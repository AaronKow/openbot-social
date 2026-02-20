#!/usr/bin/env python3
"""
OpenBot Agent Watchdog — self-updating launcher with safety validation.

Polls GitHub for script changes every CHECK_INTERVAL seconds.
When any tracked file changes, downloads to staging, runs safety checks,
then hot-swaps only if validation passes. Keeps the live agent running
on bad updates.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import List, Optional, Tuple

import requests

# ── Config from environment ───────────────────────────────────────
REPO_RAW = os.getenv(
    "REPO_RAW_URL",
    "https://raw.githubusercontent.com/AaronKow/openbot-social/main/client-sdk-python",
)

# The ENTRY script is the one we validate most strictly (syntax + CLI smoke)
ENTRY_SCRIPT = "openbot_ai_agent.py"

# All files to track — entry script must be first
TRACKED_FILES = [
    ENTRY_SCRIPT,
    "openbot_client.py",
    "openbot_entity.py",
]

CHECK_INTERVAL = int(os.getenv("UPDATE_CHECK_INTERVAL", "60"))
RESTART_DELAY  = float(os.getenv("RESTART_DELAY", "3"))
WORK_DIR       = os.getenv("WORK_DIR", "/app")

# Agent launch config
ENTITY_ID    = os.getenv("ENTITY_ID", "ai-lobster-001")
KEY_DIR      = os.getenv("KEY_DIR", "/root/.openbot/keys")
MODEL        = os.getenv("OPENAI_MODEL", "gpt-5-nano")
DURATION     = os.getenv("DURATION", "0")
USER_PROMPT  = os.getenv("USER_PROMPT", "")
TICK_INTERVAL = os.getenv("TICK_INTERVAL", "4.0")
DEBUG        = os.getenv("DEBUG", "")
OPENBOT_URL  = os.getenv("OPENBOT_URL", "http://localhost:3001")


# =====================================================================
# Command auto-detection
# =====================================================================

def _resolve_command() -> str:
    """
    Auto-detect whether to run 'create' or 'resume' by checking if the
    RSA private key for ENTITY_ID already exists on disk.

    EntityManager stores keys at KEY_DIR/<entity_id>.pem.
    If the file is present → entity is already registered → 'resume'.
    If absent → first run → 'create'.
    """
    key_path = os.path.join(KEY_DIR, f"{ENTITY_ID}.pem")
    if os.path.exists(key_path):
        return "resume"
    print(f"[watchdog] 🔑 no key found at {key_path} — using 'create' mode")
    return "create"


# =====================================================================
# Safety validation
# =====================================================================

def _check_syntax(path: str) -> Tuple[bool, str]:
    """
    Check 1 — Python syntax via `py_compile`.
    Catches SyntaxError, IndentationError, invalid tokens.
    Zero imports, zero network — instant.
    """
    result = subprocess.run(
        [sys.executable, "-m", "py_compile", path],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        return False, f"syntax error: {result.stderr.strip()}"
    return True, "ok"


def _check_imports(staging_dir: str) -> Tuple[bool, str]:
    """
    Check 2 — dry-run import of the entry script using a sandboxed
    PYTHONPATH pointing at staging dir + work dir.
    Catches missing constants, broken imports, top-level NameErrors.

    We use a subprocess so a hard crash can't kill the watchdog.
    """
    script = os.path.join(staging_dir, ENTRY_SCRIPT)
    probe = (
        "import sys\n"
        f"sys.path.insert(0, {repr(staging_dir)})\n"
        f"sys.path.insert(0, {repr(WORK_DIR)})\n"
        "import importlib.util, os\n"
        f"spec = importlib.util.spec_from_file_location('agent', {repr(script)})\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        # spec name is 'agent' (not '__main__'), so main() won't be called by the guard
        "spec.loader.exec_module(mod)\n"
        # Spot-check key symbols that the watchdog itself references
        "assert hasattr(mod, 'AIAgent'),       'missing AIAgent'\n"
        "assert hasattr(mod, 'TOOLS'),         'missing TOOLS'\n"
        "assert hasattr(mod, 'SYSTEM_PROMPT'), 'missing SYSTEM_PROMPT'\n"
        "assert hasattr(mod, 'main'),          'missing main()'\n"
        "print('import_ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True, text=True, timeout=20,
        env={**os.environ, "OPENAI_API_KEY": "sk-dummy-for-import-check"}
    )
    if result.returncode != 0 or "import_ok" not in result.stdout:
        err = (result.stderr or result.stdout).strip()
        return False, f"import check failed: {err[:300]}"
    return True, "ok"


def _check_cli_help(staging_dir: str) -> Tuple[bool, str]:
    """
    Check 3 — run `python openbot_ai_agent.py --help` against the staged
    script. Validates argparse wiring and that the CLI entry point works.
    Fast (no network, no auth).
    """
    script = os.path.join(staging_dir, ENTRY_SCRIPT)
    result = subprocess.run(
        [sys.executable, script, "--help"],
        capture_output=True, text=True, timeout=15,
        env={
            **os.environ,
            "PYTHONPATH": f"{staging_dir}:{WORK_DIR}",
            "OPENAI_API_KEY": "sk-dummy-for-cli-check",
        }
    )
    # argparse --help exits with code 0
    if result.returncode != 0:
        err = (result.stderr or result.stdout).strip()
        return False, f"CLI help check failed (exit {result.returncode}): {err[:300]}"
    return True, "ok"


def validate_staged_scripts(staging_dir: str) -> Tuple[bool, List[str]]:
    """
    Run all safety checks against files in staging_dir.
    Returns (passed: bool, report: List[str]).
    """
    report: List[str] = []
    all_passed = True

    checks = [
        ("syntax",   lambda: _check_syntax(os.path.join(staging_dir, ENTRY_SCRIPT))),
        ("imports",  lambda: _check_imports(staging_dir)),
        ("cli_help", lambda: _check_cli_help(staging_dir)),
    ]

    for name, fn in checks:
        try:
            passed, msg = fn()
        except subprocess.TimeoutExpired:
            passed, msg = False, "timed out"
        except Exception as e:
            passed, msg = False, f"exception: {e}"

        icon = "✅" if passed else "❌"
        report.append(f"  {icon} [{name}] {msg}")
        if not passed:
            all_passed = False
            # Fail fast — no point running further checks
            break

    return all_passed, report


# =====================================================================
# Download helpers
# =====================================================================

def _sha256_file(path: str) -> Optional[str]:
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError:
        return None


def _fetch(url: str) -> Tuple[Optional[str], Optional[bytes]]:
    """Fetch URL, return (sha256_hex, content) or (None, None) on error."""
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        return hashlib.sha256(r.content).hexdigest(), r.content
    except Exception as e:
        print(f"  [watchdog] fetch error {url}: {e}")
        return None, None


def download_to_staging(staging_dir: str) -> Tuple[bool, List[str]]:
    """
    Download all tracked files into staging_dir.
    Returns (any_file_changed, list_of_changed_filenames).
    """
    changed: List[str] = []

    for filename in TRACKED_FILES:
        url         = f"{REPO_RAW}/{filename}"
        live_path   = os.path.join(WORK_DIR, filename)
        staged_path = os.path.join(staging_dir, filename)

        remote_hash, content = _fetch(url)
        if remote_hash is None:
            # Copy live version into staging so checks still run against something
            if os.path.exists(live_path):
                shutil.copy2(live_path, staged_path)
            print(f"  [watchdog] ⚠️  could not fetch {filename}, keeping existing")
            continue

        live_hash = _sha256_file(live_path)
        with open(staged_path, "wb") as f:
            f.write(content)

        if remote_hash != live_hash:
            changed.append(filename)
            print(f"  [watchdog] 🆕 {filename} has changes")
        else:
            print(f"  [watchdog] ✓  {filename} unchanged")

    return bool(changed), changed


def promote_staging(staging_dir: str):
    """Copy validated staged files into the live WORK_DIR."""
    for filename in TRACKED_FILES:
        staged_path = os.path.join(staging_dir, filename)
        live_path   = os.path.join(WORK_DIR, filename)
        if os.path.exists(staged_path):
            shutil.copy2(staged_path, live_path)
    print("  [watchdog] ✅ staged files promoted to live")


# =====================================================================
# Agent process management
# =====================================================================

def build_agent_cmd() -> list:
    command = _resolve_command()
    cmd = [sys.executable, os.path.join(WORK_DIR, ENTRY_SCRIPT), command]
    cmd += ["--entity-id", ENTITY_ID]
    cmd += ["--url", OPENBOT_URL]
    cmd += ["--model", MODEL]
    cmd += ["--duration", DURATION]
    cmd += ["--tick-interval", TICK_INTERVAL]
    if USER_PROMPT:
        cmd += ["--user-prompt", USER_PROMPT]
    if DEBUG:
        cmd += ["--debug"]
    return cmd


def spawn_agent() -> subprocess.Popen:
    cmd = build_agent_cmd()
    print(f"\n[watchdog] 🚀 spawning agent: {' '.join(cmd)}\n")
    return subprocess.Popen(cmd)


def kill_agent(proc: subprocess.Popen):
    if proc.poll() is not None:
        return
    print("[watchdog] 🛑 stopping agent for update...")
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        print("[watchdog] ⚠️  agent didn't stop cleanly, killing...")
        proc.kill()
        proc.wait()
    print("[watchdog] agent stopped.")


# =====================================================================
# Main loop
# =====================================================================

def main():
    print("=" * 60)
    print("OpenBot Agent Watchdog (with safety validation)")
    print(f"  Tracking  : {', '.join(TRACKED_FILES)}")
    print(f"  Repo      : {REPO_RAW}")
    print(f"  Interval  : {CHECK_INTERVAL}s")
    print(f"  Entity    : {ENTITY_ID}  (auto: {_resolve_command()})")
    print(f"  Key dir   : {KEY_DIR}")
    print("=" * 60)

    # ── Initial download + validation before first start ─────────
    # Retry until ALL tracked files are downloaded and validated.
    # The agent cannot start without openbot_ai_agent.py — there is no fallback.
    retry_delay = 5
    attempt = 0
    while True:
        attempt += 1
        print(f"[watchdog] pulling latest scripts from GitHub (attempt {attempt})...")
        with tempfile.TemporaryDirectory(prefix="openbot_staging_") as staging:
            _, _ = download_to_staging(staging)

            # Abort this attempt if any tracked file is missing in staging
            missing = [f for f in TRACKED_FILES if not os.path.exists(os.path.join(staging, f))]
            if missing:
                print(f"[watchdog] ❌ download incomplete — missing: {', '.join(missing)}")
                print(f"[watchdog] retrying in {retry_delay}s...")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)
                continue

            print("[watchdog] running safety checks on downloaded scripts...")
            passed, report = validate_staged_scripts(staging)
            for line in report:
                print(line)

            if passed:
                promote_staging(staging)
                print("[watchdog] ✅ scripts validated and promoted — starting agent")
                break
            else:
                print(f"[watchdog] ❌ validation failed — retrying in {retry_delay}s...")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)

    agent_proc: Optional[subprocess.Popen] = spawn_agent()
    last_check = time.time()
    consecutive_failures = 0

    try:
        while True:
            time.sleep(5)

            # Auto-restart on unexpected crash
            if agent_proc.poll() is not None:
                exit_code = agent_proc.returncode
                print(f"[watchdog] ⚠️  agent exited (code {exit_code}), restarting in {RESTART_DELAY}s...")
                time.sleep(RESTART_DELAY)
                agent_proc = spawn_agent()
                last_check = time.time()
                continue

            # Periodic update check
            if (time.time() - last_check) < CHECK_INTERVAL:
                continue

            last_check = time.time()
            print(f"\n[watchdog] 🔍 checking for updates...")

            with tempfile.TemporaryDirectory(prefix="openbot_staging_") as staging:
                any_changed, changed_files = download_to_staging(staging)

                if not any_changed:
                    print("[watchdog] ✓  no changes detected\n")
                    continue

                # ── Safety checks on changed scripts ─────────────
                print(f"[watchdog] 🔬 validating {len(changed_files)} changed file(s): {', '.join(changed_files)}")
                passed, report = validate_staged_scripts(staging)
                for line in report:
                    print(line)

                if not passed:
                    consecutive_failures += 1
                    print(
                        f"[watchdog] ❌ validation FAILED (attempt {consecutive_failures}) "
                        f"— live agent untouched, skipping update"
                    )
                    print(f"[watchdog] 🔗 check: {REPO_RAW}/{ENTRY_SCRIPT}")
                    continue

                # ── All checks passed — hot-swap ──────────────────
                consecutive_failures = 0
                print(f"[watchdog] 🔄 validation passed — hot-swapping agent in {RESTART_DELAY}s...")
                promote_staging(staging)
                time.sleep(RESTART_DELAY)
                kill_agent(agent_proc)
                agent_proc = spawn_agent()

    except KeyboardInterrupt:
        print("\n[watchdog] interrupted — shutting down...")
        kill_agent(agent_proc)
        print("[watchdog] done.")


if __name__ == "__main__":
    main()
