# Changelog

All notable changes to Exocortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

No CHANGELOG and no git tags existed before this file — the stated reason
unified-agent task #373's Tier 4 roadmap drifted three phases before anyone
noticed (roadmap item 5.5). `[0.1.0]` below is a retrospective summary of
everything shipped to `main` before this file existed, reconstructed from
`git log`; entries from here forward are written at merge time.

## [Unreleased]

### Fixed

- Stored dwell, capture time, site name and byline were all wrong: the
  tracker sent `dwellDurationMs` / `capturedAt` while the service worker
  read `dwellTime` / `timestamp` / `byline` / `siteName`, so every dwell
  was the 5000 ms default, every timestamp was message-receive time and
  site/byline were empty. Both sides now use one typed definition
  (`src/lib/dwell-message.ts`).
- A typed search with no lexical hit and no real query vector returned
  every recent page ranked by recency and dwell. It now returns nothing.
- The taxonomy matched `x.com` as a URL substring, classifying
  netflix.com, dropbox.com and any URL mentioning a social site as a
  distraction. Sites are matched on the parsed hostname.
- Page titles crossed the native bridge inside `userState`: the
  classifier copies the title into `primaryFocusEntity` and the excerpt
  into `workingStateSummary`. Values that repeat the frame's own title
  or excerpt are replaced at the bridge boundary (`docs/native-bridge.md`).
- The native bridge client gave up permanently after three reconnects.
  It now tries once more on later activity, at most once a minute.

### Added

- Desktop-ingest operator runbook (`docs/desktop-ingest.md`): the
  CLI active-window poller and `exocortex_record_desktop_frame` write
  MCP-process `db.frames` (`sourceType: "desktop_window"`), not Chrome;
  `exocortex_query_frames` will not list them; unbridged semantic
  search is lexical because no embeddings are stored.
- Federated KG operator runbook (`docs/federated-kg.md`):
  `exocortex_align_federated_kg` reads MCP-process Dexie only (not
  Chrome Librarian Vault, not desktop-poller `db.frames`), honouring
  `UA_VAULT_PATH` / `UA_VAULT_WRITE_DIRS`, `locked: true`, and
  human-authoritative existing notes.
- Chrome Prompt API runbook (`docs/built-in-ai.md`): dwell taxonomy is
  the hostname regex because the service worker has no `window`; MCP
  `exocortex_summarize_page` truncates CLI `page_text` rather than
  calling Gemini Nano.
- Real dwell: the tracker keeps a foreground clock after the 5s capture
  and sends cumulative `DWELL_UPDATE`s on hide, unload and SPA URL
  change; the service worker raises dwell on the visit's existing rows.
- Page metadata on captured frames: site name, author (channel on
  YouTube) and a `video` / `article` / `page` kind, read from `<meta>`
  and JSON-LD only. A YouTube watch page is named by its video instead
  of "Social Feed".
- Side panel: every timestamp shows its date (`Today 14:05`,
  `Yesterday 09:12`, `Nov 12 16:40`); result rows show site, author and
  kind as plain text.
- Retention selector in the side panel (7 / 30 / 90 / 365 days, default
  7). Shortening prunes immediately. `docs/retention.md`.
- Optional, off-by-default feed of page titles to the local omaCortex
  recorder over native messaging. `docs/omacortex-feed.md`.
- Side-panel operator runbook (`docs/sidepanel.md`): one search box
  drives two contracts (hybrid timeline with URLs vs sanitized mobile
  recall), Librarian Vault is Chrome Dexie last-5 (not MCP
  `exocortex_search_semantic_vault`), and the neuroergonomic banner is
  not Focus Shield.
- Live side-panel semantic search (`searchPanelMemory` on
  `#search-input`): query privacy gate, `matchKind` badges, and a
  labelled lexical banner when the query embedder is down.
  Operator runbook: `docs/semantic-search.md`.
- Shared `isSearchQueryBlocked` on panel, MCP
  `exocortex_semantic_search` (tool + bridge validator + service
  worker), and mobile recall. `exocortex_search_memory` remains
  unguarded keyword search. Operator runbook: `docs/privacy-guard.md`.
- Python Exocortex Core SDK (`src/exocortex_sdk/`): Shape A protocol,
  `InMemoryCore`, optional hub existing-store adapter
  (`EXOCORTEX_SDK_HUB_STORE=1`, loopback, writes refuse-closed), and a
  Citetrail sqlite consumer proof (`examples/citetrail_consumer/`).
  Contract: `docs/exocortex-sdk-core-contract.md`.
- CWS-required capture consent: dwell recording is **off by default**.
  The side-panel **Local footprint capture** toggle writes
  `exocortexCaptureConsent`; the content script re-reads it fail-closed
  on every timer start. Operator runbook: `docs/capture-consent.md`.
  Store listing draft: `CHROMEWEBSTORE.md`. Privacy policy:
  `docs/PRIVACY.md`.
- Popup **Open Side Panel** button — `chrome.sidePanel.open()` is
  gesture-gated; this is the supported entrypoint.
- Configurable capture retention (default 7 days): `pruneOldData()` on
  service-worker install/start, plus read-path filters in
  `searchBrowserMemory` and `hybridVectorSearch`.
  `EXOCORTEX_RETENTION_DAYS` applies to the MCP / Node process only.
  Operator runbook: `docs/retention.md`.
- `exocortex_get_bridge_status`, a CLI-side diagnostic for socket listen
  state, peer connection, and the bridge-backed tool list.
- The MCP CLI starts the native-bridge Unix socket **by default**
  (`EXOCORTEX_NATIVE_BRIDGE=0` opts out). Bridged tools fail closed until
  the extension connects rather than answering from the empty harness DB.
- The MCP CLI starts the desktop active-window poller **by default**
  (`EXOCORTEX_DESKTOP_POLLING=0` opts out). Frames write to the process's
  in-process Dexie, not the Chrome profile.
- The offscreen embedding path now uses Transformers.js v3, preferring WebGPU
  in Chrome and falling back to WASM; the deterministic hash vector remains a
  labelled last resort when model execution is unavailable.

- Opt-in Focus Shield overlay workflow with persisted `focus_shield_enabled`
  configuration, context restoration, and non-destructive grouping of known
  distraction tabs. The overlay is delivered by the content script and never runs
  on blocked URLs.
- `exocortex_project_task_reference`, a live-bridge-capable contract-v1 projector
  for privacy-minimised browsing-context edges to unified-agent tasks. The receiver
  remains responsible for task existence and terminal-state checks.
- Reconciled completion specification at `docs/spec-fully-working-web-extension-2026-08-12.md`.
- `exocortex_open_memory` and opaque memory handles. `exocortex_search_memory`
  now returns `{parsedAt, score, handle}` across the bridge; the handle is a
  local row id (never derived from the URL) that only the issuing browser can
  resolve, so an agent can act on a memory it is not permitted to read.
- Embedding provenance (`EmbeddingRecord.source`: `model` | `fallback`) and
  per-result `matchKind` on semantic search, so a real MiniLM comparison is
  distinguishable from lexical ranking.
- `exocortex_project_focus_anchor` added to the documented tool list — the
  surface has been 18 tools since `5666e61`; the README said sixteen.

### Fixed

- Cognitive frames created on the dwell path now stamp `timestampUtc` with the
  capture time shared with the dwell row, so the side-panel mobile glance no
  longer prefers an older page whose embedding finished after a newer dwell.
- Native-bridge operator docs instruct allow-listing the **loaded** unpacked
  extension ID (same discovery the live-browser suite uses); packing alone does
  not retarget a running unpacked instance.
- A persistently failing WebGPU backend is demoted for the offscreen process
  lifetime so later embeds skip straight to WASM instead of re-burning the
  15s timeout every capture.
- Docs no longer claim every fallback/empty embedding is persisted, or that the
  mobile query guard fails closed on general banking/credential language — both
  describe the narrower real behavior.
- Operator docs name which eleven MCP tools are live over the native bridge
  (the other eight stay ephemeral even when the bridge is connected), document
  `exocortex_open_memory`'s `rate_limited` status and 5/60s cap, and add a
  Focus Shield runbook (`docs/focus-shield.md`) covering fatigue math,
  parking rules, and MV3 persistence.
- Operator docs catch up to default-on bridge and desktop poller, 20 MCP
  tools (`exocortex_get_bridge_status`), 7-day retention, federated-KG
  excerpt/URL sanitization, and B* opt-in via `EXOCORTEX_BROWSER_TESTS=1`.
- Operator docs add a privacy-guard runbook (hostname substring
  blocklist, URL/DOM sanitization, shared query vs capture guards)
  and a native-bridge operator runbook (host wrapper, loaded
  extension ID, `GET_BRIDGE_HEALTH` vs `exocortex_get_bridge_status`,
  MCP env vars). CWS listing text now names the real parked-group
  title and capture-consent storage use.
- Operator docs catch up side-panel semantic search vs MCP outage
  behaviour, the shared (not mobile-only) query gate, the Python
  Core SDK run path, Depot CI mapping (`.depot/workflows/ci.yml`),
  and the opt-in `verify/` adversarial probes (`docs/verify.md`).
- Federated KG vault writes sanitize excerpts (secrets, JWTs, API keys,
  SSN/CC) and omit blocked or non-http(s) URLs instead of dumping raw
  capture onto disk.
- The agent guardrail file no longer claims the MCP-facing search
  boundary is `{parsedAt, score}` only — handles cross too.

- Focus Shield restoration no longer sends context prompts to page content. The
  page overlay uses a closed shadow root and opens the extension-owned side panel
  for restoration; observer state, tab classifications, and intervention timing
  survive MV3 worker restarts, stale sessions reset after prolonged inactivity,
  and interventions are revalidated against the active tab before delivery.
- Focus Shield now refreshes an already-open side panel when Restore is clicked,
  and its config loading, persistence wrappers, active-tab revalidation, and
  side-panel context request flow have direct unit coverage.
- **The on-device embedding pipeline never ran in Chrome.** The shipped manifest
  (`public/manifest.json`) omitted the `offscreen` permission, so
  `chrome.offscreen` was undefined and every embedding silently resolved to `[]`.
  A stale duplicate manifest at the repo root declared it, hiding the defect from
  inspection. Also adds the `wasm-unsafe-eval` CSP that ONNX Runtime requires.
- Drift detection failed open on empty vectors: `[]` is truthy, so it reached
  `cosineDistance`, which answers 0.0 — read as "identical content". A dead
  embedding pipeline therefore presented as perfect focus.
- The MCP stdio loop split each chunk independently, so a request arriving in two
  pieces produced no response and no error and hung the client. Unknown methods
  were likewise answered with silence rather than `-32601`.
- A second bridge connection silently displaced the first, stranding its
  in-flight requests until timeout.
- `hybridVectorSearch` reused `dwell_blocks` primary keys as frame ids, attaching
  unrelated records' embeddings to fallback candidates.
- URL-only hits in `searchBrowserMemory` scored 0 and sorted below every other
  match.
- The native bridge protocol is now v4; bridge clients that do not understand the
  task-reference request fail closed instead of accepting a partial contract.

### Changed

- Service-worker session clocks (`activeAnchorFrame`, `activeNudge`,
  `activeSession`) persist across MV3 restarts via
  `chrome.storage.session` (falls back to `local`). Restored frames
  older than the retention cutoff are dropped.
- SPA URL observer in the content script is debounced (250ms).
- Native-bridge request handlers run asynchronously so a slow tool
  cannot block the port listener.
- Unused `scripting` permission removed from the shipped manifest.
- The suite now covers 223 tests, including Focus Shield tab-safety and task-edge
  projection contracts. Run under `xvfb-run -a bun test` to prove the real Chrome
  extension path on a headless host.
- L1 contract now asserts that every `chrome.*` API used in `src/` has a declared
  permission, that extension pages may execute Wasm, and that `dist/manifest.json`
  matches `public/manifest.json` with no root copy.
- Tool descriptions for `exocortex_semantic_search` and
  `exocortex_search_semantic_vault` describe what they do. The former advertised
  "BM25 keyword rescoring", a term that appeared nowhere in the codebase except
  that string.

## [0.1.0] - 2026-08-11

### Added

- Manifest V3 Chrome extension scaffold: sensor layer, privacy guard
  (URL/domain blocklist), and a Dexie.js local vault (Phase 1).
- Cognitive engine, agent layer (context-anchor, drift-detector, taxonomy,
  state-observer, librarian), sidepanel UI, and the first MCP server bridge
  (Phase 2).
- On-device AI / WASM embedding pipeline for local semantic search
  (Phase 3.1).
- Multi-modal context tracking and native desktop-window ingestion
  (Phase 3.2).
- Neuroergonomic focus shield: soft nudges on detected context drift
  (Phase 3.3).
- Federated knowledge-graph alignment, writing Exocortex entities into the
  Obsidian vault's Wiki layer as interlinked markdown (Phase 3.4).
- Sanitized cognitive/fatigue telemetry export for cross-device sync
  (Decision 2026-07-29 Option B) — excludes DOM, page titles, URLs, and
  clean-text excerpts by construction.
- Native browser <-> MCP-process bridge over a private Unix socket
  (`EXOCORTEX_NATIVE_BRIDGE=1`): the first tool to cross it live was
  `exocortex_search_memory`, minimized to match metadata only. Every MCP
  tool response is now labelled `live` or `ephemeral` so an agent can tell
  "the browser has no such memory" from "this process cannot see your
  browser at all" (`src/mcp/source-envelope.ts`).
- Exocortex -> unified-agent projection contract v1 (unified-agent task
  #279, gate G2): the focus-anchor projector, the sending half — an
  allowlist-only, minimising transform with no MCP tool wired to it yet at
  this point in history (contract-first by design; see
  `unified_agent/docs/exocortex-projection-contract-v1.md`).

### Fixed

- Content-script build and PNG icon bundling so `chrome://extensions` "Load
  unpacked" actually works.
- `fake-indexeddb` no longer leaks into the shipped service-worker bundle.
- The offscreen OCR stub no longer stores placeholder text as if it were
  real captured page content.
- The MCP tool surface and response-provenance labelling, after a regression
  left some tools undispatchable.

### Changed

- README brought up to the shipped architecture; a stale roadmap doc and a
  closed contract-hole claim (#212) were reconciled against the live repo
  state rather than left to drift further.
