/**
 * Does `exocortex_semantic_search` actually search semantically?
 *
 * The tool advertised "two-stage hybrid vector search over IndexedDB embeddings
 * combined with BM25 keyword rescoring". None of that was happening. No caller ever
 * passed a query vector, so `hybridVectorSearch` fell to a hardcoded
 * `sim = 0.7 // Text match surrogate` on a title substring, wrote that constant into
 * a field named `cosineSimilarity`, and returned it. ("BM25" appeared exactly once
 * in the repository: in the description string.) A caller could not tell a real
 * embedding match from a substring hit, because both reported a plausible
 * similarity score.
 *
 * The discriminating test is a paraphrase: text that means the same thing while
 * sharing no query keywords. Lexical ranking cannot retrieve it by construction;
 * vector search can. So this asserts both halves of the contract —
 * a real query vector retrieves the paraphrase, and without one the result is
 * labelled `lexical` rather than dressed up as a similarity.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { handleSemanticSearch } from "../src/mcp/tools";
import { hybridVectorSearch, lexicalOverlap, VECTOR_RELEVANCE_FLOOR } from "../src/lib/models/vector-search";
import { searchPanelMemory } from "../src/sidepanel/semantic-search";
import { BRIDGE_ARG_VALIDATORS } from "../src/bridge/protocol";

const DIM = 8;

/** Unit-length vector pointing mostly along `axis` — a stand-in for a MiniLM embedding. */
function vec(axis: number, jitter = 0): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  if (jitter) v[(axis + 1) % DIM] = jitter;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm) as Float32Array;
}

async function seed() {
  await Promise.all([db.frames.clear(), db.embeddings.clear(), db.page_text.clear()]);

  // The paraphrase: no token overlap with "canine companion" whatsoever.
  const paraphraseId = await db.frames.add({
    url: "https://example.test/a",
    title: "Caring for your dog",
    summary: "Grooming and feeding a puppy",
    domain: "example.test",
    dwellTime: 30,
    timestamp: Date.now(),
  });
  const unrelatedId = await db.frames.add({
    url: "https://example.test/b",
    title: "Quarterly tax filing deadlines",
    summary: "Corporate accounting schedule",
    domain: "example.test",
    dwellTime: 30,
    timestamp: Date.now(),
  });

  await db.embeddings.put({
    frameId: paraphraseId,
    vector: vec(0, 0.1),
    dimension: DIM,
    createdAt: Date.now(),
    source: "model",
  });
  await db.embeddings.put({
    frameId: unrelatedId,
    vector: vec(4),
    dimension: DIM,
    createdAt: Date.now(),
    source: "model",
  });

  return { paraphraseId, unrelatedId };
}

describe("semantic search tells you how it matched", () => {
  beforeEach(async () => {
    await seed();
  });

  test("a real query vector retrieves a paraphrase that shares no keywords", async () => {
    const { paraphraseId } = await seed();

    // "canine companion" shares no token with "Caring for your dog".
    expect(lexicalOverlap("canine companion", "Caring for your dog Grooming and feeding a puppy")).toBe(0);

    // A decoy whose title contains the query verbatim. Without it this test passed
    // for the wrong reason: stage 1 narrowed candidates by substring, so whenever
    // ANY candidate matched literally the paraphrase was discarded before cosine
    // rescoring ran. With no decoy in the fixture that filter was a no-op and the
    // test proved less than it appeared to.
    await db.frames.add({
      url: "https://example.test/decoy",
      title: "canine companion",
      summary: "canine companion",
      dwellTime: 30,
      timestamp: Date.now(),
    });

    const results = await hybridVectorSearch({
      queryVector: vec(0),
      queryText: "canine companion",
      limit: 5,
    });

    expect(results[0].frameId).toBe(paraphraseId);
    expect(results[0].matchKind).toBe("vector");
    expect(results[0].cosineSimilarity).toBeGreaterThan(0.9);
  });

  test("without a query vector, results are labelled lexical rather than given a fake similarity", async () => {
    const results = await hybridVectorSearch({ queryText: "dog", limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      // The old code reported 0.7 here for every title substring hit.
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("a legacy embedding with no provenance is not trusted as a model vector", async () => {
    // The case that actually exists in the field. `source` became required after
    // these rows were written, so they carry `undefined` — and the first version of
    // the filter tested `=== "fallback"`, which waved every one of them through as
    // if it were a real embedding. Given the headline defect (chrome.offscreen
    // undefined, embedder never ran), those rows are overwhelmingly the bad ones.
    await db.embeddings.clear();
    const frame = (await db.frames.toArray())[0];
    await db.embeddings.put({
      frameId: frame.id!,
      vector: vec(0),
      dimension: DIM,
      createdAt: Date.now(),
      // Deliberately absent, exactly as a pre-v7 row would be.
    } as never);

    const results = await hybridVectorSearch({ queryVector: vec(0), queryText: "dog", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("a fallback embedding is never used for vector rescoring", async () => {
    // A hash bag-of-words has an embedding's shape but not its semantics, so
    // comparing one by cosine similarity produces a confident, meaningless number.
    await db.embeddings.clear();
    const frame = (await db.frames.toArray())[0];
    await db.embeddings.put({
      frameId: frame.id!,
      vector: vec(0),
      dimension: DIM,
      createdAt: Date.now(),
      source: "fallback",
    });

    const results = await hybridVectorSearch({ queryVector: vec(0), queryText: "dog", limit: 5 });
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
    }
  });

  test("the unbridged MCP tool degrades to lexical, and says so", async () => {
    // handleSemanticSearch takes queryVector as a second argument precisely so an
    // MCP client cannot supply one; only the extension can embed a query.
    const results = (await handleSemanticSearch({ query: "dog", limit: 5 })) as Array<{
      matchKind: string;
      cosineSimilarity: number | null;
    }>;

    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("a real vector match outranks a full-overlap lexical match", async () => {
    // The regression this PR introduced. `sim` fed `wVector * sim` at one weight for
    // both kinds, but full lexical overlap is 1.0 by construction while a genuine
    // paraphrase lands ~0.5-0.7 cosine — so keyword hits systematically beat semantic
    // ones in any mixed candidate set. Exactly backwards for the feature.
    await Promise.all([db.frames.clear(), db.embeddings.clear()]);

    const semanticId = await db.frames.add({
      url: "https://example.test/semantic",
      title: "Caring for your dog",
      summary: "Grooming and feeding a puppy",
      dwellTime: 30,
      timestamp: Date.now(),
    });
    // Every token of the query appears verbatim -> lexicalOverlap === 1.0.
    await db.frames.add({
      url: "https://example.test/lexical",
      title: "canine companion",
      summary: "canine companion",
      dwellTime: 30,
      timestamp: Date.now(),
    });
    await db.embeddings.put({
      frameId: semanticId,
      vector: vec(0),
      dimension: DIM,
      createdAt: Date.now(),
      source: "model",
    });

    const results = await hybridVectorSearch({
      queryVector: vec(0),
      queryText: "canine companion",
      limit: 5,
    });

    expect(results[0].frameId).toBe(semanticId);
    expect(results[0].matchKind).toBe("vector");
    // And the lexical hit really was a perfect one — otherwise this proves nothing.
    const lexicalHit = results.find((r) => r.matchKind === "lexical");
    expect(lexicalHit?.lexicalScore).toBe(1);
  });

  test("a weak vector match does NOT outrank a strong lexical one", async () => {
    // The converse guard. Tiering must not become "any frame with an embedding
    // wins" — a cosine of 0.1 is a real number and still a bad match.
    await Promise.all([db.frames.clear(), db.embeddings.clear()]);

    const weakId = await db.frames.add({
      url: "https://example.test/weak",
      title: "Quarterly tax filing",
      summary: "Corporate accounting",
      dwellTime: 30,
      timestamp: Date.now(),
    });
    const strongLexicalId = await db.frames.add({
      url: "https://example.test/lexical",
      title: "canine companion",
      summary: "canine companion",
      dwellTime: 30,
      timestamp: Date.now(),
    });
    // Orthogonal to the query vector -> cosine 0, far below VECTOR_RELEVANCE_FLOOR.
    await db.embeddings.put({
      frameId: weakId,
      vector: vec(4),
      dimension: DIM,
      createdAt: Date.now(),
      source: "model",
    });

    const results = await hybridVectorSearch({
      queryVector: vec(0),
      queryText: "canine companion",
      limit: 5,
    });

    expect(results[0].frameId).toBe(strongLexicalId);
    const weak = results.find((r) => r.frameId === weakId);
    expect(weak?.cosineSimilarity).toBeLessThan(VECTOR_RELEVANCE_FLOOR);
  });

  test("lexicalOverlap matches whole tokens, not substrings", async () => {
    // "cat" against "category" inflated the score in the direction that makes
    // lexical results look better than they are.
    expect(lexicalOverlap("cat", "category listings")).toBe(0);
    expect(lexicalOverlap("cat", "the cat sat")).toBe(1);
    expect(lexicalOverlap("cat dog", "the cat sat")).toBe(0.5);
  });

  test("dwell_blocks fallback candidates are never joined to embeddings", async () => {
    // dwell_blocks primary keys come from a different autoincrement sequence than
    // frames. Reusing them as frame ids attached whatever unrelated record happened
    // to share the number — a page rescored against another page's embedding.
    await db.frames.clear();
    await db.embeddings.clear();
    await db.dwell_blocks.clear();

    const dwellId = await db.dwell_blocks.add({
      sessionId: "s1",
      url: "https://example.test/dwell",
      title: "Quarterly tax filing deadlines",
      timestamp: Date.now(),
      dwellTime: 30_000,
    });
    // An embedding whose frameId collides with the dwell block's id, pointing in a
    // completely different semantic direction.
    await db.embeddings.put({
      frameId: dwellId,
      vector: vec(0),
      dimension: DIM,
      createdAt: Date.now(),
      source: "model",
    });

    const results = await hybridVectorSearch({ queryVector: vec(0), queryText: "tax", limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    // It must not claim a vector match on a borrowed embedding.
    for (const r of results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });
});

describe("a typed query that matches nothing", () => {
  beforeEach(async () => {
    await seed();
  });

  test("returns no results when there is no lexical hit and no query vector", async () => {
    // "kubernetes" appears in neither seeded page. The search used to fall through
    // its own narrowing step and return both of them, ranked by recency and dwell —
    // the user's most recent pages presented as matches for a word they never read.
    expect(lexicalOverlap("kubernetes", "Caring for your dog Grooming and feeding a puppy")).toBe(0);
    expect(await hybridVectorSearch({ queryText: "kubernetes", limit: 10 })).toEqual([]);
    expect(await hybridVectorSearch({ queryText: "zzz qqq", limit: 10 })).toEqual([]);
  });

  test("the same holds for the dwell_blocks fallback candidates", async () => {
    await Promise.all([db.frames.clear(), db.embeddings.clear(), db.dwell_blocks.clear()]);
    await db.dwell_blocks.add({
      sessionId: "s1",
      url: "https://example.test/dwell",
      title: "Quarterly tax filing deadlines",
      timestamp: Date.now(),
      dwellTime: 30_000,
    });

    expect(await hybridVectorSearch({ queryText: "kubernetes", limit: 10 })).toEqual([]);
    expect((await hybridVectorSearch({ queryText: "tax", limit: 10 })).length).toBe(1);
  });

  test("a query sharing one whole word with a page still finds it, labelled lexical", async () => {
    // Not a verbatim phrase match, so the phrase narrowing finds nothing — token
    // overlap is what keeps a multi-word query useful without a vector.
    const results = await hybridVectorSearch({ queryText: "dog training videos", limit: 10 });
    expect(results.map((r) => r.title)).toEqual(["Caring for your dog"]);
    expect(results[0].matchKind).toBe("lexical");
    expect(results[0].cosineSimilarity).toBeNull();
    expect(results[0].lexicalScore).toBeGreaterThan(0);
  });

  test("a substring that is not a whole word is still a phrase hit", async () => {
    // "groom" is inside "Grooming": the phrase narrowing keeps it, as before.
    const results = await hybridVectorSearch({ queryText: "groom", limit: 10 });
    expect(results.map((r) => r.title)).toEqual(["Caring for your dog"]);
  });

  test("with no query at all, recent pages are still listed", async () => {
    // Browsing recents is not a search; nothing was typed, so nothing is claimed.
    expect((await hybridVectorSearch({ limit: 10 })).length).toBe(2);
    expect((await hybridVectorSearch({ queryText: "   ", limit: 10 })).length).toBe(2);
  });

  test("a real query vector is unaffected: the paraphrase is still found", async () => {
    const { paraphraseId } = await seed();
    const results = await hybridVectorSearch({ queryVector: vec(0), queryText: "canine companion", limit: 5 });
    expect(results[0].frameId).toBe(paraphraseId);
    expect(results[0].matchKind).toBe("vector");
  });

  test("site name and author are searchable", async () => {
    await db.frames.add({
      url: "https://www.youtube.com/watch?v=abc",
      title: "Rust in 100 Seconds",
      siteName: "YouTube",
      byline: "Fireship",
      contentKind: "video",
      dwellTime: 120,
      timestamp: Date.now(),
    });

    const byChannel = await hybridVectorSearch({ queryText: "fireship", limit: 10 });
    expect(byChannel.map((r) => r.title)).toEqual(["Rust in 100 Seconds"]);
    expect(byChannel[0]).toMatchObject({ siteName: "YouTube", byline: "Fireship", contentKind: "video" });
  });

  test("the side panel shows nothing for a no-hit query when the embedder is down", async () => {
    // The panel's outage path: it retries with a fallback embedding and labels
    // the result lexical. For a query with no lexical hit that must be empty.
    const res = await searchPanelMemory("kubernetes", {
      requestEmbedding: async () => ({ vector: [], source: "fallback" })
    });
    expect(res.status).toBe("ok");
    expect(res.results).toEqual([]);
  });

  test("the unbridged MCP tool returns nothing rather than recent pages", async () => {
    expect(await handleSemanticSearch({ query: "kubernetes", limit: 5 })).toEqual([]);
  });
});

describe("side-panel orchestration (searchPanelMemory)", () => {
  beforeEach(async () => {
    await seed();
  });

  test("the side-panel path retrieves a paraphrase only when the embedder produced a model vector", async () => {
    const { paraphraseId } = await seed();

    await db.frames.add({
      url: "https://example.test/decoy",
      title: "canine companion",
      summary: "canine companion",
      dwellTime: 30,
      timestamp: Date.now(),
    });

    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => ({ vector: Array.from(vec(0)), source: "model" })
    });

    expect(res.results[0].frameId).toBe(paraphraseId);
    expect(res.results[0].matchKind).toBe("vector");
    expect(res.results[0].cosineSimilarity!).toBeGreaterThan(0.9);
  });

  test("a fallback-source embedding degrades the panel search to labelled lexical", async () => {
    // A page that really contains the query. Without it this test passed only
    // because a query with no lexical hit used to return every recent page — the
    // defect covered by "a typed query that matches nothing" below. The claim
    // here is about labelling, so it needs a genuine lexical hit to label.
    await db.frames.add({
      url: "https://example.test/decoy",
      title: "canine companion",
      summary: "canine companion",
      dwellTime: 30,
      timestamp: Date.now(),
    });

    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => ({ vector: Array.from(vec(0)), source: "fallback" })
    });

    expect(res.status).toBe("ok");
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.matchKind).toBe("lexical");
      expect(r.cosineSimilarity).toBeNull();
    }
  });

  test("an unavailable embedder returns embedding_unavailable, never a fabricated vector", async () => {
    const res = await searchPanelMemory("canine companion", {
      requestEmbedding: async () => {
        throw new Error("embedder down");
      }
    });

    expect(res.status).toBe("embedding_unavailable");
    expect(res.results.length).toBe(0);
  });
});

describe("query privacy guard on both semantic-search entry paths", () => {
  const blockedQueries = [
    "chase.com",
    "check my bankofamerica.com balance",
    "https://chase.com/login",
    "chrome://settings",
    "my password",
  ];

  test("direct MCP path: handleSemanticSearch refuses blocked queries before searching", async () => {
    for (const query of blockedQueries) {
      await expect(handleSemanticSearch({ query, limit: 5 })).rejects.toThrow("privacy blocklist");
    }
  });

  test("bridge path: the semantic_search arg validator refuses the same queries", () => {
    // The bridge validator is the first gate a socket-delivered query hits
    // (src/bridge/protocol.ts), ahead of the service-worker handler and the
    // tool itself. Both layers must agree or the bridge path is a bypass.
    for (const query of blockedQueries) {
      expect(() => BRIDGE_ARG_VALIDATORS.semantic_search({ query })).toThrow("privacy blocklist");
    }
  });

  test("canonical contract: bare brands pass the query guard on both paths", async () => {
    // docs/privacy-guard.md "Two query guards": bare brand names and generic
    // terms (bank/login/auth) are URL-guard terms only. The stricter guard
    // still applies to URL-shaped queries and to result pages.
    expect(BRIDGE_ARG_VALIDATORS.semantic_search({ query: "chase" })).toEqual({ query: "chase" });
    const results = await handleSemanticSearch({ query: "chase", limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});
