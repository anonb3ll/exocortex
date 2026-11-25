# omaCortex feed

Optional, **off by default**. When on, each page Exocortex captures is
also reported to [omaCortex](https://github.com/anonb3ll/omaCortex), the
OS-level activity recorder, so the visit outlives this extension's
retention window (`docs/retention.md`).

It sends page *titles*, not page *content*. No page text, excerpt,
embedding or search query is ever part of a message.

## Intent

Exocortex knows what a tab is (title, site, author, video or article)
and how long it was really in front of you. omaCortex keeps a durable
local SQLite history of activity across the whole desktop but sees a
browser only as a window title. The feed joins the two on this machine.

Nothing leaves the computer: the message goes over Chrome native
messaging to a local process the user installed.

## Architecture

```
content script  DWELL_RECORD / DWELL_UPDATE   (consent + privacy guard)
        ▼
service worker  captureContext() succeeded?   → visit is eligible
        │ feed toggle on AND capture consent on?
        ▼
buildOmacortexPageMessage()                   src/lib/omacortex-feed.ts
        │ chrome.runtime.sendNativeMessage("io.github.anonb3ll.omacortex", msg)
        ▼
omaCortex native host  → upsert on (url, at)
```

| Piece | Path | Role |
|---|---|---|
| Builder + sender | `src/lib/omacortex-feed.ts` | The only place a message is assembled |
| Trigger | `src/background/service-worker.ts` | After capture, and on each dwell update |
| Toggle + status | `src/sidepanel/sidepanel.ts` / `.html` | Writes `exocortexOmacortexFeed`; probes status |
| Tests | `tests/omacortex-feed.test.ts` | URL minimization, upsert identity, quiet missing host |

## Turning it on

1. Install omaCortex and register its browser host for **this**
   extension's ID (the loaded ID from `chrome://extensions`):

   ```bash
   omacortex browser install --extension-id <this extension's id>
   ```

2. In the side panel, turn on **Local footprint capture** if it is not
   already on, then **Also send page titles to omaCortex**.

The label beside the toggle shows what the host answered:

| Label | Meaning |
|---|---|
| `off` | Toggle is off. The host is not contacted at all. |
| `connected` | Host answered and omaCortex is recording. |
| `paused` | Host answered; omaCortex is paused and stores nothing. |
| `connected, recording off` | Host answered; omaCortex recording is not enabled. |
| `not installed` | No host registered for this extension ID. |
| `not responding` | Host answered with an error or something unreadable. |

The status probe runs when the panel opens with the toggle on, and when
the toggle is switched on. It is one request, never a poll.

## What is sent (contract version 1)

One message per visit update: once when the page is captured (after 5 s
of dwell), and again each time the tracker reports more dwell — the page
was hidden, unloaded, or its SPA URL changed.

```json
{
  "v": 1,
  "type": "page",
  "source": "exocortex",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rust in 100 Seconds - YouTube",
  "site": "YouTube",
  "author": "Fireship",
  "content": "video",
  "seconds": 754.3,
  "at": 1800000000.123
}
```

| Field | Rule |
|---|---|
| `url` | Capture-safe `http(s)` only; paths that look like credential URLs are refused. Query and fragment are removed, except a capture-safe `v` parameter on `youtube.com/watch`. |
| `title` | Scrubbed, whitespace collapsed, at most 300 characters. |
| `site` | `og:site_name`, else the hostname. Omitted if unknown. |
| `author` | Author, or the channel on a video page. Omitted if unknown. |
| `content` | `"article"`, `"video"` or `"page"`. |
| `seconds` | Cumulative foreground dwell for this visit. Grows across updates. |
| `at` | Visit start, epoch seconds (float). **Identical on every update for the visit.** |

The feed scrubs title, site and author before sending, including when a dwell
update reloads metadata from a row written before capture-time scrubbing. The
host upserts on `(url, at)`, so repeated updates raise one row's `seconds`
rather than adding rows.

Replies:

```json
{ "ok": true, "stored": true,  "recording": true,  "version": "0.3.0" }
{ "ok": true, "stored": false, "recording": false, "reason": "paused", "version": "0.3.0" }
{ "ok": false, "error": "…" }
```

`stored: false` with a reason (`paused`, `excluded`, `too short`) is a
normal answer, not an error.

Status probe: `{ "v": 1, "type": "status" }` →
`{ "ok": true, "consent": true, "paused": false, "recording": true, "version": "0.3.0" }`.

## What is never sent

- Page text, the Readability excerpt, or any summary.
- Embeddings.
- Search queries typed into the side panel or sent over MCP.
- Query strings and fragments (apart from YouTube's `v`).
- Any URL the privacy guard blocks (`docs/privacy-guard.md`), any
  non-`http(s)` URL, or any visit that was not captured.

`buildOmacortexPageMessage` has no parameter that could carry page text,
and a test asserts the built message has exactly the fields above.

## Gates

A visit is sent only when **all** of these hold:

1. **Local footprint capture** is on (`exocortexCaptureConsent`).
2. The URL passed the privacy guard and `captureContext()` stored it.
3. **Also send page titles to omaCortex** is on
   (`exocortexOmacortexFeed`).

Turning either toggle off stops the feed at the next message. Rows
already stored by omaCortex are omaCortex's to manage.

## Missing host

Most users will never install omaCortex. A missing host is the expected
state and is handled quietly:

- `chrome.runtime.lastError` is always read, so Chrome reports no
  unchecked error.
- Nothing is logged.
- The failed message is dropped, not queued or retried.
- Nothing more is sent for 5 minutes (`FEED_UNAVAILABLE_BACKOFF_MS`).
  The first visit after that is the next attempt. Switching the toggle
  off and on clears the wait.
- Capture, search and the MCP bridge are unaffected.

## Pitfalls

- **Not the MCP bridge.** That is `io.exocortex.mcp_bridge`, a long-lived
  port (`docs/native-bridge.md`). This is a different host
  (`io.github.anonb3ll.omacortex`) and one-shot messages. Installing one
  does not install the other.
- **Extension ID must match.** An unpacked extension's ID changes when
  `dist/` moves; re-run `omacortex browser install` with the new ID.
- **Path stays in the URL.** Only the query and fragment are stripped. A
  site that puts a secret in the path sends it; so does the local Dexie
  row. Hosts on the capture blocklist are never sent.
- **Titles can be sensitive.** That is why this is opt-in and separate
  from capture consent.
- **No backfill.** Only visits captured while the toggle is on are sent.
- **A crash loses the tail.** The last dwell update is sent when a page
  is hidden or unloaded. If the browser is killed, omaCortex keeps the
  last total it was told.
