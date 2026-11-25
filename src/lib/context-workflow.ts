import { db, upsertPageText, type DwellBlockRecord } from "./db";
import { sanitizeCaptureUrl, sanitizeCapturedText } from "../content/privacy";

export interface ContextCaptureInput {
  sessionId?: string;
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  textContent?: string;
  siteName?: string;
  timestamp: number;
  dwellTime: number;
}

export interface RecalledContext {
  title: string;
  url: string;
  excerpt: string;
  capturedAt: number;
  dwellSeconds: number;
  provenance: {
    source: "local-dexie";
    url: string;
    capturedAt: number;
  };
  resumeAction: {
    type: "reopen-tab";
    url: string;
    label: "Reopen Page";
  };
}

/** Capture one local page context without crossing the extension boundary. */
export async function captureContext(input: ContextCaptureInput): Promise<boolean> {
  const cleanUrl = sanitizeCaptureUrl(input.url);
  if (!cleanUrl) return false;
  const title = sanitizeCapturedText(input.title);

  if (input.textContent) {
    await upsertPageText({
      url: cleanUrl,
      title,
      byline: input.byline === undefined ? undefined : sanitizeCapturedText(input.byline),
      excerpt: input.excerpt === undefined ? undefined : sanitizeCapturedText(input.excerpt),
      textContent: sanitizeCapturedText(input.textContent),
      siteName: input.siteName === undefined ? undefined : sanitizeCapturedText(input.siteName),
      parsedAt: input.timestamp
    });
  }

  const dwellBlock: DwellBlockRecord = {
    sessionId: input.sessionId,
    url: cleanUrl,
    title,
    timestamp: input.timestamp,
    dwellTime: input.dwellTime
  };
  await db.dwell_blocks.put(dwellBlock);
  return true;
}

/** Recall the latest local context and return a provenance-backed resume action. */
export async function recallLatestContext(): Promise<RecalledContext | null> {
  const lastBlock = await db.dwell_blocks.orderBy("timestamp").reverse().first();
  if (!lastBlock) return null;

  const pageText = await db.page_text.where("url").equals(lastBlock.url).first();
  const excerpt = pageText?.excerpt || pageText?.textContent?.substring(0, 150) || "No text excerpt available.";

  return {
    title: lastBlock.title || pageText?.title || "Untitled Page",
    url: lastBlock.url,
    excerpt,
    capturedAt: lastBlock.timestamp,
    dwellSeconds: Math.round((lastBlock.dwellTime || 0) / 1000),
    provenance: {
      source: "local-dexie",
      url: lastBlock.url,
      capturedAt: lastBlock.timestamp
    },
    resumeAction: {
      type: "reopen-tab",
      url: lastBlock.url,
      label: "Reopen Page"
    }
  };
}
