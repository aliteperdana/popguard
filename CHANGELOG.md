# Changelog

## 0.3.0 — 2026-11-14

**No tab at all**

- A cross-domain `window.open` is now refused *inside* `window.open` unless the
  user clicked a link pointing at that destination. The real `window.open` is
  never called, so no tab is created — nothing flashes and closes.
- The same rule applies in both modes. Modes now govern `_blank` link clicks
  only; scripted pop-ups always need evidence.
- A small notice offers **Open anyway** for the exact URL that was refused. It
  can be switched off in settings.
- Cross-origin ad iframes are covered: a frame guard runs in every frame of every
  site, but stays inert until the tab's top host is enabled. The armed decision is
  relayed down the frame tree so a freshly created ad iframe is covered before its
  first click.
- A blank `about:blank` pop-up is refused too — it was the last way an ad tab
  still appeared before being closed.
- A form with `target=_blank` to another site is blocked in strict mode; it never
  passes through `window.open` or a link click.
- A clean `window.open` grabbed from a freshly created iframe is guarded too: the
  `contentWindow` getter hands back a window whose `open` is patched, so that
  trick no longer produces an unlogged popup.

**Faster backstop**

- `webNavigation` supplies the destination URL at tab creation, so the decision
  no longer waits for `tabs.onUpdated`.
- Redirect surveillance now listens on `onBeforeNavigate`, so a same-site banner
  that redirects to an ad is closed before the ad page is requested.

## 0.2.0 — 2026-11-12

First public release.

**Protection**

- Per-site arming with exact hostname matching; only enabled hosts get the
  guard script.
- Two modes per site: **Balanced** (real clicks may leave the site) and
  **Strict** (every cross-domain tab is blocked unless excepted).
- Page guard blocks pop-ups without user interaction, pop-ups triggered by
  keyboard, invisible `_blank` anchors, and — in strict mode — cross-domain
  targets.
- Service-worker watchdog closes cross-domain tabs, pop-ups without an opener,
  blank pop-ups filled after a delay, and cross-domain hops in strict mode.
- Cross-domain exceptions for sign-in and payment providers.

**Diagnostics**

- Block log with reason per entry, plus "Open" and "Allow site" actions.
- Tab diagnostics table showing opener, target and verdict for every new tab.
- Liveness counter that reveals when a page's CSP prevents the guard script from
  loading.

**UI**

- Popup with shield state, blocked-today counter, per-site toggle and mode
  selector.
- Settings page with protected sites, exceptions, block log, diagnostics and
  JSON backup/restore.
