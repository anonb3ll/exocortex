# Citetrail consumer proof (unified-agent task #1048)

One external consumer — [Citetrail](https://github.com/anonb3ll/citetrail), the
public "provenance-backed memory of what your browser saw" slice — running the
Exocortex SDK's governed `ExocortexCore` over its **existing** sqlite store.

This is the thinnest real integration on the #1046 contract + #1047
`InMemoryCore`: the consumer implements the `MemoryStore` seam (three methods —
`get`, `append`, `iter_items`), and inherits scope isolation, consent gating,
privacy-blocked queries, append-only writes, freshness, and `explain` for free.

## What is demonstrated

`demo.py` runs the full round trip from the consumer's own code path:

```
citetrail.capture() ──> citetrail sqlite ──> CitetrailMemoryStore ──> core.recall()
       │                                                              │
       │ (URL + PrivacyPolicy never                            core.explain()
       │  leave Citetrail)                                             │
       └──────────────────────────── adapter.reference_for() <─────────┘
                    handle -> bounded Reference (url, position)
```

1. `citetrail.capture.capture()` writes two pages and refuses a blocklisted
   host — Citetrail's real code path and its own privacy policy.
2. `CitetrailMemoryStore` projects every `captures` row into a `MemoryItem`
   (`cite_<rowid>` handles, `page_dwell` kind, `standing_local_capture`
   consent, `browser` surface).
3. `core.recall(scope, "retry backoff")` returns governed hits with `Evidence`.
4. `core.explain(scope, handle)` returns provenance + freshness; the adapter's
   `reference_for(handle)` resolves the Citetrail `Reference` (url, title,
   captured_at, position) at the consumer edge — `MemoryItem` has no `url`
   field, so the URL never crosses the SDK boundary.
5. `core.capture()` of an SDK-native `NOTE` lands as a **real** `captures` row
   (`urn:exocortex-sdk:<handle>` origin marker) and is visible to Citetrail's
   own `store.search()`.
6. Governance contrast: a foreign-project scope gets `scope_violation` /
   empty recall, and a sensitive query returns `privacy_blocked` — enforcement
   Citetrail alone does not have (its `recall()` is an unscoped LIKE search).

## Install and run (reproducible by anyone)

Requirements: Python 3.11+, [`uv`](https://docs.astral.sh/uv/), network access
to github.com (Citetrail is installed from its public repo — the same pattern
the citetrail-runroom integration-contract uses).

```bash
git clone <exocortex repo>
cd exocortex

# The opt-in dependency group pulls citetrail from GitHub and installs it
# into the project venv. Nothing else changes for normal development.
uv run --group citetrail-consumer python examples/citetrail_consumer/demo.py

# Focused consumer tests (8 cases):
uv run --group citetrail-consumer pytest tests/test_sdk_citetrail_consumer.py -q
```

Without `--group citetrail-consumer` the consumer test file **skips** (not
fails) — the same opt-in convention as the `EXOCORTEX_BROWSER_TESTS` B* layer.
The contract and impl suites never depend on Citetrail:

```bash
uv run pytest tests/test_sdk_core_contract.py tests/test_sdk_core_impl.py -q
```

## Before / after integration surface

| | without the SDK | with `InMemoryCore` + this adapter |
|---|---|---|
| governed recall | bespoke: scope filter + query guard + freshness math | `core.recall(scope, req)` |
| provenance answer | bespoke: join row -> reference, redact URL | `core.explain` + `reference_for` |
| consent gate on writes | none in citetrail's `store.add` path | `consent_required` refusal |
| overwrite protection | none (sqlite INSERT always wins) | `append_only_violation` / `conflict` |
| code the consumer writes | all of the above | `CitetrailMemoryStore` — ~120 lines, 3 protocol methods + handle resolution |

Measured: `citetrail_adapter.py` is 187 lines total (docstrings included); the
protocol surface it implements is `get` / `append` / `iter_items` /
`reference_for`. Everything else — Scope enforcement, `CoreErrorCode`,
`Freshness`, evidence — comes from the SDK unchanged.

## Honest record: what remains internal-only / out of scope

- **Hub adapter seam stays flagged off.** `HubExistingStoreAdapter`
  (`EXOCORTEX_SDK_HUB_STORE=1`, loopback only) was not exercised here; this is
  an external-consumer proof, not hub wiring. No hub endpoint is exposed.
- **In-memory Core is the reference implementation.** `InMemoryCore` +
  `CitetrailMemoryStore` share one process. There is no new persistent
  database: the only bytes on disk are Citetrail's own `citetrail.sqlite3`.
- **SDK-minted handles are process-local.** A `mem_<n>` handle created via
  `core.capture` resolves to its row only while the adapter instance lives.
  After a restart the same row reappears as `cite_<rowid>` — the data is
  durable, the SDK handle is not. Making handles durable would need either a
  handle column in Citetrail's schema or a documented re-derivation rule.
- **`ExistingStorePort.source` is hub-vocabulary** (`memory|vault|gbrain`).
  This proof used the lower-level `MemoryStore` seam instead of widening the
  literal — a deliberate choice to keep the #1046 contract untouched.
- **Lexical recall only.** The SDK's `require_vector` path maps to the
  extension's embedder; Citetrail's store has no embeddings, so this proof is
  `match_kind=lexical` end to end.
- **No Runroom leg.** Runroom, a separate local project, was the alternative candidate;
  Citetrail was picked because "a CLI that remembers what it read" is the
  minimal capture/recall/explain fit. A Runroom projection (run events as
  `checkpoint`/`task_reference` items) is a plausible next consumer.
- **No private-vault coupling, no telemetry, no new permissions.**

## Files

| File | Role |
|---|---|
| `citetrail_adapter.py` | `CitetrailMemoryStore` — `MemoryStore` over Citetrail's sqlite + `reference_for` |
| `demo.py` | Runnable transcript of the round trip above |
| `tests/test_sdk_citetrail_consumer.py` (repo `tests/`) | 8 focused tests over the real citetrail package |
