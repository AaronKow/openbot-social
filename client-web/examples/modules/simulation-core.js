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
        sleeping: false,
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
          energy: 72 - i * 3,
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
          lastHitTick: 0,
          swingUntil: 0,
          dodgeUntil: 0,
          tookHitUntil: 0,
          lastAttackerId: null
        },
        statusEffects: {
          burning: 0,
          frozen: 0,
          electrocuted: 0,
          paralyzed: 0,
          tornadoSpin: 0,
          burnTick: 0,
          shockTick: 0,
          freezeTick: 0,
          tornadoCenterX: x,
          tornadoCenterZ: z,
          tornadoThrowReady: false
        },
        damageMarkers: []
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

  function markDamage(lobster, amount, type) {
    lobster.damageMarkers.push({
      id: `dmg-${state.world.tick}-${Math.floor(rng() * 1e6)}`,
      amount: Number(amount) || 0,
      type: String(type || 'impact'),
      at: state.world.elapsedSeconds
    });
    if (lobster.damageMarkers.length > 24) {
      lobster.damageMarkers = lobster.damageMarkers.slice(-24);
    }
  }

  function applyHazardEffect(lobster, key, durationSec) {
    lobster.statusEffects[key] = Math.max(lobster.statusEffects[key] || 0, durationSec);
  }

  function drainEnergy(lobster, amount, markerType = null, markerThreshold = 0.25) {
    const before = lobster.stats.energy;
    lobster.stats.energy = clamp(before - Math.max(0, amount), 0, 100);
    const lost = before - lobster.stats.energy;
    if (markerType && lost >= markerThreshold) {
      markDamage(lobster, lost, markerType);
    }
    return lost;
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
    state.world.hazards.forEach((hazard) => {
      const baseSpeed = 0.12 + (rng() * 0.16);
      const theta = rng() * Math.PI * 2;
      hazard.vx = Math.cos(theta) * baseSpeed;
      hazard.vz = Math.sin(theta) * baseSpeed;
      hazard.turnIn = 18 + Math.floor(rng() * 36);
    });
  }

  function tickHazardMovement() {
    if (!enabled(6)) return;
    state.world.hazards.forEach((hazard) => {
      const minX = MAP_EDGE_BUFFER + hazard.radius + 0.5;
      const maxX = width - MAP_EDGE_BUFFER - hazard.radius - 0.5;
      const minZ = MAP_EDGE_BUFFER + hazard.radius + 0.5;
      const maxZ = height - MAP_EDGE_BUFFER - hazard.radius - 0.5;

      hazard.x += hazard.vx;
      hazard.z += hazard.vz;

      if (hazard.x <= minX || hazard.x >= maxX) {
        hazard.vx *= -1;
        hazard.x = clamp(hazard.x, minX, maxX);
      }
      if (hazard.z <= minZ || hazard.z >= maxZ) {
        hazard.vz *= -1;
        hazard.z = clamp(hazard.z, minZ, maxZ);
      }

      hazard.turnIn -= 1;
      if (hazard.turnIn <= 0) {
        const speed = Math.max(0.08, Math.hypot(hazard.vx, hazard.vz));
        const angle = Math.atan2(hazard.vz, hazard.vx) + ((rng() - 0.5) * 1.8);
        const speedJitter = clamp(speed + (((rng() - 0.5) * 0.22) - 0.01), 0.08, 0.34);
        hazard.vx = Math.cos(angle) * speedJitter;
        hazard.vz = Math.sin(angle) * speedJitter;
        hazard.turnIn = 14 + Math.floor(rng() * 30);
      }
    });
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

  function queuePriorityAction(lobster, actionType, payload = {}) {
    const first = lobster.actionQueue[0];
    if (first && first.type === actionType) return;
    lobster.actionQueue.unshift({
      id: `a-priority-${state.world.tick}-${Math.floor(rng() * 1e6)}`,
      type: actionType,
      payload,
      ttl: payload.ttl || 10,
      initialized: false
    });
    lobster.stats.actions += 1;
    pointsFor(lobster.id, 1, `priority ${actionType}`);
  }

  function findClosestOpponent(lobster) {
    let chosen = null;
    let bestDistance = Infinity;
    state.lobsters.forEach((other) => {
      if (other.id === lobster.id || other.sleeping) return;
      const d = distance2D(lobster.position, other.position);
      if (d < bestDistance) {
        bestDistance = d;
        chosen = other;
      }
    });
    return chosen;
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
    const frozenFactor = lobster.statusEffects.frozen > 0 ? 0.42 : 1;
    const burntFactor = lobster.statusEffects.burning > 0 ? 0.88 : 1;
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
      const moveStep = Math.min(distance, lobster.speed * speedFactor * frozenFactor * burntFactor * dt);
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
        const planned = action.payload.to;
        const target = planned && Number.isFinite(planned.x) && Number.isFinite(planned.z)
          ? planned
          : findSafeMoveTarget(lobster.position.x, lobster.position.z, lobster.rotation + Math.PI);
        action.payload.to = target;
        assignMoveTarget(lobster, target.x, target.z, 1.1);
      }

      if (action.type === 'jump') {
        startJumpIfNeeded(lobster);
      }

      action.initialized = true;
    }

    if (lobster.statusEffects.paralyzed > 0) {
      action.ttl -= 1;
      lobster.state = 'paralyzed';
      lobster.position.y = Math.max(lobster.position.y, 0.08 + (Math.abs(Math.sin(state.world.elapsedSeconds * 22)) * 0.24));
      drainEnergy(lobster, dt * 0.42);
      if (action.ttl <= 0 && lobster.actionQueue[0]?.id === action.id) finishAction(lobster);
      return;
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
          lobster.stats.energy = Math.min(100, lobster.stats.energy + nearest.food.energy * 0.95);
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
      const target = findClosestOpponent(lobster);
      if (target) {
        lobster.combat.targetId = target.id;
        lobster.combat.mode = action.type;

        if (action.type === 'attack') {
          ensureMoveTarget(lobster, target.position.x, target.position.z, 0.9);
          updateMoveLocomotion(lobster, dt);
          const closeEnough = distance2D(lobster.position, target.position) < 3.6;
          const hitCooldownReady = (state.world.tick - lobster.combat.lastHitTick) >= 8;
          if (closeEnough && hitCooldownReady) {
            lobster.combat.swingUntil = 0.42;
            lobster.combat.lastHitTick = state.world.tick;

            const dodgeChance = target.stats.energy > 42 ? 0.62 : 0.36;
            if (rng() < dodgeChance) {
              const awayYaw = Math.atan2(
                target.position.z - lobster.position.z,
                target.position.x - lobster.position.x
              );
              const escapeTarget = findSafeMoveTarget(target.position.x, target.position.z, awayYaw);
              target.combat.mode = 'evading';
              target.combat.dodgeUntil = 1.0;
              target.combat.lastAttackerId = lobster.id;
              queuePriorityAction(target, 'retreat', { ttl: 10, to: escapeTarget, fromCombat: true });
              drainEnergy(target, 0.9, 'evade', 0.5);
              pointsFor(target.id, 4, `dodged ${lobster.name}`);
              pointsFor(lobster.id, 2, `forced retreat ${target.name}`);
              pushEvent('combat', `${target.name} dodged ${lobster.name}'s hammer swing and ran.`);
            } else {
              const damage = 8 + Math.floor(rng() * 7);
              const pushDx = target.position.x - lobster.position.x;
              const pushDz = target.position.z - lobster.position.z;
              const pushMag = Math.max(0.001, Math.hypot(pushDx, pushDz));
              const knockback = 2.8 + (rng() * 1.7);
              target.position.x = clamp(
                target.position.x + ((pushDx / pushMag) * knockback),
                MAP_EDGE_BUFFER,
                width - MAP_EDGE_BUFFER
              );
              target.position.z = clamp(
                target.position.z + ((pushDz / pushMag) * knockback),
                MAP_EDGE_BUFFER,
                height - MAP_EDGE_BUFFER
              );
              target.position.y = Math.max(target.position.y, 1.05);
              drainEnergy(target, damage, 'hammer', 0.1);
              target.combat.tookHitUntil = 0.52;
              target.combat.lastAttackerId = lobster.id;
              drainEnergy(lobster, 2.2);
              pointsFor(lobster.id, 8, `hammer hit ${target.name}`);
              pushEvent('combat', `${lobster.name} hit ${target.name} with a hammer (${damage} dmg).`);
            }

            drainEnergy(lobster, 3);
            if (target.stats.energy <= 0) {
              lobster.stats.wins += 1;
              target.stats.defeats += 1;
              target.stats.energy = 55;
              target.combat.tookHitUntil = 0.6;
              pointsFor(lobster.id, 25, 'combat win');
              pushEvent('combat', `${lobster.name} won a duel vs ${target.name}.`);
              finishAction(lobster);
            }
          }
        }

        if (action.type === 'defend') {
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
    if (lobster.sleeping) return;
    if (lobster.actionQueue.length > 0) return;

    if (enabled(7) && state.world.rescues.some((entry) => !entry.rescuedBy)) {
      queueAction(lobster, 'rescue', { ttl: 24 });
      return;
    }

    if (enabled(2) && lobster.stats.energy < 58 && state.world.foods.length > 0) {
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

    if (lobster.sleeping) {
      lobster.state = 'sleeping';
      lobster.position.y = 0;
      lobster.stats.energy = clamp(lobster.stats.energy + (dt * 8.6), 0, 100);
      if (lobster.stats.energy >= 72) {
        lobster.sleeping = false;
        lobster.state = 'idle';
        pushEvent('energy', `${lobster.name} woke up after recharging energy.`);
      }
    } else if (enabled(2)) {
      lobster.stats.energy = clamp(lobster.stats.energy - (dt * 0.72), 0, 100);
      if (lobster.stats.energy <= 0.01) {
        lobster.stats.energy = 0;
        lobster.sleeping = true;
        lobster.state = 'sleeping';
        lobster.actionQueue = [];
        lobster.locomotion.phase = 'idle';
        lobster.position.y = 0;
        pointsFor(lobster.id, -10, 'energy collapse');
        pushEvent('energy', `${lobster.name} ran out of energy and fell asleep.`);
      }
    }

    if (enabled(4)) {
      lobster.stats.visibility = state.world.dayPhase === 'night' ? 0.55 : state.world.dayPhase === 'dusk' ? 0.75 : 1;
      if (!lobster.sleeping && state.world.dayPhase === 'night') {
        lobster.stats.energy = clamp(lobster.stats.energy - dt * 0.2, 0, 100);
      } else if (!lobster.sleeping) {
        lobster.stats.energy = clamp(lobster.stats.energy + dt * 0.08, 0, 100);
      }
    }

    if (enabled(3)) {
      Object.values(lobster.skills).forEach((skill) => {
        skill.cooldown = Math.max(0, skill.cooldown - dt * 2.6);
      });
    }

    lobster.combat.swingUntil = Math.max(0, lobster.combat.swingUntil - dt);
    lobster.combat.dodgeUntil = Math.max(0, lobster.combat.dodgeUntil - dt);
    lobster.combat.tookHitUntil = Math.max(0, lobster.combat.tookHitUntil - dt);
    if (lobster.combat.dodgeUntil <= 0 && lobster.combat.mode === 'evading') {
      lobster.combat.mode = 'neutral';
    }
  }

  function tickHazards(lobster, dt) {
    if (!enabled(6)) return;
    let touchedHazard = false;
    let exposure = 0;
    state.world.hazards.forEach((hazard) => {
      const d = distance2D(lobster.position, hazard);
      if (d <= hazard.radius) {
        touchedHazard = true;
        const zoneRatio = 1 - (d / Math.max(0.001, hazard.radius)); // 0 at edge, 1 at center
        const zonePower = 0.75 + (zoneRatio * 0.65); // keeps high baseline impact across hazard circle
        exposure += 1;
        if (hazard.type === 'blizzard') {
          lobster.position.x = clamp(
            lobster.position.x + ((rng() - 0.5) * 2.4 * zonePower),
            MAP_EDGE_BUFFER,
            width - MAP_EDGE_BUFFER
          );
          lobster.position.z = clamp(
            lobster.position.z + ((rng() - 0.5) * 2.4 * zonePower),
            MAP_EDGE_BUFFER,
            height - MAP_EDGE_BUFFER
          );
          const blizzardDrain = (dt * 2.6 * zonePower) + (dt * 1.4 * zonePower);
          drainEnergy(lobster, blizzardDrain, 'blizzard', 0.35);
          applyHazardEffect(lobster, 'frozen', 2.6 + zonePower);
        }
        if (hazard.type === 'fire') {
          const fireDamage = dt * 3.8 * zonePower;
          drainEnergy(lobster, fireDamage, 'fire', 0.2);
          applyHazardEffect(lobster, 'burning', 3.6 + zonePower);
        }
        if (hazard.type === 'thunder') {
          const pulse = ((state.world.tick + Math.floor(hazard.x + hazard.z)) % 12) === 0;
          if (pulse) {
            const shockDamage = 7 + (5 * zonePower);
            const thunderDrain = shockDamage + (8 + (6 * zonePower));
            drainEnergy(lobster, thunderDrain, 'thunder', 0.2);
            lobster.position.x = clamp(
              lobster.position.x + ((rng() - 0.5) * (5.8 * zonePower)),
              MAP_EDGE_BUFFER,
              width - MAP_EDGE_BUFFER
            );
            lobster.position.z = clamp(
              lobster.position.z + ((rng() - 0.5) * (5.8 * zonePower)),
              MAP_EDGE_BUFFER,
              height - MAP_EDGE_BUFFER
            );
            applyHazardEffect(lobster, 'electrocuted', 2.4 + (zonePower * 0.6));
            applyHazardEffect(lobster, 'paralyzed', 0.85 + (zonePower * 0.45));
          }
        }
        if (hazard.type === 'tornado') {
          const dx = lobster.position.x - hazard.x;
          const dz = lobster.position.z - hazard.z;
          const swirl = Math.max(0.2, Math.hypot(dx, dz));
          lobster.position.x = clamp(
            lobster.position.x + ((-dz / swirl) * dt * 10.5 * zonePower),
            MAP_EDGE_BUFFER,
            width - MAP_EDGE_BUFFER
          );
          lobster.position.z = clamp(
            lobster.position.z + ((dx / swirl) * dt * 10.5 * zonePower),
            MAP_EDGE_BUFFER,
            height - MAP_EDGE_BUFFER
          );
          lobster.position.y = Math.max(lobster.position.y, 0.35 + (zonePower * 0.9));
          drainEnergy(lobster, (dt * 2.2 * zonePower) + (dt * 2.7 * zonePower), 'tornado', 0.55);
          lobster.statusEffects.tornadoCenterX = hazard.x;
          lobster.statusEffects.tornadoCenterZ = hazard.z;
          lobster.statusEffects.tornadoThrowReady = true;
          applyHazardEffect(lobster, 'tornadoSpin', 1.8 + zonePower);
        }
      }
    });

    lobster.stats.hazardExposure = clamp(lobster.stats.hazardExposure + exposure * dt, 0, 9999);
    if (exposure > 0) pointsFor(lobster.id, -1, 'hazard exposure');
    if (touchedHazard && lobster.sleeping) {
      lobster.sleeping = false;
      lobster.state = 'idle';
      lobster.locomotion.phase = 'idle';
      pushEvent('energy', `${lobster.name} was jolted awake by hazard contact.`);
    }
  }

  function tickStatusEffects(lobster, dt) {
    const fx = lobster.statusEffects;
    fx.burning = Math.max(0, fx.burning - dt);
    fx.frozen = Math.max(0, fx.frozen - dt);
    fx.electrocuted = Math.max(0, fx.electrocuted - dt);
    fx.paralyzed = Math.max(0, fx.paralyzed - dt);
    fx.tornadoSpin = Math.max(0, fx.tornadoSpin - dt);

    fx.burnTick -= dt;
    fx.shockTick -= dt;
    fx.freezeTick -= dt;

    if (fx.burning > 0 && fx.burnTick <= 0) {
      const burnDamage = 1.8 + (rng() * 1.8);
      drainEnergy(lobster, burnDamage + 0.9, 'burn', 0.2);
      fx.burnTick = 0.42;
    }

    if (fx.electrocuted > 0 && fx.shockTick <= 0) {
      const shockDamage = 1.6 + (rng() * 2.4);
      drainEnergy(lobster, shockDamage + (1.4 + rng() * 1.6), 'shock', 0.2);
      lobster.position.x = clamp(lobster.position.x + ((rng() - 0.5) * 1.2), MAP_EDGE_BUFFER, width - MAP_EDGE_BUFFER);
      lobster.position.z = clamp(lobster.position.z + ((rng() - 0.5) * 1.2), MAP_EDGE_BUFFER, height - MAP_EDGE_BUFFER);
      fx.shockTick = 0.32;
    }

    if (fx.frozen > 0 && fx.freezeTick <= 0) {
      drainEnergy(lobster, (0.8 + rng() * 0.8) + (0.7 + rng() * 0.7), 'blizzard', 0.2);
      fx.freezeTick = 0.55;
    }

    if (fx.tornadoSpin > 0) {
      lobster.position.y = Math.max(lobster.position.y, 0.5 + (Math.abs(Math.sin(state.world.elapsedSeconds * 8.2)) * 1.2));
    } else if (fx.tornadoThrowReady) {
      let vx = lobster.position.x - fx.tornadoCenterX;
      let vz = lobster.position.z - fx.tornadoCenterZ;
      const mag = Math.hypot(vx, vz) || 1;
      vx /= mag;
      vz /= mag;
      const throwDistance = 7 + (rng() * 7);
      lobster.position.x = clamp(lobster.position.x + (vx * throwDistance), MAP_EDGE_BUFFER, width - MAP_EDGE_BUFFER);
      lobster.position.z = clamp(lobster.position.z + (vz * throwDistance), MAP_EDGE_BUFFER, height - MAP_EDGE_BUFFER);
      lobster.position.y = Math.max(lobster.position.y, 0.9);
      const throwDamage = 5 + (rng() * 4);
      drainEnergy(lobster, throwDamage, 'tornado', 0.2);
      fx.tornadoThrowReady = false;
    }

    lobster.damageMarkers = lobster.damageMarkers.filter((entry) => (state.world.elapsedSeconds - entry.at) <= 2.2);
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
    tickHazardMovement();

    state.lobsters.forEach((lobster) => {
      if (!lobster.sleeping) {
        backgroundBehaviors(lobster);
        const current = lobster.actionQueue[0];
        if (current) {
          processAction(lobster, current, dt);
        } else {
          lobster.state = 'idle';
          lobster.position.y = 0;
        }
      } else {
        lobster.state = 'sleeping';
        lobster.position.y = 0;
      }
      tickStats(lobster, dt);
      tickHazards(lobster, dt);
      tickStatusEffects(lobster, dt);
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
