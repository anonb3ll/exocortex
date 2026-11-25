# Exocortex SDK Core Contract

Status: **contract + minimal Core landed** (unified-agent tasks **#1046** /
**#1047**, parent **#1045**). `#1046` defined Shape A types + governance
oracle; `#1047` implements `InMemoryCore`, the `MemoryStore` seam, and a
feature-flagged localhost hub existing-store adapter (memory/vault/gbrain
projection only — no new DB, no broad connectors). `#1048` adds the first
external-consumer proof: Citetrail's real sqlite store behind `InMemoryCore`
via `examples/citetrail_consumer/` (see its README for install/run and the
internal-only record).

This document defines the smallest deep interface and domain vocabulary for
**Exocortex Core**: a governed context SDK over existing stores (browser IndexedDB,
unified-agent memory/vault/gbrain), **not** a new second-brain database.

Python types live in `src/exocortex_sdk/`. Executable contract cases live in
`tests/test_sdk_core_contract.py` and run via `uv run pytest`.

---

## 1. Decision: Shape A selected over Shape B

Two interface shapes were compared against the **actual** Exocortex surfaces that
already ship today.

### Shape A — Operation-centric Core Protocol (SELECTED)

One deep Protocol, `ExocortexCore`, with five operations:

| Operation | Role |
|---|---|
| `capture` | Append a memory item under Scope + Provenance (consent required) |
| `recall` | Search within Scope; return `RecallResult` + `Evidence` |
| `link` | Append a link item between two in-scope handles |
| `record` | Append a structured kind (checkpoint, focus_anchor, …); overwrite refused |
| `explain` | Return provenance + evidence chain for one in-scope handle |

**Depth.** Governance (Scope isolation, consent, privacy block, append-only,
freshness) sits at a single choke point. Every write carries `Provenance`; every
read returns items only inside the caller `Scope`.

**Locality.** Existing TypeScript surfaces become *adapters* that project into
Core types. They keep their local UX shapes, but the SDK contract does not fork
into one API per UI panel.

### Shape B — Surface-local Facades (REJECTED)

Separate Protocols that mirror today’s TypeScript return types:

- `MobileRecallAPI` ≈ `searchMobileMemoryPure` → `MobileRecallResponse`
- `PanelSemanticSearchAPI` ≈ `searchPanelMemory` → `PanelSemanticSearchResult`
- `DwellCaptureAPI` ≈ `executeDwellCapture` / consent-gated dwell timer

**Depth.** Shallow: each facade keeps its own status enum and result shape.
Governance is optional per surface.

**Locality.** High fidelity to today’s code — and that is the problem. Privacy
enforcement has already drifted across surfaces once (panel guarded queries;
MCP/bridge did not until #1082). Encoding Shape B as the SDK would cement that
asymmetry instead of closing it.

### Comparison against live surfaces

#### Mobile-slice capture / recall path

`src/lib/mobile-slice.ts` already practices Core-like redaction:

- Opaque handles (`mem_<id>`), sanitized title/excerpt, no raw URL on the mobile
  recall item (`MobileRecallItem`, lines 43–49).
- Fail-closed query guard via `isSearchQueryBlocked` before search
  (`searchMobileMemoryPure`, lines 92–101).
- Fail-closed URL skip via `isUrlBlocked` over candidates (lines 109–113).
- Honest status envelope: `ok | empty | privacy_blocked | error` (line 30).
- Freshness vocabulary `live | stale | offline` on the mobile state envelope
  (lines 29, 221–231).

Capture itself is consent-gated in `src/content/tracker.ts`: `loadConsent()`
returns false unless the side-panel opt-in is set (lines 27–34, 42–44), and
blocked URLs never start a dwell timer (lines 52–55) or complete capture
(lines 70–71).

Shape A maps this path as: consent + privacy → `capture` / `recall` error modes;
handles + sanitized text → `MemoryItem`; freshness → `Freshness`.

#### Semantic-search recall path

`src/sidepanel/semantic-search.ts` is the panel recall surface:

- Query blocklist first (`searchPanelMemory`, lines 55–62) →
  `status: "privacy_blocked"`.
- Embedder failure is an explicit degraded status, not silent lexical fallback
  (`embedding_unavailable`, lines 65–74) — honesty requirement from #1082.
- Successful path returns vector/lexical hits via `hybridVectorSearch`
  (`src/lib/models/vector-search.ts`), where `MatchKind` distinguishes real
  cosine evidence from lexical overlap (lines 17–34).

Shape A maps this as: `RecallRequest.require_vector` + `embedding_available` →
`RecallStatus.EMBEDDING_UNAVAILABLE`; evidence carries `match_kind`.

Shape B would keep `PanelSemanticSearchResult` and `MobileRecallResponse` as
peer SDK types, forcing every consumer (Runroom/Citetrail in #1048) to learn
two status enums and two redaction rules. Shape A collapses them behind one
`RecallResult`.

### Selection

**Select Shape A.** It matches #1045’s decision (“governed context interface over
existing stores”) and gives #1047 a single Protocol to implement. Shape B is
kept only as the rejected alternative so future adapters do not accidentally
reintroduce per-surface governance forks.

---

## 2. Domain vocabulary

| Type | Meaning |
|---|---|
| `MemoryKind` | Closed set: `page_dwell`, `focus_anchor`, `cognitive_frame`, `checkpoint`, `link`, `note`, `task_reference` |
| `MemoryItem` | Wire record: handle, kind, scope_project, sanitized title/excerpt, provenance. **No `url` field.** |
| `Evidence` | Why a hit was returned: kind + opaque `source_ref` + optional score/match_kind |
| `Provenance` | origin_machine/surface, captured_at, recorded_at, consent_basis, trust_tier |
| `Scope` | caller_id, optional project, trust_tier, allow_kinds |
| `RecallResult` | status, query, items, evidence, freshness, optional error |
| `Freshness` | `live` \| `stale` \| `offline` |
| `CoreErrorCode` | privacy_blocked, consent_required, scope_violation, not_found, stale, conflict, embedding_unavailable, invalid_input, append_only_violation |

Aligns with projection provenance in `src/lib/projection/contract-v1.ts`
(`Provenance` interface, lines 86–93) and consent bases (lines 58–62).

---

## 3. Operations, error modes, freshness

### Operations

1. **capture(scope, CaptureRequest) → MemoryItem | CoreError**  
   Append-only. Refuses when `consent_granted` is false (mirrors
   `tracker.ts` opt-in), privacy-blocked content, and kinds outside
   `allow_kinds`.
2. **recall(scope, RecallRequest) → RecallResult**  
   Never returns out-of-scope items. Privacy-blocked queries yield empty items.
3. **link(scope, LinkRequest) → MemoryItem | CoreError**  
   Both handles must be in scope.
4. **record(scope, RecordRequest) → MemoryItem | CoreError**  
   Append-only; `replace_handle` is always refused.
5. **explain(scope, handle) → ExplainResult**  
   Scope-gated provenance + evidence; foreign handles never leak.

### Error modes

Mirror the honest statuses already used by mobile-slice and semantic-search:
`privacy_blocked`, `embedding_unavailable`, plus Core governance modes
`consent_required`, `scope_violation`, `append_only_violation`, `not_found`,
`stale`, `conflict`, `invalid_input`.

### Freshness

Default stale threshold is **7 days** (same as retention; see `docs/retention.md`).
`compute_freshness(captured_at, now_ms)` returns `stale` when age exceeds the
threshold. Offline is reserved for missing/unreachable handles on explain.

---

## 4. Privacy / governance invariants (testable)

Stated as assertions executed in `tests/test_sdk_core_contract.py`:

1. A `RecallResult` never returns items outside the caller `Scope`.
2. A privacy-blocked query yields `status=privacy_blocked` and zero items.
3. Capture without consent (`consent_granted=False`) stores nothing and returns
   `CONSENT_REQUIRED`.
4. Capture of privacy-blocked content stores nothing and returns `PRIVACY_BLOCKED`.
5. `record(..., replace_handle=...)` is refused (`APPEND_ONLY_VIOLATION`).
6. `link` refuses when either handle is outside Scope.
7. `explain` never returns a foreign-scope `MemoryItem`.
8. `MemoryItem` field set contains no `url` (wire redaction).
9. Vector recall with embedder down yields `embedding_unavailable` and empty items.

Named cases for #1047 are also listed as `CONTRACT_CASES` in
`src/exocortex_sdk/types.py`.

---

## 5. Boundaries (this lane)

In scope: this document, `src/exocortex_sdk/` types + Protocol + reference oracle,
`tests/test_sdk_core_contract.py`, `pyproject.toml` for pytest/ruff.

Out of scope: persistent storage, public packaging, broad ontology, and any
modification of the semantic-search / mobile-slice TypeScript implementation
files (those are product surfaces; the #1047 seam does not touch them).

The `ReferenceCore` alias in `src/exocortex_sdk/reference.py` remains the
**contract oracle** import path. The governed implementation is
`InMemoryCore` (`src/exocortex_sdk/core.py`) over `MemoryStore`
(`src/exocortex_sdk/store.py`). The existing-store seam lives under
`src/exocortex_sdk/adapters/` — `ExistingStorePort` plus
`HubExistingStoreAdapter` behind `EXOCORTEX_SDK_HUB_STORE=1` (loopback only;
writes require explicit `WritePolicy.ALLOW`).

---

## 6. Operator run path

```bash
uv run pytest tests/test_sdk_core_contract.py tests/test_sdk_core_impl.py -q
```

Citetrail consumer proof (opt-in extra group, skipped without it):

```bash
uv run --group citetrail-consumer python examples/citetrail_consumer/demo.py
uv run --group citetrail-consumer pytest tests/test_sdk_citetrail_consumer.py -q
```

Install/run details: `examples/citetrail_consumer/README.md`.

### Constraints

- **`is_query_privacy_blocked` is a stand-in.**
  `SENSITIVE_QUERY_MARKERS` is `{password, credential, secret, chase.com,
  1password.com}` — not a clone of TypeScript `SENSITIVE_SEARCH_TERMS`
  (which also includes `wellsfargo.com`, `bankofamerica.com`,
  `bitwarden.com`, …). Contract tests, not production parity.
- **Hub adapter stays flagged off.** `build_core()` never auto-writes.
  `EXOCORTEX_SDK_HUB_STORE=1` constructs `HubExistingStoreAdapter` on
  loopback only (`127.0.0.1` / `localhost` / `::1`). Appends still
  refuse unless the caller passes `WritePolicy.ALLOW` to
  `hub_store.append`. The factory's `write_policy` argument is unused
  on purpose.
- **No new database.** `InMemoryCore` is process-local. Citetrail's
  sqlite is the consumer's existing store, not an SDK persistence
  layer.
