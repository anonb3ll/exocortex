# Native browser bridge

Operator runbook for the Unix-socket relay between the MCP CLI and the
loaded Chrome extension. Architecture, tool list, and wire minimization
live in README "Native browser bridge". This page is install,
diagnostics, and failure modes.

## Intent

Give eleven allowlisted MCP tools a path to the **Chrome profile's**
Dexie, labelled `source: "live"`. Everything else stays on the CLI's
empty in-process database (`fake-indexeddb`), labelled `ephemeral`.

The extension is fully usable without a native host. A missing host is
the normal case: the service worker retries, then gives up, and does
not spin. Giving up is not permanent — the next captured page makes one
more attempt, at most once a minute.

This is not the omaCortex feed. That is a different native host and
one-shot messages (`docs/omacortex-feed.md`).

## Architecture

```
bun src/mcp/cli.ts
        │ NativeBridgeServer  mode 0600 Unix socket
        │ default: $XDG_RUNTIME_DIR/exocortex-mcp-bridge.sock
        ▼
scripts/exocortex-native-host.ts   (Chrome-spawned stdio relay)
        │ Native Messaging length-prefixed JSON
        │ host name: io.exocortex.mcp_bridge
        ▼
service worker  chrome.runtime.connectNative(...)
        │ handlers + minimizeBridgeResult (protocol v4)
        ▼
Chrome IndexedDB (ExocortexVault)
```

| Piece | Path | Role |
|---|---|---|
| CLI | `src/mcp/cli.ts` | Listen unless `EXOCORTEX_NATIVE_BRIDGE=0` |
| Socket | `src/bridge/server.ts` | One peer; a second connection supersedes the first |
| Relay | `scripts/exocortex-native-host.ts` | No page data; logs nothing; exits on >64 KiB frames |
| Client | `src/background/native-bridge-client.ts` | Connect / backoff / `GET_BRIDGE_HEALTH` |
| Protocol | `src/bridge/protocol.ts` | v4; default deadline 2s; `semantic_search` 30s |
| Manifest example | `config/native-messaging/io.exocortex.mcp_bridge.json.example` | `path` + `allowed_origins` |

Chrome execs the host manifest `path` **directly**. That file must be
executable. Pointing `path` at the `.ts` source without a wrapper is
not enough.

## Env vars (MCP / Node process)

| Variable | Default | Meaning |
|---|---|---|
| `EXOCORTEX_NATIVE_BRIDGE` | **on** | Only `=0` disables the socket |
| `EXOCORTEX_NATIVE_BRIDGE_SOCKET` | `$XDG_RUNTIME_DIR/exocortex-mcp-bridge.sock` (else `/tmp/…`) | Socket path; host wrapper must export the same value |
| `EXOCORTEX_DESKTOP_POLLING` | **on** | Only `=0` disables the OS-window poller |
| `EXOCORTEX_DESKTOP_POLL_INTERVAL_MS` | `2000` | Poller interval |
| `EXOCORTEX_RETENTION_DAYS` | `7` | MCP Dexie only — not the Chrome profile |
| `UA_VAULT_PATH` | `$HOME/vaults/main` | `exocortex_align_federated_kg` vault root (`docs/federated-kg.md`) |
| `UA_VAULT_WRITE_DIRS` | `Wiki:00 - Inbox:Logs` | Colon-separated write allowlist; not a tool argument |
| `EXOCORTEX_BROWSER_TESTS` | unset | Opt-in B* real Chrome; always headless |

The gate is `!== "0"`, not `=== "1"`. Omitting the var is already on.

None of these reach the service worker. Chrome retention is the
side-panel setting, 7 days by default (`docs/retention.md`).

## Two health APIs

They are not the same object.

| API | Where | What it answers |
|---|---|---|
| `GET_BRIDGE_HEALTH` | Extension page / SW (`chrome.runtime.sendMessage`) | Client: `connected`, `connectAttempts`, `disconnects`, `served`, `rejected`, `lastError`, `gaveUp` |
| `exocortex_get_bridge_status` | MCP tool | CLI: `mode`, `bridgeListening`, `peerConnected`, `socketPath`, `bridgeBackedTools`, `summary` |

`get_bridge_status` is **not** in `BRIDGE_BACKED_TOOLS`. Envelope
`source` stays `ephemeral` even when the socket is up — read
`data.mode` / `data.peerConnected`.

From an extension page (popup or side panel DevTools):

```js
chrome.runtime.sendMessage({ type: "GET_BRIDGE_HEALTH" }, console.log);
```

`gaveUp: true` with `connected: false` means the host was missing or
the 1s / 5s / 30s backoff exhausted. A throw from `connectNative`
gives up immediately. `lastError` is `chrome.runtime.lastError` on
disconnect.

`gaveUp` is a state, not a verdict. While it is true, each captured
page calls `nudge()`, which makes **one** new connection attempt if at
least 60 s (`RETRY_AFTER_GIVE_UP_MS`) have passed since the last one. A
failed nudge gives up again at once and schedules nothing. So a host
installed, or an MCP CLI started, mid-session connects on the next page
you read instead of at the next Chrome restart; a missing host costs
one failed connect per minute of active browsing and none while idle.
A host that served a request and then dropped restarts the 1s backoff.

## Usage — register a host for this unpacked load

1. `bun run build` and load `dist/` unpacked (`chrome://extensions`).
2. Copy the **loaded** ID (the path-derived ID on
   `chrome-extension://<id>/…`). Packing a CRX does not retarget a
   running unpacked instance.
3. Write an executable wrapper that pins the same socket the CLI uses:

```sh
#!/bin/sh
export EXOCORTEX_NATIVE_BRIDGE_SOCKET="${XDG_RUNTIME_DIR:-/tmp}/exocortex-mcp-bridge.sock"
exec /absolute/path/to/bun /absolute/path/to/exocortex/scripts/exocortex-native-host.ts
```

`chmod +x` the wrapper. Put that absolute path in the host manifest
`path` field (see the example JSON). `allowed_origins` must be
`["chrome-extension://<loaded-id>/"]`.

4. Install as `io.exocortex.mcp_bridge.json` in Chrome's **per-user**
   Native Messaging Host directory, then restart Chrome:
   - Linux Chrome: `~/.config/google-chrome/NativeMessagingHosts/`
   - Linux Chromium: `~/.config/chromium/NativeMessagingHosts/`
   - macOS Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
5. `bun src/mcp/cli.ts` (bridge on by default). Bridged tools fail
   closed (~2s) until `peerConnected` is true.

B* `tests/live-native-bridge.test.ts` does the same two-pass dance
(probe ID, write wrapper + manifest under a throwaway
`--user-data-dir`) and never writes `~/.config/google-chrome`.

Roll back: `EXOCORTEX_NATIVE_BRIDGE=0` and remove the host manifest.

## Pitfalls

- **Unpacked ID ≠ packed ID.** The example JSON used to say
  `REPLACE_WITH_PACKED_EXTENSION_ID`. Allow-list the ID Chrome is
  actually running. Moving `dist/` changes the unpacked ID.
- **CLI listening ≠ extension connected.** `bridgeListening` can be
  true while `peerConnected` is false (host missing, wrong origin, or
  worker still backing off).
- **Default-on CLI, default-off host.** Starting `cli.ts` opens the
  socket. Chrome will not connect until the host manifest exists.
- **Two stores.** Poller / `record_*` writes land in the CLI
  `fake-indexeddb` and die with the process. Bridged search sees only
  Chrome. Consent in the side panel does not fill the CLI DB.
  Desktop rows: `docs/desktop-ingest.md`.
- **Eight data tools stay ephemeral** even with a live peer, including
  `exocortex_project_focus_anchor` and `exocortex_detect_drift`. List:
  README.
- **Protocol v4 is fail-closed.** Version skew is rejected, not
  degraded into a `live` payload of the wrong shape.
- **Focus entities are minimized too.** For a captured page the
  classifier often sets `primaryFocusEntity` to the page title and
  `workingStateSummary` to "Working on <title>" or the head of the
  excerpt. Over the bridge (`query_frames`, `get_focus_anchor`,
  `get_cognitive_load_telemetry`, `project_task_reference`) the summary
  becomes "<category> on <site>", or just the category when the site
  is not printable. The entity keeps its value only when it is already
  the label (the site, else the category). Other captured entities can
  contain titles, classifier paraphrases, or URL paths. `query_frames`
  filters on that same wire-visible entity. Agent-set anchors
  (`set_focus_anchor`) pass through unchanged.
- **Stored goals carry their provenance, not their text.** The working
  memory stack and the cognitive checkpoints behind `restore_context`
  keep the full goal at rest (the side panel shows it to the user) and
  store beside it the answer to "was this copied out of the page
  title?" (`focusDerivedFromPageTitle` / `goalDerivedFromPageTitle`),
  decided at capture while the frame is still in hand
  (`src/lib/title-provenance.ts`). `get_working_memory_stack` and
  `restore_context` answer with the site label recorded at capture
  instead of the goal string, and drop the tab titles and URLs from
  the restored prompt. A row written before that flag existed is
  treated as captured, not assumed safe — a missing flag must never
  read as "safe". Chrome's AI classifier paraphrases a title rather
  than copying it, which is why this is a stored flag and not another
  string comparison.
- **Second Chrome wins.** A new native-messaging connection supersedes
  the previous peer and fails in-flight requests.
- **Relay is size-capped.** Declared native frames larger than 64 KiB
  exit the host (`process.exit(1)`) so a bad length prefix cannot stall
  stdin.
- **`semantic_search` cold start.** First call may download MiniLM and
  is allowed 30s; other bridged tools stay at 2s
  (`docs/on-device-embeddings.md`).
- **`exocortex_search_semantic_vault` is not the panel vault.** The
  side-panel **Librarian Vault** reads Chrome Dexie `semantic_vault`
  (last 5). The MCP tool is not bridge-backed, so it searches the
  CLI's empty in-process table. Operator split: `docs/sidepanel.md`.
- **Query gate is on `semantic_search` only.** The bridge
  `semantic_search` validator, the service-worker handler, and
  `handleSemanticSearch` all run `isSearchQueryBlocked` and throw
  `"Search query matches privacy blocklist"`. `search_memory` does
  **not** — keyword search over `page_text` can still match a string
  semantic search would refuse (`docs/privacy-guard.md`).
