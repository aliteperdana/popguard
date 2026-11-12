/*
 * PopGuard — service worker.
 *
 * Two jobs:
 *   1. Primary defence: close cross-domain tabs spawned by a protected host.
 *      This lives here because it is immune to page CSP, cross-origin ad
 *      iframes and the "trusted click" problem that limits the page guard.
 *   2. Bookkeeping: per-host database, dynamic script registration, logging.
 *
 * It still does NOT decide popups from its own knowledge of gestures — the page
 * guard reports "allowed" tokens for those.
 */
'use strict';

const HOSTS_KEY = 'protectedHosts';
const EXCEPTIONS_KEY = 'globalExceptions';
const LOG_KEY = 'blockLog';
const DIAG_KEY = 'diagLog';
const SEEN_KEY = 'guardSeen';

const LOG_LIMIT = 300;
const DIAG_LIMIT = 120;
const ALLOW_TTL_MS = 2000;

/** How long an about:blank popup may stay blank before we stop watching it. */
const EMPTY_URL_GRACE_MS = 8000;
/** How long an allowed tab stays under redirect surveillance. */
const REDIRECT_WINDOW_MS = 6000;
/** How long a right-click link intent stays valid. */
const INTENT_TTL_MS = 5000;
/** A blank tab that stays blank this long was opened by a human, not an ad. */
const MANUAL_BLANK_MS = 1500;
/** A URL the user explicitly reopened from the block log stays open this long. */
const MANUAL_OPEN_TTL_MS = 15000;

const GUARD_ID = 'thg-guard:';
const BRIDGE_ID = 'thg-bridge:';

/**
 * Strict: every cross-domain tab is blocked unless it is excepted.
 * Balanced: cross-domain tabs opened by a real click are allowed; anything the
 * page guard did not vouch for (ads in iframes, timers, blank popups) is still
 * blocked. Forums with external links need balanced; ad-heavy pages want strict.
 */
const DEFAULT_MODE = 'balanced';

/**
 * Hosts that are allowed to receive a new tab from any protected site.
 * Seeded with login/anti-bot providers so cross-domain blocking does not break
 * OAuth. Matching is suffix-based: "paypal.com" also covers www.paypal.com.
 */
const DEFAULT_EXCEPTIONS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'github.com',
  'facebook.com',
  'paypal.com',
  'stripe.com',
  'cloudflare.com',
  'recaptcha.net',
];

/* In-memory state. Lost on service worker restart; rebuilt on boot. */
let hosts = {};
let exceptions = [];
const protectedTabHosts = new Map(); // tabId -> protected host
const allowTokens = new Map(); // tabId -> { ts, any, key } page-guard approval
const pendingCreations = new Map(); // tabId -> { ts, openerTabId, windowId, active, url }
const windowTypes = new Map(); // windowId -> 'normal' | 'popup' | ...
const watchedTabs = new Map(); // tabId -> { host, ts } — tabs allowed to exist
const intentTokens = new Map(); // tabId -> { href, ts } — right-click on a link
const manualUrls = new Map(); // urlKey -> ts — user reopened a blocked URL
let lastFocusedProtected = null; // { tabId, host, windowId }

/* ------------------------------------------------------------------ helpers */

function normalizeHost(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)
    ? host
    : '';
}

function hostOf(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function sameSite(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function isExcepted(host) {
  if (!host) return false;
  return exceptions.some((entry) => host === entry || host.endsWith('.' + entry));
}

const originPattern = (host) => `*://${host}/*`;

/**
 * Host access is granted once at install (`host_permissions: "*://*​/*"`), the
 * same way other blockers do it. `permissions.getAll()` may report the broad
 * pattern instead of the per-host subset, so both shapes must count.
 */
async function hasOriginGranted(host) {
  const granted = new Set((await chrome.permissions.getAll()).origins || []);
  return granted.has(originPattern(host)) || granted.has('*://*/*');
}

/* ------------------------------------------------------------------ storage */

async function loadCaches() {
  const sync = await chrome.storage.sync.get([HOSTS_KEY, EXCEPTIONS_KEY]);
  hosts = sync[HOSTS_KEY] || {};
  exceptions = sync[EXCEPTIONS_KEY] || DEFAULT_EXCEPTIONS;

  // Migrate entries created before per-site modes existed.
  let dirty = false;
  for (const entry of Object.values(hosts)) {
    if (entry.mode !== 'strict' && entry.mode !== 'balanced') {
      entry.mode = DEFAULT_MODE;
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.sync.set({ [HOSTS_KEY]: hosts });
}

async function persistHosts() {
  await chrome.storage.sync.set({ [HOSTS_KEY]: hosts });
}

async function persistExceptions() {
  await chrome.storage.sync.set({ [EXCEPTIONS_KEY]: exceptions });
}

async function getLog() {
  const data = await chrome.storage.local.get(LOG_KEY);
  return data[LOG_KEY] || [];
}

async function appendLog(entry) {
  const log = await getLog();
  log.unshift(entry);
  if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

async function getDiag() {
  const data = await chrome.storage.local.get(DIAG_KEY);
  return data[DIAG_KEY] || [];
}

async function appendDiag(entry) {
  const log = await getDiag();
  log.unshift(entry);
  if (log.length > DIAG_LIMIT) log.length = DIAG_LIMIT;
  await chrome.storage.local.set({ [DIAG_KEY]: log });
}

async function getSeen() {
  const data = await chrome.storage.local.get(SEEN_KEY);
  return data[SEEN_KEY] || {};
}

/* ------------------------------------------------- content script lifecycle */

async function registerForHost(host) {
  const guardId = GUARD_ID + host;
  const bridgeId = BRIDGE_ID + host;
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const stale = existing.map((s) => s.id).filter((id) => id === guardId || id === bridgeId);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });

  await chrome.scripting.registerContentScripts([
    {
      id: guardId,
      matches: [originPattern(host)],
      js: ['src/page/guard.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true,
    },
    {
      id: bridgeId,
      matches: [originPattern(host)],
      js: ['src/content/bridge.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);

  // Registration can silently no-op if the permission is wrong; verify it.
  const check = await chrome.scripting.getRegisteredContentScripts({ ids: [guardId, bridgeId] });
  if (check.length !== 2) throw new Error('registration-incomplete');
}

async function unregisterForHost(host) {
  const ids = [GUARD_ID + host, BRIDGE_ID + host];
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const present = existing.map((s) => s.id).filter((id) => ids.includes(id));
  if (present.length) await chrome.scripting.unregisterContentScripts({ ids: present });
}

/**
 * Storage, granted permissions and registered scripts can drift apart: the user
 * can revoke a host permission from brave://extensions and the stored entry
 * would then lie. This makes storage agree with reality.
 */
async function reconcile() {
  await loadCaches();
  const grantedSet = new Set((await chrome.permissions.getAll()).origins || []);
  const broadAccess = grantedSet.has('*://*/*');
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  let dirty = false;

  for (const host of Object.keys(hosts)) {
    if (!broadAccess && !grantedSet.has(originPattern(host))) {
      delete hosts[host];
      dirty = true;
      await unregisterForHost(host).catch(() => {});
      continue;
    }
    if (!registered.has(GUARD_ID + host) || !registered.has(BRIDGE_ID + host)) {
      await registerForHost(host).catch((error) => console.error('[thg] register failed', host, error));
    }
  }

  for (const id of registered) {
    const prefix = id.startsWith(GUARD_ID) ? GUARD_ID : id.startsWith(BRIDGE_ID) ? BRIDGE_ID : null;
    if (!prefix) continue;
    const host = id.slice(prefix.length);
    if (!hosts[host]) await unregisterForHost(host).catch(() => {});
  }

  if (dirty) await persistHosts();
}

/* -------------------------------------------------------------- tab tracking */

async function trackTab(tab) {
  if (!tab || tab.id == null) return;
  const host = hostOf(tab.url || tab.pendingUrl);
  if (host && hosts[host]) protectedTabHosts.set(tab.id, host);
  else protectedTabHosts.delete(tab.id);
}

async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) await trackTab(tab);

  try {
    const focused = await chrome.windows.getLastFocused({ populate: true });
    const active = (focused.tabs || []).find((tab) => tab.active);
    if (active) await noteFocus(active);
  } catch (_) {}
}

/**
 * Remembers the protected tab the user is looking at. Orphan popups carry no
 * opener, so focus is the only thing that can attribute them to a site.
 */
async function noteFocus(tab) {
  if (!tab || tab.id == null) return;
  const host = hostOf(tab.url || tab.pendingUrl);
  if (host && hosts[host]) {
    lastFocusedProtected = { tabId: tab.id, host, windowId: tab.windowId };
  }
}

async function updateFocus(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await noteFocus(tab);
  } catch (_) {}
}

function allowTokenFresh(tabId, url) {
  if (tabId == null) return false;

  const token = allowTokens.get(tabId);
  if (!token) return false;
  if (Date.now() - token.ts > ALLOW_TTL_MS) return false;

  // Ctrl/Cmd/Shift/middle click: the user asked the browser for a tab, and the
  // destination is whatever they clicked, so no URL to compare against.
  if (token.any) return true;

  // A token only vouches for the exact URL the guard approved. Without this, a
  // stale token from a legitimate popup would legitimise an ad tab opened in the
  // same two-second window.
  if (!token.key || !url) return false;
  return token.key === urlKey(url);
}

/**
 * True when the user right-clicked this exact link shortly before the tab
 * appeared ("Open link in new tab", "Copy link address" then paste). Matching is
 * on origin + path + query so tracking parameters differing by a fragment still
 * count, but an unrelated ad URL never does.
 */
function intentMatches(tabId, url) {
  if (tabId == null) return false;
  const intent = intentTokens.get(tabId);
  if (!intent) return false;

  if (Date.now() - intent.ts > INTENT_TTL_MS) {
    intentTokens.delete(tabId);
    return false;
  }

  try {
    const wanted = new URL(intent.href);
    const actual = new URL(url);
    return (
      wanted.origin === actual.origin &&
      wanted.pathname === actual.pathname &&
      wanted.search === actual.search
    );
  } catch (_) {
    return false;
  }
}

/**
 * A tab that sat at about:blank for more than a moment was almost certainly
 * created by a human (Ctrl+T / Ctrl+N / new window) rather than by an ad, which
 * navigates within milliseconds.
 */
function looksManual(info) {
  return info.startedBlank === true && Date.now() - info.ts >= MANUAL_BLANK_MS;
}

async function getWindowType(windowId) {
  if (windowId == null) return 'normal';
  if (windowTypes.has(windowId)) return windowTypes.get(windowId);

  try {
    const win = await chrome.windows.get(windowId);
    const type = win && win.type ? win.type : 'normal';
    windowTypes.set(windowId, type);
    return type;
  } catch (_) {
    return 'normal';
  }
}

function urlKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname + parsed.search;
  } catch (_) {
    return '';
  }
}

/**
 * True once when the user asked to reopen a specific blocked URL (block-log
 * "Buka" button). Consumed on match so an ad cannot ride along on retry.
 */
function takeManualOpen(url) {
  const key = urlKey(url);
  if (!key) return false;

  const ts = manualUrls.get(key);
  if (ts === undefined) return false;

  manualUrls.delete(key);
  return Date.now() - ts <= MANUAL_OPEN_TTL_MS;
}

/** Closes the offending tab and records why. */
async function closeHijack(tabId, trail) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    return false; // already gone
  }

  await appendLog({
    host: trail.host,
    kind: 'tab',
    reason: trail.reason,
    url: trail.url,
    newHost: trail.newHost,
    ts: Date.now(),
  });

  if (hosts[trail.host]) {
    hosts[trail.host].blocks = (hosts[trail.host].blocks || 0) + 1;
    await persistHosts();
  }

  if (trail.badgeTabId != null) {
    try {
      const current = Number(await chrome.action.getBadgeText({ tabId: trail.badgeTabId })) || 0;
      await chrome.action.setBadgeText({ tabId: trail.badgeTabId, text: String(current + 1) });
      await chrome.action.setBadgeBackgroundColor({ tabId: trail.badgeTabId, color: '#c0392b' });
    } catch (_) {}
  }

  return true;
}

function finishDiag(tabId, info, verdict, extra) {
  pendingCreations.delete(tabId);
  return appendDiag({
    ts: Date.now(),
    tabId,
    openerTabId: info.openerTabId ?? null,
    newHost: extra && extra.newHost,
    openerHost: extra && extra.openerHost,
    url: info.url,
    active: info.active,
    verdict,
  });
}

/**
 * A tab we allowed to exist is not automatically innocent: `window.open(
 * 'about:blank')` followed by `w.location = adUrl` is the standard evasion.
 * Keep such tabs under surveillance for a few seconds.
 */
function watchTab(tabId, host) {
  if (tabId == null || !host) return;
  watchedTabs.set(tabId, { host, ts: Date.now() });
}

async function evaluateRedirect(tabId, url) {
  const watched = watchedTabs.get(tabId);
  if (!watched) return;

  if (Date.now() - watched.ts > REDIRECT_WINDOW_MS) {
    watchedTabs.delete(tabId);
    return;
  }

  const newHost = hostOf(url);
  if (!newHost) return;
  if (sameSite(newHost, watched.host)) return;
  if (hosts[newHost]) return;
  if (isExcepted(newHost)) return;

  watchedTabs.delete(tabId);
  await appendDiag({
    ts: Date.now(),
    tabId,
    openerHost: watched.host,
    newHost,
    url,
    verdict: 'blocked-redirect',
  });
  await closeHijack(tabId, {
    host: watched.host,
    reason: 'cross-domain-redirect',
    url,
    newHost,
  });
}

/**
 * Verdicts where the user personally asked for the tab (paste/typed, or
 * right-click). Whatever those redirect to is their business, so they must never
 * be pulled into redirect surveillance.
 */
const USER_DECLARED_VERDICTS = new Set(['allowed-manual-navigation', 'allowed-context-menu']);

function isStrictHost(host) {
  return Boolean(host && hosts[host] && hosts[host].mode === 'strict');
}

function allowVerdict(tabId, info, verdict, openerHost, newHost, watchHost) {
  finishDiag(tabId, info, verdict, { newHost, openerHost });

  // Redirect surveillance is a strict-mode tool. In balanced mode cross-domain
  // navigation is already allowed after a real click, so policing the hop that
  // follows would just undo that promise (e.g. file-host -> video-host).
  if (USER_DECLARED_VERDICTS.has(verdict) || !isStrictHost(openerHost)) return;

  // Watch the destination, not the opener: the tab already left the opener's
  // site by design, so a further hop is what deserves scrutiny.
  watchTab(tabId, watchHost !== undefined ? watchHost : openerHost);
}

/**
 * A tab with no opener can still be an ad popup: networks use `noopener` on
 * purpose. Attribute it by focus instead — if the user is looking at a protected
 * tab and a new window appears in a *different* window, that is not something
 * they did in the current window (Ctrl+T and "open link in new tab" stay in the
 * same window, so they are never touched by this rule).
 */
async function evaluateOrphan(tabId, info, newHost) {
  const focus = lastFocusedProtected;
  if (!focus) return finishDiag(tabId, info, 'no-protected-opener', { newHost });

  if (allowTokenFresh(focus.tabId, info.url)) {
    return allowVerdict(tabId, info, 'allowed-by-page-guard', focus.host, newHost);
  }
  if (sameSite(newHost, focus.host)) {
    return allowVerdict(tabId, info, 'same-site', focus.host, newHost);
  }
  if (hosts[newHost]) return allowVerdict(tabId, info, 'protected-host', focus.host, newHost);
  if (isExcepted(newHost)) return allowVerdict(tabId, info, 'exception', focus.host, newHost);

  if (info.windowId != null && info.windowId === focus.windowId) {
    // Same window as the protected tab: could be Ctrl+T or a context-menu
    // action. Leave it alone rather than risk closing a deliberate navigation.
    return finishDiag(tabId, info, 'skipped-same-window', { newHost, openerHost: focus.host });
  }

  finishDiag(tabId, info, 'blocked-orphan-popup', { newHost, openerHost: focus.host });
  await closeHijack(tabId, {
    host: focus.host,
    reason: 'cross-domain-popup',
    url: info.url,
    newHost,
    badgeTabId: focus.tabId,
  });
}

/**
 * Decides the fate of one newly created tab.
 * Returns early when the URL is not known yet; the caller relies on
 * tabs.onUpdated to call us again with a real URL.
 */
async function evaluateCreation(tabId) {
  const info = pendingCreations.get(tabId);
  if (!info || !info.url) return;

  const newHost = hostOf(info.url);
  if (!newHost) {
    // Keep watching: about:blank popups are the usual vehicle for an ad tab.
    // Give up only after the grace period so the map cannot grow forever.
    if (Date.now() - info.ts <= EMPTY_URL_GRACE_MS) return;
    return finishDiag(tabId, info, 'skip-empty-url', {});
  }

  const focusHost = (lastFocusedProtected && lastFocusedProtected.host) || '';

  // Explicit user action: reopened from the block log.
  if (takeManualOpen(info.url)) {
    allowVerdict(tabId, info, 'allowed-manual-navigation', focusHost, newHost, newHost);
    return;
  }

  const openerHost = info.openerTabId != null ? protectedTabHosts.get(info.openerTabId) : undefined;
  const windowType = await getWindowType(info.windowId);

  /**
   * The "it sat blank for a while" rule only holds for the shapes a human can
   * actually produce: a tab with no protected opener (Ctrl+T) or a normal
   * window (Ctrl+N). An ad popup is either spawned by the page (so it has an
   * opener) or lives in a popup-type window — and it can simply *wait* before
   * filling itself, which is exactly what the earlier version missed.
   */
  const humanShaped = !openerHost && windowType !== 'popup';

  if (looksManual(info) && humanShaped) {
    allowVerdict(tabId, info, 'allowed-manual-navigation', focusHost, newHost, newHost);
    return;
  }

  const latePopup = looksManual(info) && !humanShaped;

  if (!openerHost) return evaluateOrphan(tabId, info, newHost);

  // Right-click on the exact link: deliberate, and impossible for an ad script
  // to forge. This is what makes "Open link in new tab" work again.
  if (intentMatches(info.openerTabId, info.url)) {
    allowVerdict(tabId, info, 'allowed-context-menu', openerHost, newHost, newHost);
    return;
  }

  let verdict;
  if (allowTokenFresh(info.openerTabId, info.url)) verdict = 'allowed-by-page-guard';
  else if (sameSite(newHost, openerHost)) verdict = 'same-site';
  else if (hosts[newHost]) verdict = 'protected-host';
  else if (isExcepted(newHost)) verdict = 'exception';
  else verdict = 'blocked-cross-domain';

  if (verdict !== 'blocked-cross-domain') {
    allowVerdict(tabId, info, verdict, openerHost, newHost);
    return;
  }

  finishDiag(tabId, info, latePopup ? 'blocked-late-popup' : verdict, { newHost, openerHost });
  await closeHijack(tabId, {
    host: openerHost,
    reason: latePopup ? 'late-popup' : 'cross-domain-tab',
    url: info.url,
    newHost,
    badgeTabId: info.openerTabId,
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null) return;
  const initialUrl = tab.pendingUrl || tab.url || '';
  pendingCreations.set(tab.id, {
    ts: Date.now(),
    openerTabId: tab.openerTabId ?? null,
    windowId: tab.windowId ?? null,
    active: tab.active !== false,
    url: initialUrl,
    startedBlank: !initialUrl || initialUrl === 'about:blank',
  });
  trackTab(tab).catch(() => {});
  evaluateCreation(tab.id).catch((error) => console.error('[thg] evaluate failed', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    const pending = pendingCreations.get(tabId);
    if (pending) {
      const url = changeInfo.url || tab.url || tab.pendingUrl || '';
      if (url) pending.url = url;
      evaluateCreation(tabId).catch((error) => console.error('[thg] evaluate failed', error));
    }
  }
  if (changeInfo.url) {
    evaluateRedirect(tabId, changeInfo.url).catch((error) => console.error('[thg] redirect check failed', error));
  }
  if (tab) trackTab(tab).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => {
      trackTab(tab).catch(() => {});
      noteFocus(tab).catch(() => {});
    })
    .catch(() => {});
  if (windowId != null) updateFocus(windowId).catch(() => {});
});

// Focus is how orphan popups (no openerTabId) get attributed to a site.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  updateFocus(windowId).catch(() => {});
});

chrome.windows.onRemoved.addListener((windowId) => {
  windowTypes.delete(windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  protectedTabHosts.delete(tabId);
  allowTokens.delete(tabId);
  pendingCreations.delete(tabId);
  watchedTabs.delete(tabId);
  intentTokens.delete(tabId);
  if (lastFocusedProtected && lastFocusedProtected.tabId === tabId) lastFocusedProtected = null;
});

/* ----------------------------------------------------------------- commands */

async function protectHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, error: 'invalid-host' };

  const granted = await hasOriginGranted(host);
  if (!granted) return { ok: false, error: 'permission-missing' };

  if (!hosts[host]) hosts[host] = { host, armedAt: Date.now(), blocks: 0, mode: DEFAULT_MODE, exceptions: [] };
  await persistHosts();

  try {
    await registerForHost(host);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, host };
}

async function unprotectHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, error: 'invalid-host' };

  delete hosts[host];
  await persistHosts();
  await unregisterForHost(host).catch(() => {});
  // Host access itself is declared in the manifest and cannot be revoked here;
  // only the per-host content scripts are removed.

  for (const [tabId, tabHost] of protectedTabHosts) {
    if (tabHost === host) protectedTabHosts.delete(tabId);
  }
  return { ok: true, host };
}

async function recordBlock(message, sender) {
  const host = normalizeHost(message.host) || '';
  if (!host) return { ok: false, error: 'missing-host' };

  await appendLog({
    host,
    kind: message.kind || 'window.open',
    reason: message.reason || 'unknown',
    url: message.url || '',
    ts: Number(message.ts) || Date.now(),
  });

  if (hosts[host]) {
    hosts[host].blocks = (hosts[host].blocks || 0) + 1;
    await persistHosts();
  }

  if (sender.tab && sender.tab.id != null) {
    try {
      const tabId = sender.tab.id;
      const current = Number(await chrome.action.getBadgeText({ tabId })) || 0;
      await chrome.action.setBadgeText({ tabId, text: String(current + 1) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
    } catch (_) {}
  }

  return { ok: true };
}

async function recordPing(message) {
  const host = normalizeHost(message.host);
  if (!host) return { ok: true };

  const seen = await getSeen();
  const entry = seen[host] || { count: 0, lastTs: 0 };
  entry.count += 1;
  entry.lastTs = Date.now();
  seen[host] = entry;
  await chrome.storage.local.set({ [SEEN_KEY]: seen });
  return { ok: true };
}

async function importState(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'invalid-data' };

  let imported = 0;
  for (const rawHost of Object.keys(data.hosts || {})) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    if (!(await hasOriginGranted(host))) continue;
    if (!hosts[host]) {
      hosts[host] = {
        host,
        armedAt: Date.now(),
        blocks: 0,
        mode: data.hosts[rawHost] && data.hosts[rawHost].mode === 'strict' ? 'strict' : DEFAULT_MODE,
        exceptions: [],
      };
    }
    await registerForHost(host).catch(() => {});
    imported += 1;
  }
  await persistHosts();

  if (Array.isArray(data.exceptions)) {
    exceptions = data.exceptions.map(normalizeHost).filter(Boolean);
    await persistExceptions();
  }
  if (Array.isArray(data.log)) {
    await chrome.storage.local.set({ [LOG_KEY]: data.log.slice(0, LOG_LIMIT) });
  }
  return { ok: true, imported };
}

const HANDLERS = {
  'thg:state': async () => ({
    ok: true,
    hosts,
    log: await getLog(),
    exceptions,
    seen: await getSeen(),
    diag: (await getDiag()).slice(0, 40),
  }),
  'thg:config': async (message) => {
    const host = normalizeHost(message.host) || '';
    const entry = hosts[host];
    return {
      ok: true,
      exceptions,
      host,
      mode: entry && entry.mode ? entry.mode : DEFAULT_MODE,
    };
  },  'thg:setMode': async (message) => {
    const host = normalizeHost(message.host);
    const mode = message.mode === 'strict' ? 'strict' : 'balanced';
    if (!host || !hosts[host]) return { ok: false, error: 'unknown-host' };
    hosts[host].mode = mode;
    await persistHosts();
    return { ok: true, host, mode };
  },
  'thg:openBlocked': async (message) => {
    let parsed;
    try {
      parsed = new URL(String(message.url || ''));
    } catch (_) {
      return { ok: false, error: 'invalid-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'invalid-url' };
    }

    // Register the bypass BEFORE creating the tab: onCreated can fire first.
    const key = urlKey(parsed.href);
    if (key) manualUrls.set(key, Date.now());

    await chrome.tabs.create({ url: parsed.href, active: true });
    return { ok: true, url: parsed.href };
  },
  'thg:protect': async (message) => protectHost(message.host),
  'thg:unprotect': async (message) => unprotectHost(message.host),
  'thg:block': async (message, sender) => recordBlock(message, sender),
  'thg:allow': async (message, sender) => {
    if (!sender.tab || sender.tab.id == null) return { ok: true };

    const raw = String(message.url || '');
    const any = raw === '__modifier__';
    allowTokens.set(sender.tab.id, {
      ts: Date.now(),
      any,
      key: any ? '' : urlKey(raw),
    });
    return { ok: true };
  },
  'thg:intent': async (message, sender) => {
    if (sender.tab && sender.tab.id != null && message.href) {
      intentTokens.set(sender.tab.id, { href: String(message.href), ts: Date.now() });
    }
    return { ok: true };
  },
  'thg:ping': async (message) => recordPing(message),
  'thg:clearLog': async () => {
    await chrome.storage.local.set({ [LOG_KEY]: [], [DIAG_KEY]: [] });
    return { ok: true };
  },
  'thg:addException': async (message) => {
    const host = normalizeHost(message.host);
    if (!host) return { ok: false, error: 'invalid-host' };
    if (!exceptions.includes(host)) {
      exceptions.push(host);
      await persistExceptions();
    }
    return { ok: true, host };
  },
  'thg:removeException': async (message) => {
    exceptions = exceptions.filter((entry) => entry !== message.host);
    await persistExceptions();
    return { ok: true };
  },
  'thg:export': async () => ({
    ok: true,
    data: { hosts, exceptions, log: await getLog() },
  }),
  'thg:import': async (message) => importState(message.data),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('thg:')) return false;
  const handler = HANDLERS[message.type];
  if (!handler) return false;

  ensureBoot()
    .then(() => handler(message, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));

  return true; // keep the channel open for the async reply
});

/* -------------------------------------------------------------- lifecycle */

async function boot() {
  await loadCaches();
  const sync = await chrome.storage.sync.get(EXCEPTIONS_KEY);
  if (!Array.isArray(sync[EXCEPTIONS_KEY])) await persistExceptions();
  await reconcile();
  await refreshAllTabs();
}

/**
 * Every message handler needs the caches. A cold service worker used to answer
 * `thg:config` from an empty `hosts` object and fall back to DEFAULT_MODE, so a
 * strict site could be handed balanced config on its first load after a wake-up.
 * Gating on this promise removes that race.
 */
let bootPromise = null;

function ensureBoot() {
  if (!bootPromise) {
    bootPromise = boot().catch((error) => {
      console.error('[thg] boot failed', error);
    });
  }
  return bootPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureBoot();
});

chrome.runtime.onStartup.addListener(() => {
  ensureBoot();
});

chrome.permissions.onRemoved.addListener(() => {
  bootPromise = null;
  ensureBoot();
});

chrome.permissions.onAdded.addListener(() => {
  bootPromise = null;
  ensureBoot();
});

ensureBoot();
