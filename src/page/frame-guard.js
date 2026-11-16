/*
 * PopGuard — cross-origin frame guard.
 *
 * Registered statically for every site and every frame, because a pop-up can be
 * opened from an ad iframe whose origin is not the protected host. Registration
 * matches say nothing about protection: this script is INERT until it learns that
 * the tab it belongs to has an armed top host.
 *
 * Two ways to learn it, because neither is reliable on its own:
 *
 *  1. The parent frame relays `{type:'armed'}` as soon as it is armed (instant,
 *     but only reaches frames that exist when it broadcasts).
 *  2. The service worker answers `thg:config` (authoritative, but asynchronous —
 *     and it can arrive after the frame has already fired a pop-up).
 *
 * This keeps the product rule intact — only armed sites are affected — while
 * still denying the tab before it is created, which is the only way to avoid a
 * visible pop-up.
 *
 * Top frames are handled by src/page/guard.js, which is registered per armed host
 * and fails closed immediately.
 */
(() => {
  'use strict';

  if (window.top === window) return; // top frames belong to src/page/guard.js

  const policy = window.__thgPolicy;
  if (!policy) return;

  /** @type {ReturnType<typeof policy.installGuard> | null} */
  let guard = null;

  function relayDown() {
    if (guard) guard.broadcastArmed();
  }

  function accept(data) {
    if (!data || data.armed !== true) return;

    if (!guard) {
      guard = policy.installGuard({
        armed: true,
        topHost: data.topHost || location.hostname.toLowerCase(),
        mode: data.mode,
        exceptions: data.exceptions,
      });

      // Tell the service worker that this frame is now covered. If a pop-up
      // still escapes from an ad frame, `frameLog` in the export says whether
      // that frame was ever armed — the difference between "we missed it" and
      // "we were never there".
      try {
        window.postMessage(
          {
            __thg: policy.NS,
            type: 'frame',
            topHost: data.topHost || location.hostname.toLowerCase(),
            mode: data.mode || '',
            ts: Date.now(),
          },
          '*',
        );
      } catch (_) {}
    } else {
      guard.setConfig(data);
    }
    relayDown();
  }

  // From the bridge in this frame (the isolated world posts to this window).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__thg !== policy.NS || data.type !== 'config') return;
    accept(data);
  });

  // From the parent frame, which inherited the decision from an armed ancestor.
  // A child can never arm its parent, so a page cannot use this to disarm.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.__thg !== policy.NS || data.type !== 'armed') return;
    accept(data);
  });

  // The service worker may be waking up, or the tab URL may not have been known
  // yet when we first asked. Keep asking for a few seconds: a frame guard that
  // stayed inert would let a tab through and show a flash.
  let attempts = 0;
  function ask() {
    if (guard) return;
    policy.requestConfig();
    attempts += 1;
    if (attempts < 12) setTimeout(ask, 350);
  }

  // An ad iframe often gets its pop-up on the first click, before any answer
  // arrived; asking again here is cheap and covers a late service worker.
  const nudge = () => {
    if (!guard) policy.requestConfig();
  };
  window.addEventListener('pointerdown', nudge, true);
  window.addEventListener('click', nudge, true);
  window.addEventListener('pageshow', nudge);

  ask();
})();
