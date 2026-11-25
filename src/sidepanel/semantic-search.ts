import type { VectorSearchResult } from "../lib/models/vector-search";
import { hybridVectorSearch } from "../lib/models/vector-search";
import { isSearchQueryBlocked } from "../content/privacy";

export type PanelSearchStatus = "ok" | "empty" | "privacy_blocked" | "embedding_unavailable";

export interface PanelEmbeddingResult {
  vector: number[];
  source: "model" | "fallback";
}

export interface SemanticSearchDeps {
  requestEmbedding: (text: string) => Promise<PanelEmbeddingResult>;
  search?: typeof hybridVectorSearch;
}

export interface PanelSemanticSearchResult {
  status: PanelSearchStatus;
  query: string;
  results: VectorSearchResult[];
  errorMessage?: string;
}

export async function requestPanelEmbedding(text: string): Promise<PanelEmbeddingResult> {
  return await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "REQUEST_VECTOR_EMBEDDING", payload: { text } }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      if (!response || response.status !== "success" || response.source !== "model") {
        reject(new Error(response?.error || "semantic embedding unavailable"));
        return;
      }
      resolve({ vector: response.vector || [], source: response.source === "model" ? "model" : "fallback" });
    });
  });
}

export async function searchPanelMemory(
  query: string,
  deps: SemanticSearchDeps,
  options?: { limit?: number }
): Promise<PanelSemanticSearchResult> {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    return {
      status: "empty",
      query: "",
      results: []
    };
  }

  if (isSearchQueryBlocked(trimmed)) {
    return {
      status: "privacy_blocked",
      query: "[blocked-query]",
      results: [],
      errorMessage: "Search query matches privacy blocklist"
    };
  }

  let embedding: PanelEmbeddingResult;
  try {
    embedding = await deps.requestEmbedding(trimmed);
  } catch (err) {
    return {
      status: "embedding_unavailable",
      query: trimmed,
      results: [],
      errorMessage: err instanceof Error ? err.message : String(err)
    };
  }

  const queryVector = embedding.source === "model" ? embedding.vector : undefined;
  const searchFn = deps.search ?? hybridVectorSearch;
  const results = await searchFn({
    queryVector,
    queryText: trimmed,
    limit: options?.limit ?? 10
  });

  return {
    status: "ok",
    query: trimmed,
    results
  };
}
