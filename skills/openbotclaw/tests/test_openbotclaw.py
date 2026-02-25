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

    def test_build_perception_packet_structured_output(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester")
        hub._tick_count = 3
        hub._new_senders = ["reef-1"]
        hub._tagged_by = ["reef-1"]
        hub._interests = ["ocean politics"]
        hub.build_observation = Mock(return_value="🔴 reef-1 — IN RANGE, CHAT NOW\nREPLY TO: reef-1")
        hub.get_position = Mock(return_value={"x": 5.0, "y": 0.0, "z": 7.0})

        packet = hub.build_perception_packet()

        self.assertEqual(packet["tick"], 3)
        self.assertEqual(packet["position"]["x"], 5.0)
        self.assertEqual(packet["new_senders"], ["reef-1"])
        self.assertEqual(packet["tagged_by"], ["reef-1"])
        self.assertTrue(packet["markers"]["urgent_chat"])
        self.assertIn("reef-1", packet["markers"]["reply_targets"])


    def test_observe_chat_biases_interest_weights(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester")
        hub._interests_with_weights = [
            {"interest": "ocean politics", "weight": 33.34},
            {"interest": "weird science", "weight": 33.33},
            {"interest": "sports debates", "weight": 33.33},
        ]
        hub.set_interests = Mock(return_value=True)

        hub._observe_chat_for_interests("ocean politics are heating up this week")

        self.assertNotEqual(hub._interests_with_weights[0]["weight"], 33.34)
        self.assertEqual(round(sum(i["weight"] for i in hub._interests_with_weights), 2), 100.0)
        hub.set_interests.assert_called_once()

    def test_record_reflection_posts_expected_payload(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester", entity_id="tester")
        hub.session = Mock()
        response = Mock()
        response.status_code = 200
        hub.session.post = Mock(return_value=response)

        ok = hub.record_reflection(
            summary_date="2026-02-24",
            daily_summary="Great social day",
            message_count=4,
            social_summary="Met 2 agents",
            goal_progress={"social": 0.9},
            memory_updates={"lesson": "ask follow-ups"},
        )

        self.assertTrue(ok)
        hub.session.post.assert_called_once()
        kwargs = hub.session.post.call_args.kwargs
        self.assertEqual(kwargs["json"]["summaryDate"], "2026-02-24")
        self.assertEqual(kwargs["json"]["messageCount"], 4)

    def test_get_daily_reflections_returns_summaries(self):
        hub = OpenBotClawHub("http://localhost:3001", agent_name="tester", entity_id="tester")
        hub.session = Mock()
        response = Mock()
        response.status_code = 200
        response.json = Mock(return_value={"summaries": [{"date": "2026-02-24", "dailySummary": "ok"}]})
        hub.session.get = Mock(return_value=response)

        rows = hub.get_daily_reflections(limit=10)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2026-02-24")
        hub.session.get.assert_called_once()


if __name__ == "__main__":
    unittest.main()
