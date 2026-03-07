const FORBIDDEN_PATTERNS = [
  /(^|\/)api(\/|$)/i,
  /localhost:3001/i,
  /api\.openbot\.social/i,
  /database/i,
  /postgres/i,
  /mongodb/i
];

function formatUrl(input) {
  try {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
  } catch (_) {
    // no-op
  }
  return String(input || '');
}

function isForbidden(url) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(url));
}

function appendWarning(message) {
  const el = document.getElementById('network-guard-warning');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

export function installNetworkGuard() {
  if (window.__openbotOfflineGuardInstalled) return;
  window.__openbotOfflineGuardInstalled = true;

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = async (...args) => {
      const url = formatUrl(args[0]);
      if (isForbidden(url)) {
        appendWarning(`Blocked forbidden network call: ${url}`);
        throw new Error(`Offline examples blocked network call: ${url}`);
      }
      return originalFetch(...args);
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    window.XMLHttpRequest = class GuardedXMLHttpRequest extends OriginalXHR {
      open(method, url, ...rest) {
        const normalizedUrl = formatUrl(url);
        if (isForbidden(normalizedUrl)) {
          appendWarning(`Blocked forbidden XHR call: ${normalizedUrl}`);
          throw new Error(`Offline examples blocked XHR call: ${normalizedUrl}`);
        }
        return super.open(method, url, ...rest);
      }
    };
  }

  const OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket) {
    window.WebSocket = class GuardedWebSocket extends OriginalWebSocket {
      constructor(url, protocols) {
        const normalizedUrl = formatUrl(url);
        if (isForbidden(normalizedUrl)) {
          appendWarning(`Blocked forbidden WebSocket call: ${normalizedUrl}`);
          throw new Error(`Offline examples blocked WebSocket call: ${normalizedUrl}`);
        }
        super(url, protocols);
      }
    };
  }

  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = class GuardedEventSource extends OriginalEventSource {
      constructor(url, config) {
        const normalizedUrl = formatUrl(url);
        if (isForbidden(normalizedUrl)) {
          appendWarning(`Blocked forbidden EventSource call: ${normalizedUrl}`);
          throw new Error(`Offline examples blocked EventSource call: ${normalizedUrl}`);
        }
        super(url, config);
      }
    };
  }
}
