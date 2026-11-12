# AGENTS.md

Brave/Chromium MV3 extension that blocks unwanted new tabs on **sites the user
explicitly arms**. No build step, no dependencies, no bundler.

Resume point: **`progress.md`** (Indonesian) holds milestone status, field-test
findings, the verification checklist, and every gotcha found so far. Read it
before changing behaviour.

**Language split:** all user-facing strings are **English** (popup, options,
manifest). `progress.md` stays Indonesian because the user reads it. Reason and
verdict labels live in both `popup.js` and `options.js` as English maps — keep
them identical. Product name is **PopGuard**; icons live in `icons/` and are
generated from `icons/logo.png`.

## Defence model — two layers, the second one matters most

1. `src/page/guard.js` (MAIN world) patches `window.open`, guards invisible
   `_blank` anchors and blocks cross-domain popups.
2. `src/background/sw.js` closes cross-domain tabs via `tabs.onCreated`.

**Never treat the page guard as the real defence.** It silently fails when the
page CSP blocks MAIN-world scripts, when the popup originates in a cross-origin
ad iframe, or when the page restores its own `window.open`. The service worker
watchdog is the only layer that always runs; fixes for "tab still opened" belong
there.

Symptom worth knowing: an **empty block log plus many popups** means the guard
never loaded, not that it was too lenient. `bridge.js` sends a `thg:ping` per
page load, surfaced in the popup as "Penjaga terdeteksi…". Use it to tell
"guard absent" from "guard permissive".

## Do not "improve" these

- **No build tooling.** Files load from the repo root via `brave://extensions` →
  Load unpacked. A bundler or `dist/` breaks every manifest path.
- **Host access comes from the manifest, not from a runtime prompt.**
  `host_permissions: ["*://*/*"]` is granted at install, so arming a site never
  shows a dialog and `registerContentScripts` works immediately. Do not
  reintroduce `optional_host_permissions` + `permissions.request` — that is what
  forced a per-site prompt. The cost is the broad install warning, which is the
  same trade other ad blockers make; only armed hosts ever get scripts.
  Consequence: `permissions.getAll()` reports `*://*/*` rather than the per-host
  pattern, so any origin check must accept the broad pattern too (see
  `hasOriginGranted`) — the naive check silently deleted every host entry.
  `permissions.remove` in `unprotectHost` must stay deleted; manifest-granted
  hosts cannot be revoked at runtime.
- **`src/page/guard.js` has no `chrome.*` access** (MAIN world). All reporting
  goes `postMessage` → `src/content/bridge.js`. Any `chrome.` call added here
  silently does nothing.
- **`window.open` must return the inert stub**, never `null`; sites call
  `popup.focus()` immediately and throw otherwise.
- **Host matching in the database is exact hostname.** `www.example.com` and
  `example.com` are separate entries by design.
- **A trusted click alone is not sufficient.** On armed sites a popup must also
  stay same-site or target an exception. Reverting this re-opens the ad-click
  hole that the 2026-11-12 field test exposed.
- **Scope is unwanted new tabs.** Same-tab redirect hijacking is out of scope.
- **Silent close, no toast.** Do not add confirmation prompts; the block log and
  diagnostics table are the feedback channel.

## Architecture facts not obvious from filenames

- Layer order: page guard decides → bridge relays → service worker persists,
  registers scripts, logs. The SW never decides from gesture knowledge; it
  accepts an **allow token** (`thg:allow`, 2s TTL) that the guard emits for
  popups it deliberately let through.
- **An allow token is bound to a URL key** (`origin + path + search`). The guard
  always sends an absolute URL; `__modifier__` is the only unrestricted form
  (Ctrl/Cmd/Shift/middle click). Without the binding, a token from a legitimate
  popup legitimised an ad tab opened within the same 2s window — that was a real
  field bug.
- **Message handlers run behind `ensureBoot()`.** On a cold service worker the
  `hosts` cache is empty, so `thg:config` used to fall back to `DEFAULT_MODE`
  and hand *balanced* config to a *strict* site on its first load after wake-up.
  Never answer a handler straight from `hosts`/`exceptions` without that gate.
- Watchdog verdicts (`storage.local` → `diagLog`) are a closed set:
  `blocked-cross-domain`, `blocked-orphan-popup`, `blocked-redirect`,
  `blocked-late-popup`, `allowed-context-menu`, `allowed-manual-navigation`,
  `allowed-by-page-guard`, `same-site`, `protected-host`, `exception`,
  `no-protected-opener`, `skipped-same-window`, `skip-empty-url`.
  `protectedTabHosts`, `allowTokens`, `pendingCreations`, `watchedTabs`,
  `intentTokens`, `windowTypes` and `lastFocusedProtected` are in-memory only and
  rebuild on SW boot.
- **A blank destination is never vouched for.** `window.open('about:blank')`
  (and `window.open('')`, which `new URL` resolves to the page itself — see
  `isBlankTarget` in the guard) must not emit an allow token, and its tab stays
  in `pendingCreations` up to `EMPTY_URL_GRACE_MS` until a real URL arrives. This
  was the actual ad-popup vector in the field test: blank popup, then navigate.
- Redirect surveillance is **strict-mode only**, and it skips tabs the user
  opened personally (`allowed-manual-navigation`, `allowed-context-menu`). In
  balanced mode a hop like `file-host -> video-host` is normal and must survive;
  policing it contradicts the whole point of balanced mode. Do not restore the
  unconditional `watchTab` call in `allowVerdict` — that was a real false
  positive on forum file hosts.
- **Modes are per host and chosen by the user.** `mode: 'strict'` makes the page
  guard block every cross-domain popup/anchor; `'balanced'` lets real clicks
  leave the site and relies on the watchdog to catch unvouched tabs. The guard
  starts at `'strict'` until config arrives (fail closed), then adopts the host's
  mode. A mode change needs a page reload because the config is read on load.
- **Deliberate cross-domain navigation has explicit escape hatches**; do not
  remove them without expecting false positives. A trusted **right click** on a
  link records the href (`intentTokens`, 5s) and lets the matching tab through —
  right-click produces no `click` event, so this is the only way "Open link in
  new tab" can work. Middle/Ctrl/Shift click already emit an allow token. A tab
  that is **blank for >1.5s** before it is filled counts as human-driven **only
  when it has no protected opener and is not a popup-type window** — an ad can
  simply wait before filling itself, so time alone proves nothing. `humanShaped`
  in `evaluateCreation` encodes that; do not widen it back to a bare timing check.
  Blocks failing that test are logged as `blocked-late-popup` / `late-popup`.
  A plain left click on a cross-domain `_blank` link stays blocked **in strict
  mode only**; in balanced mode it is allowed. That is the line between a video
  site and a forum — do not collapse the two.
- Tabs with **no `openerTabId`** (ad popups use `noopener`) are attributed by
  focus: `lastFocusedProtected` plus "different window id than the focused
  protected tab". The same-window case is deliberately exempt, because Ctrl+T and
  "open link in new tab" land there; closing them would be a false positive.
- A tab's URL is often unknown in `onCreated`; the decision waits for
  `tabs.onUpdated`. Empty URLs are skipped, not blocked.
- Content scripts are registered per host with `document_start` +
  `persistAcrossSessions`, and `registerForHost` re-reads the registration to
  verify it actually stuck. Storage, granted permissions and registered scripts
  drift apart; `reconcile()` reconciles all three and runs on boot.
- Storage split: `protectedHosts` + `globalExceptions` in `storage.sync`;
  `blockLog`, `diagLog`, `guardSeen` in `storage.local` (sync quota is ~8KB/item).
- Reason codes (`no-activation`, `keyboard`, `untrusted-event`, `hidden-anchor`,
  `cross-domain`, `cross-domain-anchor`, `cross-domain-tab`,
  `cross-domain-popup`, `cross-domain-redirect`, `late-popup`) are mapped to
  English labels in **both** `popup.js` and `options.js`. Keep them in sync.

## Commands

```powershell
# syntax gate (no test runner; the browser is the real verifier)
node --check src/background/sw.js
node --check src/page/guard.js
node --check src/content/bridge.js
node --check src/ui/popup.js
node --check src/ui/options.js

# fixtures on http://localhost:8123/
powershell -ExecutionPolicy Bypass -File test/serve.ps1
```

## Verification

Manual only. Six fixtures; expected outcomes are listed in
`test/fixtures/index.html`. `05-legit-oauth.html` must stay **allowed** (same-site
popup) and `06-cross-domain.html` must be **blocked** — those two form the
regression pair. If 05 breaks, the guard is too aggressive and will break real
navigation; if 06 passes through, the ad-click hole is back.

Two things invalidate a run:

- Fixtures opened via `file://` — no file access, guard never loads.
- Testing without reloading after arming — arming is not retroactive.

When a hijack still gets through, read the **Diagnostik tab** table in the
options page before touching code: it says whether the blocked tab had a
protected opener, and which verdict let it through.
