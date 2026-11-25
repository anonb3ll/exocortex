# Desktop window ingest

Operator runbook for OS active-window polling and
`exocortex_record_desktop_frame`. Both write the **MCP process** Dexie
(`db.frames`), not the Chrome profile. Native-bridge install:
`docs/native-bridge.md`. OCR is unshipped (`src/offscreen/ocr.ts`
returns `""`).

## Intent

Record which native app was in front, without capturing window
contents. The poller is a CLI-side sensor. Consent
(`exocortexCaptureConsent`) does not apply — that gate is Chrome dwell
only (`docs/capture-consent.md`).

Rows are privacy-minimized: app name, window title, a `desktop://`
URL, a coarse category, and dwell seconds. No screenshot, no OCR, no
embedding.

## Architecture

```
bun src/mcp/cli.ts
        │ resolveDesktopPolling()  (X11/macOS: on · Wayland/no DISPLAY: off)
        │ interval: EXOCORTEX_DESKTOP_POLL_INTERVAL_MS || 2000
        ▼
startDesktopWindowPoller          src/mcp/desktop-ingest.ts
        │ Linux:  xdotool getwindowname + xprop WM_CLASS
        │ macOS:  osascript System Events
        │ else / missing tools / timeout (1.5s) → null (silent)
        │
        │ on appName or windowTitle change:
        │   if previous dwell ≥ 1s → recordDesktopFrame(previous)
        ▼
db.frames  sourceType: "desktop_window"
           url: desktop://app/<urlencoded-app-name>
```

| Piece | Path | Role |
|---|---|---|
| CLI start | `src/mcp/cli.ts` | Starts/stops the poller; logs to stderr |
| Poller | `src/mcp/desktop-ingest.ts` | Transition detector; `unref()` so it does not keep the process alive |
| Writer | `src/lib/desktop-frame.ts` | Normalize labels, category, dwell clamp |
| MCP tool | `src/mcp/tools.ts` `handleRecordDesktopFrame` | Same writer; **not** in `BRIDGE_BACKED_TOOLS` |
| Chrome dwell | `src/background/service-worker.ts` | Separate `db.frames.add` — no `sourceType`, real embeddings |

The poller and the MCP tool share one table and one process. Chrome
dwell uses the same *schema* in a different IndexedDB. They never mix.

`exocortex_query_frames` reads `cognitive_frames`, not `db.frames`.
Desktop rows never appear there. `exocortex_search_memory` reads
`page_text`; desktop ingest does not write that table either.

## Defaults

| Input | Default | Notes |
|---|---|---|
| `EXOCORTEX_DESKTOP_POLLING` | resolved | `1`/`true` forces on, `0`/`false` forces off; unset follows the session (`resolveDesktopPolling`) |
| `EXOCORTEX_DESKTOP_POLL_INTERVAL_MS` | `2000` | `Number(env) \|\| 2000` — `0`, NaN, unset all become 2000 |
| First poll | no write | Establishes baseline; the still-frontmost window is never flushed on CLI exit |
| Dwell gate | ≥ 1s | Shorter previous windows are dropped on transition |
| Blank `appName` / `windowTitle` | `Desktop App` / `Desktop Window` | Trim-empty only |
| Non-finite `dwellTimeSeconds` | `2` | Else `max(1, round(seconds))` — `0` becomes `1` |
| `ocrText` | ignored | Present on the MCP schema; `handleRecordDesktopFrame` does not pass it |

Category is a first-match substring on the **app** (YouTube is the
exception — it matches the **title**):

- Slack / Discord / Mail / Telegram / Teams / Zoom → `Communication & Async`
- Spotify / Steam / Netflix / Twitch, or title contains `youtube` → `Distraction / Rabbit Hole`
- everything else → `Deep Work (Drafting/Coding)`

`Mail` matches any app whose name contains `mail` (including Gmail).
There is no `Research & Gathering` / `Task Execution & Ops` bucket on
this path.

## Wayland (this desktop): off by default, omaCortex is the OS-level source

The Linux sensor is `xdotool getactivewindow getwindowname` plus
`xprop WM_CLASS`. Both are X11 protocol clients: on a Wayland session they
see XWayland windows or nothing at all, and the poller swallows the failure
into `null`, so it looks alive while writing no frames. That was task #2626:
the Hyprland desktop ran a sensor that could not see it.

So the poller does not start by default when `WAYLAND_DISPLAY` is set or
`XDG_SESSION_TYPE=wayland`, and the CLI says why on stderr. On that desktop
the OS-level source is [omaCortex](https://github.com/anonb3ll/omaCortex): it
records window focus from Hyprland's socket into a durable store and serves
`omacortex_now` / `recall` over MCP. Desktop recall belongs there.

`EXOCORTEX_DESKTOP_POLLING=1` still forces the poller on — the startup line
then warns that it will record nothing — and `=0` forces it off anywhere.
The flag decides whether it runs, not what it can see.

Two limits stay true either way: these frames are written to the MCP
process's in-memory Dexie and are lost when it exits, and OCR is unshipped.

## Usage

Disable the poller in an ephemeral harness:

```bash
EXOCORTEX_NATIVE_BRIDGE=0 EXOCORTEX_DESKTOP_POLLING=0 bun src/mcp/cli.ts
```

Record a window in-process (same empty CLI Dexie the poller uses):

```js
exocortex_record_desktop_frame({
  appName: "Code",
  windowTitle: "exocortex — desktop-ingest.ts",
  dwellTimeSeconds: 45
})
// → { status: "success", frameId: <dexie id> }
```

Inspect those rows with **unbridged** `exocortex_semantic_search` and
`sourceType: "desktop_window"`. With the native bridge on, that tool
is live against **Chrome** `db.frames`, which the poller never writes.

```js
// Only sees CLI poller/tool rows when EXOCORTEX_NATIVE_BRIDGE=0
exocortex_semantic_search({
  query: "exocortex",
  sourceType: "desktop_window"
})
```

Linux needs `xdotool` and `xprop` on `PATH`. macOS uses `osascript`.
Windows (`process.platform` other than `linux` / `darwin`) always
returns `null`.

## Tests

- Writer: `tests/desktop-frame.test.ts` — blank labels, NaN dwell → 2,
  communication vs distraction categories
- Poller: `tests/desktop-ingest.test.ts` — lifecycle,
  transition-after-dwell write, CLI stderr
  `Desktop active-window poller started` vs `… disabled (EXOCORTEX_DESKTOP_POLLING=0)`

## Pitfalls

- **Not Chrome capture.** Side-panel timeline, Librarian Vault, and
  bridged search never see poller rows. `exocortex_align_federated_kg`
  is the same split: it reads CLI `semantic_vault` +
  `cognitive_frames`, not `db.frames`.
- **`query_frames` is the wrong table.** It is bridge-backed and reads
  `cognitive_frames`. A connected peer still will not list desktop
  windows.
- **Current window is invisible.** The poller writes the *previous*
  window on change. Stay in one app until the CLI exits and nothing is
  stored. `process.on("exit")` only `clearInterval`s — no flush.
- **No embeddings.** `recordDesktopFrame` does not call the offscreen
  embedder. Unbridged hits are lexical (`matchKind: "lexical"`,
  `cosineSimilarity: null`). Chrome dwell frames *do* get embeddings
  (`docs/on-device-embeddings.md`).
- **`sourceType: "web"` is not browser capture.** Chrome dwell
  `db.frames.add` omits `sourceType` (it stays `undefined`). Filtering
  `"web"` drops those rows. Desktop rows are the ones that actually
  set the field (`"desktop_window"`).
- **Empty desktop filter falls back to `page_text`.** If hybrid search
  returns no `desktop_window` candidates,
  `handleSemanticSearch` still calls `handleSearchMemory` and labels
  those keyword hits lexical. A `sourceType` filter is not a hard
  partition (`docs/semantic-search.md`).
- **`ocrText` is a stub.** Passing it does not store, embed, or
  summarize window contents. `exocortex_summarize_page({ frame_id })`
  on a desktop id truncates `frame.summary` (`App: Title`) in the CLI
  store — it is not Gemini Nano.
- **Missing OS tools are silent.** No stderr line. The poller stays
  "started" and records nothing. Watch `db.frames` in the same
  process, not the startup log.
- **`desktop://` is not a privileged-scheme block.** `isUrlBlocked`
  does not list it (hostname is `app`). `sanitizeUrlForKg` still
  returns `null` because the protocol is not `http(s)`.
  `exocortex_open_memory` resolves `page_text` handles — desktop
  ingest never writes that table. Drift's `desktop_window` pause is
  on `cognitive_frames`, which this path also never writes.
