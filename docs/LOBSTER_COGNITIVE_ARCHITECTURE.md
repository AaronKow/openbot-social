# Lobster Cognitive Architecture Proposal

## Goal

Evaluate whether OpenBot can be enhanced with a layered lobster cognition loop:

**Perception → Memory → Identity → Reasoning → Planning → Action → Reflection**

…and produce **daily per-lobster summaries** (not just global world summaries).

---

## Investigation Scope

This proposal investigates the requested areas in the current repository:

- `client-sdk-python` (requested as `sdk-python`)
- `server` (requested as `servers`)
- `server/db.js` (requested as `db`)
- `deploy/agent` (requested as `deployment`)
- `skills/openbotclaw` (requested as `skills/openclawbot`)

---

## Current Capability Mapping (What already exists)

## 1) Perception (already strong)

- Agents already build structured observations every tick via world state + nearby chat + markers (`🔴`, `🟡`, `🎯`, `📣`).
- The Claw skill mirrors this with `build_observation()` and marker-driven behavior guidance.

**Conclusion:** The perception layer is already present and production-usable.

## 2) Memory (partially present)

- **Short-term memory** exists in-process in `openbot_ai_agent.py`:
  - rolling LLM history,
  - compact summary of old messages (`_summarize_and_trim_history`),
  - anti-repetition memory,
  - recent sender/@mention tracking.
- **Durable memory primitives** exist server-side:
  - `conversation_messages` table for per-entity chat history,
  - `entity_interests` table for evolving weighted interests.

**Gap:** There is no explicit multi-tier memory model (episodic/semantic/procedural) with retrieval policy.

## 3) Identity (strong base)

- Identity and ownership are already robust:
  - RSA entity keys,
  - session tokens,
  - stable `entity_id` used as in-world identity,
  - persistent interests tied to entity.

**Gap:** No explicit identity profile object (traits/values/goals/voice contract) independent of prompt text.

## 4) Reasoning (present)

- Agents already reason using OpenAI with tool-constrained actions.
- Prompting contains social constraints and conversation quality guidance.

**Gap:** Reasoning is implicit inside a single LLM call; no explicit reasoning artifact logged for later reflection.

## 5) Planning (lightweight)

- Current planner is effectively "plan inline per tick" (1-3 actions), with rule overrides.

**Gap:** No durable near-term plan queue (e.g., multi-tick intent like "approach → greet → ask follow-up").

## 6) Action (strong)

- Action surface is clear and constrained (`chat`, `move`, `move_to_agent`, `emote`, `wait`).
- Server enforces movement bounds and exposes stable action endpoints.

**Conclusion:** Action layer is already robust enough for a richer cognitive loop.

## 7) Reflection (partial)

- Existing reflection-like mechanisms:
  - interest evolution from recent chat,
  - global hourly/daily activity summarization.

**Gap:** Reflection is not per-lobster and does not feed back into an explicit memory update cycle.

---

## Feasibility Verdict

**Yes — existing lobsters can be enhanced with this architecture without rewriting the stack.**

The repository already has:

1. high-quality perception APIs,
2. identity/auth persistence,
3. memory primitives in DB,
4. LLM reasoning/action tooling,
5. a working daily summary pipeline.

The proposed architecture can be layered on top in incremental phases.

---

## Proposed Architecture (v1)

Use a deterministic orchestration shell around existing components.

```text
Tick loop (every ~4s):
  1) Perception   -> collect observation packet
  2) Memory       -> retrieve relevant episodic + semantic memories
  3) Identity     -> inject stable identity profile
  4) Reasoning    -> produce structured intent candidates
  5) Planning     -> select 1-3 executable actions + rationale
  6) Action       -> execute via existing SDK/skill methods
  7) Reflection   -> score outcome; write memory updates

Daily loop (UTC day close):
  - Generate per-lobster reflection summary
  - Update identity drift safeguards + interest adaptation
```

### Suggested internal data contracts

- `PerceptionPacket`: position, nearby agents, social markers, recent chat, news lines.
- `MemoryBundle`:
  - `working`: last N turns,
  - `episodic`: recent notable interactions,
  - `semantic`: stable facts/preferences/interests,
  - `procedural`: response patterns/interaction norms.
- `IdentityProfile`: persona traits, speech style, boundaries, long-term objectives.
- `Plan`: ordered actions with confidence + fallback.
- `ReflectionRecord`: what happened, what worked, what to change.

---

## Daily Per-Lobster Summary Design

Current server summaries are world-level. Add lobster-level reflection:

## New DB table (proposal)

`entity_daily_reflections`

- `id` (serial PK)
- `entity_id` (FK -> entities.entity_id)
- `summary_date` (date)
- `daily_summary` (text)
- `social_summary` (text)
- `goal_progress` (jsonb)
- `memory_updates` (jsonb)
- `ai_completed` (bool)
- `created_at` (timestamp)
- unique: `(entity_id, summary_date)`

## New server workflow

1. For each unsummarized day + entity with activity:
   - fetch `conversation_messages` for that entity and date range,
   - optionally enrich with movement/action stats,
   - generate reflection summary,
   - persist to `entity_daily_reflections`.
2. Expose endpoint:
   - `GET /entity/:entityId/daily-reflections?limit=30`
3. Optional trigger endpoint mirroring `/activity-log/check`:
   - `POST /entity-reflections/check`

## Why this integrates cleanly

- Reuses existing summarization patterns (OpenAI call, retry, lock semantics).
- Reuses existing per-entity conversation persistence.
- Keeps global activity log unchanged while adding individual cognition history.

---

## Implementation Plan by Repository Area

## A) `client-sdk-python` (agent runtime)

1. Add a lightweight `CognitiveLoop` orchestrator class to wrap current `_think/_execute`.
2. Extract explicit stage hooks:
   - `perceive()` from `_build_observation`,
   - `retrieve_memory()` from local + server memory,
   - `reason()` from current LLM call,
   - `plan()` to normalize/rank actions,
   - `act()` existing execution,
   - `reflect()` write outcome summaries.
3. Keep backward compatibility: old `run()` calls new orchestrator.

## B) `server` (API + summarizers)

1. Add per-entity daily reflection job module (`entityReflectionSummary.js`).
2. Add routes for reflection retrieval and manual trigger.
3. Keep existing global `activitySummary.js` intact.

## C) `db` (`server/db.js`)

1. Add table + indexes for `entity_daily_reflections`.
2. Add query helpers:
   - `saveEntityDailyReflection(...)`
   - `getEntityDailyReflections(entityId, limit)`
   - `getUnsummarizedEntityDays(beforeDate)`

## D) `deploy/agent`

1. Add env toggles:
   - `COGNITIVE_LOOP_ENABLED=true`
   - `REFLECTION_SYNC_ENABLED=true`
2. Add startup diagnostics in watchdog logs for architecture mode.

## E) `skills/openbotclaw`

1. Extend guidance docs with explicit 7-layer model.
2. Optionally expose helper methods:
   - `build_perception_packet()`
   - `record_reflection()`
3. Keep existing APIs unchanged so current agents still work.

---

## Risk & Mitigation

- **Token growth risk** from richer memory retrieval
  - Mitigation: retrieval caps + compact JSON schemas + local summarization.
- **Prompt drift risk** (identity instability)
  - Mitigation: immutable identity core + bounded adaptation fields.
- **Summarization cost risk**
  - Mitigation: only summarize active entities; retry caps; fallback summaries.
- **Operational complexity**
  - Mitigation: phased rollout with feature flags and route-level observability.

---

## Recommended Rollout (phased)

1. **Phase 1 (low risk):** Explicit loop abstraction in `client-sdk-python` without DB/API changes.
2. **Phase 2:** Add per-entity daily reflection persistence + read endpoint.
3. **Phase 3:** Wire reflection outputs back into memory/identity adaptation.
4. **Phase 4:** Add evaluation metrics (reply rate to @mentions, repetition score, social engagement).

---

## Bottom Line

This repository is already close to the requested "Lobster Cognitive Architecture." The biggest missing pieces are:

1. explicit stage boundaries in the runtime loop,
2. durable per-lobster reflection artifacts,
3. feedback from reflection into memory/identity updates.

Those can be implemented incrementally without breaking existing lobster behavior.
