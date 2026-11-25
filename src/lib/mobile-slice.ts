/**
 * Exocortex Mobile Thin Slice (Tasks #408, #411, #421)
 *
 * Implements the minimal, privacy-preserving mobile surface for:
 * 1. Mobile Recall: Search over sanitized metadata & opaque handles (`mem_<id>`)
 * 2. Focus Anchor & State Glance: Lightweight projection of focus, load, and state digest
 * 3. Task Reference Projection: Bidirectional linkage to `ua://task/<id>`
 * 4. Honest Status Envelopes: Explicit live / stale / offline / privacy_blocked states
 */

import { isSearchQueryBlocked, isUrlBlocked } from "../content/privacy";
export { isSearchQueryBlocked } from "../content/privacy";
import { memoryHandle, parseMemoryHandle } from "./browser-memory-search";
import {
  CONTRACT_VERSION,
  MAX_FOCUS_ENTITY_CHARS,
  MAX_STATE_DIGEST_CHARS,
  ProjectedRecord,
  FocusAnchorSource,
  projectFocusAnchor,
  projectTaskReference
} from "./projection/contract-v1";

export const MOBILE_SLICE_VERSION = "1.0";
export const MAX_RECALL_EXCERPT_CHARS = 160;
export const MAX_RECALL_TITLE_CHARS = 100;

export type MobileFreshness = "live" | "stale" | "offline";
export type MobileHealthStatus = "healthy" | "degraded" | "unavailable";
export type MobileRecallStatus = "ok" | "empty" | "privacy_blocked" | "error";

const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;

/**
 * Strips URL-like substrings from free text for mobile consumption.
 */
export function sanitizeMobileText(text: string, maxChars = 200): string {
  if (!text || typeof text !== "string") return "";
  const redacted = text.replace(URL_LIKE, "[redacted-link]").replace(/\s+/g, " ").trim();
  return redacted.length <= maxChars ? redacted : redacted.slice(0, maxChars - 1) + "…";
}

export interface MobileRecallItem {
  handle: string;
  title: string;
  excerpt: string;
  parsedAt: number;
  score: number;
}

export interface MobileRecallQueryOptions {
  limit?: number;
  minScore?: number;
}

export interface PageRecordLike {
  id?: number;
  url: string;
  title: string;
  excerpt?: string;
  textContent?: string;
  parsedAt: number;
}

export interface MobileRecallResponse {
  status: MobileRecallStatus;
  query: string;
  results: MobileRecallItem[];
  totalCount: number;
  errorMessage?: string;
}

/**
 * Pure search function over page records that returns privacy-safe mobile recall items.
 * Guaranteed to never return raw URLs or sensitive domains.
 */
export function searchMobileMemoryPure(
  query: string,
  pages: PageRecordLike[],
  options: MobileRecallQueryOptions = {}
): MobileRecallResponse {
  const queryTrimmed = (query || "").trim();
  if (!queryTrimmed) {
    return {
      status: "empty",
      query: "",
      results: [],
      totalCount: 0
    };
  }

  // If query itself contains blocked/sensitive domains or credentials, fail closed
  if (isSearchQueryBlocked(queryTrimmed)) {
    return {
      status: "privacy_blocked",
      query: "[blocked-query]",
      results: [],
      totalCount: 0,
      errorMessage: "Search query matches privacy blocklist"
    };
  }

  const queryLower = queryTrimmed.toLowerCase();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const minScore = options.minScore ?? 1;

  const matches: MobileRecallItem[] = [];

  for (const page of pages) {
    // Fail-closed privacy check: skip any sensitive or credential URLs
    if (isUrlBlocked(page.url)) {
      continue;
    }

    const titleText = page.title || "";
    const excerptText = page.excerpt || page.textContent?.slice(0, 300) || "";
    const bodyText = page.textContent || "";

    const titleHit = titleText.toLowerCase().includes(queryLower);
    const excerptHit = excerptText.toLowerCase().includes(queryLower);
    const bodyHit = bodyText.toLowerCase().includes(queryLower);

    if (titleHit || excerptHit || bodyHit) {
      const score = (titleHit ? 3 : 0) + (excerptHit ? 2 : 0) + (bodyHit ? 1 : 0);
      if (score >= minScore) {
        const pageId = page.id;
        if (typeof pageId !== "number" || !Number.isInteger(pageId) || pageId <= 0) {
          continue;
        }
        const handle = memoryHandle(pageId);
        matches.push({
          handle,
          title: sanitizeMobileText(titleText, MAX_RECALL_TITLE_CHARS),
          excerpt: sanitizeMobileText(excerptText, MAX_RECALL_EXCERPT_CHARS),
          parsedAt: page.parsedAt || Date.now(),
          score
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score || b.parsedAt - a.parsedAt);
  const sliced = matches.slice(0, limit);

  return {
    status: sliced.length > 0 ? "ok" : "empty",
    query: sanitizeMobileText(queryTrimmed, 50),
    results: sliced,
    totalCount: matches.length
  };
}

export interface MobileFocusGlance {
  contract_version: string;
  status: "live" | "stale" | "offline" | "empty";
  focusEntity: string;
  stateDigest: string;
  intentCategory: string;
  cognitiveLoadLevel: string;
  updatedAt: number;
  suggestedTaskRef: string | null;
  originRef: string;
}

/**
 * Projects a FocusAnchorSource into a mobile glanceable format.
 */
export async function projectMobileFocusGlance(
  source: FocusAnchorSource | null,
  options: {
    originMachine?: string;
    freshness?: MobileFreshness;
    suggestedTaskId?: number;
  } = {}
): Promise<MobileFocusGlance> {
  const originMachine = options.originMachine || "unknown-host";
  const freshness = options.freshness || "live";

  if (!source || !source.activeFocusEntity) {
    return {
      contract_version: MOBILE_SLICE_VERSION,
      status: "empty",
      focusEntity: "No active focus",
      stateDigest: "No active working state captured",
      intentCategory: "Idle / Transition",
      cognitiveLoadLevel: "Low",
      updatedAt: Date.now(),
      suggestedTaskRef: null,
      originRef: "0000000000000000"
    };
  }

  // Use core contract projection to guarantee canonical validation.
  //
  // `source` here is the LOCAL, full-fidelity anchor the side panel builds from the
  // stored frame — it is the user's own machine, and the glance renders in the panel.
  // The projector redacts links and clamps, but by design it cannot tell a page title
  // from an entity (`projectFocusAnchor` in contract-v1.ts trusts its caller). If this
  // glance ever leaves the device, feed it `handleGetFocusAnchor({ wireSafe: true })`
  // first: contract v1 §5 allows no page title or captured text.
  const projectedAnchor = await projectFocusAnchor(source, {
    originMachine,
    originSurface: "browser",
    trustTier: "local",
    consentBasis: "standing_local_capture",
    projectedAt: Date.now()
  });

  let taskRefStr: string | null = null;
  if (options.suggestedTaskId && options.suggestedTaskId > 0) {
    const taskProj = projectTaskReference(projectedAnchor, options.suggestedTaskId, 0.85);
    taskRefStr = String(taskProj.payload.task_ref);
  }

  return {
    contract_version: MOBILE_SLICE_VERSION,
    status: freshness,
    focusEntity: String(projectedAnchor.payload.focus_entity),
    stateDigest: String(projectedAnchor.payload.state_digest),
    intentCategory: String(projectedAnchor.payload.intent_category),
    cognitiveLoadLevel: String(projectedAnchor.payload.cognitive_load_level),
    updatedAt: projectedAnchor.provenance.captured_at,
    suggestedTaskRef: taskRefStr,
    originRef: String(projectedAnchor.payload.origin_ref)
  };
}

export interface MobileStateEnvelope {
  contract_version: string;
  projection_id: string;
  freshness: MobileFreshness;
  service_health: MobileHealthStatus;
  error_code: string | null;
  error_message: string | null;
  focus: MobileFocusGlance;
  recalls: MobileRecallItem[];
  generated_at: number;
}

/**
 * Builds the top-level mobile state envelope for Apple Watch or iPhone companion clients.
 */
export function buildMobileStateEnvelope(params: {
  focus: MobileFocusGlance;
  recalls?: MobileRecallItem[];
  freshness?: MobileFreshness;
  serviceHealth?: MobileHealthStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
}): MobileStateEnvelope {
  const generatedAt = Date.now();
  const freshness = params.freshness || "live";
  const serviceHealth = params.serviceHealth || "healthy";

  const projectionId = `exo_mob_${generatedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    contract_version: MOBILE_SLICE_VERSION,
    projection_id: projectionId,
    freshness,
    service_health: serviceHealth,
    error_code: params.errorCode || null,
    error_message: params.errorMessage ? sanitizeMobileText(params.errorMessage, 120) : null,
    focus: params.focus,
    recalls: params.recalls || [],
    generated_at: generatedAt
  };
}
