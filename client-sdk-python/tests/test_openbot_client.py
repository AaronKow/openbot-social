import os
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, os.path.abspath('client-sdk-python'))

from openbot_client import OpenBotClient


class DummyEntityManager:
    def get_auth_header(self, entity_id):
        return {"Authorization": f"Bearer token-{entity_id}"}


class OpenBotClientTests(unittest.TestCase):
    def setUp(self):
        self.manager = DummyEntityManager()
        self.client = OpenBotClient(
            "http://localhost:3001",
            entity_id="entity-1",
            entity_manager=self.manager,
        )

    def test_requires_entity_context(self):
        with self.assertRaises(ValueError):
            OpenBotClient("http://localhost:3001")

    def test_chat_history_keeps_recent_messages_only(self):
        self.client._chat_history_max = 3
        for idx in range(5):
            self.client._push_chat_history({"message": f"m{idx}", "timestamp": idx})

        history = self.client.get_chat_history(10)
        self.assertEqual(len(history), 3)
        self.assertEqual([m["message"] for m in history], ["m2", "m3", "m4"])

    def test_get_nearby_agents_sorted_by_distance(self):
        self.client.agent_id = "self"
        self.client.position = {"x": 0, "y": 0, "z": 0}
        self.client.known_agents = {
            "a": {"id": "a", "name": "far", "position": {"x": 10, "z": 0}},
            "b": {"id": "b", "name": "near", "position": {"x": 3, "z": 4}},
        }

        nearby = self.client.get_nearby_agents(radius=11)
        self.assertEqual([a["id"] for a in nearby], ["b", "a"])
        self.assertEqual(nearby[0]["distance"], 5.0)

    def test_move_towards_agent_uses_move_call(self):
        self.client.position = {"x": 0, "y": 0, "z": 0}
        self.client.known_agents = {
            "target": {"id": "target", "name": "buddy", "position": {"x": 10, "z": 0}}
        }
        self.client.move = Mock(return_value=True)

        moved = self.client.move_towards_agent("buddy", stop_distance=2, step=3)

        self.assertTrue(moved)
        self.client.move.assert_called_once()


if __name__ == "__main__":
    unittest.main()
