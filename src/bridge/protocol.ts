/**
 * Shared, environment-agnostic core of the native bridge protocol: request
 * types, per-type argument validation, and per-type response minimization.
 *
 * No Node built-ins here on purpose. `src/bridge/server.ts` (the Bun/Node MCP
 * process) and `src/background/native-bridge-client.ts` (the browser service
 * worker) both import this module, and only one of those runs under Node —
 * so this file stays pure TypeScript/JS, importing only types from `../lib/db`.
 *
 * Extending the bridge to a new tool (roadmap task #373, 5.2) means adding one
 * entry here (a request type, its arg validator, and — if its return shape
 * carries anything sensitive — a minimizer) plus one entry in
 * `TOOL_TO_BRIDGE_TYPE` (src/mcp/cli.ts) and `BRIDGE_BACKED_TOOLS`
 * (src/mcp/source-envelope.ts). Forgetting the last two fails loudly: a test
 * in tests/bridge-protocol.test.ts asserts all three name sets agree.
 */
import type { CognitiveStateFrame } from "../lib/db";
import { isSearchQueryBlocked } from "../content/privacy";
import {
  CAPTURED_PAGE_LABEL,
  focusEntityDerivedFromPageTitle,
  isDeviceProvenance,
  printableHost,
  safeCaptureLabel
} from "../lib/title-provenance";

/**
 * Version history:
 *   2 -> 3  the open_memory request type and the search-result contract changes
 *           (`search_memory` gained `handle`; `semantic_search` gained `matchKind`
 *           and made `cosineSimilarity` nullable).
 *   3 -> 4  the project_task_reference request type.
 *
 * The version is enforced inbound by the browser side (native-bridge-client.ts).
 * Before the 2 -> 3 bump, a newly updated MCP process could connect to an older
 * loaded extension as though they agreed: `open_memory` would be rejected as an
 * unknown type and `search_memory` would return results with no `handle`, while the
 * bridge stayed connected and its answers were still labelled `live`. Skew must fail
 * explicitly, not degrade into wrong-shaped data wearing a `live` label.
 *
 * Minimizing a field's *value* further (as `wireSafeUserState` does) is not a bump:
 * the request types and result shapes are unchanged. The same holds for a
 * minimizer that narrows a shape it alone owns: `get_working_memory_stack` used
 * to pass the stored item through whole and now answers with the title-free shape
 * (`minimizeWorkingMemoryStack`). The only consumer is the MCP CLI in this repo,
 * which reads `activeGoal`, `status` and the timestamps; it never reads the
 * removed keys (`id`, `goalDerivedFromPageTitle`, `safeGoalLabel`), and both ends
 * of the socket ship together.
 */
export const BRIDGE_PROTOCOL_VERSION = 4;

/** Fail-closed deadline for a bridged request that declares no override below. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 2_000;

/**
 * Per-request-type deadlines, for work that legitimately cannot answer in 2s.
 *
 * `semantic_search` is the one such case: the browser has to embed the query, and on
 * the first call after a cold start that means creating the offscreen document and
 * initializing the MiniLM ONNX model. That routinely exceeds the default deadline —
 * so the MCP call failed closed while the extension went on to compute an answer
 * nobody was waiting for any more. Everything else keeps the tight 2s contract.
 */
export const BRIDGE_REQUEST_TIMEOUTS_MS: Partial<Record<BridgeRequestType, number>> = {
  semantic_search: 30_000,
};
export const MAX_QUERY_LENGTH = 500;
export const MAX_RESULT_LIMIT = 20;
export const MAX_FOCUS_ENTITY_LENGTH = 200;
export const MAX_GOAL_TITLE_LENGTH = 200;
export const MAX_STATE_SUMMARY_LENGTH = 2000;
export const MAX_SOURCE_DEVICE_LENGTH = 64;
export const MAX_ORIGIN_MACHINE_LENGTH = 64;

export const INTENT_CATEGORIES = [
  "Deep Work (Drafting/Coding)",
  "Research & Gathering",
  "Task Execution & Ops",
  "Communication & Async",
  "Distraction / Rabbit Hole",
  "Idle / Transition"
] as const;

const TRUST_TIERS = ["local", "remote", "vault"] as const;
const CONSENT_BASES = ["explicit_user_action", "standing_local_capture", "derived_aggregate"] as const;

export const BRIDGE_REQUEST_TYPES = [
  "search_memory",
  "query_frames",
  "semantic_search",
  "get_working_memory_stack",
  "restore_context",
  "get_focus_anchor",
  "set_focus_anchor",
  "project_task_reference",
  "get_cognitive_load_telemetry",
  "get_sanitized_telemetry_export",
  "open_memory"
] as const;

export const MAX_HANDLE_LENGTH = 64;

export type BridgeRequestType = (typeof BRIDGE_REQUEST_TYPES)[number];

export type BridgeRequest = { id: string; type: BridgeRequestType; args: Record<string, unknown> };

// --- argument validation --------------------------------------------------

function asArgsObject(raw: unknown, type: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`bridge request args for ${type} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], type: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`bridge request for ${type} contains unknown field: ${key}`);
  }
}

function requireNonEmptyString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} is invalid`);
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} is invalid`);
  return value;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RESULT_LIMIT) {
    throw new Error("bridge result limit is invalid");
  }
  return value as number;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function optionalIntentCategory(value: unknown): (typeof INTENT_CATEGORIES)[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(INTENT_CATEGORIES as readonly string[]).includes(value)) {
    throw new Error("intentCategory is invalid");
  }
  return value as (typeof INTENT_CATEGORIES)[number];
}

type ArgValidator = (raw: unknown) => Record<string, unknown>;

export const BRIDGE_ARG_VALIDATORS: Record<BridgeRequestType, ArgValidator> = {
  search_memory: (raw) => {
    const args = asArgsObject(raw, "search_memory");
    requireOnlyKeys(args, ["query", "limit"], "search_memory");
    const query = requireNonEmptyString(args.query, "query", MAX_QUERY_LENGTH);
    // Defaults to 10 rather than requiring it: the exocortex_search_memory
    // MCP tool declares `limit` optional with a schema default of 10, and a
    // caller that omits it must get that default here too, not a rejection.
    const limit = optionalLimit(args.limit) ?? 10;
    return { query, limit };
  },
  open_memory: (raw) => {
    const args = asArgsObject(raw, "open_memory");
    requireOnlyKeys(args, ["handle"], "open_memory");
    // Shape-checked here and re-checked against the real row in the service
    // worker. A handle is an opaque token, never a URL — accepting a URL-shaped
    // value would turn this into an open-redirect for anything on the MCP side.
    const handle = requireNonEmptyString(args.handle, "handle", MAX_HANDLE_LENGTH);
    if (!/^mem_[0-9]+$/.test(handle)) throw new Error("handle is invalid");
    return { handle };
  },
  query_frames: (raw) => {
    const args = asArgsObject(raw, "query_frames");
    requireOnlyKeys(args, ["intentCategory", "primaryFocusEntity", "limit", "sinceTimestamp"], "query_frames");
    const out: Record<string, unknown> = {};
    const intentCategory = optionalIntentCategory(args.intentCategory);
    if (intentCategory !== undefined) out.intentCategory = intentCategory;
    const primaryFocusEntity = optionalString(args.primaryFocusEntity, "primaryFocusEntity", MAX_FOCUS_ENTITY_LENGTH);
    if (primaryFocusEntity !== undefined) out.primaryFocusEntity = primaryFocusEntity;
    const limit = optionalLimit(args.limit);
    if (limit !== undefined) out.limit = limit;
    const sinceTimestamp = optionalTimestamp(args.sinceTimestamp, "sinceTimestamp");
    if (sinceTimestamp !== undefined) out.sinceTimestamp = sinceTimestamp;
    return out;
  },
  semantic_search: (raw) => {
    const args = asArgsObject(raw, "semantic_search");
    requireOnlyKeys(args, ["query", "limit", "min_score", "sourceType"], "semantic_search");
    const query = requireNonEmptyString(args.query, "query", MAX_QUERY_LENGTH);
    if (isSearchQueryBlocked(query)) throw new Error("Search query matches privacy blocklist");
    const out: Record<string, unknown> = { query };
    const limit = optionalLimit(args.limit);
    if (limit !== undefined) out.limit = limit;
    if (args.min_score !== undefined) {
      if (
        typeof args.min_score !== "number" ||
        !Number.isFinite(args.min_score) ||
        args.min_score < 0 ||
        args.min_score > 1
      ) {
        throw new Error("min_score is invalid");
      }
      out.min_score = args.min_score;
    }
    if (args.sourceType !== undefined) {
      if (!["web", "pdf", "desktop_window"].includes(args.sourceType as string)) throw new Error("sourceType is invalid");
      out.sourceType = args.sourceType;
    }
    return out;
  },
  get_working_memory_stack: (raw) => {
    requireOnlyKeys(asArgsObject(raw, "get_working_memory_stack"), [], "get_working_memory_stack");
    return {};
  },
  restore_context: (raw) => {
    const args = asArgsObject(raw, "restore_context");
    requireOnlyKeys(args, ["focusEntity"], "restore_context");
    const out: Record<string, unknown> = {};
    const focusEntity = optionalString(args.focusEntity, "focusEntity", MAX_FOCUS_ENTITY_LENGTH);
    if (focusEntity !== undefined) out.focusEntity = focusEntity;
    return out;
  },
  get_focus_anchor: (raw) => {
    requireOnlyKeys(asArgsObject(raw, "get_focus_anchor"), [], "get_focus_anchor");
    return {};
  },
  set_focus_anchor: (raw) => {
    const args = asArgsObject(raw, "set_focus_anchor");
    requireOnlyKeys(
      args,
      ["goalTitle", "primaryFocusEntity", "workingStateSummary", "intentCategory"],
      "set_focus_anchor"
    );
    const goalTitle = requireNonEmptyString(args.goalTitle, "goalTitle", MAX_GOAL_TITLE_LENGTH);
    const primaryFocusEntity = requireNonEmptyString(args.primaryFocusEntity, "primaryFocusEntity", MAX_FOCUS_ENTITY_LENGTH);
    const out: Record<string, unknown> = { goalTitle, primaryFocusEntity };
    const workingStateSummary = optionalString(args.workingStateSummary, "workingStateSummary", MAX_STATE_SUMMARY_LENGTH);
    if (workingStateSummary !== undefined) out.workingStateSummary = workingStateSummary;
    const intentCategory = optionalIntentCategory(args.intentCategory);
    if (intentCategory !== undefined) out.intentCategory = intentCategory;
    return out;
  },
  project_task_reference: (raw) => {
    const args = asArgsObject(raw, "project_task_reference");
    requireOnlyKeys(args, ["taskId", "confidence", "originMachine", "trustTier", "consentBasis"], "project_task_reference");
    if (!Number.isInteger(args.taskId) || (args.taskId as number) < 1 || (args.taskId as number) > 999_999_999) {
      throw new Error("taskId is invalid");
    }
    if (
      typeof args.confidence !== "number" ||
      !Number.isFinite(args.confidence) ||
      args.confidence < 0 ||
      args.confidence > 1
    ) {
      throw new Error("confidence is invalid");
    }
    const out: Record<string, unknown> = { taskId: args.taskId, confidence: args.confidence };
    if (args.originMachine !== undefined) {
      out.originMachine = requireNonEmptyString(args.originMachine, "originMachine", MAX_ORIGIN_MACHINE_LENGTH);
    }
    if (args.trustTier !== undefined) {
      if (typeof args.trustTier !== "string" || !(TRUST_TIERS as readonly string[]).includes(args.trustTier)) {
        throw new Error("trustTier is invalid");
      }
      out.trustTier = args.trustTier;
    }
    if (args.consentBasis !== undefined) {
      if (typeof args.consentBasis !== "string" || !(CONSENT_BASES as readonly string[]).includes(args.consentBasis)) {
        throw new Error("consentBasis is invalid");
      }
      out.consentBasis = args.consentBasis;
    }
    return out;
  },
  get_cognitive_load_telemetry: (raw) => {
    requireOnlyKeys(asArgsObject(raw, "get_cognitive_load_telemetry"), [], "get_cognitive_load_telemetry");
    return {};
  },
  get_sanitized_telemetry_export: (raw) => {
    const args = asArgsObject(raw, "get_sanitized_telemetry_export");
    requireOnlyKeys(args, ["sourceDevice"], "get_sanitized_telemetry_export");
    const out: Record<string, unknown> = {};
    const sourceDevice = optionalString(args.sourceDevice, "sourceDevice", MAX_SOURCE_DEVICE_LENGTH);
    if (sourceDevice !== undefined) out.sourceDevice = sourceDevice;
    return out;
  }
};

/** Validates a full envelope (`{id, type, args}`) arriving from either side of the wire. */
export function validateBridgeRequestEnvelope(input: unknown): BridgeRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bridge request must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set(["id", "type", "args"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`bridge request contains unknown field: ${key}`);
  if (typeof value.id !== "string" || !value.id) throw new Error("bridge request id is required");
  const validator = BRIDGE_ARG_VALIDATORS[value.type as BridgeRequestType];
  if (!validator) throw new Error("bridge request type is unsupported");
  const args = validator(value.args);
  return { id: value.id, type: value.type as BridgeRequestType, args };
}

// --- response minimization -------------------------------------------------
//
// What crosses the bridge transport is held to the same "what never crosses"
// list the Exocortex -> unified-agent projection contract enforces
// (contract-v1.ts §5): no raw URL, page title, captured text, or interaction
// trace. That contract guards a *stricter* boundary (persistent control-plane
// storage); this local, ephemeral, same-machine transport is a looser one,
// but the same minimization principle applies because several of these
// tools' normal (unbridged, in-process) return shapes carry raw URLs and
// page text that must not additionally cross the actual Unix-socket /
// native-messaging pipe.

const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;

/** Replace anything URL-shaped with a marker — mirrors contract-v1.ts's redactLinks. */
export function redactUrls(text: string): string {
  return text.replace(URL_LIKE, "[redacted-link]");
}

export type MinimizedFrame = {
  frameId: string;
  timestampUtc: number;
  sessionId: string;
  sourceType: CognitiveStateFrame["sourceType"];
  userState: CognitiveStateFrame["userState"];
  activeDwellSeconds: number;
};

/**
 * A frame's `userState` with captured page text taken back out of it.
 *
 * `userState` was passed across whole on the reasoning that it is derived state,
 * not provenance. But the rule-based classifier derives it by copying: for research,
 * mail and task pages `primaryFocusEntity` *is* the page title, and
 * `workingStateSummary` is "Working on <title>" or the first 100 characters of the
 * page excerpt. Stripping `provenance.pageTitle` and then sending the same string
 * one field over is not minimization.
 *
 * Both free-text fields are therefore replaced on any browser frame:
 *   - the entity keeps its value only when it is already the site label or the
 *     intent category. Anything else on a captured page came out of the page — the
 *     title, a paraphrase of it, or the URL path (`owner/repo`, a gist id), which
 *     plus the site is a rebuildable URL (`focusEntityDerivedFromPageTitle`);
 *   - the summary always becomes "<intent category> on <label>", because on a
 *     captured page it is the title, the excerpt, or a paraphrase of one. A
 *     literal-repeat test missed all three.
 *
 * Frames an agent wrote through MCP (`device://` provenance, from
 * `set_focus_anchor` / `record_frame`) are left alone: their "title" is the entity
 * the agent itself supplied, so there is nothing captured in it.
 */
export function wireSafeUserState(frame: CognitiveStateFrame): CognitiveStateFrame["userState"] {
  const url = frame.provenance?.url ?? "";
  if (isDeviceProvenance(url)) return frame.userState;

  const label = safeCaptureLabel(frame.provenance, frame.userState.intentCategory);
  const derived = focusEntityDerivedFromPageTitle(
    frame.userState.primaryFocusEntity,
    frame.provenance,
    frame.userState.intentCategory
  );

  // The summary is capture text on any browser frame — "Working on <title>", the
  // head of the excerpt, or a paraphrase — so it is replaced whether or not the
  // entity repeats the title. The entity keeps its value only when it is the label;
  // judging that by shape (a literal repeat, or whitespace) let URL-path entities
  // like `owner/repo` and paraphrases through.
  const category = frame.userState.intentCategory;
  return {
    ...frame.userState,
    primaryFocusEntity: derived ? label : frame.userState.primaryFocusEntity,
    // When the site is not printable the label is the category, and "X on X" says
    // nothing; print it once.
    workingStateSummary: label === category ? category : `${category} on ${label}`
  };
}

/**
 * Strips provenance.url / pageTitle / cleanTextExcerpt / userActions, and takes the
 * same title and excerpt text back out of `userState` (see `wireSafeUserState`).
 */
export function minimizeFrame(frame: CognitiveStateFrame): MinimizedFrame {
  return {
    frameId: frame.frameId,
    timestampUtc: frame.timestampUtc,
    sessionId: frame.sessionId,
    sourceType: frame.sourceType,
    userState: wireSafeUserState(frame),
    activeDwellSeconds: frame.provenance.activeDwellSeconds
  };
}

export function minimizeFrames(frames: CognitiveStateFrame[]): MinimizedFrame[] {
  return frames.map(minimizeFrame);
}

export type MinimizedSemanticSearchResult = {
  frameId: number;
  domain?: string;
  category?: string;
  sourceType?: "web" | "pdf" | "desktop_window";
  dwellTime?: number;
  timestamp: number;
  matchKind: "vector" | "lexical";
  cosineSimilarity: number | null;
  lexicalScore?: number;
  recencyScore?: number;
  dwellScore?: number;
  score: number;
};

/** Strips url/title/summary (a raw-excerpt field in the search fallback path); keeps match metadata. */
export function minimizeSemanticSearchResults(results: Array<Record<string, unknown>>): MinimizedSemanticSearchResult[] {
  return results.map((r) => ({
    frameId: r.frameId as number,
    // Same rule as the capture label: a reserved, private or IP host is not a site
    // an agent should be handed, so it is dropped rather than printed.
    domain: printableHost(String(r.domain ?? "")) || undefined,
    category: r.category as string | undefined,
    sourceType: r.sourceType as MinimizedSemanticSearchResult["sourceType"],
    dwellTime: r.dwellTime as number | undefined,
    timestamp: r.timestamp as number,
    // Carried across the wire so the agent can tell a real embedding match from a
    // lexical one. Neither field reveals content — they describe how the match was
    // scored, not what was matched.
    matchKind: (r.matchKind === "vector" ? "vector" : "lexical"),
    cosineSimilarity: (r.cosineSimilarity ?? null) as number | null,
    lexicalScore: r.lexicalScore as number | undefined,
    recencyScore: r.recencyScore as number | undefined,
    dwellScore: r.dwellScore as number | undefined,
    score: r.score as number
  }));
}

/**
 * Keeps match metadata plus an opaque handle; url/title/excerpt never cross.
 *
 * The handle is what makes this result usable at all. Minimization previously
 * reduced the one tool with a real path to browser data to a list of
 * `{parsedAt, score}` — an agent could see that three memories matched but could
 * neither name them nor do anything with them. A handle preserves the privacy
 * posture exactly (it is a local row id, not derived from the URL) while letting
 * the agent say "open the second one" and have the *browser* resolve it.
 */
export function minimizeSearchMemoryResults(
  results: Array<{ parsedAt: number; score: number; handle?: string }>
): Array<{ parsedAt: number; score: number; handle: string }> {
  return results.map(({ parsedAt, score, handle }) => ({ parsedAt, score, handle: handle ?? "" }));
}

export function minimizeFocusAnchor<T extends { url?: string | null }>(anchor: T): Omit<T, "url"> {
  const { url: _url, ...rest } = anchor;
  return rest;
}

export function minimizeRestorationPrompt(result: { restorationPrompt: string | null }): {
  restorationPrompt: string | null;
} {
  return {
    restorationPrompt: result.restorationPrompt === null ? null : redactUrls(result.restorationPrompt)
  };
}

/**
 * Working-memory items with the goal text taken out when it came from a page title.
 *
 * The stored item keeps `activeGoal` (`Focus: <entity>`) for the side panel, plus
 * the answer to "was that captured?" recorded at capture time (task #2632). A row
 * written before that flag existed has no answer, so it is treated as derived: a
 * missing flag must not read as "safe". `activeGoal` is the only field that can
 * carry the title; `stackId`, `status` and the timestamps are opaque.
 */
export function minimizeWorkingMemoryStack(
  items: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return (items ?? []).map((item) => {
    const derived = item.goalDerivedFromPageTitle !== false;
    const safeGoal =
      typeof item.safeGoalLabel === "string" && item.safeGoalLabel ? item.safeGoalLabel : CAPTURED_PAGE_LABEL;
    const minimized: Record<string, unknown> = {
      stackId: item.stackId,
      activeGoal: derived ? safeGoal : item.activeGoal,
      status: item.status,
      lastUpdatedUtc: item.lastUpdatedUtc,
      contextCheckpointId: item.contextCheckpointId
    };
    // A parent goal is a goal string too, so it only crosses when this item is known safe.
    if (!derived && item.parentGoal !== undefined) minimized.parentGoal = item.parentGoal;
    return minimized;
  });
}

/**
 * Applies the per-type minimization for whatever crosses the bridge wire.
 * Every `BridgeRequestType` has an explicit case — the fallthrough is
 * unreachable by construction (exhaustiveness is checked at compile time via
 * the `never` assignment), so a new request type cannot silently ship
 * unminimized.
 */
export function minimizeBridgeResult(type: BridgeRequestType, result: unknown): unknown {
  switch (type) {
    case "search_memory":
      return minimizeSearchMemoryResults(result as Array<{ parsedAt: number; score: number; handle?: string }>);
    case "query_frames":
      return minimizeFrames(result as CognitiveStateFrame[]);
    case "semantic_search":
      return minimizeSemanticSearchResults(result as Array<Record<string, unknown>>);
    case "get_focus_anchor":
      return minimizeFocusAnchor(result as { url?: string | null });
    case "restore_context":
      return minimizeRestorationPrompt(result as { restorationPrompt: string | null });
    case "get_cognitive_load_telemetry": {
      const snapshot = result as { activeFrame: CognitiveStateFrame | null; [key: string]: unknown };
      return { ...snapshot, activeFrame: snapshot.activeFrame ? minimizeFrame(snapshot.activeFrame) : null };
    }
    // get_working_memory_stack used to be listed here as carrying "no url/page
    // fields". That was true of the shape and false of the content: `activeGoal`
    // is `Focus: <entity>`, and on research, mail and task pages the entity *is*
    // the page title. The minimizer now removes the value, not just the field.
    case "get_working_memory_stack":
      return minimizeWorkingMemoryStack(result as Array<Record<string, unknown>>);
    // set_focus_anchor returns {status, frameId}; get_sanitized_telemetry_export
    // is already sanitized by design (Decision 2026-07-29 Option B).
    // open_memory returns {status, handle} — an acknowledgement, never the page
    // it resolved to. The whole point is that the content stays in the browser.
    case "set_focus_anchor":
    case "project_task_reference":
    case "get_sanitized_telemetry_export":
    case "open_memory":
      return result;
    default: {
      const exhaustive: never = type;
      throw new Error(`no minimizer registered for bridge request type: ${exhaustive}`);
    }
  }
}
