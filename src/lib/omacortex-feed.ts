/**
 * Optional feed of page visits to omaCortex, the OS-level activity recorder.
 *
 * Off by default. When the user turns it on, each visit that already passed
 * capture consent and the privacy guard is also sent to omaCortex's native
 * messaging host as one small message: where, what it was called, who made it,
 * and for how long. No page text, excerpt, embedding or search query is ever
 * part of a message — `buildOmacortexPageMessage` is the only place a message
 * is assembled, and it has no parameter that could carry one.
 *
 * Wire contract, version 1 (`docs/omacortex-feed.md`):
 *   page    → { v, type: "page", source: "exocortex", url, title, site?, author?,
 *               content?, seconds, at }
 *   reply   ← { ok: true, stored, recording, reason?, version } | { ok: false, error }
 *   status  → { v, type: "status" }
 *   reply   ← { ok: true, consent, paused, recording, version }
 *
 * The host upserts on (url, at), so both are derived only from values that are
 * fixed for the life of a visit.
 */
import { sanitizeCaptureUrl, sanitizeCapturedText } from "../content/privacy";
import type { ContentKind } from "./dwell-message";
import { isContentKind } from "./dwell-message";
import { hostMatchesDomain } from "./host-match";

export const OMACORTEX_NATIVE_HOST = "io.github.anonb3ll.omacortex";
export const OMACORTEX_FEED_STORAGE_KEY = "exocortexOmacortexFeed";
export const OMACORTEX_PROTOCOL_VERSION = 1;
export const MAX_FEED_TITLE_LENGTH = 300;
export const MAX_FEED_SITE_LENGTH = 100;
export const MAX_FEED_AUTHOR_LENGTH = 120;
/** After the host fails to answer, nothing is sent for this long. */
export const FEED_UNAVAILABLE_BACKOFF_MS = 5 * 60 * 1000;

export interface OmacortexPageMessage {
  v: typeof OMACORTEX_PROTOCOL_VERSION;
  type: "page";
  source: "exocortex";
  url: string;
  title: string;
  site?: string;
  author?: string;
  content?: ContentKind;
  /** Cumulative foreground dwell for the visit, in seconds. */
  seconds: number;
  /** Visit start, epoch seconds. Identical on every update for the visit. */
  at: number;
}

export interface OmacortexStatusMessage {
  v: typeof OMACORTEX_PROTOCOL_VERSION;
  type: "status";
}

export interface FeedVisitInput {
  url: string;
  title: string;
  siteName?: string;
  byline?: string;
  contentKind?: string;
  dwellMs: number;
  visitStartedAtMs: number;
}

function clip(value: string | undefined, max: number): string {
  // A dwell update can recover metadata written before capture-time scrubbing.
  const collapsed = sanitizeCapturedText(value ?? "").replace(/\s+/g, " ").trim();
  // Cut on code points so a clipped title never ends in half a surrogate pair.
  const points = Array.from(collapsed);
  return points.length > max ? points.slice(0, max).join("").trim() : collapsed;
}

/**
 * The URL as omaCortex receives it: http(s) only, no credentials, no query
 * string and no fragment — except the `v` parameter of a YouTube watch URL,
 * which *is* the page. Returns null for anything that must not be sent,
 * including every URL the privacy guard blocks.
 */
export function minimizeFeedUrl(rawUrl: string): string | null {
  const cleanUrl = sanitizeCaptureUrl(rawUrl);
  if (!cleanUrl) return null;
  const parsed = new URL(cleanUrl);

  let query = "";
  if (hostMatchesDomain(parsed.hostname, "youtube.com") && parsed.pathname === "/watch") {
    const videoId = parsed.searchParams.get("v");
    if (videoId && /^[A-Za-z0-9_-]{1,32}$/.test(videoId)) query = `?v=${videoId}`;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`;
}

/** Builds the one message sent per visit update, or null when the visit must not be sent. */
export function buildOmacortexPageMessage(input: FeedVisitInput): OmacortexPageMessage | null {
  const url = minimizeFeedUrl(input.url);
  if (!url) return null;
  if (!Number.isFinite(input.visitStartedAtMs) || input.visitStartedAtMs <= 0) return null;
  if (!Number.isFinite(input.dwellMs) || input.dwellMs < 0) return null;

  const title = clip(input.title, MAX_FEED_TITLE_LENGTH) || new URL(url).hostname;
  const message: OmacortexPageMessage = {
    v: OMACORTEX_PROTOCOL_VERSION,
    type: "page",
    source: "exocortex",
    url,
    title,
    seconds: Math.round(input.dwellMs / 100) / 10,
    at: input.visitStartedAtMs / 1000
  };
  const site = clip(input.siteName, MAX_FEED_SITE_LENGTH);
  if (site) message.site = site;
  const author = clip(input.byline, MAX_FEED_AUTHOR_LENGTH);
  if (author) message.author = author;
  if (isContentKind(input.contentKind)) message.content = input.contentKind;
  return message;
}

export function buildOmacortexStatusMessage(): OmacortexStatusMessage {
  return { v: OMACORTEX_PROTOCOL_VERSION, type: "status" };
}

/** Sends one message to a native host. Rejects when the host is missing or does not answer. */
export type NativeSend = (host: string, message: unknown) => Promise<unknown>;

/**
 * `chrome.runtime.sendNativeMessage` as a promise. `lastError` is always read,
 * so a missing host never surfaces as an unchecked runtime error.
 */
export const chromeNativeSend: NativeSend = (host, message) =>
  new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(host, message as object, (reply: unknown) => {
        const error = chrome.runtime.lastError?.message;
        if (error) reject(new Error(error));
        else resolve(reply);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("native messaging unavailable"));
    }
  });

export type FeedSendResult =
  | { status: "stored" }
  | { status: "not_stored"; reason: string }
  | { status: "rejected"; error: string }
  | { status: "unavailable" }
  | { status: "skipped"; reason: "disabled" | "not_sendable" | "backoff" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface OmacortexFeedOptions {
  send: NativeSend;
  /** Re-evaluated for every visit: the feed toggle and capture consent, both on. */
  isEnabled(): boolean | Promise<boolean>;
  now?(): number;
  backoffMs?: number;
}

/**
 * The sender the service worker holds.
 *
 * A host that is missing or does not answer is the expected state for anyone
 * who has not installed omaCortex. It is handled without a log line and
 * without a retry: the failed message is dropped, and nothing more is sent
 * until the backoff has passed. The next visit after that is the retry.
 */
export function createOmacortexFeed(options: OmacortexFeedOptions): {
  sendVisit(input: FeedVisitInput): Promise<FeedSendResult>;
  resetBackoff(): void;
} {
  const now = options.now ?? (() => Date.now());
  const backoffMs = options.backoffMs ?? FEED_UNAVAILABLE_BACKOFF_MS;
  let unavailableUntil = 0;

  return {
    resetBackoff() {
      unavailableUntil = 0;
    },
    async sendVisit(input) {
      if (!(await options.isEnabled())) return { status: "skipped", reason: "disabled" };
      if (now() < unavailableUntil) return { status: "skipped", reason: "backoff" };
      const message = buildOmacortexPageMessage(input);
      if (!message) return { status: "skipped", reason: "not_sendable" };

      let reply: unknown;
      try {
        reply = await options.send(OMACORTEX_NATIVE_HOST, message);
      } catch {
        unavailableUntil = now() + backoffMs;
        return { status: "unavailable" };
      }
      if (!isRecord(reply)) return { status: "rejected", error: "malformed reply" };
      if (reply.ok !== true) {
        return { status: "rejected", error: typeof reply.error === "string" ? reply.error : "rejected" };
      }
      // `stored: false` is a normal answer — omaCortex is paused, the page is
      // excluded there, or the visit is too short to keep.
      if (reply.stored === true) return { status: "stored" };
      return { status: "not_stored", reason: typeof reply.reason === "string" ? reply.reason : "not stored" };
    }
  };
}

export type OmacortexLinkState = "connected" | "recording_off" | "paused" | "not_installed" | "error";

export interface OmacortexLinkStatus {
  state: OmacortexLinkState;
  version?: string;
}

/** One status probe. Never throws and never retries. */
export async function probeOmacortexStatus(send: NativeSend): Promise<OmacortexLinkStatus> {
  let reply: unknown;
  try {
    reply = await send(OMACORTEX_NATIVE_HOST, buildOmacortexStatusMessage());
  } catch {
    return { state: "not_installed" };
  }
  if (!isRecord(reply) || reply.ok !== true) return { state: "error" };
  const version = typeof reply.version === "string" ? reply.version.slice(0, 32) : undefined;
  if (reply.paused === true) return { state: "paused", version };
  if (reply.recording === true) return { state: "connected", version };
  return { state: "recording_off", version };
}

/** The label shown next to the side-panel toggle. */
export function describeOmacortexStatus(status: OmacortexLinkStatus): string {
  switch (status.state) {
    case "connected":
      return "connected";
    case "paused":
      return "paused";
    case "recording_off":
      return "connected, recording off";
    case "not_installed":
      return "not installed";
    default:
      return "not responding";
  }
}
