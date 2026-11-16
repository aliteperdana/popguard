# Contributing

PopGuard is a Manifest V3 extension with **no build step**: edit the files, then
reload the extension. No dependencies, no bundler, no `node_modules`.

## Run it locally

1. Open `brave://extensions` or `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the repository root — the folder that
   contains `manifest.json`.
3. Open a site, click the PopGuard icon, switch it on, then **reload that page**.
   The guard is installed on page load, never retroactively.

Syntax gate — the browser is still the real verifier:

```powershell
node --check src/background/sw.js
node --check src/page/policy.js
node --check src/page/guard.js
node --check src/page/frame-guard.js
node --check src/content/bridge.js
node --check src/ui/popup.js
node --check src/ui/options.js
```

## Fixtures

```powershell
powershell -ExecutionPolicy Bypass -File test/serve.ps1
```

Open `http://localhost:8123/`, arm the `localhost` host, then reload the fixture
page. Serve them over `http://` — the extension has no file access by default, so
the guard never loads from `file://`.

Expected outcomes are listed in `test/fixtures/index.html`. Two of them form a
regression pair:

- `05-legit-oauth.html` must stay **allowed** (same-site popup from a real click).
- `06-cross-domain.html` must be **blocked** in both modes (`no-evidence`).

`07-iframe-popup.html` needs the server's second origin (`127.0.0.1`) and proves
the frame guard denies a pop-up before a tab exists. `08-same-site-redirect.html`
must show a tab that appears and is then closed (`blocked-redirect`, strict mode).

## Ground rules

Each of these looks arbitrary until you know why. They exist because the
alternative was tried and produced a real bug.

- **`chrome.permissions.request()` stays in `src/ui/popup.js`.** Host access comes
  from `host_permissions` at install, so arming a site never prompts. Do not
  reintroduce `optional_host_permissions`.
- **A trusted click is not evidence.** A pop-up that leaves the protected host is
  only allowed when the user clicked a link pointing at that destination
  (`matchesClicked` in `src/page/policy.js`). Ad buttons are trusted clicks too;
  reverting this re-opens the "every banner opens a tab" hole.
- **Only the protected document's clicks are evidence.** `isProtectedDocument()`
  gates `matchesClicked`. An ad iframe whose banner the user clicked matches its
  own href and would otherwise authorise its own tab — that was a real leak that
  logged nothing, because the guard "allowed" it.
- **`HTMLIFrameElement.prototype.contentWindow` is patched.** A fresh
  `about:blank` frame still holds the native `open`, so
  `frame.contentWindow.open.call(window, url)` bypasses `window.open` entirely.
  The getter hands back a window whose `open` is guarded. Removing it brings back
  a popup that produces no log line.
- **A blank pop-up is refused even after a click.** `window.open('about:blank')`
  is the same vector one step later: the page fills it with an ad a second later,
  and waiting for that is what still showed a tab. Legacy print windows are the
  accepted cost.
- **Frames learn about arming from their parent first, and from the service
  worker second.** `policy.js` relays `{type:'armed'}` down the frame tree; only a
  parent may arm a child. Without the relay the frame guard is inert for the first
  moments of an ad iframe's life — exactly when its pop-up fires.
- **The guard refuses; it does not close.** When `window.open` is refused, the
  real `window.open` is never called, so no tab is created. Returning the stub is
  the whole point — a tab that exists has already flashed.
- **Registration is not protection.** `src/page/frame-guard.js` is registered for
  `<all_urls>` in every frame, but it is inert until the service worker confirms
  the tab's **top** host is armed (`thg:config` → `armed`). Decisions are always
  relative to that top host, never to the frame's own origin.
- **`src/page/policy.js` runs in the MAIN world** and has no `chrome.*` access. All
  reporting goes through `postMessage` → `src/content/bridge.js`.
- **Allow tokens are bound to a URL key** (`origin + path + search`). A bare
  timestamp once let an ad reuse the approval meant for a legitimate popup.
- **Modes are per host and mean different things.** `balanced` lets a real click
  on a *link* leave the site; `strict` blocks every cross-domain tab unless
  excepted. Modes do not affect the `window.open` evidence rule.
- **Redirect surveillance runs only in strict mode**, and never on tabs the user
  opened personally. It listens on `webNavigation.onBeforeNavigate` so the ad page
  never loads.
- **`window.open` must return an inert stub**, never `null`; sites call
  `popup.focus()` immediately.
- **A notice is not a pop-up.** The only UI the guard adds is a small
  closed-shadow-root notice with "Open anyway" for the exact URL just refused.
  It exists because early refusal is aggressive; do not add confirmation dialogs.
- **No remote code, no telemetry, no bundler.** Everything ships in the package.

## Project layout

| Path | Role |
| --- | --- |
| `src/page/policy.js` | MAIN world: shared decisions, `window.open`/anchor patching |
| `src/page/guard.js` | Entry point for an armed host's top frames (fails closed) |
| `src/page/frame-guard.js` | Entry point for subframes on every site; inert until armed |
| `src/content/bridge.js` | ISOLATED world: relay, config, liveness ping, "Open anyway" notice |
| `src/background/sw.js` | Tab watchdog, host database, registrations, log, diagnostics |
| `src/ui/popup.*` | Shield state, blocked-today count, toggle, mode selector |
| `src/ui/options.*` | Hosts, exceptions, block log, tab diagnostics, notice toggle, backup |
| `test/fixtures/` | Eight manual fixtures and a static server |
| `docs/preview/` | Static pages used to render README screenshots |

## Screenshots

`docs/preview/*.html` reuse the real `src/ui/*.css` with sample data. After
changing the popup or settings markup, update the preview pages and re-render
with headless Chrome (`--force-device-scale-factor=2`) into `docs/screenshots/`.
