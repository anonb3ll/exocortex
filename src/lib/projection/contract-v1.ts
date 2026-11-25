/**
 * Exocortex -> unified-agent projection contract, version 1
 * (unified-agent task #279, gate G2).
 *
 * Exocortex owns the transform because minimisation has to happen at the source:
 * this module is the only place that sees a full URL or a clean-text excerpt, and
 * nothing it emits may contain either. The receiving validator is
 * unified_agent/projection/exocortex_v1.py, which independently re-checks every
 * rule below and fails closed — this projector is a good citizen, not a trust
 * boundary on its own.
 *
 * Field-by-field rationale, compatibility policy and retention schedule:
 * unified_agent/docs/exocortex-projection-contract-v1.md
 */

export const CONTRACT_VERSION = "1.0";

export const MAX_RECORD_BYTES = 8 * 1024;
export const MAX_FOCUS_ENTITY_CHARS = 200;
export const MAX_STATE_DIGEST_CHARS = 280;
export const MAX_ORIGIN_MACHINE_CHARS = 64;
export const MAX_TASK_REF_CHARS = 64;

export const KIND_FIELDS = {
  focus_anchor: [
    "focus_entity",
    "intent_category",
    "cognitive_load_level",
    "state_digest",
    "origin_ref"
  ],
  cognitive_frame: [
    "focus_entity",
    "intent_category",
    "cognitive_load_level",
    "state_digest",
    "friction_score",
    "dwell_seconds",
    "origin_ref"
  ],
  checkpoint: ["goal_title", "focus_entity", "state_digest", "open_context_count", "origin_ref"],
  telemetry: [
    "cognitive_load_score",
    "fatigue_index",
    "context_switch_cost",
    "intent_category",
    "tab_switches_5m",
    "session_minutes"
  ],
  task_reference: ["task_ref", "relation", "confidence", "focus_entity"],
  vault_proposal: ["note_title", "summary_digest", "suggested_folder", "focus_entity"]
} as const satisfies Record<string, readonly string[]>;

export type ProjectionKind = keyof typeof KIND_FIELDS;

export const ORIGIN_SURFACES = ["browser", "desktop", "vault"] as const;
export const TRUST_TIERS = ["local", "remote", "vault"] as const;
export const CONSENT_BASES = [
  "explicit_user_action",
  "standing_local_capture",
  "derived_aggregate"
] as const;

export type OriginSurface = (typeof ORIGIN_SURFACES)[number];
export type TrustTier = (typeof TRUST_TIERS)[number];
export type ConsentBasis = (typeof CONSENT_BASES)[number];

const INTENT_CATEGORIES = [
  "Deep Work (Drafting/Coding)",
  "Research & Gathering",
  "Task Execution & Ops",
  "Communication & Async",
  "Distraction / Rabbit Hole",
  "Idle / Transition"
] as const;

const COGNITIVE_LOAD_LEVELS = ["Low", "Medium", "High", "Overload"] as const;

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

export interface Provenance {
  origin_machine: string;
  origin_surface: OriginSurface;
  captured_at: number;
  projected_at: number;
  consent_basis: ConsentBasis;
  trust_tier: TrustTier;
}

export interface ProjectedRecord<K extends ProjectionKind = ProjectionKind> {
  contract_version: string;
  kind: K;
  record_id: string;
  provenance: Provenance;
  payload: Record<(typeof KIND_FIELDS)[K][number], string | number>;
}

/** The internal shape returned by exocortex_get_focus_anchor. */
export interface FocusAnchorSource {
  activeFocusEntity: string | null;
  workingStateSummary: string | null;
  intentCategory: string | null;
  cognitiveLoadLevel: string | null;
  timestampUtc: number | null;
  url: string | null;
}

export interface ProjectionOptions {
  originMachine: string;
  originSurface: OriginSurface;
  trustTier: TrustTier;
  consentBasis: ConsentBasis;
  projectedAt?: number;
}

const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;

/** Replace anything URL-shaped with a marker. Applied to every free-text field. */
function redactLinks(text: string): string {
  return text.replace(URL_LIKE, "[redacted-link]");
}

function clampText(text: string, max: number): string {
  const collapsed = redactLinks(text).replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + "…";
}

/** 16 hex chars of SHA-256 — enough to correlate two projections of the same page,
 *  not enough to recover the URL. */
async function originRef(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function requireNonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionError(`${field} is required and must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ProjectionError(`${field} exceeds ${max} characters`);
  }
  return value;
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ProjectionError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireEpochMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProjectionError(`${field} must be a non-negative finite epoch-millisecond number`);
  }
  return Math.trunc(value);
}

/**
 * Project a focus anchor onto the v1 contract — the S2 vertical slice.
 *
 * Free text is redacted and clamped rather than rejected (that is minimisation
 * working as intended); structural problems and out-of-vocabulary values throw,
 * because silently emitting a degraded record would hide a real capture bug.
 */
export async function projectFocusAnchor(
  source: FocusAnchorSource,
  options: ProjectionOptions
): Promise<ProjectedRecord<"focus_anchor">> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ProjectionError("focus anchor source must be an object");
  }
  if (typeof options !== "object" || options === null) {
    throw new ProjectionError("projection options are required");
  }

  const originMachine = requireNonEmpty(
    options.originMachine,
    "originMachine",
    MAX_ORIGIN_MACHINE_CHARS
  );
  const originSurface = requireMember(options.originSurface, ORIGIN_SURFACES, "originSurface");
  const trustTier = requireMember(options.trustTier, TRUST_TIERS, "trustTier");
  const consentBasis = requireMember(options.consentBasis, CONSENT_BASES, "consentBasis");

  const rawFocus = requireNonEmpty(source.activeFocusEntity, "activeFocusEntity", 50_000);
  const intentCategory = requireMember(source.intentCategory, INTENT_CATEGORIES, "intentCategory");
  const cognitiveLoadLevel = requireMember(
    source.cognitiveLoadLevel,
    COGNITIVE_LOAD_LEVELS,
    "cognitiveLoadLevel"
  );
  const capturedAt = requireEpochMs(source.timestampUtc, "timestampUtc");
  const projectedAt = requireEpochMs(options.projectedAt ?? Date.now(), "projectedAt");

  const focusEntity = clampText(rawFocus, MAX_FOCUS_ENTITY_CHARS);
  const stateDigest = clampText(source.workingStateSummary ?? "", MAX_STATE_DIGEST_CHARS);

  const record: ProjectedRecord<"focus_anchor"> = {
    contract_version: CONTRACT_VERSION,
    kind: "focus_anchor",
    record_id: `fa_${capturedAt.toString(36)}_${await originRef(String(source.url ?? ""))}`.slice(
      0,
      128
    ),
    provenance: {
      origin_machine: originMachine,
      origin_surface: originSurface,
      captured_at: capturedAt,
      projected_at: projectedAt,
      consent_basis: consentBasis,
      trust_tier: trustTier
    },
    payload: {
      focus_entity: focusEntity,
      intent_category: intentCategory,
      cognitive_load_level: cognitiveLoadLevel,
      state_digest: stateDigest,
      origin_ref: await originRef(String(source.url ?? ""))
    }
  };

  const size = new TextEncoder().encode(JSON.stringify(record)).length;
  if (size > MAX_RECORD_BYTES) {
    throw new ProjectionError(`projected record is ${size} bytes, over the ${MAX_RECORD_BYTES} limit`);
  }

  return record;
}

/**
 * Derive the privacy-minimised task edge accepted by unified-agent's receiver.
 * This is intentionally pure: the receiver remains responsible for checking
 * that the task exists and is non-terminal before persisting the edge.
 */
export function projectTaskReference(
  anchor: ProjectedRecord<"focus_anchor">,
  taskId: number,
  confidence: number
): ProjectedRecord<"task_reference"> {
  if (!anchor || anchor.kind !== "focus_anchor") {
    throw new ProjectionError("expected a focus_anchor record");
  }
  if (!Number.isInteger(taskId) || taskId < 1 || taskId > 999_999_999) {
    throw new ProjectionError("taskId must be a positive integer");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ProjectionError("confidence must be a number in [0, 1]");
  }

  const record: ProjectedRecord<"task_reference"> = {
    contract_version: CONTRACT_VERSION,
    kind: "task_reference",
    record_id: `tr_${anchor.record_id}_${taskId}`.slice(0, 128),
    provenance: anchor.provenance,
    payload: {
      task_ref: `ua://task/${taskId}`,
      relation: "suggested_by_focus",
      confidence: Math.round(confidence * 10_000) / 10_000,
      focus_entity: String(anchor.payload.focus_entity)
    }
  };

  const size = new TextEncoder().encode(JSON.stringify(record)).length;
  if (size > MAX_RECORD_BYTES) {
    throw new ProjectionError(`projected record is ${size} bytes, over the ${MAX_RECORD_BYTES} limit`);
  }
  return record;
}
