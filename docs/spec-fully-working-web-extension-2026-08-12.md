---
date: 2026-08-12
source: anonb3ll
tags: [specification, exocortex, chrome-extension, mv3, roadmap]
---

# Exocortex — Fully Working Web Extension Specification

> Status (2026-09-07): capture is off by default. The user workflow
> below that starts at Focus Shield is incomplete — enable **Local
> footprint capture** first (`docs/capture-consent.md`). Historical
> spec; do not treat as the operator runbook.

## Scope

This specification defines the v0.2 completion boundary for the local-first
Manifest V3 browser extension. “Fully working” means the shipped user workflow
is observable in Chrome, fails closed at privacy boundaries, survives the
service-worker lifecycle, and has automated coverage for its policy and wire
contracts. It does not mean that unshipped OCR or raw cross-device SQLite sync
is silently added.

## User workflow

1. The user enables Focus Shield in the side panel. The default remains off.
2. Dwell capture classifies the current tab locally. Blocked URLs are never
   captured, indexed, projected, or acted on.
3. When the configured fatigue threshold is reached, the service worker emits
   one rate-capped intervention to the active tab and automatically groups known
   distraction tabs. The tab receives a visible, dismissible shadow-DOM overlay
   with the fatigue reason and three actions: keep working, restore context, and
   park known distraction tabs again.
4. Parking groups only tabs previously classified as `Distraction / Rabbit Hole`
   in the current window. It never closes tabs and never moves the active or
   pinned tab. The group is collapsed and titled `Exocortex — Parked Context`.
5. Restore context returns the local context-restoration kit to the overlay;
   restoring parked tabs ungroups only the Exocortex-owned parked group.
6. An explicit MCP projection call can produce a task-reference edge from the
   current focus anchor and a positive unified-agent task ID. The output is
   contract v1, allowlisted, URL-minimised, and does not write directly to the
   unified-agent database.

## Acceptance criteria

### Focus Shield

- `focus_shield_enabled` is persisted in `chrome.storage.local` and defaults to
  `false`.
- The threshold and frequency cap are enforced by `FocusShieldManager`.
- The overlay is rendered only on an eligible, non-blocked page and is removed
  on dismiss or restore.
- Overlay actions are idempotent and do not leak page content or URLs.
- A browser smoke test proves the overlay can be shown and dismissed.

### Tab organization

- Only known distraction tabs in the active window are candidates.
- Active, pinned, blocked, special-scheme, and already-grouped tabs are skipped.
- Parking is grouping only; no tab is closed, navigated, or made active.
- Restore only ungroups the named Exocortex group.
- Pure planner tests pin the safety exclusions and selected tab IDs.

### Task graph edge

- `exocortex_project_task_reference` requires a positive task ID and confidence
  in `[0, 1]`.
- It derives the v1 `task_reference` record from a focus anchor, with relation
  `suggested_by_focus`, `ua://task/<id>`, and the anchor’s minimised focus entity.
- Payload fields are exactly the v1 allowlist; raw URL, title, text, history,
  and embeddings never appear.
- The tool remains pure: it returns a record and does not perform a database
  write or reach into unified-agent storage.

### Release gates

- `bun run build` succeeds and `dist/manifest.json` matches the source manifest.
- TypeScript compilation succeeds.
- Focus Shield, tab planner, projection, bridge, privacy, and existing end-to-end
  tests pass.
- Roadmap and the repository instructions describe the actual test count and the actual OCR
  boundary.

## Explicit non-goals

- No real OCR engine is included in this slice. Visual frames without OCR text
  are intentionally not treated as textual evidence.
- No raw Exocortex/unified-agent SQLite sharing or ad hoc cross-repository writes.
- No automatic tab closure, navigation, or movement of pinned/active tabs.
- No default-on interventions; the user must opt in.
