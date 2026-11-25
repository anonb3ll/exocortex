---
date: 2026-07-25
source: anonb3ll
tags: [roadmap, exocortex, chrome-extension, second-brain, mcp]
---

# Project Exocortex — Strategic Architecture Roadmap

## Completed Milestones (Phases 1.0 – 3.4)
- **Phase 1.0 (MVP Sensor & Vault)**: Chrome Manifest V3 extension, DOM text extraction, privacy guard, Dexie.js (IndexedDB) local vault, popup & sidepanel layout.
- **Phase 2.0 (Cognitive Engine & MCP Bridge)**:
  - Mathematical telemetry model (continuous cognitive load, tab velocity penalty, context switch cost overhead, fatigue index).
  - 6 specialized in-browser agents (`StateObserver`, `TaxonomyAgent`, `DriftDetector`, `ContextAnchorAgent`, `LibrarianAgent`, `NeuroergonomicNudgeAgent`).
  - Interactive Sidepanel UI with real-time gauges, focus anchor cards, and working memory stack.
  - 20-tool bi-directional MCP Server Bridge (`src/mcp/`) running via native browser bridge / Bun stdio (count pinned by `tests/mcp-tool-surface.test.ts`; was 11 as of Phase 2.0, 16 as of 2026-08-07, 19 before `exocortex_get_bridge_status`).
- **Phase 3.1 (On-Device AI & Local Vector Engine — SHIPPED 2026-07-25; embedder promoted 2026-08-21)**:
  - Chrome `window.ai` (Gemini Nano) zero-shot taxonomy classification and page summarization with `capabilities.available === 'readily'` guardrail.
  - Offscreen Transformers.js v3 embedder (`@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`): WebGPU → WASM in Chrome, CPU under Bun/Node, labelled hash fallback last. See `docs/on-device-embeddings.md`.
  - Dexie.js v5 schema extension with Float32Array vector storage (`embeddings` table) and 7-day LRU retention.
  - Two-stage coarse-to-fine hybrid vector search ($N \le 200$ candidate filter + Float32 dot-product rescore).
  - Dynamic drift hysteresis (2-frame consecutive high-dwell gate $+ >15\text{s}$) and length-scaled sensitivity.
  - 2 new MCP tools (`exocortex_semantic_search`, `exocortex_summarize_page`).
- **Phase 3.2 (Multi-Modal Context Tracking & IDE/Desktop Ingestion — SHIPPED, commit `c4d1542`)**:
  - Desktop window ingest via MCP `exocortex_record_desktop_frame` (`src/lib/desktop-frame.ts`). The MCP CLI starts `startDesktopWindowPoller` by default (`EXOCORTEX_DESKTOP_POLLING=0` opts out); frames write to the CLI's in-process Dexie, not Chrome.
  - Multimodal page capture combining DOM structure, screenshot thumbnail, and vector embedding — shipped.
  - ✅ **On-screen OCR placeholder removed (task #296, merged 2026-08-07).** No OCR engine is shipped yet; visual frames intentionally yield no OCR text and are not embedded as if text existed. Implementing a real local OCR engine is a separate future capability, not an open correctness bug.
- **Phase 3.3 (Neuroergonomic Intervention Shield & Context Recovery — SHIPPED, commits `019fb50` / `cb36555`)**:
  - One-click "Context Recovery Kit" generator (`getContextRestorationKit`) — shipped.
  - Opt-in Focus Shield overlay (`focus_shield_enabled`), closed-shadow-DOM prompt, side-panel restore, MV3-persisted observer state — shipped. See README "Focus Shield workflow".
  - Non-destructive parking of known `Distraction / Rabbit Hole` tabs into `Exocortex — Parked Context` — shipped.
- **Phase 3.4 (Federated Knowledge Graph & Unified Agent Graph Alignment — SHIPPED for the sending half)**:
  - Federated KG → vault `Wiki/` aligner converting high-dwell research clusters into proposed Obsidian notes, honouring the write-dir allowlist and `locked: true` — shipped.
  - Graph edge mapping: `exocortex_project_task_reference` returns a contract-v1 `task_reference` edge. The receiver must still verify the task exists and is non-terminal.
  - ❌ **P2P sync between Exocortex local vault and unified-agent SQLite — struck, not deferred.** Explicitly prohibited ("no raw cross-device SQLite sharing," task #276). Cross-device state sharing goes through the typed projection contract, not raw SQLite.
- **Post-3.4, unroadmapped (shipped, add to record)**: sanitized telemetry export (`77e2087`), native browser/MCP bridge (`b54638a`) — including 3 fail-open bridge reliability fixes and a live-Chrome verification harness (unified-agent task #278, 2026-08-07).

---

## Open backlog (reconciled 2026-08-21)

Shipped since the 2026-08-12 note: Focus Shield overlay + tab parking
(`019fb50`, `cb36555`); `exocortex_project_task_reference`; Transformers.js
v3 live embedder (`7ac3c42`). Side panel also previews the mobile-slice
projection (task #462) — no iOS/watchOS binary in this repo.

Still open:

- Real on-screen OCR remains an explicitly unshipped capability; frames without OCR text must continue to be dropped from OCR indexing rather than receive fabricated text.
- WebGPU device path is implemented but not proven in this repo's Puppeteer Chromium (`navigator.gpu` absent). See `docs/on-device-embeddings.md`.

Shipped after this 2026-08-21 note (do not treat the bullets below as open work):

- Desktop poller started from `src/mcp/cli.ts` (`9829557`, task #674).
- Native bridge auto-starts (`0caf486`, task #660); `exocortex_get_bridge_status`.
- 7-day retention prune + read-path filter (`de9beed`, task #661). See `docs/retention.md`.

## Reconciliation note (2026-11-16)

Operator runbook for the shipped desktop poller / record tool that
still had no home: `docs/desktop-ingest.md`. README's "unbridged tools
can see poller frames" line was too broad — `exocortex_query_frames`
reads `cognitive_frames`, and desktop ingest never writes embeddings.

## Reconciliation note (2026-11-09)

Operator runbooks for two shipped surfaces that still had no home:

- `docs/federated-kg.md` — `exocortex_align_federated_kg` vault path,
  write-dir allowlist, CLI Dexie vs Chrome Librarian Vault.
- `docs/built-in-ai.md` — `window.ai.languageModel` gate vs regex
  taxonomy and MCP summarize truncation. The Phase 3.1 "Gemini Nano
  readily" bullet above is the capability check; dwell and the MCP CLI
  do not currently see `window`.

OCR and live WebGPU-in-CI remain unshipped, as above.

## Reconciliation note (2026-10-19)

Shipped after the 2026-09-14 operator-docs pass: live side-panel
semantic search (`b14c0b0`, task #1053); embedder-outage honesty on
that path (`c8c830b` / `#1082`); shared `isSearchQueryBlocked` on
panel, MCP `exocortex_semantic_search`, and mobile recall (`85cdc14`,
task #1167) — **not** on `exocortex_search_memory`. Operator runbook:
`docs/semantic-search.md`. Privacy-guard "mobile query only" language
was stale.

Python Exocortex Core (`src/exocortex_sdk/`, tasks #1046–#1048): Shape A
contract, `InMemoryCore`, hub existing-store seam (flagged off),
Citetrail consumer proof. Runbook: `docs/exocortex-sdk-core-contract.md`.

CI: `.github/workflows/ci.yml` still runs the xvfb B* form;
`.depot/workflows/ci.yml` is the same job mapped to
`depot-ubuntu-latest` (task #1235). Adversarial probes under `verify/`
are **not** in `bun run test` (`docs/verify.md`).

OCR and live WebGPU-in-CI remain unshipped, as above.

Draft docs PRs #62 and #63 covered the same catch-up and stayed
unmerged; this note is the landing on `main`.

## Reconciliation note (2026-09-14)

Operator runbooks added for the privacy hostname guard
(`docs/privacy-guard.md`) and native-host install/diagnostics
(`docs/native-bridge.md`). Capture remains off by default. OCR and
live WebGPU-in-CI remain unshipped, as above.

## Reconciliation note (2026-09-07)

Shipped after the 2026-08-31 docs pass (`509b95b`): CWS-required capture
consent. Browser dwell is **off by default** until the side-panel
**Local footprint capture** toggle writes `exocortexCaptureConsent`.
Operator runbook: `docs/capture-consent.md`. Historical bullets above
that say capture starts on install are stale.

## Reconciliation note (2026-08-31)

Operator docs (README, `USAGE.md`, `docs/retention.md`, this roadmap) were
stale on default-on bridge/poller, tool count (20), KG sanitization, and
B* opt-in (`EXOCORTEX_BROWSER_TESTS=1`). Capture notes above are historical;
verify behaviour against `src/mcp/cli.ts` and `tests/mcp-tool-surface.test.ts`.

## Reconciliation note (2026-08-07)
This doc was stale in both directions as of 2026-08-07: it still listed Phase 3.2 as "NEXT UP" and 3.3/3.4 as upcoming, when all three had already shipped, while simultaneously claiming deliverables within them that were never built. Corrected per task #277 (S0 baseline) and task #295 (this fix).
