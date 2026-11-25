import Dexie, { type Table } from "dexie";

export interface SessionRecord {
  id?: number;
  sessionId: string;
  startTime: number;
  endTime: number;
  url: string;
  title: string;
  favIconUrl?: string;
  activeDuration: number;
}

export interface DwellBlockRecord {
  id?: number;
  sessionId?: string;
  url: string;
  title: string;
  timestamp: number;
  dwellTime: number; // in milliseconds
  favIconUrl?: string;
}

export interface PageTextRecord {
  id?: number;
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  textContent: string;
  length: number;
  siteName?: string;
  parsedAt: number;
}

export interface CognitiveStateFrame {
  id?: number;
  frameId: string;
  timestampUtc: number;
  sessionId: string;
  
  userState: {
    intentCategory: 
      | 'Deep Work (Drafting/Coding)'
      | 'Research & Gathering'
      | 'Task Execution & Ops'
      | 'Communication & Async'
      | 'Distraction / Rabbit Hole'
      | 'Idle / Transition';
    primaryFocusEntity: string;
    workingStateSummary: string;
    cognitiveLoadLevel: 'Low' | 'Medium' | 'High' | 'Overload';
    frictionScore: number;
    cognitiveLoadScore?: number; // 0.0 - 1.0 normalized
    fatigueIndex?: number; // continuous fatigue depletion
    contextSwitchCost?: number; // switch penalty in seconds
  };

  provenance: {
    url: string;
    pageTitle: string;
    activeDwellSeconds: number;
    userActions: string[];
    cleanTextExcerpt: string;
  };

  vectorAnchor?: number[];
  sourceType?: 'web' | 'pdf' | 'desktop_window';
}

export interface CognitiveCheckpoint {
  id?: number;
  checkpointId: string;
  timestampUtc: number;
  sessionId: string;
  goalTitle: string;
  primaryFocusEntity: string;
  stateSummary: string;
  openTabsContext: { url: string; title: string; excerpt?: string }[];
  vectorAnchor?: number[];
  restorationPrompt?: string;
  /**
   * True when this checkpoint was written from a captured (browser) frame, so
   * every free-text field in it — the entity, the goal and the summary — may
   * carry page text. `false` for an agent-supplied checkpoint (`device://`).
   * Undefined on rows from before task #2632, which readers treat as captured.
   */
  fromCapturedPage?: boolean;
  /**
   * True when `goalTitle` / `primaryFocusEntity` were copied (or paraphrased) out
   * of the captured page title. Undefined on rows written before task #2632, which
   * wire-facing readers treat as derived — see src/lib/title-provenance.ts.
   */
  focusDerivedFromPageTitle?: boolean;
  /** Wire-safe substitute computed at capture: the site, else the intent category. */
  safeFocusLabel?: string;
  /** `goalTitle` with the derived entity replaced by `safeFocusLabel`. */
  safeGoalTitle?: string;
}

export interface WorkingMemoryItem {
  id?: number;
  stackId: string;
  activeGoal: string;
  parentGoal?: string;
  status: 'active' | 'paused' | 'completed';
  lastUpdatedUtc: number;
  contextCheckpointId?: string;
  /** See CognitiveCheckpoint.focusDerivedFromPageTitle. */
  goalDerivedFromPageTitle?: boolean;
  /** Wire-safe substitute for `activeGoal`, computed at capture. */
  safeGoalLabel?: string;
}

export interface SemanticVaultRecord {
  id?: number;
  vaultId: string;
  timestampUtc: number;
  url: string;
  title: string;
  excerpt: string;
  primaryFocusEntity: string;
  vectorAnchor?: number[];
  keywords: string[];
}

/**
 * How an embedding vector was produced.
 *
 * `model` is a real MiniLM sentence embedding. `fallback` is the hash-bag-of-words
 * substitute `computeFallbackVector` emits when ONNX/Wasm is unavailable — it shares
 * the shape of a real embedding but none of its semantics, so two paraphrases land in
 * disjoint bins. Consumers that reason about *meaning* (drift detection, semantic
 * search) must refuse `fallback` rather than silently treat it as a real embedding;
 * that silent substitution is what made the dead embedding pipeline invisible.
 */
export type EmbeddingSource = 'model' | 'fallback';

/** Spec 3.3 Phase 3.1 Extensions */
export interface EmbeddingRecord {
  id?: number;
  frameId: number;
  vector: Float32Array;
  dimension: number; // 384
  createdAt: number;
  source: EmbeddingSource;
}

export interface FrameRecord {
  id?: number;
  url: string;
  title: string;
  domain?: string;
  category?: string;
  summary?: string;
  sourceType?: 'web' | 'pdf' | 'desktop_window';
  hasVisualThumb?: boolean;
  /** Seconds. For web frames this is the visit's cumulative foreground dwell. */
  dwellTime?: number;
  timestamp: number;
  synced?: boolean;
  // Page metadata for recall. Not indexed, so no schema version bump: rows
  // written before these existed simply lack them.
  /** `og:site_name`, else the hostname. */
  siteName?: string;
  /** Author, or the channel name on a video page. */
  byline?: string;
  contentKind?: 'video' | 'article' | 'page';
}

/** Task #166 Phase 3.2 Extensions */
export interface FrameVisualRecord {
  id?: number;
  frameId: number;
  thumbnailWebP?: Blob;
  ocrText?: string;
}

export interface AnchorRecord {
  id?: number;
  title: string;
  category?: string;
  status: 'active' | 'completed' | 'paused';
  createdAt: number;
  vector?: Float32Array;
}

export interface TelemetryRecord {
  id?: number;
  timestamp: number;
  event: string;
  details?: Record<string, any>;
}

export class ExocortexDatabase extends Dexie {
  sessions!: Table<SessionRecord, number>;
  dwell_blocks!: Table<DwellBlockRecord, number>;
  page_text!: Table<PageTextRecord, number>;
  cognitive_frames!: Table<CognitiveStateFrame, number>;
  cognitive_checkpoints!: Table<CognitiveCheckpoint, number>;
  working_memory_stack!: Table<WorkingMemoryItem, number>;
  semantic_vault!: Table<SemanticVaultRecord, number>;

  // Phase 3.1 & 3.2 Tables
  frames!: Table<FrameRecord, number>;
  embeddings!: Table<EmbeddingRecord, number>;
  anchors!: Table<AnchorRecord, number>;
  telemetry!: Table<TelemetryRecord, number>;
  frame_visuals!: Table<FrameVisualRecord, number>;

  constructor() {
    super("ExocortexVault");
    // Consolidated to single version declaration — versions 1-5 were additive
    // schema-only (no data migration callbacks), so collapsing to the final
    // schema avoids Dexie running upgrade logic for each version during
    // constructor init, which was stalling the service worker.
    this.version(6).stores({
      sessions: "++id, sessionId, startTime, endTime, url, [url+startTime]",
      dwell_blocks: "++id, sessionId, url, timestamp",
      page_text: "++id, &url, parsedAt",
      cognitive_frames: "&frameId, timestampUtc, sessionId, [userState.intentCategory], [userState.primaryFocusEntity]",
      cognitive_checkpoints: "&checkpointId, timestampUtc, sessionId, primaryFocusEntity",
      working_memory_stack: "&stackId, activeGoal, lastUpdatedUtc, status",
      semantic_vault: "&vaultId, timestampUtc, url, primaryFocusEntity",
      frames: "++id, url, title, domain, category, sourceType, dwellTime, timestamp, synced",
      embeddings: "++id, &frameId, createdAt",
      anchors: "++id, title, category, status, createdAt",
      telemetry: "++id, timestamp",
      frame_visuals: "++id, &frameId"
    });

    // v7 adds no indexes — it exists only to backfill `EmbeddingRecord.source`,
    // which became required after the fact. Rows written before it existed have
    // `source === undefined`, and an undefined provenance must never be read as
    // "model": those rows are disproportionately the empty and fallback vectors
    // produced during the period when chrome.offscreen was undefined and the
    // embedder never ran at all.
    //
    // Stamping rather than deleting: the rows stay inspectable, the `!== "model"`
    // filter in vector-search.ts already excludes them from cosine rescoring, and
    // the 7-day LRU retires them on its own.
    //
    // One upgrade callback does not reintroduce the stall described above. That
    // was five versions of schema replay running on every constructor init; this
    // is a single bounded pass over one table, and only on the upgrade itself.
    this.version(7).upgrade(async (tx) => {
      await tx.table("embeddings").toCollection().modify((row: Partial<EmbeddingRecord>) => {
        if (row.source !== "model" && row.source !== "fallback") {
          row.source = "fallback";
        }
      });
    });
  }
}

export const db = new ExocortexDatabase();

const MAX_TEXT_LENGTH = 50 * 1024; // 50 KB (~10,000 words)

export const DEFAULT_RETENTION_MAX_AGE_DAYS = 7;

let configuredRetentionDays: number | null = null;

export function getRetentionMaxAgeDays(): number {
  if (configuredRetentionDays !== null && configuredRetentionDays > 0) {
    return configuredRetentionDays;
  }
  const envVal = typeof process !== "undefined" ? process.env?.EXOCORTEX_RETENTION_DAYS : undefined;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_RETENTION_MAX_AGE_DAYS;
}

export function setRetentionMaxAgeDays(days: number | null): void {
  if (days === null) {
    configuredRetentionDays = null;
    return;
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid retention days: ${days}. Must be a positive finite number.`);
  }
  configuredRetentionDays = days;
}

export function getRetentionCutoff(now: number = Date.now(), maxAgeDays: number = getRetentionMaxAgeDays()): number {
  return now - maxAgeDays * 24 * 60 * 60 * 1000;
}

export function isTimestampExpired(timestamp: number, now: number = Date.now(), maxAgeDays: number = getRetentionMaxAgeDays()): boolean {
  return timestamp < getRetentionCutoff(now, maxAgeDays);
}

export function truncateText(text: string, maxBytes: number = MAX_TEXT_LENGTH): string {
  if (!text || text.length <= maxBytes) return text || "";
  return text.substring(0, maxBytes);
}

/**
 * Idempotently upsert page_text under the extension origin using Dexie .put()
 */
export async function upsertPageText(record: {
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  textContent: string;
  siteName?: string;
  parsedAt?: number;
}): Promise<void> {
  const cleanContent = truncateText(record.textContent);
  const cleanExcerpt = truncateText(record.excerpt || "", 1024);
  const now = record.parsedAt || Date.now();

  const existing = await db.page_text.where("url").equals(record.url).first();

  await db.page_text.put({
    id: existing?.id,
    url: record.url,
    title: record.title || existing?.title || "Untitled Page",
    byline: record.byline || existing?.byline || "",
    excerpt: cleanExcerpt || existing?.excerpt || "",
    textContent: cleanContent || existing?.textContent || "",
    length: cleanContent.length,
    siteName: record.siteName || existing?.siteName || "",
    parsedAt: now
  });
}

/**
 * Deletes records older than maxAgeDays (default configured retention) from all Dexie tables.
 */
export async function pruneOldData(
  maxAgeDays: number = getRetentionMaxAgeDays(),
  cutoffTimestamp?: number
): Promise<{
  sessionsDeleted: number;
  dwellBlocksDeleted: number;
  pageTextDeleted: number;
  cognitiveFramesDeleted: number;
  checkpointsDeleted: number;
  vaultRecordsDeleted: number;
  framesDeleted: number;
  embeddingsDeleted: number;
  telemetryDeleted: number;
  frameVisualsDeleted: number;
  workingMemoryDeleted: number;
  anchorsDeleted: number;
}> {
  const cutoff = cutoffTimestamp ?? getRetentionCutoff(Date.now(), maxAgeDays);

  const oldSessions = await db.sessions.where("startTime").below(cutoff).primaryKeys();
  const oldDwellBlocks = await db.dwell_blocks.where("timestamp").below(cutoff).primaryKeys();
  const oldPageText = await db.page_text.where("parsedAt").below(cutoff).primaryKeys();
  const oldFrames = await db.cognitive_frames.where("timestampUtc").below(cutoff).primaryKeys();
  const oldCheckpoints = await db.cognitive_checkpoints.where("timestampUtc").below(cutoff).primaryKeys();
  const oldVaultRecords = await db.semantic_vault.where("timestampUtc").below(cutoff).primaryKeys();

  const oldFrameRecords = await db.frames.where("timestamp").below(cutoff).primaryKeys();
  const oldEmbeddings = await db.embeddings.where("createdAt").below(cutoff).primaryKeys();
  const oldTelemetry = await db.telemetry.where("timestamp").below(cutoff).primaryKeys();
  const oldWorkingMemory = await db.working_memory_stack.where("lastUpdatedUtc").below(cutoff).primaryKeys();
  const oldAnchors = await db.anchors.where("createdAt").below(cutoff).primaryKeys();

  const oldFrameVisuals = await db.frame_visuals.where("frameId").anyOf(oldFrameRecords as number[]).primaryKeys();

  await db.sessions.bulkDelete(oldSessions);
  await db.dwell_blocks.bulkDelete(oldDwellBlocks);
  await db.page_text.bulkDelete(oldPageText);
  await db.cognitive_frames.bulkDelete(oldFrames);
  await db.cognitive_checkpoints.bulkDelete(oldCheckpoints);
  await db.semantic_vault.bulkDelete(oldVaultRecords);

  await db.frames.bulkDelete(oldFrameRecords);
  await db.embeddings.bulkDelete(oldEmbeddings);
  await db.telemetry.bulkDelete(oldTelemetry);
  await db.working_memory_stack.bulkDelete(oldWorkingMemory);
  await db.anchors.bulkDelete(oldAnchors);
  await db.frame_visuals.bulkDelete(oldFrameVisuals);

  return {
    sessionsDeleted: oldSessions.length,
    dwellBlocksDeleted: oldDwellBlocks.length,
    pageTextDeleted: oldPageText.length,
    cognitiveFramesDeleted: oldFrames.length,
    checkpointsDeleted: oldCheckpoints.length,
    vaultRecordsDeleted: oldVaultRecords.length,
    framesDeleted: oldFrameRecords.length,
    embeddingsDeleted: oldEmbeddings.length,
    telemetryDeleted: oldTelemetry.length,
    frameVisualsDeleted: oldFrameVisuals.length,
    workingMemoryDeleted: oldWorkingMemory.length,
    anchorsDeleted: oldAnchors.length
  };
}
