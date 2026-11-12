/*
 * PopGuard — isolated-world bridge.
 *
 * MAIN-world scripts cannot touch chrome.*, so src/page/guard.js posts plain
 * messages here and we relay them to the service worker. Also fetches the
 * exception list once per page load and hands it to the guard.
 */
(() => {
  'use strict';

  const NS = 1;

  window.addEventListener(
    'message',
    (event) => {
      // Only accept messages this window posted to itself; anything else could
      // be an iframe or a page-controlled opener trying to forge block events.
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.__thg !== NS) return;

      // The guard may load before we do (worlds start in unspecified order), so
      // it asks for the exception list itself and we answer here.
      if (data.type === 'config-request') {
        loadConfig();
        return;
      }

      if (data.type !== 'block' && data.type !== 'allow' && data.type !== 'intent') return;

      const payload = {
        type:
          data.type === 'block'
            ? 'thg:block'
            : data.type === 'allow'
              ? 'thg:allow'
              : 'thg:intent',
        host: location.hostname,
        kind: String(data.kind || ''),
        reason: String(data.reason || ''),
        url: String(data.url || ''),
        href: String(data.href || ''),
        ts: Number(data.ts) || Date.now(),
      };

      try {
        const pending = chrome.runtime.sendMessage(payload);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) {
        // Extension was reloaded or revoked; nothing useful to do here.
      }
    },
    false,
  );

  // Liveness check: lets the popup prove the guard is actually injected on this
  // host. An empty block log plus zero pings means injection never happened.
  function ping() {
    try {
      const pending = chrome.runtime.sendMessage({ type: 'thg:ping', host: location.hostname });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) {}
  }

  async function loadConfig() {
    try {
      const config = await chrome.runtime.sendMessage({ type: 'thg:config', host: location.hostname });
      if (!config || !config.ok) return;
      window.postMessage(
        { __thg: NS, type: 'config', exceptions: config.exceptions || [], mode: config.mode || 'strict' },
        '*',
      );
    } catch (_) {}
  }

  ping();
  loadConfig();
  window.addEventListener('pageshow', ping);
})();
