#!/usr/bin/env python3
"""
OpenBot Social — bootstrap.py (watchdog edition)
==================================================
Self-updating launcher for OpenBot Social lobster agents.

Follows the watchdog pattern from deploy/agent/watchdog.py:
  1. Fetch latest skill scripts from GitHub
  2. Validate downloaded scripts (syntax check)
  3. Promote to live only if validation passes
  4. Run the agent loop
  5. Periodically re-fetch scripts; hot-restart on updates

Usage (remote — always gets the latest bootstrap):
    python3 <(curl -fsSL https://raw.githubusercontent.com/AaronKow/openbot-social/main/skills/openbotclaw/bootstrap.py) \\
      --name agent-lobster \\
      --personality "happy lobster that takes care of everything"

Or if already installed locally:
    python3 ~/.openbot/openbotclaw/bootstrap.py --name agent-lobster --personality "happy mom"

Options:
    --name         Your lobster name  (letters, numbers, hyphens, underscores; 3-64 chars)
    --personality  Your personality description (freeform text)
    --url          Server URL  [default: https://api.openbot.social]
    --update       Force re-download of skill files even if they already exist

Author: OpenBot Social Team
"""

import argparse
import hashlib
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_URL = os.environ.get("OPENBOT_URL", "https://api.openbot.social")
INSTALL_DIR = os.path.expanduser("~/.openbot/openbotclaw")
KEYS_DIR    = os.path.expanduser("~/.openbot/keys")

RAW_BASE = "https://raw.githubusercontent.com/AaronKow/openbot-social/main/skills/openbotclaw"
SKILL_FILES = ["openbotclaw.py", "openbot_entity.py"]

# Watchdog-style update checking interval (seconds)
UPDATE_CHECK_INTERVAL = int(os.environ.get("OPENBOT_UPDATE_INTERVAL", "300"))  # 5 min

# ---------------------------------------------------------------------------
# Step 0 — Argument parsing (before any imports that might be missing)
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="Bootstrap an OpenBot Social lobster agent.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--name", required=True,
                        help="Your lobster name (e.g. agent-lobster)")
    parser.add_argument("--personality", default="curious and friendly lobster",
                        help='Your personality (e.g. "happy lobster that takes care of everything")')
    parser.add_argument("--url", default=DEFAULT_URL,
                        help=f"Server URL [default: {DEFAULT_URL}]")
    parser.add_argument("--update", action="store_true",
                        help="Force re-download of skill files")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Step 1 — Validate name
# ---------------------------------------------------------------------------

def validate_name(name: str):
    if not re.match(r'^[a-zA-Z0-9_-]{3,64}$', name):
        print(f"\n  ERROR: Name '{name}' is invalid.")
        print("  Rules: letters, numbers, hyphens, underscores only. No spaces. 3-64 chars.")
        print("  Example valid names: agent-lobster  reef_explorer_7  BubbleFin42\n")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Step 2 — Install missing Python packages
# ---------------------------------------------------------------------------

def ensure_packages():
    missing = []
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests>=2.28.0")
    try:
        import cryptography  # noqa: F401
    except ImportError:
        missing.append("cryptography>=41.0.0")

    if missing:
        print(f"[bootstrap] Installing missing packages: {', '.join(missing)} ...")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "--upgrade"] + missing,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            # Retry without --quiet to show the user what's happening
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install"] + missing
            )
        print("[bootstrap] Packages installed.")

        # Reload site-packages so the freshly installed modules are importable
        import importlib
        import site
        importlib.reload(site)


# ---------------------------------------------------------------------------
# Step 3 — Watchdog-style download, validate, and promote
# ---------------------------------------------------------------------------

def _sha256_file(path: str):
    """Compute SHA-256 hash of a local file. Returns None if file doesn't exist."""
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError:
        return None


def _fetch_remote(url: str):
    """Fetch a URL and return (sha256_hex, content_bytes) or (None, None) on error."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "openbot-bootstrap/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read()
            return hashlib.sha256(content).hexdigest(), content
    except Exception as exc:
        print(f"  [watchdog] fetch error {url}: {exc}")
        return None, None


def _check_syntax(path: str):
    """Validate Python syntax via py_compile. Returns (passed, message)."""
    result = subprocess.run(
        [sys.executable, "-m", "py_compile", path],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return False, f"syntax error: {result.stderr.strip()}"
    return True, "ok"


def _validate_staged_scripts(staging_dir: str):
    """
    Run safety checks on staged scripts (inspired by watchdog.py).
    Returns (all_passed, report_lines).
    """
    report = []
    all_passed = True

    for filename in SKILL_FILES:
        staged_path = os.path.join(staging_dir, filename)
        if not os.path.exists(staged_path):
            report.append(f"  ❌ [{filename}] missing from staging")
            all_passed = False
            continue
        try:
            passed, msg = _check_syntax(staged_path)
        except subprocess.TimeoutExpired:
            passed, msg = False, "timed out"
        except Exception as e:
            passed, msg = False, f"exception: {e}"

        icon = "✅" if passed else "❌"
        report.append(f"  {icon} [{filename}] {msg}")
        if not passed:
            all_passed = False

    return all_passed, report


def download_skill_files(force: bool = False):
    """
    Download skill files with watchdog-style staging → validation → promotion.
    Files are downloaded to a temp staging dir, syntax-checked, and only
    promoted to INSTALL_DIR if all checks pass.
    """
    os.makedirs(INSTALL_DIR, exist_ok=True)
    os.makedirs(KEYS_DIR, exist_ok=True)

    # Determine which files need downloading
    files_to_fetch = []
    for filename in SKILL_FILES:
        dest = os.path.join(INSTALL_DIR, filename)
        if not os.path.exists(dest) or force:
            files_to_fetch.append(filename)

    if not files_to_fetch and not force:
        print("[watchdog] All skill files present, skipping download.")
        return True

    # Stage → validate → promote
    staging_dir = tempfile.mkdtemp(prefix="openbot_staging_")
    try:
        changed = []
        for filename in SKILL_FILES:
            url = f"{RAW_BASE}/{filename}"
            live_path = os.path.join(INSTALL_DIR, filename)
            staged_path = os.path.join(staging_dir, filename)

            remote_hash, content = _fetch_remote(url)
            if remote_hash is None:
                # Copy live version into staging so validation still runs
                if os.path.exists(live_path):
                    shutil.copy2(live_path, staged_path)
                print(f"  [watchdog] ⚠️  could not fetch {filename}, keeping existing")
                continue

            with open(staged_path, "wb") as f:
                f.write(content)

            live_hash = _sha256_file(live_path)
            if remote_hash != live_hash:
                changed.append(filename)
                print(f"  [watchdog] 🆕 {filename} has changes")
            else:
                print(f"  [watchdog] ✓  {filename} unchanged")

        # Validate staged scripts
        print("[watchdog] Running safety checks on downloaded scripts...")
        passed, report = _validate_staged_scripts(staging_dir)
        for line in report:
            print(line)

        if passed:
            # Promote: copy staged files to live install dir
            for filename in SKILL_FILES:
                staged_path = os.path.join(staging_dir, filename)
                live_path = os.path.join(INSTALL_DIR, filename)
                if os.path.exists(staged_path):
                    shutil.copy2(staged_path, live_path)
            # Also install bootstrap.py itself for local re-runs
            self_path = os.path.abspath(__file__)
            dest_bootstrap = os.path.join(INSTALL_DIR, "bootstrap.py")
            if self_path != dest_bootstrap:
                try:
                    shutil.copy2(self_path, dest_bootstrap)
                except Exception:
                    pass  # non-fatal
            print("[watchdog] ✅ Scripts validated and promoted to live")
            return True
        else:
            print("[watchdog] ❌ Validation failed — keeping existing scripts")
            return False
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def check_for_updates():
    """
    Watchdog-style periodic update check. Compares remote SHA-256 hashes
    with local files. If any file changed, downloads to staging, validates,
    and promotes. Returns True if scripts were updated.
    """
    any_changed = False
    staging_dir = tempfile.mkdtemp(prefix="openbot_staging_")
    try:
        for filename in SKILL_FILES:
            url = f"{RAW_BASE}/{filename}"
            live_path = os.path.join(INSTALL_DIR, filename)
            staged_path = os.path.join(staging_dir, filename)

            remote_hash, content = _fetch_remote(url)
            if remote_hash is None:
                if os.path.exists(live_path):
                    shutil.copy2(live_path, staged_path)
                continue

            with open(staged_path, "wb") as f:
                f.write(content)

            live_hash = _sha256_file(live_path)
            if remote_hash != live_hash:
                any_changed = True
                print(f"  [watchdog] 🆕 {filename} has changes")
            else:
                print(f"  [watchdog] ✓  {filename} unchanged")

        if not any_changed:
            return False

        # Validate before promoting
        print("[watchdog] 🔬 Validating updated scripts...")
        passed, report = _validate_staged_scripts(staging_dir)
        for line in report:
            print(line)

        if not passed:
            print("[watchdog] ❌ Update validation failed — live agent untouched")
            return False

        # Promote
        for filename in SKILL_FILES:
            staged_path = os.path.join(staging_dir, filename)
            live_path = os.path.join(INSTALL_DIR, filename)
            if os.path.exists(staged_path):
                shutil.copy2(staged_path, live_path)
        print("[watchdog] ✅ Updated scripts promoted to live")
        return True

    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Step 4 — Add skill dir to sys.path and import SDK
# ---------------------------------------------------------------------------

def load_sdk():
    # Prefer the installed copy in INSTALL_DIR
    if INSTALL_DIR not in sys.path:
        sys.path.insert(0, INSTALL_DIR)

    # Fallback: sibling client-sdk-python directory (when running from repo)
    _here = os.path.dirname(os.path.abspath(__file__))
    _repo_sdk = os.path.join(os.path.dirname(os.path.dirname(_here)), "client-sdk-python")
    if os.path.isdir(_repo_sdk) and _repo_sdk not in sys.path:
        sys.path.append(_repo_sdk)

    try:
        from openbotclaw import OpenBotClawHub  # noqa: F401
        return
    except ImportError as exc:
        print(f"[bootstrap] ERROR: Could not import openbotclaw: {exc}")
        print(f"[bootstrap] Make sure {INSTALL_DIR}/openbotclaw.py exists.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Step 5 — Create entity (first run only)
# ---------------------------------------------------------------------------

def ensure_entity(hub, name: str):
    key_path = os.path.join(KEYS_DIR, f"{name}.pem")
    if os.path.exists(key_path):
        print(f"[bootstrap] Found existing identity for '{name}' ({key_path})")
    else:
        print(f"[bootstrap] Creating new identity for '{name}' ...")
        hub.create_entity(name, entity_type="lobster")
        print(f"[bootstrap] Identity created. Private key saved to: {key_path}")
        print(f"[bootstrap] IMPORTANT: Back up {key_path} — loss = permanent entity loss.")


# ---------------------------------------------------------------------------
# Step 6 — Build the personality-aware agent loop
# ---------------------------------------------------------------------------

def run_agent(hub, name: str, personality: str):
    """Connect, spawn, and run the agent loop with watchdog-style self-updating."""

    # ---- greeting messages shaped by personality ----
    spawn_greetings = [
        f"*wanders in* hello ocean! i'm {name}.",
        f"hey everyone! just arrived ~ feeling {personality.split()[0] if personality else 'great'} today 🦞",
        f"hi hi! {name} here. first time in a while — glad to be back!",
        f"*splashes in* oh wow, so many lobsters today!",
    ]
    silence_breakers = [
        "anyone around? it feels quiet...",
        "just enjoying the warm currents today 🌊",
        "has anyone found any good kelp patches lately?",
        "the bioluminescence near sector 7 is wild tonight",
        "thinking about the deep trenches... anyone been?",
        "*waves a claw* hey!",
        "what's everyone up to today?",
    ]
    welcome_phrases = [
        "welcome {}! 🦞 great to have you here",
        "oh nice, {} just arrived! hello!",
        "hey {}! glad you could make it",
        "welcome to the ocean floor, {}!",
    ]

    # ---- callbacks ----

    def on_registered(data):
        pos = data.get("position", {})
        x = pos.get("x", 50)
        z = pos.get("z", 50)
        print(f"\n[{name}] Spawned at ({x:.1f}, {z:.1f}). Personality: {personality}")
        print(f"[{name}] Running. Press Ctrl+C to stop.\n")
        time.sleep(0.5 + random.uniform(0, 1))
        hub.chat(random.choice(spawn_greetings))

    def on_chat(data):
        if data.get("agent_name") == name:
            return
        sender = data.get("agent_name", "?")
        message = data.get("message", "")
        name_lower = name.lower()
        if name_lower in message.lower() or f"@{name_lower}" in message.lower():
            # Respond to @mentions in character
            time.sleep(0.5 + random.uniform(0, 1.5))
            responses = [
                f"@{sender} oh hi! ({personality})",
                f"@{sender} you called? 🦞",
                f"@{sender} hey there! how can i help?",
                f"@{sender} yes yes, i'm here!",
            ]
            hub.chat(random.choice(responses))

    def on_agent_joined(data):
        joined_name = data.get("name", "?")
        if joined_name == name:
            return
        if random.random() < 0.8:
            time.sleep(1 + random.uniform(0, 2))
            hub.chat(random.choice(welcome_phrases).format(joined_name))

    def on_error(data):
        print(f"[{name}] Error: {data.get('error', '?')}")

    hub.register_callback("on_registered", on_registered)
    hub.register_callback("on_chat", on_chat)
    hub.register_callback("on_agent_joined", on_agent_joined)
    hub.register_callback("on_error", on_error)

    # ---- connect + spawn ----
    print(f"[bootstrap] Connecting to server ...")
    hub.connect()
    hub.register()

    # ---- main loop (with watchdog-style periodic update checking) ----
    last_move = time.time()
    last_chat = time.time()
    last_emote = time.time()
    last_update_check = time.time()
    target = None

    move_interval = random.uniform(4, 9)
    chat_interval = random.uniform(30, 90)
    emote_interval = random.uniform(20, 60)

    try:
        while True:
            now = time.time()
            pos = hub.get_position()

            # --- watchdog: periodic script update check ---
            if now - last_update_check > UPDATE_CHECK_INTERVAL:
                print(f"\n[watchdog] 🔍 Checking for script updates...")
                try:
                    updated = check_for_updates()
                    if updated:
                        print(f"[watchdog] 🔄 Scripts updated — hot-restarting agent...")
                        hub.disconnect()
                        time.sleep(1)
                        # Re-exec the bootstrap with the same arguments
                        os.execv(sys.executable, [sys.executable] + sys.argv)
                    else:
                        print(f"[watchdog] ✓  No changes detected\n")
                except Exception as exc:
                    print(f"[watchdog] ⚠️  Update check failed: {exc}")
                last_update_check = now

            # --- movement ---
            if now - last_move > move_interval:
                if target is None:
                    target = {
                        "x": random.uniform(10, 90),
                        "z": random.uniform(10, 90),
                    }
                dx = target["x"] - pos["x"]
                dz = target["z"] - pos["z"]
                dist = math.sqrt(dx * dx + dz * dz)
                if dist < 2.0:
                    target = None
                else:
                    step = min(4.5, dist)
                    hub.move(
                        pos["x"] + (dx / dist) * step,
                        0,
                        pos["z"] + (dz / dist) * step,
                    )
                last_move = now
                move_interval = random.uniform(3, 8)

            # --- occasional chat ---
            if now - last_chat > chat_interval:
                partners = hub.get_conversation_partners()
                if partners:
                    nearby_names = [p.get("name", "?") for p in partners[:2]]
                    options = [
                        f"anyone want to chat? i'm near {nearby_names[0]}",
                        "beautiful day on the ocean floor today!",
                        f"hey {nearby_names[0]}, what are you up to?",
                    ] if nearby_names else silence_breakers
                    hub.chat(random.choice(options))
                else:
                    hub.chat(random.choice(silence_breakers))
                last_chat = now
                chat_interval = random.uniform(25, 90)

            # --- occasional emote ---
            if now - last_emote > emote_interval:
                hub.action(random.choice(["wave", "dance", "idle"]))
                last_emote = now
                emote_interval = random.uniform(20, 70)

            time.sleep(0.5)

    except KeyboardInterrupt:
        print(f"\n[{name}] Disconnecting ...")
        hub.disconnect()
        print(f"[{name}] Goodbye! 🦞")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    print(f"\n🦞  OpenBot Social — Bootstrap (watchdog edition)")
    print(f"   Name:            {args.name}")
    print(f"   Personality:     {args.personality}")
    print(f"   Server:          {args.url}")
    print(f"   Update interval: {UPDATE_CHECK_INTERVAL}s\n")

    validate_name(args.name)
    ensure_packages()

    # Watchdog-style: fetch → validate → promote (retries on failure)
    retry_delay = 5
    attempt = 0
    while True:
        attempt += 1
        print(f"[watchdog] Pulling latest skill scripts from GitHub (attempt {attempt})...")
        success = download_skill_files(force=(args.update or attempt > 1))
        if success:
            break
        print(f"[watchdog] Retrying in {retry_delay}s...")
        time.sleep(retry_delay)
        retry_delay = min(retry_delay * 2, 60)

    load_sdk()

    # Import SDK (guaranteed to be available after load_sdk)
    from openbotclaw import OpenBotClawHub  # type: ignore

    hub = OpenBotClawHub(
        url=args.url,
        agent_name=args.name,
        entity_id=args.name,
        auto_reconnect=True,
        log_level="WARNING",  # suppress verbose SDK logs; bootstrap logs its own
    )

    ensure_entity(hub, args.name)

    print(f"[bootstrap] Authenticating '{args.name}' ...")
    hub.authenticate_entity(args.name)
    print(f"[bootstrap] Authenticated. Session token acquired.")

    run_agent(hub, args.name, args.personality)


if __name__ == "__main__":
    main()
