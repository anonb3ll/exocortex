# On-device embeddings

Live path for local MiniLM vectors. Page text, dwell events, and search
queries never leave the browser: the embedder runs in the extension
offscreen document. Chrome Prompt API taxonomy/summarize (a separate
`window.ai` gate, usually closed in the service worker and MCP CLI):
`docs/built-in-ai.md`.

This is the current architecture. The 2026-08-20 WebGPU proof slice
(`docs/webgpu-embedding-proof-slice-2026-08-20.md`) is historical
evidence that the ladder works; it is not the operator guide.

## Intent

Produce a 384-d sentence embedding for captured page text and for
query-time recall (`exocortex_semantic_search` and the side-panel
search box), with an honest label when the model cannot run.
Downstream consumers that reason about *meaning* (semantic search,
drift detection, cognitive-frame `vectorAnchor`) must refuse fallback
vectors rather than treat a hash bag-of-words as MiniLM. Panel vs MCP
outage behaviour: `docs/semantic-search.md`.

## Architecture

```
content script (consent + 5s dwell)
        │ loadConsent() fail-closed — docs/capture-consent.md
        │ DWELL_RECORD
        ▼
service worker  ──requestVectorEmbedding()──►  offscreen document
        │                                       embedWithFallback()
        │                                       @huggingface/transformers v3
        ▼                                       Xenova/all-MiniLM-L6-v2
Dexie: frames + embeddings (source: model|fallback)
        │
        ▼
hybridVectorSearch / drift detector (model vectors only)
```

| Piece | Path | Role |
|---|---|---|
| Offscreen worker | `src/offscreen/offscreen.ts` | Handles `GENERATE_EMBEDDING` and `PROCESS_VISUAL_FRAME` |
| Shared embedder | `src/lib/models/webgpu-embedder.ts` | Device ladder, timeouts, 384-d check |
| Hash fallback | `src/lib/models/hash-fallback.ts` | Deterministic last resort when the model throws |
| Capture | `src/background/service-worker.ts` | Dwell → embed → Dexie; query embed for MCP `semantic_search` |
| Panel query | `src/sidepanel/semantic-search.ts` | `requestPanelEmbedding` rejects unless `source === "model"` |
| Ranking | `src/lib/models/vector-search.ts` | Cosine rescore only on `source === "model"` |

Manifest requirements (gated by `tests/manifest-artifact-contract.test.ts`):

- `offscreen` permission — without it `chrome.offscreen` is undefined and
  every embedding fails closed.
- CSP `script-src 'self' 'wasm-unsafe-eval'` — ONNX Runtime Wasm will
  not instantiate under MV3's default CSP.

## Fallback ladder

`fallbackLadder()` is runtime-dependent. Transformers.js v3 ships two
ONNX bundles with different device sets:

| Runtime | How it is detected | Devices tried |
|---|---|---|
| Browser / offscreen / worker | `window` or `importScripts` | `webgpu` (if `navigator.gpu` exists) → `wasm` |
| Bun / Node (tests, benchmark) | neither of the above | `cpu` only |

`wasm` and `webgpu` are onnxruntime-web providers. Passing them to the
Node bundle throws `Unsupported device`. The module picks the ladder for
the runtime it is actually in; it does not assume Wasm is a universal
floor.

`runtimeLadder()` is that raw list. `fallbackLadder()` is the same list
after process-lifetime demotions: if a higher rung constructs a pipeline
and then fails inference (device loss, 15s timeout), `demoteBackend()`
drops it so later captures skip straight to the next rung instead of
re-burning the timeout. If demoting would empty the ladder, the original
floor is kept (`applyDemotions`). Demotions live in the offscreen
document's JS heap — reloading the extension or recreating that document
clears them. `resetEmbedderRuntimeState()` is a test helper, not an
operator API.

When every rung of that ladder fails, the offscreen worker stores
`computeFallbackVector(text)` and tags `source: "fallback"`. Empty input
never reaches the model: the worker returns a 384-d zero vector labelled
`fallback`.

## Provenance

`EmbeddingRecord.source` is `"model"` or `"fallback"`. Rows written
before `source` existed are treated as untrusted (`!== "model"`), not as
model vectors. That filter lives in `hybridVectorSearch`; Dexie
migration v7 also stamps legacy rows at rest.

| Consumer | Model vector | Fallback / empty / unknown |
|---|---|---|
| `exocortex_semantic_search` | Cosine rescore; `matchKind: "vector"` | Lexical token overlap; `cosineSimilarity: null` |
| Cognitive-frame `vectorAnchor` | Stored on the frame | Omitted (`undefined`) |
| Drift detector | Compared via `hasComparableVectors` | `vectorSignalAvailable: false` |
| Dexie `embeddings` table | Persisted | Only 384-dimensional dwell-path fallbacks are persisted and tagged for diagnostics. Empty vectors (offscreen unavailable / `sendMessage` failure) and query-time fallbacks are not written. |

## Constraints

| Limit | Value | Where |
|---|---|---|
| Model | `Xenova/all-MiniLM-L6-v2` | `webgpu-embedder.ts` |
| Dimension | 384; other widths throw | same |
| Input truncation | 8000 characters | `MAX_INPUT_CHARS` |
| Load + inference timeout | 15s each | `EMBED_TIMEOUT_MS` |
| Dwell before capture | 5s | `src/content/tracker.ts` |
| Vector ranking floor | cosine ≥ 0.35 beats lexical | `VECTOR_RELEVANCE_FLOOR` |
| Blend weights | 0.6 similarity + 0.25 recency + 0.15 dwell | `vector-search.ts` |
| Bridge deadline for `semantic_search` | 30s (default tools are 2s) | `src/bridge/protocol.ts` |
| First model fetch | Hugging Face Hub (`env.allowLocalModels = false`) | cold start |

Timed-out inferences still dispose the ONNX tensor when they eventually
settle, so a stuck WebGPU/Wasm call cannot leak heap in the long-running
offscreen document.

**Capture clock.** The dwell path stamps `dwell_blocks.timestamp`,
`cognitive_frames.timestampUtc`, `frames.timestamp`, and
`embeddings.createdAt` with the dwell payload's `timestamp` (fall back:
`Date.now()` at message receipt). Embedding and taxonomy can finish
seconds later; freshness and the side-panel mobile glance compare those
shared activity times, not "when MiniLM returned". MCP
`exocortex_record_frame` does not pass `timestampUtc`, so those frames
still use wall-clock completion time.

Visual frames (`PROCESS_VISUAL_FRAME`) downsample to 1280px WebP. OCR
is not shipped: `extractOcrTextFromImageData` returns `""`, so visual
frames are not embedded as if they had text.

## Usage

Capture runs only after **Local footprint capture** is enabled and a
non-blocked tab dwells 5s. In the side panel, type in `#search-input`
(empty input restores the chronological timeline). Semantic search from
the live bridge:

```bash
bun src/mcp/cli.ts
# native bridge is on by default; EXOCORTEX_NATIVE_BRIDGE=0 for ephemeral-only
# then call exocortex_semantic_search with { "query": "..." }
```

Check `matchKind` on every MCP hit. `vector` means a real MiniLM comparison;
`lexical` means token overlap against title/url/summary. Panel cards show
the same distinction as `vector · cos 0.xx` vs `lexical` badges.

CPU-only benchmark (Bun cannot exercise WebGPU or Wasm):

```bash
bun run scripts/benchmark-webgpu-embeddings.ts
```

Writes `docs/benchmarks/webgpu-embedding-<date>.json`. WebGPU and Wasm
legs are labelled `NOT-REPRODUCED` in this environment on purpose.

## Pitfalls

- **Consent off means no embeddings.** The offscreen path starts from
  `DWELL_RECORD`. Until `exocortexCaptureConsent` is true, the ladder
  never runs (`docs/capture-consent.md`).
- **`bun test` vs `bun run test`.** `package.json` `pretest` builds
  `dist/`. Direct `bun test` skips that hook; L1 contract tests fail on
  a fresh checkout until `bun run build` has run. CI uses
  `EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run test`. The B* layer
  skips unless that env var is set; a live desktop `DISPLAY` is not
  enough (and must not launch headed Chrome on the operator session).
- **Cold start looks like a hung search.** The first `semantic_search`
  after worker start creates the offscreen document and downloads/loads
  MiniLM. The bridge allows 30s for that tool; others stay at 2s. The
  side panel shows "Semantic search unavailable — showing lexical
  matches" if that query embed fails; MCP has no equivalent banner.
- **Panel `requestPanelEmbedding` is fail-closed on fallback.** A
  `source !== "model"` response is a throw, not a silent `ok`. The UI
  banner path injects `source: "fallback"` on purpose. P9 in
  `verify/adversarial-probes.test.ts` injects that fallback dep and is
  not live wiring (`docs/verify.md`).
- **CI Chromium has no `navigator.gpu`.** The B* Puppeteer args
  (`--enable-unsafe-webgpu --use-gl=swiftshader`) do not prove the
  WebGPU device path. Treat a green suite as Wasm/CPU coverage plus
  ladder unit tests, not as WebGPU proof.
- **A broken WebGPU session taxes only the first failure.** After a
  non-floor rung fails, it is demoted for the offscreen process
  lifetime. The first capture after device loss can still take 15s;
  later ones go to WASM. Reload the extension if you need to retry
  WebGPU.
- **Hash fallback is not semantic.** It shares shape (384-d, unit-ish)
  and none of the meaning. Paraphrases land in disjoint bins. Do not
  feed it to cosine or drift.
- **Two concurrent `DWELL_RECORD`s** used to race `chrome.offscreen.createDocument`.
  Setup is now single-flight; a failure is not cached forever.
- **`@xenova/transformers` is gone.** The live path is
  `@huggingface/transformers` v3. Inbox specs and the original proof
  slice that still name Xenova v2 are historical.
