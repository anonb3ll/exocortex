import { db, type SemanticVaultRecord } from "../db";
import { cosineDistance } from "./drift-detector";

export interface VaultSearchResult {
  vaultId: string;
  url: string;
  title: string;
  excerpt: string;
  primaryFocusEntity: string;
  timestampUtc: number;
  score: number;
}

export class LibrarianAgent {
  /**
   * Indexes a page excerpt and vector embedding into the Semantic Vault.
   */
  public async indexPageExcerpt(params: {
    url: string;
    title: string;
    excerpt: string;
    primaryFocusEntity: string;
    vectorAnchor?: number[];
  }): Promise<SemanticVaultRecord> {
    const { url, title, excerpt, primaryFocusEntity, vectorAnchor } = params;

    const existing = await db.semantic_vault.where("url").equals(url).first();
    const vaultId = existing?.vaultId || `vlt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const keywords = this.extractKeywords(`${title} ${primaryFocusEntity} ${excerpt}`);

    const record: SemanticVaultRecord = {
      id: existing?.id,
      vaultId,
      timestampUtc: Date.now(),
      url,
      title: title || "Untitled Knowledge",
      excerpt: (excerpt || "").substring(0, 500),
      primaryFocusEntity: primaryFocusEntity || "Web Research",
      vectorAnchor,
      keywords
    };

    await db.semantic_vault.put(record);
    return record;
  }

  /**
   * Hybrid Search over the Semantic Vault combining keyword relevance and vector cosine distance.
   */
  public async searchSemanticVault(params: {
    query?: string;
    vectorAnchor?: number[];
    primaryFocusEntity?: string;
    limit?: number;
  }): Promise<VaultSearchResult[]> {
    const { query, vectorAnchor, primaryFocusEntity, limit = 10 } = params;
    const records = await db.semantic_vault.toArray();

    if (records.length === 0) return [];

    const queryLower = (query || "").toLowerCase().trim();
    const focusLower = (primaryFocusEntity || "").toLowerCase().trim();

    const results: VaultSearchResult[] = [];

    for (const rec of records) {
      let score = 0;

      // Keyword matching
      if (queryLower) {
        if (rec.title.toLowerCase().includes(queryLower)) score += 4;
        if (rec.primaryFocusEntity.toLowerCase().includes(queryLower)) score += 3;
        if (rec.excerpt.toLowerCase().includes(queryLower)) score += 2;
        if (rec.keywords.some((k) => k.includes(queryLower))) score += 1;
      }

      // Focus Entity match bonus
      if (focusLower && rec.primaryFocusEntity.toLowerCase().includes(focusLower)) {
        score += 3;
      }

      // Vector Cosine Similarity
      if (vectorAnchor && rec.vectorAnchor && vectorAnchor.length === rec.vectorAnchor.length) {
        const distance = cosineDistance(vectorAnchor, rec.vectorAnchor);
        const similarity = Math.max(0, 1.0 - distance);
        score += similarity * 5; // Weighted vector similarity
      }

      if (score > 0 || (!queryLower && !vectorAnchor && !focusLower)) {
        results.push({
          vaultId: rec.vaultId,
          url: rec.url,
          title: rec.title,
          excerpt: rec.excerpt,
          primaryFocusEntity: rec.primaryFocusEntity,
          timestampUtc: rec.timestampUtc,
          score: Number(score.toFixed(2))
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Helper to extract key terms for indexed search
   */
  private extractKeywords(text: string): string[] {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 15);
  }
}

export const librarianAgent = new LibrarianAgent();
