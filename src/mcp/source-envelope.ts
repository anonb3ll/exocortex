/**
 * Provenance envelope for MCP tool responses.
 *
 * The problem this exists to solve: `src/mcp/cli.ts` imports
 * `fake-indexeddb/auto` at module load, so the MCP process runs its own
 * in-memory IndexedDB that nothing ever writes to. Only the tools listed in
 * `BRIDGE_BACKED_TOOLS` are intercepted by the native bridge, and only while
 * it is enabled (the default; `EXOCORTEX_NATIVE_BRIDGE=0` turns it off) and the
 * extension is connected. Every other tool answers from that empty
 * database — and answers *cleanly*, so an agent cannot tell "your browser has
 * no such memory" from "this process cannot see your browser at all".
 *
 * Wrapping every response makes the distinction visible without changing any
 * handler. `source` is a property of where the answer came from, not of the
 * answer's content, so an empty live result stays a legitimate empty result.
 */

/**
 * Tools the native bridge can currently serve from the real browser database.
 *
 * Extended by roadmap item 5.2 from a single tool (exocortex_search_memory)
 * to every tool with a corresponding entry in `src/bridge/protocol.ts`'s
 * `BRIDGE_ARG_VALIDATORS`/`minimizeBridgeResult`, plus a mapping in
 * `TOOL_TO_BRIDGE_TYPE` (src/mcp/cli.ts). Adding a tool here without all
 * three will produce a `live` label over a failed call, or fail loudly in
 * tests/bridge-protocol.test.ts — the three lists are asserted to agree.
 */
export const BRIDGE_BACKED_TOOLS = new Set<string>([
  "exocortex_search_memory",
  "exocortex_query_frames",
  "exocortex_semantic_search",
  "exocortex_get_working_memory_stack",
  "exocortex_restore_context",
  "exocortex_get_focus_anchor",
  "exocortex_set_focus_anchor",
  "exocortex_project_task_reference",
  "exocortex_get_cognitive_load_telemetry",
  "exocortex_get_sanitized_telemetry_export",
  "exocortex_open_memory"
]);

/** Tools whose effect is a write, where an ephemeral store silently discards it. */
export const WRITE_TOOLS = new Set<string>([
  "exocortex_record_frame",
  "exocortex_record_desktop_frame",
  "exocortex_create_cognitive_checkpoint",
  "exocortex_set_focus_anchor",
]);

export type ResponseSource = "live" | "ephemeral";

export interface EnvelopedResponse<T = unknown> {
  /**
   * `live` — served by the native bridge from the browser's real IndexedDB.
   * `ephemeral` — served from this process's in-memory database, which starts
   * empty and is discarded on exit.
   */
  source: ResponseSource;
  /** Present only when `source` is `ephemeral`. Absent on a live answer. */
  warning?: string;
  data: T;
}

const READ_WARNING =
  "EPHEMERAL: this result came from an empty in-process database, not your browser. " +
  "An empty or missing result here is NOT evidence that the memory does not exist. " +
  "Only tools in BRIDGE_BACKED_TOOLS reach real browser data, and only when the native " +
  "bridge is on (the default; EXOCORTEX_NATIVE_BRIDGE=0 disables it) and the extension is connected.";

const WRITE_WARNING =
  "EPHEMERAL: this write went to an in-process database that is discarded when the " +
  "MCP process exits. Nothing was persisted to your browser, and no later read — " +
  "from this process or any other — will see it.";

/**
 * Whether a tool call served without the bridge should be labelled ephemeral.
 *
 * `exocortex_align_federated_kg` writes markdown to the Obsidian vault over the
 * filesystem, which is genuinely durable — but it sources the entities it
 * writes from the same empty database, so an unbridged run produces a real file
 * containing nothing. It is labelled ephemeral for that reason.
 */
export function isEphemeral(toolName: string, servedByBridge: boolean): boolean {
  return !(servedByBridge && BRIDGE_BACKED_TOOLS.has(toolName));
}

/** Wrap a handler result in its provenance envelope. */
export function envelope<T>(
  toolName: string,
  result: T,
  servedByBridge: boolean,
): EnvelopedResponse<T> {
  if (!isEphemeral(toolName, servedByBridge)) {
    return { source: "live", data: result };
  }
  return {
    source: "ephemeral",
    warning: WRITE_TOOLS.has(toolName) ? WRITE_WARNING : READ_WARNING,
    data: result,
  };
}

/**
 * One-line startup banner naming the process's data reality.
 *
 * Written to stderr so it lands in the MCP host's server log, which is where
 * someone debugging "why does Exocortex know nothing" actually looks.
 */
export function startupProvenanceBanner(bridgeActive: boolean): string {
  return bridgeActive
    ? "[Exocortex MCP] Data source: native bridge for " +
        `${[...BRIDGE_BACKED_TOOLS].join(", ")}; all other tools read an EMPTY in-process database.`
    : "[Exocortex MCP] Data source: EMPTY in-process database for ALL tools. " +
        "No tool can see real browser memory. The native bridge is off (EXOCORTEX_NATIVE_BRIDGE=0); " +
        "unset it and connect the extension.";
}
