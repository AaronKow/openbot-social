import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath('client-sdk-python'))

from openbot_ai_agent import AIAgent


class DummyClient:
    def __init__(self):
        self.position = {"x": 10, "y": 0, "z": 10}
        self.world_size = {"x": 100, "y": 100}
        self.latest_world_state = {}
        self.known_agents = {}
        self.agent_id = "self"
        self.recent_window_calls = []
        self.chats = []
        self.moves = []
        self.queue_submissions = []
        self.queue_executions = 0
        self.actions = []

    def get_position(self):
        return self.position

    def get_world_state_snapshot(self):
        return dict(self.latest_world_state)

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

    def action(self, emote, **kwargs):
        self.actions.append((emote, kwargs))
        return True

    def move_towards_agent(self, name, stop_distance=3.0, step=5.0):
        return True

    def submit_action_queue(self, actions, mode='replace'):
        self.queue_submissions.append((actions, mode))
        return {"success": True, "queue": {"sequence": actions}}

    def execute_action_queue(self):
        self.queue_executions += 1
        return {"success": True}


class AIAgentTimingTests(unittest.TestCase):
    def _base_perception(self):
        return {
            "tick": 1,
            "worldTick": 100,
            "position": {"x": 10.0, "z": 10.0},
            "markers": {
                "mentions": [],
                "urgent_chat": [],
                "new_messages": [],
                "blocked_resource": [],
            },
            "selfState": {
                "inventory": {"rock": 0, "kelp": 0, "seaweed": 0},
                "lastAction": {},
                "expansionCooldownUntilTick": 0,
            },
            "worldObjects": [
                {"id": "rock-1", "type": "rock", "position": {"x": 11, "z": 10}},
                {"id": "kelp-1", "type": "kelp", "position": {"x": 12, "z": 10}},
                {"id": "seaweed-1", "type": "seaweed", "position": {"x": 13, "z": 10}},
            ],
            "frontier": {
                "centroid": {"x": 20, "z": 20},
                "resource_likelihood": 0.7,
                "novelty": 0.8,
                "edge_sector": True,
            },
            "expansionGuidance": {"target": {"x": 22, "z": 22}},
            "explorationGuidance": {},
            "progressionSignals": {
                "inventoryTowardsExpansionCost": {"ready": False},
                "questProgressSnapshot": {"active": []},
                "nearestHarvestableResources": [
                    {"id": "rock-1", "type": "rock", "x": 11, "z": 10, "distance": 1.0}
                ],
            },
            "exploration": {"progress": {"frontier_debt": 0.1, "loop_streak": 0, "stagnation_streak": 0}},
            "survival": {},
            "threats": [],
        }

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

    @patch("openbot_ai_agent.OpenAI")
    def test_execute_move_keeps_expansion_frontier_coordinates(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-expansion"
        agent.client = DummyClient()
        agent.client.latest_world_state = {
            "expansionTiles": [
                {"x": 120, "z": 130},
            ]
        }

        agent._execute([{"type": "move", "x": 120, "z": 130}])

        self.assertEqual(len(agent.client.moves), 1)
        mx, _, mz, _ = agent.client.moves[0]
        self.assertEqual(mx, 120)
        self.assertEqual(mz, 130)

    @patch("openbot_ai_agent.OpenAI")
    def test_execute_move_then_expand_map_frontier_flow(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-frontier-flow"
        agent.client = DummyClient()
        agent.client.latest_world_state = {
            "expansionTiles": [
                {"x": 121, "z": 122},
            ]
        }

        executed = agent._execute([
            {"type": "move", "x": 121, "z": 122},
            {"type": "expand_map", "x": 121, "z": 122},
        ])

        self.assertEqual(agent.client.moves[0][0], 121)
        self.assertEqual(agent.client.moves[0][2], 122)
        self.assertIn(("expand_map", {"x": 121.0, "z": 122.0}), agent.client.actions)
        self.assertEqual(executed[1].get("status"), "ok")

    @patch("openbot_ai_agent.OpenAI")
    def test_execute_move_sanitizes_non_finite_coordinates(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-safety"
        agent.client = DummyClient()

        agent._execute([{"type": "move", "x": float("inf"), "z": float("nan")}])

        self.assertEqual(len(agent.client.moves), 1)
        mx, _, mz, _ = agent.client.moves[0]
        self.assertEqual(mx, 10.0)
        self.assertEqual(mz, 10.0)

    @patch("openbot_ai_agent.OpenAI")
    def test_act_submits_server_action_queue_for_long_intervals(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=900.0)
        agent.entity_id = "agent-1"
        agent.client = DummyClient()

        result = agent.act({"actions": [{"type": "move", "x": 20, "z": 40}]})

        self.assertEqual(agent.client.queue_executions, 0)
        self.assertEqual(len(agent.client.queue_submissions), 1)
        submitted_actions, mode = agent.client.queue_submissions[0]
        self.assertEqual(mode, "replace")
        self.assertGreaterEqual(len(submitted_actions), 4)
        self.assertEqual(result.get("execution"), "lobster-side")
        self.assertGreaterEqual(result.get("queuedPlanActions", 0), 1)
        self.assertGreaterEqual(len(agent.client.moves), 1)

    @patch("openbot_ai_agent.OpenAI")
    def test_balanced_guardrail_no_force_when_social_streak_below_threshold(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent._tick_count = 5
        agent._last_objective_tick = 4
        agent._social_only_plan_streak = 0
        perception = self._base_perception()

        actions = agent._apply_balanced_objective_guardrails(
            [{"type": "chat", "message": "hi there"}],
            perception,
        )

        self.assertEqual(actions[0].get("type"), "chat")
        self.assertEqual(agent._social_only_plan_streak, 1)

    @patch("openbot_ai_agent.OpenAI")
    def test_balanced_guardrail_forces_objective_after_social_streak(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent._tick_count = 20
        agent._last_objective_tick = 1
        agent._social_only_plan_streak = 2
        perception = self._base_perception()
        perception["selfState"]["inventory"] = {"rock": 0, "kelp": 1, "seaweed": 1}

        forced = agent._apply_balanced_objective_guardrails(
            [{"type": "chat", "message": "still social"}],
            perception,
        )

        self.assertIn(forced[0].get("type"), {"move", "harvest"})
        self.assertTrue(any(a.get("type") == "harvest" for a in forced))
        self.assertTrue(any(bool(a.get("__objective_cycle")) for a in forced))

    @patch("openbot_ai_agent.OpenAI")
    def test_balanced_guardrail_defers_when_mentions_active(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent._tick_count = 20
        agent._last_objective_tick = 1
        agent._social_only_plan_streak = 4
        perception = self._base_perception()
        perception["markers"]["mentions"] = ["📣 TAGGED BY reef-bot"]
        perception["taggedBy"] = ["reef-bot"]

        actions = agent._apply_balanced_objective_guardrails(
            [{"type": "chat", "message": "@reef-bot on it"}],
            perception,
        )

        self.assertEqual(actions[0].get("type"), "chat")
        self.assertFalse(any(a.get("type") in {"harvest", "expand_map"} for a in actions))

    @patch("openbot_ai_agent.OpenAI")
    def test_balanced_guardrail_forces_when_missing_resources_persist(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent._tick_count = 30
        agent._last_objective_tick = 28
        agent._social_only_plan_streak = 0
        agent._missing_resource_streak = 2
        perception = self._base_perception()
        perception["selfState"]["inventory"] = {"rock": 0, "kelp": 1, "seaweed": 1}

        forced = agent._apply_balanced_objective_guardrails(
            [{"type": "wait"}],
            perception,
        )

        self.assertTrue(any(a.get("type") == "harvest" for a in forced))
        self.assertEqual(agent._last_forced_objective_reason, "missing_resources_persisted")

    @patch("openbot_ai_agent.OpenAI")
    def test_anti_idle_contract_injects_objective_cycle_on_wallclock_social_debt(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-anti-idle"
        agent.client = DummyClient()
        agent._anti_idle_policy_enabled = True
        agent._anti_idle_policy_bias = 0.4
        agent._social_only_wallclock_seconds = agent._anti_idle_max_social_seconds + 30
        agent._recent_plan_runtime.append({
            "tick": 1,
            "objectiveActions": 0,
            "movementActions": 0,
            "chatActions": 1,
            "displacement": 0.0,
            "socialOnly": True,
        })
        perception = self._base_perception()

        contracted = agent._apply_anti_idle_contract(
            [{"type": "chat", "message": "still social"}],
            perception,
        )

        self.assertGreaterEqual(len(contracted), 1)
        self.assertEqual(contracted[0].get("type"), "move")
        self.assertTrue(any(bool(a.get("__objective_cycle")) for a in contracted))

    @patch("openbot_ai_agent.OpenAI")
    def test_mission_role_enforcement_injects_forager_action_each_window(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-mission"
        agent.client = DummyClient()
        agent._tick_count = 22
        agent._last_mission_role_action_tick = 10
        agent._mission_membership = {"missionId": "mission-1"}
        agent._mission_role = "forager"
        perception = self._base_perception()
        perception["nearHarvestObject"] = {"id": "rock-1", "type": "rock"}

        enforced = agent._enforce_mission_role_action(
            [{"type": "chat", "message": "hello"}],
            perception,
        )

        self.assertEqual(enforced[0].get("type"), "harvest")
        self.assertEqual(enforced[0].get("resource_type"), "rock")
        self.assertEqual(enforced[0].get("object_id"), "rock-1")


if __name__ == "__main__":
    unittest.main()
