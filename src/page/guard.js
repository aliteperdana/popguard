/*
 * PopGuard — page-world guard (defence in depth).
 *
 * Runs in the MAIN world at document_start so it is installed before any page
 * script can capture the real window.open.
 *
 * Important: MAIN-world scripts are subject to the page's CSP and do not exist
 * inside cross-origin iframes. This file is therefore a second line of defence;
 * the service worker's tab watchdog is the one that always runs.
 *
 * No chrome.* here — reporting goes through window.postMessage to
 * src/content/bridge.js, plus a `thg:blocked` CustomEvent for the fixtures.
 */
(() => {
  'use strict';

  const NS = 1;
  const ACTIVATION_WINDOW_MS = 1000;

  const pageHost = location.hostname.toLowerCase();
  const nativeOpen = window.open;

  /** @type {string[]} host suffixes allowed to receive a popup from this page */
  let exceptions = [];
  let configLoaded = false;
  // Fail closed until the service worker confirms the host's mode.
  let mode = 'strict';

  /** @type {{ kind: 'click'|'key', ts: number, trusted: boolean } | null} */
  let lastIntent = null;

  const patchedOpen = function open(url, name, features) {
    if (window.open !== patchedOpen) window.open = patchedOpen;

    const target = typeof url === 'string' ? url : url == null ? 'about:blank' : String(url);
    const reason = decide(target);

    if (reason) {
      report('window.open', target, reason);
      return makeStub(target);
    }

    announceAllow(target);
    return nativeOpen.apply(window, arguments);
  };

  /* ------------------------------------------------------------- decisions */

  function hostMatches(entry, host) {
    return host === entry || host.endsWith('.' + entry);
  }

  function isExcepted(host) {
    return exceptions.some((entry) => hostMatches(entry, host));
  }

  function resolvedHost(target) {
    try {
      const url = new URL(target, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  /**
   * `new URL('', href)` resolves to the current page, which would make an empty
   * `window.open('')` look like a same-site popup. It is not: the browser gives
   * it about:blank, and the caller can write any address into it.
   */
  function isBlankTarget(target) {
    if (target == null) return true;
    const value = String(target).trim();
    return value === '' || /^about:blank/i.test(value);
  }

  /**
   * @returns {string | null} 'cross-domain' when the popup leaves this site and
   *   is not explicitly allowed. Same-site and non-http targets return null.
   */
  function crossDomainVerdict(target) {
    if (isBlankTarget(target)) return null;
    // Balanced mode lets real clicks leave the site; strict mode does not.
    if (mode !== 'strict') return null;
    const host = resolvedHost(target);
    if (!host) return null; // about:blank / javascript: / relative-to-nothing
    if (host === pageHost) return null;
    if (host.endsWith('.' + pageHost)) return null; // subdomain of this page
    if (pageHost.endsWith('.' + host)) return null; // parent domain of this page
    if (isExcepted(host)) return null;
    return 'cross-domain';
  }

  function decide(target) {
    if (!lastIntent) return 'no-activation';
    if (Date.now() - lastIntent.ts > ACTIVATION_WINDOW_MS) return 'no-activation';
    if (lastIntent.kind === 'key') return 'keyboard';
    if (!lastIntent.trusted) return 'untrusted-event';

    // A trusted click is not enough on an armed site: ad buttons are trusted
    // clicks too. Leaving the site without an explicit exception is what we
    // treat as unwanted.
    return crossDomainVerdict(target);
  }

  /* -------------------------------------------------------------- reporting */

  function report(kind, url, reason) {
    const detail = { kind, url, reason, ts: Date.now() };
    try {
      document.dispatchEvent(new CustomEvent('thg:blocked', { detail }));
    } catch (_) {}
    try {
      window.postMessage({ __thg: NS, type: 'block', ...detail, host: location.hostname }, '*');
    } catch (_) {}
  }

  function announceAllow(url) {
    try {
      // Ctrl/Cmd/Shift/middle click: destination is whatever the user clicked.
      if (url === '__modifier__') {
        window.postMessage({ __thg: NS, type: 'allow', url: '__modifier__', ts: Date.now() }, '*');
        return;
      }

      // Never vouch for a blank destination. `window.open('about:blank')` is a
      // blank cheque: the tab can navigate anywhere a moment later, so approving
      // it here would legitimise whatever it lands on.
      if (isBlankTarget(url) || !resolvedHost(url)) return;

      // Absolute URL, so the service worker can bind the token to this exact
      // destination and refuse to let an ad borrow it.
      let absolute;
      try {
        absolute = new URL(String(url), location.href).href;
      } catch (_) {
        return;
      }

      window.postMessage({ __thg: NS, type: 'allow', url: absolute, ts: Date.now() }, '*');
    } catch (_) {}
  }

  function requestConfig() {
    try {
      window.postMessage({ __thg: NS, type: 'config-request' }, '*');
    } catch (_) {}
  }

  function announceIntent(href) {
    try {
      window.postMessage({ __thg: NS, type: 'intent', href: String(href || ''), ts: Date.now() }, '*');
    } catch (_) {}
  }

  function makeStub(url) {
    const stub = {
      // Lets tests tell a blocked call from a real window without touching
      // cross-origin properties.
      __thgStub: true,
      closed: false,
      opener: null,
      name: '',
      location: {
        href: url || 'about:blank',
        assign() {},
        replace() {},
        reload() {},
        toString() {
          return this.href;
        },
      },
      document: { write() {}, writeln() {}, open() {}, close() {} },
      focus() {},
      blur() {},
      close() {
        stub.closed = true;
      },
      postMessage() {},
      moveTo() {},
      moveBy() {},
      resizeTo() {},
      resizeBy() {},
      print() {},
    };
    return stub;
  }

  /* ---------------------------------------------------------------- inputs */

  function rememberIntent(kind, event) {
    const trusted = event.isTrusted === true;
    const fresh = lastIntent !== null && Date.now() - lastIntent.ts <= ACTIVATION_WINDOW_MS;

    // Never let a synthetic click erase a fresh trusted one: pages that call
    // el.click() right after a real click would otherwise lose their own popup.
    if (!trusted && fresh && lastIntent.trusted) return;

    lastIntent = { kind, ts: Date.now(), trusted };

    // The exception list may not have arrived yet (worlds load in unspecified
    // order). Ask again on the first input; without it, auth popups look
    // cross-domain and get blocked.
    if (!configLoaded) requestConfig();

    // A page may swap window.open after we installed; re-assert on next input.
    if (window.open !== patchedOpen) window.open = patchedOpen;
  }

  function findAnchor(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node && node.nodeType === 1 && node.tagName === 'A') return node;
    }
    return null;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    return true;
  }

  function opensNewWindow(anchor) {
    return anchor.target === '_blank' || anchor.target === '_new';
  }

  window.addEventListener('keydown', (event) => rememberIntent('key', event), true);

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button === 2) {
        // Right click opens the browser's own context menu. No ad script can
        // synthesise a trusted one, so it is a reliable intent signal: remember
        // which link is under the cursor so "Open link in new tab" and
        // "Copy link address" are not mistaken for a hijack.
        if (event.isTrusted) {
          const anchor = findAnchor(event);
          if (anchor) announceIntent(anchor.href);
        }
        return; // a right click must never count as a popup-permitting click
      }

      rememberIntent('click', event);

      // Ctrl/Cmd/Shift/middle click opens a tab through the browser itself, not
      // through window.open. Tell the service worker so its watchdog allows it.
      if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey) {
        announceAllow('__modifier__');
      }
    },
    true,
  );

  window.addEventListener(
    'click',
    (event) => {
      rememberIntent('click', event);

      const anchor = findAnchor(event);
      if (!anchor || !opensNewWindow(anchor)) return;

      if (!isVisible(anchor)) {
        // An invisible _blank anchor means the click was delegated from an
        // overlay or fired programmatically. Suppressing default also stops the
        // browser's own target=_blank handling, which bypasses window.open.
        event.preventDefault();
        event.stopImmediatePropagation();
        report('anchor', anchor.href, 'hidden-anchor');
        return;
      }

      const verdict = crossDomainVerdict(anchor.href);
      if (verdict) {
        event.preventDefault();
        event.stopImmediatePropagation();
        report('anchor', anchor.href, verdict);
      } else {
        // A legitimate _blank navigation. These usually carry rel=noopener, so
        // no window.open call happens — tell the service worker the tab is
        // wanted before its orphan-popup rule sees it.
        announceAllow(anchor.href);
      }
    },
    true,
  );

  /* --------------------------------------------------------------- config */

  // The bridge fetches the exception list from the service worker and hands it
  // over here, because MAIN world has no chrome.storage access.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__thg !== NS || data.type !== 'config') return;
    exceptions = Array.isArray(data.exceptions)
      ? data.exceptions.map((entry) => String(entry).toLowerCase()).filter(Boolean)
      : [];
    mode = data.mode === 'balanced' ? 'balanced' : 'strict';
    configLoaded = true;
  });

  window.open = patchedOpen;
  requestConfig();
})();
