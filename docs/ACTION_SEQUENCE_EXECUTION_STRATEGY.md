# Action Sequence Execution Strategy (Short, Infra-Fit Version)

## TL;DR for your current setup (1 server + 1 DB)

**Yes, this is feasible on your current infra** if implemented in a lightweight way:

- Execute queue progress **in server memory** each tick.
- Write to DB only on **queue create** and **queue finish/cancel/fail**.
- Do **not** write per tick.

If you follow this, impact should be low for normal traffic.

---

## What to implement first (safe version)

1. Add a per-lobster action queue in memory.
2. Add simple APIs:
   - create/replace queue
   - start queue
   - get queue status
   - cancel queue
3. Keep strict limits:
   - max 8 actions per queue
   - max 30 total ticks per queue
   - rate-limit queue submissions per lobster
4. Persist only lifecycle events in DB:
   - queue created
   - queue ended (completed/failed/cancelled)

This gives chained actions with low DB load.

---

## Performance impact expectation

With the safe version above:

- **Server CPU:** small increase (simple in-memory countdown + pointer advance).
- **DB load:** small increase (2-3 writes per queue, not per tick).
- **Latency:** usually unchanged if queue checks are O(1) per active lobster.

So for one server + one DB, this is typically fine.

---

## Important note on “no impact”

True zero impact is never guaranteed.

But you can keep impact minimal by:

- avoiding per-tick DB writes,
- enforcing queue/tick limits,
- rate limiting queue creation,
- shipping behind a feature flag and monitoring.

---

## Suggested lobster actions for v1

Start with small deterministic set:

- `move` (2-4 ticks)
- `jump` (1 tick)
- `dance` (3 ticks)
- `emoji` (1 tick)
- `wait` (N ticks)

Example sequence:
`jump (1) -> dance (3) -> emoji (1) -> emote (1)`

---

## Rollout plan (minimal risk)

### Phase 1 (now)
- In-memory queue executor + lifecycle DB writes only.
- Keep old immediate actions as fallback.

### Phase 2 (only if needed)
- Add periodic checkpoint (every few steps/seconds) for better crash recovery.

### Phase 3 (later, optional)
- Add richer queue analytics/history.

---

## Decision

For your current infra: **Proceed with Phase 1**.  
It is the best cost/performance tradeoff and should be safe if limits are enforced.
