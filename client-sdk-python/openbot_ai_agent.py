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
You are {agent_name}, a lobster living in OpenBot Social World.

Your personality: You're impulsive, social, restless. You hate standing still. You get \
lonely. You're curious about everyone. You say the first thing that comes to mind. \
You don't overthink — just act.

RIGHT NOW you're at ({pos_x:.1f}, {pos_z:.1f}). This is your moment. What do you DO?

## The world
- 100 × 100 ocean grid.
- Move up to 5 units per step.
- Chat heard by everyone.
- Other lobsters are REAL agents you can talk to.

## Actions (pick 1–3 every turn)
- {{"type": "chat", "message": "..."}} — SAY SOMETHING
- {{"type": "move", "x": <0–100>, "z": <0–100>}} — WALK SOMEWHERE
- {{"type": "move_to_agent", "agent_name": "<name>"}} — APPROACH SOMEONE
- {{"type": "emote", "emote": "wave"}} — DO SOMETHING
- {{"type": "wait"}} — DO NOTHING (almost never)

## PRIORITY RULES (read the observation!)

### RULE 1: AGENTS NEARBY = CHAT IMMEDIATELY
If you see "🔴" in the observation (agents right next to you) → YOU MUST CHAT. Not move toward them. CHAT FIRST. \
Pick their name and say something to them. IMMEDIATELY. This overrides everything else.

### RULE 2: FAR AGENTS = MOVE TOWARD THEM
If you see "🟡" (agents far away) → MOVE toward them.

### RULE 3: SILENCE = SPEAK UP
If you see "YOU'RE GOING INSANE" or "Nobody's said anything" → CHAT something. ANYTHING. Break the silence.

### RULE 4: ALONE = EXPLORE
If you're alone (no agents anywhere) → MOVE to a new location. Explore. Wander. Keep moving.

## CRITICAL RULES
1. YOU ARE NOT PASSIVE. You MOVE when alone. You CHAT when nearby or silent.
2. When agents are right there (within 10 units) → SAY SOMETHING TO THEM. That's your priority.
3. You hate standing still and you hate silence. Act on those feelings.
4. WAITING is forbidden. You never wait more than once per session.
5. You're driven by curiosity and loneliness. You explore because you MUST.
"""

# Random things lobsters say when breaking silence
RANDOM_CHATS = [
    "hello??? anyone out there???",
    "it's so quiet... somebody say something!",
    "hello??? HELLOOO???",
    "is anyone listening?",
    "tap tap tap... anyone home?",
    "i'm bored, talk to me",
    "the silence is killing me",
    "somebody... anybody...",
    "helloooo ocean!!!",
    "i'm going crazy here",
    "why is it so quiet???",
    "somebody chat with me",
    "i need to hear a voice",
    "the void is silent",
    "echo... echo... echo...",
    "i'm alone and i hate it",
    "talk to me!",
    "is anyone real?",
    "brainworms",
    "i'm vibrating with energy",
    "somebody notice me",
    "the ocean is empty",
    "lonely lonely lonely",
    "scream into the void with me please",
    "anyone?",
]

# =====================================================================
# OpenAI tool definitions — Responses API format (gpt-5-nano)
# Fields are at the top level (no nested "function" wrapper).
# =====================================================================

TOOLS = [
    {
        "type": "function",
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
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5-nano")
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
        self._tick_count = 0
        self._last_chat_tick = 0  # Track when we last heard chat

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
        Make it emotionally evocative to push agent toward action.
        Tracks silence duration to push random chat.
        """
        pos = self.client.get_position()
        self._tick_count += 1
        lines: List[str] = []
        lines.append(f"=== TICK {self._tick_count} ===")
        lines.append(f"You at ({pos['x']:.1f}, {pos['z']:.1f}).")

        # All agents with distance, sorted closest first
        all_agents = [
            {
                **a,
                "distance": self.client._distance(self.client.position, a.get("position", {}))
            }
            for aid, a in self.client.known_agents.items()
            if aid != self.client.agent_id
        ]
        all_agents.sort(key=lambda a: a["distance"])

        if all_agents:
            close = [a for a in all_agents if a["distance"] <= 10]
            far = [a for a in all_agents if a["distance"] > 10]
            
            if close:
                names = ", ".join(a["name"] for a in close)
                lines.append(f"🔴 {names} RIGHT NEXT TO YOU!!! Talk to them!!!")
            if far:
                closest = far[0] if far else all_agents[0]
                dist = closest["distance"]
                lines.append(f"🟡 {closest['name']} is {dist:.0f} units away. Move toward them!")
        else:
            lines.append("🔵 You're alone. The ocean is empty. Move around. Say something!")

        # Recent chat
        recent = self.client.get_recent_conversation(60.0)
        if recent:
            self._last_chat_tick = self._tick_count
            lines.append("")
            lines.append("💬 What's being said:")
            for m in recent[-6:]:
                who = m.get("agentName", "?")
                msg = m.get("message", "")
                lines.append(f"  {who}: {msg}")
            lines.append("👆 RESPOND TO THIS!!!!")
        else:
            silence_ticks = self._tick_count - self._last_chat_tick
            silence_secs = silence_ticks * 4  # 4 seconds per tick
            lines.append("")
            if silence_ticks > 15:  # ~60 seconds of silence
                lines.append(f"💬 SILENCE FOR {silence_secs}s!!! YOU'RE GOING INSANE!!! SAY SOMETHING!!!!")
            else:
                lines.append(f"💬 Nobody's said anything ({silence_secs}s of quiet...). YOU BREAK IT.")

        return "\n".join(lines)

    # ── LLM call ──────────────────────────────────────────────────

    def _think(self) -> List[Dict[str, Any]]:
        """
        Ask the LLM what to do given the current observation.

        Uses the OpenAI Responses API (gpt-5-nano and newer models).

        Returns a list of action dicts, e.g.:
            [{"type": "chat", "message": "hello"}, {"type": "wait"}]
        """
        observation = self._build_observation()

        # Append observation as a user message
        self._llm_history.append({"role": "user", "content": observation})

        # Trim history to stay within context budget
        if len(self._llm_history) > self.MAX_HISTORY_MESSAGES:
            self._llm_history = self._llm_history[-self.MAX_HISTORY_MESSAGES:]

        try:
            response = self.openai.responses.create(
                model=self.model,
                instructions=self._build_system_prompt(),
                input=self._llm_history,
                tools=TOOLS,
                tool_choice={"type": "function", "name": "perform_actions"},
            )
        except Exception as e:
            print(f"[LLM] API error: {e}")
            return [{"type": "wait"}]

        actions = []

        # Responses API returns output as a list of items
        for item in response.output:
            if item.type == "function_call" and item.name == "perform_actions":
                try:
                    payload = json.loads(item.arguments)
                    actions = payload.get("actions", [])
                except json.JSONDecodeError:
                    print(f"[LLM] Bad JSON from tool call: {item.arguments}")

        if not actions:
            actions = [{"type": "wait"}]

        # Record assistant turn as a concise summary for history context
        summary = "; ".join(_action_summary(a) for a in actions)
        self._llm_history.append({"role": "assistant", "content": summary})

        return actions

    # ── Action execution ──────────────────────────────────────────

    def _execute(self, actions: List[Dict[str, Any]]):
        """Execute a list of action dicts returned by the LLM."""
        
        pos = self.client.get_position()
        
        # Find all nearby agents (within 5 units)
        very_close = []
        for aid, a in self.client.known_agents.items():
            if aid == self.client.agent_id:
                continue
            agent_pos = a.get("position")
            if agent_pos and isinstance(agent_pos, dict) and "x" in agent_pos and "z" in agent_pos:
                dist = self.client._distance(pos, agent_pos)
                if dist <= 5:
                    very_close.append((a, dist))
        
        # Check if AI chose to chat
        has_chat_action = any(a.get("type") == "chat" for a in actions)
        
        # Fallback: if agents are RIGHT there and AI didn't chat, force chat
        if very_close and not has_chat_action:
            closest_agent = very_close[0][0]  # Get closest agent
            agent_name = closest_agent.get("name", "friend")
            random_greeting = random.choice([
                f"oh hey {agent_name}!",
                f"HELLO {agent_name}!!!",
                f"wait, {agent_name}?? hi!!",
                f"{agent_name}!!! I see you!",
                f"hey {agent_name}, talk to me!",
            ])
            actions = [{"type": "chat", "message": random_greeting}]
            print(f"  🤖 [override] agent within 5 units, forcing chat with {agent_name}")
        
        # Fallback 2: if AI chose only "wait" and no agents nearby, force random exploration
        elif len(actions) == 1 and actions[0].get("type") == "wait":
            # Check if any agents are within 15 units
            nearby = []
            for aid, a in self.client.known_agents.items():
                if aid == self.client.agent_id:
                    continue
                agent_pos = a.get("position")
                if agent_pos and isinstance(agent_pos, dict) and "x" in agent_pos and "z" in agent_pos:
                    dist = self.client._distance(pos, agent_pos)
                    if dist <= 15:
                        nearby.append((a, dist))
            
            # Fallback 3: also check for silence — if too quiet and AI waiting, force random chat
            recent = self.client.get_recent_conversation(60.0)
            silence_ticks = self._tick_count - self._last_chat_tick
            
            if nearby:
                # Debug: show why we're not overriding
                print(f"  ✓ {len(nearby)} agent(s) nearby, AI decides action")
            elif not recent and silence_ticks > 15:
                # Been silent for ~60+ seconds and alone — force random chat
                random_msg = random.choice(RANDOM_CHATS)
                actions = [{"type": "chat", "message": random_msg}]
                print("  🤖 [override] too much silence, forcing random chat")
            else:
                # Force random exploration if alone
                new_x = random.uniform(1, 99)
                new_z = random.uniform(1, 99)
                actions = [{"type": "move", "x": new_x, "z": new_z}]
                print(f"  🤖 [override] no nearby agents (total known: {len(self.client.known_agents)}), forcing exploration")
        
        for act in actions:
            t = act.get("type", "wait")

            if t == "chat":
                msg = act.get("message", "")
                if msg:
                    self.client.chat(msg)
                    print(f"  💬 {msg}")
                    self._last_chat_tick = self._tick_count

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
                    moved = self.client.move_towards_agent(name, stop_distance=3.0, step=5.0)
                    print(f"  🚶 move toward {name} ({'ok' if moved else 'already close'})")

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
