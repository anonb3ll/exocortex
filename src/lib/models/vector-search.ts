/**
 * Two-Stage Coarse-to-Fine Hybrid Vector Search Optimization
 * Spec Section 3.4 & Task #166
 */
import { db, getRetentionMaxAgeDays, type FrameRecord, type EmbeddingRecord } from "../db";

/**
 * How a result's similarity term was actually derived.
 *
 * `vector` is a real MiniLM cosine similarity. `lexical` is token overlap against
 * the candidate's title/url/summary — useful for ranking, but it is not semantic and
 * will never retrieve a paraphrase. The distinction used to be invisible: with no
 * query vector the code assigned a flat `sim = 0.7` into a field named
 * `cosineSimilarity`, so a search that had done no vector work at all reported a
 * confident-looking similarity score for every hit.
 */
export type MatchKind = 'vector' | 'lexical';

export interface VectorSearchResult {
  frameId: number;
  url: string;
  title: string;
  domain?: string;
  category?: string;
  summary?: string;
  sourceType?: 'web' | 'pdf' | 'desktop_window';
  dwellTime?: number;
  timestamp: number;
  /** Page metadata captured with the frame, when known. Never sent over the bridge. */
  siteName?: string;
  byline?: string;
  contentKind?: 'video' | 'article' | 'page';
  matchKind: MatchKind;
  /** Real cosine similarity, or null when this result was matched lexically. */
  cosineSimilarity: number | null;
  /** Token-overlap score in [0,1]; 0 when the result was matched by vector. */
  lexicalScore: number;
  recencyScore: number;
  dwellScore: number;
  /**
   * Blended relevance. Comparable only *within* a `matchKind` — a lexical 0.9 and a
   * vector 0.6 are not the same quality of evidence. Ordering across kinds is handled
   * by ranking, not by this number; see VECTOR_RELEVANCE_FLOOR.
   */
  score: number;
}

/** Ranking tier, stripped before results are returned. 1 = relevant vector match. */
type TieredResult = VectorSearchResult & { tier: number };

/**
 * Minimum cosine similarity at which a vector match is preferred over lexical ones.
 *
 * A cosine of 0.1 is a real number and still a bad match, so a frame does not get to
 * outrank a strong keyword hit merely by *having* an embedding. Above this it is a
 * genuine semantic hit and should win; below it, it competes on the blended score
 * like any lexical result.
 */
export const VECTOR_RELEVANCE_FLOOR = 0.35;

/**
 * Fraction of query tokens present in the candidate's indexed text, in [0,1].
 *
 * Compares whole tokens, not substrings. A substring test (`haystack.includes(token)`)
 * counts "cat" as a hit against "category" — inflating the very score this function
 * exists to state honestly, and doing it in the direction that makes lexical results
 * look better than they are.
 */
export function lexicalOverlap(queryText: string, haystack: string): number {
  const tokens = queryText.toLowerCase().split(/\W+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const targetTokens = new Set(haystack.toLowerCase().split(/\W+/).filter(Boolean));
  let hits = 0;
  for (const token of tokens) {
    if (targetTokens.has(token)) hits += 1;
  }
  return hits / tokens.length;
}

/** Everything about a frame that a typed query may match lexically. */
function lexicalHaystack(frame: FrameRecord): string {
  return [frame.title, frame.url, frame.summary, frame.siteName, frame.byline].filter(Boolean).join(" ");
}

/**
 * Computes dot-product cosine similarity over normalized 384-d vectors
 */
export function cosineSimilarity(
  u: Float32Array | number[],
  v: Float32Array | number[]
): number {
  if (!u || !v || u.length !== v.length || u.length === 0) return 0.0;
  let dot = 0.0;
  let normU = 0.0;
  let normV = 0.0;

  for (let i = 0; i < u.length; i++) {
    dot += u[i] * v[i];
    normU += u[i] * u[i];
    normV += v[i] * v[i];
  }

  if (normU === 0 || normV === 0) return 0.0;
  return dot / (Math.sqrt(normU) * Math.sqrt(normV));
}

/**
 * Two-Stage Coarse-to-Fine Search
 */
export async function hybridVectorSearch(params: {
  queryVector?: number[] | Float32Array;
  queryText?: string;
  category?: string;
  sourceType?: 'web' | 'pdf' | 'desktop_window';
  maxAgeDays?: number;
  limit?: number;
  minScore?: number;
}): Promise<VectorSearchResult[]> {
  const {
    queryVector,
    queryText,
    category,
    sourceType,
    maxAgeDays = getRetentionMaxAgeDays(),
    limit = 10,
    minScore = 0.0
  } = params;

  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;

  // --- STAGE 1: IndexedDB Candidate Filter (N <= 200) ---
  let candidateFrames: FrameRecord[] = [];

  if (category) {
    candidateFrames = await db.frames
      .where("category")
      .equals(category)
      .and((f) => f.timestamp >= cutoff)
      .limit(200)
      .toArray();
  } else {
    candidateFrames = await db.frames
      .where("timestamp")
      .above(cutoff)
      .reverse()
      .limit(200)
      .toArray();
  }

  // Filter by optional sourceType if specified
  if (sourceType) {
    candidateFrames = candidateFrames.filter((f) => f.sourceType === sourceType);
  }

  // If candidate count is zero in new `frames` table, fall back to `dwell_blocks`.
  //
  // These carry dwell_blocks primary keys, which come from a *different*
  // autoincrement sequence than `frames`. Reusing them as frame ids and looking
  // them up in `embeddings.frameId` attached whatever unrelated record happened to
  // share the number, so a fallback search could rescore a page against another
  // page's embedding. They are tracked separately and never joined to embeddings.
  let candidatesAreDwellBlocks = false;
  if (candidateFrames.length === 0 && !sourceType) {
    const dwellBlocks = await db.dwell_blocks
      .where("timestamp")
      .above(cutoff)
      .reverse()
      .limit(200)
      .toArray();

    candidatesAreDwellBlocks = true;
    candidateFrames = dwellBlocks.map((b) => ({
      id: b.id,
      url: b.url,
      title: b.title,
      dwellTime: Math.round(b.dwellTime / 1000),
      timestamp: b.timestamp,
      sourceType: "web"
    }));
  }

  if (candidateFrames.length === 0) return [];

  // Narrow by text substring — but ONLY when there is no query vector to rescore with.
  //
  // This filter is lexical, and it runs before stage 2. With a query vector present it
  // was actively defeating the feature: as soon as any one candidate's title contained
  // the query substring, every paraphrase was discarded here and never reached cosine
  // rescoring at all. A semantic search that can only return literal substring matches
  // is not a semantic search, and the ranking fix downstream cannot repair a candidate
  // set that never contained the right answer.
  //
  // With a vector, the whole recency-bounded candidate set goes to stage 2 and cosine
  // decides. Without one, this narrowing is the only signal available and stays.
  //
  // And without one, a query that matches nothing returns nothing. This used to fall
  // through with the full candidate set when no candidate contained the query: a
  // search for a word the user had never read came back with their 200 most recent
  // pages, ranked by recency and dwell and labelled as matches. A typed query with no
  // lexical hit and no vector to rescore with has no evidence for any result.
  let filteredCandidates = candidateFrames;
  if (!queryVector && queryText && queryText.trim()) {
    const qLower = queryText.toLowerCase().trim();
    const phraseMatches = candidateFrames.filter((f) => lexicalHaystack(f).toLowerCase().includes(qLower));
    // A multi-word query rarely appears verbatim; any shared whole token still counts.
    filteredCandidates =
      phraseMatches.length > 0
        ? phraseMatches
        : candidateFrames.filter((f) => lexicalOverlap(queryText, lexicalHaystack(f)) > 0);
    if (filteredCandidates.length === 0) return [];
  }

  // Map frame IDs to candidate objects
  const candidateMap = new Map<number, FrameRecord>();
  for (const c of filteredCandidates) {
    if (c.id !== undefined) candidateMap.set(c.id, c);
  }

  // Fetch embeddings for candidate IDs. Skipped entirely for dwell_blocks
  // candidates, whose ids do not address this table (see above).
  const candidateIds = Array.from(candidateMap.keys());
  const embeddingRecords: EmbeddingRecord[] = candidatesAreDwellBlocks
    ? []
    : await db.embeddings.where("frameId").anyOf(candidateIds).toArray();

  const embeddingMap = new Map<number, Float32Array>();
  for (const emb of embeddingRecords) {
    // Only a vector we can positively identify as a model embedding is trusted for
    // cosine rescoring. Note this is `!== "model"`, not `=== "fallback"`: rows
    // written before `source` existed have `source === undefined`, and an
    // `=== "fallback"` test would wave every one of them through as if it were a
    // real embedding. Those legacy rows are disproportionately the empty and
    // fallback vectors produced while chrome.offscreen was undefined — excluding
    // the provably-bad while admitting the unknown is backwards. Untrusted vectors
    // fall through to lexical matching. (db.ts v7 also stamps them at rest; this
    // filter is the belt to that migration's braces.)
    if (emb.source !== "model") continue;
    embeddingMap.set(emb.frameId, emb.vector);
  }

  // Convert queryVector to Float32Array if needed
  let qVec: Float32Array | null = null;
  if (queryVector) {
    qVec = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
  }

  // --- STAGE 2: Vector Rescore & Hybrid Ranking ---
  const results: TieredResult[] = [];

  const wVector = 0.6;
  const wRecency = 0.25;
  const wDwell = 0.15;

  const retentionWindowMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (const [frameId, frame] of candidateMap.entries()) {
    const vector = embeddingMap.get(frameId);

    // A result is a vector match only when a real query vector met a real stored
    // embedding of the same width. Everything else is lexical, and says so.
    const isVectorMatch = Boolean(qVec && vector && qVec.length === vector.length);
    const cosine = isVectorMatch ? Math.max(0.0, cosineSimilarity(qVec!, vector!)) : null;
    const lexical = isVectorMatch || !queryText
      ? 0
      : lexicalOverlap(queryText, lexicalHaystack(frame));

    const matchKind: MatchKind = isVectorMatch ? "vector" : "lexical";
    const sim = isVectorMatch ? cosine! : lexical;

    const deltaDays = Math.max(0, (now - frame.timestamp) / retentionWindowMs);
    const recencyScore = Math.pow(2, -deltaDays); // 2^(-t / retention)
    const dwellSeconds = frame.dwellTime || 5;
    const dwellScore = Math.min(1.0, dwellSeconds / 60.0);

    const score = wVector * sim + wRecency * recencyScore + wDwell * dwellScore;
    // A vector match only earns precedence if it is actually a good match. See
    // VECTOR_RELEVANCE_FLOOR: without the floor, any frame that merely happens to
    // have an embedding would outrank a perfect keyword hit.
    const tier = isVectorMatch && cosine! >= VECTOR_RELEVANCE_FLOOR ? 1 : 0;

    if (score >= minScore) {
      results.push({
        frameId,
        url: frame.url,
        title: frame.title,
        domain: frame.domain,
        category: frame.category,
        summary: frame.summary,
        sourceType: frame.sourceType,
        dwellTime: frame.dwellTime,
        timestamp: frame.timestamp,
        siteName: frame.siteName,
        byline: frame.byline,
        contentKind: frame.contentKind,
        matchKind,
        cosineSimilarity: cosine === null ? null : Number(cosine.toFixed(4)),
        lexicalScore: Number(lexical.toFixed(4)),
        recencyScore: Number(recencyScore.toFixed(4)),
        dwellScore: Number(dwellScore.toFixed(4)),
        score: Number(score.toFixed(4)),
        tier
      });
    }
  }

  // Rank by tier first, then by score within the tier.
  //
  // `sim` feeds `wVector * sim` at one weight, but the two match kinds do not
  // produce comparable numbers: full lexical overlap is 1.0 by construction, while
  // a genuine paraphrase — the case semantic search exists for — lands around
  // 0.5-0.7 cosine. Ranking them on the raw blend meant keyword hits systematically
  // beat semantic ones in any mixed candidate set, which is precisely backwards for
  // the feature. Tiering fixes the ordering; the floor stops it overcorrecting into
  // "any embedding beats every keyword".
  return results
    .sort((a, b) => (b.tier - a.tier) || (b.score - a.score))
    .slice(0, limit)
    .map(({ tier: _tier, ...result }) => result);
}
