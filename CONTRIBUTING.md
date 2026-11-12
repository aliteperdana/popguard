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
node --check src/page/guard.js
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
- `06-cross-domain.html` must be **blocked** in strict mode only.

## Ground rules

Each of these looks arbitrary until you know why. They exist because the
alternative was tried and produced a real bug.

- **`chrome.permissions.request()` stays in `src/ui/popup.js`.** Host access comes
  from `host_permissions` at install, so arming a site never prompts. Do not
  reintroduce `optional_host_permissions`.
- **`src/page/guard.js` runs in the MAIN world** and has no `chrome.*` access. All
  reporting goes through `postMessage` → `src/content/bridge.js`.
- **Allow tokens are bound to a URL key** (`origin + path + search`). A bare
  timestamp once let an ad reuse the approval meant for a legitimate popup.
- **Modes are per host and mean different things.** `balanced` lets real clicks
  leave the site; `strict` blocks every cross-domain tab unless excepted.
- **Redirect surveillance runs only in strict mode**, and never on tabs the user
  opened personally.
- **`window.open` must return an inert stub**, never `null`; sites call
  `popup.focus()` immediately.
- **No remote code, no telemetry, no bundler.** Everything ships in the package.

## Project layout

| Path | Role |
| --- | --- |
| `src/page/guard.js` | MAIN-world guard: `window.open`, `_blank` anchors, cross-domain policy |
| `src/content/bridge.js` | ISOLATED-world relay, config fetch, liveness ping |
| `src/background/sw.js` | Tab watchdog, host database, registrations, log, diagnostics |
| `src/ui/popup.*` | Shield state, blocked-today count, toggle, mode selector |
| `src/ui/options.*` | Hosts, exceptions, block log, tab diagnostics, backup |
| `test/fixtures/` | Six manual fixtures and a static server |
| `docs/preview/` | Static pages used to render README screenshots |

## Screenshots

`docs/preview/*.html` reuse the real `src/ui/*.css` with sample data. After
changing the popup or settings markup, update the preview pages and re-render
with headless Chrome (`--force-device-scale-factor=2`) into `docs/screenshots/`.
