import { db, getRetentionCutoff, type CognitiveStateFrame } from "../lib/db";
import { createCognitiveFrame } from "../lib/models/cognitive-frame";
import { evaluateContextDrift } from "../lib/agents/drift-detector";
import { contextAnchorAgent } from "../lib/agents/context-anchor-agent";
import { librarianAgent } from "../lib/agents/librarian-agent";
import { stateObserver } from "../lib/agents/state-observer";
import { hybridVectorSearch } from "../lib/models/vector-search";
import { searchBrowserMemory } from "../lib/browser-memory-search";
import { summarizePageWithAi } from "../lib/models/built-in-ai";
import { recordDesktopFrame } from "../lib/desktop-frame";
import { projectFocusAnchor, projectTaskReference, type ProjectedRecord } from "../lib/projection/contract-v1";
import { BRIDGE_BACKED_TOOLS } from "./source-envelope";
import { isSearchQueryBlocked } from "../content/privacy";
import { wireSafeUserState } from "../bridge/protocol";
import type {
  FocusAnchorResponse,
  ProjectFocusAnchorParams,
  ProjectTaskReferenceParams,
  QueryFramesParams,
  RecordFrameParams,
  SearchMemoryParams,
  SearchMemoryResult,
  SemanticSearchParams,
  SummarizePageParams,
  RecordDesktopFrameParams,
  BridgeStatusResponse
} from "./types";

/**
 * Tool 1: exocortex_get_focus_anchor
 * Returns the user's active focus entity and working state summary
 */
export async function handleGetFocusAnchor(options: { wireSafe?: boolean } = {}): Promise<FocusAnchorResponse> {
  const storedFrame = await db.cognitive_frames.orderBy("timestampUtc").reverse().first();
  // `wireSafe` is set wherever the answer leaves this process's trust boundary
  // (the native bridge, a contract-v1 projection). The anchor response carries no
  // provenance, so the bridge minimizer downstream cannot tell a derived entity
  // from a copied page title — only this function, holding the frame, can.
  const latestFrame =
    storedFrame && options.wireSafe ? { ...storedFrame, userState: wireSafeUserState(storedFrame) } : storedFrame;
  if (!latestFrame) {
    return {
      activeFocusEntity: null,
      workingStateSummary: null,
      intentCategory: null,
      cognitiveLoadLevel: null,
      timestampUtc: null,
      url: null
    };
  }

  return {
    activeFocusEntity: latestFrame.userState.primaryFocusEntity,
    workingStateSummary: latestFrame.userState.workingStateSummary,
    intentCategory: latestFrame.userState.intentCategory,
    cognitiveLoadLevel: latestFrame.userState.cognitiveLoadLevel,
    timestampUtc: latestFrame.timestampUtc,
    url: latestFrame.provenance.url
  };
}

/**
 * Tool 1b: exocortex_project_focus_anchor
 * The producing half of the S2 vertical slice (unified-agent task #373 5.3):
 * projects the current focus anchor onto contract v1 and returns the
 * minimised wire record — ready to hand, alongside a task id, to
 * unified-agent's browser_derive_task_reference tool. Nothing crosses this
 * boundary that projectFocusAnchor() does not allowlist; see
 * src/lib/projection/contract-v1.ts and
 * unified_agent/docs/exocortex-projection-contract-v1.md.
 */
export async function handleProjectFocusAnchor(
  params: ProjectFocusAnchorParams = {}
): Promise<ProjectedRecord<"focus_anchor">> {
  // Contract v1 §5: no page title or captured text crosses. The projector
  // redacts links and clamps length, but cannot recognise a title on its own.
  const anchor = await handleGetFocusAnchor({ wireSafe: true });
  if (
    !anchor.activeFocusEntity ||
    !anchor.intentCategory ||
    !anchor.cognitiveLoadLevel ||
    anchor.timestampUtc === null
  ) {
    throw new Error("no focus anchor captured yet — nothing to project");
  }

  return projectFocusAnchor(anchor, {
    originMachine: params.originMachine || "desktop",
    originSurface: "browser",
    trustTier: params.trustTier || "local",
    consentBasis: params.consentBasis || "standing_local_capture"
  });
}

/** Produce the contract-v1 edge that a unified-agent receiver can validate. */
export async function handleProjectTaskReference(
  params: ProjectTaskReferenceParams
): Promise<ProjectedRecord<"task_reference">> {
  const anchor = await handleProjectFocusAnchor(params);
  return projectTaskReference(anchor, params.taskId, params.confidence);
}

/**
 * Tool 2: exocortex_query_frames
 * Queries cognitive state frames by category, focus entity, or timeframe
 */
export async function handleQueryFrames(params: QueryFramesParams): Promise<CognitiveStateFrame[]> {
  const limit = params.limit || 10;
  let frames = await db.cognitive_frames.orderBy("timestampUtc").reverse().limit(limit * 2).toArray();

  if (params.intentCategory) {
    frames = frames.filter((f) => f.userState.intentCategory === params.intentCategory);
  }

  if (params.primaryFocusEntity) {
    // Filter on the entity as the caller can see it, not on the stored one. The
    // stored entity is a page title on a captured frame, so filtering on it turns
    // `query_frames` into a substring oracle: send longer and longer guesses and
    // the hit count tells you what the title is. It also fixes the round trip —
    // a caller who was given `github.com` can now ask for it back.
    const focusLower = params.primaryFocusEntity.toLowerCase();
    frames = frames.filter((f) => wireSafeUserState(f).primaryFocusEntity.toLowerCase().includes(focusLower));
  }

  if (params.sinceTimestamp) {
    frames = frames.filter((f) => f.timestampUtc >= params.sinceTimestamp!);
  }

  return frames.slice(0, limit);
}

/**
 * Tool 3: exocortex_search_memory
 * Performs hybrid search over page texts and cognitive state excerpts
 */
export async function handleSearchMemory(params: SearchMemoryParams): Promise<SearchMemoryResult[]> {
  return searchBrowserMemory(params.query || "", params.limit || 10);
}

/**
 * Tool 4: exocortex_detect_drift
 * Checks recent frames for rabbit-hole context drift and returns soft nudges
 */
export async function handleDetectDrift(): Promise<{
  isContextDrift: boolean;
  driftSeverity: string;
  activeAnchorEntity: string | null;
  suggestedSoftNudge: string | null;
}> {
  const frames = await db.cognitive_frames.orderBy("timestampUtc").reverse().limit(10).toArray();
  if (frames.length < 2) {
    return {
      isContextDrift: false,
      driftSeverity: "None",
      activeAnchorEntity: frames[0]?.userState.primaryFocusEntity || null,
      suggestedSoftNudge: null
    };
  }

  const activeAnchor = frames.find((f) => f.userState.intentCategory !== "Distraction / Rabbit Hole") || frames[frames.length - 1];
  const current = frames[0];

  const drift = evaluateContextDrift(activeAnchor, current, frames.length, frames);
  return {
    isContextDrift: drift.isContextDrift,
    driftSeverity: drift.driftSeverity,
    activeAnchorEntity: drift.activeAnchorEntity,
    suggestedSoftNudge: drift.suggestedSoftNudge
  };
}

/**
 * Tool 5: exocortex_record_frame
 * Universal ingestion tool for Desktop, Mobile, or IoT sensors
 */
export async function handleRecordFrame(params: RecordFrameParams): Promise<{ status: string; frameId: string }> {
  const frame = createCognitiveFrame({
    sessionId: params.sessionId || `session_${params.sourceDevice || "external"}_${Date.now()}`,
    url: params.url || `device://${params.sourceDevice || "desktop"}/${encodeURIComponent(params.primaryFocusEntity)}`,
    pageTitle: params.pageTitle || params.primaryFocusEntity,
    activeDwellSeconds: 30,
    cleanTextExcerpt: params.cleanTextExcerpt || params.workingStateSummary,
    userActions: params.userActions || [params.sourceDevice || "external_capture"]
  });

  if (params.intentCategory) {
    frame.userState.intentCategory = params.intentCategory;
  }
  if (params.primaryFocusEntity) {
    frame.userState.primaryFocusEntity = params.primaryFocusEntity;
  }
  if (params.workingStateSummary) {
    frame.userState.workingStateSummary = params.workingStateSummary;
  }

  await db.cognitive_frames.put(frame);
  return { status: "success", frameId: frame.frameId };
}

/**
 * Tool 6: exocortex_get_working_memory_stack
 */
export async function handleGetWorkingMemoryStack(): Promise<unknown[]> {
  // The MCP tool surface is a wire boundary: goals derived from a captured page
  // title are answered with the label stored at capture (task #2632).
  return await contextAnchorAgent.getWireSafeWorkingMemoryStack(10);
}

/**
 * Tool 7: exocortex_create_cognitive_checkpoint
 */
export async function handleCreateCognitiveCheckpoint(params: {
  goalTitle: string;
  primaryFocusEntity: string;
  stateSummary: string;
  openTabsContext?: { url: string; title: string; excerpt?: string }[];
}): Promise<{ status: string; checkpointId: string }> {
  // Build the frame from the agent's own arguments, not from the latest captured
  // frame: reusing a browser frame would file the agent's goal under that page's
  // provenance, so a title-derived `stateSummary` would ride along with a goal the
  // agent wrote itself.
  const dummyFrame = createCognitiveFrame({
    sessionId: `session_mcp_${Date.now()}`,
    url: `device://mcp/${encodeURIComponent(params.primaryFocusEntity)}`,
    pageTitle: params.primaryFocusEntity,
    activeDwellSeconds: 60,
    cleanTextExcerpt: params.stateSummary
  });
  dummyFrame.userState.primaryFocusEntity = params.primaryFocusEntity;
  dummyFrame.userState.workingStateSummary = params.stateSummary;

  const checkpoint = await contextAnchorAgent.captureCheckpoint({
    frame: dummyFrame,
    goalTitle: params.goalTitle,
    openTabsContext: params.openTabsContext || []
  });

  return { status: "success", checkpointId: checkpoint.checkpointId };
}

/**
 * Tool 8: exocortex_restore_context
 *
 * Always the title-free prompt. The prompt prints the focus, the goal and the
 * tabs, so it is a wire view wherever it is called from for an agent. The side
 * panel's Focus Shield "Restore" is the one local caller and goes through
 * `contextAnchorAgent.getContextRestorationKit(undefined, { wireSafe: false })`
 * directly — this function does not take an option that could be passed in from
 * an MCP request.
 */
export async function handleRestoreContext(params: { focusEntity?: string }): Promise<{ restorationPrompt: string | null }> {
  const prompt = await contextAnchorAgent.getContextRestorationKit(params.focusEntity, { wireSafe: true });
  return { restorationPrompt: prompt };
}

/**
 * Tool 9: exocortex_get_cognitive_load_telemetry
 */
export async function handleGetCognitiveLoadTelemetry(): Promise<unknown> {
  return await stateObserver.getLatestObserverSnapshot();
}

/**
 * Tool 10: exocortex_search_semantic_vault
 */
export async function handleSearchSemanticVault(params: {
  query?: string;
  primaryFocusEntity?: string;
  limit?: number;
}): Promise<unknown[]> {
  return await librarianAgent.searchSemanticVault(params);
}

/**
 * Tool 11: exocortex_set_focus_anchor (Bi-directional orchestration tool)
 */
export async function handleSetFocusAnchor(params: {
  goalTitle: string;
  primaryFocusEntity: string;
  workingStateSummary?: string;
  intentCategory?: CognitiveStateFrame["userState"]["intentCategory"];
}): Promise<{ status: string; frameId: string }> {
  const frame = createCognitiveFrame({
    sessionId: `session_mcp_set_${Date.now()}`,
    url: `device://mcp/orchestrator/${encodeURIComponent(params.primaryFocusEntity)}`,
    pageTitle: params.primaryFocusEntity,
    activeDwellSeconds: 60,
    cleanTextExcerpt: params.workingStateSummary || params.goalTitle,
    userActions: ["mcp_orchestrated_focus"]
  });

  if (params.intentCategory) {
    frame.userState.intentCategory = params.intentCategory;
  }
  if (params.primaryFocusEntity) {
    frame.userState.primaryFocusEntity = params.primaryFocusEntity;
  }
  if (params.workingStateSummary) {
    frame.userState.workingStateSummary = params.workingStateSummary;
  }

  await db.cognitive_frames.put(frame);
  await contextAnchorAgent.pushWorkingMemoryStack(params.goalTitle);

  return { status: "success", frameId: frame.frameId };
}

/**
 * Tool 18: exocortex_open_memory
 *
 * Resolving a handle requires the browser that issued it, so this in-process
 * implementation cannot succeed and does not pretend to. Under the native bridge
 * the service worker handles it against the real profile; unbridged it throws,
 * which the envelope reports as `ephemeral` — "this process cannot see your
 * browser", not "that memory does not exist".
 */
export async function handleOpenMemory(params: { handle: string }): Promise<never> {
  throw new Error(
    `cannot open memory ${params.handle}: handles are resolvable only by the browser that issued them. ` +
      `Connect the extension to this MCP process over the native bridge ` +
      `(on by default; EXOCORTEX_NATIVE_BRIDGE=0 disables it).`
  );
}

/**
 * Tool 12: exocortex_semantic_search (Spec Section 5)
 */
/**
 * `queryVector` is a second argument rather than a field on `params` on purpose:
 * only the extension can produce one (the embedder lives in the offscreen document),
 * so the service worker injects it *after* the bridge has validated the caller's
 * arguments. An MCP client cannot supply or forge one over the wire.
 *
 * Without it — which is every unbridged call — this degrades to lexical ranking and
 * each result says so via `matchKind`, instead of reporting a fabricated similarity.
 */
export async function handleSemanticSearch(
  params: SemanticSearchParams,
  queryVector?: number[]
): Promise<unknown[]> {
  const query = (params.query || "").trim();
  if (!query) throw new Error("semantic search query is required");
  if (isSearchQueryBlocked(query)) throw new Error("Search query matches privacy blocklist");

  const results = await hybridVectorSearch({
    queryVector,
    queryText: query,
    sourceType: params.sourceType,
    limit: params.limit || 10,
    minScore: params.min_score || 0.0
  });

  if (results.length === 0) {
    const memoryResults = await handleSearchMemory({ query, limit: params.limit || 10 });
    return memoryResults.map((m) => ({
      frameId: -1,
      url: m.url,
      title: m.title,
      summary: m.excerpt,
      matchKind: "lexical" as const,
      cosineSimilarity: null,
      score: m.score || 0.5,
      timestamp: m.parsedAt
    }));
  }

  return results;
}

/**
 * Tool 13: exocortex_summarize_page (Spec Section 5)
 */
export async function handleSummarizePage(params: SummarizePageParams): Promise<{
  url?: string;
  title?: string;
  summary: string;
}> {
  let title = "Page Summary";
  let content = "";
  let pageUrl = params.url || "";

  if (params.frame_id) {
    const frame = await db.frames.get(params.frame_id);
    if (frame) {
      title = frame.title;
      content = frame.summary || frame.title;
      pageUrl = frame.url;
    }
  }

  if (!content && pageUrl) {
    const pt = await db.page_text.where("url").equals(pageUrl).first();
    if (pt) {
      title = pt.title;
      content = pt.textContent || pt.excerpt || "";
    }
  }

  if (!content) {
    const latestPt = await db.page_text.orderBy("parsedAt").reverse().first();
    if (latestPt) {
      title = latestPt.title;
      content = latestPt.textContent || latestPt.excerpt || "";
      pageUrl = latestPt.url;
    }
  }

  if (!content) {
    return {
      url: pageUrl,
      title,
      summary: "No page content available to summarize."
    };
  }

  const aiSummary = await summarizePageWithAi(title, content);
  const summary = aiSummary || (content.length > 250 ? content.slice(0, 247) + "..." : content);

  return {
    url: pageUrl,
    title,
    summary
  };
}

/**
 * Tool 14: exocortex_record_desktop_frame (Task #166)
 */
export async function handleRecordDesktopFrame(params: RecordDesktopFrameParams): Promise<{
  status: string;
  frameId: number;
}> {
  const frameId = await recordDesktopFrame(
    params.appName,
    params.windowTitle,
    params.dwellTimeSeconds ?? 2
  );

  return {
    status: "success",
    frameId
  };
}

/**
 * Tool 16: exocortex_get_sanitized_telemetry_export (Task #214 / Option B)
 * Returns sanitized high-level cognitive/fatigue metrics for cross-device hub sync without exposing page content.
 */
export async function handleGetSanitizedTelemetryExport(params?: { sourceDevice?: string }): Promise<unknown> {
  return await stateObserver.getSanitizedTelemetryExport(params?.sourceDevice || "local");
}

/**
 * Tool 17: exocortex_get_bridge_status (Task #660)
 * Returns explicit status of the native browser bridge and current data-path mode.
 */
export async function handleGetBridgeStatus(bridgeInfo?: {
  listening: boolean;
  peerConnected: boolean;
  socketPath: string;
}): Promise<BridgeStatusResponse> {
  const isListening = bridgeInfo?.listening ?? false;
  const isPeerConnected = bridgeInfo?.peerConnected ?? false;
  const socketPath = bridgeInfo?.socketPath ?? (process.env.EXOCORTEX_NATIVE_BRIDGE_SOCKET || `${process.env.XDG_RUNTIME_DIR || "/tmp"}/exocortex-mcp-bridge.sock`);
  const mode = isListening ? "native_bridge" : "ephemeral";

  let summary: string;
  if (isListening && isPeerConnected) {
    summary = "Native browser bridge is ACTIVE and CONNECTED to the Chrome extension. Real browser data is accessible.";
  } else if (isListening) {
    summary = "Native browser bridge is LISTENING, but no Chrome extension is connected. Ensure the Exocortex extension is running in Chrome.";
  } else {
    summary = "Running in EPHEMERAL mode with an in-process database. Real browser data is NOT accessible.";
  }

  return {
    mode,
    bridgeListening: isListening,
    peerConnected: isPeerConnected,
    socketPath,
    bridgeBackedTools: Array.from(BRIDGE_BACKED_TOOLS).sort(),
    summary
  };
}
