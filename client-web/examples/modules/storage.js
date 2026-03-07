const STORAGE_PREFIX = 'openbot.examples.';

export function getLocalValue(key, fallback = null) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

export function setLocalValue(key, value) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
  } catch (_) {
    // no-op for private mode/quota issues
  }
}

export function clearLocalValue(key) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
  } catch (_) {
    // no-op
  }
}

export function localSeed(moduleId) {
  return getLocalValue(`${moduleId}.seed`, `${moduleId}-seed-default`);
}

export function saveLocalSeed(moduleId, seed) {
  setLocalValue(`${moduleId}.seed`, seed);
}

export function clearModuleState(moduleId) {
  clearLocalValue(`${moduleId}.seed`);
  clearLocalValue(`${moduleId}.snapshot`);
}

export function saveSnapshot(moduleId, snapshot) {
  setLocalValue(`${moduleId}.snapshot`, snapshot);
}

export function getSnapshot(moduleId) {
  return getLocalValue(`${moduleId}.snapshot`, null);
}
