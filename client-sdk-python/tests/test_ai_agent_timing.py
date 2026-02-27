import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath('client-sdk-python'))

from openbot_ai_agent import AIAgent


class DummyClient:
    def __init__(self):
        self.position = {"x": 10, "y": 0, "z": 10}
        self.known_agents = {}
        self.agent_id = "self"
        self.recent_window_calls = []
        self.chats = []
        self.moves = []

    def get_position(self):
        return self.position

    def _distance(self, p1, p2):
        dx = p1.get("x", 0) - p2.get("x", 0)
        dz = p1.get("z", 0) - p2.get("z", 0)
        return (dx * dx + dz * dz) ** 0.5

    def get_recent_conversation(self, window_seconds):
        self.recent_window_calls.append(window_seconds)
        return []

    def chat(self, message):
        self.chats.append(message)

    def move(self, x, y, z, rotation):
        self.moves.append((x, y, z, rotation))
        return True

    def action(self, emote):
        return True

    def move_towards_agent(self, name, stop_distance=3.0, step=5.0):
        return True


class AIAgentTimingTests(unittest.TestCase):
    @patch("openbot_ai_agent.OpenAI")
    def test_build_observation_scales_silence_and_recent_window_with_tick_interval(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=900.0)
        agent.entity_id = "agent-1"
        agent.client = DummyClient()

        observation = agent._build_observation()

        self.assertIn("💬 quiet 900.0s", observation)
        self.assertEqual(agent.client.recent_window_calls[-1], 1800.0)

    @patch("openbot_ai_agent.OpenAI")
    def test_execute_wait_override_uses_tick_scaled_silence_threshold(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=900.0)
        agent.entity_id = "agent-1"
        agent.client = DummyClient()

        # Exactly at threshold (2 ticks * 900 = 1800) should not force a chat.
        agent._tick_count = 2
        agent._last_chat_tick = 0
        with patch("openbot_ai_agent.random.uniform", return_value=50.0):
            agent._execute([{"type": "wait"}])
        self.assertEqual(len(agent.client.chats), 0)
        self.assertEqual(len(agent.client.moves), 1)

        # Beyond threshold (3 ticks * 900 = 2700) should force a random chat.
        agent._tick_count = 3
        agent._last_chat_tick = 0
        with patch("openbot_ai_agent.random.choice", return_value="hello from silence"), \
             patch("openbot_ai_agent.random.uniform", return_value=40.0):
            agent._execute([{"type": "wait"}])

        self.assertEqual(agent.client.recent_window_calls[-1], 1800.0)
        self.assertIn("hello from silence", agent.client.chats)


if __name__ == "__main__":
    unittest.main()
