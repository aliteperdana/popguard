/*
 * PopGuard — page-world guard entry point.
 *
 * Registered by the service worker for each protected host (document_start,
 * MAIN world, all frames), so it is present before any page script can capture
 * the real window.open.
 *
 * All policy lives in src/page/policy.js, which is loaded first. This file only
 * says "the top host here is armed" and keeps the guard's config up to date.
 *
 * Important: MAIN-world scripts are subject to the page's CSP. That is why the
 * service worker watchdog still exists; cross-origin frames are covered by
 * src/page/frame-guard.js.
 */
(() => {
  'use strict';

  const policy = window.__thgPolicy;
  if (!policy) return;

  const guard = policy.installGuard({
    armed: true,
    topHost: location.hostname.toLowerCase(),
    // Fail closed until the service worker confirms the host's real mode.
    mode: 'strict',
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__thg !== policy.NS || data.type !== 'config') return;
    guard.setConfig(data);
  });

  guard.requestConfig();
})();
