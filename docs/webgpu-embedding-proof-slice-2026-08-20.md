# Task #474 — bounded non-Apple WebGPU embedding proof slice

> **Status (2026-08-21):** Historical evidence packet. The live offscreen
> path now calls `embedWithFallback()` from
> `src/lib/models/webgpu-embedder.ts` (commit `7ac3c42`). Claims below
> that this slice “does not touch” `src/offscreen/offscreen.ts`, or that
> the worker is still on `@xenova/transformers` v2, describe the slice’s
> original bounds — not current architecture. See
> `docs/on-device-embeddings.md`.

Evidence packet for the 24-hour review gate.

## What this proves

- `@huggingface/transformers` v3.8.1 (the maintained successor to
  `@xenova/transformers` v2, currently used in `src/offscreen/offscreen.ts`)
  loads and runs a `feature-extraction` pipeline correctly on this machine,
  producing a normalized 384-dim vector matching the existing embedding
  dimension.
- The fallback ladder degrades correctly by environment rather than assuming
  a single universal floor. Finding: the library's Node bundle
  (onnxruntime-node, loaded whenever there's no `window`/`importScripts`,
  e.g. under Bun) only accepts `cpu`/`cuda` as a device — it throws
  `Unsupported device` for `wasm` or `webgpu`. Those two are browser-only
  execution providers (onnxruntime-web), available only in a real
  window/worker context. `fallbackLadder()` in
  `src/lib/models/webgpu-embedder.ts` picks the right ladder for the runtime
  it's actually in: `["webgpu", "wasm"]` in a browser-like runtime (falling
  back to `wasm` if `navigator.gpu` is absent or the WebGPU call fails),
  `["cpu"]` under Node/Bun.
- Resource limits are enforced: `MAX_INPUT_CHARS` (8000) truncates oversized
  input before it reaches the model; `EMBED_TIMEOUT_MS` (15000) bounds both
  model load and the embed call itself, so a stuck load or inference can't
  hang the caller indefinitely.

## What this does NOT prove (NOT-REPRODUCED)

- **WebGPU device path.** This machine's Puppeteer-launched Chromium (used
  by the repo's B*-layer, `--enable-unsafe-webgpu --use-gl=swiftshader
  --use-angle=swiftshader`) has no `navigator.gpu` at all — not an adapter
  failure, the API surface itself is absent in this Chromium build. WebGPU
  proof needs either a real GPU-backed Chrome or a newer Chromium for
  Testing build with WebGPU compiled in.
- **Browser `wasm` device path.** Same root cause from the other side: this
  Bun-run harness never enters a browser-like runtime, so it never reaches
  onnxruntime-web at all, only onnxruntime-node (`cpu`).

Both gaps are structural to *this* environment, not to the code — the
module and benchmark harness are already NOT-REPRODUCED-aware and would
exercise both browser legs correctly in a Chrome build with WebGPU enabled
(the module's `fallbackLadder()`/`isBrowserLikeRuntime()` checks are
runtime-driven, not hardcoded to this environment).

## Scope discipline

Per the task's own bounds: nothing here touches the live embedding path
(`src/offscreen/offscreen.ts`, still on `@xenova/transformers` v2/WASM), the
IndexedDB schema, or `EmbeddingSource` in `src/lib/db.ts`. This is a
standalone module + benchmark + tests only. Promoting any of it into the
production pipeline is a separate decision, out of scope here. No Watch/
iPhone/iOS/device lane touched. No new manifest permissions added — the
module runs in whatever context imports it and makes no `chrome.*` calls of
its own.

## Artifacts

- `src/lib/models/webgpu-embedder.ts` — the embedder + fallback ladder.
- `scripts/benchmark-webgpu-embeddings.ts` — benchmark harness, fixed
  10-item synthetic fixture set (no real user data), writes a dated JSON
  report to `docs/benchmarks/`.
- `tests/webgpu-embedder.test.ts` — 9 tests: environment detection, fallback
  behavior (valid vector, empty-input rejection, oversized-input bounding),
  resource limits, and benchmark-harness correctness including the
  NOT-REPRODUCED labeling itself.
- `docs/benchmarks/webgpu-embedding-2026-08-20.json` — one benchmark run's
  raw output (cpu leg: mean 61.7ms / p50 11.8ms / p95 521.7ms over 10
  fixtures, first call dominated by model load).

## Verification run (2026-08-20)

```
bun run build            # clean, existing eval warning is pre-existing @xenova/transformers, unrelated
xvfb-run -a bun test     # 276 pass, 0 fail, 865 expect() calls, 39 files (223 pre-existing + this slice's 9, plus other growth since the 223 baseline was last recorded in the repository instructions)
bun run scripts/benchmark-webgpu-embeddings.ts   # writes docs/benchmarks/webgpu-embedding-2026-08-20.json
```

## Recommendation

Proof slice complete and bounded as specced. Do not promote into the live
offscreen pipeline without a separate decision — that would be an
architecture change (new dependency alongside `@xenova/transformers`,
manifest/CSP review for `@huggingface/transformers`' WASM/WebGPU assets,
and a real-GPU browser to actually validate the webgpu leg) outside this
task's non-goals.
