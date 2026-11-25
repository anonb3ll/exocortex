# Privacy Policy — Project Exocortex

Last updated: 2026-11-19

## Summary

Project Exocortex is local-first. All captured data — dwell checkpoints, page
text, vector embeddings, cognitive frames — is stored in your browser's local
storage (IndexedDB and `chrome.storage`). No data is sold, shared with third
parties, or transmitted off-device.

One optional setting, off by default, copies a small part of that data to
another program on the same computer; see "Optional omaCortex feed" below.

## What we collect (only with your explicit consent)

Capture is **off by default**. Only after you enable "Local footprint capture"
in the side panel does Exocortex record:

- **Web history (local only)** — URLs and titles of pages you dwell on, used to
  reconstruct working context. Stored in local IndexedDB; optionally written to
  your local Obsidian vault if you enable that integration.
- **User activity (local only)** — tab-switch timing used to compute a local
  cognitive-fatigue signal for Focus Shield.
- **Website content (local only)** — article text extracted for local search
  indexing and on-device vector embeddings (WebGPU/WASM, executed entirely in
  your browser).

## What never happens

- No page content, telemetry, or identifiers are transmitted to remote servers.
- The optional native-messaging bridge exchanges minimized query results with
  a local unified-agent process over localhost only — it is off unless you
  install and start that local server yourself.
- Data is never sold or used for advertising, creditworthiness, or unrelated
  purposes.

## Optional omaCortex feed

Off by default. If you install the separate omaCortex recorder on your computer
and turn on "Also send page titles to omaCortex" in the side panel, Exocortex
passes it, for each captured page: the page address with its query string
removed, the title, the site name, the author if the page states one, whether
it is a video or an article, and how long it was in the foreground. Page text,
excerpts, embeddings and search queries are never passed. The data goes to that
local program only, over Chrome native messaging; it does not leave your
device. What omaCortex then keeps is governed by omaCortex's own settings. See
`docs/omacortex-feed.md`.

## Retention

Captured records are kept for 7 days by default, then pruned automatically.
You can change this to 30 days, 90 days or 1 year in the side panel; choosing a
shorter period deletes older records immediately (see `docs/retention.md`).
Turning capture off stops capture in open tabs.

## Erasing your data

There is no in-extension deletion UI. To erase everything Exocortex has stored:

1. Remove the extension: `chrome://extensions` → Project Exocortex → Remove.
   Chrome deletes the extension's IndexedDB and storage with it.
2. If you enabled the Obsidian vault write, delete the notes it created under
   `Wiki/` in your vault (they are plain markdown files).
3. The local unified-agent socket holds no capture data; nothing to erase there.
4. If you turned on the omaCortex feed, the visits it received are stored by
   omaCortex, not by this extension; remove them with omaCortex's own tools.

## Contact

Open an issue at https://github.com/anonb3ll/exocortex or email
anonb3ll@pm.me.

Operator details for the capture blocklist (hostname substrings,
sanitization, vault export) are in `docs/privacy-guard.md`. That page
is engineering documentation, not a substitute for this policy.
