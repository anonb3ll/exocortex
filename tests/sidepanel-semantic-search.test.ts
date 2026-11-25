import { describe, expect, test } from "bun:test";
import { requestPanelEmbedding, searchPanelMemory } from "../src/sidepanel/semantic-search";
import { isSearchQueryBlocked } from "../src/lib/mobile-slice";

describe("sidepanel-semantic-search orchestration", () => {
  test("1. Guard-first URL with a spy: blocked, search and embedding not invoked", async () => {
    let calls = 0;
    const requestEmbedding = async () => {
      calls++;
      return { vector: [] as number[], source: "model" as const };
    };
    let searchCalls = 0;
    const fakeSearch = async () => {
      searchCalls++;
      return [];
    };

    const res = await searchPanelMemory("https://chase.com/login", {
      requestEmbedding,
      search: fakeSearch as any
    });

    expect(res.status).toBe("privacy_blocked");
    expect(res.query).toBe("[blocked-query]");
    expect(res.results).toEqual([]);
    expect(res.errorMessage).toBe("Search query matches privacy blocklist");
    expect(calls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  test("2. Guard-first keyword: ' my password ' (guard trims before matching)", async () => {
    let calls = 0;
    const requestEmbedding = async () => {
      calls++;
      return { vector: [] as number[], source: "model" as const };
    };
    let searchCalls = 0;
    const fakeSearch = async () => {
      searchCalls++;
      return [];
    };

    const res = await searchPanelMemory(" my password ", {
      requestEmbedding,
      search: fakeSearch as any
    });

    expect(res.status).toBe("privacy_blocked");
    expect(res.query).toBe("[blocked-query]");
    expect(res.results).toEqual([]);
    expect(calls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  test("3. Empty: '   ' returns empty status without calling spy", async () => {
    let calls = 0;
    const requestEmbedding = async () => {
      calls++;
      return { vector: [] as number[], source: "model" as const };
    };
    let searchCalls = 0;
    const fakeSearch = async () => {
      searchCalls++;
      return [];
    };

    const res = await searchPanelMemory("   ", {
      requestEmbedding,
      search: fakeSearch as any
    });

    expect(res.status).toBe("empty");
    expect(res.query).toBe("");
    expect(res.results).toEqual([]);
    expect(calls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  test("4. Model path: passes queryVector and queryText to search", async () => {
    let recordedParams: any = null;
    const fakeSearch = async (params: any) => {
      recordedParams = params;
      return [];
    };

    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => ({ vector: [1, 2, 3], source: "model" }),
      search: fakeSearch as any
    });

    expect(res.status).toBe("ok");
    expect(recordedParams.queryVector).toEqual([1, 2, 3]);
    expect(recordedParams.queryText).toBe("canine companion");
  });

  test("5. Fallback path: passes undefined queryVector to search", async () => {
    let recordedParams: any = null;
    const fakeSearch = async (params: any) => {
      recordedParams = params;
      return [];
    };

    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => ({ vector: [1, 2, 3], source: "fallback" }),
      search: fakeSearch as any
    });

    expect(res.status).toBe("ok");
    expect(recordedParams.queryVector).toBeUndefined();
    expect(recordedParams.queryText).toBe("canine companion");
  });

  test("6. Real panel wiring treats the worker fallback response as unavailable", async () => {
    const previousChrome = (globalThis as any).chrome;
    let searchCalls = 0;
    let embeddingCalls = 0;
    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: (_message: unknown, callback: (response?: unknown) => void) => {
          embeddingCalls++;
          callback({ status: "success", vector: [], source: "fallback" });
        }
      }
    };

    try {
      const res = await searchPanelMemory("canine companion", {
        requestEmbedding: requestPanelEmbedding,
        search: (async () => {
          searchCalls++;
          return [];
        }) as any
      });

      expect(res.status).toBe("embedding_unavailable");
      expect(res.errorMessage).toContain("semantic embedding unavailable");
      expect(res.results).toEqual([]);
      expect(embeddingCalls).toBe(1);
      expect(searchCalls).toBe(0);
    } finally {
      if (previousChrome === undefined) {
        delete (globalThis as any).chrome;
      } else {
        (globalThis as any).chrome = previousChrome;
      }
    }
  });

  test("7. Exported-guard unit: isSearchQueryBlocked", () => {
    expect(isSearchQueryBlocked("https://chase.com/login")).toBe(true);
    expect(isSearchQueryBlocked("chase.com")).toBe(true);
    expect(isSearchQueryBlocked("chase.com login")).toBe(true);
    expect(isSearchQueryBlocked("my password")).toBe(true);
    expect(isSearchQueryBlocked("chrome://settings")).toBe(true);
    expect(isSearchQueryBlocked("what was the weather last week")).toBe(false);
    // Canonical query-guard contract (docs/privacy-guard.md "Two query guards"):
    // bare brands and generic terms pass; only the URL guard is stricter.
    expect(isSearchQueryBlocked("chase")).toBe(false);
    expect(isSearchQueryBlocked("bank of america login")).toBe(false);
  });
});
