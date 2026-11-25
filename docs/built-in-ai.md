# Chrome Prompt API and taxonomy

Where Gemini Nano / `window.ai` is actually consulted, and what runs
when that object is missing. MiniLM embeddings are a different path
(`docs/on-device-embeddings.md`). The Phase 3.1 spec
(`docs/spec-phase-3.1-on-device-ai-and-local-embeddings-2026-07-25.md`)
is the original design; this page is the live gate.

## Intent

Offer on-device taxonomy and a two-sentence summary **only** when
Chrome's Prompt API reports `capabilities.available === "readily"`.
Every caller has a non-AI fallback. Missing `window`, a renamed API, or
a Node/Bun MCP process must not hang or invent prose.

## Architecture

```
getLanguageModel()          src/lib/models/built-in-ai.ts
        │ window.ai.languageModel.capabilities()
        │ available === "readily" → languageModel.create()
        │ else / throw → null
        ▼
classifyTaxonomyWithAi      dwell: classifyIntentAndFocusAsync
summarizePageWithAi         MCP: handleSummarizePage
extractEntitiesWithAi       no in-repo callers
```

| Piece | Path | Role |
|---|---|---|
| Gate | `src/lib/models/built-in-ai.ts` | `window.ai.languageModel` only |
| Regex taxonomy | `src/lib/agents/taxonomy-agent.ts` `classifyIntentAndFocus` | Hostname substring rules |
| Hybrid wrapper | `classifyIntentAndFocusAsync` | AI then regex; used on dwell |
| Frame factory | `src/lib/models/cognitive-frame.ts` | Always regex (fatigue math) |
| MCP summary | `src/mcp/tools.ts` `handleSummarizePage` | AI, else first 247 chars of page text |

The gate does **not** look at `LanguageModel`, `ai.assistant`, or
offscreen `self`. It is `typeof window !== "undefined" && "ai" in
window && "languageModel" in window.ai`.

## What actually runs

**Dwell (service worker).** `classifyIntentAndFocusAsync` is called
from `src/background/service-worker.ts` after a consented capture.
MV3 service workers have no `window`, so `getLanguageModel()` returns
`null` and the hostname regex always wins. `createCognitiveFrame`
still computes fatigue / friction from that same regex even if a
future AI hit overwrote `intentCategory`.

**MCP `exocortex_summarize_page`.** Runs in Bun/Node. There is no
`window`, so `summarizePageWithAi` is always `null`. The tool then
returns `content.slice(0, 247) + "..."` (or the full string if
shorter), looking up `frames` / `page_text` in the **CLI** Dexie. It
is not bridge-backed: Chrome page text is invisible. `ocrText` is
not consulted.

**MCP `exocortex_record_frame`.** Uses `createCognitiveFrame` only
(regex). It does not call the async hybrid wrapper.

Regex categories (first hostname match wins): social hosts →
`Distraction / Rabbit Hole`; Slack/Discord/Teams/Gmail →
`Communication & Async`; GitHub / localhost / Stack Overflow / MDN /
`docs.` → `Deep Work (Drafting/Coding)`; Jira / Linear / AWS / GCP
console / Notion / Trello → `Task Execution & Ops`; else
`Research & Gathering`. GitHub focus entity is `owner/repo` when the
path has two segments.

## Usage

Do not treat MCP summaries or dwell categories as evidence that Gemini
Nano ran. To confirm the Prompt API in a page that *has* `window`
(side panel or offscreen DevTools):

```js
window.ai?.languageModel?.capabilities?.().then(console.log);
```

If that throws or is undefined, the shipped gate is closed — which is
the service-worker and MCP-CLI case today.

`exocortex_summarize_page` is a convenience over CLI `page_text`, not
a live Chrome summarizer. Lookup order: `frame_id` → `url` on
`page_text` → **latest** `page_text` row → `"No page content available
to summarize."` A URL that is not in the store still summarizes the
newest row if one exists.

```js
exocortex_summarize_page({ url: "https://example.com/docs" })
// empty CLI Dexie → { summary: "No page content available to summarize." }
// otherwise a 247-char truncation of whatever page_text it resolved
```

## Pitfalls

- **Roadmap "shipped window.ai" ≠ live Nano.** The capability check
  and regex fallback shipped. The dwell and MCP call sites do not
  currently see `window.ai`.
- **API rename closes the gate.** Chrome's Prompt API has moved names
  across channels. Until `getLanguageModel()` matches the object that
  exists, taxonomy stays regex and summarize stays truncation.
- **Fatigue ignores a hypothetical AI category.** Overlay math uses
  the regex classification inside `createCognitiveFrame`, then the
  worker copies only intent / entity / summary from the async result.
- **`exocortex_summarize_page` is ephemeral.** Same empty CLI store as
  other unbridged tools. A connected native host does not change that.
- **Missing URL ≠ empty summary.** If `page_text` has any row, an
  unknown `url` still truncates the latest one. `"No page content
  available to summarize."` only appears when that table is empty.
- **`extractEntitiesWithAi` is unused.** Do not document it as a
  public API.
