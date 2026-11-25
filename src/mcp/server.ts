import {
  handleGetFocusAnchor,
  handleProjectFocusAnchor,
  handleProjectTaskReference,
  handleQueryFrames,
  handleSearchMemory,
  handleOpenMemory,
  handleDetectDrift,
  handleRecordFrame,
  handleGetWorkingMemoryStack,
  handleCreateCognitiveCheckpoint,
  handleRestoreContext,
  handleGetCognitiveLoadTelemetry,
  handleSearchSemanticVault,
  handleSetFocusAnchor,
  handleSemanticSearch,
  handleSummarizePage,
  handleRecordDesktopFrame,
  handleGetSanitizedTelemetryExport,
  handleGetBridgeStatus
} from "./tools";
import { alignFederatedKgToVault } from "./federated-kg-aligner";
import type { ExocortexToolName } from "./types";

export const EXOCORTEX_MCP_TOOLS = [
  {
    name: "exocortex_get_focus_anchor",
    description: "Get the user's active focus entity, working state summary, and cognitive load level.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "exocortex_project_focus_anchor",
    description:
      "Project the current focus anchor onto the Exocortex -> unified-agent contract v1 (kind: focus_anchor). Returns the minimised wire record; combine with a task id and pass to unified-agent's browser_derive_task_reference to link browsing context to a task. Throws if nothing has been captured yet.",
    inputSchema: {
      type: "object",
      properties: {
        originMachine: { type: "string", default: "desktop", description: "Label for the capturing machine (self-asserted, not a security claim in v1)." },
        trustTier: { type: "string", enum: ["local", "remote", "vault"], default: "local" },
        consentBasis: {
          type: "string",
          enum: ["explicit_user_action", "standing_local_capture", "derived_aggregate"],
          default: "standing_local_capture"
        }
      }
    }
  },
  {
    name: "exocortex_project_task_reference",
    description:
      "Project the current focus anchor into a contract-v1 task_reference edge for a unified-agent task. The receiver must independently validate that the task exists and is non-terminal; this tool only returns the minimised record and never writes to the task database.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "integer", minimum: 1, description: "Positive unified-agent task id." },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Caller-supplied relation confidence." },
        originMachine: { type: "string", default: "desktop" },
        trustTier: { type: "string", enum: ["local", "remote", "vault"], default: "local" },
        consentBasis: { type: "string", enum: ["explicit_user_action", "standing_local_capture", "derived_aggregate"], default: "standing_local_capture" }
      },
      required: ["taskId", "confidence"]
    }
  },
  {
    name: "exocortex_query_frames",
    description: "Query recent Cognitive State Frames filtered by intent category, focus entity, or timeframe.",
    inputSchema: {
      type: "object",
      properties: {
        intentCategory: {
          type: "string",
          enum: [
            "Deep Work (Drafting/Coding)",
            "Research & Gathering",
            "Task Execution & Ops",
            "Communication & Async",
            "Distraction / Rabbit Hole",
            "Idle / Transition"
          ]
        },
        primaryFocusEntity: { type: "string" },
        limit: { type: "number", default: 10 },
        sinceTimestamp: { type: "number" }
      }
    }
  },
  {
    name: "exocortex_search_memory",
    description: "Search across the user's digital memory vault (page texts, excerpts, and titles). Over the live browser bridge each result is minimized to {parsedAt, score, handle} — page text, titles and URLs never leave the browser. Pass a handle to exocortex_open_memory to act on a result without reading it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or keyword" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "exocortex_detect_drift",
    description: "Check recent cognitive state for rabbit holes, context drift, and active soft nudges.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "exocortex_record_frame",
    description: "Universal ingestion tool to record a cognitive frame from Desktop, Mobile, or IoT sensors.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDevice: { type: "string", enum: ["browser", "desktop", "mobile", "iot"], default: "desktop" },
        intentCategory: { type: "string" },
        primaryFocusEntity: { type: "string" },
        workingStateSummary: { type: "string" },
        url: { type: "string" },
        pageTitle: { type: "string" },
        cleanTextExcerpt: { type: "string" }
      },
      required: ["intentCategory", "primaryFocusEntity", "workingStateSummary"]
    }
  },
  {
    name: "exocortex_get_working_memory_stack",
    description: "Retrieve the active goal stack and working memory context history.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "exocortex_create_cognitive_checkpoint",
    description: "Explicitly anchor a working memory snapshot for a goal or deep work task.",
    inputSchema: {
      type: "object",
      properties: {
        goalTitle: { type: "string" },
        primaryFocusEntity: { type: "string" },
        stateSummary: { type: "string" }
      },
      required: ["goalTitle", "primaryFocusEntity", "stateSummary"]
    }
  },
  {
    name: "exocortex_restore_context",
    description: "Generates a zero-friction mental state resumption summary for a previous focus context.",
    inputSchema: {
      type: "object",
      properties: {
        focusEntity: { type: "string" }
      }
    }
  },
  {
    name: "exocortex_get_cognitive_load_telemetry",
    description: "Get real-time continuous cognitive load, fatigue indices, and context switch cost.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "exocortex_search_semantic_vault",
    description: "Search historical knowledge snippets in the Semantic Vault by keyword and focus-entity relevance. Cosine similarity additionally weights the ranking only when called from the extension, which is the only context that can embed the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        primaryFocusEntity: { type: "string" },
        limit: { type: "number", default: 10 }
      }
    }
  },
  {
    name: "exocortex_set_focus_anchor",
    description: "Bi-directional orchestration tool allowing external agents to push a new active goal focus anchor into Exocortex.",
    inputSchema: {
      type: "object",
      properties: {
        goalTitle: { type: "string" },
        primaryFocusEntity: { type: "string" },
        workingStateSummary: { type: "string" },
        intentCategory: { type: "string" }
      },
      required: ["goalTitle", "primaryFocusEntity"]
    }
  },
  {
    name: "exocortex_open_memory",
    description: "Open a memory in the user's browser by its opaque handle from exocortex_search_memory. The browser resolves the handle and opens the page; the handle is never resolved to a URL on this side and no page content is returned. Requires the live browser bridge.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Opaque handle from an exocortex_search_memory result, e.g. 'mem_12'" }
      },
      required: ["handle"]
    }
  },
  {
    name: "exocortex_semantic_search",
    description: "Two-stage search over recent frames, ranked by similarity, recency and dwell time. Stage two rescores by MiniLM cosine similarity when the browser can embed the query and the candidate has a stored model embedding; otherwise it ranks by lexical token overlap. Every result reports matchKind ('vector' or 'lexical') and cosineSimilarity is null for lexical matches — check it before treating a hit as semantic.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 10 },
        min_score: { type: "number", default: 0.0 },
        sourceType: { type: "string", enum: ["web", "pdf", "desktop_window"] }
      },
      required: ["query"]
    }
  },
  {
    name: "exocortex_summarize_page",
    description: "Generate a 2-sentence executive summary of page context using on-device Chrome window.ai or local summary engine.",
    inputSchema: {
      type: "object",
      properties: {
        frame_id: { type: "number", description: "Optional frame ID" },
        url: { type: "string", description: "Optional page URL" }
      }
    }
  },
  {
    name: "exocortex_record_desktop_frame",
    description: "Record a native desktop active window transition frame (IDE, Terminal, Desktop App).",
    inputSchema: {
      type: "object",
      properties: {
        appName: { type: "string", description: "Desktop Application Name (e.g. VS Code, Terminal)" },
        windowTitle: { type: "string", description: "Active Window Title" },
        dwellTimeSeconds: { type: "number", default: 2 },
        ocrText: { type: "string" }
      },
      required: ["appName", "windowTitle"]
    }
  },
  {
    name: "exocortex_align_federated_kg",
    description: "Synchronize Exocortex browser KG entities with the Obsidian vault Wiki layer as interlinked markdown notes. Respects vault write boundaries, locked notes, and human-curated authority.",
    inputSchema: {
      type: "object",
      properties: {
        vaultPath: { type: "string", description: "Vault root path (default: UA_VAULT_PATH, otherwise ~/vaults/main)" },
        targetSubdir: { type: "string", default: "Wiki" },
        dryRun: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "exocortex_get_sanitized_telemetry_export",
    description: "Export sanitized high-level cognitive/fatigue telemetry metrics for cross-device hub synchronization under Decision 2026-07-29 Option B. Excludes DOM, page titles, URLs, and clean text excerpts.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDevice: { type: "string", default: "local" }
      }
    }
  },
  {
    name: "exocortex_get_bridge_status",
    description: "Get explicit availability status of the native browser bridge and current data-path mode (native_bridge vs ephemeral).",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

export async function executeExocortexMcpTool(name: ExocortexToolName | string, args: Record<string, any> = {}): Promise<any> {
  switch (name) {
    case "exocortex_get_focus_anchor":
      return await handleGetFocusAnchor();
    case "exocortex_project_focus_anchor":
      return await handleProjectFocusAnchor(args as any);
    case "exocortex_project_task_reference":
      return await handleProjectTaskReference(args as any);
    case "exocortex_query_frames":
      return await handleQueryFrames(args);
    case "exocortex_search_memory":
      return await handleSearchMemory(args as any);
    case "exocortex_detect_drift":
      return await handleDetectDrift();
    case "exocortex_record_frame":
      return await handleRecordFrame(args as any);
    case "exocortex_get_working_memory_stack":
      return await handleGetWorkingMemoryStack();
    case "exocortex_create_cognitive_checkpoint":
      return await handleCreateCognitiveCheckpoint(args as any);
    case "exocortex_restore_context":
      // Only the field the tool declares: an MCP request must not be able to ask
      // for the local, un-redacted prompt.
      return await handleRestoreContext({ focusEntity: (args as { focusEntity?: string } | undefined)?.focusEntity });
    case "exocortex_get_cognitive_load_telemetry":
      return await handleGetCognitiveLoadTelemetry();
    case "exocortex_search_semantic_vault":
      return await handleSearchSemanticVault(args as any);
    case "exocortex_set_focus_anchor":
      return await handleSetFocusAnchor(args as any);
    case "exocortex_semantic_search":
      return await handleSemanticSearch(args as any);
    case "exocortex_summarize_page":
      return await handleSummarizePage(args as any);
    case "exocortex_record_desktop_frame":
      return await handleRecordDesktopFrame(args as any);
    case "exocortex_align_federated_kg":
      return await alignFederatedKgToVault(args as any);
    case "exocortex_get_sanitized_telemetry_export":
      return await handleGetSanitizedTelemetryExport(args as any);
    case "exocortex_open_memory":
      return await handleOpenMemory(args as any);
    case "exocortex_get_bridge_status":
      return await handleGetBridgeStatus(args.bridgeInfo);
    default:
      throw new Error(`Unknown Exocortex MCP tool: ${name}`);
  }
}
