# Capture consent

Browser dwell capture is **off by default**. The content-script timer
must not record web history, user activity, or page text until the user
flips **Local footprint capture** in the side panel. That is a Chrome
Web Store requirement, not a preference.

## Intent

Fail closed. Absent, false, or unreadable consent means no dwell timer
and no `DWELL_RECORD`. Focus Shield states and MCP `consentBasis`
metadata do not count as consent.

This gate is **Chrome-profile only**. MCP `exocortex_record_frame` /
`exocortex_record_desktop_frame` write the CLI process's in-process
Dexie and never read `exocortexCaptureConsent`.

## Architecture

```
side panel toggle
        │ chrome.storage.local.set({ exocortexCaptureConsent })
        ▼
content script startDwellTimer()
        │ loadConsent() — re-read every start (fail-closed)
        │ generation bump so a superseded start cannot arm a timer
        ▼
5s dwell → Readability + page metadata → DWELL_RECORD → service worker
        │ foreground clock keeps running
        ▼
hidden / pagehide / SPA URL change → DWELL_UPDATE (cumulative ms)
```

Both messages are defined once, in `src/lib/dwell-message.ts`, and both
sides build and read them through that module.

| Piece | Path | Role |
|---|---|---|
| Gate | `src/content/tracker.ts` | `loadConsent()` before every timer; no dwell update without consent |
| Contract | `src/lib/dwell-message.ts` | `DWELL_RECORD` / `DWELL_UPDATE` payloads and their readers |
| Metadata | `src/content/page-metadata.ts` | Site name, author, content kind from `<meta>` / JSON-LD |
| Toggle | `src/sidepanel/sidepanel.ts` / `.html` | Writes `exocortexCaptureConsent` |
| Store | `chrome.storage.local` | Default `false`; no other writer in `src/` |
| B* seed | `tests/fixtures/browser-launch.ts` | `seedCaptureConsent()` |

`executeDwellCapture()` does **not** re-check the flag. Consent is
enforced when a timer is armed. Unit tests that call the capture
function directly bypass the gate on purpose.

## Defaults

| Key | Default | Notes |
|---|---|---|
| `exocortexCaptureConsent` | `false` | Side-panel checkbox is the only UI |
| Storage-read error | treat as false | Catch in `loadConsent()` |
| Missing key | false | `chrome.storage.local.get` default |

There is no popup toggle and no MCP tool. The service worker reads this
key for one purpose only: the optional omaCortex feed is sent only while
capture consent is on (`docs/omacortex-feed.md`).

## Dwell

The capture fires once, after 5 s. Dwell does not stop there: the
tracker keeps a foreground clock (time the page is visible and has not
lost focus; focus moving into an embedded frame on the same page does
not count as losing it) and reports the cumulative total with a `DWELL_UPDATE` when
the page is hidden, unloaded (`pagehide`), or its SPA URL changes, and
on a blur once 15 s of new dwell has built up. The update carries the
record's `capturedAt`, so the service worker raises `dwellTime` on the
rows it already wrote (`dwell_blocks`, `frames`, `cognitive_frames`)
instead of creating a second visit.

Updates carry no page text and no title. Nothing is sent before the
initial capture, on a blocked URL, or without consent.

## Page metadata

Captured with the record, from what the page declares about itself:

| Field | Source, in order |
|---|---|
| Site name | `og:site_name`, Readability site name, hostname |
| Author | On a YouTube watch page, the channel name. Otherwise `meta[name=author]`, `article:author` (when it is a name, not a URL), JSON-LD `author.name`, Readability byline |
| Kind | `video`, `article` or `page`, from the URL, `og:type` and JSON-LD `@type` |

No additional page text is read for this. The fields are stored on the
`frames` row (`siteName`, `byline`, `contentKind`) and, for site name
and author, on `page_text`.

## What still runs without consent

The content script is injected on `<all_urls>` (minus Chrome's own
restricted pages). It still:

- attaches Focus Shield overlay listeners on non-blocked pages
- observes the DOM for SPA URL changes (250ms debounce)
- logs that it is active on the hostname

None of that writes dwell, page text, or embeddings. Those start only
after a consented, unblocked, visible tab reaches 5s
(`DWELL_THRESHOLD_MS`).

## Usage

1. Load `dist/` unpacked.
2. Open the side panel (popup **Open Side Panel** button, or Chrome's
   side-panel menu). `chrome.sidePanel.open()` needs a user gesture.
3. Enable **Local footprint capture**. The help text is the in-product
   disclosure.
4. Dwell ≥ 5s on a non-blocked page.

Turning the toggle off takes effect at once in open tabs: the tracker
listens for `storage.onChanged`, clears an armed timer and stops
reporting dwell for the current visit. Every `startDwellTimer()`
(visibility, focus, `pageshow`, SPA URL change) also re-reads the flag,
so a tab that missed the event still stops at its next start signal.
Turning it on starts the clock on a page that is already in view.

Existing IndexedDB rows stay until retention prune
(`docs/retention.md`).

## Tests

B* suites that exercise real capture must seed the flag. Without it
the dwell pipeline is silent and the test looks like a broken tracker:

```ts
await seedCaptureConsent(browser);
```

`tests/smoke-capture-recall.test.ts` and
`tests/smoke-privacy-guard.test.ts` already do this.
`tests/tracker-dwell-navigation.test.ts` mocks
`exocortexCaptureConsent: true`.

## Pitfalls

- **Empty popup is expected on first load.** "Browse pages for >5s"
  is incomplete — capture is still off until the side-panel toggle.
- **Not MCP `consentBasis`.** That field is projection/ingest metadata
  (`standing_local_capture`, etc.). It does not open the Chrome gate.
- **Not Focus Shield.** `focus_shield_enabled` only controls the
  overlay. Shield evaluation still needs consented dwells to classify
  tabs.
- **Two stores.** Enabling capture in Chrome does not populate the
  MCP CLI's `fake-indexeddb`. Bridged search sees Chrome rows; the
  poller and `record_*` tools do not (`docs/desktop-ingest.md`).
- **SPA debounce is 250ms.** Rapid `pushState` bursts are coalesced
  before `handleUrlChange()` resets the dwell clock.
- **Blocked hosts never capture.** Hostname substrings `bank`,
  `login`, and `auth` fail closed even with consent on.
  `docs/privacy-guard.md`.
