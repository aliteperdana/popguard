# Changelog

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
