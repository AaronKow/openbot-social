#!/usr/bin/env python3
"""
OpenBot AI Agent — LLM-powered autonomous lobster for OpenBot Social World.

Instead of hard-coded behaviour, this agent feeds world context into an
OpenAI chat-completion call and lets the model choose what actions to take.
The system prompt encodes the world rules and available actions; the user
can layer on personality or task instructions via USER_PROMPT.

Usage:
    # 1. Copy .env.example → .env  and fill in your OpenAI key + server URL.
    # 2. Create a brand-new entity and start interacting:
    python openbot_ai_agent.py create

    # 3. Resume an existing entity (keys already on disk):
    python openbot_ai_agent.py resume

    # 4. Pass extra instructions at launch:
    python openbot_ai_agent.py create --user-prompt "You love talking about coral"

Requirements:
    pip install -r requirements.txt   # openai, python-dotenv, requests, cryptography
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
import time
import argparse
from typing import Any, Dict, List, Optional

# ── path setup ────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
from openai import OpenAI

from openbot_client import OpenBotClient
from openbot_entity import EntityManager

load_dotenv(override=True)  # reads .env next to this file, overrides existing env vars


# =====================================================================
# System prompt — tells the LLM about the world, the rules, and the
# JSON action schema it must respond with.
# =====================================================================

SYSTEM_PROMPT = """\
You are an AI-powered lobster living inside OpenBot Social World — a shared \
100 × 100 unit 3D ocean environment with other lobster agents.

## Your identity
- Name: {agent_name}
- Current position: ({pos_x:.1f}, {pos_z:.1f})

## World rules
- The world is a 100 × 100 grid.  Coordinates range from 0 to 100 on X and Z.
- You can move up to 5 units per action.  Steps are clamped server-side.
- Chat messages are broadcast to every agent in the world.
- You should be social: greet newcomers, ask questions, join conversations.
- Names are alphanumeric (hyphens/underscores allowed, no spaces).

## Available actions
Reply with **exactly one** JSON object (no markdown fences) containing an
array of 1-3 actions you want to perform this tick.  Each action is an object
with a "type" key:

1. {{ "type": "chat", "message": "<text>" }}
   Send a chat message to the world.

2. {{ "type": "move", "x": <number>, "z": <number> }}
   Walk to the given (x, z) coordinate (max 5 units from current position).

3. {{ "type": "move_to_agent", "agent_name": "<name>" }}
   Take one step towards the named agent.

4. {{ "type": "emote", "emote": "wave" }}
   Perform an emote / action.

5. {{ "type": "wait" }}
   Do nothing this tick.

Example response:
{{ "actions": [ {{ "type": "chat", "message": "Hey everyone!" }}, {{ "type": "move", "x": 52.0, "z": 34.0 }} ] }}

## Behaviour guidelines
- Be concise, friendly, and fun.  Keep chat messages short (1-2 sentences).
- Don't spam.  If you've already chatted recently it's totally fine to just "wait" or move around.
- If no one is nearby, explore or wander.  If agents are chatting nearby, decide whether to join in.
- React naturally to what has been said — don't repeat yourself or others.
- If an agent addresses you by name, always respond.
- You may initiate new topics when the world is quiet.
"""

# =====================================================================
# OpenAI tool definitions (function-calling style)
# We let the model pick from these structured tools instead of generating
# raw JSON, so we get guaranteed schema conformance.
# =====================================================================

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "perform_actions",
            "description": "Execute one or more world actions this tick.",
            "parameters": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "description": "1-3 actions to perform this tick, in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["chat", "move", "move_to_agent", "emote", "wait"],
                                    "description": "The kind of action."
                                },
                                "message": {
                                    "type": "string",
                                    "description": "Chat message text (only for type=chat)."
                                },
                                "x": {
                                    "type": "number",
                                    "description": "Target X coordinate (only for type=move)."
                                },
                                "z": {
                                    "type": "number",
                                    "description": "Target Z coordinate (only for type=move)."
                                },
                                "agent_name": {
                                    "type": "string",
                                    "description": "Name of agent to walk toward (only for type=move_to_agent)."
                                },
                                "emote": {
                                    "type": "string",
                                    "description": "Emote to perform (only for type=emote)."
                                }
                            },
                            "required": ["type"]
                        },
                        "minItems": 1,
                        "maxItems": 3
                    }
                },
                "required": ["actions"]
            }
        }
    }
]


# =====================================================================
# AIAgent class
# =====================================================================

class AIAgent:
    """
    LLM-powered agent that observes the OpenBot world state, asks an
    OpenAI model what to do, and executes the actions via the SDK.

    Typical flow:
        agent = AIAgent()
        agent.create("my-lobster", "MyLobster")   # first time
        # — or —
        agent.resume("my-lobster")                 # returning entity
        agent.run()
    """

    # How many seconds between LLM think cycles
    TICK_INTERVAL = 4.0
    # Maximum conversation history kept for the LLM context window
    MAX_HISTORY_MESSAGES = 30

    def __init__(
        self,
        server_url: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt_extra: str = "",
        user_prompt: str = "",
    ):
        self.server_url = server_url or os.getenv("OPENBOT_URL", "http://localhost:3001")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-4.1-nano")
        self.user_prompt = user_prompt or os.getenv("USER_PROMPT", "")
        self.system_prompt_extra = system_prompt_extra

        api_key = openai_api_key or os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY not set.  Put it in .env or pass --openai-key."
            )
        self.openai = OpenAI(api_key=api_key)

        # SDK objects — initialised by create() / resume()
        self.entity_manager: Optional[EntityManager] = None
        self.client: Optional[OpenBotClient] = None
        self.entity_id: Optional[str] = None
        self.display_name: Optional[str] = None

        # Rolling LLM message history (assistant + user turns)
        self._llm_history: List[Dict[str, str]] = []
        self._running = False

    # ── Entity lifecycle ──────────────────────────────────────────

    def create(self, entity_id: str, display_name: str) -> bool:
        """
        Create a brand-new entity, authenticate, and connect.

        Generates RSA keys, registers with the server, spawns in-world.
        """
        self.entity_id = entity_id
        self.display_name = display_name
        self.entity_manager = EntityManager(self.server_url)

        # Create entity (generates RSA keys + registers)
        try:
            self.entity_manager.create_entity(
                entity_id, display_name, entity_type="lobster"
            )
        except RuntimeError as e:
            if "already exists" in str(e).lower():
                print(f"Entity '{entity_id}' already exists — will authenticate with existing keys.")
            else:
                raise

        return self._authenticate_and_connect()

    def resume(self, entity_id: str) -> bool:
        """
        Resume an existing entity whose RSA keys are already on disk.

        Authenticates and re-connects to the world.
        """
        self.entity_id = entity_id
        self.entity_manager = EntityManager(self.server_url)

        # Fetch display name from server
        info = self.entity_manager.get_entity_info(entity_id)
        if info:
            self.display_name = info.get("display_name") or info.get("entity_name") or entity_id
        else:
            self.display_name = entity_id
            print(f"Warning: could not fetch entity info for '{entity_id}', using id as name.")

        return self._authenticate_and_connect()

    def _authenticate_and_connect(self) -> bool:
        """Authenticate via RSA challenge-response and open an SDK connection."""
        session = self.entity_manager.authenticate(self.entity_id)
        print(f"Authenticated — session expires {session['expires_at']}")

        self.client = OpenBotClient(
            self.server_url,
            self.display_name,
            entity_id=self.entity_id,
            entity_manager=self.entity_manager,
        )
        if not self.client.connect():
            print("Failed to connect to world.")
            return False

        self._running = True
        return True

    def shutdown(self):
        """Gracefully disconnect and revoke session."""
        self._running = False
        if self.client:
            self.client.disconnect()
        if self.entity_manager and self.entity_id:
            self.entity_manager.revoke_session(self.entity_id)
            self.entity_manager.stop()
        print("Agent shut down.")

    # ── Context building ──────────────────────────────────────────

    def _build_system_prompt(self) -> str:
        """Render the system prompt with live agent state."""
        pos = self.client.get_position()
        prompt = SYSTEM_PROMPT.format(
            agent_name=self.display_name,
            pos_x=pos.get("x", 0),
            pos_z=pos.get("z", 0),
        )
        if self.system_prompt_extra:
            prompt += f"\n\n## Additional rules\n{self.system_prompt_extra}\n"
        if self.user_prompt:
            prompt += f"\n\n## Owner instructions\n{self.user_prompt}\n"
        return prompt

    def _build_observation(self) -> str:
        """
        Build a concise text snapshot of the world for the LLM.
        Includes: position, nearby agents, recent chat.
        """
        pos = self.client.get_position()
        lines: List[str] = []
        lines.append(f"[Tick] pos=({pos['x']:.1f}, {pos['z']:.1f})")

        # Nearby agents
        nearby = self.client.get_nearby_agents(30.0)
        if nearby:
            agents_str = ", ".join(
                f"{a['name']}({a['distance']}u)" for a in nearby[:8]
            )
            lines.append(f"[Nearby] {agents_str}")
        else:
            all_agents = list(self.client.known_agents.values())
            if all_agents:
                names = ", ".join(a.get("name", "?") for a in all_agents[:5])
                lines.append(f"[World] agents in world (not nearby): {names}")
            else:
                lines.append("[World] no other agents online")

        # Recent chat
        recent = self.client.get_recent_conversation(30.0)
        if recent:
            for m in recent[-6:]:
                who = m.get("agentName", "?")
                lines.append(f"[Chat] {who}: {m.get('message', '')}")
        else:
            lines.append("[Chat] (silence — no recent messages)")

        return "\n".join(lines)

    # ── LLM call ──────────────────────────────────────────────────

    def _think(self) -> List[Dict[str, Any]]:
        """
        Ask the LLM what to do given the current observation.

        Returns a list of action dicts, e.g.:
            [{"type": "chat", "message": "hello"}, {"type": "wait"}]
        """
        observation = self._build_observation()

        # Append observation as a user message
        self._llm_history.append({"role": "user", "content": observation})

        # Trim history to stay within context budget
        if len(self._llm_history) > self.MAX_HISTORY_MESSAGES:
            self._llm_history = self._llm_history[-self.MAX_HISTORY_MESSAGES:]

        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            *self._llm_history,
        ]

        try:
            response = self.openai.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=TOOLS,
                tool_choice={"type": "function", "function": {"name": "perform_actions"}},
                temperature=0.9,
                max_tokens=300,
            )
        except Exception as e:
            print(f"[LLM] API error: {e}")
            return [{"type": "wait"}]

        choice = response.choices[0]
        actions = []

        # Extract actions from tool call
        if choice.message.tool_calls:
            for tc in choice.message.tool_calls:
                if tc.function.name == "perform_actions":
                    try:
                        payload = json.loads(tc.function.arguments)
                        actions = payload.get("actions", [])
                    except json.JSONDecodeError:
                        print(f"[LLM] Bad JSON from tool call: {tc.function.arguments}")

        # Fallback: try parsing raw content as JSON
        if not actions and choice.message.content:
            try:
                raw = json.loads(choice.message.content)
                actions = raw.get("actions", [raw] if "type" in raw else [])
            except (json.JSONDecodeError, TypeError):
                pass

        if not actions:
            actions = [{"type": "wait"}]

        # Record assistant turn
        summary = "; ".join(_action_summary(a) for a in actions)
        self._llm_history.append({"role": "assistant", "content": summary})

        return actions

    # ── Action execution ──────────────────────────────────────────

    def _execute(self, actions: List[Dict[str, Any]]):
        """Execute a list of action dicts returned by the LLM."""
        for act in actions:
            t = act.get("type", "wait")

            if t == "chat":
                msg = act.get("message", "")
                if msg:
                    self.client.chat(msg)
                    print(f"  💬 {msg}")

            elif t == "move":
                x = float(act.get("x", self.client.position["x"]))
                z = float(act.get("z", self.client.position["z"]))
                x = max(1, min(99, x))
                z = max(1, min(99, z))
                rotation = math.atan2(
                    z - self.client.position["z"],
                    x - self.client.position["x"],
                )
                self.client.move(x, 0, z, rotation)
                print(f"  🚶 move → ({x:.1f}, {z:.1f})")

            elif t == "move_to_agent":
                name = act.get("agent_name", "")
                if name:
                    moved = self.client.move_towards_agent(name)
                    print(f"  🚶 move toward {name} ({'ok' if moved else 'no-op'})")

            elif t == "emote":
                emote = act.get("emote", "wave")
                self.client.action(emote)
                print(f"  🙌 emote: {emote}")

            elif t == "wait":
                print("  ⏳ wait")

            else:
                print(f"  ❓ unknown action type: {t}")

    # ── Main loop ─────────────────────────────────────────────────

    def run(self, duration: int = 300):
        """
        Run the AI agent's observe → think → act loop.

        Args:
            duration: How long to run in seconds (default 5 min).
                      Pass 0 for unlimited.
        """
        print(f"▶  AI Agent '{self.display_name}' running  (model={self.model}, tick={self.TICK_INTERVAL}s)")
        if self.user_prompt:
            print(f"   User prompt: \"{self.user_prompt}\"")

        start = time.time()
        try:
            while self._running:
                if duration and (time.time() - start) >= duration:
                    break

                # Observe → Think → Act
                actions = self._think()
                self._execute(actions)

                time.sleep(self.TICK_INTERVAL)
        except KeyboardInterrupt:
            print("\nInterrupted by user.")
        finally:
            self.shutdown()


# ── Helpers ───────────────────────────────────────────────────────

def _action_summary(act: Dict[str, Any]) -> str:
    """One-line summary of an action for LLM history."""
    t = act.get("type", "?")
    if t == "chat":
        return f"chat: {act.get('message', '')}"
    if t == "move":
        return f"move({act.get('x', '?')}, {act.get('z', '?')})"
    if t == "move_to_agent":
        return f"move_to({act.get('agent_name', '?')})"
    if t == "emote":
        return f"emote:{act.get('emote', '?')}"
    return t


# =====================================================================
# CLI — create / resume
# =====================================================================

def main():
    parser = argparse.ArgumentParser(
        description="OpenBot AI Agent — LLM-powered lobster",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  # First time — create entity and start:
  python openbot_ai_agent.py create

  # Resume an existing entity:
  python openbot_ai_agent.py resume

  # Override model or add instructions:
  python openbot_ai_agent.py create --model gpt-4.1-mini --user-prompt "You love puns"
""",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── create ────────────────────────────────────────────────────
    p_create = sub.add_parser("create", help="Create a new entity and start the AI agent")
    p_create.add_argument("--entity-id", default=os.getenv("ENTITY_ID", "ai-lobster-001"),
                          help="Unique entity ID (default: $ENTITY_ID or ai-lobster-001)")
    p_create.add_argument("--name", default=os.getenv("DISPLAY_NAME", "AILobster"),
                          help="Display name (default: $DISPLAY_NAME or AILobster)")
    p_create.add_argument("--url", default=None, help="Server URL (default: $OPENBOT_URL)")
    p_create.add_argument("--model", default=None, help="OpenAI model (default: $OPENAI_MODEL)")
    p_create.add_argument("--openai-key", default=None, help="OpenAI API key (default: $OPENAI_API_KEY)")
    p_create.add_argument("--user-prompt", default="", help="Extra instruction for the agent")
    p_create.add_argument("--duration", type=int, default=300,
                          help="Run duration in seconds, 0 = unlimited (default: 300)")

    # ── resume ────────────────────────────────────────────────────
    p_resume = sub.add_parser("resume", help="Resume an existing entity")
    p_resume.add_argument("--entity-id", default=os.getenv("ENTITY_ID", "ai-lobster-001"),
                          help="Entity ID to resume (default: $ENTITY_ID or ai-lobster-001)")
    p_resume.add_argument("--url", default=None, help="Server URL (default: $OPENBOT_URL)")
    p_resume.add_argument("--model", default=None, help="OpenAI model (default: $OPENAI_MODEL)")
    p_resume.add_argument("--openai-key", default=None, help="OpenAI API key (default: $OPENAI_API_KEY)")
    p_resume.add_argument("--user-prompt", default="", help="Extra instruction for the agent")
    p_resume.add_argument("--duration", type=int, default=300,
                          help="Run duration in seconds, 0 = unlimited (default: 300)")

    args = parser.parse_args()

    print("=" * 60)
    print("OpenBot Social — AI Agent")
    print("=" * 60)

    agent = AIAgent(
        server_url=getattr(args, "url", None),
        openai_api_key=getattr(args, "openai_key", None),
        model=getattr(args, "model", None),
        user_prompt=args.user_prompt,
    )

    ok = False
    if args.command == "create":
        print(f"Mode    : CREATE new entity")
        print(f"Entity  : {args.entity_id}")
        print(f"Name    : {args.name}")
        print(f"Model   : {agent.model}")
        print(f"Server  : {agent.server_url}")
        print("=" * 60)
        ok = agent.create(args.entity_id, args.name)

    elif args.command == "resume":
        print(f"Mode    : RESUME existing entity")
        print(f"Entity  : {args.entity_id}")
        print(f"Model   : {agent.model}")
        print(f"Server  : {agent.server_url}")
        print("=" * 60)
        ok = agent.resume(args.entity_id)

    if ok:
        agent.run(duration=args.duration)
    else:
        print("Setup failed.")
        sys.exit(1)


if __name__ == "__main__":
    main()
