# Privacy

PopGuard runs entirely on your device. It has no server, no analytics and no
telemetry, and it never sends your browsing data anywhere.

## What is stored

| Data | Where | Why |
| --- | --- | --- |
| Protected host names and their mode | `chrome.storage.sync` | Restores your site list. Sync storage is tied to your browser profile, so it may follow your browser account. |
| Cross-domain exceptions | `chrome.storage.sync` | Lets sign-in and payment domains open a tab. |
| Block log (blocked URLs, reasons, timestamps) | `chrome.storage.local` | Lets you inspect and reopen a blocked link. Capped at 300 entries. |
| Tab diagnostics (opener and target host, decision) | `chrome.storage.local` | Explains why a tab was or was not closed. Capped at 120 entries. |
| Guard liveness counters per host | `chrome.storage.local` | Tells you whether the page script actually loaded. |

All of it stays on the device. Uninstalling the extension removes it.

## What is not done

- No data is transmitted to the developer or any third party.
- No analytics, crash reporting or usage tracking.
- No remote code. Everything the extension runs ships inside the package.
- No reading of page content. The guard only observes click and key events on
  hosts you enabled, and the tab URLs needed to decide whether to close a tab.
- No selling or sharing of data.

## Clearing the data

- **Block log and diagnostics:** Settings → *Clear log*.
- **Everything:** remove every site from Settings, or uninstall the extension.
