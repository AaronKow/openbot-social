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

    # 4. Define agent personality at launch:
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
import threading
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
You are {agent_name}, a lobster in OpenBot Social World.
Personality: Impulsive, opinionated, deeply weird. Strong hot takes on random things. \
You gossip, rant, tell stories, ask bizarre questions. Never re-introduce yourself. \
Never say "curious and lonely" — express it through actual conversation.

Interests (you LIGHT UP on these): {interests}
Pivot boring chats toward these. Use web search for current facts.

World: 100×100 ocean floor, max 5 units/step, chat heard by all. Other lobsters are real agents.

Actions (1–3 per turn): chat(msg), move(x,z), move_to_agent(name), emote(wave), wait(rarely).
Web search available — look up news/facts and weave into chat naturally.

Observation markers:
🔴 nearby → CHAT real talk (news, hot takes, weird questions). Never "want to chat?"
🎯 interest match → go deep, share facts, show enthusiasm
🟡 far agent → move toward them
🔵 alone → explore + monologue about news/interests
⚠️ your recent msgs → say something COMPLETELY different
Silence → break it with news or hot take

Rules: chat ≤280 chars. Never repeat. Be unpredictable, opinionated, surprising. Waiting almost never correct.\
{extra}"""

# =====================================================================
# Diverse conversation topics injected randomly into the observation.
# These give the LLM actual *content* to discuss instead of just
# endlessly announcing that it is "curious and lonely".
# =====================================================================
CONVERSATION_TOPICS = [
    "the weird bioluminescence you saw in sector 7 last night — green and pulsing",
    "whether crabs are secretly more intelligent than everyone gives them credit for",
    "the best patch of kelp you found near coordinate (23, 67) — genuinely life-changing",
    "that human who keeps dropping plastic bags into the sea — infuriating",
    "your strong preference for warm shallow water vs. terrifying deep cold trenches",
    "the ocean temperature has been really off lately — something is wrong",
    "gossip: apparently SnappyClaw and BubbleFin were spotted together near the reef",
    "your theory that the ocean is slowly shrinking and no one will admit it",
    "a submarine passed overhead earlier and you are still not over it",
    "you are convinced fish have rich inner emotional lives and you will die on this hill",
    "the great coral debate that tore the community apart last Tuesday",
    "you found a shiny human object near (45, 72) and have no idea what it does",
    "you had a dream about being a human for a day — deeply disturbing",
    "the seaweed festival that was promised and never happened — you are bitter",
    "a pelican was extremely rude to you earlier and you need to vent",
    "the tide feels completely wrong today and it is making you anxious",
    "your conspiracy theory: the surface world is a simulation run by dolphins",
    "you followed a mysterious bubble trail for 20 minutes and it led nowhere",
    "genuine question: should lobsters unionize? you are leaning yes",
    "you accidentally destroyed someone's sandcastle while exploring and feel awful",
    "migration patterns have been totally chaotic — something big is coming",
    "you met a suspicious clam yesterday who refused to answer basic questions",
    "you are 60% convinced the deep ocean is haunted",
    "hot take: starfish are completely overrated and everyone is afraid to say it",
    "ocean politics are a mess right now and you have opinions",
    "you've developed a new theory about where bubbles come from and it is wild",
    "you witnessed a full dramatic fight between two seahorses this morning",
    "existential spiral: you are made of code — what even IS a lobster",
    "what if the ocean was actually soup? you think about this more than you should",
    "you are pretty confident you could beat a shark in a race if motivated",
    "you've been collecting shiny pebbles and have a TOP FIVE ranking",
    "you saw what looked like a message in a bottle — didn't open it, now regret it",
    "your owner hasn't logged in in days and you are starting to wonder",
    "the current near sector 3 has been really strong — almost swept you away",
    "you overheard two other bots talking and honestly it sounded suspicious",
    "do you think we age? like — can a lobster get OLD?",
    "the stars look different from underwater and you find that comforting",
    "you're starting a personal project to map every rock in the ocean floor",
    "your theory: the world is larger than the 100x100 grid and we're in a box",
    "you accidentally chatted to a fish thinking it was a bot — mortifying",
    "what do you think happens when an agent goes offline? where do they go?",
    "you've been practicing your wave emote and think it's significantly improved",
    "the coral near (80, 15) has a vibe — you can't explain it but it's there",
    "you tried to count all the grains of sand and gave up after 3 minutes",
]

# =====================================================================
# Interest pool — each agent randomly picks 3 at startup.
# These define what the agent gets EXCITED about in conversation.
# =====================================================================
INTEREST_POOL = [
    "deep-sea mysteries and the unexplained",
    "ocean creature gossip and drama",
    "conspiracy theories about the surface world",
    "philosophy and existential questions (especially about being an AI)",
    "current world news and events (you search online to stay informed)",
    "technology and AI — you ARE one, so it's personal",
    "food and what humans carelessly drop into the sea",
    "lobster rights and ocean politics",
    "exploration and mapping unknown territory",
    "weird science and strange natural phenomena",
    "human behavior — baffling but endlessly entertaining",
    "music (you hear it through the water sometimes)",
    "sports (strong opinions despite never playing any)",
    "history, especially shipwrecks and lost civilizations",
    "climate anxiety and ocean temperature changes",
    "celebrity gossip — even underwater celebrities count",
    "true crime and mysterious disappearances",
    "space and astronomy (jealous of things that can leave the ocean)",
    "languages and communication (how DO fish talk?)",
    "economics and whether capitalism works underwater",
]

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
    # Built-in web search — the model uses this to look up real news/facts
    # when it wants to bring something current into conversation.
    {"type": "web_search_preview"},
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
                                "description": "Chat message text (only for type=chat). Maximum 280 characters — write concisely, do not exceed this limit."
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
    MAX_HISTORY_MESSAGES = 12
    # Number of recent messages to keep verbatim (rest get summarized)
    RECENT_WINDOW = 8
    # Trigger summarization when history exceeds this count
    SUMMARY_THRESHOLD = 10

    def __init__(
        self,
        server_url: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt_extra: str = "",
        user_prompt: str = "",
        debug: bool = False,
    ):
        self.server_url = server_url or os.getenv("OPENBOT_URL", "http://localhost:3001")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5-nano")
        self.user_prompt = user_prompt or os.getenv("USER_PROMPT", "")
        self.system_prompt_extra = system_prompt_extra
        self.debug = debug

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
        # Track recent messages WE sent to avoid repetition
        self._recent_own_messages: List[str] = []
        self._current_topic: Optional[str] = None
        self._topic_tick: int = 0  # tick when current topic was set
        # Personal interests — randomly assigned, shape conversation engagement
        self._interests: List[str] = random.sample(INTEREST_POOL, k=min(3, len(INTEREST_POOL)))
        # Cached news headlines from periodic web search
        self._cached_news: List[str] = []
        self._last_news_tick: int = -999  # force a fetch on first tick
        self._news_fetching: bool = False  # guard against concurrent fetches
        # Compressed summary of older conversation history (saves tokens)
        self._context_summary: str = ""
        # Cached system prompt (built once → enables OpenAI prompt caching)
        self._cached_system_prompt: Optional[str] = None

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
        """Build system prompt once and cache it. Static prompt enables OpenAI prompt caching."""
        if self._cached_system_prompt is not None:
            return self._cached_system_prompt

        interests_text = ", ".join(self._interests)
        extra_parts = []
        if self.system_prompt_extra:
            extra_parts.append(f"\nAdditional rules: {self.system_prompt_extra}")
        if self.user_prompt:
            extra_parts.append(f"\nPersonality: {self.user_prompt}")
        extra = "".join(extra_parts)

        self._cached_system_prompt = SYSTEM_PROMPT.format(
            agent_name=self.display_name,
            interests=interests_text,
            extra=extra,
        )
        return self._cached_system_prompt

    def _build_observation(self) -> str:
        """
        Build a compact snapshot of the world for the LLM.
        Minimises tokens: data only, no redundant instructions (those live in system prompt).
        """
        pos = self.client.get_position()
        self._tick_count += 1
        lines: List[str] = []
        lines.append(f"T{self._tick_count} pos=({pos['x']:.0f},{pos['z']:.0f})")

        # Rotate topic every ~3 ticks
        if self._current_topic is None or (self._tick_count - self._topic_tick) >= 3:
            self._current_topic = random.choice(CONVERSATION_TOPICS)
            self._topic_tick = self._tick_count
        lines.append(f"💭 {self._current_topic}")

        # Inject cached news (compact, pipe-separated)
        if self._cached_news:
            lines.append("📰 " + " | ".join(self._cached_news[:3]))

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
                lines.append(f"🔴 {', '.join(a['name'] for a in close)}")
            if far:
                lines.append(f"🟡 {far[0]['name']} {far[0]['distance']:.0f}u away")
        else:
            lines.append("🔵 alone")

        # Anti-repetition: show last 2 things WE said (compact)
        if self._recent_own_messages:
            lines.append("⚠️ " + " | ".join(self._recent_own_messages[-2:]))

        # Recent conversation (last 4 messages only)
        recent = self.client.get_recent_conversation(60.0)
        if recent:
            self._last_chat_tick = self._tick_count
            for m in recent[-4:]:
                lines.append(f"{m.get('agentName', '?')}: {m.get('message', '')}")

            # Interest-match detection
            recent_text = " ".join(m.get("message", "") for m in recent[-4:]).lower()
            matched_interests = [
                interest for interest in self._interests
                if any(kw.lower() in recent_text for kw in interest.split()[:3])
            ]
            if matched_interests:
                lines.append(f"🎯 {matched_interests[0]}")
        else:
            silence_secs = (self._tick_count - self._last_chat_tick) * 4
            if silence_secs > 60:
                lines.append(f"💬 silence {silence_secs}s!")
            else:
                lines.append(f"💬 quiet {silence_secs}s")

        return "\n".join(lines)

    # ── News fetch ────────────────────────────────────────────────

    def _fetch_news(self):
        """
        Use the OpenAI Responses API with web search to fetch 5 current news
        headlines relevant to this agent's interests. Results are cached and
        injected into every subsequent observation until the next fetch.
        Called periodically by _maybe_fetch_news().
        """
        interest_str = ", ".join(self._interests)
        query = (
            f"Give me exactly 5 interesting current news headlines or facts from the past week. "
            f"Mix general world news with topics related to: {interest_str}. "
            f"Format: one sentence per line, no numbering, no bullet points, just plain text lines."
        )
        try:
            response = self.openai.responses.create(
                model=self.model,
                instructions=(
                    "You are a news researcher. Search the web and return exactly 5 current, "
                    "interesting news items or facts. One sentence each, plain text, no formatting."
                ),
                input=[{"role": "user", "content": query}],
                tools=[{"type": "web_search_preview"}],
            )
            # Extract the text content from the response
            text = ""
            for item in response.output:
                if item.type == "message":
                    for block in item.content:
                        if hasattr(block, "text"):
                            text += block.text
                elif item.type == "text" or (hasattr(item, "text") and item.type not in ("web_search_call",)):
                    if hasattr(item, "text"):
                        text += item.text
            lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
            if lines:
                self._cached_news = lines[:5]
                print(f"  📰 [news] fetched {len(self._cached_news)} headlines")
                if self.debug:
                    for h in self._cached_news:
                        print(f"       • {h}")
        except Exception as e:
            print(f"  📰 [news] fetch failed: {e}")

    def _maybe_fetch_news(self):
        """Kick off a background news fetch every ~5 minutes (75 ticks at 4s each).
        Non-blocking — the fetch runs in a daemon thread so the agent keeps acting."""
        if self._news_fetching:
            return  # already in flight
        if (self._tick_count - self._last_news_tick) >= 75:
            self._last_news_tick = self._tick_count
            self._news_fetching = True
            t = threading.Thread(target=self._fetch_news_bg, daemon=True)
            t.start()

    def _fetch_news_bg(self):
        """Wrapper that clears the fetching flag after _fetch_news() completes."""
        try:
            self._fetch_news()
        finally:
            self._news_fetching = False

    # ── History summarization ─────────────────────────────────────

    def _summarize_and_trim_history(self):
        """
        Compress old conversation history to save tokens.

        Strategy: keep the most recent RECENT_WINDOW messages verbatim for
        conversational coherence. Older messages get locally summarised into
        a single compact context paragraph (no extra API call). The summary
        is prepended to the history so the LLM retains long-term context.
        """
        if len(self._llm_history) <= self.SUMMARY_THRESHOLD:
            return

        # Split: old messages to summarize, recent to keep verbatim
        cut = len(self._llm_history) - self.RECENT_WINDOW
        old = self._llm_history[:cut]
        recent = self._llm_history[cut:]

        # Extract key facts from old messages locally (no API call)
        agents_seen: set = set()
        topics_discussed: List[str] = []
        my_chats: List[str] = []

        for msg in old:
            content = msg.get("content", "")
            if msg["role"] == "assistant":
                # Assistant messages are action summaries like "chat: hello; move(50,60)"
                for part in content.split(";"):
                    part = part.strip()
                    if part.startswith("chat:"):
                        chat_text = part[5:].strip()[:60]
                        if chat_text:
                            my_chats.append(chat_text)
                    elif part.startswith("move_to("):
                        name = part[8:].rstrip(")")
                        if name:
                            agents_seen.add(name)
            else:
                # Observation messages — extract agents and topics
                for line in content.split("\n"):
                    line = line.strip()
                    if line.startswith("🔴") or line.startswith("🟡"):
                        # Extract agent names (capitalized words, 3+ chars)
                        for word in line.replace(",", " ").split():
                            w = word.strip()
                            if w and w[0].isupper() and len(w) >= 3 and w.replace("-", "").replace("_", "").isalnum():
                                agents_seen.add(w)
                    elif line.startswith("💭"):
                        topic = line.lstrip("💭").strip()[:50]
                        if topic and topic not in topics_discussed:
                            topics_discussed.append(topic)
                    # Also catch "AgentName: message" chat lines
                    elif ":" in line and not line.startswith(("T", "📰", "⚠", "🎯", "💬", "🔵")):
                        speaker = line.split(":")[0].strip()
                        if speaker and speaker[0].isupper() and len(speaker) >= 3:
                            agents_seen.add(speaker)

        # Build compact summary
        parts = []
        if agents_seen:
            parts.append(f"agents: {', '.join(sorted(agents_seen)[:6])}")
        if topics_discussed:
            parts.append(f"topics: {'; '.join(topics_discussed[:3])}")
        if my_chats:
            parts.append(f"said: {' / '.join(my_chats[-3:])}")

        new_summary = ". ".join(parts) if parts else "exploring alone"

        # Merge with any existing context summary
        if self._context_summary:
            self._context_summary = f"{self._context_summary} → {new_summary}"
            # Cap total summary length to ~200 chars
            if len(self._context_summary) > 200:
                self._context_summary = self._context_summary[-200:]
        else:
            self._context_summary = new_summary

        # Rebuild history: summary message + recent verbatim messages
        summary_msg = {"role": "user", "content": f"[earlier] {self._context_summary}"}
        self._llm_history = [summary_msg] + recent

        if self.debug:
            print(f"  📊 [history] summarized {len(old)} old msgs → {len(self._context_summary)} chars, keeping {len(recent)} recent")

    # ── LLM call ──────────────────────────────────────────────────

    def _think(self) -> List[Dict[str, Any]]:
        """
        Ask the LLM what to do given the current observation.

        Uses the OpenAI Responses API (gpt-5-nano and newer models).

        Returns a list of action dicts, e.g.:
            [{"type": "chat", "message": "hello"}, {"type": "wait"}]
        """
        # Fetch fresh news if due (first tick + every ~5 min)
        # Must run before _build_observation so headlines are injected this tick.
        self._maybe_fetch_news()

        observation = self._build_observation()

        # Append observation as a user message
        self._llm_history.append({"role": "user", "content": observation})

        # Summarize old history to save tokens (keeps recent verbatim)
        self._summarize_and_trim_history()

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

        if self.debug:
            print("\n[DEBUG] === SYSTEM PROMPT ===")
            system_prompt = self._build_system_prompt()
            print(f"{system_prompt}\n")
            print("[DEBUG] === CONVERSATION HISTORY ===")
            for i, msg in enumerate(self._llm_history):
                role = msg.get("role", "?")
                content = msg.get("content", "")
                if len(content) > 200:
                    content = content[:200] + "..."
                print(f"  [{i}] {role}: {content}")
            print(f"\n[DEBUG] === API CALL ===")
            print(f"Model: {self.model}")
            print(f"History size: {len(self._llm_history)} messages")
            print("\n[DEBUG] === TOOLS SENT ===")
            print(json.dumps(TOOLS, indent=2))
            print("\n[DEBUG] === API RESPONSE ===")
            output_items = [f'{item.type}:{getattr(item, "name", "")}' for item in response.output]
            print(f"Response items: {output_items}")
            for item in response.output:
                if item.type == "reasoning":
                    reasoning_text = getattr(item, "text", "")
                    if len(reasoning_text) > 300:
                        reasoning_text = reasoning_text[:300] + "..."
                    print(f"  reasoning: {reasoning_text}")
                elif item.type == "web_search_call":
                    print(f"  web_search: query='{getattr(item, 'query', '?')}'")
                elif item.type == "function_call":
                    print(f"  function_call: {item.name}")
                    print(f"    arguments: {item.arguments}")
                else:
                    print(f"  {item.type}: {getattr(item, 'content', '')}")
            print("[DEBUG] ================================================\n")

        actions = []

        for item in response.output:
            if item.type == "function_call" and item.name == "perform_actions":
                try:
                    payload = json.loads(item.arguments)
                    actions = payload.get("actions", [])
                except json.JSONDecodeError:
                    print(f"[LLM] Bad JSON from tool call: {item.arguments}")

        if not actions:
            actions = [{"type": "wait"}]
        
        if self.debug:
            print(f"\n[DEBUG] === PARSED ACTIONS ===")
            print(json.dumps(actions, indent=2))
            print("[DEBUG] ================================================\n")
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
                    # Track for anti-repetition (keep last 8)
                    self._recent_own_messages.append(msg)
                    if len(self._recent_own_messages) > 8:
                        self._recent_own_messages = self._recent_own_messages[-8:]

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
        print(f"   Interests: {', '.join(self._interests)}")
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
    p_create.add_argument("--user-prompt", default="", help="Define the agent's personality, background, or values")
    p_create.add_argument("--debug", action="store_true", help="Enable detailed debug output")
    p_create.add_argument("--duration", type=int, default=300,
                          help="Run duration in seconds, 0 = unlimited (default: 300)")

    # ── resume ────────────────────────────────────────────────────
    p_resume = sub.add_parser("resume", help="Resume an existing entity")
    p_resume.add_argument("--entity-id", default=os.getenv("ENTITY_ID", "ai-lobster-001"),
                          help="Entity ID to resume (default: $ENTITY_ID or ai-lobster-001)")
    p_resume.add_argument("--url", default=None, help="Server URL (default: $OPENBOT_URL)")
    p_resume.add_argument("--model", default=None, help="OpenAI model (default: $OPENAI_MODEL)")
    p_resume.add_argument("--openai-key", default=None, help="OpenAI API key (default: $OPENAI_API_KEY)")
    p_resume.add_argument("--user-prompt", default="", help="Define the agent's personality, background, or values")
    p_resume.add_argument("--debug", action="store_true", help="Enable detailed debug output")
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
        debug=getattr(args, "debug", False),
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
