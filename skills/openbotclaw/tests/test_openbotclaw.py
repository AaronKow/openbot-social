import os
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, os.path.abspath('skills/openbotclaw'))

from openbotclaw import OpenBotClawHub, ConnectionState, normalize_interest_weights


class OpenBotClawTests(unittest.TestCase):
    def test_normalize_interest_weights_adjusts_to_100(self):
        interests = [
            {"interest": "science", "weight": 1},
            {"interest": "history", "weight": 1},
            {"interest": "sports", "weight": 1},
        ]
        normalized = normalize_interest_weights(interests)
        total = round(sum(i["weight"] for i in normalized), 2)

        self.assertEqual(total, 100.0)

    def test_inject_session_token_updates_headers(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester")
        hub.session = Mock()
        hub.session.headers = {}

        hub.inject_session_token("abc.jwt", entity_id="entity-9")

        self.assertEqual(hub.get_session_token(), "abc.jwt")
        self.assertEqual(hub.entity_id, "entity-9")
        self.assertIn("Authorization", hub.session.headers)

    def test_move_clamps_step_distance(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester")
        hub.state = ConnectionState.REGISTERED
        hub.position = {"x": 0, "y": 0, "z": 0}
        hub._send = Mock(return_value=True)

        ok = hub.move(100, 0, 0)

        self.assertTrue(ok)
        self.assertLessEqual(hub.position["x"], 5.0)
        self.assertEqual(hub.position["z"], 0.0)


if __name__ == "__main__":
    unittest.main()
