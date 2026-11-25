/**
 * The one definition of what the content script sends the service worker about
 * a page visit.
 *
 * It lives in its own module because the two sides used to disagree silently:
 * the tracker sent `dwellDurationMs` / `capturedAt` while the worker read
 * `dwellTime` / `timestamp` / `byline` / `siteName`. Nothing failed — the
 * worker fell back to a 5000 ms dwell and its own receive time, and every
 * stored site name and byline was empty. Both sides now build and read the
 * payload through this file, so a renamed field is a type error on one side
 * and a `null` from the reader on the other, not a quiet default.
 *
 * No Dexie or chrome imports: the content bundle includes this module.
 */

import { sanitizeCapturedText } from "../content/privacy";

export const DWELL_RECORD = "DWELL_RECORD";
export const DWELL_UPDATE = "DWELL_UPDATE";

export const CONTENT_KINDS = ["video", "article", "page"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Sent once per page visit, after the dwell threshold. */
export interface DwellRecordPayload {
  /** Sanitized page URL. Together with `capturedAt` it identifies the visit. */
  url: string;
  title: string;
  excerpt: string;
  textContent: string;
  /** Cumulative visible, focused milliseconds on this page so far. */
  dwellDurationMs: number;
  /** Epoch ms of the capture. Stable for the life of the visit. */
  capturedAt: number;
  /** Epoch ms the page first came to the foreground. Stable for the visit. */
  visitStartedAt: number;
  siteName: string;
  byline: string;
  contentKind: ContentKind;
}

/**
 * Sent after the record, whenever the page leaves the foreground, unloads or
 * its SPA URL changes. Carries no page text and no title: the worker looks the
 * visit up by `url` + `capturedAt`.
 */
export interface DwellUpdatePayload {
  url: string;
  capturedAt: number;
  visitStartedAt: number;
  /** Cumulative, never a delta, so a lost or reordered update cannot corrupt the total. */
  dwellDurationMs: number;
}

export type DwellRecordMessage = { type: typeof DWELL_RECORD; payload: DwellRecordPayload };
export type DwellUpdateMessage = { type: typeof DWELL_UPDATE; payload: DwellUpdatePayload };
export type DwellMessage = DwellRecordMessage | DwellUpdateMessage;

function sanitizeDwellText(payload: DwellRecordPayload): DwellRecordPayload {
  return {
    ...payload,
    title: sanitizeCapturedText(payload.title),
    excerpt: sanitizeCapturedText(payload.excerpt),
    textContent: sanitizeCapturedText(payload.textContent).slice(0, 2000),
    siteName: sanitizeCapturedText(payload.siteName),
    byline: sanitizeCapturedText(payload.byline)
  };
}

export function dwellRecordMessage(payload: DwellRecordPayload): DwellRecordMessage {
  return { type: DWELL_RECORD, payload: sanitizeDwellText(payload) };
}

export function dwellUpdateMessage(payload: DwellUpdatePayload): DwellUpdateMessage {
  return { type: DWELL_UPDATE, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The visit start, or `capturedAt` when it is missing or implausible.
 *
 * The fallback must not depend on anything that changes during a visit (the
 * dwell does): the record and every later update have to resolve to the same
 * value, because downstream consumers key on it.
 */
function readVisitStart(raw: unknown, capturedAt: number): number {
  const visitStartedAt = positiveFinite(raw);
  return visitStartedAt !== null && visitStartedAt <= capturedAt ? visitStartedAt : capturedAt;
}

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === "string" && (CONTENT_KINDS as readonly string[]).includes(value);
}

/**
 * Reads a DWELL_RECORD payload on the worker side.
 *
 * The visit identity (`url`, `capturedAt`) and the dwell are required: a
 * payload without them is rejected (`null`) rather than defaulted, because a
 * defaulted dwell or timestamp is exactly the defect this module exists to
 * prevent. The descriptive fields are optional so a content script injected by
 * the previous build keeps working until its tab reloads.
 */
export function readDwellRecordPayload(raw: unknown): DwellRecordPayload | null {
  if (!isRecord(raw)) return null;
  const url = text(raw.url);
  const capturedAt = positiveFinite(raw.capturedAt);
  const dwellDurationMs = nonNegativeFinite(raw.dwellDurationMs);
  if (!url || capturedAt === null || dwellDurationMs === null) return null;
  return sanitizeDwellText({
    url,
    title: text(raw.title),
    excerpt: text(raw.excerpt),
    textContent: text(raw.textContent),
    dwellDurationMs,
    capturedAt,
    visitStartedAt: readVisitStart(raw.visitStartedAt, capturedAt),
    siteName: text(raw.siteName),
    byline: text(raw.byline),
    contentKind: isContentKind(raw.contentKind) ? raw.contentKind : "page"
  });
}

export function readDwellUpdatePayload(raw: unknown): DwellUpdatePayload | null {
  if (!isRecord(raw)) return null;
  const url = text(raw.url);
  const capturedAt = positiveFinite(raw.capturedAt);
  const dwellDurationMs = nonNegativeFinite(raw.dwellDurationMs);
  if (!url || capturedAt === null || dwellDurationMs === null) return null;
  return {
    url,
    capturedAt,
    visitStartedAt: readVisitStart(raw.visitStartedAt, capturedAt),
    dwellDurationMs
  };
}
