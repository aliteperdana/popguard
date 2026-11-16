/*
 * PopGuard — isolated-world bridge.
 *
 * MAIN-world scripts cannot touch chrome.*, so src/page/policy.js posts plain
 * messages here and we relay them to the service worker. We also fetch the
 * config (armed?, mode, exceptions) once per page load and hand it to the guard,
 * and — in the top frame of an armed tab — show the "Open anyway" notice for a
 * pop-up that was refused before it could become a tab.
 */
(() => {
  'use strict';

  const NS = 1;

  /** @type {{ armed: boolean, host: string, mode: string, exceptions: string[], notices: boolean }} */
  let config = { armed: false, host: '', mode: 'strict', exceptions: [], notices: true };

  const send = (payload) => {
    try {
      const pending = chrome.runtime.sendMessage(payload);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return pending;
    } catch (_) {
      // Extension was reloaded or revoked; nothing useful to do here.
      return Promise.resolve(null);
    }
  };

  /* ------------------------------------------------------------- the notice */

  let noticeHost = null;

  /**
   * A small notice, not a pop-up: drawn in the top frame inside a closed shadow
   * root, so the page cannot press the button for the user. The URL it reopens
   * is checked by the service worker against the tab that just blocked it.
   */
  function showNotice(url) {
    if (window.top !== window) return;
    if (!config.notices) return;
    if (!/^https?:/i.test(url || '')) return;

    let label = url;
    try {
      label = new URL(url).hostname || url;
    } catch (_) {}

    if (noticeHost) noticeHost.remove();

    const host = document.createElement('popguard-notice');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .t{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;
           font:13px/1.4 system-ui,sans-serif;background:#111827;color:#f9fafb;border-radius:10px;
           padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center}
        .m{flex:1;overflow-wrap:anywhere} b{color:#93c5fd}
        button{all:unset;cursor:pointer;padding:4px 8px;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;white-space:nowrap}
        .x{background:transparent;color:#9ca3af;font-weight:400}
      </style>
      <div class="t" role="status"><div class="m"><span></span><b></b></div><button class="go"></button><button class="x" aria-label="Dismiss">✕</button></div>`;

    root.querySelector('.m span').textContent = 'Blocked a new tab to ';
    root.querySelector('.m b').textContent = label;

    const go = root.querySelector('.go');
    go.textContent = 'Open anyway';
    go.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      host.remove();
      send({ type: 'thg:reopen', url });
    });
    root.querySelector('.x').addEventListener('click', () => host.remove());

    (document.body || document.documentElement).appendChild(host);
    noticeHost = host;
    setTimeout(() => {
      if (noticeHost === host) noticeHost = null;
      host.remove();
    }, 8000);
  }

  /* ------------------------------------------------------------- relaying */

  window.addEventListener(
    'message',
    (event) => {
      // Only accept messages this window posted to itself; anything else could
      // be an iframe or a page-controlled opener trying to forge block events.
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.__thg !== NS) return;

      // The guard may load before we do (worlds start in unspecified order), so
      // it asks for the config itself and we answer here.
      if (data.type === 'config-request') {
        loadConfig();
        return;
      }

      if (data.type !== 'block' && data.type !== 'allow' && data.type !== 'intent' && data.type !== 'frame') return;

      send({
        type:
          data.type === 'block'
            ? 'thg:block'
            : data.type === 'allow'
              ? 'thg:allow'
              : data.type === 'intent'
                ? 'thg:intent'
                : 'thg:frame',
        host: location.hostname,
        topHost: String(data.topHost || ''),
        kind: String(data.kind || ''),
        reason: String(data.reason || ''),
        mode: String(data.mode || ''),
        url: String(data.url || ''),
        href: String(data.href || ''),
        ts: Number(data.ts) || Date.now(),
      });

      // Only a refusal the user could plausibly have wanted deserves a notice: a
      // trusted click happened, but no clicked link pointed at the destination.
      // Timer/timeout pop-ups (no-activation, keyboard, untrusted-event) are
      // unambiguously ads and stay silent, as do invisible overlay anchors.
      const noticed = data.type === 'block' && (data.reason === 'no-evidence' || data.reason === 'cross-domain');
      if (noticed) showNotice(String(data.url || ''));
    },
    false,
  );

  // Liveness check: lets the popup prove the guard is actually injected on this
  // host. An empty block log plus zero pings means injection never happened.
  function ping() {
    send({ type: 'thg:ping', host: location.hostname });
  }

  async function loadConfig() {
    try {
      const response = await send({ type: 'thg:config', host: location.hostname });
      if (!response || !response.ok) return;

      config = {
        armed: response.armed === true,
        host: String(response.host || location.hostname),
        mode: response.mode === 'balanced' ? 'balanced' : 'strict',
        exceptions: Array.isArray(response.exceptions) ? response.exceptions : [],
        notices: response.notices !== false,
      };

      window.postMessage(
        {
          __thg: NS,
          type: 'config',
          armed: config.armed,
          topHost: config.host,
          mode: config.mode,
          exceptions: config.exceptions,
          notices: config.notices,
        },
        '*',
      );
    } catch (_) {}
  }

  ping();
  loadConfig();
  window.addEventListener('pageshow', ping);
})();
