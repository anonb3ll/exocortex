/**
 * Worker-side storage for a page visit's dwell.
 *
 * A visit is identified by its sanitized URL plus the `capturedAt` the content
 * script stamped on the initial record. Every row the worker writes for the
 * visit carries that timestamp, so a later dwell update can find and raise
 * them without a visit id column or a schema change.
 */
import { db, type FrameRecord } from "./db";
import type { ContextCaptureInput } from "./context-workflow";
import type { ContentKind, DwellRecordPayload } from "./dwell-message";
import { displayHost, hostnameOf } from "./host-match";

export const UNTITLED_PAGE = "Untitled Page";

export interface VisitMeta {
  title: string;
  siteName: string;
  byline: string;
  contentKind: ContentKind;
}

export function visitKey(url: string, capturedAt: number): string {
  return `${capturedAt}|${url}`;
}

/** Maps a DWELL_RECORD payload onto the capture workflow's input, field for field. */
export function captureInputFromDwell(
  payload: DwellRecordPayload,
  cleanUrl: string,
  sessionId?: string
): ContextCaptureInput {
  return {
    sessionId,
    url: cleanUrl,
    title: payload.title || UNTITLED_PAGE,
    byline: payload.byline,
    excerpt: payload.excerpt,
    textContent: payload.textContent,
    siteName: payload.siteName,
    timestamp: payload.capturedAt,
    dwellTime: payload.dwellDurationMs
  };
}

export function visitMetaFromDwell(payload: DwellRecordPayload, cleanUrl: string): VisitMeta {
  return {
    title: payload.title || UNTITLED_PAGE,
    siteName: payload.siteName || displayHost(hostnameOf(cleanUrl)),
    byline: payload.byline,
    contentKind: payload.contentKind
  };
}

/**
 * In-memory record of the visits this worker instance has seen.
 *
 * It exists for one race: a dwell update can arrive while the initial record
 * is still being embedded, before its `frames` row exists. The update is noted
 * here, and the record pipeline reads the latest total back when it writes.
 * Losing the ledger to an MV3 worker restart is harmless — by then the rows
 * exist and updates go straight to the database.
 */
export class VisitLedger {
  private readonly visits = new Map<string, { dwellMs: number; meta?: VisitMeta }>();

  constructor(private readonly maxEntries = 200) {}

  /** Records `dwellMs` if it is the largest seen for the visit; returns the largest. */
  noteDwell(key: string, dwellMs: number): number {
    const existing = this.visits.get(key);
    if (existing) {
      if (dwellMs > existing.dwellMs) existing.dwellMs = dwellMs;
      return existing.dwellMs;
    }
    this.visits.set(key, { dwellMs });
    if (this.visits.size > this.maxEntries) {
      const oldest = this.visits.keys().next().value;
      if (oldest !== undefined) this.visits.delete(oldest);
    }
    return dwellMs;
  }

  dwellMs(key: string): number | undefined {
    return this.visits.get(key)?.dwellMs;
  }

  setMeta(key: string, meta: VisitMeta): void {
    const existing = this.visits.get(key);
    if (existing) existing.meta = meta;
  }

  meta(key: string): VisitMeta | undefined {
    return this.visits.get(key)?.meta;
  }
}

export interface VisitDwellUpdate {
  url: string;
  capturedAt: number;
  dwellDurationMs: number;
}

/**
 * Raises the stored dwell on every row written for the visit. Dwell only ever
 * grows: a late or reordered update with a smaller total changes nothing.
 */
export async function applyVisitDwell(
  update: VisitDwellUpdate
): Promise<{ dwellBlocks: number; frames: number; cognitiveFrames: number }> {
  const { url, capturedAt, dwellDurationMs } = update;
  const seconds = Math.round(dwellDurationMs / 1000);

  const dwellBlocks = await db.dwell_blocks
    .where("timestamp")
    .equals(capturedAt)
    .filter((block) => block.url === url && (block.dwellTime || 0) < dwellDurationMs)
    .modify({ dwellTime: dwellDurationMs });

  const frames = await db.frames
    .where("timestamp")
    .equals(capturedAt)
    .filter((frame) => frame.url === url && (frame.dwellTime || 0) < seconds)
    .modify({ dwellTime: seconds });

  const cognitiveFrames = await db.cognitive_frames
    .where("timestampUtc")
    .equals(capturedAt)
    .filter((frame) => frame.provenance.url === url && (frame.provenance.activeDwellSeconds || 0) < seconds)
    .modify((frame) => {
      frame.provenance.activeDwellSeconds = seconds;
    });

  return { dwellBlocks, frames, cognitiveFrames };
}

/**
 * Looks a visit up in the database, for a worker that restarted since the
 * record. Returns null when no row exists — the visit was never captured (or
 * was pruned), so there is nothing to describe.
 */
export async function findVisitMeta(url: string, capturedAt: number): Promise<VisitMeta | null> {
  const frame: FrameRecord | undefined = await db.frames
    .where("timestamp")
    .equals(capturedAt)
    .filter((row) => row.url === url)
    .first();
  if (frame) {
    return {
      title: frame.title || UNTITLED_PAGE,
      siteName: frame.siteName || frame.domain || displayHost(hostnameOf(url)),
      byline: frame.byline || "",
      contentKind: frame.contentKind || "page"
    };
  }
  const block = await db.dwell_blocks
    .where("timestamp")
    .equals(capturedAt)
    .filter((row) => row.url === url)
    .first();
  if (!block) return null;
  return {
    title: block.title || UNTITLED_PAGE,
    siteName: displayHost(hostnameOf(url)),
    byline: "",
    contentKind: "page"
  };
}
