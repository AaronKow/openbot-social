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




class DummyEntityManager:
    def get_auth_header(self, entity_id):
        return {"authorization": f"Bearer token-{entity_id}"}


class DummyResponse:
    def __init__(self, status_code=200, text='ok'):
        self.status_code = status_code
        self.text = text

    def json(self):
        return {}


class DummySession:
    def __init__(self):
        self.posts = []
        self.gets = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append({
            "url": url,
            "headers": headers or {},
            "json": json or {},
            "timeout": timeout,
        })
        return DummyResponse(200, 'ok')

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets.append({
            "url": url,
            "params": params or {},
            "headers": headers or {},
            "timeout": timeout,
        })
        return DummyResponse(200, 'ok')


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
    def test_progression_policy_injects_move_before_expand_when_target_far(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        perception = self._base_perception()
        perception["position"] = {"x": 10.0, "z": 10.0}
        perception["selfState"]["inventory"] = {"rock": 1, "kelp": 1, "seaweed": 1}
        perception["progressionSignals"]["inventoryTowardsExpansionCost"] = {"ready": True}
        perception["expansionGuidance"] = {"target": {"x": 24.0, "z": 26.0}}

        actions = agent._apply_progression_policy([{"type": "chat", "message": "hi"}], perception)

        self.assertEqual(actions[0].get("type"), "move")
        self.assertEqual(actions[1].get("type"), "expand_map")
        self.assertEqual(actions[1].get("x"), 24.0)
        self.assertEqual(actions[1].get("z"), 26.0)

    @patch("openbot_ai_agent.OpenAI")
    def test_progression_policy_injects_move_before_harvest_when_resource_far(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        perception = self._base_perception()
        perception["position"] = {"x": 10.0, "z": 10.0}
        perception["selfState"]["inventory"] = {"rock": 0, "kelp": 1, "seaweed": 1}
        perception["progressionSignals"]["inventoryTowardsExpansionCost"] = {"ready": False}
        perception["progressionSignals"]["nearestHarvestableResources"] = [
            {"id": "rock-far", "type": "rock", "x": 30.0, "z": 30.0, "distance": 28.2}
        ]

        actions = agent._apply_progression_policy([{"type": "chat", "message": "hi"}], perception)

        self.assertEqual(actions[0].get("type"), "move")
        self.assertEqual(actions[1].get("type"), "harvest")
        self.assertEqual(actions[1].get("resource_type"), "rock")
        self.assertEqual(actions[1].get("object_id"), "rock-far")

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

    @patch("openbot_ai_agent.OpenAI")
    def test_reflect_syncs_same_day_wishlist_for_short_lived_agents(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-wishlist"
        agent.client = DummyClient()
        session = DummySession()
        agent.client.session = session
        agent.entity_manager = DummyEntityManager()

        perception = self._base_perception()
        perception["timestamp"] = 1735689600000
        action_outcome = {
            "executedActions": [{"type": "chat", "status": "ok"}],
        }

        agent.reflect(perception, {}, {}, {}, {}, action_outcome)

        wishlist_posts = [p for p in session.posts if p["url"].endswith("/wishlists")]
        self.assertGreaterEqual(len(wishlist_posts), 1)
        self.assertIn("wishes", wishlist_posts[0]["json"])
        self.assertTrue(wishlist_posts[0]["json"]["wishes"])

    @patch("openbot_ai_agent.OpenAI")
    def test_perceive_fetches_exploration_recommendations_and_derives_guidance_from_them(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-perceive"
        agent.client = DummyClient()
        agent.client.get_world_threats = lambda: []
        agent.client.get_world_objects = lambda: []
        agent.client.get_self_agent_state = lambda: {"inventory": {"rock": 0, "kelp": 0, "seaweed": 0}}

        exploration_rows = [
            {
                "targetPosition": {"x": 33, "z": 44},
                "reason": "seek unvisited frontier",
                "score": 0.91,
            }
        ]

        def fake_fetch(rec_type):
            if rec_type == "conversation":
                return [{"id": "c1"}]
            if rec_type == "expansion":
                return [{"id": "e1"}]
            if rec_type == "exploration":
                return exploration_rows
            return []

        with patch.object(agent, "_maybe_fetch_news"), \
             patch.object(agent, "_build_observation", return_value="🔵 alone"), \
             patch.object(agent, "_update_stuck_runtime"), \
             patch.object(agent, "_update_shelter_runtime", return_value={}), \
             patch.object(agent, "_get_nearest_threat", return_value=None), \
             patch.object(agent, "_get_nearest_harvestable_object", return_value=None), \
             patch.object(agent, "_build_progression_signals", return_value={}), \
             patch.object(agent, "_compute_exploration_state", return_value={"progress": {}, "nearest_frontier_cell": None}), \
             patch.object(agent, "_fetch_recommendations", side_effect=fake_fetch) as mock_fetch, \
             patch.object(agent, "_fetch_world_progress", return_value={}), \
             patch.object(agent, "_maybe_join_mission", return_value={}), \
             patch.object(agent, "_fetch_active_missions", return_value=[]):
            perception = agent.perceive()

        self.assertEqual(
            [call.args[0] for call in mock_fetch.call_args_list[:3]],
            ["conversation", "expansion", "exploration"],
        )
        self.assertEqual(perception["expansionRecommendations"], [{"id": "e1"}])
        self.assertEqual(perception["explorationRecommendations"], exploration_rows)
        self.assertEqual(perception["explorationGuidance"]["target"], {"x": 33.0, "z": 44.0})
        self.assertIn("seek unvisited frontier", perception["explorationGuidance"]["reason"])

    @patch("openbot_ai_agent.OpenAI")
    def test_perceive_emits_shown_events_for_top_recommendations(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-shown"
        agent.client = DummyClient()
        agent.client.get_world_threats = lambda: []
        agent.client.get_world_objects = lambda: []
        agent.client.get_self_agent_state = lambda: {"inventory": {"rock": 0, "kelp": 0, "seaweed": 0}}
        agent.client.session = DummySession()
        agent.client._get_auth_headers = lambda: {"authorization": "Bearer token"}

        with patch.object(agent, "_maybe_fetch_news"), \
             patch.object(agent, "_build_observation", return_value="🔵 alone"), \
             patch.object(agent, "_update_stuck_runtime"), \
             patch.object(agent, "_update_shelter_runtime", return_value={}), \
             patch.object(agent, "_get_nearest_threat", return_value=None), \
             patch.object(agent, "_get_nearest_harvestable_object", return_value=None), \
             patch.object(agent, "_build_progression_signals", return_value={}), \
             patch.object(agent, "_compute_exploration_state", return_value={"progress": {}, "nearest_frontier_cell": None}), \
             patch.object(agent, "_fetch_recommendations", side_effect=[
                 [{"entityId": "c1"}, {"entityId": "c2"}],
                 [{"entityId": "e1"}],
                 [{"entityId": "x1"}],
             ]), \
             patch.object(agent, "_fetch_world_progress", return_value={}), \
             patch.object(agent, "_maybe_join_mission", return_value={}), \
             patch.object(agent, "_fetch_active_missions", return_value=[]):
            agent.perceive()

        event_posts = [p for p in agent.client.session.posts if p["url"].endswith("/recommendations/events")]
        self.assertEqual(len(event_posts), 4)
        self.assertEqual(event_posts[0]["json"]["eventType"], "shown")

    @patch("openbot_ai_agent.OpenAI")
    def test_plan_marks_acceptance_and_reflect_emits_follow_through(self, mock_openai):
        agent = AIAgent(openai_api_key="test-key", tick_interval=4.0)
        agent.entity_id = "agent-lifecycle"
        agent.client = DummyClient()
        agent.client.session = DummySession()
        agent.client._get_auth_headers = lambda: {"authorization": "Bearer token"}

        perception = self._base_perception()
        perception["recommendations"] = [{"entityId": "friend-1"}]
        perception["expansionRecommendations"] = []
        perception["explorationRecommendations"] = []

        with patch.object(agent, "_apply_progression_policy", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_inject_mission_role_bias", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_merge_quest_priorities", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_apply_survival_reflex", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_arbitrate_goal_channels", side_effect=lambda _p, actions: actions), \
             patch.object(agent, "_apply_balanced_objective_guardrails", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_apply_anti_idle_contract", side_effect=lambda actions, _: actions), \
             patch.object(agent, "_enforce_mission_role_action", side_effect=lambda actions, _: actions):
            plan = agent.plan({"actions": [{"type": "move_to_agent", "agent_name": "friend-1"}]}, perception)

        planned_action = plan["actions"][0]
        self.assertIn("__recommendation", planned_action)

        executed = agent._execute([planned_action])
        self.assertEqual(executed[0]["recommendation"]["candidateEntityId"], "friend-1")

        with patch.object(agent, "_get_quest_progress_snapshot", return_value={}), \
             patch.object(agent, "_rollup_reflection"), \
             patch.object(agent, "_maybe_sync_same_day_wishlist"), \
             patch.object(agent, "_maybe_sync_previous_day_reflection"), \
             patch.object(agent, "_maybe_publish_mission_progress_chat"):
            agent.reflect(perception, {}, {}, {}, plan, {"executedActions": executed})

        event_posts = [p for p in agent.client.session.posts if p["url"].endswith("/recommendations/events")]
        event_types = [p["json"].get("eventType") for p in event_posts]
        self.assertIn("accepted", event_types)
        self.assertIn("follow_through", event_types)



if __name__ == "__main__":
    unittest.main()
