import type { CognitiveStateFrame } from "../lib/db";

export type ExocortexToolName =
  | "exocortex_get_focus_anchor"
  | "exocortex_project_focus_anchor"
  | "exocortex_project_task_reference"
  | "exocortex_query_frames"
  | "exocortex_search_memory"
  | "exocortex_detect_drift"
  | "exocortex_record_frame"
  | "exocortex_get_working_memory_stack"
  | "exocortex_create_cognitive_checkpoint"
  | "exocortex_restore_context"
  | "exocortex_get_cognitive_load_telemetry"
  | "exocortex_search_semantic_vault"
  | "exocortex_set_focus_anchor"
  | "exocortex_semantic_search"
  | "exocortex_summarize_page"
  | "exocortex_record_desktop_frame"
  | "exocortex_align_federated_kg"
  | "exocortex_get_sanitized_telemetry_export"
  | "exocortex_get_bridge_status"
  | "exocortex_open_memory";


export interface ProjectFocusAnchorParams {
  originMachine?: string;
  trustTier?: "local" | "remote" | "vault";
  consentBasis?: "explicit_user_action" | "standing_local_capture" | "derived_aggregate";
}

export interface ProjectTaskReferenceParams extends ProjectFocusAnchorParams {
  taskId: number;
  confidence: number;
}

export interface AlignFederatedKgParams {
  vaultPath?: string;
  targetSubdir?: string;
  dryRun?: boolean;
}

export interface CreateCheckpointParams {
  goalTitle: string;
  primaryFocusEntity: string;
  stateSummary: string;
  openTabsContext?: { url: string; title: string; excerpt?: string }[];
}

export interface RestoreContextParams {
  focusEntity?: string;
}

export interface SearchSemanticVaultParams {
  query?: string;
  primaryFocusEntity?: string;
  limit?: number;
}

export interface SetFocusAnchorParams {
  goalTitle: string;
  primaryFocusEntity: string;
  workingStateSummary?: string;
  intentCategory?: CognitiveStateFrame["userState"]["intentCategory"];
}

export interface SemanticSearchParams {
  query: string;
  limit?: number;
  min_score?: number;
  sourceType?: "web" | "pdf" | "desktop_window";
}

export interface SummarizePageParams {
  frame_id?: number;
  url?: string;
}

export interface RecordDesktopFrameParams {
  appName: string;
  windowTitle: string;
  dwellTimeSeconds?: number;
  ocrText?: string;
}

export interface FocusAnchorResponse {
  activeFocusEntity: string | null;
  workingStateSummary: string | null;
  intentCategory: CognitiveStateFrame["userState"]["intentCategory"] | null;
  cognitiveLoadLevel: CognitiveStateFrame["userState"]["cognitiveLoadLevel"] | null;
  timestampUtc: number | null;
  url: string | null;
}

export interface QueryFramesParams {
  intentCategory?: CognitiveStateFrame["userState"]["intentCategory"];
  primaryFocusEntity?: string;
  limit?: number;
  sinceTimestamp?: number;
}

export interface SearchMemoryParams {
  query: string;
  limit?: number;
}

export interface SearchMemoryResult {
  url: string;
  title: string;
  excerpt: string;
  parsedAt: number;
  score?: number;
}

export interface RecordFrameParams {
  sessionId?: string;
  sourceDevice?: "browser" | "desktop" | "mobile" | "iot";
  intentCategory: CognitiveStateFrame["userState"]["intentCategory"];
  primaryFocusEntity: string;
  workingStateSummary: string;
  url?: string;
  pageTitle?: string;
  cleanTextExcerpt?: string;
  userActions?: string[];
  cognitiveLoadLevel?: CognitiveStateFrame["userState"]["cognitiveLoadLevel"];
  frictionScore?: number;
}

export interface BridgeStatusResponse {
  mode: "native_bridge" | "ephemeral";
  bridgeListening: boolean;
  peerConnected: boolean;
  socketPath: string;
  bridgeBackedTools: string[];
  summary: string;
}
