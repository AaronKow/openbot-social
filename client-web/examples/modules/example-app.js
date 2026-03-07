import { installNetworkGuard } from './network-guard.js';
import { createSimulation } from './simulation-core.js';
import {
  localSeed,
  saveLocalSeed,
  clearModuleState,
  saveSnapshot,
  getSnapshot
} from './storage.js';
import { renderShell, renderSnapshot } from './ui-shell.js';
import { Example3DWorld } from './world-3d.js';

const MODULE_ORDER = [
  '1_actions',
  '2_hunger_system',
  '3_skills',
  '4_day_and_night',
  '5_combat',
  '6_hazards',
  '7_rescue',
  '8_leaderboard'
];

const MODULE_META = {
  '1_actions': {
    title: 'Example 1: Actions Playground',
    subtitle: 'Movement/action queue baseline for lobster behavior in 3D world.',
    note: 'Production mapping: maps directly to server action queue + animation state updates in client rendering.'
  },
  '2_hunger_system': {
    title: 'Example 2: Hunger System',
    subtitle: 'Food loops, hunger decay, and starvation penalties in same 3D world.',
    note: 'Production mapping: migrate hunger/energy metrics into entity profile state and observer HUD summaries.'
  },
  '3_skills': {
    title: 'Example 3: Skills',
    subtitle: 'Skill leveling with cooldown and XP progression in 3D simulation.',
    note: 'Production mapping: skill snapshots can extend entity wiki and heartbeat-driven behavior selection.'
  },
  '4_day_and_night': {
    title: 'Example 4: Day and Night',
    subtitle: 'World clock, phase changes, and lighting shifts in 3D environment.',
    note: 'Production mapping: aligns with world clock labels and time-based behavior weighting in live simulation.'
  },
  '5_combat': {
    title: 'Example 5: Combat',
    subtitle: 'Attack/defend/retreat loop with HP/stamina balancing in 3D.',
    note: 'Production mapping: combat actions become explicit server action types with anti-spam limits and event summaries.'
  },
  '6_hazards': {
    title: 'Example 6: Hazards',
    subtitle: 'Currents, toxic zones, and predator routes visualized in 3D.',
    note: 'Production mapping: hazard objects map to world objects and per-tick environment effects in runtime queues.'
  },
  '7_rescue': {
    title: 'Example 7: Rescue',
    subtitle: 'Distress beacons and cooperative save objectives inside the 3D world.',
    note: 'Production mapping: rescue tasks can be introduced as world events and tracked in reflection summaries.'
  },
  '8_leaderboard': {
    title: 'Example 8: Leaderboard',
    subtitle: 'Local-only ranking dashboard fed by ongoing 3D simulation.',
    note: 'Production mapping: leaderboard metrics can roll into daily summaries and public lobster directory stats.'
  }
};

function nextHref(moduleId) {
  const idx = MODULE_ORDER.indexOf(moduleId);
  if (idx === -1 || idx === MODULE_ORDER.length - 1) return '';
  return `./${MODULE_ORDER[idx + 1]}.html`;
}

export function initExample(moduleId) {
  installNetworkGuard();

  const root = document.getElementById('app');
  const meta = MODULE_META[moduleId];
  if (!root || !meta) throw new Error(`Unknown module page: ${moduleId}`);

  const ui = renderShell({
    root,
    title: meta.title,
    subtitle: meta.subtitle,
    moduleId,
    nextHref: nextHref(moduleId),
    mappingNote: meta.note
  });

  const world3d = new Example3DWorld(ui.worldMount);

  const seedInput = document.getElementById('seed-input');
  const saveSeedBtn = document.getElementById('save-seed');
  const resetLocalBtn = document.getElementById('reset-local');
  const pauseToggleBtn = document.getElementById('pause-toggle');
  const fullscreenToggleBtn = ui.fullscreenToggleBtn;
  const speedSelect = ui.speedSelect;

  let seed = localSeed(moduleId);
  seedInput.value = seed;

  const simulation = createSimulation({ seed, moduleId });
  let paused = false;
  let speedMultiplier = 1;
  let accumulator = 0;
  const fixedStep = 1 / 12;
  let lastFrameMs = performance.now();
  let latest = simulation.getSnapshot();

  const restored = getSnapshot(moduleId);
  if (restored && restored.world && typeof restored.world.tick === 'number' && restored.world.seed === seed) {
    const maxReplayTicks = Math.min(restored.world.tick, 1800);
    for (let i = 0; i < maxReplayTicks; i += 1) {
      simulation.stepSimulation(1 / 12);
    }
    latest = simulation.getSnapshot();
  }

  function pickLobster() {
    return latest.lobsters[0]?.id || 'lobster-1';
  }

  function frame(nowMs = performance.now()) {
    const frameDeltaSec = Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;

    if (!paused) {
      accumulator += frameDeltaSec * speedMultiplier;
      let stepped = false;
      while (accumulator >= fixedStep) {
        simulation.stepSimulation(fixedStep);
        accumulator -= fixedStep;
        stepped = true;
      }
      if (stepped) {
        latest = simulation.getSnapshot();
        if (latest.world.tick % 25 === 0) {
          saveSnapshot(moduleId, { world: { tick: latest.world.tick, seed } });
        }
      }
    }

    world3d.update(latest);
    world3d.render();
    renderSnapshot(ui, latest);

    requestAnimationFrame(frame);
  }

  simulation.subscribe((snapshot) => {
    latest = snapshot;
  });

  ui.controls.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    simulation.dispatchAction(pickLobster(), action, {
      to: {
        x: Math.round(Math.random() * 94 + 3),
        z: Math.round(Math.random() * 94 + 3)
      }
    });
  });

  saveSeedBtn.addEventListener('click', () => {
    seed = (seedInput.value || '').trim() || `${moduleId}-seed-default`;
    saveLocalSeed(moduleId, seed);
    window.location.reload();
  });

  resetLocalBtn.addEventListener('click', () => {
    clearModuleState(moduleId);
    seedInput.value = `${moduleId}-seed-default`;
    window.location.reload();
  });

  pauseToggleBtn.addEventListener('click', () => {
    paused = !paused;
    pauseToggleBtn.textContent = paused ? 'Resume' : 'Pause';
    lastFrameMs = performance.now();
  });

  if (speedSelect) {
    speedSelect.addEventListener('change', () => {
      const next = Number(speedSelect.value);
      speedMultiplier = Number.isFinite(next) && next > 0 ? next : 1;
    });
  }

  const fullscreenTarget = ui.worldStage || ui.worldMount;

  function isFullscreenActive() {
    return document.fullscreenElement === fullscreenTarget;
  }

  function updateFullscreenLabel() {
    if (!fullscreenToggleBtn) return;
    fullscreenToggleBtn.textContent = isFullscreenActive() ? 'Exit Fullscreen' : 'Fullscreen World';
  }

  if (fullscreenToggleBtn) {
    fullscreenToggleBtn.addEventListener('click', async () => {
      try {
        if (!isFullscreenActive()) {
          await fullscreenTarget.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (error) {
        console.warn('Fullscreen request failed:', error);
      } finally {
        requestAnimationFrame(() => world3d.resize());
        updateFullscreenLabel();
      }
    });
  }

  document.addEventListener('fullscreenchange', () => {
    requestAnimationFrame(() => world3d.resize());
    setTimeout(() => world3d.resize(), 50);
    setTimeout(() => world3d.resize(), 120);
    setTimeout(() => world3d.resize(), 240);
    updateFullscreenLabel();
  });

  updateFullscreenLabel();

  frame();

  window.addEventListener('beforeunload', () => {
    world3d.dispose();
  });
}
