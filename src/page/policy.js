/*
 * PopGuard — page-world policy, shared by the top-frame guard and the
 * cross-origin frame guard.
 *
 * Loaded before src/page/guard.js and src/page/frame-guard.js. Both entry
 * points call installGuard(); only one guard exists per document, so a
 * same-origin subframe that matches both registrations is never patched twice.
 *
 * MAIN world only: there is no chrome.* here. Reporting goes through
 * window.postMessage to src/content/bridge.js, plus a `thg:blocked` CustomEvent
 * for the fixtures.
 *
 * The page can see and theoretically tamper with window.__thgPolicy, exactly as
 * it can tamper with window.open. That is why the service worker watchdog in
 * src/background/sw.js still exists.
 */
(() => {
  'use strict';

  if (window.__thgPolicy) return;

  const NS = 1;

  /**
   * How long a gesture counts as intent, and how long the href of the clicked
   * link stays usable as evidence. One constant for both: a popup that arrives
   * later than this was not caused by that click.
   */
  const INTENT_WINDOW_MS = 2000;

  /**
   * Sites one company owns. A player on an embedded frame legitimately opens its
   * own site, and those URLs carry extras (`&t=42s`) that break exact matching.
   * Ad networks are never listed here; network-level blocking does not use it.
   */
  const FAMILIES = [
    ['google.com', 'youtube.com', 'googlevideo.com', 'googleusercontent.com', 'gstatic.com', 'blogspot.com', 'withgoogle.com'],
    ['microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'office365.com', 'bing.com', 'xbox.com'],
    ['apple.com', 'icloud.com'],
    ['amazon.com', 'amazonaws.com', 'twitch.tv', 'audible.com'],
    ['meta.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'fbcdn.net'],
    ['x.com', 'twitter.com', 't.co'],
    ['linkedin.com', 'licdn.com'],
    ['zoom.us', 'zoom.com'],
  ];

  /**
   * Sign-in and payment hosts. Identity flows jump between these with scripted
   * popups (Microsoft's account picker, "Sign in with Google"); an ad script
   * never sends you to them. Kept here in addition to the user's exception list
   * so a removed exception cannot break logging in.
   */
  const SIGN_IN = [
    'accounts.google.com',
    'login.live.com',
    'login.microsoftonline.com',
    'login.microsoft.com',
    'account.live.com',
    'account.microsoft.com',
    'appleid.apple.com',
    'idmsa.apple.com',
    'paypal.com',
    'checkout.stripe.com',
    'okta.com',
    'auth0.com',
  ];

  /* ------------------------------------------------------------------ hosts */

  const hostOf = (url, base) => {
    try {
      const parsed = new URL(String(url), base || location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  };

  const absolute = (url, base) => {
    try {
      return new URL(String(url), base || location.href).href;
    } catch (_) {
      return '';
    }
  };

  /** `new URL('', href)` resolves to the current page; the browser does not. */
  const isBlankTarget = (url) => {
    if (url == null) return true;
    const value = String(url).trim();
    return value === '' || /^about:blank/i.test(value);
  };

  /** Schemes that never reach the network and cannot become a hijacked tab. */
  const isInnerScheme = (url) => /^(blob:|data:|javascript:|mailto:|tel:)/i.test(String(url || '').trim());

  const sameSiteHost = (a, b) => Boolean(a && b) && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));

  const ownerOf = (host) => {
    if (!host) return '';
    for (const group of FAMILIES) {
      if (group.some((domain) => sameSiteHost(host, domain))) return group[0];
    }
    return '';
  };

  const sameOwner = (a, b) => {
    const hostA = hostOf(a);
    const hostB = hostOf(b);
    if (!hostA || !hostB) return false;
    if (sameSiteHost(hostA, hostB)) return true;
    const owner = ownerOf(hostA);
    return Boolean(owner) && owner === ownerOf(hostB);
  };

  const isSignIn = (host) => Boolean(host) && SIGN_IN.some((domain) => host === domain || host.endsWith('.' + domain));

  const isExcepted = (host, exceptions) => {
    if (!host) return false;
    return (exceptions || []).some((entry) => host === entry || host.endsWith('.' + entry));
  };

  /** origin + path + search: a fragment difference is the same destination. */
  const urlKey = (url) => {
    try {
      const parsed = new URL(String(url));
      return parsed.origin + parsed.pathname + parsed.search;
    } catch (_) {
      return '';
    }
  };

  /* ----------------------------------------------------------- guard builder */

  /**
   * One guard per document.
   *
   * @param {object} options
   * @param {string} options.topHost   the protected host whose policy applies
   *                                   (not this frame's origin, which may be an
   *                                   ad domain)
   * @param {'strict'|'balanced'} [options.mode]
   * @param {string[]} [options.exceptions]
   * @param {boolean} [options.armed]  false makes the guard inert
   */
  function installGuard(options) {
    if (window.__thgGuard) {
      window.__thgGuard.setConfig(options || {});
      return window.__thgGuard;
    }

    const settings = {
      topHost: String((options && options.topHost) || location.hostname || '').toLowerCase(),
      mode: options && options.mode === 'balanced' ? 'balanced' : 'strict',
      exceptions: Array.isArray(options && options.exceptions)
        ? options.exceptions.map((entry) => String(entry).toLowerCase()).filter(Boolean)
        : [],
      // A guard is only installed on an armed host, or in a frame whose tab is
      // armed; until the service worker says otherwise, fail closed.
      enabled: !(options && options.armed === false),
      configLoaded: false,
    };

    const nativeOpen = window.open;
    /** @type {{ ts: number, kind: string, trusted: boolean, href: string } | null} */
    let lastIntent = null;

    const intentFresh = () => lastIntent !== null && Date.now() - lastIntent.ts <= INTENT_WINDOW_MS;

    /**
     * True when this document *is* the site the user armed.
     *
     * In an ad iframe that is false, and a click inside an ad is an ad click
     * however well its href matches the destination. Treating that click as
     * evidence let Vidara's ad frame open its own landing page with no log line
     * at all — the popup was "allowed", not missed.
     */
    function isProtectedDocument() {
      return settings.topHost === String(location.hostname || '').toLowerCase();
    }

    /**
     * Hand the armed decision down to child frames immediately.
     *
     * A cross-origin ad iframe cannot know which site armed it: its own origin is
     * the ad domain, and asking the service worker is asynchronous. Without this
     * relay the frame guard is inert for the first moments of a frame's life —
     * exactly when a pop-up is fired. Only a parent may arm a child, so a page
     * cannot use this to disarm anything.
     */
    function broadcastArmed() {
      if (!settings.enabled) return;
      let count = 0;
      try {
        count = window.frames.length;
      } catch (_) {
        return;
      }
      const payload = {
        __thg: NS,
        type: 'armed',
        armed: true,
        topHost: settings.topHost,
        mode: settings.mode,
        exceptions: settings.exceptions,
      };
      for (let index = 0; index < count; index += 1) {
        try {
          window.frames[index].postMessage(payload, '*');
        } catch (_) {}
      }
    }

    function setConfig(next) {
      if (!next) return;
      if (next.mode === 'balanced' || next.mode === 'strict') settings.mode = next.mode;
      if (Array.isArray(next.exceptions)) {
        settings.exceptions = next.exceptions.map((entry) => String(entry).toLowerCase()).filter(Boolean);
      }
      if (next.topHost) settings.topHost = String(next.topHost).toLowerCase();
      if (next.armed === false) {
        settings.enabled = false;
        if (window.open === patchedOpen) window.open = nativeOpen;
      } else if (next.armed === true) {
        settings.enabled = true;
      }
      settings.configLoaded = true;
      broadcastArmed();
    }

    /* ------------------------------------------------------------ decisions */

    /**
     * Evidence that the user asked for *this* destination: the link they
     * clicked points at it. A trusted click alone is not enough — ad buttons
     * are trusted clicks too, which is what made every banner open a tab.
     */
    function matchesClicked(target) {
      if (!intentFresh() || !lastIntent.trusted || !lastIntent.href) return false;
      // Only the protected document's own clicks are evidence. An embedded ad
      // frame must never be able to authorise a tab by being clicked itself.
      if (!isProtectedDocument()) return false;
      const actual = absolute(target);
      if (!actual) return false;
      if (urlKey(lastIntent.href) === urlKey(actual)) return true;
      // A known company's page may carry extras the clicked link did not have.
      return Boolean(ownerOf(hostOf(actual))) && sameOwner(lastIntent.href, actual);
    }

    /**
     * @returns {string | null} reason to refuse `window.open`, or null to let it
     *   through. A blank destination is always refused; everything that leaves
     *   the protected host needs evidence that the user asked for it.
     */
    function decideOpen(target) {
      // Identity providers may open without a gesture: an OAuth window is often
      // created after an async round-trip, when the gesture is already gone. Ad
      // networks never send you to an identity provider, so this cannot be
      // abused the way a general "trusted click" rule could.
      if (!isBlankTarget(target) && !isInnerScheme(target)) {
        const signInHost = hostOf(target);
        if (signInHost && isSignIn(signInHost)) return null;
      }

      if (!intentFresh()) return 'no-activation';
      if (lastIntent.kind === 'key') return 'keyboard';
      if (!lastIntent.trusted) return 'untrusted-event';

      /*
       * A blank window is a blank cheque: the page writes any address into it a
       * moment later. Allowing it "as long as a click happened" is what produced
       * the last visible tab in the field test — the ad waited 1.5s, the
       * watchdog closed it after the fact, and the user saw a tab appear.
       *
       * Refusing it costs legacy `window.open('')` + `document.write()` print
       * windows. That is the trade the reference implementation makes too, and
       * the stub keeps the page from throwing.
       */
      if (isBlankTarget(target)) return 'blank-popup';

      // Other inner schemes cannot become a hijacked tab.
      if (isInnerScheme(target)) return null;

      const host = hostOf(target);
      if (!host) return null;
      if (sameSiteHost(host, settings.topHost)) return null;
      if (isExcepted(host, settings.exceptions)) return null;
      if (isSignIn(host)) return null;
      if (ownerOf(host) && ownerOf(host) === ownerOf(settings.topHost)) return null;
      if (matchesClicked(target)) return null;

      return 'no-evidence';
    }

    /**
     * Anchor policy. Only strict mode polices `_blank` links; balanced mode lets
     * a real click leave the site, which is what forums need.
     */
    function anchorVerdict(href) {
      if (settings.mode !== 'strict') return null;
      if (!href) return null;
      const host = hostOf(href);
      if (!host) return null;
      if (sameSiteHost(host, settings.topHost)) return null;
      if (isExcepted(host, settings.exceptions)) return null;
      if (isSignIn(host)) return null;
      if (ownerOf(host) && ownerOf(host) === ownerOf(settings.topHost)) return null;
      return 'cross-domain';
    }

    /* ------------------------------------------------------------ reporting */

    function report(kind, url, reason) {
      const raw = String(url == null ? '' : url);
      const clean = isBlankTarget(raw) || raw === '__modifier__' ? raw : absolute(raw) || raw;
      const detail = { kind, url: clean, reason, ts: Date.now(), topHost: settings.topHost };
      try {
        document.dispatchEvent(new CustomEvent('thg:blocked', { detail }));
      } catch (_) {}
      try {
        window.postMessage({ __thg: NS, type: 'block', ...detail, host: location.hostname }, '*');
      } catch (_) {}
    }

    function announceAllow(url) {
      try {
        // Ctrl/Cmd/Shift/middle click: the user asked the browser for a tab and
        // the destination is whatever they clicked.
        if (url === '__modifier__') {
          window.postMessage({ __thg: NS, type: 'allow', url: '__modifier__', ts: Date.now() }, '*');
          return;
        }

        // Never vouch for a blank destination: it is a blank cheque the tab can
        // fill with an ad a moment later.
        if (isBlankTarget(url) || isInnerScheme(url) || !hostOf(url)) return;

        window.postMessage({ __thg: NS, type: 'allow', url: absolute(url), ts: Date.now() }, '*');
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

    /* --------------------------------------------------------------- patch */

    function makeStub(url) {
      const stub = {
        // Lets the fixtures tell a blocked call from a real window without
        // touching cross-origin properties.
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

    const patchedOpen = function open(url) {
      if (window.open !== patchedOpen) window.open = patchedOpen;
      if (!settings.enabled) return nativeOpen.apply(window, arguments);

      const target = typeof url === 'string' ? url : url == null ? 'about:blank' : String(url);
      const reason = decideOpen(target);

      if (reason) {
        report('window.open', target, reason);
        return makeStub(target);
      }

      announceAllow(target);
      return nativeOpen.apply(window, arguments);
    };

    /* -------------------------------------------------------------- inputs */

    function rememberIntent(kind, event, anchor) {
      const trusted = event.isTrusted === true;
      const fresh = intentFresh();

      // Never let a synthetic click erase a fresh trusted one: pages that call
      // el.click() right after a real click would otherwise lose their own popup.
      if (!trusted && fresh && lastIntent.trusted) return;

      lastIntent = {
        kind,
        ts: Date.now(),
        trusted,
        href: anchor ? absolute(anchor.getAttribute('href')) : '',
      };

      // The exception list may not have arrived yet (worlds load in unspecified
      // order). Ask again on the first input; without it, auth popups look like
      // cross-domain targets and get blocked.
      if (!settings.configLoaded) requestConfig();

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

    const opensNewWindow = (anchor) => anchor.target === '_blank' || anchor.target === '_new';

    window.addEventListener('keydown', (event) => rememberIntent('key', event, null), true);

    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button === 2) {
          // Right click opens the browser's own context menu. No ad script can
          // synthesise a trusted one, so it is a reliable intent signal: remember
          // which link is under the cursor so "Open link in new tab" and "Copy
          // link address" are not mistaken for a hijack.
          if (event.isTrusted) {
            const anchor = findAnchor(event);
            if (anchor) announceIntent(anchor.href);
          }
          return; // a right click must never count as a popup-permitting click
        }

        rememberIntent('click', event, findAnchor(event));

        // Ctrl/Cmd/Shift/middle click opens a tab through the browser itself,
        // not through window.open. Tell the service worker so it allows it.
        if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey) {
          announceAllow('__modifier__');
        }
      },
      true,
    );

    window.addEventListener(
      'click',
      (event) => {
        const anchor = findAnchor(event);
        rememberIntent('click', event, anchor);
        if (!anchor || !opensNewWindow(anchor)) return;

        if (!isVisible(anchor)) {
          // An invisible _blank anchor means the click was delegated from an
          // overlay or fired programmatically. Suppressing default also stops
          // the browser's own target=_blank handling, which bypasses window.open.
          event.preventDefault();
          event.stopImmediatePropagation();
          report('anchor', anchor.href, 'hidden-anchor');
          return;
        }

        const verdict = anchorVerdict(anchor.href);
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

    /*
     * A form with target=_blank navigates without window.open and without an
     * anchor click, so neither patch above sees it. The action attribute is the
     * only signal we get, and only strict mode polices it.
     */
    window.addEventListener(
      'submit',
      (event) => {
        if (!settings.enabled) return;
        const form = event.target;
        if (!form || form.tagName !== 'FORM') return;
        const target = String(form.target || '').toLowerCase();
        if (target !== '_blank' && target !== '_new') return;

        const action = absolute(form.getAttribute('action') || location.href);
        const verdict = anchorVerdict(action);
        if (!verdict) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        report('form', action, verdict);
      },
      true,
    );

    // Ad iframes are created at any time, so keep relaying the armed decision
    // down the frame tree. After half a minute the service-worker answer is the
    // path that covers new frames anyway.
    if (window.top === window) {
      let ticks = 0;
      const timer = setInterval(() => {
        broadcastArmed();
        ticks += 1;
        if (ticks >= 15) clearInterval(timer);
      }, 2000);
    }

    window.open = patchedOpen;

    /*
     * A page can grab an untouched window.open from a fresh iframe:
     *
     *   const f = document.createElement('iframe');
     *   document.body.append(f);
     *   const realOpen = f.contentWindow.open;   // about:blank child, not patched
     *   realOpen.call(window, adUrl);
     *
     * A brand-new frame has no guard yet, so its `open` is native, and the call
     * bypasses everything above — no block line in the log, a tab born blank,
     * filled with an ad a moment later. That was the last leak on Vidara.
     *
     * Patching the getter means every frame handle hands back a window whose
     * `open` is guarded.
     */
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (descriptor && typeof descriptor.get === 'function') {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            const frameWindow = descriptor.get.call(this);
            try {
              if (frameWindow && frameWindow.open !== patchedOpen) {
                Object.defineProperty(frameWindow, 'open', {
                  value: patchedOpen,
                  writable: false,
                  configurable: false,
                });
              }
            } catch (_) {
              // Cross-origin handle: the page cannot reach `open` either.
            }
            return frameWindow;
          },
        });
      }
    } catch (_) {}

    const api = { setConfig, requestConfig, report, broadcastArmed };
    window.__thgGuard = api;
    return api;
  }

  window.__thgPolicy = {
    NS,
    installGuard,
    requestConfig() {
      try {
        window.postMessage({ __thg: NS, type: 'config-request' }, '*');
      } catch (_) {}
    },
  };
})();
