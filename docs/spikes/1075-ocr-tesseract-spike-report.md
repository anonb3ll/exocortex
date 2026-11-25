---
date: 2026-09-21
source: anonb3ll
tags: [spike, ocr, tesseract, task-1075]
---

# Task #1075 — OCR engine spike report (Tesseract.js)

Status: **spike only — no engine is wired into the shipped extension.**
`src/offscreen/ocr.ts` is unchanged by this PR; `extractOcrTextFromImageData`
still returns `""` by design (task #296).

## Method

Tesseract.js (WASM) was chosen as the leading local-OCR candidate per the
task brief. Rather than estimate, this spike ran the actual engine inside a
real Chromium page — the same rendering/WASM engine a `chrome.offscreen`
document uses — via Puppeteer (already a repo devDependency), loading every
asset (`worker.min.js`, the WASM core, `eng.traineddata`) from a local static
file server instead of the library's default jsdelivr CDN, so the
measurement reflects a fully local, CSP-compliant deployment shape rather
than the library's out-of-the-box network behavior.

Test frame: a synthetic 1280×800 white canvas with a ~630-character paragraph
of representative UI body text at 16px, matching the 1280px-wide downsampled
screenshot format `docs/on-device-embeddings.md` describes for visual frames.

Reproduction script: `docs/spikes/1075-ocr-tesseract-spike.mjs` (setup
instructions in its header comment). Tesseract.js `5.1.1`, `tesseract.js-core`
`5.1.1` (npm, installed 2026-09-21). Measured on the dev desktop: Intel Core
i5-6600 @ 3.30GHz, 4 cores, headless Chrome 151 via Puppeteer 25.4.0,
`--no-sandbox`.

## Question 1 — Does `manifest.json`'s CSP allow `wasm-unsafe-eval`?

**Yes, already.** `public/manifest.json`:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

`wasm-unsafe-eval` is already present — **no manifest change needed** to
execute WASM in the offscreen document.

**But this CSP has a second, more consequential implication for engine
choice.** `script-src 'self'` means the extension can only execute script (and,
per Chrome's WASM-CSP handling, fetch/instantiate WASM) from its own origin.
Tesseract.js's *default* behavior — confirmed by reading its source
(`src/worker/browser/defaultOptions.js`, `src/worker-script/browser/getCore.js`,
`src/worker-script/index.js`) and by a live `curl` against the URLs it
constructs — is to fetch `worker.min.js`, the WASM core, and
`<lang>.traineddata` from `cdn.jsdelivr.net` unless `workerPath`/`corePath`/
`langPath` are explicitly overridden. That CDN fetch is not "self" and would
be blocked by the existing CSP outright, independent of privacy policy. The
spike therefore had to (and did) serve all three assets locally to run at
all — which happens to be exactly what the product's local-first, no-network
stance would also require. Net effect: **no CSP change is needed, but engine
integration is only possible by bundling the worker script, WASM core, and
traineddata inside the extension package** (or an origin the CSP is loosened
for, which is out of scope and not recommended). This was proven, not assumed
— the spike's local-asset configuration is what let recognition run at all.

## Question 2 — Model/traineddata size and first-use download behavior

Measured directly (not estimated):

| Asset | Size | Source |
|---|---|---|
| `eng.traineddata.gz` (LSTM-only, `best_int` — the recommended small model) | 2,952,873 bytes (~2.95 MB) | `curl -sIL https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz` → `content-length: 2952873` |
| `eng.traineddata` (decompressed) | 5,199,098 bytes (~5.2 MB) | `gunzip -k` on the file above |
| `tesseract-core-simd-lstm.wasm.js` (JS-wrapped WASM core, LSTM-only, SIMD build — the smallest core variant that still auto-detects SIMD) | 3.8 MB | `node_modules/tesseract.js-core` after `npm install tesseract.js@5` |
| `worker.min.js` | 121 KB | same install |
| **Total minimum, English-only, LSTM-only** | **≈ 6.9 MB** | sum of the above |

**Default first-use download behavior:** unless the integration explicitly
overrides `workerPath`/`corePath`/`langPath`, tesseract.js fetches all three
assets above from `cdn.jsdelivr.net` on first use, over plain HTTPS, with no
user-visible consent step. This is confirmed both by static source
inspection and by the CDN URLs answering live (`HTTP/2 200`) during this
spike.

**Is that acceptable for this product?** No, on two independent grounds:

1. **CSP blocks it anyway** (Question 1) — `script-src 'self'` does not
   permit jsdelivr.
2. **Privacy stance blocks it regardless of CSP.** This repo's hard rule
   (`docs/roadmap.md`, the product guidelines: *"Honest about
   limits... OCR is absent"*, and the project's local-first design generally)
   is that captured content and the tools that process it stay local. A
   silent ~6.9 MB fetch of extension-internal assets to a third-party CDN the
   first time a user's screen is OCR'd is exactly the kind of network
   dependency this product avoids elsewhere (embeddings already run
   on-device per `docs/on-device-embeddings.md`).

The only compliant path is to **bundle** the core, worker script, and
`eng.traineddata` inside the extension package (`chrome-extension://` URLs
passed as `corePath`/`workerPath`/`langPath`) — proven working in this spike
with zero network requests after the initial local asset load. That adds
**~6.9 MB to the shipped extension bundle** for English-only OCR (multiply
per additional language). This is a real, measured packaging/review cost:
Chrome Web Store review for a multi-megabyte WASM+model payload, plus the
one-time unpacked-extension disk footprint for every install.

## Question 3 — CPU cost of a realistic recognition pass in the offscreen document

Measured via the reproduction script (`docs/spikes/1075-ocr-tesseract-spike.mjs`),
running the real Tesseract.js WASM engine against the 1280×800 test frame,
inside actual Chromium (not a Node WASM shim):

| Run | What it measures | Result |
|---|---|---|
| **Cold** | Worker creation + WASM core init + local traineddata load (already on disk, not downloaded) + first `recognize()` | init `432 ms` + recognize `1,241.5 ms` = **`1,673.5 ms` total** |
| **Warm** | `recognize()` only, worker and model already resident (matches a long-lived offscreen document processing frame N > 1) | **`885.8 ms`** |

Output text length was 632 characters, matching the input paragraph, with no
garbling in the sampled prefix — the engine itself works correctly on this
class of input.

Caveat (explicitly unmeasured): this is one frame density (a single body-text
paragraph). A denser frame — a full-page screenshot with multiple text
blocks, tables, or a code editor — will cost more, because Tesseract's time
scales with the number and complexity of text regions it must segment, not
just character count. I did not measure that scaling within this spike's
time budget; treat the numbers above as a lower-to-middle bound for typical
body-text-dominant frames, not a worst case.

## Question 4 — Does the existing 3000ms deadline in `extractOcrTextWithTimeout` survive? (decisive question)

**Yes, if and only if the engine is initialized once and kept warm — not
created fresh inside the timeout-wrapped call.**

- `extractOcrTextWithTimeout(canvas, timeoutMs = 3000)` today wraps a single
  synchronous-shaped extraction call and races it against a 3000ms timer.
- **Warm case (recommended integration shape):** if the offscreen document
  creates the Tesseract worker once at document startup (module-level
  singleton, matching how the offscreen document is already long-lived) and
  `extractOcrTextWithTimeout` only calls the already-initialized worker's
  `recognize()`, the measured cost is **885.8 ms — 38% headroom used, 62%
  (≈2,114 ms) of the 3000ms budget still unspent** on this test frame and
  this CPU.
- **Cold case (if the engine were naively created per-frame inside the
  timeout-wrapped function):** measured cost is **1,673.5 ms — 56% headroom
  used, 44% (≈1,326 ms) unspent.** Still technically under 3000ms in this
  run, but with much less margin against a slower machine, a denser frame, or
  GC/JIT variance, and this number **excludes any network download** (Q2) —
  if the model isn't pre-bundled/pre-fetched, first use could blow the
  budget by seconds, not milliseconds.
- **Verdict: the deadline survives with real margin, but only under the
  warm-singleton integration shape.** A naive per-frame `createWorker()` call
  is the wrong integration pattern for this codebase's timeout contract and
  should not be how step 2 (if greenlit) wires this in.

This is the one number the task explicitly asked not to be estimated, and it
was measured end-to-end through the real engine, not inferred from
documentation or benchmarks published elsewhere.

## Recommendation: GO (conditional)

Tesseract.js is technically viable for this codebase, with three conditions
that step 2 (not started, not authorized by this PR) would need to satisfy:

1. **Bundle, don't fetch.** Ship the WASM core, worker script, and
   `eng.traineddata` inside the extension package with explicit
   `workerPath`/`corePath`/`langPath` pointing at `chrome-extension://`
   URLs. This is required by the existing CSP and by the product's privacy
   stance — not optional. Budget **~6.9 MB** added to the package for
   English-only.
2. **Initialize once, keep warm.** The worker must be created at offscreen
   document startup (or lazily on first use but then cached), never inside
   `extractOcrTextWithTimeout`. This is what makes the 3000ms deadline safe
   (885.8ms measured vs. 1,673.5ms for a cold per-frame create).
3. **Re-measure on denser frames before shipping.** This spike used one
   text-paragraph frame density. A full-page-screenshot-with-code-and-tables
   frame should be measured before committing to the 3000ms budget in
   production; §"Question 3" caveat above.

None of this is decided or implemented here — it is the shape a future,
separately-authorized step 2 would need to take if a later change authorizes
integration.

## What this spike did NOT test

- Recognition accuracy/quality on real captured screenshots (only a
  synthetic clean paragraph was used — real browser screenshots have
  anti-aliased fonts, varied contrast, UI chrome, and non-Latin scripts).
- Non-English languages (traineddata size and recognize cost both vary by
  language and script).
- Memory pressure / GC behavior under repeated recognize() calls over a long
  browsing session (only two calls were measured per run).
- Denser/multi-region frames (see Question 3 caveat).
- Actual `chrome.offscreen` document behavior specifically (Puppeteer's
  headless page is the closest available proxy — same Chromium, same V8/WASM
  engine — but is not byte-for-byte the offscreen-document execution
  context; this is a reasonable proxy, not a substitute for an in-extension
  measurement).
