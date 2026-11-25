---
date: 2026-07-25
source: anonb3ll
tags: [spec, architecture, exocortex, chrome-extension, on-device-ai, window-ai, vector-embeddings, dexie, mcp]
---

# Technical Specification — Exocortex Phase 3.1: On-Device Built-in AI & Local Embedding Engine (v1.1 — Production Refined)

> **Current implementation (2026-08-21):** The live offscreen worker uses
> Transformers.js v3 (`@huggingface/transformers`), not `@xenova/transformers`.
> Device ladder, provenance, and operator pitfalls are in
> `docs/on-device-embeddings.md`. Section 3.2 below is the original v1.1
> design; treat Xenova v2 / BM25 wording as historical. Dwell capture is
> consent-gated as of `509b95b` (`docs/capture-consent.md`).
>
> **Prompt API (2026-11-09):** Section 3.1's `window.ai.languageModel`
> gate still exists in `src/lib/models/built-in-ai.ts`. MV3 service
> workers and the Bun MCP CLI have no `window`, so dwell taxonomy is
> the hostname regex and `exocortex_summarize_page` truncates CLI
> `page_text`. Live operator notes: `docs/built-in-ai.md`.

## 1. Executive Summary

**Project Root:** `/path/to/exocortex`  
**Target Platform:** Chrome Extension (Manifest V3) + Bun/Node Stdio MCP Bridge  
**Objective:** Transform Exocortex into a 100% self-contained, offline-first cognitive engine by integrating Chrome's Built-in AI (`window.ai` / Gemini Nano) and a WebAssembly (Wasm) vector embedding pipeline inside an MV3 Offscreen Worker.

### Core Value Proposition
- **Zero Cost & Zero Token Usage:** 100% on-device inference using local hardware acceleration (WebGL / WebGPU / NPU).
- **Sub-50ms Taxonomy & Summarization:** Zero network round-trips for page classification, entity extraction, and drift calculation.
- **Privacy Hardline:** Captured DOM text and vector embeddings never leave the local browser environment.
- **Offline Hybrid Search:** Full semantic vector retrieval ($384\text{-d}$ embeddings stored in Dexie.js IndexedDB) combined with BM25 keyword matching.

---

## 2. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Chrome Browser Context                            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Active Tab DOM (5s Dwell Gate Passed)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MV3 Background Service Worker                            │
│  • Manages event queue & privacy scrubbing (scrubQueryTokens / Blocklist)   │
└──────────────┬──────────────────────────────────────────────┬───────────────┘
               │                                              │
               │ DOM Text / Title                             │ Clean Page Payload
               ▼                                              ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│  Chrome Built-in AI API      │              │    MV3 Offscreen Worker      │
│  (`window.ai.languageModel`) │              │  (`src/offscreen/worker.ts`) │
│  • Model: Gemini Nano        │              │  • Engine: Wasm Transformers │
│  • Task: Zero-Shot Taxonomy, │              │  • Model: all-MiniLM-L6-v2   │
│    Entity Extraction,        │              │  • Task: 384d Float32        │
│    Page Summarization        │              │    Vector Embedding          │
└──────────────┬───────────────┘              └──────────────┬───────────────┘
               │                                              │
               │ Category & Summary                           │ Vector Blob
               └──────────────────────┬───────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Dexie.js IndexedDB Vault                            │
│  • `frames` Table: metadata, category, summary, dwellTime                   │
│  • `embeddings` Table: frameId, vector (Float32Array), dimension (384)      │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      │ Local Cosine Similarity & Query
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         In-Browser Agent Mesh                               │
│  • TaxonomyAgent: Classifies page into project taxonomy                     │
│  • DriftDetector: Cosine Distance(Active Vector, FocusAnchor Vector) > 0.65 │
│  • LibrarianAgent: Hybrid Vector + Recency Search                            │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      │ Exposes Semantic Search & Summaries
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Bun / Stdio MCP Server Bridge                         │
│  • `exocortex_semantic_search`, `exocortex_summarize_page`                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Breakdown

### 3.1 Chrome Built-in AI Integration & Feature Detection (`window.ai`)
* **API Target:** `window.ai.languageModel` (Chrome Built-in AI Prompt API).
* **Module:** `src/lib/models/built-in-ai.ts`
* **Explicit Async Capability Guardrail:**
  Chrome's Built-in AI APIs (`window.ai.languageModel` vs `ai.languageModel.create()`) are evolving across Chrome release channels. Instead of standard try/catch wrappers, use an explicit capability check:

```typescript
export async function getLanguageModel() {
  if (typeof window !== 'undefined' && 'ai' in window && 'languageModel' in (window as any).ai) {
    const capabilities = await (window as any).ai.languageModel.capabilities();
    if (capabilities.available === 'readily') {
      return await (window as any).ai.languageModel.create();
    }
  }
  return null; // Graceful fallback to regex rule engine in TaxonomyAgent
}
```

* **Capabilities:**
  1. **Zero-Shot Taxonomy Classification:** Pass page title + top 300 words of Readability text to classify into canonical project domains (`engineering`, `research`, `documentation`, `social`, `financial`, `admin`, `distraction`).
  2. **Zero-Latency Page Summarization:** Generate a concise 2-sentence executive summary of high-dwell pages ($>15\text{s}$) for quick review in the SidePanel UI.
  3. **Entity Extraction:** Extract named entities (projects, libraries, tools, people) to build the local graph.

### 3.2 Offscreen Wasm Vector Engine & Memory Management
* **Technology Stack:** `@xenova/transformers` (Transformers.js) running inside `src/offscreen/offscreen.html` / `src/offscreen/offscreen.ts`.
* **Model Selection:** `Xenova/all-MiniLM-L6-v2` (quantized ONNX, 23MB bundle, 384 dimensions).
* **Mandatory Wasm Tensor Memory Cleanup:**
  To prevent cumulative Wasm/WebGPU heap leaks inside long-running offscreen document workers, ONNX tensor allocations must be explicitly freed immediately after Float32 conversion:

```typescript
// Inside src/offscreen/offscreen.ts
const output = await embedder(cleanedText, { pooling: 'mean', normalize: true });
const vector = new Float32Array(output.data);
if (output.dispose) {
  output.dispose(); // Instantly free ONNX/Wasm heap allocations
}
```

* **Execution Flow:**
  1. Background Service Worker detects high-dwell page ($>5\text{s}$).
  2. Sends IPC message `GENERATE_EMBEDDING` with `frameId` and cleaned text payload to the Offscreen Document.
  3. Offscreen Worker runs feature extraction pipeline, normalizes the 384-dimensional vector, disposes of tensor heap, and posts `Float32Array` back.
  4. Background worker writes vector blob into Dexie.js `embeddings` table.

### 3.3 Dexie.js Schema Extension (`src/lib/db.ts`)
Add a dedicated high-performance vector store:

```typescript
export interface EmbeddingRecord {
  id?: number;
  frameId: number;
  vector: Float32Array;
  dimension: number; // 384
  createdAt: number;
}

// Dexie Schema Upgrade (Version 3)
this.version(3).stores({
  frames: '++id, url, title, domain, category, dwellTime, timestamp, synced',
  embeddings: '++id, &frameId, createdAt', // Indexed by frameId for fast joins
  anchors: '++id, title, category, status, createdAt',
  telemetry: '++id, timestamp'
});
```

### 3.4 Two-Stage Coarse-to-Fine Search Optimization
To prevent $O(N)$ full vector scans over 2,000+ entries on every frame update, execute a two-stage coarse-to-fine query pipeline:

* **Stage 1 (IndexedDB Candidate Filter):** Use Dexie indices to retrieve candidate frame IDs filtered by recency ($\Delta t \le 7\text{d}$), category, or keyword substring, capping the candidate pool to $N \le 200$ items.
* **Stage 2 (Vector Rescore):** Compute dot-product cosine similarity over only the filtered candidate Float32Array vectors.

$$\text{CosineSimilarity}(\mathbf{u}, \mathbf{v}) = \sum_{i=1}^{384} u_i \cdot v_i$$

* **Hybrid Ranking Formula:**
  $$\text{Score} = w_{\text{vector}} \cdot \text{CosineSimilarity} + w_{\text{recency}} \cdot 2^{-\Delta t / 7\text{d}} + w_{\text{dwell}} \cdot \min\left(1.0, \frac{\text{dwellTime}}{60}\right)$$
  Where $w_{\text{vector}} = 0.6$, $w_{\text{recency}} = 0.25$, $w_{\text{dwell}} = 0.15$.

---

## 4. In-Browser Agent Upgrades & Dynamic Drift Hysteresis

| Agent | Current Phase 2 Baseline | Phase 3.1 On-Device Upgrade |
|---|---|---|
| **`TaxonomyAgent`** | Regex keyword rules (`domain-rules.ts`) | Hybrid: Chrome `window.ai` zero-shot prompt with fallback to regex |
| **`DriftDetector`** | Keyword overlap against active anchor title | **Dynamic Hysteresis Vector Distance:** Requires **two consecutive high-dwell frames** ($>15\text{s}$ each) exceeding distance threshold, with length-scaled dynamic sensitivity: $\text{Threshold}_{\text{drift}} = 0.65 + \alpha \cdot e^{-\frac{\text{length}}{100}}$ |
| **`LibrarianAgent`** | Full-text substring search | 100% offline two-stage hybrid vector + BM25 + recency ranking |
| **`ContextAnchorAgent`** | Manual string anchor matching | Auto-clustering of high-similarity embeddings into candidate focus anchors |

### Dynamic Hysteresis Rule
To eliminate false-positive drift triggers when users navigate broad documentation portals or multi-topic hubs:
1. **Dwell Hysteresis:** A drift event is emitted **only** after two consecutive active frames stay on non-matching content for $>15\text{s}$ each.
2. **Dynamic Sensitivity:** Short query/title payloads use a higher distance threshold, while long DOM documents use tighter thresholds to prevent accidental alerts.

---

## 5. MCP Server Bridge Extensions (`src/mcp/`)

Expose 2 new local MCP tools via Bun stdio bridge to `unified-agent`:

1. **`exocortex_semantic_search`**
   - **Input:** `{ query: string, limit?: number, min_score?: number }`
   - **Operation:** Vectorizes `query` via Offscreen Worker, executes two-stage candidate filter & cosine similarity against Dexie `embeddings`, and returns top matching frames with full page context.
2. **`exocortex_summarize_page`**
   - **Input:** `{ frame_id?: number, url?: string }`
   - **Operation:** Uses Chrome `window.ai` to return a 2-sentence summary of the page context.

---

## 6. Resource & Performance Constraints

- **Offscreen Worker RAM Cap:** $\le 120\text{ MB}$ (model weights + Wasm runtime memory with mandatory `dispose()` cleanup).
- **Embedding Latency Budget:** $< 150\text{ms}$ per 300-word frame on standard CPU/GPU Wasm backend.
- **Gemini Nano Latency Budget:** $< 60\text{ms}$ per page classification/summary request.
- **Storage Cap:** 7-day LRU retention policy on `embeddings` table to keep IndexedDB footprint $< 50\text{ MB}$ (~2,000 vector records $\times$ 1.5 KB per record).

---

## 7. Verification & Definition of Done

- [ ] `bun run build` passes with 0 TypeScript / Vite compilation errors.
- [ ] Offscreen worker loads `all-MiniLM-L6-v2` ONNX model, generates 384d `Float32Array` vectors, and disposes tensor heap memory cleanly.
- [ ] Dexie.js version 3 migration successfully stores and joins `embeddings` with `frames`.
- [ ] Two-stage search retrieves candidate IDs first before running vector rescoring.
- [ ] `DriftDetector` applies 2-frame hysteresis and dynamic length thresholding before flagging focus drift.
- [ ] Chrome `window.ai` zero-shot classification executes when `capabilities.available === 'readily'` and falls back gracefully to regex rules when unflagged.
- [ ] MCP tool `exocortex_semantic_search` returns ranked semantic search results via Bun CLI (`bun src/mcp/cli.ts`).
