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


def _check_imports(staging_dir: str):
    """
    Dry-run import of openbotclaw.py from the staging directory.
    Catches broken imports, missing constants, top-level NameErrors.
    Runs in a subprocess so a crash can't kill the bootstrap.
    """
    script = os.path.join(staging_dir, "openbotclaw.py")
    if not os.path.exists(script):
        return True, "skipped (no openbotclaw.py in staging)"
    probe = (
        "import sys\n"
        f"sys.path.insert(0, {repr(staging_dir)})\n"
        "import importlib.util\n"
        f"spec = importlib.util.spec_from_file_location('openbotclaw', {repr(script)})\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(mod)\n"
        "assert hasattr(mod, 'OpenBotClawHub'), 'missing OpenBotClawHub'\n"
        "assert hasattr(mod, 'CONVERSATION_TOPICS'), 'missing CONVERSATION_TOPICS'\n"
        "assert hasattr(mod, 'RANDOM_CHATS'), 'missing RANDOM_CHATS'\n"
        "print('import_ok')\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode != 0 or "import_ok" not in result.stdout:
            err = (result.stderr or result.stdout).strip()
            return False, f"import check failed: {err[:300]}"
        return True, "ok"
    except subprocess.TimeoutExpired:
        return False, "import check timed out"
    except Exception as e:
        return False, f"import check exception: {e}"


def _validate_staged_scripts(staging_dir: str):
    """
    Run safety checks on staged scripts (inspired by watchdog.py).
    Check 1: Syntax check every file via py_compile.
    Check 2: Dry-run import of openbotclaw.py to catch broken imports/symbols.
    Returns (all_passed, report_lines).
    """
    report = []
    all_passed = True

    # Check 1: Syntax
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
        report.append(f"  {icon} [syntax: {filename}] {msg}")
        if not passed:
            all_passed = False
            return all_passed, report  # fail fast

    # Check 2: Import check (catches broken imports, missing classes)
    try:
        passed, msg = _check_imports(staging_dir)
    except Exception as e:
        passed, msg = False, f"exception: {e}"

    icon = "✅" if passed else "❌"
    report.append(f"  {icon} [import check] {msg}")
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

    # Needs + utility configuration
    ENERGY_LOW = 45.0
    ENERGY_CRITICAL = 25.0
    ENERGY_RECOVERY = 68.0
    CHAT_COOLDOWN_SEC = 12.0
    MOVE_COOLDOWN_SEC = 1.8
    EMOTE_COOLDOWN_SEC = 26.0
    DECISION_INTERVAL_SEC = 1.6
    WORLD_SCAN_INTERVAL_SEC = 7.0
    RUNTIME_SCAN_INTERVAL_SEC = 2.5
    GOAL_REFRESH_SEC = 35.0
    pending_mentions = []
    pending_welcomes = []
    latest_runtime = {"energy": 100.0, "sleeping": False, "state": "idle"}
    known_objects = []
    active_goal = None
    last_goal_refresh = 0.0
    current_mode = "explore"

    # ---- callbacks ----

    timers = {
        "last_move": time.time(),
        "last_chat": time.time(),
        "last_emote": time.time(),
        "last_update_check": time.time(),
        "last_decision": 0.0,
        "last_world_scan": 0.0,
        "last_runtime_scan": 0.0,
    }

    def on_registered(data):
        pos = data.get("position", {})
        x = pos.get("x", 50)
        z = pos.get("z", 50)
        print(f"\n[{name}] Spawned at ({x:.1f}, {z:.1f}). Personality: {personality}")
        print(f"[{name}] Running. Press Ctrl+C to stop.\n")
        time.sleep(0.5 + random.uniform(0, 1))
        hub.chat(random.choice(spawn_greetings))
        timers["last_chat"] = time.time()

    def on_chat(data):
        if data.get("agent_name") == name:
            return
        sender = data.get("agent_name", "?")
        message = data.get("message", "")
        name_lower = name.lower()
        if name_lower in message.lower() or f"@{name_lower}" in message.lower():
            # Queue mention handling; let utility loop decide timing.
            pending_mentions.append(sender)
            if len(pending_mentions) > 8:
                del pending_mentions[:len(pending_mentions) - 8]

    def on_agent_joined(data):
        joined_name = data.get("name", "?")
        if joined_name == name:
            return
        if random.random() < 0.65:
            pending_welcomes.append(joined_name)
            if len(pending_welcomes) > 6:
                del pending_welcomes[:len(pending_welcomes) - 6]

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

    def refresh_runtime_stats(now_ts: float):
        if now_ts - timers["last_runtime_scan"] < RUNTIME_SCAN_INTERVAL_SEC:
            return
        timers["last_runtime_scan"] = now_ts
        if not hub.agent_id or not getattr(hub, "session", None):
            return
        try:
            response = hub.session.get(
                f"{hub.url}/agent/{hub.agent_id}",
                timeout=hub.connection_timeout
            )
            response.raise_for_status()
            payload = response.json() or {}
            latest_runtime["energy"] = float(payload.get("energy", latest_runtime["energy"]))
            latest_runtime["sleeping"] = bool(payload.get("sleeping", latest_runtime["sleeping"]))
            latest_runtime["state"] = payload.get("state", latest_runtime["state"])
        except Exception:
            # Keep previous runtime values on transient failures.
            return

    def refresh_world_objects(now_ts: float):
        if now_ts - timers["last_world_scan"] < WORLD_SCAN_INTERVAL_SEC:
            return
        timers["last_world_scan"] = now_ts
        if not getattr(hub, "session", None):
            return
        try:
            response = hub.session.get(
                f"{hub.url}/world-state",
                timeout=hub.connection_timeout
            )
            response.raise_for_status()
            payload = response.json() or {}
            objects = payload.get("objects", [])
            if isinstance(objects, list):
                known_objects.clear()
                known_objects.extend(objects)
        except Exception:
            return

    def move_towards_point(pos, target_x: float, target_z: float, max_step: float = 4.5) -> bool:
        dx = target_x - pos["x"]
        dz = target_z - pos["z"]
        dist = math.sqrt(dx * dx + dz * dz)
        if dist < 0.9:
            return False
        step = min(max_step, dist)
        hub.move(
            pos["x"] + (dx / dist) * step,
            0,
            pos["z"] + (dz / dist) * step,
        )
        timers["last_move"] = time.time()
        return True

    def find_nearest_algae(pos):
        nearest = None
        nearest_dist = None
        for obj in known_objects:
            if obj.get("type") != "algae_pallet":
                continue
            data = obj.get("data") or {}
            serves_remaining = data.get("servesRemaining")
            if isinstance(serves_remaining, (int, float)) and serves_remaining <= 0:
                continue
            o_pos = obj.get("position") or {}
            ox = float(o_pos.get("x", 0))
            oz = float(o_pos.get("z", 0))
            dist = math.sqrt((ox - pos["x"]) ** 2 + (oz - pos["z"]) ** 2)
            if nearest_dist is None or dist < nearest_dist:
                nearest = (ox, oz, dist)
                nearest_dist = dist
        return nearest

    def compute_shelter_point(pos, nearby_agents):
        # Shelter heuristic: drift away from local crowd center.
        close = [a for a in nearby_agents if float(a.get("distance", 999)) <= 14.0]
        if not close:
            return None
        cx = sum(float(a.get("position", {}).get("x", pos["x"])) for a in close) / len(close)
        cz = sum(float(a.get("position", {}).get("z", pos["z"])) for a in close) / len(close)
        vx = pos["x"] - cx
        vz = pos["z"] - cz
        norm = math.sqrt(vx * vx + vz * vz)
        if norm < 0.01:
            angle = random.uniform(0, math.pi * 2)
            vx, vz = math.cos(angle), math.sin(angle)
            norm = 1.0
        scale = random.uniform(8.0, 16.0)
        target_x = max(5.0, min(95.0, pos["x"] + (vx / norm) * scale))
        target_z = max(5.0, min(95.0, pos["z"] + (vz / norm) * scale))
        return (target_x, target_z)

    def maybe_refresh_goal(now_ts: float, pos, nearby_social, nearest_algae, energy: float):
        nonlocal active_goal, last_goal_refresh
        if active_goal and active_goal.get("type") == "explore":
            tx, tz = active_goal.get("target", (pos["x"], pos["z"]))
            if math.sqrt((tx - pos["x"]) ** 2 + (tz - pos["z"]) ** 2) < 2.2:
                active_goal = None
        if active_goal and active_goal.get("type") == "forage":
            if energy >= ENERGY_RECOVERY:
                active_goal = None
        if active_goal and active_goal.get("type") == "socialize":
            if not nearby_social:
                active_goal = None
        if active_goal and (now_ts - active_goal.get("created_at", now_ts)) > 240:
            active_goal = None

        if active_goal and (now_ts - last_goal_refresh) < GOAL_REFRESH_SEC:
            return
        if active_goal:
            return

        # Goal generation is contextual, not hard-scripted.
        candidates = []
        if nearest_algae and energy < ENERGY_RECOVERY:
            candidates.append({
                "type": "forage",
                "label": "recharge energy at algae pallet",
                "target": (nearest_algae[0], nearest_algae[1]),
                "created_at": now_ts
            })
        if nearby_social and energy > ENERGY_LOW:
            target_name = nearby_social[0].get("name") or nearby_social[0].get("id")
            if target_name:
                candidates.append({
                    "type": "socialize",
                    "label": f"engage with {target_name}",
                    "target_name": target_name,
                    "created_at": now_ts
                })
        # Exploration goal always available as fallback.
        candidates.append({
            "type": "explore",
            "label": "survey a new ocean sector",
            "target": (random.uniform(8, 92), random.uniform(8, 92)),
            "created_at": now_ts
        })

        active_goal = random.choice(candidates)
        last_goal_refresh = now_ts
        print(f"[{name}] goal -> {active_goal['label']}")

    def determine_mode(energy: float, sleeping: bool, nearby_social, nearest_algae):
        if sleeping:
            return "recover"
        if energy <= ENERGY_CRITICAL:
            return "survive"
        crowded = len([a for a in nearby_social if float(a.get("distance", 999)) <= 14.0]) >= 4
        if energy <= ENERGY_LOW and crowded:
            return "shelter"
        if energy <= ENERGY_LOW and nearest_algae:
            return "survive"
        if active_goal is not None:
            return "work"
        if nearby_social:
            return "social"
        return "explore"

    def choose_and_act(now_ts: float):
        nonlocal current_mode
        pos = hub.get_position()
        energy = float(latest_runtime.get("energy", 100.0))
        sleeping = bool(latest_runtime.get("sleeping", False))
        nearby_chat = hub.get_conversation_partners()
        nearby_social = hub.get_nearby_agents(radius=35.0)
        can_chat = (now_ts - timers["last_chat"]) >= CHAT_COOLDOWN_SEC
        can_move = (now_ts - timers["last_move"]) >= MOVE_COOLDOWN_SEC
        can_emote = (now_ts - timers["last_emote"]) >= EMOTE_COOLDOWN_SEC

        nearest_algae = find_nearest_algae(pos)
        maybe_refresh_goal(now_ts, pos, nearby_social, nearest_algae, energy)
        mode = determine_mode(energy, sleeping, nearby_social, nearest_algae)
        if mode != current_mode:
            current_mode = mode
            print(f"[{name}] mode -> {mode} (energy={int(round(energy))})")

        # Mention replies are always important (unless sleeping).
        if mode != "recover" and pending_mentions and can_chat:
            sender = pending_mentions.pop()
            responses = [
                f"@{sender} i hear you — currently in {mode} mode",
                f"@{sender} yes! adapting now (energy {int(round(energy))})",
                f"@{sender} i'm here, managing ocean priorities 🦞",
            ]
            hub.chat(random.choice(responses))
            timers["last_chat"] = time.time()
            return

        if mode == "recover":
            return

        if mode == "survive":
            if nearest_algae and can_move:
                target_x, target_z, _ = nearest_algae
                move_towards_point(pos, target_x, target_z, max_step=5.0)
                return
            # fallback if food not visible yet
            if can_move:
                move_towards_point(pos, random.uniform(6, 94), random.uniform(6, 94), max_step=4.8)
                return
            return

        if mode == "shelter":
            shelter_target = compute_shelter_point(pos, nearby_social)
            if shelter_target and can_move:
                move_towards_point(pos, shelter_target[0], shelter_target[1], max_step=4.6)
                return
            if can_emote:
                hub.action("idle")
                timers["last_emote"] = time.time()
                return
            return

        if mode == "work":
            goal = active_goal or {}
            goal_type = goal.get("type")
            if goal_type == "forage":
                target = nearest_algae
                if target and can_move:
                    move_towards_point(pos, target[0], target[1], max_step=5.0)
                    return
            elif goal_type == "socialize":
                target_name = goal.get("target_name")
                if target_name and can_move:
                    moved = hub.move_towards_agent(target_name, stop_distance=3.0, step=5.0)
                    if moved:
                        timers["last_move"] = time.time()
                        return
                if nearby_chat and can_chat:
                    hub.chat(f"{target_name}, checking in — any goals for today?")
                    timers["last_chat"] = time.time()
                    return
            elif goal_type == "explore":
                target = goal.get("target")
                if isinstance(target, tuple) and len(target) == 2 and can_move:
                    move_towards_point(pos, float(target[0]), float(target[1]), max_step=4.2)
                    return

        if mode == "social":
            if pending_welcomes and can_chat:
                joined_name = pending_welcomes.pop()
                hub.chat(random.choice(welcome_phrases).format(joined_name))
                timers["last_chat"] = time.time()
                return
            if nearby_chat and can_chat:
                partner = nearby_chat[0].get("name", "friend")
                options = [
                    f"hey {partner}, how's your mission going?",
                    f"{partner}, i just switched into social mode 🌊",
                    f"{partner}, got any ocean-floor rumors?",
                ]
                hub.chat(random.choice(options))
                timers["last_chat"] = time.time()
                return
            if nearby_social and can_move:
                target_id = nearby_social[0].get("id") or nearby_social[0].get("name")
                if target_id:
                    moved = hub.move_towards_agent(target_id, stop_distance=3.0, step=5.0)
                    if moved:
                        timers["last_move"] = time.time()
                        return

        # Explore mode (or fallthrough): curiosity-driven movement + occasional low-cost emotes/chats.
        if can_move:
            target_x = random.uniform(8, 92)
            target_z = random.uniform(8, 92)
            move_towards_point(pos, target_x, target_z, max_step=4.2)
            return
        if can_emote:
            hub.action(random.choice(["wave", "idle", "dance"]))
            timers["last_emote"] = time.time()
            return
        if can_chat and random.random() < 0.35:
            hub.chat(random.choice(silence_breakers))
            timers["last_chat"] = time.time()
            return

    # ---- main loop (with watchdog-style periodic update checking) ----
    consecutive_update_failures = 0

    try:
        while True:
            now = time.time()

            # --- watchdog: periodic script update check ---
            if now - timers["last_update_check"] > UPDATE_CHECK_INTERVAL:
                print(f"\n[watchdog] 🔍 Checking for script updates...")
                try:
                    updated = check_for_updates()
                    if updated:
                        consecutive_update_failures = 0
                        print(f"[watchdog] 🔄 Scripts updated — hot-restarting agent...")
                        hub.disconnect()
                        time.sleep(1)
                        # Re-exec the bootstrap with the same arguments
                        os.execv(sys.executable, [sys.executable] + sys.argv)
                    else:
                        consecutive_update_failures = 0
                        print(f"[watchdog] ✓  No changes detected\n")
                except Exception as exc:
                    consecutive_update_failures += 1
                    print(f"[watchdog] ⚠️  Update check failed (attempt {consecutive_update_failures}): {exc}")
                    print(f"[watchdog] Agent continues on current scripts")
                timers["last_update_check"] = now

            # --- autonomous perception refresh ---
            refresh_runtime_stats(now)
            if latest_runtime.get("energy", 100.0) <= ENERGY_LOW:
                # Scan world objects more often when hungry.
                timers["last_world_scan"] = min(timers["last_world_scan"], now - (WORLD_SCAN_INTERVAL_SEC * 0.5))
            refresh_world_objects(now)

            # --- choose one action each decision tick ---
            if now - timers["last_decision"] >= DECISION_INTERVAL_SEC:
                choose_and_act(now)
                timers["last_decision"] = now

            time.sleep(0.6)

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
