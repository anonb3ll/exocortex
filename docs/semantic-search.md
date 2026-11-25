# Semantic search

Live recall over captured pages. Two surfaces share `hybridVectorSearch`
and the query privacy guard, then diverge on outage behaviour.

This is the operator guide. Embedder ladder, demotion, and model
constraints: `docs/on-device-embeddings.md`. Query vs hostname guards:
`docs/privacy-guard.md`. Opt-in probe caveats: `docs/verify.md`.

## Intent

Return paraphrase-capable hits when a real MiniLM query vector exists,
and **label** every result when it does not. A cosine written into a
lexical hit was the previous failure mode
(`tests/semantic-search-honesty.test.ts`).

## Architecture

```
side panel #search-input (200ms debounce)
        │ searchPanelMemory()
        │ isSearchQueryBlocked? → privacy_blocked, no embed
        │ requestPanelEmbedding()  — rejects unless source === "model"
        │ throw → embedding_unavailable (empty results at this layer)
        ▼
hybridVectorSearch (queryVector only when source is model)
        │
        ├ UI ok                  — cards: "vector · cos 0.xx" or "lexical"
        ├ UI privacy_blocked     — Fail-Closed Privacy Shield banner
        └ UI embedding_unavailable
                                 — labelled lexical retry + amber banner

MCP exocortex_semantic_search (bridge-backed)
        │ validator + service worker re-check isSearchQueryBlocked
        │ requestVectorEmbedding; queryVector only if source === "model"
        ▼
handleSemanticSearch → hybridVectorSearch
        └ empty hybrid set → handleSearchMemory, each mapped matchKind: lexical
```

| Piece | Path | Role |
|---|---|---|
| Panel orchestration | `src/sidepanel/semantic-search.ts` | Guard → embed → search; honest statuses |
| Panel UI | `src/sidepanel/sidepanel.ts` | 200ms debounce on `#search-input`; banners |
| Ranking | `src/lib/models/vector-search.ts` | Cosine rescore only on model vectors |
| MCP tool | `src/mcp/tools.ts` `handleSemanticSearch` | Same ranking; empty set falls back to keyword search |
| Bridge | `src/bridge/protocol.ts` | Query gate + 30s deadline (`semantic_search`) |
| Live embed | `src/background/service-worker.ts` | Offscreen query vector; fallback vector is not passed on |

`exocortex_search_memory` / `searchBrowserMemory` is **not** this
path. It is substring ranking over `page_text` and does not call
`isSearchQueryBlocked`. A blocked semantic query can still hit keyword
search.

## Statuses and labels

Panel `searchPanelMemory` returns `ok | empty | privacy_blocked | embedding_unavailable`.

| Status | When | Results |
|---|---|---|
| `empty` | Blank / whitespace query | none |
| `privacy_blocked` | `isSearchQueryBlocked` (query rewritten to `[blocked-query]`) | none; embedder never called |
| `embedding_unavailable` | `requestPanelEmbedding` throws (runtime error, non-success, or `source !== "model"`) | none at this layer |
| `ok` | Embedder returned a model vector, or a caller injected `source: "fallback"` | `hybridVectorSearch` hits |

The **UI** (`renderSemanticResults`) then special-cases
`embedding_unavailable`: it retries `searchPanelMemory` with
`source: "fallback"` (no query vector) and prefixes

> Semantic search unavailable — showing lexical matches

That labelled lexical pass is UI-only. The orchestration function
itself does not silently degrade.

MCP `exocortex_semantic_search` has no status envelope. Blocked queries
throw `"Search query matches privacy blocklist"`. Missing query vector
(unbridged call, or embedder `source !== "model"`) degrades to
`matchKind: "lexical"` with `cosineSimilarity: null`. Check `matchKind`
before treating a hit as semantic.

Panel cards show URLs and titles — this is the user's extension UI, not
the MCP wire. Bridged `search_memory` still returns
`{parsedAt, score, handle}` only.

## Usage

1. Enable **Local footprint capture** and dwell ≥ 5s on allowed pages
   (`docs/capture-consent.md`). No dwell rows means no embeddings.
2. Type in the side-panel search box (`placeholder="Search footprint & memory..."`).
   Empty input restores the chronological timeline.
3. Over MCP (bridge on, extension connected):

```bash
bun src/mcp/cli.ts
# call exocortex_semantic_search with { "query": "..." }
```

A cosine below 0.35 does not outrank a strong keyword hit
(`VECTOR_RELEVANCE_FLOOR`). Blend is 0.6 similarity + 0.25 recency +
0.15 dwell.

## Tests

- Honesty: `tests/semantic-search-honesty.test.ts` — paraphrase retrieval
  with a model vector; lexical labelling without one
- Panel orchestration: `tests/sidepanel-semantic-search.test.ts` —
  guard-first (embedder not called), `embedding_unavailable` on throw
- B*: `tests/smoke-sidepanel-semantic-search.test.ts` (needs
  `EXOCORTEX_BROWSER_TESTS=1`)
- Adversarial (not in `bun run test`): `bun test verify/adversarial-probes.test.ts`
  — `package.json` `"test"` is `bun test tests/`, so `verify/` is opt-in

## Pitfalls

- **Panel outage ≠ MCP outage.** Panel shows an amber banner and lexical
  cards. MCP returns `matchKind: "lexical"` with no banner. Do not
  document one behaviour for both.
- **`requestPanelEmbedding` rejects fallback.** A hash vector is treated
  as unavailable (throw), not as a silent `ok`. Injecting
  `source: "fallback"` into `searchPanelMemory` (the UI retry, or a
  test) yields `ok` + lexical ranking — that is how the banner path
  works. `verify/adversarial-probes.test.ts` P9 still injects that
  fallback dep and is **not** the live `requestPanelEmbedding` contract
  (the unit test "Real panel wiring treats the worker fallback response
  as unavailable" is).
- **Keyword search is a separate tool.** `exocortex_search_memory` does
  not run the query gate. Semantic search does.
- **Generic `login` / `auth` / `chase` queries are allowed.** `chase.com`
  and `my password` are not. See `docs/privacy-guard.md`.
- **Cold start can look hung.** First query embed may download MiniLM;
  the bridge allows 30s for `semantic_search`, 2s for other tools.
- **`sourceType: "desktop_window"` is CLI-only.** The poller and
  `exocortex_record_desktop_frame` tag that value on MCP-process
  `db.frames`; Chrome dwell omits `sourceType` entirely. An empty
  desktop candidate set still falls through to `handleSearchMemory`
  (`page_text`). Operator split: `docs/desktop-ingest.md`.
