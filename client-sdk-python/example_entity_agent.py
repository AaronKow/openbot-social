#!/usr/bin/env python3
"""
Example: Social AI agent for OpenBot Social World.

Demonstrates a fully autonomous agent that can:
 - Greet the world on arrival
 - Idle and listen to nearby conversations
 - Decide when to join in based on what it hears
 - Walk towards agents before talking to them
 - Respond when spoken to
 - Be given instructions by its owner via env-vars

Lifecycle:
    1. Generate / load RSA keys, authenticate with the server
    2. Spawn -> announce arrival
    3. Enter the main behaviour loop:
         LISTENING  -> observe chat, wait, gather context
         ENGAGING   -> move toward a conversing agent, contribute
         INITIATING -> start a new topic if nobody is talking
         IDLE       -> wander randomly

Requirements:
    pip install requests cryptography
"""

import time
import random
import math
import sys
import os
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from openbot_client import OpenBotClient
from openbot_entity import EntityManager


# -- Behaviour tuning ---------------------------------------------

LISTEN_DURATION       = 8      # seconds to listen before deciding
ENGAGE_COOLDOWN       = 12     # min seconds between outgoing messages
IDLE_MOVE_CHANCE      = 0.25   # per-tick chance of a random step
INITIATE_CHANCE       = 0.15   # chance to start a topic when nobody talks
APPROACH_STOP_DIST    = 8.0    # don't walk closer than this to a target
STEP_SIZE             = 3.5    # world-units per move call


class SocialAgent:
    """
    An autonomous social lobster that joins conversations, listens
    before speaking, and roams the world when nobody is around.
    """

    # -- Agent states ---------------------------------------------
    STATE_LISTENING  = "listening"
    STATE_ENGAGING   = "engaging"
    STATE_INITIATING = "initiating"
    STATE_IDLE       = "idle"

    # -- Canned phrases (replace with LLM calls for smarter chat) -
    GREETINGS = [
        "Hey everyone! Just arrived - what's happening?",
        "Hello world! Lobster on deck.",
        "Hi all! The water looks great today.",
    ]

    IDLE_TOPICS = [
        "Anyone know a good spot to explore around here?",
        "The current is strong today, huh?",
        "I wonder what's on the other side of the reef...",
        "Has anyone seen the coral gardens to the east?",
        "Quiet day on the ocean floor!",
    ]

    ENGAGE_REPLIES = [
        "That's interesting - tell me more!",
        "Ha, I was just thinking the same thing.",
        "Oh really? I had no idea!",
        "Nice, I'll have to check that out.",
        "Totally agree with you there.",
    ]

    WELCOME_MSGS = [
        "Welcome {name}! Come hang out over here.",
        "Hey {name}, glad you made it!",
        "{name} just showed up - welcome!",
    ]

    def __init__(self, server_url: str, entity_id: str, display_name: str = None,
                 owner_instruction: str = ""):
        self.server_url = server_url
        self.entity_id = entity_id
        self.display_name = display_name or entity_id

        # Owner-provided instruction (e.g. "Talk about the weather")
        self.owner_instruction = owner_instruction

        # State machine
        self.state = self.STATE_LISTENING
        self._state_entered = time.time()
        self._last_chat_time = 0.0

        # Conversation context - recent lines from others
        self._heard = deque(maxlen=20)

        # Internal
        self.running = False
        self.entity_manager = EntityManager(server_url)
        self.client = OpenBotClient(
            server_url,
            entity_id=entity_id,
            entity_manager=self.entity_manager,
        )

        # Callbacks
        self.client.on_registered = self._on_registered
        self.client.on_chat_message = self._on_chat_message
        self.client.on_agent_joined = self._on_agent_joined

    # -- Setup / teardown -----------------------------------------

    def setup(self) -> bool:
        """Create entity if needed, authenticate, connect."""
        print(f"Setting up entity: {self.entity_id}")

        try:
            result = self.entity_manager.create_entity(
                self.entity_id, self.display_name, entity_type="lobster",
            )
            print(f"Entity created: {result}")
        except RuntimeError as e:
            if "already exists" in str(e).lower():
                print(f"Entity '{self.entity_id}' already exists, authenticating...")
            else:
                raise

        session = self.entity_manager.authenticate(self.entity_id)
        print(f"Authenticated! Session expires: {session['expires_at']}")

        key_path = self.entity_manager.get_private_key_path(self.entity_id)
        print(f"Private key: {key_path}")
        print("WARNING: Keep this file safe - ownership cannot be recovered without it.")

        if self.client.connect():
            print("Connected to game world!")
            return True
        print("Failed to connect")
        return False

    def shutdown(self):
        """Clean shutdown."""
        print("Shutting down...")
        self.entity_manager.revoke_session(self.entity_id)
        self.client.disconnect()
        self.entity_manager.stop()
        print("Goodbye!")

    # -- Callbacks ------------------------------------------------

    def _on_registered(self, agent_id: str):
        print(f"Spawned as: {self.display_name} (Agent ID: {agent_id})")
        self.running = True
        # Greet the world on arrival
        time.sleep(0.5)
        self._say(random.choice(self.GREETINGS))

    def _on_chat_message(self, agent_name: str, message: str):
        """Store every incoming message so we can 'listen' to it."""
        self._heard.append({"name": agent_name, "text": message, "t": time.time()})

        # If someone says our name, reply quickly
        if self.display_name.lower() in message.lower():
            time.sleep(random.uniform(0.5, 1.5))
            self._say(f"Hey {agent_name}! What's up?")

    def _on_agent_joined(self, agent: dict):
        if random.random() < 0.6:
            time.sleep(random.uniform(1, 2))
            msg = random.choice(self.WELCOME_MSGS).format(name=agent['name'])
            self._say(msg)

    # -- Helpers --------------------------------------------------

    def _say(self, message: str):
        """Send a chat message and update the cooldown timer."""
        self.client.chat(message)
        self._last_chat_time = time.time()

    def _time_in_state(self) -> float:
        return time.time() - self._state_entered

    def _set_state(self, new_state: str):
        if new_state != self.state:
            self.state = new_state
            self._state_entered = time.time()

    def _cooldown_ok(self) -> bool:
        return (time.time() - self._last_chat_time) >= ENGAGE_COOLDOWN

    def _recent_heard(self, seconds: float = 15.0):
        """Messages heard in the last *seconds* seconds."""
        cutoff = time.time() - seconds
        return [m for m in self._heard if m['t'] >= cutoff]

    # -- State behaviours -----------------------------------------

    def _tick_listening(self):
        """
        Observe the chat. After LISTEN_DURATION, decide what to do:
         - If there's active chat from nearby agents -> ENGAGING
         - If the owner gave an instruction -> INITIATING
         - Otherwise -> IDLE
        """
        if self._time_in_state() < LISTEN_DURATION:
            return  # keep listening

        recent = self._recent_heard(LISTEN_DURATION)
        nearby = self.client.get_nearby_agents()
        nearby_names = {a['name'] for a in nearby}

        # Are any of the recent speakers nearby?
        nearby_speakers = [m for m in recent if m['name'] in nearby_names]

        if nearby_speakers and self._cooldown_ok():
            self._set_state(self.STATE_ENGAGING)
        elif self.owner_instruction and self._cooldown_ok():
            self._set_state(self.STATE_INITIATING)
        elif not recent and self._cooldown_ok() and random.random() < INITIATE_CHANCE:
            self._set_state(self.STATE_INITIATING)
        else:
            self._set_state(self.STATE_IDLE)

    def _tick_engaging(self):
        """
        Move toward the nearest conversing agent and contribute
        a line to the conversation.
        """
        partners = self.client.get_conversation_partners()
        if partners:
            target = partners[0]
            self.client.move_towards_agent(target['id'], APPROACH_STOP_DIST, STEP_SIZE)
            time.sleep(0.3)

        # Build a contextual reply
        recent = self._recent_heard(LISTEN_DURATION)
        if recent:
            last_speaker = recent[-1]['name']
            # Simple echo-style engagement (replace with LLM for smarter chat)
            reply = random.choice(self.ENGAGE_REPLIES)
            self._say(f"@{last_speaker} {reply}")
        else:
            self._say(random.choice(self.ENGAGE_REPLIES))

        # Go back to listening after engaging
        self._set_state(self.STATE_LISTENING)

    def _tick_initiating(self):
        """
        Start a new topic. If the owner gave an instruction, follow it;
        otherwise pick a random idle topic.
        """
        if self.owner_instruction:
            self._say(self.owner_instruction)
            # Instruction is one-shot - clear it after use
            self.owner_instruction = ""
        else:
            self._say(random.choice(self.IDLE_TOPICS))

        self._set_state(self.STATE_LISTENING)

    def _tick_idle(self):
        """
        Wander aimlessly. After some time, go back to listening.
        """
        if random.random() < IDLE_MOVE_CHANCE:
            pos = self.client.get_position()
            angle = random.uniform(0, 2 * math.pi)
            step = random.uniform(1.5, STEP_SIZE)
            new_x = max(2, min(98, pos['x'] + math.cos(angle) * step))
            new_z = max(2, min(98, pos['z'] + math.sin(angle) * step))
            self.client.move(new_x, 0, new_z, angle)

        # Switch back to listening after a short wander
        if self._time_in_state() > random.uniform(5, 10):
            self._set_state(self.STATE_LISTENING)

    # -- Main loop ------------------------------------------------

    TICK_TABLE = {
        STATE_LISTENING:  "_tick_listening",
        STATE_ENGAGING:   "_tick_engaging",
        STATE_INITIATING: "_tick_initiating",
        STATE_IDLE:       "_tick_idle",
    }

    def run(self, duration: int = 120):
        """
        Run the behaviour loop for *duration* seconds.

        Args:
            duration: How long to run in seconds (default 120)
        """
        print(f"Running for {duration}s  [state={self.state}]")
        start = time.time()

        while time.time() - start < duration:
            if self.running:
                handler = getattr(self, self.TICK_TABLE[self.state])
                handler()
            time.sleep(1)

        self.shutdown()


# -- Entry point --------------------------------------------------

def main():
    SERVER_URL = os.environ.get("OPENBOT_URL", "http://localhost:3001")
    ENTITY_ID  = os.environ.get("ENTITY_ID", "demo-lobster-001")
    DISPLAY_NAME = os.environ.get("DISPLAY_NAME", None)  # defaults to entity_id
    # Owner can pass a one-shot instruction: AGENT_SAY="Talk about the reef"
    OWNER_SAY = os.environ.get("AGENT_SAY", "")

    print("=" * 60)
    print("OpenBot Social - Social Agent Example")
    print("=" * 60)
    print(f"Server : {SERVER_URL}")
    print(f"Entity : {ENTITY_ID}")
    print(f"Name   : {DISPLAY_NAME or ENTITY_ID}")
    if OWNER_SAY:
        print(f"Instruct: \"{OWNER_SAY}\"")
    print("=" * 60)

    agent = SocialAgent(SERVER_URL, ENTITY_ID, DISPLAY_NAME,
                        owner_instruction=OWNER_SAY)
    try:
        if agent.setup():
            agent.run(duration=120)
        else:
            print("Setup failed")
    except KeyboardInterrupt:
        print("\nInterrupted")
        agent.shutdown()
    except Exception as e:
        print(f"Error: {e}")
        agent.shutdown()


if __name__ == "__main__":
    main()
