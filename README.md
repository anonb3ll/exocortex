# Project Exocortex

> **Local footprint & externalized working memory — Chrome Extension (Manifest V3)**

A privacy-first Chrome extension that acts as an external working memory for users
facing cognitive overload, ADHD, or frequent context switches. Everything runs
on-device: telemetry, embeddings, and classification never leave the browser.

## Architecture

| Layer | Where | What it does |
|---|---|---|
| **Sensor** | `src/content`, `src/background` | Consent-gated dwell tracking and Readability DOM parsing |
| **Privacy guard** | `src/content/privacy.ts` | Zero-trust hostname blocklist — banking, password managers, `login`/`auth` hosts, and privileged schemes are never captured. Shared query gate on semantic/mobile recall (`docs/privacy-guard.md`) |
| **Model engine** | `src/lib/models` | On-device MiniLM embeddings (WebGPU → WASM → labelled hash fallback) and cognitive-fatigue classification |
| **Agents** | `src/lib/agents` | Cognitive checkpointing, drift detection, context restoration |
| **Focus shield** | `src/lib/focus-shield` | Active intervention driven by fatigue state, with intervention caps |
| **Federated KG** | `src/mcp/federated-kg-aligner.ts` | Aligns captured entities into the Obsidian vault's `Wiki/` layer, which stays human-authoritative |
| **Surfaces** | `src/popup`, `src/sidepanel`, `src/offscreen` | "Where was I?" popup (opens the side panel on gesture), timeline + live semantic search (one box, two contracts) + librarian vault + capture-consent + mobile-slice + Focus Shield, offscreen embedder (`docs/sidepanel.md`, `docs/semantic-search.md`) |
| **MCP bridge** | `src/mcp` | Exposes the extension's memory to the `unified-agent` hub |

**Storage:** IndexedDB via Dexie (`src/lib/db.ts`), single consolidated schema version.
The `fake-indexeddb` polyfill is **test-only** (`tests/preload.ts` + `bunfig.toml`) and
must never enter the browser bundle — shipping it silently shadowed the real
`self.indexedDB` and crashed the service worker on load.

## MCP tool surface

Twenty tools registered in `src/mcp/server.ts`, consumed by the `unified-agent` hub
(`tests/mcp-tool-surface.test.ts` pins the exact set against the running binary):

`exocortex_record_frame` · `exocortex_record_desktop_frame` · `exocortex_query_frames` ·
`exocortex_search_memory` · `exocortex_open_memory` · `exocortex_semantic_search` ·
`exocortex_search_semantic_vault` · `exocortex_summarize_page` ·
`exocortex_get_working_memory_stack` · `exocortex_get_cognitive_load_telemetry` ·
`exocortex_get_focus_anchor` · `exocortex_set_focus_anchor` ·
`exocortex_project_focus_anchor` · `exocortex_create_cognitive_checkpoint` ·
`exocortex_project_task_reference` ·
`exocortex_restore_context` · `exocortex_detect_drift` · `exocortex_align_federated_kg` ·
`exocortex_get_sanitized_telemetry_export` · `exocortex_get_bridge_status`

`exocortex_project_task_reference` returns a contract-v1 `task_reference` edge from
the current focus anchor and a caller-supplied unified-agent task ID. It only returns
the allowlisted, minimised record; the receiver must verify that the task exists and
is non-terminal before persisting it.

`exocortex_get_bridge_status` reports CLI-side socket state (`mode`,
`bridgeListening`, `peerConnected`, `socketPath`, `bridgeBackedTools`). It is
not a browser-data tool and is not in `BRIDGE_BACKED_TOOLS`, so the envelope
`source` stays `ephemeral` — read `data.mode` / `data.peerConnected` instead.

## Capture consent (off by default)

Dwell capture does **not** start when you load the extension. The
content script (`src/content/tracker.ts`) re-reads
`exocortexCaptureConsent` from `chrome.storage.local` on every timer
start and treats anything other than `true` as no. Storage-read errors
are no.

Enable **Local footprint capture** in the side panel — that checkbox is
the in-product disclosure required before web history, activity, or page
text may be stored. Open the panel from the popup **Open Side Panel**
button (Chrome requires a user gesture for `chrome.sidePanel.open()`) or
from Chrome's side-panel menu.

Turning the toggle off stops capture and dwell reporting in open tabs
at once. Existing IndexedDB rows stay until retention prune.

After the 5s capture the tracker keeps counting foreground time and
reports the cumulative dwell when the page is hidden, unloaded or its
SPA URL changes, so a stored visit carries the time actually spent on
it. Site name, author and a `video` / `article` / `page` kind are
captured from the page's own metadata.

This flag is not MCP `consentBasis` and is not `focus_shield_enabled`.
The MCP CLI never reads it. Operator details, test seeding, and
pitfalls: `docs/capture-consent.md`.

## Focus Shield workflow

Focus Shield is opt-in and stored as `focus_shield_enabled` in local extension
storage (default **off**). The side-panel toggle writes only that flag; the
fatigue threshold (80) and 30-minute intervention cap have no UI. When the
threshold is reached on the still-active capture tab, the service worker shows a
dismissible closed-shadow-DOM overlay. Restore opens the extension-owned side
panel; saved context prompts never enter the page DOM. Observer state, known tab
classifications, and the cooldown persist across MV3 service-worker restarts.
The worker also writes the active anchor frame, nudge, and session clocks to
`chrome.storage.session` (falls back to `local`); restored frames older
than the retention cutoff are dropped so a long Chrome sleep cannot
keep driving drift past the window.
Known `Distraction / Rabbit Hole` tabs can be grouped into collapsed
`Exocortex — Parked Context`. It never closes tabs and skips active, pinned,
already-grouped, blocked, and special-scheme tabs.

Fatigue is session time plus recent tab hops, not dwell length — a short quiet
session will not fire. Operator defaults, parking rules, and pitfalls:
`docs/focus-shield.md`.

## Semantic search

Two surfaces share `hybridVectorSearch` and the query privacy guard
(`docs/semantic-search.md`):

- **Side panel** — typing in `#search-input` (200ms debounce) runs
  `searchPanelMemory`. Blocked queries show a Fail-Closed Privacy Shield
  and never call the embedder. When the embedder is down, the
  orchestration status is `embedding_unavailable`; the UI then retries
  as labelled lexical with the banner "Semantic search unavailable —
  showing lexical matches". Cards badge `vector · cos 0.xx` or `lexical`.
- **MCP `exocortex_semantic_search`** — rescores by MiniLM cosine **only**
  when a real query vector exists (the embedder lives in the offscreen
  document). Blocked queries throw. Missing vector degrades in-place to
  `matchKind: "lexical"` with `cosineSimilarity: null` — no banner.

Every ranked hit carries `matchKind`:

- `vector` — a genuine embedding comparison; `cosineSimilarity` is a real number.
- `lexical` — token overlap against title/url/summary; `cosineSimilarity` is `null`.

Check the field before treating a hit as semantic. Embeddings are also tagged at
rest (`EmbeddingRecord.source`): if ONNX/Wasm is unavailable the extension stores a
hash bag-of-words `fallback` vector, and those are never used for cosine rescoring
or for drift detection — a fallback has an embedding's shape but none of its
semantics.

`exocortex_search_memory` is **not** this path: it is substring ranking
over `page_text` and does not run `isSearchQueryBlocked`.

The live embedder is Transformers.js v3 (`@huggingface/transformers`), model
`Xenova/all-MiniLM-L6-v2` (384-d). In Chrome it tries WebGPU then WASM; under
Bun/Node it uses CPU. A WebGPU rung that fails inference is demoted for the
offscreen document's lifetime so later captures skip to WASM. Input is truncated
at 8000 characters; model load and inference are each bounded to 15s. A cosine
below 0.35 does not outrank a strong keyword hit (`VECTOR_RELEVANCE_FLOOR`).
First use downloads the ONNX weights from Hugging Face and can exceed the
default 2s bridge deadline — `semantic_search` is therefore allowed 30s.
Operator details: `docs/semantic-search.md`. Device ladder, demotion, and
failure modes: `docs/on-device-embeddings.md`.

## Desktop window ingest

`exocortex_record_desktop_frame` and the CLI active-window poller write
the **MCP process** Dexie (`db.frames`, `sourceType: "desktop_window"`),
not the Chrome profile. The tool is not in `BRIDGE_BACKED_TOOLS`.
Operator details: `docs/desktop-ingest.md`.

- `url` is `desktop://app/<urlencoded-app-name>`. Blank labels become
  `Desktop App` / `Desktop Window`. Non-finite dwell becomes 2; otherwise
  `max(1, round(seconds))`.
- Category is a first-match substring on the app (YouTube matches the
  title): Slack/Discord/Mail/Telegram/Teams/Zoom → `Communication & Async`;
  Spotify/YouTube/Steam/Netflix/Twitch → `Distraction / Rabbit Hole`;
  everything else → `Deep Work (Drafting/Coding)`.
- The MCP schema still accepts `ocrText`; the handler ignores it. No OCR
  engine is shipped.

`src/mcp/cli.ts` starts `startDesktopWindowPoller()` only where the sensor
can actually read a window: an X11 session or macOS
(`EXOCORTEX_DESKTOP_POLLING=1` forces it on, `=0` forces it off; interval
`EXOCORTEX_DESKTOP_POLL_INTERVAL_MS`, default 2s). Linux uses `xdotool`
+ `xprop`, so a Wayland session starts it off — there it sees only
XWayland windows, and omaCortex is the OS-level source
(`docs/desktop-ingest.md`). Windows returns null. Missing OS
tools are a silent no-op.

The poller records the **previous** window on app/title change after
≥ 1s dwell. It does not flush the frontmost window on CLI exit.
`exocortex_query_frames` reads `cognitive_frames` and will not list
these rows even unbridged. Unbridged `exocortex_semantic_search` with
`sourceType: "desktop_window"` is the recall path — and is lexical
only, because desktop ingest never writes embeddings.

## Retention

Capture is retained for **7 days** by default (`DEFAULT_RETENTION_MAX_AGE_DAYS`
in `src/lib/db.ts`). The side panel's **Keep history for** selector changes
that to 30 days, 90 days or 1 year; choosing a shorter window prunes
immediately. The service worker prunes every Dexie table on install, on
startup and when the setting changes. Keyword search and hybrid vector search
also drop rows older than the cutoff, so a delayed prune cannot leak expired
hits.

`EXOCORTEX_RETENTION_DAYS` is honoured by the MCP / Node process only; the
loaded extension does not read that env var.
Operator details, table timestamp fields, and pitfalls: `docs/retention.md`.

## omaCortex feed (optional, off by default)

**Also send page titles to omaCortex** in the side panel passes each
captured page's minimized URL, title, site, author, kind and dwell to the
local [omaCortex](https://github.com/anonb3ll/omaCortex) recorder over
native messaging, so the visit outlives this extension's retention window.
Page text, excerpts, embeddings and search queries are never sent. Set up
with `omacortex browser install --extension-id <this extension's id>`.
Contract and gates: `docs/omacortex-feed.md`.

## Native browser bridge (default on)

`bun src/mcp/cli.ts` starts the native-bridge Unix socket unless
`EXOCORTEX_NATIVE_BRIDGE=0`. Bridged tools then fail closed (JSON-RPC error
within ~2s) until the extension connects — they do **not** fall back to the
empty in-process database. For an ephemeral-only harness (tests, no Chrome),
set `EXOCORTEX_NATIVE_BRIDGE=0`.

The MCP process still owns an in-process IndexedDB harness (imported via
`fake-indexeddb/auto` in `src/mcp/cli.ts`). That database starts empty and is
discarded on exit. Every tool response is labelled `source: "live" | "ephemeral"`
so an empty result is not mistaken for "the browser has no such memory".

The process opens a Unix socket at `$XDG_RUNTIME_DIR/exocortex-mcp-bridge.sock`
(or `EXOCORTEX_NATIVE_BRIDGE_SOCKET`) with mode `0600`; it never opens a TCP
listener. The wire is protocol **v4**; version skew is rejected, not degraded
into a `live` payload of the wrong shape.

Only these eleven tools cross the bridge (`BRIDGE_BACKED_TOOLS` in
`src/mcp/source-envelope.ts`, pinned against `TOOL_TO_BRIDGE_TYPE` and
`BRIDGE_REQUEST_TYPES` by `tests/bridge-protocol.test.ts`):

`exocortex_search_memory` · `exocortex_query_frames` ·
`exocortex_semantic_search` · `exocortex_get_working_memory_stack` ·
`exocortex_restore_context` · `exocortex_get_focus_anchor` ·
`exocortex_set_focus_anchor` · `exocortex_project_task_reference` ·
`exocortex_get_cognitive_load_telemetry` ·
`exocortex_get_sanitized_telemetry_export` · `exocortex_open_memory`

Eight data tools stay ephemeral **even with the bridge on**:
`exocortex_record_frame`, `exocortex_record_desktop_frame`,
`exocortex_create_cognitive_checkpoint`, `exocortex_project_focus_anchor`,
`exocortex_detect_drift`, `exocortex_search_semantic_vault`,
`exocortex_summarize_page`, and `exocortex_align_federated_kg`.
`exocortex_get_bridge_status` is also not bridge-backed (see above).

Task-reference projection *is* live (it builds the focus-anchor record
inside the service worker); `exocortex_project_focus_anchor` itself is
not mapped, so calling it over a connected bridge still reads the empty
in-process database. `exocortex_align_federated_kg` writes markdown to
disk either way, but sources entities from that same empty DB unless you
first populated it in-process, so it is labelled ephemeral. Unbridged
`exocortex_open_memory` throws rather than pretending a handle resolved.
The side-panel **Librarian Vault** list is Chrome `semantic_vault`
(last 5); `exocortex_search_semantic_vault` does not see it
(`docs/sidepanel.md`).

Host install, wrapper script, env vars, and diagnostics:
`docs/native-bridge.md`. Allow-list the **loaded** unpacked ID (not a
packed-CRX ID) in `allowed_origins`. Chrome execs the host `path`
directly — that file must be an executable wrapper that exports
`EXOCORTEX_NATIVE_BRIDGE_SOCKET` and runs
`scripts/exocortex-native-host.ts`. Moving `dist/` changes the
unpacked ID. `EXOCORTEX_NATIVE_BRIDGE=0` is the empty in-process
harness only.

If the native host is absent — the default for every user who has not done the above —
the extension stays fully functional. The port is refused, the service worker retries on
a bounded backoff (1s/5s/30s) and then gives up rather than spinning, and searches fail
closed. After giving up it tries once more on later activity (a captured page), at most
once a minute, so a host installed mid-session connects without a Chrome restart. Extension-side `GET_BRIDGE_HEALTH` and MCP
`exocortex_get_bridge_status` are **different objects** — see
`docs/native-bridge.md`.

The native-host manifest restricts callers to the configured extension ID. The Unix socket restricts the relay to the same OS user. The bridge accepts only bounded, allowlisted arguments and returns minimized results; page text, excerpts, titles, and URLs never cross this boundary. It does not capture pages, accept DOM/text payloads, log request data, sync between devices, or bypass existing privacy filters. Roll back by setting `EXOCORTEX_NATIVE_BRIDGE=0` and unregistering the native host.

#### Opaque handles

`exocortex_search_memory` returns `{parsedAt, score, handle}` over the bridge. The
handle is the answer to a problem the minimization created: the one tool with a real
path to browser data was returning results an agent could count but not name or act
on.

A handle is the local `page_text` row id (`mem_12`), deliberately **not** a hash of
the URL — a hash is still a deterministic function of the URL, so anyone holding a
list of candidate URLs could confirm which the user had visited. Only the browser
profile that issued a handle can resolve it.

`exocortex_open_memory` takes a handle and opens that page in the user's browser.
The URL is resolved and used inside the service worker and never returned; the reply
is `{status, handle}` where status is `opened`, `not_found`, `blocked`,
`invalid_handle`, or `rate_limited`. Opens are capped at **5 per 60s**
(`MEMORY_OPEN_LIMIT` / `MEMORY_OPEN_WINDOW_MS`) so an agent cannot enumerate
`mem_1`…`mem_N` into a tab storm. Blocklisted URLs are re-checked at open time,
because the privacy blocklist may have grown since the page was captured. Note
this is a visible side effect on the user's browser — an agent can open tabs, it
just cannot read them.

`exocortex_align_federated_kg` still writes markdown to the local vault
(outside the wire boundary), but it sources entities from the MCP
process Dexie (`semantic_vault` + `cognitive_frames`) — **not** Chrome,
and **not** desktop-poller `db.frames`. A connected bridge does not
change that. Writes are sanitized (`sanitizeUrlForKg` /
`sanitizeExcerpt`); blocked-domain entities can still produce a note
without a Captured Sources URL. The vault remains human-authoritative
(`locked: true` notes are skipped; existing bodies are never
rewritten). Operator details: `docs/federated-kg.md`.

## MCP / test environment variables

These are process env vars for the MCP CLI and the test runner. The
loaded extension does not read them.

| Variable | Default | Meaning |
|---|---|---|
| `EXOCORTEX_NATIVE_BRIDGE` | on (`=0` opts out) | Unix-socket bridge in `cli.ts` |
| `EXOCORTEX_NATIVE_BRIDGE_SOCKET` | `$XDG_RUNTIME_DIR/exocortex-mcp-bridge.sock` | Socket path; host wrapper must match |
| `EXOCORTEX_DESKTOP_POLLING` | X11/macOS on, Wayland off (`=1`/`=0` force) | Active-window poller (CLI Dexie only) |
| `EXOCORTEX_DESKTOP_POLL_INTERVAL_MS` | `2000` | Poller interval |
| `EXOCORTEX_RETENTION_DAYS` | `7` | MCP Dexie cutoff; Chrome uses the side-panel setting |
| `UA_VAULT_PATH` | `$HOME/vaults/main` | Vault root for `exocortex_align_federated_kg` |
| `UA_VAULT_WRITE_DIRS` | `Wiki:00 - Inbox:Logs` | Colon-separated allowlist; PARA folders refused |
| `EXOCORTEX_BROWSER_TESTS` | unset (B* skipped) | Opt-in real Chrome; always headless |
| `EXOCORTEX_EMBEDDER_TESTS` | unset (3 skipped) | Opt-in CPU embedder tests that download the MiniLM weights |

Operator details: `docs/native-bridge.md`, `docs/retention.md`,
`docs/federated-kg.md`.

## Getting started

This project uses **Bun**. `bun.lock` is the lockfile.

```bash
bun install
bun run build
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` directory
4. Open the side panel and enable **Local footprint capture** — dwell
   recording stays off until that toggle is on (`docs/capture-consent.md`)

## Development

```bash
bun run build                 # tsc type-gate + extension bundle + content-script bundle
bun run test                  # pretest rebuilds dist/, then the suite (B* skipped)
bun test                      # bun's runner directly — does not build
EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run test   # full suite including real Chrome (CI form)
EXOCORTEX_EMBEDDER_TESTS=1 bun run test              # also run the MiniLM download tests
bun run dev                   # Vite dev server
```

`package.json` `pretest` runs `bun run build`. `bun run test` therefore always
has a fresh `dist/`. `bun test` (the bun builtin) skips that hook: on a fresh
checkout the L1 manifest/artifact contract fails until you have built, which is
the harness working, not a broken setup.

The three tests that download MiniLM weights are **opt-in** via `EXOCORTEX_EMBEDDER_TESTS=1`. Without it they skip, so `bun run test` does not need huggingface.co. The assertions inside a test that runs are unchanged.

The B* (real Chrome) layer is **opt-in** via `EXOCORTEX_BROWSER_TESTS=1` and
always launches headless. A live desktop `DISPLAY` is not treated as a test
display — otherwise Chrome steals focus on the operator session. CI
(`.github/workflows/ci.yml`) sets the env var and wraps the suite in
`xvfb-run -a`. Task #1235 added a Depot mapping of that same job
(`.depot/workflows/ci.yml`, `runs-on: depot-ubuntu-latest`). A skipped
B-layer is not evidence the extension loads.

Neither of those two venues currently runs (billing and a minute cap), so CI
runs on Google Cloud Build instead: `scripts/cloud-ci.sh <pr|branch|sha>`
builds that exact commit, runs this same suite with the B* layer on, and posts
the commit status `CI / build`. Setup, cost and recovery: `docs/ci.md`.

`bun run test` is `bun test tests/`. Adversarial probes under `verify/`
are not in that glob — run `bun test verify/adversarial-probes.test.ts`
separately (`docs/verify.md`).

`bun run build` runs two Vite passes: the main bundle, and `vite.content.config.ts`
for the content script. The content script is injected as a **classic** script, so it
cannot contain ESM `import` statements — `tests/manifest-artifact-contract.test.ts`
gates exactly that. A green `bun run build` alone does **not** prove the extension
loads; four consecutive phases shipped with a dead content script before that test
existed.

Note: `tsc` is a type gate only (`noEmit`). Vite bundles the `.ts` sources directly,
which is why `src/**/*.js` is gitignored — emitted siblings would shadow the sources.

## Workflow

Developed under the hub-and-spoke model with the `unified-agent` project: branch from
`main` → worktree `task/<id>-<slug>` → TDD → PR. Review runs through the
`unified-agent-review` CLI. See the vault's `Wiki/Workspace-Sync-Guide.md` for which
directory to launch agents in.

## Documentation

- `docs/capture-consent.md` — CWS opt-in gate, storage key, B* seeding, fail-closed pitfalls
- `docs/sidepanel.md` — dual search contracts, Librarian Vault vs MCP `exocortex_search_semantic_vault`, nudge banner
- `docs/privacy-guard.md` — hostname blocklist, URL/DOM sanitization, shared query vs capture guards
- `docs/semantic-search.md` — side-panel vs MCP recall, `matchKind`, query gate, embedder-outage banners
- `docs/verify.md` — opt-in adversarial / live-Chrome probes; not part of `bun run test`
- `docs/native-bridge.md` — native-host wrapper, loaded extension ID, health APIs, env vars
- `docs/desktop-ingest.md` — CLI window poller + `exocortex_record_desktop_frame`: `db.frames` only, not Chrome
- `docs/federated-kg.md` — `exocortex_align_federated_kg`: CLI Dexie vs Chrome vault, write-dir allowlist, locked notes
- `docs/built-in-ai.md` — Prompt API gate (`window.ai.languageModel`); dwell taxonomy is regex; MCP summarize truncates
- `docs/on-device-embeddings.md` — live Transformers.js v3 embedder, device ladder, WebGPU demotion, capture clock, pitfalls
- `docs/exocortex-sdk-core-contract.md` — Python Core SDK (`uv run pytest`); hub adapter is flagged off
- `examples/citetrail_consumer/README.md` — first external consumer proof over `InMemoryCore`
- `docs/focus-shield.md` — opt-in overlay, fatigue threshold, tab parking, MV3 persistence
- `docs/retention.md` — capture window (7 days default; side-panel selector), prune vs read-path filter, env-var limits
- `docs/omacortex-feed.md` — optional feed of page titles to the local omaCortex recorder: contract, gates, missing-host behaviour
- `docs/PRIVACY.md` — local-first privacy policy (CWS listing URL)
- `CHROMEWEBSTORE.md` — store listing draft, permission justifications, asset checklist
- `docs/exocortex-mobile-architecture-spike.md` — mobile thin-slice ADR, including the side-panel preview
- `docs/webgpu-embedding-proof-slice-2026-08-20.md` — historical WebGPU proof packet (superseded for the live path)
- `docs/portfolio-demo-task-337.md` — "Where was I?" popup capture/recall evidence (popup uses `recallLatestContext()`, not cognitive frames)
- [`USAGE.md`](USAGE.md) — Comprehensive Feature & User Guide (Features, Chrome UI, Privacy, and MCP usage)
- `docs/roadmap.md` — development roadmap (living document; the archived vault snapshot is superseded)
- `docs/spec-fully-working-web-extension-2026-08-12.md` — point-in-time spec for a fully working extension
- `docs/spec-phase-3.1-on-device-ai-and-local-embeddings-2026-07-25.md` — point-in-time Phase 3.1 spec
- Vault `Wiki/` layer — federated knowledge graph notes synchronized via `exocortex_align_federated_kg`

