import { db, getRetentionCutoff } from "./db";

export type BrowserMemorySearchResult = {
  url: string;
  title: string;
  excerpt: string;
  parsedAt: number;
  score: number;
  /** Opaque, browser-resolvable reference to this memory. See `memoryHandle`. */
  handle: string;
};
export type BridgeMemorySearchResult = Pick<BrowserMemorySearchResult, "parsedAt" | "score" | "handle">;

const HANDLE_PREFIX = "mem_";

/**
 * An opaque reference an agent can act on without ever seeing what it points at.
 *
 * Derived from the local `page_text` autoincrement id, deliberately *not* from the
 * URL: a hash of the URL would still be a deterministic function of it, so anyone
 * holding a list of candidate URLs could confirm which the user had visited. A local
 * row id is not derivable from content in either direction, and only this browser
 * profile can resolve it back to a page.
 */
export function memoryHandle(pageTextId: number): string {
  return `${HANDLE_PREFIX}${pageTextId}`;
}

export function parseMemoryHandle(handle: string): number | null {
  if (!handle.startsWith(HANDLE_PREFIX)) return null;
  const id = Number(handle.slice(HANDLE_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Shared search implementation for the browser service worker and MCP fallback.
 * It reads the caller's IndexedDB instance; the native bridge therefore reaches
 * the extension's real database rather than the CLI's fake-indexeddb singleton.
 */
export async function searchBrowserMemory(query: string, limit = 10): Promise<BrowserMemorySearchResult[]> {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return [];
  const cutoff = getRetentionCutoff();
  const pageTexts = await db.page_text.toArray();
  const results: BrowserMemorySearchResult[] = [];
  for (const page of pageTexts) {
    if (page.parsedAt < cutoff) continue;
    const titleMatch = page.title.toLowerCase().includes(queryLower);
    const urlMatch = page.url.toLowerCase().includes(queryLower);
    const excerptMatch = (page.excerpt || "").toLowerCase().includes(queryLower);
    const textMatch = page.textContent.toLowerCase().includes(queryLower);
    if (titleMatch || urlMatch || excerptMatch || textMatch) {
      results.push({
        url: page.url,
        title: page.title,
        excerpt: page.excerpt || `${page.textContent.substring(0, 150)}...`,
        parsedAt: page.parsedAt,
        // urlMatch was counted for inclusion but omitted from the sum, so a
        // URL-only hit entered the list scoring 0 and sorted below every other
        // match — including ones the caller cares about less.
        score:
          (titleMatch ? 3 : 0) + (excerptMatch ? 2 : 0) + (textMatch ? 1 : 0) + (urlMatch ? 1 : 0),
        handle: page.id !== undefined ? memoryHandle(page.id) : "",
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
