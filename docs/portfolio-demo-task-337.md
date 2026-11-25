# Exocortex — portfolio workflow evidence

> Evidence packet for task #337. The live "Where was I?" popup still
> calls `recallLatestContext()` over `dwell_blocks` (not cognitive
> frames). Operator overview: README → Surfaces / Documentation.
>
> Status (2026-09-07): dwell capture is consent-gated
> (`docs/capture-consent.md`). An empty popup is expected until
> **Local footprint capture** is on and a page dwells ≥ 5s. The popup
> also exposes **Open Side Panel**.

Task #337 turns the existing local capture and recall foundation into one
user-facing outcome: **Where Was I?**

## Workflow

1. A page remains local to the extension and is captured after the existing
   dwell threshold.
2. `captureContext()` records the page text and dwell event in the local Dexie
   database.
3. `recallLatestContext()` returns the latest title, excerpt, capture time, and
   dwell duration.
4. The popup renders the recalled context and exposes the provenance-backed
   `Reopen Page` action.

The workflow does not add a second store, project registry, session router, or
cross-project access path. It targets the selected local Exocortex extension
checkout and keeps the source URL and capture timestamp attached to the recalled
context as local provenance.

## Evidence

- `tests/context-workflow.test.ts`: two deterministic tests cover the populated
  and empty states of capture → recall → resume.
- `bun run build`: TypeScript gate and both extension bundles pass.
- Existing projection-contract tests pass, including provenance and privacy
  allowlists.
- The existing `tests/e2e-capture-recall.test.ts` could not complete in this
  restricted environment because Bun received `EPERM` while writing to the
  spawned MCP fixture's stdin. That is an environment limitation, not a
  workflow assertion failure; rerun it in the browser-capable development
  environment.

## Observed friction

- Before this seam, the popup duplicated database lookup and resume formatting,
  so the user outcome was not represented by one testable contract.
- The side panel and popup expose related recall behavior but remain separate
  surfaces; the side panel is the richer timeline, while the popup is the
  shortest recovery path.
- Browser-level verification requires a Chrome-capable environment; unit and
  build verification remain available without it.

## Portfolio summary

Exocortex now demonstrates a bounded local loop: capture a page context, preserve
minimal provenance, recall the latest useful state, and take the concrete action
of reopening the page. The implementation uses the existing IndexedDB schema,
privacy boundary, and projection contracts; it does not claim cross-device
sync, autonomous task execution, or production browser deployment.
