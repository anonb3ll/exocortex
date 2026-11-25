/**
 * INDEPENDENT ADVERSARIAL PROBES — task t_19e6870c (hub #1054)
 * Verification-only. Does NOT modify implementation or shipped tests.
 * Run: bun test verify/adversarial-probes.test.ts   (from repo root)
 * Purpose: try to falsify the shipped honesty/privacy contract beyond the
 * shipped tests; every check prints PASS/FAIL and a reason.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { hybridVectorSearch, cosineSimilarity, VECTOR_RELEVANCE_FLOOR } from "../src/lib/models/vector-search";
import { searchPanelMemory } from "../src/sidepanel/semantic-search";
import { isSearchQueryBlocked } from "../src/lib/mobile-slice";
import { handleSemanticSearch } from "../src/mcp/tools";

const DIM = 384; // production dimension — the shipped tests use 8; be real here

function modelVec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1)) * 0.5;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm) as Float32Array;
}
function orthoVec(): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = 1;
  return v;
}

async function seedFrame(title: string, url = `https://example.test/${title.replace(/\W+/g, "-").toLowerCase()}`) {
  return db.frames.add({
    url,
    title,
    summary: `${title} summary`,
    domain: "example.test",
    dwellTime: 30,
    timestamp: Date.now(),
  });
}

describe("adversarial: blocked query must never reach the embedder (searchPanelMemory wiring)", () => {
  test("P1 blocked-variant battery: embedder and search are never invoked", async () => {
    const blockedInputs = [
      "chase.com",
      "my password",
      "https://chase.com/login",
      "chrome://settings",
      "1password.com",
      "check my bankofamerica.com balance",
    ];
    for (const q of blockedInputs) {
      let embedCalls = 0;
      let searchCalls = 0;
      const res = await searchPanelMemory(q, {
        requestEmbedding: async () => { embedCalls++; return { vector: modelVec(1), source: "model" as const }; },
        search: (async () => { searchCalls++; return []; }) as any,
      });
      expect(res.status).toBe("privacy_blocked");
      expect(res.results).toEqual([]);
      expect(embedCalls).toBe(0);
      expect(searchCalls).toBe(0);
    }
  });

  test("P2 non-blocked benign query DOES invoke embedder (proves the guard is not just always-on)", async () => {
    let embedCalls = 0;
    const res = await searchPanelMemory("what was the weather last week", {
      requestEmbedding: async () => { embedCalls++; return { vector: [], source: "fallback" as const }; },
      search: async () => [] as any,
    });
    expect(embedCalls).toBe(1);
    expect(res.status).toBe("ok");
  });
});

describe("adversarial: a fallback/label-less embedding must never yield vector cosine or a vector badge", () => {
  beforeEach(async () => {
    await Promise.all([db.frames.clear(), db.embeddings.clear(), db.page_text.clear()]);
  });

  test("P3 fallback-source stored embedding + real model query vector => lexical, cosine null (384-d)", async () => {
    const frameId = await seedFrame("Caring for your dog");
    await db.embeddings.put({ frameId, vector: modelVec(1), dimension: DIM, createdAt: Date.now(), source: "fallback" });
    const results = await hybridVectorSearch({ queryVector: modelVec(1), queryText: "dog", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("P4 legacy embedding with NO source field => never rescored as vector", async () => {
    const frameId = await seedFrame("Caring for your dog");
    await db.embeddings.put({ frameId, vector: modelVec(1), dimension: DIM, createdAt: Date.now() } as never);
    const results = await hybridVectorSearch({ queryVector: modelVec(1), queryText: "dog", limit: 5 });
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("P5 control: model-source embedding + model query vector DOES yield vector cosine (sanity of harness)", async () => {
    const frameId = await seedFrame("Caring for your dog");
    await db.embeddings.put({ frameId, vector: modelVec(1), dimension: DIM, createdAt: Date.now(), source: "model" });
    const results = await hybridVectorSearch({ queryVector: modelVec(1), queryText: "dog", limit: 5 });
    expect(results[0].matchKind).toBe("vector");
    expect(results[0].cosineSimilarity).toBeGreaterThan(VECTOR_RELEVANCE_FLOOR);
  });

  test("P6 dimension mismatch: query vector 384 vs stored 8-d model vector => lexical, not a vector lie", async () => {
    const frameId = await seedFrame("Caring for your dog");
    const eight = new Float32Array(8); eight[0] = 1;
    await db.embeddings.put({ frameId, vector: eight, dimension: 8, createdAt: Date.now(), source: "model" });
    const results = await hybridVectorSearch({ queryVector: modelVec(1), queryText: "dog", limit: 5 });
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("P7 cosineSimilarity of two unit-norm vectors is bounded and finite; zero vectors never produce a fake positive", async () => {
    const v = modelVec(1);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    const inAxis = new Float32Array(DIM); inAxis[0] = 1;
    const ortho = new Float32Array(DIM); ortho[1] = 1; // genuinely orthogonal to inAxis (index 0)
    expect(cosineSimilarity(inAxis, ortho)).toBeCloseTo(0, 5);
    const zeros = new Float32Array(DIM);
    expect(cosineSimilarity(zeros, modelVec(1))).toBe(0);
    expect(cosineSimilarity(v, new Float32Array(DIM + 1))).toBe(0);
  });
});

describe("adversarial: embedding_unavailable must never fabricate a result", () => {
  test("P8 throwing embedder => embedding_unavailable, zero results, search never invoked", async () => {
    let searchCalls = 0;
    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => { throw new Error("embedder process down"); },
      search: (async () => { searchCalls++; return []; }) as any,
    });
    expect(res.status).toBe("embedding_unavailable");
    expect(res.results).toEqual([]);
    expect(searchCalls).toBe(0);
  });

  test("P9 WIRING GAP: real sidepanel requestPanelEmbedding never throws — it resolves fallback, so the unavailable state is unreachable in production", async () => {
    // This asserts the REAL wiring contract (src/sidepanel/sidepanel.ts requestPanelEmbedding):
    // on lastError / status!=="success" / no response it resolves { vector: [], source: "fallback" }.
    // So searchPanelMemory receives a fallback source, returns status "ok" (silent lexical),
    // and the "Semantic search unavailable — showing lexical matches" banner path can never render.
    const wiringEquivalent = async () => ({ vector: [], source: "fallback" as const });
    const res = await searchPanelMemory("canine companion", { requestEmbedding: wiringEquivalent });
    expect(res.status).toBe("ok"); // silent degrade — NOT embedding_unavailable
    // If results carry a vector token anywhere, that would be the lie; assert the opposite:
    for (const r of res.results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
    // NOTE: this is a finding, not a pass — the shipped unit tests reach embedding_unavailable
    // only by injecting a *throwing* fake that production wiring cannot produce.
  });
});

describe("adversarial: MCP/bridge semantic-search path query guard", () => {
  test("P10 sensitive queries are refused on the MCP tool path (guard landed; was the P10 gap)", async () => {
    // Original finding: service-worker.ts semantic_search bridge handler reached
    // handleSemanticSearch() with no isSearchQueryBlocked pre-check, so a
    // sensitive query was searched on the bridge path while the side panel
    // refused it. The guard now exists at all three layers — the bridge arg
    // validator (src/bridge/protocol.ts), the service-worker handler, and the
    // tool itself (src/mcp/tools.ts). This battery pins the tool-level refusal
    // so the gap cannot silently reopen.
    const blockedQueries = [
      "chase.com",
      "my password",
      "https://chase.com/login",
      "chrome://settings",
      "check my bankofamerica.com balance",
    ];
    for (const q of blockedQueries) {
      await expect(handleSemanticSearch({ query: q, limit: 5 })).rejects.toThrow("privacy blocklist");
    }
    // Control: a benign query must still reach search (guard is not just always-on).
    const res = await handleSemanticSearch({ query: "what was the weather last week", limit: 5 });
    expect(Array.isArray(res)).toBe(true);
  });

  test("P11 query blocklist only substring-matches FQ domains, not bare brands (canonical contract)", async () => {
    // Canonical contract per docs/privacy-guard.md "Two query guards": the query
    // guard is a narrow list (credential keywords + named hosts); generic
    // hostname fragments and bare brands are URL-guard terms only.
    expect(isSearchQueryBlocked("chase.com")).toBe(true);
    expect(isSearchQueryBlocked("chase.com login")).toBe(true);
    expect(isSearchQueryBlocked("https://chase.com/accounts")).toBe(true);
    expect(isSearchQueryBlocked("my password")).toBe(true);
    // Bare brand / spaced brand passes the query guard (URL guard is stricter):
    expect(isSearchQueryBlocked("chase")).toBe(false);
    expect(isSearchQueryBlocked("bank of america login")).toBe(false);
  });
});