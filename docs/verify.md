# Verify probes

Opt-in adversarial and live-Chrome probes under `verify/`. They are
**not** part of `bun run test` (`package.json` `"test"` is
`bun test tests/`). A green default suite is not evidence these ran.

Independent of the shipped L1–L5 / B* harness. They must not weaken
those suites to pass.

## Intent

Falsify the honesty and privacy contracts beyond the unit tests:
blocked queries never reach the embedder, fallback vectors never earn
a cosine, and panel vs MCP outage behaviour stays labelled.

## Suite

| Probe | How to run | What it is |
|---|---|---|
| Adversarial (P1–P11) | `bun test verify/adversarial-probes.test.ts` | Unit-level attempts to break `searchPanelMemory`, `hybridVectorSearch`, and `handleSemanticSearch` |
| Runtime panel | `EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run verify/runtime-probe.ts` | Real Chrome against freshly built `dist/`; screenshots under `dist/screenshots/indy-*.png` |
| Real-model panel | same env + `bun run verify/real-model-probe.ts` | Allows Hugging Face through the resolver map so MiniLM can actually download |
| Why-fallback | `bun run verify/why-fallback.ts` | Logs why a B* offscreen run did not produce `source: "model"` |
| Offscreen as page | `verify/offscreen-as-page.ts` / `verify/offscreen-direct.ts` | Direct offscreen-document probes, not the side-panel UI |

`bun run test` never picks these up. CI (`.github/workflows/ci.yml` and
the Depot mapping `.depot/workflows/ci.yml`) also runs `bun run test`
only — not `verify/`.

## P9 is not live wiring

`verify/adversarial-probes.test.ts` P9 injects
`{ vector: [], source: "fallback" }` into `searchPanelMemory`. That
returns `status: "ok"` and lexical hits — the **pre-#1082** silent
degrade.

Live `requestPanelEmbedding` (`src/sidepanel/semantic-search.ts`)
**rejects** unless `response.source === "model"`. A worker fallback
response becomes `embedding_unavailable`, which the UI then retries as
labelled lexical (`docs/semantic-search.md`).

The live contract is the unit test
`"Real panel wiring treats the worker fallback response as unavailable"`
in `tests/sidepanel-semantic-search.test.ts`. Do not cite P9 as
production panel behaviour.

## Constraints

- Runtime probes need a built `dist/` (`bun run build`) and
  `EXOCORTEX_BROWSER_TESTS=1`. They launch headless Chrome the same way
  B* does (`tests/fixtures/browser-launch.ts`).
- `real-model-probe.ts` punches Hugging Face through the default
  `MAP * 127.0.0.1` resolver. That is probe-only. Shipped B* tests keep
  third-party DNS blocked.
- Do not fold these into `package.json` `"test"` to make a probe
  failure look like an L-layer regression.

## Pitfalls

- **`bun test verify/...` skips `pretest`.** Same as `bun test`: on a
  fresh checkout, build first if the probe loads `dist/`.
- **P9 comment text is stale.** The probe file still describes
  `requestPanelEmbedding` as resolving fallback. Source rejects
  fallback; believe `semantic-search.ts` and the "Real panel wiring"
  test, not that comment.
- **A skipped B-layer is not a skipped `verify/` run.** They are
  separate opt-ins.
