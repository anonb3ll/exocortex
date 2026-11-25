/**
 * Page metadata for recall: site name, author and a coarse content kind.
 *
 * Everything here is read from what the page declares about itself — `<meta>`
 * tags, JSON-LD and, on YouTube watch pages, the channel-name element. No body
 * text is read; the only page text the extension captures is still the
 * Readability extract the tracker already takes.
 *
 * The document is typed structurally so this module can be unit-tested without
 * a DOM, and every lookup is guarded: a page with broken markup must still be
 * captured, just with less metadata.
 */
import type { ContentKind } from "../lib/dwell-message";
import { displayHost, hostMatchesAny, hostnameOf } from "../lib/host-match";

export interface MetaElementLike {
  getAttribute(name: string): string | null;
  textContent?: string | null;
}

export interface MetaDocumentLike {
  querySelector?(selector: string): MetaElementLike | null;
  querySelectorAll?(selector: string): ArrayLike<MetaElementLike>;
}

export interface PageMetadata {
  siteName: string;
  byline: string;
  contentKind: ContentKind;
}

export const MAX_SITE_NAME_LENGTH = 100;
export const MAX_BYLINE_LENGTH = 120;
const MAX_JSON_LD_SCRIPTS = 8;
const MAX_JSON_LD_CHARS = 200_000;

const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com"] as const;
const VIDEO_DOMAINS = ["vimeo.com", "twitch.tv", "dailymotion.com"] as const;
const ARTICLE_DOMAINS = ["substack.com", "medium.com"] as const;

const VIDEO_LD_TYPES = new Set(["videoobject", "movie", "tvepisode", "clip", "broadcastevent"]);
const ARTICLE_LD_TYPES = new Set([
  "article",
  "newsarticle",
  "blogposting",
  "techarticle",
  "scholarlyarticle",
  "report",
  "opinionnewsarticle",
  "analysisnewsarticle",
  "reportagenewsarticle",
  "reviewnewsarticle",
  "liveblogposting"
]);

function squash(value: string | null | undefined, max: number): string {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
}

function looksLikeUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^www\./i.test(value);
}

/** A person or channel name, or "" when the value is empty or is a URL. */
export function cleanByline(value: string | null | undefined): string {
  const squashed = squash(value, 400);
  if (!squashed || looksLikeUrl(squashed)) return "";
  return squash(squashed.replace(/^by[:\s]+/i, ""), MAX_BYLINE_LENGTH);
}

function firstElement(doc: MetaDocumentLike, selector: string): MetaElementLike | null {
  if (typeof doc.querySelector !== "function") return null;
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

function metaContent(doc: MetaDocumentLike, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const content = firstElement(doc, selector)?.getAttribute("content");
    if (content && content.trim()) return content.trim();
  }
  return "";
}

function elementText(doc: MetaDocumentLike, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const value = firstElement(doc, selector)?.textContent;
    if (value && value.trim()) return value.trim();
  }
  return "";
}

type JsonLdNode = Record<string, unknown>;

/** Flattens the JSON-LD blocks on the page into plain nodes, following `@graph`. */
export function readJsonLdNodes(doc: MetaDocumentLike): JsonLdNode[] {
  if (typeof doc.querySelectorAll !== "function") return [];
  let scripts: ArrayLike<MetaElementLike>;
  try {
    scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  } catch {
    return [];
  }
  const nodes: JsonLdNode[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || nodes.length >= 64) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as JsonLdNode;
    nodes.push(node);
    if (node["@graph"]) visit(node["@graph"], depth + 1);
  };
  for (let i = 0; i < Math.min(scripts.length, MAX_JSON_LD_SCRIPTS); i += 1) {
    const raw = scripts[i]?.textContent ?? "";
    if (!raw || raw.length > MAX_JSON_LD_CHARS) continue;
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Malformed JSON-LD is common; the page is still captured without it.
    }
  }
  return nodes;
}

function ldTypes(node: JsonLdNode): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
}

function ldAuthorName(node: JsonLdNode): string {
  const read = (value: unknown): string => {
    if (typeof value === "string") return cleanByline(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const name = read(item);
        if (name) return name;
      }
      return "";
    }
    if (value && typeof value === "object") {
      const name = (value as JsonLdNode).name;
      return typeof name === "string" ? cleanByline(name) : "";
    }
    return "";
  };
  return read(node.author);
}

/** True for a page whose main content is one YouTube video. */
export function isYouTubeWatchUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (host === "youtu.be") return true;
  if (!hostMatchesAny(host, YOUTUBE_DOMAINS)) return false;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/") || path.startsWith("/embed/");
}

function isVideoUrl(url: string): boolean {
  if (isYouTubeWatchUrl(url)) return true;
  const host = hostnameOf(url);
  if (!hostMatchesAny(host, VIDEO_DOMAINS)) return false;
  try {
    // A site's home or search page is not a video; a path under it is.
    return new URL(url).pathname.replace(/\/+$/, "").length > 0;
  } catch {
    return false;
  }
}

function isArticleUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!hostMatchesAny(host, ARTICLE_DOMAINS)) return false;
  try {
    const path = new URL(url).pathname;
    // Substack posts live under /p/; Medium posts end in a hex id.
    return path.startsWith("/p/") || /-[0-9a-f]{8,}$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * "video", "article" or "page".
 *
 * The URL is consulted first because single-page sites keep stale `og:type`
 * and JSON-LD from the page the tab was loaded on: a YouTube tab that started
 * on the home page still declares `website` after navigating to a video.
 */
export function deriveContentKind(input: { url: string; ogType?: string; ldTypes?: readonly string[] }): ContentKind {
  if (isVideoUrl(input.url)) return "video";
  if (isArticleUrl(input.url)) return "article";
  const ogType = (input.ogType || "").toLowerCase().trim();
  const types = (input.ldTypes || []).map((t) => t.toLowerCase());
  if (ogType.startsWith("video") || types.some((t) => VIDEO_LD_TYPES.has(t))) return "video";
  if (ogType === "article" || types.some((t) => ARTICLE_LD_TYPES.has(t))) return "article";
  return "page";
}

const YOUTUBE_CHANNEL_SELECTORS = [
  "ytd-watch-metadata ytd-channel-name a",
  "#owner ytd-channel-name a",
  "ytd-video-owner-renderer ytd-channel-name a"
] as const;

function youTubeChannelName(doc: MetaDocumentLike): string {
  // The rendered channel link tracks SPA navigation; the microdata does not, so
  // it is only the fallback.
  const rendered = cleanByline(elementText(doc, YOUTUBE_CHANNEL_SELECTORS));
  if (rendered) return rendered;
  return cleanByline(metaContent(doc, ['span[itemprop="author"] link[itemprop="name"]']));
}

/**
 * Collects metadata for the page at `url`.
 *
 * `readability` is what the tracker's existing Readability pass already
 * produced; it is the last resort for the byline and never widens what is read.
 */
export function collectPageMetadata(
  doc: MetaDocumentLike | null | undefined,
  url: string,
  readability?: { byline?: string | null; siteName?: string | null }
): PageMetadata {
  const host = displayHost(hostnameOf(url));
  const fallback: PageMetadata = {
    siteName: squash(readability?.siteName, MAX_SITE_NAME_LENGTH) || host,
    byline: cleanByline(readability?.byline),
    contentKind: deriveContentKind({ url })
  };
  if (!doc) return fallback;

  try {
    const nodes = readJsonLdNodes(doc);
    const types = nodes.flatMap(ldTypes);
    const contentKind = deriveContentKind({
      url,
      ogType: metaContent(doc, ['meta[property="og:type"]', 'meta[name="og:type"]']),
      ldTypes: types
    });

    const siteName =
      squash(metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="og:site_name"]']), MAX_SITE_NAME_LENGTH) ||
      fallback.siteName;

    let byline = isYouTubeWatchUrl(url) ? youTubeChannelName(doc) : "";
    if (!byline) byline = cleanByline(metaContent(doc, ['meta[name="author"]']));
    if (!byline) {
      byline = cleanByline(metaContent(doc, ['meta[property="article:author"]', 'meta[name="article:author"]']));
    }
    if (!byline) {
      for (const node of nodes) {
        byline = ldAuthorName(node);
        if (byline) break;
      }
    }
    if (!byline) byline = fallback.byline;

    return { siteName, byline, contentKind };
  } catch {
    return fallback;
  }
}
