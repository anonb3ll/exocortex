# Exocortex Feature & Usage Guide

**Exocortex** is an on-device, privacy-first Chrome Extension (Manifest V3) designed to act as external working memory for users managing cognitive load, ADHD, or complex multitasking.

## Requirements

- [Bun](https://bun.sh) 1, on your `PATH`. CI uses the `oven/bun:1` image. From the repository root: `bun install`, then `bun run build`. Load the unpacked `dist/` directory.
- Chrome 114 or newer. The side panel is the dashboard, and that API shipped in Chrome 114.

---

## Core Features

### 1. Passive Tab & Reading Capture
- **Consent first**: Capture is **off by default**. Enable **Local footprint capture** in the side panel before anything is recorded (`docs/capture-consent.md`).
- **Dwell Tracking**: After consent, captures web page context on a 5s dwell (`DWELL_THRESHOLD_MS` in `src/content/tracker.ts`).
- **DOM & Text Extraction**: Parses article content locally using Readability without sending data to cloud servers.
- **IndexedDB Storage**: Stores history in a local Dexie database. Records older than the retention window (**7 days** by default; 30, 90 or 365 days from the side panel) are pruned on service-worker start and excluded from search (`docs/retention.md`).

### 2. Zero-Trust Privacy Guard
- **Hostname substring blocklist**: Never captures banking, password managers, `login`/`auth` hosts, or privileged schemes (`chrome://`, `file://`, …). `mybank.example.com` and `login.example.com` are blocked; `/login` on an allowed host is not. Operator list and pitfalls: `docs/privacy-guard.md`.
- **URL & Param Scrubbing**: Strips userinfo and query keys that equal **or contain** tokens such as `token`, `auth`, `api_key`, `secret`, `jwt`, `password`, `key`, `code`, `state`.
- **Fail-Closed Protection**: Empty or unparseable URLs are blocked from capture.
- **Query gate (semantic / mobile only)**: `isSearchQueryBlocked` refuses `password` / `secret` / named hosts such as `chase.com` on the side-panel search box, MCP `exocortex_semantic_search`, and mobile recall. Keyword `exocortex_search_memory` skips this gate (`docs/privacy-guard.md`).
- **Vault export**: `exocortex_align_federated_kg` redacts secrets in excerpts and omits blocked URLs from Wiki notes.

### 3. Focus Shield & Cognitive Fatigue Monitoring
- **On-Device Fatigue Index**: Session time plus recent tab hops (not a WASM classifier). Overlay fires at fatigue ≥ 80; defaults **off**. See `docs/focus-shield.md`.
- **Focus Anchors**: Set explicit task anchors (`exocortex_set_focus_anchor`) to anchor your working state.
- **Drift Detection**: `exocortex_detect_drift` is **not** live over the native bridge — it reads the MCP process's in-process database unless you populated that store in the same process.

### 4. Federated Knowledge Graph (Obsidian Integration)
- **Vault Synchronization**: `exocortex_align_federated_kg` writes Obsidian `Wiki/` notes from the **MCP process** Dexie (`semantic_vault` + `cognitive_frames`). It does not read Chrome capture or the side-panel Librarian Vault. Operator runbook: `docs/federated-kg.md`.
- **Human-Authoritative Policy**: Never overwrites curated note bodies. `locked: true` frontmatter skips the file. Write-dir allowlist is `Wiki` / `00 - Inbox` / `Logs` (`UA_VAULT_WRITE_DIRS`).

### 5. Unified Agent MCP Interface
Twenty tools registered in `src/mcp/server.ts` (`tests/mcp-tool-surface.test.ts` pins the set):

- **Memory & Search**: `exocortex_search_memory`, `exocortex_open_memory`, `exocortex_semantic_search`, `exocortex_search_semantic_vault`, `exocortex_query_frames`
- **Context & Checkpoints**: `exocortex_create_cognitive_checkpoint`, `exocortex_restore_context`, `exocortex_get_working_memory_stack`, `exocortex_get_focus_anchor`, `exocortex_set_focus_anchor`
- **Projection**: `exocortex_project_focus_anchor`, `exocortex_project_task_reference`
- **Ingest**: `exocortex_record_frame`, `exocortex_record_desktop_frame`, `exocortex_summarize_page`
- **Telemetry & ops**: `exocortex_get_cognitive_load_telemetry`, `exocortex_get_sanitized_telemetry_export`, `exocortex_detect_drift`, `exocortex_align_federated_kg`, `exocortex_get_bridge_status`

Eleven of those are live over the native bridge when the extension is connected; the rest stay ephemeral. Full list and fail-closed behaviour: README "Native browser bridge".

---

## How to Use

### Step 1: Loading the Extension in Chrome
1. Build the production extension:
   ```bash
   bun run build
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle switch in the top-right).
4. Click **Load unpacked** and select this repo's `dist/` directory.
5. Open the side panel and enable **Local footprint capture** — nothing is recorded until this toggle is on.

### Step 2: Interacting with Chrome UI
- **Popup UI**: Click the Exocortex icon in the toolbar for the "Where Was I?" card, then **Open Side Panel** (required user gesture for `chrome.sidePanel.open()`). An empty card on first load is expected — capture is still off.
- **Side Panel**: Enable **Local footprint capture** (in-product consent). Then use the timeline, the search box (`Search footprint & memory...` — live hybrid recall, 200ms debounce; it drives **two** contracts at once: hybrid timeline with URLs vs sanitized mobile recall), the mobile-slice preview, Librarian Vault (last 5 Chrome snippets), and the separate Focus Shield toggle. You can also open the panel from Chrome's side-panel menu. Operator details: `docs/semantic-search.md`, `docs/sidepanel.md`.

### Step 3: Using MCP Tools with AI Agents
The MCP CLI (`bun src/mcp/cli.ts`) starts the native-bridge socket **by default**. Bridged searches fail closed until the extension is connected. For an empty in-process harness, set `EXOCORTEX_NATIVE_BRIDGE=0`.

When pair programming with agents:
- **Search past reading** (live, if the bridge is connected): `exocortex_search_memory(query="...")` is keyword/substring ranking and does **not** run the query privacy gate. `exocortex_semantic_search(query="...")` is hybrid recall (`matchKind: vector|lexical`); blocked queries throw. Results over the bridge for keyword search are `{parsedAt, score, handle}` — pass a handle to `exocortex_open_memory`.
- **Check bridge health**: `exocortex_get_bridge_status()` — read `data.mode` / `data.peerConnected`, not the envelope `source`.
- **Sync to Obsidian**: `exocortex_align_federated_kg()` exports non-sensitive entities to `$UA_VAULT_PATH/Wiki`. Seed `exocortex_record_frame` in the **same** CLI process first; a live bridge does not feed this tool. `processedEntities: 0` means the CLI Dexie was empty (`docs/federated-kg.md`).
- **Summarize a page**: `exocortex_summarize_page` is not Gemini Nano over the bridge. In the MCP CLI it truncates in-process `page_text` (`docs/built-in-ai.md`).

The CLI starts a desktop active-window poller only where it can read a window: an X11 session or macOS (`EXOCORTEX_DESKTOP_POLLING=1` forces it on, `=0` forces it off). A Wayland session starts it off, because `xdotool`/`xprop` see only XWayland windows there — omaCortex is the OS-level source on that desktop. Those frames write to the MCP process's throwaway IndexedDB, not Chrome. They are not `exocortex_query_frames` rows. Operator runbook: `docs/desktop-ingest.md`.

Env vars, native-host wrapper, and `GET_BRIDGE_HEALTH` vs
`exocortex_get_bridge_status`: `docs/native-bridge.md`.

---

## Troubleshooting

| Symptom | Likely cause | Where |
|---|---|---|
| Popup says "Browse pages for >5s" on a fresh load | Capture is **off by default** | Enable **Local footprint capture** in the side panel (`docs/capture-consent.md`) |
| Toggle on, still no dwell on `login.` / `auth.` / `*bank*` hosts | Privacy guard hostname substrings | `docs/privacy-guard.md` |
| MCP search empty / JSON-RPC error ~2s | Bridge on, Chrome not connected | `exocortex_get_bridge_status` → `data.peerConnected`; host install in `docs/native-bridge.md` |
| MCP `source: "ephemeral"` on a read tool | Tool not in `BRIDGE_BACKED_TOOLS`, or `EXOCORTEX_NATIVE_BRIDGE=0` | README tool list; envelope `source` on `get_bridge_status` is always ephemeral |
| Desktop poller frames missing from Chrome search | Poller writes CLI `db.frames` only; not bridge-backed | `docs/desktop-ingest.md` |
| `exocortex_query_frames` empty after recording a desktop window | Tool reads `cognitive_frames`, not `db.frames` | `docs/desktop-ingest.md` |
| `bun test` fails L1 manifest contract | `pretest` did not run | `bun run build` or `bun run test` |
| B* tests skipped | `EXOCORTEX_BROWSER_TESTS` unset | `EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run test` |
| Semantic hits all `matchKind: "lexical"` | No model embedding (Wasm/WebGPU failed or query embed fallback) | `docs/on-device-embeddings.md`, `docs/semantic-search.md` |
| Side panel: Fail-Closed Privacy Shield | Query matched `isSearchQueryBlocked` (`chase.com`, `my password`, …) | `docs/privacy-guard.md` — keyword search is a different tool |
| Side panel: "Semantic search unavailable — showing lexical matches" | Query embedder down; UI retried as labelled lexical | `docs/semantic-search.md` — MCP has no equivalent banner |
| `bun run test` green but `verify/` not run | `package.json` `"test"` is `bun test tests/` | `bun test verify/adversarial-probes.test.ts` (`docs/verify.md`) |
| MCP `exocortex_search_semantic_vault` empty while the panel lists snippets | Tool is not bridge-backed; panel reads Chrome Dexie | `docs/sidepanel.md` |
| `exocortex_align_federated_kg` writes nothing / empty Wiki | CLI Dexie empty; Chrome vault and desktop poller frames are not inputs | `docs/federated-kg.md` |
| `exocortex_summarize_page` is a truncated snippet, not a Nano summary | MCP CLI has no `window.ai`; tool truncates CLI `page_text` | `docs/built-in-ai.md` |
| Timeline search shows URLs, mobile slice does not | One `#search-input`, two contracts | `docs/sidepanel.md` |
| "Neuroergonomic Recommendation" with Focus Shield off | Nudge banner is advisory `GET_TELEMETRY`, not the overlay | `docs/focus-shield.md`, `docs/sidepanel.md` |
| Working memory **Resume** does nothing | Handler only honors `data-url` reopen buttons | `docs/sidepanel.md` |
