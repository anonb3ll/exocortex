# Retention

Local capture is kept for a bounded window. Search and prune both honour
that window so a missed prune cannot resurrect expired rows on read.

## Intent

Cap IndexedDB growth, let the user choose how far back recall reaches,
and keep `exocortex_search_memory` / `exocortex_semantic_search` from
returning records older than the configured age even if
`pruneOldData()` has not run yet.

This is not LRU-by-count. Cutoff is wall-clock age against each table's
timestamp field.

The side panel has a **Keep history for** selector: 7 days (default),
30 days, 90 days or 1 year, stored as `exocortexRetentionDays` in
`chrome.storage.local`.

## Architecture

```
side panel selector
        │ chrome.storage.local.set({ exocortexRetentionDays })
        ▼
loadRetentionSetting()   service worker AND side panel, each on load
        │ setRetentionMaxAgeDays(7 | 30 | 90 | 365)
        ▼
getRetentionMaxAgeDays()
        │ in-process setter? → that value
        │ else EXOCORTEX_RETENTION_DAYS (MCP / Node only)
        │ else DEFAULT_RETENTION_MAX_AGE_DAYS (7)
        ▼
getRetentionCutoff(now) = now - days * 24h
        │
        ├ pruneOldData()     — SW install, SW startup, setting changed
        ├ searchBrowserMemory — skip page_text.parsedAt < cutoff
        └ hybridVectorSearch  — frames.timestamp >= cutoff (N ≤ 200)
```

| Piece | Path | Role |
|---|---|---|
| Policy | `src/lib/db.ts` | Days, cutoff, `pruneOldData()` |
| Setting | `src/lib/retention-setting.ts` | Storage key, allowed windows, load into the policy |
| Selector | `src/sidepanel/sidepanel.ts` / `.html` | Writes `exocortexRetentionDays` |
| Read path | `src/lib/browser-memory-search.ts` | Keyword search filters `parsedAt` |
| Read path | `src/lib/models/vector-search.ts` | Hybrid search filters `frames.timestamp` |
| Trigger | `src/background/service-worker.ts` | Load the setting, then prune: on install, on worker start, and when the setting changes |
| Session restore | `src/background/service-worker.ts` | `syncSessionState()` drops restored frames/sessions older than the cutoff |

## Defaults

| Source | Value | Where it applies |
|---|---|---|
| `DEFAULT_RETENTION_MAX_AGE_DAYS` | **7** | Extension, until the user picks another window |
| `exocortexRetentionDays` | `7`, `30`, `90` or `365` | Extension (`chrome.storage.local`); side-panel selector |
| `EXOCORTEX_RETENTION_DAYS` | positive number | MCP CLI / tests when no setter override |
| `setRetentionMaxAgeDays(n)` | `n > 0` or `null` | In-process only; `null` restores env/default |

Invalid env values (zero, negative, NaN, non-numeric) are ignored and
the 7-day default is used. `setRetentionMaxAgeDays(0)` throws. A stored
`exocortexRetentionDays` that is not one of the four offered windows is
read as 7.

## Changing the window

- **Longer** takes effect at once for search. It cannot bring back
  what an earlier, shorter window already pruned.
- **Shorter prunes immediately.** The service worker applies the new
  value and runs `pruneOldData()` in the same storage-change handler.
  This is the one retention action that deletes on demand; there is no
  undo.
- The service worker re-reads the setting before every install and
  startup prune. If `chrome.storage.local` cannot be read, that prune is
  **skipped**: pruning on the 7-day default after a storage error would
  delete months of history from a user who chose a year.
- A longer window means a larger IndexedDB. Hybrid search still scores
  only the 200 most recent frames inside the window.

## What prune deletes

`pruneOldData()` bulk-deletes rows **strictly older** than the cutoff
(`where(field).below(cutoff)`):

| Table | Timestamp field |
|---|---|
| `sessions` | `startTime` |
| `dwell_blocks` | `timestamp` |
| `page_text` | `parsedAt` |
| `cognitive_frames` | `timestampUtc` |
| `cognitive_checkpoints` | `timestampUtc` |
| `semantic_vault` | `timestampUtc` |
| `frames` | `timestamp` |
| `embeddings` | `createdAt` |
| `telemetry` | `timestamp` |
| `working_memory_stack` | `lastUpdatedUtc` |
| `anchors` | `createdAt` |
| `frame_visuals` | parent `frames` id (cascade by `frameId`) |

A 7-day-old row at the exact cutoff instant is kept. Read-path filters
use the same cutoff.

## Usage

In the loaded extension, pick the window in the side panel under
**Keep history for**. To change the MCP process window:

```bash
EXOCORTEX_RETENTION_DAYS=3 bun src/mcp/cli.ts
```

That env var does **not** reach the Chrome service worker, and the
side-panel setting does not reach the MCP process. They are two stores.

## Pitfalls

- **Two stores, two clocks.** The MCP CLI uses `fake-indexeddb` and is
  discarded on exit; Chrome IndexedDB is the durable store. Setting
  `EXOCORTEX_RETENTION_DAYS` on the CLI does not prune the extension.
- **Read filter ≠ prune.** Search hides expired rows immediately.
  Disk is reclaimed when the service worker starts, the extension is
  installed/updated, or the window is changed.
- **Every reading context loads the setting.** The policy value is
  module state, and the side panel runs its own search. Both it and
  the service worker call `loadRetentionSetting()`; a new extension
  page that queries Dexie must do the same or it filters on 7 days.
- **Dwell updates do not move a row's age.** A visit's rows keep the
  capture timestamp; later dwell updates raise `dwellTime` only.
- **MV3 workers restart often.** Startup prune is the normal reclaim
  path, not a rare maintenance job.
- **No MCP tool.** There is no `exocortex_set_retention` / prune tool.
  Agents cannot widen or disable the window over the bridge; only the
  side-panel selector changes it.
- **omaCortex keeps its own history.** Visits sent through the optional
  feed (`docs/omacortex-feed.md`) are not pruned by this window.
- **Desktop frames follow `frames.timestamp`.** A poller-written
  `desktop_window` row older than the window is excluded from hybrid
  search and deleted on prune like any other frame
  (`docs/desktop-ingest.md`). Those rows live in the MCP process Dexie
  unless a test wrote them into Chrome.
- **Session store is not IndexedDB.** After an MV3 worker restart the
  service worker reloads `activeAnchorFrame` / `activeSession` from
  `chrome.storage.session` (or `local`). Those objects skip
  `pruneOldData()`; `syncSessionState()` applies the same cutoff so a
  frame from before a long Chrome sleep cannot keep driving drift.
