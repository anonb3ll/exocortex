# Focus Shield

Opt-in intervention when cognitive fatigue is high. The overlay lives in
the page; restored context never does. Defaults **off**.

## Intent

Surface a dismissible prompt on the active eligible tab when the fatigue
index crosses a threshold, park known distraction tabs without closing
them, and restore a checkpoint in the extension-owned side panel.

This is not the same as the neuroergonomic nudge (`softNudge` on a dwell
response, and the side-panel `#nudge-banner` from `GET_TELEMETRY`).
Nudges are advisory messages at fatigue ≥ 75 (plus drift / tab-hop
copy). The banner CTA has no click handler. Focus Shield is a gated
overlay plus tab grouping, frequency-capped at 30 minutes.
Side-panel layout: `docs/sidepanel.md`.

## Architecture

```
consent + dwell (5s) → service worker
        │ classify + createCognitiveFrame(timestampUtc = capture time)
        │ stateObserver.evaluateTelemetry()
        ▼
FocusShieldManager.evaluateFrameSequence()
        │ enabled? fatigue ≥ 80? cooldown elapsed?
        │ capture tab still active and unblocked?
        ▼
content script overlay (closed shadow DOM)
        ├ Restore → chrome.sidePanel.open + GET_FOCUS_SHIELD_CONTEXT
        ├ Park    → group known Distraction tabs
        └ Dismiss → hide overlay; cooldown stays
```

| Piece | Path | Role |
|---|---|---|
| Policy | `src/lib/focus-shield/focus-shield.ts` | Enable, threshold, cooldown, rollback |
| Persistence | `src/lib/focus-shield/runtime.ts` | Load config/observer/classifications after MV3 restart |
| Parking | `src/lib/focus-shield/tab-parking.ts` | Who may be grouped |
| Overlay | `src/content/focus-shield-overlay.ts` | Closed-shadow UI; no restoration text |
| Delivery | `src/background/service-worker.ts` | Active-tab revalidation, park on activate |
| Side panel | `src/sidepanel/sidepanel.ts` | Toggle, restore parked tabs, context prompt |

## Defaults

Stored in `chrome.storage.local` (`FOCUS_SHIELD_STORAGE_DEFAULTS`):

| Key | Default | Notes |
|---|---|---|
| `focus_shield_enabled` | `false` | Side-panel toggle writes only this |
| `fatigueThreshold` | `80` | Compared to `metrics.fatigueIndex` (0–100) |
| `minInterventionIntervalMs` | `30 * 60 * 1000` | Frequency cap |
| `focus_shield_last_intervention_at` | `0` | Restored into the manager on SW start |
| `focus_shield_observer_state` | session clocks | 2h inactivity resets the session |
| `focus_shield_tab_context_signals` | `[]` | Last 100 tab classifications |
| `focus_shield_parked_group_ids` | `[]` | Groups this extension created |

The side panel only sends `{ enabled }`. Threshold and interval can be
changed with `SET_FOCUS_SHIELD_CONFIG` but have no UI.

## When it fires

`evaluateFrameSequence(frames, metrics)` in order:

1. Disabled → `INACTIVE`, no overlay.
2. Any frame whose `provenance.url` is blocklisted → no overlay
   (privacy non-bypass).
3. `fatigueIndex < 80` → `IDLE`.
4. Last intervention was fewer than 30 minutes ago → capped.
5. Else `ACTIVE_SHIELD` with action `CONTEXT_RESTORATION`.

The service worker then **re-checks** that the capturing tab is still
the active tab at that URL. If the user switched away, it
`rollbackIntervention` so the cooldown is not burned for a prompt that
never appeared.

Parking runs automatically on a successful activation (same window),
and again if the user clicks **Park distraction tabs** on the overlay.

### Fatigue index (why it may never fire)

From `calculateContinuousLoadAndFatigue()`:

```
timeFatigue     = min(60, (sessionMinutes / 60) * 40)   // 60 pts after 90 min
velocityFatigue = min(40, tabSwitchesIn5Min * 4)        // 40 pts at 10 hops
fatigueIndex    = min(100, round(timeFatigue + velocityFatigue))
```

`activeDwellSeconds` is passed in and unused. Category load scores
cognitive load, not this index. A quiet 20-minute coding session is
nowhere near 80; you need long cumulative session time and/or rapid
tab hops. Observer state older than **2 hours**
(`SESSION_INACTIVITY_RESET_MS`) is discarded on restore, so overnight
fatigue does not carry over.

## Overlay and restore

- Injected only when `isUrlBlocked(location.href)` is false.
- Closed shadow root; page JS cannot read the card. Restoration prompts
  are fetched with `GET_FOCUS_SHIELD_CONTEXT` →
  `handleRestoreContext()` and rendered in the side panel.
- **Restore context** opens the side panel for that tab and sends
  `FOCUS_SHIELD_CONTEXT_REFRESH` so an already-open panel refetches
  instead of showing stale text.
- **Keep working** dismisses UI state but does **not** reset the 30
  minute cap.

## Tab parking

`selectTabsToPark()` keeps a tab only when all of these hold:

- not active, not pinned, not already grouped
- URL is not a special scheme (`chrome:`, `chrome-extension:`, `edge:`,
  `about:`, `brave:`, `file:`, `view-source:`)
- the stored classification URL still matches the live sanitized URL
- `intentCategory === "Distraction / Rabbit Hole"`

It never closes tabs. Groups are titled `Exocortex — Parked Context`,
grey, collapsed. If ownership cannot be persisted, the new group is
ungrouped immediately.

**Restore parked tabs** (side panel) ungroups only groups whose ids
this extension stored. Groups the user created, or groups in another
window when a `windowId` is passed, are left alone. The side-panel
button does not pass `windowId`, so it restores every owned group.

## Usage

1. Load `dist/` unpacked, open the side panel, enable **Local footprint
   capture** *and* **Focus Shield**. Capture is a separate opt-in
   (`docs/capture-consent.md`); without it no dwells land and nothing
   is classified.
2. Browse a non-blocked tab for 5s so a dwell records a classification.
3. Overlay appears only after fatigue ≥ 80 and the 30-minute cap allows
   it. Until then the toggle being on is the expected idle state.
4. Restore reads the latest cognitive checkpoint; if none exists the
   prompt is empty.

## Pitfalls

- **Capture off means no classifications.** Focus Shield can be enabled
  while `exocortexCaptureConsent` is still false. Overlay and parking
  then stay idle because no dwell frames arrive.
- **Blocked URLs never see the overlay.** The content script bails out
  before attaching a listener, and the manager refuses frames whose
  provenance URL is blocklisted (`docs/privacy-guard.md`).
- **Classifications are per-tab-id and must still match the URL.** A
  SPA navigation or recycled tab id without a new dwell will not park.
- **Activation parks in the capturing window only.** The overlay's Park
  button uses `sender.tab.windowId`.
- **MV3 restarts are expected.** Config, last intervention time,
  observer clocks, and tab signals reload from `chrome.storage.local`
  before dwell handling (`focusShieldReady`).
- **Do not confuse with MCP `exocortex_detect_drift`.** That tool is
  not bridge-backed; it reads the MCP process's empty database unless
  you are looking at the in-extension nudge on the dwell response.
- **Side-panel nudge banner is not the overlay.** `#nudge-banner` can
  show a rest/drift recommendation while Focus Shield is still off.
  Overlay delivery still requires the toggle, fatigue ≥ 80, and the
  30-minute cap.
