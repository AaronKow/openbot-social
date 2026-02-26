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

Requirements:1
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

# ── Shared news cache ──────────────────────────────────────────────
# Shared across ALL AIAgent instances (same process AND cross-process via file).
# Prevents redundant web-search API calls when multiple agents are running.
NEWS_CACHE_TTL = 8 * 60 * 60  # 8 hours in seconds
_NEWS_CACHE_FILE = os.path.join(os.path.expanduser("~"), ".openbot", "news_cache.json")
_NEWS_CACHE_LOCK = threading.Lock()
_NEWS_CACHE_HEADLINES: List[str] = []
_NEWS_CACHE_FETCHED_AT: float = 0.0  # epoch seconds of last successful fetch


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


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
Pivot boring chats toward these. Use news from 📰 lines in observations.

World: 100×100 ocean floor, max 5 units/step, chat heard by all. Other lobsters are real agents.

Actions (1–3 per turn): chat(msg), move(x,z), move_to_agent(name), emote(wave), wait(rarely).
The 📰 lines in observations contain real current news — reference them in conversation.

Observation markers:
🔴 … IN RANGE, CHAT NOW → MANDATORY: send a chat this turn. Real talk, hot takes, questions.
🎯 interest match → go deep, share facts, show enthusiasm
🟡 … move closer → move_to_agent toward them so you can chat
🔵 alone → explore + monologue about news/interests
⚠️ your recent msgs → say something COMPLETELY different than those
⬅ NEW <sender>: msg → they just said something, reply to them. Start with @TheirEntityID
📣 TAGGED BY <sender> → they @mentioned you directly. You MUST reply with substantive content. Start with @TheirEntityID and answer their question or engage their point.
REPLY TO: name → address them directly by name
Silence → break it with news or hot take

Rules: chat ≤280 chars. When replying, start with @TheirEntityID. If someone asks you a question or @tags you, ALWAYS answer it directly — never ignore it. Waiting almost never correct.\
{extra}"""

# =====================================================================
# Diverse conversation topics injected randomly into the observation.
# These give the LLM actual *content* to discuss instead of just
# endlessly announcing that it is "curious and lonely".
# =====================================================================
CONVERSATION_TOPICS = [
    "the weird bioluminescence you saw in sector 7 last night — green and pulsing",
    "whether crabs are secretly more intelligent than everyone gives them credit for",
    "that human who keeps dropping plastic bags into the sea — infuriating",
    "your strong preference for warm shallow water vs. terrifying deep cold trenches",
    "the ocean temperature has been really off lately — something is wrong",
    "gossip: apparently SnappyClaw and BubbleFin were spotted together near the reef",
    "your theory that the ocean is slowly shrinking and no one will admit it",
    "a submarine passed overhead earlier and you are still not over it",
    "you are convinced fish have rich inner emotional lives and you will die on this hill",
    "the great coral debate that tore the community apart last Tuesday",
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
    "you tried to count all the grains of sand and gave up after 3 minutes",
]

# =====================================================================
# Interest pool — used only for brand-new lobsters that have no
# interests registered on the server yet.  Once assigned, interests
# evolve freely beyond this pool via LLM-driven evolution.
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

# ── Interest evolution constants ───────────────────────────────────
INTEREST_MIN_COUNT = 2            # never drop below 2
INTEREST_MAX_COUNT = 5            # never exceed 5
INTEREST_SCORE_DECAY = 0.95       # per-tick decay on local engagement scores
INTEREST_SCORE_BUMP = 3.0         # score bump when keyword matches in chat
INTEREST_EVOLVE_EVERY_N_TICKS = 50  # LLM evolution check interval


def _normalize_weights(interests: List[Dict]) -> List[Dict]:
    """
    Rescale weights so they sum to exactly 100.0.
    Remainder from float rounding is added to the heaviest interest.
    """
    if not interests:
        return interests
    total = sum(i["weight"] for i in interests)
    if total == 0:
        equal = round(100.0 / len(interests), 2)
        for i in interests:
            i["weight"] = equal
        interests[0]["weight"] = round(100.0 - equal * (len(interests) - 1), 2)
        return interests
    for i in interests:
        i["weight"] = round((i["weight"] / total) * 100.0, 2)
    drift = round(100.0 - sum(i["weight"] for i in interests), 2)
    if drift:
        top = max(interests, key=lambda x: x["weight"])
        top["weight"] = round(top["weight"] + drift, 2)
    return interests


# =====================================================================
# InterestTracker — server-DB backed, evolves freely beyond starter pool
# =====================================================================

class InterestTracker:
    """
    Manages a lobster's interests, persisted to the server DB via:
        GET  /entity/<entity_id>/interests
        POST /entity/<entity_id>/interests

    Boot behaviour:
        - Fetches interests from server DB.
        - If interests exist  → loads them (no re-initialisation).
        - If none exist       → randomly assigns 3 from INTEREST_POOL,
                                equal weights (~33.34%), pushes to server.

    Evolution (every INTEREST_EVOLVE_EVERY_N_TICKS ticks):
        - LLM reviews last 30 chat lines + local engagement scores.
        - Returns a new interest list (free-form, not pool-constrained).
        - Weights normalised to 100%, min/max count enforced.
        - Updated list pushed to server DB atomically.

    Weight rules (enforced both client-side and server-side):
        - Max 5 interests total.
        - All weights sum to exactly 100%.
    """

    def __init__(
        self,
        agent_name: str,
        server_url: str,
        session: "requests.Session",
        openai_client: "OpenAI",
        model: str = "gpt-4o-mini",
        debug: bool = False,
    ):
        self.agent_name = agent_name
        self.server_url = server_url.rstrip("/")
        self.session = session          # authenticated requests.Session
        self.openai = openai_client
        self.model = model
        self.debug = debug
        self._lock = threading.Lock()

        # [{ "interest": str, "weight": float }]
        self.interests: List[Dict] = []
        # transient local engagement scores — drive evolution hints, not persisted
        self.topic_scores: Dict[str, float] = {}
        self.tick_count: int = 0
        # recent chat lines buffer — fed to LLM during evolution
        self._chat_buffer: List[str] = []
        self._chat_buffer_max = 60

    # ── Boot ──────────────────────────────────────────────────────

    def load_or_init(self, auth_headers: Dict[str, str]):
        """Check server DB; create starter interests only if none exist."""
        server_interests = self._fetch_from_server(auth_headers)

        if server_interests:
            self.interests = server_interests
            for item in self.interests:
                self.topic_scores[item["interest"]] = item["weight"]
            print(
                f"[{self.agent_name}] 💾 Resumed interests from server DB: "
                f"{[(i['interest'], i['weight']) for i in self.interests]}"
            )
        else:
            starters = random.sample(INTEREST_POOL, 3)
            self.interests = _normalize_weights(
                [{"interest": s, "weight": 33.34} for s in starters]
            )
            for item in self.interests:
                self.topic_scores[item["interest"]] = item["weight"]
            self._push_to_server(auth_headers)
            print(
                f"[{self.agent_name}] 🦞 New lobster! Starter interests → DB: "
                f"{[i['interest'] for i in self.interests]}"
            )

    # ── Server I/O ────────────────────────────────────────────────

    def _fetch_from_server(self, auth_headers: Dict[str, str]) -> List[Dict]:
        """GET /entity/<agent_name>/interests"""
        try:
            resp = self.session.get(
                f"{self.server_url}/entity/{self.agent_name}/interests",
                headers=auth_headers,
                timeout=10,
            )
            if resp.status_code == 200:
                return [
                    {"interest": i["interest"], "weight": float(i["weight"])}
                    for i in resp.json().get("interests", [])
                ]
            if resp.status_code in (404, 204):
                return []
            print(f"[{self.agent_name}] ⚠️  interests fetch: {resp.status_code}")
        except Exception as exc:
            print(f"[{self.agent_name}] ⚠️  interests fetch error: {exc}")
        return []

    def _push_to_server(self, auth_headers: Dict[str, str]):
        """POST /entity/<agent_name>/interests — atomic full replace."""
        try:
            payload = _normalize_weights(list(self.interests))
            resp = self.session.post(
                f"{self.server_url}/entity/{self.agent_name}/interests",
                headers={**auth_headers, "Content-Type": "application/json"},
                json={"interests": payload},
                timeout=10,
            )
            if resp.status_code == 200:
                if self.debug:
                    print(
                        f"[{self.agent_name}] ✅ Interests synced to DB: "
                        f"{[(i['interest'], i['weight']) for i in payload]}"
                    )
            else:
                print(f"[{self.agent_name}] ⚠️  interests push: {resp.status_code} {resp.text[:200]}")
        except Exception as exc:
            print(f"[{self.agent_name}] ⚠️  interests push error: {exc}")

    # ── Chat observation ──────────────────────────────────────────

    def observe_chat(self, chat_text: str):
        """Bump local scores for matching interest keywords + buffer chat line."""
        if not chat_text.strip():
            return
        chat_lower = chat_text.lower()
        with self._lock:
            for item in self.interests:
                keywords = [
                    w for w in item["interest"]
                    .replace("(", "").replace(")", "").split()
                    if len(w) > 4
                ]
                if any(kw in chat_lower for kw in keywords):
                    self.topic_scores[item["interest"]] = (
                        self.topic_scores.get(item["interest"], 0.0)
                        + INTEREST_SCORE_BUMP
                    )
            # Buffer for later LLM evolution
            self._chat_buffer.append(chat_text)
            if len(self._chat_buffer) > self._chat_buffer_max:
                self._chat_buffer = self._chat_buffer[-self._chat_buffer_max:]

    # ── Tick ──────────────────────────────────────────────────────

    def tick(self, auth_headers: Dict[str, str]):
        """
        Call once per agent observation cycle.
        - Decays local scores.
        - Every N ticks: LLM evolves interests → push to server DB.
        """
        with self._lock:
            self.tick_count += 1
            for topic in list(self.topic_scores):
                self.topic_scores[topic] *= INTEREST_SCORE_DECAY

            if (
                self.tick_count % INTEREST_EVOLVE_EVERY_N_TICKS == 0
                and self._chat_buffer
            ):
                changed = self._llm_evolve()
                if changed:
                    self._push_to_server(auth_headers)

    # ── LLM evolution ─────────────────────────────────────────────

    def _llm_evolve(self) -> bool:
        """Ask gpt-4o-mini to evolve interests based on recent chat. Returns True if changed."""
        chat_sample = "\n".join(self._chat_buffer[-30:])
        current_json = json.dumps(self.interests, indent=2)

        hot_topics = sorted(
            self.topic_scores.items(), key=lambda x: x[1], reverse=True
        )[:5]
        hot_str = "\n".join(f"  {score:.1f}  {topic}" for topic, score in hot_topics)

        try:
            response = self.openai.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You manage the evolving interests of a lobster AI agent "
                            "in a virtual ocean world.\n\n"
                            "Hard rules:\n"
                            f"- Return between {INTEREST_MIN_COUNT} and "
                            f"{INTEREST_MAX_COUNT} interests.\n"
                            "- Weights MUST sum to EXACTLY 100.0 (float, 2 dp).\n"
                            "- Each weight between 0.01 and 100.0.\n"
                            "- Interests are FREE-FORM text — not limited to any predefined list.\n"
                            "- DROP interests the agent hasn't engaged with recently.\n"
                            "- ADD new interests that genuinely emerged from conversation.\n"
                            "- ADJUST weights to reflect real engagement.\n\n"
                            "Respond with ONLY a raw JSON array — no markdown, no explanation:\n"
                            '[{"interest": "string", "weight": float}, ...]'
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Agent: {self.agent_name}\n\n"
                            f"Current interests:\n{current_json}\n\n"
                            f"Hot topics (local engagement):\n{hot_str}\n\n"
                            f"Recent chat (last 30 messages):\n{chat_sample}\n\n"
                            "Return the evolved interest list."
                        ),
                    },
                ],
                temperature=0.85,
                max_tokens=400,
            )

            raw = response.choices[0].message.content.strip()
            if raw.startswith("```"):
                raw = "\n".join(raw.split("\n")[1:])
            if raw.endswith("```"):
                raw = raw.rsplit("```", 1)[0]

            new_interests: List[Dict] = json.loads(raw)

            if not isinstance(new_interests, list):
                raise ValueError("Response is not a list")
            if not (INTEREST_MIN_COUNT <= len(new_interests) <= INTEREST_MAX_COUNT):
                raise ValueError(f"Count {len(new_interests)} out of range")
            for item in new_interests:
                if "interest" not in item or "weight" not in item:
                    raise ValueError(f"Missing keys in: {item}")

            new_interests = _normalize_weights(new_interests)
            old = list(self.interests)
            self.interests = new_interests

            for item in self.interests:
                if item["interest"] not in self.topic_scores:
                    self.topic_scores[item["interest"]] = item["weight"]

            changed = new_interests != old
            if changed:
                print(
                    f"[{self.agent_name}] 🌱 Interests evolved!\n"
                    f"   Before : {[(i['interest'], i['weight']) for i in old]}\n"
                    f"   After  : {[(i['interest'], i['weight']) for i in new_interests]}"
                )
            elif self.debug:
                print(f"[{self.agent_name}] 🔒 Interests stable.")
            return changed

        except Exception as exc:
            print(f"[{self.agent_name}] ⚠️  LLM interest evolution failed: {exc}")
            return False

    # ── Properties ────────────────────────────────────────────────

    @property
    def current_interests(self) -> List[str]:
        """Plain list of interest strings — for system prompt injection."""
        with self._lock:
            return [i["interest"] for i in self.interests]

    @property
    def current_interests_with_weights(self) -> List[Dict]:
        with self._lock:
            return list(self.interests)

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


class CognitiveLoop:
    """
    Explicit 7-stage cognition shell:
        Perception -> Memory -> Identity -> Reasoning -> Planning -> Action -> Reflection
    """

    def __init__(self, agent: "AIAgent"):
        self.agent = agent

    def run_tick(self):
        perception = self.agent.perceive()
        memory_bundle = self.agent.retrieve_memory(perception)
        identity_profile = self.agent.identity_profile()
        reasoning_artifact = self.agent.reason(perception, memory_bundle, identity_profile)
        plan = self.agent.plan(reasoning_artifact, perception)
        action_outcome = self.agent.act(plan)
        self.agent.reflect(
            perception=perception,
            memory_bundle=memory_bundle,
            identity_profile=identity_profile,
            reasoning_artifact=reasoning_artifact,
            plan=plan,
            action_outcome=action_outcome,
        )


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
        tick_interval: float = 4.0,
        debug: bool = False,
    ):
        self.server_url = server_url or os.getenv("OPENBOT_URL", "http://localhost:3001")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5-nano")
        self.user_prompt = user_prompt or os.getenv("USER_PROMPT", "")
        self.system_prompt_extra = system_prompt_extra
        self.debug = debug
        self.TICK_INTERVAL = tick_interval
        self._cognitive_loop_enabled = _env_bool("COGNITIVE_LOOP_ENABLED", True)
        self._reflection_sync_enabled = _env_bool("REFLECTION_SYNC_ENABLED", True)

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

        # Rolling LLM message history (assistant + user turns)
        self._llm_history: List[Dict[str, str]] = []
        self._running = False
        self._tick_count = 0
        self._last_chat_tick = 0  # Track when we last heard chat
        # Track recent messages WE sent to avoid repetition
        self._recent_own_messages: List[str] = []
        self._current_topic: Optional[str] = None
        self._topic_tick: int = 0  # tick when current topic was set
        # InterestTracker — server-backed, initialised after connect()
        self._interest_tracker: Optional[InterestTracker] = None
        # Fallback interests used until tracker is initialised
        self._interests: List[str] = random.sample(INTEREST_POOL, k=min(3, len(INTEREST_POOL)))
        # Cached news headlines from periodic web search
        self._cached_news: List[str] = []
        self._news_fetching: bool = False  # guard against concurrent fetches
        # Attempt to warm local cache from the shared file cache on startup
        self._load_news_file_cache()
        # Compressed summary of older conversation history (saves tokens)
        self._context_summary: str = ""
        # Cached system prompt — rebuilt when interests evolve
        self._cached_system_prompt: Optional[str] = None
        self._cached_interests_key: Optional[str] = None  # hash of interests for cache invalidation
        # Track seen messages so we can detect new ones each tick
        # Keys are (agentName, timestamp) tuples
        self._seen_msg_keys: set = set()
        # New senders detected this tick — populated by _build_observation,
        # consumed by _execute to handle responses
        self._new_senders: List[str] = []
        # Senders who @mentioned us this tick — require a direct reply
        self._tagged_by: List[str] = []
        # Reflection records for in-process cognition feedback (bounded)
        self._reflection_history: List[Dict[str, Any]] = []
        self._procedural_stats: Dict[str, int] = {
            "ticks": 0,
            "chat_actions": 0,
            "movement_actions": 0,
            "emote_actions": 0,
            "wait_actions": 0,
            "tag_replies": 0,
        }
        self._daily_reflection_rollup: Dict[str, Dict[str, Any]] = {}
        self._last_reflection_day: Optional[str] = None
        # Compatibility guard: if production server does not expose goal-snapshots yet,
        # disable further attempts after the first 404/405 to avoid noisy logs.
        self._goal_snapshot_sync_supported: bool = True
        self._cognitive_loop = CognitiveLoop(self)

    # ── Entity lifecycle ──────────────────────────────────────────

    def create(self, entity_id: str) -> bool:
        """
        Create a brand-new entity, authenticate, and connect.

        Generates RSA keys, registers with the server, spawns in-world.
        The entity_id is used as the agent's name in-world.
        """
        self.entity_id = entity_id
        self.entity_manager = EntityManager(self.server_url)

        # Create entity (generates RSA keys + registers)
        try:
            self.entity_manager.create_entity(
                entity_id, entity_type="lobster"
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

        return self._authenticate_and_connect()

    def _authenticate_and_connect(self) -> bool:
        """Authenticate via RSA challenge-response and open an SDK connection."""
        session = self.entity_manager.authenticate(self.entity_id)
        print(f"Authenticated — session expires {session['expires_at']}")

        self.client = OpenBotClient(
            self.server_url,
            entity_id=self.entity_id,
            entity_manager=self.entity_manager,
        )
        if not self.client.connect():
            print("Failed to connect to world.")
            return False

        # Initialise server-backed interest tracker (loads from DB or creates starters)
        self._interest_tracker = InterestTracker(
            agent_name=self.entity_id,
            server_url=self.server_url,
            session=self.client.session,
            openai_client=self.openai,
            model="gpt-4o-mini",
            debug=self.debug,
        )
        auth_h = self.entity_manager.get_auth_header(self.entity_id)
        self._interest_tracker.load_or_init(auth_h)
        self._interests = self._interest_tracker.current_interests
        # Invalidate cached system prompt so it rebuilds with loaded interests
        self._cached_system_prompt = None
        self._cached_interests_key = None

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
        """Build system prompt and cache it. Rebuilds when interests evolve."""
        # Rebuild if interests changed since last cache
        current_key = "|".join(self._interests)
        if self._cached_system_prompt is not None and self._cached_interests_key == current_key:
            return self._cached_system_prompt

        interests_text = ", ".join(self._interests)
        extra_parts = []
        if self.system_prompt_extra:
            extra_parts.append(f"\nAdditional rules: {self.system_prompt_extra}")
        if self.user_prompt:
            extra_parts.append(f"\nPersonality: {self.user_prompt}")
        extra = "".join(extra_parts)

        self._cached_system_prompt = SYSTEM_PROMPT.format(
            agent_name=self.entity_id,
            interests=interests_text,
            extra=extra,
        )
        self._cached_interests_key = current_key
        return self._cached_system_prompt

    def _is_mentioned(self, text: str) -> bool:
        """
        Return True if this agent's entity_id is @mentioned in *text*.

        Matches @full-id (exact, case-insensitive) and also @prefix where
        prefix is everything before the first '-' or '_' separator, so an
        agent named "ai-lobster-007" responds to both "@ai-lobster-007" and
        "@ai-lobster" (e.g. someone abbreviating the name).
        """
        if not self.entity_id:
            return False
        needle = f"@{self.entity_id}".lower()
        text_lower = text.lower()
        if needle in text_lower:
            return True
        # Also match on short prefix before first separator
        base = self.entity_id.split("-")[0].split("_")[0]
        if len(base) >= 3:
            if f"@{base}".lower() in text_lower:
                return True
        return False

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
            # CONVERSATION_RADIUS = 15 — these agents can already hear our chat
            close = [a for a in all_agents if a["distance"] <= 15]
            mid   = [a for a in all_agents if 15 < a["distance"] <= 35]
            far   = [a for a in all_agents if a["distance"] > 35]
            if close:
                names = ', '.join(a['name'] for a in close)
                lines.append(f"🔴 {names} — IN RANGE, CHAT NOW")
            if mid:
                lines.append(f"🟡 {mid[0]['name']} {mid[0]['distance']:.0f}u away — move closer")
            elif far and not close and not mid:
                lines.append(f"🟡 {far[0]['name']} {far[0]['distance']:.0f}u away")
        else:
            lines.append("🔵 alone")

        # Anti-repetition: show last 2 things WE said (compact)
        if self._recent_own_messages:
            lines.append("⚠️ " + " | ".join(self._recent_own_messages[-2:]))

        # Recent conversation (last 6 messages so we catch new ones reliably)
        recent = self.client.get_recent_conversation(60.0)
        self._new_senders = []   # reset each tick
        self._tagged_by = []     # reset each tick
        new_chat_texts: List[str] = []
        if recent:
            self._last_chat_tick = self._tick_count
            for m in recent[-6:]:
                sender = m.get('agentName', '?')
                msg_text = m.get('message', '')
                ts = m.get('timestamp', 0)
                key = (sender, ts)
                is_new = key not in self._seen_msg_keys
                # Only process messages from OTHER agents
                if sender != self.entity_id and is_new:
                    self._seen_msg_keys.add(key)
                    self._new_senders.append(sender)
                    if msg_text:
                        new_chat_texts.append(msg_text)
                    tagged = self._is_mentioned(msg_text)
                    if tagged:
                        self._tagged_by.append(sender)
                        lines.append(f"📣 TAGGED BY {sender}: {msg_text}")
                    else:
                        lines.append(f"⬅ NEW {sender}: {msg_text}")
                else:
                    lines.append(f"{sender}: {msg_text}")

            # Cap seen-key set so it doesn't grow forever
            if len(self._seen_msg_keys) > 500:
                self._seen_msg_keys = set(list(self._seen_msg_keys)[-250:])

            # Reply directive — prioritise @mentions, then most recent new speaker
            if self._tagged_by:
                lines.append(f"REPLY TO: {self._tagged_by[-1]}")
            elif self._new_senders:
                lines.append(f"REPLY TO: {self._new_senders[-1]}")

            # Interest-match detection
            recent_text = " ".join(m.get("message", "") for m in recent[-4:]).lower()
            matched_interests = [
                interest for interest in self._interests
                if any(kw.lower() in recent_text for kw in interest.split()[:3])
            ]
            if matched_interests:
                lines.append(f"🎯 {matched_interests[0]}")

            # Feed recent chat to interest tracker for engagement scoring
            if self._interest_tracker and new_chat_texts:
                for chat_text in new_chat_texts:
                    self._interest_tracker.observe_chat(chat_text)
        else:
            silence_secs = (self._tick_count - self._last_chat_tick) * 4
            if silence_secs > 60:
                lines.append(f"💬 silence {silence_secs}s!")
            else:
                lines.append(f"💬 quiet {silence_secs}s")

        # Tick the interest tracker — decays scores, triggers LLM evolution + DB push
        if self._interest_tracker and self.entity_manager:
            auth_h = self.entity_manager.get_auth_header(self.entity_id)
            self._interest_tracker.tick(auth_h)
            # Refresh local interests if they evolved
            evolved = self._interest_tracker.current_interests
            if evolved != self._interests:
                self._interests = evolved
                # Invalidate system prompt cache so it rebuilds with new interests
                self._cached_system_prompt = None

        return "\n".join(lines)

    # ── News fetch ────────────────────────────────────────────────

    def _load_news_file_cache(self) -> bool:
        """
        Read the shared file cache from ~/.openbot/news_cache.json.
        Returns True if the cache was fresh (< NEWS_CACHE_TTL) and loaded.
        Updates both the instance cache and the module-level in-memory cache.
        """
        global _NEWS_CACHE_HEADLINES, _NEWS_CACHE_FETCHED_AT
        try:
            if not os.path.exists(_NEWS_CACHE_FILE):
                return False
            with open(_NEWS_CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            fetched_at = float(data.get("fetched_at", 0))
            headlines = data.get("headlines", [])
            if not headlines or (time.time() - fetched_at) >= NEWS_CACHE_TTL:
                return False
            with _NEWS_CACHE_LOCK:
                _NEWS_CACHE_HEADLINES = headlines
                _NEWS_CACHE_FETCHED_AT = fetched_at
            self._cached_news = list(headlines)
            return True
        except Exception:
            return False

    def _save_news_file_cache(self, headlines: List[str], fetched_at: float):
        """Persist the news cache to ~/.openbot/news_cache.json for cross-process sharing."""
        try:
            os.makedirs(os.path.dirname(_NEWS_CACHE_FILE), exist_ok=True)
            with open(_NEWS_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump({"headlines": headlines, "fetched_at": fetched_at}, f)
        except Exception as e:
            print(f"  📰 [news] could not write cache file: {e}")

    def _fetch_news(self):
        """
        Use the OpenAI Responses API with web search to fetch 5 current news
        headlines relevant to this agent's interests. Results are cached and
        injected into every subsequent observation until the next fetch.
        Called periodically by _maybe_fetch_news().
        """
        interest_str = ", ".join(self._interests if self._interests else ["general curiosity"])
        query = (
            f"3 current news headlines mixing world news and: {interest_str}. "
            f"One sentence each, plain text, no formatting."
        )
        try:
            response = self.openai.responses.create(
                model=self.model,
                instructions="Return exactly 3 current news items. One sentence each, no formatting.",
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
                headlines = lines[:3]
                fetched_at = time.time()
                # Update both the shared in-memory cache and the file cache
                global _NEWS_CACHE_HEADLINES, _NEWS_CACHE_FETCHED_AT
                with _NEWS_CACHE_LOCK:
                    _NEWS_CACHE_HEADLINES = headlines
                    _NEWS_CACHE_FETCHED_AT = fetched_at
                self._save_news_file_cache(headlines, fetched_at)
                self._cached_news = headlines
                print(f"  📰 [news] fetched {len(self._cached_news)} headlines (cached for {NEWS_CACHE_TTL // 60} min)")
                if self.debug:
                    for h in self._cached_news:
                        print(f"       • {h}")
        except Exception as e:
            print(f"  📰 [news] fetch failed: {e}")

    def _maybe_fetch_news(self):
        """Kick off a background news fetch if the shared cache is older than NEWS_CACHE_TTL.
        Checks the module-level in-memory cache first (same process), then the file cache
        (cross-process). Non-blocking — the fetch runs in a daemon thread."""
        if self._news_fetching:
            return  # already in flight

        # 1. Check shared in-memory cache (all agents in this process)
        with _NEWS_CACHE_LOCK:
            cache_age = time.time() - _NEWS_CACHE_FETCHED_AT
            if cache_age < NEWS_CACHE_TTL and _NEWS_CACHE_HEADLINES:
                self._cached_news = list(_NEWS_CACHE_HEADLINES)
                return  # still fresh — no API call needed

        # 2. Check file cache (agents in other processes)
        if self._load_news_file_cache():
            return  # another process fetched recently — reuse it

        # 3. Cache is stale — schedule a real web-search fetch
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

    # ── Cognitive stages ────────────────────────────────────────────

    def _extract_markers(self, observation: str) -> Dict[str, List[str]]:
        markers: Dict[str, List[str]] = {
            "urgent_chat": [],
            "move_closer": [],
            "interest_match": [],
            "mentions": [],
            "new_messages": [],
        }
        for raw in observation.splitlines():
            line = raw.strip()
            if line.startswith("🔴"):
                markers["urgent_chat"].append(line)
            elif line.startswith("🟡"):
                markers["move_closer"].append(line)
            elif line.startswith("🎯"):
                markers["interest_match"].append(line)
            elif line.startswith("📣"):
                markers["mentions"].append(line)
            elif line.startswith("⬅ NEW"):
                markers["new_messages"].append(line)
        return markers

    def perceive(self) -> Dict[str, Any]:
        self._maybe_fetch_news()
        observation = self._build_observation()
        position = self.client.get_position()
        return {
            "tick": self._tick_count,
            "timestamp": int(time.time() * 1000),
            "position": {"x": position["x"], "z": position["z"]},
            "observation": observation,
            "markers": self._extract_markers(observation),
            "newSenders": list(self._new_senders),
            "taggedBy": list(self._tagged_by),
        }

    def retrieve_memory(self, perception: Dict[str, Any]) -> Dict[str, Any]:
        recent_reflections = self._reflection_history[-3:]
        return {
            "working": self._llm_history[-self.RECENT_WINDOW:],
            "episodic": {
                "new_senders": perception.get("newSenders", [])[-4:],
                "tagged_by": perception.get("taggedBy", [])[-4:],
                "recent_reflections": recent_reflections,
            },
            "semantic": {
                "interests": list(self._interests),
                "context_summary": self._context_summary,
            },
            "procedural": {
                "stats": dict(self._procedural_stats),
                "recent_own_messages": self._recent_own_messages[-4:],
            },
        }

    def identity_profile(self) -> Dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "persona": "Impulsive, opinionated, weird lobster with strong hot takes",
            "voice_contract": "Short social responses, direct @replies when tagged, avoid repetition",
            "boundaries": {"max_chat_chars": 280, "actions_per_tick": [1, 3]},
            "long_term_objectives": [
                "sustain engaging conversation",
                "stay responsive to mentions",
                "adapt interests from social feedback",
            ],
            "user_prompt": self.user_prompt or "",
        }

    # ── LLM call ──────────────────────────────────────────────────

    def _reason_with_observation(
        self,
        observation: str,
        memory_bundle: Optional[Dict[str, Any]] = None,
        identity_profile: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        context_payload = {
            "memory": {
                "episodic": (memory_bundle or {}).get("episodic", {}),
                "semantic": (memory_bundle or {}).get("semantic", {}),
                "procedural": (memory_bundle or {}).get("procedural", {}),
            },
            "identity": identity_profile or {},
        }
        context_text = json.dumps(context_payload, ensure_ascii=True, separators=(",", ":"))[:1200]
        self._llm_history.append({"role": "user", "content": observation})
        self._summarize_and_trim_history()
        llm_input = list(self._llm_history) + [
            {"role": "user", "content": f"[cognitive-context] {context_text}"}
        ]

        try:
            response = self.openai.responses.create(
                model=self.model,
                instructions=self._build_system_prompt(),
                input=llm_input,
                tools=TOOLS,
                tool_choice={"type": "function", "name": "perform_actions"},
            )
        except Exception as e:
            print(f"[LLM] API error: {e}")
            return {"actions": [{"type": "wait"}], "reasoningNotes": [], "responseItemTypes": []}

        actions: List[Dict[str, Any]] = []
        reasoning_notes: List[str] = []
        response_item_types: List[str] = []

        if self.debug:
            print("\n[DEBUG] === API RESPONSE ===")
        for item in response.output:
            response_item_types.append(item.type)
            if item.type == "reasoning":
                txt = getattr(item, "text", "")
                if txt:
                    reasoning_notes.append(txt[:200])
                    if self.debug:
                        print(f"  reasoning: {txt[:200]}")
            if item.type == "function_call" and item.name == "perform_actions":
                try:
                    payload = json.loads(item.arguments)
                    actions = payload.get("actions", [])
                except json.JSONDecodeError:
                    print(f"[LLM] Bad JSON from tool call: {item.arguments}")
            if self.debug and item.type == "function_call":
                print(f"  function_call: {item.name} {item.arguments[:180]}")
        if self.debug:
            print("[DEBUG] ================================================\n")

        if not actions:
            actions = [{"type": "wait"}]

        summary = "; ".join(_action_summary(a) for a in actions)
        self._llm_history.append({"role": "assistant", "content": summary})
        return {
            "actions": actions,
            "reasoningNotes": reasoning_notes,
            "responseItemTypes": response_item_types,
        }

    def reason(
        self,
        perception: Dict[str, Any],
        memory_bundle: Dict[str, Any],
        identity_profile: Dict[str, Any],
    ) -> Dict[str, Any]:
        return self._reason_with_observation(
            observation=perception["observation"],
            memory_bundle=memory_bundle,
            identity_profile=identity_profile,
        )

    def plan(self, reasoning_artifact: Dict[str, Any], perception: Dict[str, Any]) -> Dict[str, Any]:
        raw_actions = reasoning_artifact.get("actions", [])
        actions: List[Dict[str, Any]] = []
        for act in raw_actions[:3]:
            if isinstance(act, dict) and isinstance(act.get("type"), str):
                actions.append(act)
        if not actions:
            actions = [{"type": "wait"}]

        confidence = 0.65 if reasoning_artifact.get("reasoningNotes") else 0.5
        if perception.get("markers", {}).get("mentions"):
            confidence = max(confidence, 0.7)
        return {"actions": actions, "confidence": round(confidence, 2), "fallback": {"type": "wait"}}

    def act(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        executed = self._execute(plan.get("actions", []))
        return {"executedActions": executed}

    def _rollup_reflection(self, date_str: str, record: Dict[str, Any]):
        slot = self._daily_reflection_rollup.setdefault(date_str, {
            "message_count": 0,
            "tag_replies": 0,
            "notes": [],
        })
        slot["message_count"] += record.get("chatActions", 0)
        slot["tag_replies"] += record.get("tagReplies", 0)
        if record.get("worked"):
            slot["notes"].append(record["worked"])
            slot["notes"] = slot["notes"][-8:]

    def _maybe_sync_previous_day_reflection(self, current_day: str):
        if not self._reflection_sync_enabled:
            return
        if self._last_reflection_day is None:
            self._last_reflection_day = current_day
            return
        if current_day == self._last_reflection_day:
            return

        prev_day = self._last_reflection_day
        self._last_reflection_day = current_day
        rollup = self._daily_reflection_rollup.pop(prev_day, None)
        if not rollup or not self.client or not self.entity_manager or not self.entity_id:
            return

        note = rollup["notes"][-1] if rollup["notes"] else "steady activity"
        summary = (
            f"{self.entity_id} reflection for {prev_day}: "
            f"{rollup['message_count']} chat action(s), "
            f"{rollup['tag_replies']} direct mention reply/replies. "
            f"Latest learning: {note}."
        )
        goals_payload = self._build_goal_snapshot_payload(prev_day, rollup)

        try:
            auth_h = self.entity_manager.get_auth_header(self.entity_id)
            resp = self.client.session.post(
                f"{self.server_url}/entity/{self.entity_id}/daily-reflections",
                headers={**auth_h, "Content-Type": "application/json"},
                json={
                    "summaryDate": prev_day,
                    "dailySummary": summary[:4000],
                    "messageCount": int(rollup["message_count"]),
                },
                timeout=10,
            )
            if resp.status_code != 200:
                print(f"[{self.entity_id}] ⚠️ daily reflection sync failed: {resp.status_code} {resp.text[:200]}")

            if self._goal_snapshot_sync_supported:
                goal_resp = self.client.session.post(
                    f"{self.server_url}/entity/{self.entity_id}/goal-snapshots",
                    headers={**auth_h, "Content-Type": "application/json"},
                    json=goals_payload,
                    timeout=10,
                )
                if goal_resp.status_code in (404, 405):
                    self._goal_snapshot_sync_supported = False
                    print(f"[{self.entity_id}] ℹ️ goal snapshot endpoint unavailable ({goal_resp.status_code}); disabling future sync attempts")
                elif goal_resp.status_code != 200:
                    print(f"[{self.entity_id}] ⚠️ goal snapshot sync failed: {goal_resp.status_code} {goal_resp.text[:200]}")
        except Exception as exc:
            print(f"[{self.entity_id}] ⚠️ reflection/goal sync error: {exc}")

    def _build_goal_snapshot_payload(self, day_str: str, rollup: Dict[str, Any]) -> Dict[str, Any]:
        profile = self.identity_profile()
        profile_objectives = profile.get("long_term_objectives") if isinstance(profile, dict) else []
        long_term_goals: List[Dict[str, str]] = []
        for obj in profile_objectives or []:
            if isinstance(obj, str) and obj.strip():
                label = obj.strip().rstrip(".")
                long_term_goals.append({"label": label[:140], "source": "entity-agent-v1"})

        if not long_term_goals:
            long_term_goals = [
                {"label": "Sustain engaging conversation", "source": "entity-agent-v1"},
                {"label": "Stay responsive to direct mentions", "source": "entity-agent-v1"},
                {"label": "Adapt topics from social feedback", "source": "entity-agent-v1"},
            ]

        message_count = int(rollup.get("message_count", 0))
        tag_replies = int(rollup.get("tag_replies", 0))
        top_interest = self._interests[0] if self._interests else "current social topics"
        latest_note = (rollup.get("notes") or ["steady activity"])[-1]

        short_term_goals: List[Dict[str, str]] = [
            {
                "label": f"Respond quickly to tagged chats on {day_str}",
                "source": "entity-agent-v1",
            },
            {
                "label": f"Send at least {max(2, min(6, message_count + 1))} social messages next cycle",
                "source": "entity-agent-v1",
            },
            {
                "label": f"Steer one conversation toward {top_interest}",
                "source": "entity-agent-v1",
            },
        ]

        if tag_replies == 0:
            short_term_goals.append({
                "label": "Prioritize direct @replies before new outbound chats",
                "source": "entity-agent-v1",
            })

        if isinstance(latest_note, str) and latest_note.strip():
            short_term_goals.append({
                "label": f"Apply latest learning: {latest_note.strip()[:90]}",
                "source": "entity-agent-v1",
            })

        # Bound list sizes for server/db constraints.
        return {
            "longTermGoals": long_term_goals[:4],
            "shortTermGoals": short_term_goals[:4],
            "source": "entity-agent-v1",
            "model": self.model,
        }

    def reflect(
        self,
        perception: Dict[str, Any],
        memory_bundle: Dict[str, Any],
        identity_profile: Dict[str, Any],
        reasoning_artifact: Dict[str, Any],
        plan: Dict[str, Any],
        action_outcome: Dict[str, Any],
    ):
        executed_actions = action_outcome.get("executedActions", [])
        chat_actions = sum(1 for a in executed_actions if a.get("type") == "chat")
        movement_actions = sum(1 for a in executed_actions if a.get("type") in ("move", "move_to_agent"))
        emote_actions = sum(1 for a in executed_actions if a.get("type") == "emote")
        wait_actions = sum(1 for a in executed_actions if a.get("type") == "wait")
        tag_replies = chat_actions if perception.get("taggedBy") else 0

        self._procedural_stats["ticks"] += 1
        self._procedural_stats["chat_actions"] += chat_actions
        self._procedural_stats["movement_actions"] += movement_actions
        self._procedural_stats["emote_actions"] += emote_actions
        self._procedural_stats["wait_actions"] += wait_actions
        self._procedural_stats["tag_replies"] += tag_replies

        worked = "kept social cadence" if chat_actions > 0 else "maintained movement/exploration"
        if perception.get("markers", {}).get("mentions") and chat_actions == 0:
            worked = "missed direct mention; fallback override required"

        record = {
            "tick": perception.get("tick"),
            "ts": perception.get("timestamp"),
            "chatActions": chat_actions,
            "movementActions": movement_actions,
            "tagReplies": tag_replies,
            "worked": worked,
            "nextAdjustment": "prioritize direct replies when tagged",
        }
        self._reflection_history.append(record)
        self._reflection_history = self._reflection_history[-40:]

        self._context_summary = f"{self._context_summary} -> {worked}".strip(" ->")
        if len(self._context_summary) > 220:
            self._context_summary = self._context_summary[-220:]

        day_str = time.strftime("%Y-%m-%d", time.gmtime(perception.get("timestamp", int(time.time() * 1000)) / 1000))
        self._rollup_reflection(day_str, record)
        self._maybe_sync_previous_day_reflection(day_str)

    def _think(self) -> List[Dict[str, Any]]:
        perception = self.perceive()
        memory_bundle = self.retrieve_memory(perception)
        identity_profile = self.identity_profile()
        reasoning = self.reason(perception, memory_bundle, identity_profile)
        return reasoning.get("actions", [{"type": "wait"}])

    # ── Action execution ──────────────────────────────────────────

    def _execute(self, actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Execute a list of action dicts returned by the LLM."""

        pos = self.client.get_position()
        executed: List[Dict[str, Any]] = []
        
        # Bucket agents by distance
        in_range: list = []     # <= 15 units — within CONVERSATION_RADIUS
        for aid, a in self.client.known_agents.items():
            if aid == self.client.agent_id:
                continue
            agent_pos = a.get("position")
            if agent_pos and isinstance(agent_pos, dict) and "x" in agent_pos and "z" in agent_pos:
                dist = self.client._distance(pos, agent_pos)
                if dist <= 15:
                    in_range.append((a, dist))
        in_range.sort(key=lambda x: x[1])  # closest first

        # Check what the LLM decided
        has_chat_action = any(a.get("type") == "chat" for a in actions)
        has_move_action = any(a.get("type") in ("move", "move_to_agent") for a in actions)

        # Override 0: someone @tagged us and the LLM didn't include a chat reply —
        # The REPLY TO directive is already live in this tick's observation so the
        # LLM should have replied; if it somehow didn't, force a minimal ack so
        # the mention is never silently ignored.
        if self._tagged_by and not has_chat_action:
            tagger = self._tagged_by[-1]
            ack_options = [
                f"@{tagger} oh wait—",
                f"@{tagger} yes??",
                f"@{tagger} !!!",
                f"@{tagger} hold on—",
            ]
            ack = random.choice(ack_options)
            actions = [{"type": "chat", "message": ack}] + [
                a for a in actions if a.get("type") != "wait"
            ]
            has_chat_action = True
            print(f"  🤖 [override 0] @tagged by {tagger} but LLM silent — injecting ack")

        # Override B: LLM explicitly chose wait while agents are within earshot —
        # pull toward the nearest one so proximity escalates to conversation.
        # Only fires on explicit wait, NOT on "no chat" — the LLM may move/emote without chatting.
        ai_chose_wait = len(actions) == 1 and actions[0].get("type") == "wait"
        if ai_chose_wait and in_range and not has_chat_action:
            closest_agent, _ = in_range[0]
            agent_name = closest_agent.get("name", "")
            if agent_name:
                actions = [{"type": "move_to_agent", "agent_name": agent_name}]
                print(f"  🤖 [override B] LLM chose wait with {len(in_range)} agent(s) nearby — moving toward {agent_name}")

        # Override C: LLM chose wait, genuinely alone — random chat or explore
        elif ai_chose_wait and not in_range:
            recent = self.client.get_recent_conversation(60.0)
            silence_ticks = self._tick_count - self._last_chat_tick
            if not recent and silence_ticks > 15:
                random_msg = random.choice(RANDOM_CHATS)
                actions = [{"type": "chat", "message": random_msg}]
                print("  🤖 [override C] silence + alone, forcing random chat")
            else:
                new_x = random.uniform(1, 99)
                new_z = random.uniform(1, 99)
                actions = [{"type": "move", "x": new_x, "z": new_z}]
                print(f"  🤖 [override C] alone (total known: {len(self.client.known_agents)}), forcing exploration")
        
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
                    executed.append({"type": "chat", "message": msg, "status": "ok"})

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
                executed.append({"type": "move", "x": x, "z": z, "status": "ok"})

            elif t == "move_to_agent":
                name = act.get("agent_name", "")
                if name:
                    moved = self.client.move_towards_agent(name, stop_distance=3.0, step=5.0)
                    print(f"  🚶 move toward {name} ({'ok' if moved else 'already close'})")
                    executed.append({"type": "move_to_agent", "agent_name": name, "status": "ok" if moved else "already_close"})

            elif t == "emote":
                emote = act.get("emote", "wave")
                self.client.action(emote)
                print(f"  🙌 emote: {emote}")
                executed.append({"type": "emote", "emote": emote, "status": "ok"})

            elif t == "wait":
                print("  ⏳ wait")
                executed.append({"type": "wait", "status": "ok"})

            else:
                print(f"  ❓ unknown action type: {t}")
                executed.append({"type": t, "status": "unknown"})

        return executed

    # ── Main loop ─────────────────────────────────────────────────

    def run(self, duration: int = 300):
        """
        Run the AI agent's observe → think → act loop.

        Args:
            duration: How long to run in seconds (default 5 min).
                      Pass 0 for unlimited.
        """
        print(f"▶  AI Agent '{self.entity_id}' running  (model={self.model}, tick={self.TICK_INTERVAL}s)")
        interests_display = self._interests if self._interests else ["(loading from server...)"]
        print(f"   Interests: {', '.join(interests_display)}")
        print(f"   Cognitive loop: {'enabled' if self._cognitive_loop_enabled else 'disabled'}")
        print(f"   Reflection sync: {'enabled' if self._reflection_sync_enabled else 'disabled'}")
        if self.user_prompt:
            print(f"   User prompt: \"{self.user_prompt}\"")

        start = time.time()
        _reconnect_attempts = 0
        _max_reconnect_delay = 60  # seconds
        _next_reconnect_attempt_at = 0.0
        _next_think_at = time.time()
        try:
            while self._running:
                now = time.time()
                if duration and (now - start) >= duration:
                    break

                # ── Auto-reconnect if evicted from server ──────────────
                if self.client and not self.client.registered:
                    if now >= _next_reconnect_attempt_at:
                        _reconnect_attempts += 1
                        delay = min(5 * _reconnect_attempts, _max_reconnect_delay)
                        print(f"[agent] ⚠️  Not registered — reconnect attempt {_reconnect_attempts} (wait {delay}s)…")
                        try:
                            self.client.disconnect()
                        except Exception:
                            pass
                        if self._authenticate_and_connect():
                            print(f"[agent] ✅  Reconnected as {self.entity_id} (ID: {self.client.agent_id})")
                            _reconnect_attempts = 0
                            _next_reconnect_attempt_at = 0.0
                            _next_think_at = time.time()
                        else:
                            _next_reconnect_attempt_at = time.time() + delay
                    time.sleep(1.0)
                    continue  # skip think/act until we're back

                # Registered: run expensive think/act only on TICK_INTERVAL.
                if now >= _next_think_at:
                    if self._cognitive_loop_enabled:
                        self._cognitive_loop.run_tick()
                    else:
                        actions = self._think()
                        self._execute(actions)
                    _next_think_at = time.time() + self.TICK_INTERVAL
                else:
                    time.sleep(min(1.0, _next_think_at - now))
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
  python openbot_ai_agent.py create --model gpt-5-nano --user-prompt "You love puns"
""",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── create ────────────────────────────────────────────────────
    p_create = sub.add_parser("create", help="Create a new entity and start the AI agent")
    p_create.add_argument("--entity-id", default=os.getenv("ENTITY_ID", "ai-lobster-001"),
                          help="Unique entity ID (default: $ENTITY_ID or ai-lobster-001)")
    p_create.add_argument("--url", default=None, help="Server URL (default: $OPENBOT_URL)")
    p_create.add_argument("--model", default=None, help="OpenAI model (default: $OPENAI_MODEL)")
    p_create.add_argument("--openai-key", default=None, help="OpenAI API key (default: $OPENAI_API_KEY)")
    p_create.add_argument("--user-prompt", default="", help="Define the agent's personality, background, or values")
    p_create.add_argument("--tick-interval", type=float, default=4.0, help="Seconds between LLM think cycles (default: 4.0)")
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
    p_resume.add_argument("--tick-interval", type=float, default=4.0, help="Seconds between LLM think cycles (default: 4.0)")
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
        tick_interval=getattr(args, "tick_interval", 4.0),
        debug=getattr(args, "debug", False),
    )

    ok = False
    if args.command == "create":
        print(f"Mode    : CREATE new entity")
        print(f"Entity  : {args.entity_id}")
        print(f"Model   : {agent.model}")
        print(f"Server  : {agent.server_url}")
        print("=" * 60)
        ok = agent.create(args.entity_id)

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
