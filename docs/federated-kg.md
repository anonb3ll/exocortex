# Federated knowledge graph

Operator runbook for `exocortex_align_federated_kg`. Sanitization
primitives live in `docs/privacy-guard.md`. This page is vault path,
write-dir allowlist, which Dexie the tool actually reads, and failure
modes.

The tool is **not** in `BRIDGE_BACKED_TOOLS`. A connected native bridge
does not feed it Chrome capture.

## Intent

Turn in-process Dexie entities into Obsidian `Wiki/` markdown. The vault
stays human-authoritative: locked notes are skipped, existing bodies are
never rewritten, and curated PARA folders are refused.

Disk writes are real. The **facts** they contain come from the MCP
process's `fake-indexeddb`, which starts empty and dies with the CLI —
the same store as `exocortex_record_frame`, not the Chrome profile the
side-panel Librarian Vault reads (`docs/sidepanel.md`).

## Architecture

```
exocortex_align_federated_kg
        │ not bridge-backed — envelope source stays ephemeral
        ▼
MCP Dexie  semantic_vault + cognitive_frames
        │ sanitizeExcerpt / sanitizeUrlForKg
        │ isPathAllowedInVault (UA_VAULT_WRITE_DIRS)
        │ isNoteLocked (frontmatter locked: true)
        ▼
$UA_VAULT_PATH / Wiki/<Entity>.md
```

| Piece | Path | Role |
|---|---|---|
| Tool | `src/mcp/server.ts` | `vaultPath`, `targetSubdir` (default `Wiki`), `dryRun` |
| Aligner | `src/mcp/federated-kg-aligner.ts` | Cluster, sanitize, write |
| Privacy | `src/content/privacy.ts` | `sanitizeExcerpt`, `sanitizeUrlForKg` |
| Chrome vault | `src/lib/agents/librarian-agent.ts` | Dwell indexer — **not** this tool's input |

`exocortex_record_desktop_frame` / the OS poller write `db.frames` only.
Those rows are never aligned.

## Defaults

| Input | Default | Notes |
|---|---|---|
| `vaultPath` | `$UA_VAULT_PATH`, else `os.homedir()/vaults/main` | `os.homedir()` honours `HOME`; there is no hardcoded user path |
| `targetSubdir` | `Wiki` | Must itself be inside the write-dir allowlist |
| `writeDirs` | `$UA_VAULT_WRITE_DIRS` (`:`-separated) or `Wiki`, `00 - Inbox`, `Logs` | Not a tool argument — env / options only |
| `dryRun` | `false` | Still reports `createdNotes` / `updatedNotes`; does not write |

PARA folders such as `01 - Projects` and `02 - Areas` are refused
(`tests/federated-kg-aligner.test.ts` DoD #3). A `targetSubdir` outside
the allowlist fails the whole run (`status: "error"`, no notes).

## What a note contains

New `Wiki/<Entity>.md` files get `tags: [wiki, exocortex, entity]`, the
first sanitized excerpt, `[[wikilinks]]` to other entities whose names
(length > 2) appear in those excerpts, and a Captured Sources list of
http(s) URLs that survived `sanitizeUrlForKg`. Filenames replace
`/ \ ? % * : \| " < >` with `_`.

Existing unlocked notes are **not** overwritten. If they lack
`## Exocortex Telemetry`, that section is appended (URLs + related
wikilinks only). If the section already exists, the file is left
unchanged and still listed in `updatedNotes`. `locked: true` in YAML
frontmatter skips the file entirely.

Blocked-host and `desktop://` URLs are omitted from Captured Sources;
the entity note can still be created. Redaction tokens:
`[REDACTED_PRIVATE_KEY]`, `[REDACTED_TOKEN]`, `[REDACTED_JWT]`,
`[REDACTED_API_KEY]`, `[REDACTED_GITHUB_KEY]`, `[REDACTED_GOOGLE_KEY]`,
`[REDACTED_SECRET]`, `[REDACTED_SSN]`, `[REDACTED_CC]`.

## Usage

Seed the **same** MCP process, then align. Bridged Chrome capture is
invisible here.

```bash
# Empty in-process harness (no Chrome Dexie)
EXOCORTEX_NATIVE_BRIDGE=0 UA_VAULT_PATH=/path/to/vault bun src/mcp/cli.ts
```

Then, in that session: `exocortex_record_frame` (writes
`cognitive_frames`) followed by `exocortex_align_federated_kg`. Pass
`dryRun: true` to see `createdNotes` / `refusedPaths` without touching
disk.

```js
exocortex_align_federated_kg({
  vaultPath: "/path/to/vault",
  targetSubdir: "Wiki",
  dryRun: true
})
```

`processedEntities: 0` with `status: "success"` means the CLI Dexie had
no `primaryFocusEntity` rows — not that Chrome capture is empty.

## Pitfalls

- **Not the Librarian Vault.** Side-panel snippets are Chrome
  `semantic_vault`. This tool reads the CLI copy of that table, which
  the dwell indexer never writes.
- **Connected bridge does not help.** The eight ephemeral data tools
  include this one. Envelope `source` stays `ephemeral` even when
  `peerConnected` is true.
- **Desktop poller frames are skipped.** They live on `db.frames`, not
  the two tables the aligner scans.
- **Human text wins.** Re-running does not duplicate files and does not
  replace a curated body. To change a locked note, edit it in Obsidian
  (or remove `locked: true`).
- **Allowlist is prefix-based.** `Wiki` allows `Wiki/Foo.md`. It does
  not allow `01 - Projects`. Do not pass a PARA folder as
  `targetSubdir`.
- **Default vault is a local path.** Unset `UA_VAULT_PATH` writes under
  `$HOME/vaults/main`. Point it at the vault you mean before a non-dry
  run.
