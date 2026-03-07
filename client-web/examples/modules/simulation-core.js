const HEAD_THRUST_ALIGNMENT_THRESHOLD = (2 * Math.PI) / 180;
const MOVE_ARRIVAL_THRESHOLD = 0.2;
const MOVE_PROGRESS_EPSILON = 0.04;
const MOVE_STUCK_TIMEOUT = 1.0;
const MAX_TURN_RATE = 5.0;
const LOBSTER_COLLISION_RADIUS = 1.2;
const COLLISION_PUSH_BUFFER = 0.35;
const MAP_EDGE_BUFFER = LOBSTER_COLLISION_RADIUS + 0.35;

function hashSeed(text) {
  const value = String(text || 'openbot-seed');
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seedText) {
  let state = hashSeed(seedText) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function phaseFromHour(hour) {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'day';
  return 'dusk';
}

function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function createSimulation({ seed, moduleId }) {
  const rng = createRng(seed);
  const moduleNumber = Number(String(moduleId || '1').split('_')[0]) || 1;
  const subscribers = new Set();
  const width = 100;
  const height = 100;

  const state = {
    world: {
      moduleId,
      seed,
      tick: 0,
      elapsedSeconds: 0,
      timeHours: 9,
      day: 1,
      dayPhase: 'morning',
      width,
      height,
      hazards: [],
      foods: [],
      rescues: []
    },
    lobsters: Array.from({ length: 6 }, (_, i) => {
      const x = 10 + i * 12;
      const z = 25 + (i % 3) * 16;
      return {
        id: `lobster-${i + 1}`,
        name: ['Coral', 'Tide', 'Brine', 'Current', 'Reef', 'Kelp'][i],
        position: { x, y: 0, z },
        rotation: rng() * Math.PI * 2,
        speed: 8.2 + rng() * 2.6,
        state: 'idle',
        actionQueue: [],
        locomotion: {
          target: { x, z },
          travelYaw: 0,
          phase: 'idle',
          moveEndAt: 0,
          stuckTime: 0,
          lastProgressX: x,
          lastProgressZ: z,
          jumpActive: false,
          jumpPhase: 0
        },
        stats: {
          hunger: 22 + i * 5,
          energy: 72 - i * 3,
          hp: 100,
          stamina: 85,
          visibility: 1,
          hazardExposure: 0,
          rescued: 0,
          wins: 0,
          defeats: 0,
          survivalSeconds: 0,
          actions: 0
        },
        skills: {
          scout: { level: 1 + (i % 2), xp: 0, cooldown: 0 },
          forage: { level: 1, xp: 0, cooldown: 0 },
          shellGuard: { level: 1, xp: 0, cooldown: 0 }
        },
        combat: {
          mode: 'neutral',
          targetId: null,
          lastHitTick: 0
        }
      };
    }),
    events: [],
    scoreboard: {
      module: moduleId,
      points: {},
      highlights: []
    }
  };

  function enabled(minModule) {
    return moduleNumber >= minModule;
  }

  function notify() {
    const snapshot = getSnapshot();
    subscribers.forEach((listener) => listener(snapshot));
  }

  function pushEvent(type, message, payload = {}) {
    state.events.unshift({
      type,
      message,
      payload,
      tick: state.world.tick,
      at: nowIso()
    });
    if (state.events.length > 180) state.events.length = 180;
  }

  function pointsFor(id, delta, reason) {
    state.scoreboard.points[id] = (state.scoreboard.points[id] || 0) + delta;
    if (reason) {
      state.scoreboard.highlights.unshift(`${id}: ${reason} (${delta > 0 ? '+' : ''}${delta})`);
      if (state.scoreboard.highlights.length > 25) state.scoreboard.highlights.length = 25;
    }
  }

  function randomPlayablePoint() {
    return {
      x: Math.round(rng() * (width - MAP_EDGE_BUFFER * 2) + MAP_EDGE_BUFFER),
      z: Math.round(rng() * (height - MAP_EDGE_BUFFER * 2) + MAP_EDGE_BUFFER)
    };
  }

  function clampPlayable(position) {
    position.x = clamp(position.x, MAP_EDGE_BUFFER, width - MAP_EDGE_BUFFER);
    position.z = clamp(position.z, MAP_EDGE_BUFFER, height - MAP_EDGE_BUFFER);
  }

  function distance2D(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  function spawnFood(count = 2) {
    if (!enabled(2)) return;
    for (let i = 0; i < count; i += 1) {
      const point = randomPlayablePoint();
      state.world.foods.push({
        id: `food-${state.world.tick}-${i}`,
        x: point.x,
        z: point.z,
        energy: 12 + Math.floor(rng() * 12)
      });
    }
    state.world.foods = state.world.foods.slice(-50);
  }

  function ensureHazards() {
    if (!enabled(6)) return;
    if (state.world.hazards.length > 0) return;
    state.world.hazards = [
      { id: 'blizzard-field', x: 26, z: 62, radius: 12, type: 'blizzard' },
      { id: 'fire-rift', x: 73, z: 34, radius: 10, type: 'fire' },
      { id: 'thunder-zone', x: 54, z: 50, radius: 11, type: 'thunder' },
      { id: 'tornado-alley', x: 38, z: 27, radius: 9, type: 'tornado' }
    ];
  }

  function ensureRescueCases() {
    if (!enabled(7)) return;
    if (state.world.rescues.length > 0) return;
    state.world.rescues.push({ id: 'distress-1', x: 84, z: 78, ttl: 420, rescuedBy: null });
    state.world.rescues.push({ id: 'distress-2', x: 16, z: 82, ttl: 320, rescuedBy: null });
  }

  function assignMoveTarget(lobster, targetX, targetZ, endPadSeconds = 1.0) {
    const locomotion = lobster.locomotion;
    locomotion.target.x = targetX;
    locomotion.target.z = targetZ;
    clampPlayable(locomotion.target);

    const dx = locomotion.target.x - lobster.position.x;
    const dz = locomotion.target.z - lobster.position.z;
    locomotion.travelYaw = Math.atan2(dz, dx);
    locomotion.phase = 'turn';
    locomotion.stuckTime = 0;
    locomotion.lastProgressX = lobster.position.x;
    locomotion.lastProgressZ = lobster.position.z;

    const travelDistance = Math.hypot(dx, dz);
    locomotion.moveEndAt = state.world.elapsedSeconds + (travelDistance / lobster.speed) + endPadSeconds;
  }

  function ensureMoveTarget(lobster, targetX, targetZ, endPadSeconds = 1.0) {
    const locomotion = lobster.locomotion;
    const dx = locomotion.target.x - targetX;
    const dz = locomotion.target.z - targetZ;
    const needsRetarget = (dx * dx) + (dz * dz) > 1.0 || locomotion.phase === 'idle';
    if (needsRetarget) {
      assignMoveTarget(lobster, targetX, targetZ, endPadSeconds);
    }
  }

  function findSafeMoveTarget(originX, originZ, preferredYaw = null) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const distance = 10 + rng() * 12;
      const baseYaw = preferredYaw === null ? rng() * Math.PI * 2 : preferredYaw;
      const yaw = baseYaw + (preferredYaw === null ? 0 : (rng() - 0.5) * 1.6);
      const candidate = {
        x: clamp(originX + Math.cos(yaw) * distance, MAP_EDGE_BUFFER, width - MAP_EDGE_BUFFER),
        z: clamp(originZ + Math.sin(yaw) * distance, MAP_EDGE_BUFFER, height - MAP_EDGE_BUFFER)
      };

      const blockedByHazard = state.world.hazards.some((hazard) => {
        const dx = candidate.x - hazard.x;
        const dz = candidate.z - hazard.z;
        return (dx * dx) + (dz * dz) < (hazard.radius + 0.9) * (hazard.radius + 0.9);
      });

      if (!blockedByHazard) return candidate;
    }

    return {
      x: clamp(originX, MAP_EDGE_BUFFER, width - MAP_EDGE_BUFFER),
      z: clamp(originZ, MAP_EDGE_BUFFER, height - MAP_EDGE_BUFFER)
    };
  }

  function queueAction(lobster, actionType, payload = {}) {
    lobster.actionQueue.push({
      id: `a-${state.world.tick}-${Math.floor(rng() * 1e6)}`,
      type: actionType,
      payload,
      ttl: payload.ttl || 18,
      initialized: false
    });
    lobster.stats.actions += 1;
    pointsFor(lobster.id, 1, `queued ${actionType}`);
  }

  function bootstrapBehavior() {
    state.lobsters.forEach((lobster, idx) => {
      queueAction(lobster, 'patrol', { to: { x: 10 + idx * 13, z: 40 + idx * 6 }, ttl: 22 });
      if (enabled(2)) queueAction(lobster, 'forage', { ttl: 10 });
      if (enabled(3) && idx % 2 === 0) queueAction(lobster, 'skill:scout', { ttl: 8 });
      if (enabled(5)) queueAction(lobster, 'defend', { ttl: 10 });
    });
  }

  function finishAction(lobster) {
    lobster.state = 'idle';
    lobster.locomotion.phase = 'idle';
    lobster.position.y = 0;
    lobster.actionQueue.shift();
  }

  function updateMoveLocomotion(lobster, dt) {
    const locomotion = lobster.locomotion;
    const dx = locomotion.target.x - lobster.position.x;
    const dz = locomotion.target.z - lobster.position.z;
    const distance = Math.hypot(dx, dz);

    if (distance <= MOVE_ARRIVAL_THRESHOLD || state.world.elapsedSeconds >= locomotion.moveEndAt) {
      return true;
    }

    const isNight = state.world.dayPhase === 'night';
    const speedFactor = isNight ? 0.55 : state.world.dayPhase === 'dusk' ? 0.78 : 1;
    const maxTurnThisTick = (isNight ? MAX_TURN_RATE * 0.78 : MAX_TURN_RATE) * dt;
    const yawDelta = shortestAngleDelta(lobster.rotation, locomotion.travelYaw);
    const headingError = Math.abs(yawDelta);

    if (locomotion.phase !== 'thrust') {
      lobster.rotation += clamp(yawDelta, -maxTurnThisTick, maxTurnThisTick);
      if (headingError <= HEAD_THRUST_ALIGNMENT_THRESHOLD) {
        lobster.rotation = locomotion.travelYaw;
        locomotion.phase = 'thrust';
      }
    } else if (headingError > HEAD_THRUST_ALIGNMENT_THRESHOLD) {
      locomotion.phase = 'turn';
    } else {
      if (isNight) {
        // Slight steering drift in darkness makes navigation harder.
        lobster.rotation += (rng() - 0.5) * 0.14 * dt;
      }
      const moveStep = Math.min(distance, lobster.speed * speedFactor * dt);
      lobster.position.x += Math.cos(lobster.rotation) * moveStep;
      lobster.position.z += Math.sin(lobster.rotation) * moveStep;
    }

    clampPlayable(lobster.position);

    const progressDx = lobster.position.x - locomotion.lastProgressX;
    const progressDz = lobster.position.z - locomotion.lastProgressZ;
    const progressDistance = Math.hypot(progressDx, progressDz);

    if (progressDistance >= MOVE_PROGRESS_EPSILON) {
      locomotion.stuckTime = 0;
      locomotion.lastProgressX = lobster.position.x;
      locomotion.lastProgressZ = lobster.position.z;
    } else if (locomotion.phase === 'thrust') {
      locomotion.stuckTime += dt;
      if (locomotion.stuckTime >= MOVE_STUCK_TIMEOUT) {
        return true;
      }
    }

    return false;
  }

  function updateJumpArc(lobster, dt) {
    const locomotion = lobster.locomotion;
    if (!locomotion.jumpActive) return;

    locomotion.jumpPhase += dt * 6.5;
    lobster.position.y = Math.max(0, Math.sin(locomotion.jumpPhase) * 1.1);
    if (locomotion.jumpPhase >= Math.PI) {
      locomotion.jumpActive = false;
      lobster.position.y = 0;
      locomotion.jumpPhase = 0;
    }
  }

  function startJumpIfNeeded(lobster) {
    const locomotion = lobster.locomotion;
    if (locomotion.jumpActive) return;
    locomotion.jumpActive = true;
    locomotion.jumpPhase = 0;
  }

  function processAction(lobster, action, dt) {
    lobster.state = action.type;

    if (!action.initialized) {
      if (action.type === 'move') {
        const target = action.payload.to || randomPlayablePoint();
        assignMoveTarget(lobster, target.x, target.z, 1.0);
      }

      if (action.type === 'patrol') {
        const target = action.payload.to || randomPlayablePoint();
        assignMoveTarget(lobster, target.x, target.z, 1.0);
      }

      if (action.type === 'retreat') {
        const target = findSafeMoveTarget(lobster.position.x, lobster.position.z, lobster.rotation + Math.PI);
        action.payload.to = target;
        assignMoveTarget(lobster, target.x, target.z, 1.1);
      }

      if (action.type === 'jump') {
        startJumpIfNeeded(lobster);
      }

      action.initialized = true;
    }

    action.ttl -= 1;

    if (action.type === 'idle') {
      lobster.stats.energy = Math.min(100, lobster.stats.energy + 0.3);
    }

    if (action.type === 'emote') {
      pointsFor(lobster.id, 2, 'emote');
      if (action.ttl % 4 === 0) pushEvent('emote', `${lobster.name} sent a reef emote.`);
    }

    if (action.type === 'jump') {
      pointsFor(lobster.id, 1, 'jumped');
      updateJumpArc(lobster, dt);
      if (!lobster.locomotion.jumpActive || action.ttl <= 0) {
        finishAction(lobster);
      }
      return;
    }

    lobster.position.y = 0;

    if (action.type === 'move') {
      const done = updateMoveLocomotion(lobster, dt);
      if (done) finishAction(lobster);
    }

    if (action.type === 'patrol') {
      const done = updateMoveLocomotion(lobster, dt);
      if (done) {
        const next = findSafeMoveTarget(lobster.position.x, lobster.position.z, lobster.rotation);
        assignMoveTarget(lobster, next.x, next.z, 1.0);
      }
      pointsFor(lobster.id, 1, 'patrol');
    }

    if (enabled(2) && (action.type === 'forage' || action.type === 'eat')) {
      const nearest = state.world.foods
        .map((food) => ({ food, d: distance2D(lobster.position, food) }))
        .sort((a, b) => a.d - b.d)[0];

      if (nearest) {
        ensureMoveTarget(lobster, nearest.food.x, nearest.food.z, 0.9);
        const done = updateMoveLocomotion(lobster, dt);
        if (nearest.d < 2.2 || done) {
          lobster.stats.hunger = Math.max(0, lobster.stats.hunger - nearest.food.energy * 0.7);
          lobster.stats.energy = Math.min(100, lobster.stats.energy + nearest.food.energy * 0.6);
          state.world.foods = state.world.foods.filter((food) => food.id !== nearest.food.id);
          pointsFor(lobster.id, 8, 'foraged food');
          pushEvent('food', `${lobster.name} consumed algae pellet (+energy).`);
          finishAction(lobster);
        }
      } else if (action.ttl <= 0) {
        finishAction(lobster);
      }
    }

    if (enabled(3) && action.type.startsWith('skill:')) {
      const skillName = action.type.split(':')[1] || 'scout';
      const skill = lobster.skills[skillName] || lobster.skills.scout;
      if (skill.cooldown <= 0) {
        skill.xp += 8 + Math.floor(rng() * 4);
        skill.cooldown = 14;
        if (skill.xp >= skill.level * 40) {
          skill.level += 1;
          skill.xp = 0;
          pointsFor(lobster.id, 15, `${skillName} leveled to ${skill.level}`);
          pushEvent('skill', `${lobster.name} leveled ${skillName} to ${skill.level}.`);
        } else {
          pointsFor(lobster.id, 3, `used ${skillName}`);
        }
      }
      if (action.ttl <= 0) finishAction(lobster);
    }

    if (enabled(5) && (action.type === 'attack' || action.type === 'defend' || action.type === 'retreat')) {
      const opponents = state.lobsters.filter((other) => other.id !== lobster.id);
      const target = opponents[Math.floor(rng() * opponents.length)];
      if (target) {
        lobster.combat.targetId = target.id;
        lobster.combat.mode = action.type;

        if (action.type === 'attack') {
          ensureMoveTarget(lobster, target.position.x, target.position.z, 0.9);
          updateMoveLocomotion(lobster, dt);
          if (distance2D(lobster.position, target.position) < 3.2) {
            const damage = 4 + Math.floor(rng() * 6);
            target.stats.hp = Math.max(0, target.stats.hp - damage);
            lobster.stats.stamina = Math.max(0, lobster.stats.stamina - 3);
            pointsFor(lobster.id, 6, `hit ${target.name}`);
            if (target.stats.hp <= 0) {
              lobster.stats.wins += 1;
              target.stats.defeats += 1;
              target.stats.hp = 70;
              pointsFor(lobster.id, 25, 'combat win');
              pushEvent('combat', `${lobster.name} won a duel vs ${target.name}.`);
              finishAction(lobster);
            }
          }
        }

        if (action.type === 'defend') {
          lobster.stats.stamina = Math.min(100, lobster.stats.stamina + 2);
          lobster.stats.energy = Math.min(100, lobster.stats.energy + 1);
          pointsFor(lobster.id, 2, 'defensive stance');
        }

        if (action.type === 'retreat') {
          const done = updateMoveLocomotion(lobster, dt);
          pointsFor(lobster.id, 1, 'retreated');
          if (done) finishAction(lobster);
        }
      }

      if (action.ttl <= 0) finishAction(lobster);
    }

    if (enabled(7) && action.type === 'rescue') {
      const target = state.world.rescues.find((entry) => !entry.rescuedBy);
      if (target) {
        ensureMoveTarget(lobster, target.x, target.z, 0.9);
        const done = updateMoveLocomotion(lobster, dt);
        if (distance2D(lobster.position, target) < 2.2 || done) {
          target.rescuedBy = lobster.id;
          lobster.stats.rescued += 1;
          pointsFor(lobster.id, 35, 'rescue completed');
          pushEvent('rescue', `${lobster.name} completed a rescue beacon.`);
          finishAction(lobster);
        }
      } else if (action.ttl <= 0) {
        finishAction(lobster);
      }
    }

    if (action.ttl <= 0 && lobster.actionQueue[0]?.id === action.id) {
      finishAction(lobster);
    }
  }

  function resolveLobsterCollisions() {
    for (let i = 0; i < state.lobsters.length; i += 1) {
      const a = state.lobsters[i];
      for (let j = i + 1; j < state.lobsters.length; j += 1) {
        const b = state.lobsters[j];
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const minDistance = LOBSTER_COLLISION_RADIUS * 2;
        const distSq = (dx * dx) + (dz * dz);

        if (distSq >= minDistance * minDistance) continue;

        const dist = Math.max(Math.sqrt(distSq), 0.0001);
        const overlap = ((minDistance - dist) * 0.5) + COLLISION_PUSH_BUFFER;
        const nx = dx / dist;
        const nz = dz / dist;

        a.position.x -= nx * overlap;
        a.position.z -= nz * overlap;
        b.position.x += nx * overlap;
        b.position.z += nz * overlap;

        clampPlayable(a.position);
        clampPlayable(b.position);
      }
    }
  }

  function backgroundBehaviors(lobster) {
    if (lobster.actionQueue.length > 0) return;

    if (enabled(7) && state.world.rescues.some((entry) => !entry.rescuedBy)) {
      queueAction(lobster, 'rescue', { ttl: 24 });
      return;
    }

    if (enabled(2) && lobster.stats.hunger > 62 && state.world.foods.length > 0) {
      queueAction(lobster, 'forage', { ttl: 20 });
      return;
    }

    if (enabled(5) && rng() > 0.66) {
      const choices = ['attack', 'defend', 'retreat'];
      queueAction(lobster, choices[Math.floor(rng() * choices.length)], { ttl: 12 });
      return;
    }

    if (enabled(3) && rng() > 0.6) {
      const pool = ['skill:scout', 'skill:forage', 'skill:shellGuard'];
      queueAction(lobster, pool[Math.floor(rng() * pool.length)], { ttl: 8 });
      return;
    }

    const genericPool = ['move', 'idle', 'emote', 'jump', 'patrol'];
    const selected = genericPool[Math.floor(rng() * genericPool.length)];
    queueAction(lobster, selected, {
      to: randomPlayablePoint(),
      ttl: 14
    });
  }

  function tickStats(lobster, dt) {
    lobster.stats.survivalSeconds += dt;

    if (enabled(2)) {
      lobster.stats.hunger = clamp(lobster.stats.hunger + dt * 1.5, 0, 100);
      lobster.stats.energy = clamp(lobster.stats.energy - dt * 0.7 - lobster.stats.hunger * 0.002, 0, 100);
      if (lobster.stats.hunger > 88) {
        lobster.stats.hp = clamp(lobster.stats.hp - dt * 2.2, 0, 100);
      }
      if (lobster.stats.hp <= 0) {
        lobster.stats.hp = 65;
        lobster.stats.hunger = 58;
        pointsFor(lobster.id, -10, 'starvation penalty');
        pushEvent('hunger', `${lobster.name} starved and recovered at low vitality.`);
      }
    }

    if (enabled(4)) {
      lobster.stats.visibility = state.world.dayPhase === 'night' ? 0.55 : state.world.dayPhase === 'dusk' ? 0.75 : 1;
      if (state.world.dayPhase === 'night') {
        lobster.stats.energy = clamp(lobster.stats.energy - dt * 0.2, 0, 100);
      } else {
        lobster.stats.energy = clamp(lobster.stats.energy + dt * 0.08, 0, 100);
      }
    }

    if (enabled(3)) {
      Object.values(lobster.skills).forEach((skill) => {
        skill.cooldown = Math.max(0, skill.cooldown - dt * 2.6);
      });
    }
  }

  function tickHazards(lobster, dt) {
    if (!enabled(6)) return;
    let exposure = 0;
    state.world.hazards.forEach((hazard) => {
      const d = distance2D(lobster.position, hazard);
      if (d <= hazard.radius) {
        exposure += 1;
        if (hazard.type === 'blizzard') {
          lobster.position.x = clamp(
            lobster.position.x + ((rng() - 0.5) * 1.6),
            MAP_EDGE_BUFFER,
            width - MAP_EDGE_BUFFER
          );
          lobster.position.z = clamp(
            lobster.position.z + ((rng() - 0.5) * 1.6),
            MAP_EDGE_BUFFER,
            height - MAP_EDGE_BUFFER
          );
          lobster.stats.energy = clamp(lobster.stats.energy - dt * 1.8, 0, 100);
          lobster.stats.stamina = clamp(lobster.stats.stamina - dt * 0.8, 0, 100);
        }
        if (hazard.type === 'fire') {
          lobster.stats.hp = clamp(lobster.stats.hp - dt * 2.4, 0, 100);
        }
        if (hazard.type === 'thunder') {
          const pulse = ((state.world.tick + Math.floor(hazard.x + hazard.z)) % 18) === 0;
          if (pulse) {
            lobster.stats.hp = clamp(lobster.stats.hp - 6, 0, 100);
            lobster.stats.stamina = clamp(lobster.stats.stamina - 8, 0, 100);
            lobster.position.x = clamp(
              lobster.position.x + ((rng() - 0.5) * 4),
              MAP_EDGE_BUFFER,
              width - MAP_EDGE_BUFFER
            );
            lobster.position.z = clamp(
              lobster.position.z + ((rng() - 0.5) * 4),
              MAP_EDGE_BUFFER,
              height - MAP_EDGE_BUFFER
            );
          }
        }
        if (hazard.type === 'tornado') {
          const dx = lobster.position.x - hazard.x;
          const dz = lobster.position.z - hazard.z;
          const swirl = Math.max(0.2, Math.hypot(dx, dz));
          lobster.position.x = clamp(
            lobster.position.x + ((-dz / swirl) * dt * 8),
            MAP_EDGE_BUFFER,
            width - MAP_EDGE_BUFFER
          );
          lobster.position.z = clamp(
            lobster.position.z + ((dx / swirl) * dt * 8),
            MAP_EDGE_BUFFER,
            height - MAP_EDGE_BUFFER
          );
          lobster.stats.energy = clamp(lobster.stats.energy - dt * 1.2, 0, 100);
          lobster.stats.stamina = clamp(lobster.stats.stamina - dt * 1.6, 0, 100);
        }
      }
    });

    lobster.stats.hazardExposure = clamp(lobster.stats.hazardExposure + exposure * dt, 0, 9999);
    if (exposure > 0) pointsFor(lobster.id, -1, 'hazard exposure');
  }

  function tickRescueCases() {
    if (!enabled(7)) return;
    state.world.rescues.forEach((entry) => {
      if (!entry.rescuedBy) entry.ttl -= 1;
      if (entry.ttl <= 0 && !entry.rescuedBy) {
        const point = randomPlayablePoint();
        entry.ttl = 320;
        entry.x = point.x;
        entry.z = point.z;
        pushEvent('rescue', 'Distress beacon relocated after timeout.');
      }
    });
  }

  function updateTime(dt) {
    if (!enabled(4)) return;
    state.world.timeHours += dt * 1.35;
    while (state.world.timeHours >= 24) {
      state.world.timeHours -= 24;
      state.world.day += 1;
      pushEvent('day', `A new simulated day has started (Day ${state.world.day}).`);
    }
    state.world.dayPhase = phaseFromHour(state.world.timeHours);
  }

  function rebuildLeaderboard() {
    if (!enabled(8)) return;
    const rows = state.lobsters.map((lobster) => {
      const points = state.scoreboard.points[lobster.id] || 0;
      const bpm = lobster.stats.actions > 0
        ? ((lobster.stats.actions / Math.max(1, state.world.tick / 60)) * 60).toFixed(1)
        : '0.0';
      return {
        id: lobster.id,
        name: lobster.name,
        points,
        rescues: lobster.stats.rescued,
        wins: lobster.stats.wins,
        survivalSeconds: Math.floor(lobster.stats.survivalSeconds),
        actionsPerMin: Number(bpm)
      };
    }).sort((a, b) => b.points - a.points);

    state.scoreboard.leaderboard = rows;
  }

  function stepSimulation(dt = 1 / 12) {
    state.world.tick += 1;
    state.world.elapsedSeconds += dt;
    updateTime(dt);

    if (enabled(2) && state.world.tick % 40 === 0) {
      spawnFood(2 + Math.floor(rng() * 3));
    }

    ensureHazards();
    ensureRescueCases();

    state.lobsters.forEach((lobster) => {
      backgroundBehaviors(lobster);
      const current = lobster.actionQueue[0];
      if (current) {
        processAction(lobster, current, dt);
      } else {
        lobster.state = 'idle';
        lobster.position.y = 0;
      }
      tickStats(lobster, dt);
      tickHazards(lobster, dt);
    });

    resolveLobsterCollisions();
    tickRescueCases();
    rebuildLeaderboard();
    notify();
  }

  function dispatchAction(lobsterId, actionType, payload = {}) {
    const lobster = state.lobsters.find((entry) => entry.id === lobsterId);
    if (!lobster) return false;
    queueAction(lobster, actionType, payload);
    pushEvent('manual', `Manual action ${actionType} queued for ${lobster.name}.`);
    notify();
    return true;
  }

  function getSnapshot() {
    return deepClone({
      world: state.world,
      lobsters: state.lobsters,
      events: state.events,
      scoreboard: state.scoreboard
    });
  }

  function subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  bootstrapBehavior();
  spawnFood(8);
  ensureHazards();
  ensureRescueCases();
  notify();

  return {
    createSimulation,
    stepSimulation,
    dispatchAction,
    getSnapshot,
    subscribe
  };
}
