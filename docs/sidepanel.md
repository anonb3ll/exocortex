# Side panel

Operator runbook for the Chrome side panel — the human surface over
the same Dexie the service worker writes. Popup, MCP, and this page
are three views of one profile, not three stores.

Consent toggle: `docs/capture-consent.md`. Overlay + parking:
`docs/focus-shield.md`. Embedder ladder: `docs/on-device-embeddings.md`.

## Intent

Show live capture, hybrid recall, a sanitized mobile-slice preview,
librarian snippets, and advisory fatigue/drift copy without sending
page text off-device. Nothing here is an MCP session. Bridged tools
see this profile only when the native host is connected
(`docs/native-bridge.md`).

## Architecture

```
chrome.sidePanel  (gesture: popup Open Side Panel, or Chrome's menu)
        │ src/sidepanel/sidepanel.ts  reads Chrome Dexie directly
        │
        ├ #search-input  (200ms debounce)
        │     ├ timeline  → searchPanelMemory / hybridVectorSearch
        │     │             (matchKind badges, clickable URLs)
        │     └ mobile    → searchMobileMemoryPure limit 5
        │                   (opaque mem_<id>, no raw URLs)
        ├ Librarian Vault → db.semantic_vault last 5 (display only)
        ├ Working Memory  → db.working_memory_stack last 5
        ├ GET_TELEMETRY   → meters + #nudge-banner (advisory)
        └ controls        → exocortexCaptureConsent
                            exocortexRetentionDays   (7 / 30 / 90 / 365)
                            exocortexOmacortexFeed   (+ status probe)
                            focus_shield_enabled
```

| Piece | Path | Role |
|---|---|---|
| Markup | `src/sidepanel/sidepanel.html` | Layout; no range scrubber in the DOM |
| Wiring | `src/sidepanel/sidepanel.ts` | Load, search debounce, banners |
| Hybrid search | `src/sidepanel/semantic-search.ts` | Query gate + `requestPanelEmbedding` |
| Result rows | `src/sidepanel/result-cards.ts` | DOM-built rows; captured strings set as text only |
| Timestamps | `src/sidepanel/format-time.ts` | `Today 14:05` / `Yesterday 09:12` / `Nov 12 16:40` |
| Mobile preview | `src/lib/mobile-slice.ts` + `mobile-slice-view.ts` | Sanitized envelope |
| Vault write | `src/lib/agents/librarian-agent.ts` | Index on dwell in the service worker |
| Vault search (MCP) | `src/mcp/tools.ts` `handleSearchSemanticVault` | Not bridge-backed |
| Nudge | `src/lib/agents/neuroergonomic-nudge-agent.ts` | `GET_TELEMETRY.nudge` |

Open the panel from the popup **Open Side Panel** button
(`chrome.sidePanel.open()` is gesture-gated) or Chrome's side-panel
menu.

## One search box, two contracts

`#search-input` is shared. Empty input restores the chronological
timeline and leaves mobile recall `status: "empty"`. Non-empty input
(200ms debounce) does **both**:

| Surface | Function | What you see |
|---|---|---|
| Timeline | `searchPanelMemory` | `vector · cos 0.xx` / `lexical` badges, page title **links**, **Reopen Tab** (`data-url`) |
| Mobile Thin Slice | `searchMobileMemoryPure(..., { limit: 5 })` | `mem_<id>` handles, `[redacted-link]`, **no** raw URLs |

Timeline result rows show when (always with the date), the site, and —
when the page declared them — the author and whether it is a video or
an article: `YouTube · Fireship · video`. Site name and author are also
matched by a typed query.

A typed query with no lexical hit and no real query vector returns
**no results**. It used to return every recent page, ranked by recency
and dwell.

A blocked query (`isSearchQueryBlocked`) rewrites the mobile query to
`[blocked-query]` and, on the timeline path, renders the Fail-Closed
Privacy Shield without embedding. Keyword MCP search
(`exocortex_search_memory`) is a third path and is not this box.

Do not treat a timeline card as the mobile envelope. The mobile ADR
§7 documents only the sanitized branch; this page is the operator
view of both.

## Librarian Vault vs MCP vault search

**Historical Knowledge (Librarian Vault)** is Chrome Dexie
`semantic_vault`, newest five rows (`timestampUtc` descending).

Writes happen only on the dwell path in the service worker
(`librarianAgent.indexPageExcerpt` after `captureContext` succeeds).
There is no other caller. Consent off or a blocked URL means no
index. Revisit of the same URL upserts the existing `vaultId` and
refreshes `timestampUtc` to `Date.now()` (index time, not dwell
`capturedAt`). Excerpt is capped at 500 characters; the panel then
shows the first 100. `vectorAnchor` is stored only when the dwell
embedder returned `source: "model"`.

The panel **does not search** this table. It is a recent-snippet list
with clickable URLs. There is no in-repo caller of the service-worker
`GET_SEMANTIC_KNOWLEDGE` handler.

`exocortex_search_semantic_vault` is a different object:

- It is not in `BRIDGE_BACKED_TOOLS`. Envelope `source` stays `ephemeral`.
- It searches the MCP process's empty `fake-indexeddb`, not the
  Chrome profile the panel is showing.
- It never passes a query embedding (the MCP schema's cosine branch
  is the unused extension handler above). Ranking is keyword +
  optional `primaryFocusEntity`.

An empty MCP vault result is not evidence the panel list is empty.

## Nudge banner vs Focus Shield

`#nudge-banner` ("Neuroergonomic Recommendation") is **not** the
Focus Shield overlay. On load, the panel asks `GET_TELEMETRY` and
shows `nudge` when `type !== "None"`:

| `nudge.type` | When (`neuroergonomic-nudge-agent.ts`) |
|---|---|
| `RestRecommendation` | `fatigueIndex ≥ 75` |
| `FocusAnchorNudge` | High rabbit-hole drift, or mild drift with an anchor |
| `ContextReconnection` | `contextSwitchCost > 60` and the frame is not already `Distraction / Rabbit Hole` |

The CTA button is display-only — there is no click handler. Focus
Shield still needs its own toggle, fatigue ≥ 80, and the 30-minute
cap (`docs/focus-shield.md`).

## Working memory and reopen

Active Working Memory Stack is `working_memory_stack` last five by
`lastUpdatedUtc`. Timeline and search cards reopen via
`restore-btn[data-url]` → `chrome.tabs.create`. The stack's
**Resume** button sets `data-goal` only; the click handler ignores
it, so Resume does not restore a goal.

Two views, on purpose. The panel is the full-fidelity one — this is the
user's own machine, and the goal is shown as captured, page title included.
Everything that leaves the process (`exocortex_get_working_memory_stack`,
`exocortex_restore_context`) answers with the site label stored beside the
goal at capture time instead; see `docs/native-bridge.md`. Do not "fix" the
panel to match the wire.

## Usage

1. `bun run build`, load `dist/` unpacked, open the side panel.
2. Enable **Local footprint capture**. Dwell ≥ 5s on a non-blocked
   tab before expecting timeline, vault snippets, or mobile glance.
3. Type in **Search footprint & memory...** to run hybrid timeline
   search plus sanitized mobile recall together.
4. Enable **Focus Shield** separately if you want the overlay.
   The nudge banner can appear without that toggle.

## Tests

- `tests/sidepanel-semantic-search.test.ts` — panel hybrid statuses
- `tests/smoke-sidepanel-semantic-search.test.ts` — B* (opt-in)
- `tests/smoke-sidepanel-mobile-slice.test.ts` — B* mobile preview
- `tests/mobile-slice-view.test.ts` — honest mobile status render

## Pitfalls

- **Two contracts, one box.** Timeline hits expose URLs; mobile
  recall must not. A demo that copies a timeline link into a
  "mobile" screenshot is mixing surfaces.
- **Panel vault ≠ MCP vault.** `exocortex_search_semantic_vault`
  cannot see Chrome `semantic_vault`. Use the panel, or bridge a
  different tool (`exocortex_semantic_search` / `search_memory`).
  `exocortex_align_federated_kg` has the same split — it exports the
  CLI copy, not these snippets (`docs/federated-kg.md`).
- **Vault clock is index time.** `timestampUtc` is `Date.now()`
  after embed + classify, not the dwell payload clock used by
  frames. Retention still keys on that field (`docs/retention.md`).
- **No vault search in the UI.** Last five rows only. Older snippets
  remain in Dexie until the retention prune but are not listed.
- **The panel loads the retention setting itself.** It queries Dexie
  directly, so it calls `loadRetentionSetting()` before the first read
  (`docs/retention.md`).
- **The omaCortex status is one probe**, made only while that toggle is
  on. It is not live; reopen the panel to refresh it
  (`docs/omacortex-feed.md`).
- **Header "Scrubber" is leftover copy.** `.scrubber` / range CSS
  exists; there is no range input.
- **Nudge CTA and stack Resume are inert.** Overlay Restore and
  `data-url` reopen are the working actions.
- **`GET_SEMANTIC_KNOWLEDGE` is unused.** Do not document it as a
  public API. It also does not run `isSearchQueryBlocked`.
