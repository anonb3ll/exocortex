#!/usr/bin/env node
import "fake-indexeddb/auto";
import { NativeBridgeServer, type BridgeRequestType } from "../bridge/server";
import { BRIDGE_BACKED_TOOLS, envelope, startupProvenanceBanner } from "./source-envelope";
// Maps an MCP tool name to the bridge protocol's own (shorter, MCP-agnostic)
// request-type vocabulary. Every BRIDGE_BACKED_TOOLS entry must appear here —
// tests/bridge-protocol.test.ts asserts the two sets agree, so a typo or a
// forgotten entry fails a test instead of silently falling through to the
// empty in-process database while still being labelled `live`.
export const TOOL_TO_BRIDGE_TYPE: Record<string, BridgeRequestType> = {
  exocortex_search_memory: "search_memory",
  exocortex_query_frames: "query_frames",
  exocortex_semantic_search: "semantic_search",
  exocortex_get_working_memory_stack: "get_working_memory_stack",
  exocortex_restore_context: "restore_context",
  exocortex_get_focus_anchor: "get_focus_anchor",
  exocortex_set_focus_anchor: "set_focus_anchor",
  exocortex_project_task_reference: "project_task_reference",
  exocortex_get_cognitive_load_telemetry: "get_cognitive_load_telemetry",
  exocortex_get_sanitized_telemetry_export: "get_sanitized_telemetry_export",
  exocortex_open_memory: "open_memory"
};

// Imported dynamically, and it must stay that way. Dexie captures the
// IndexedDB implementation into `Dexie.dependencies` when the `dexie` module
// itself evaluates, and under Bun a static `import "./server"` pulls Dexie in
// before the `fake-indexeddb/auto` side effect above has landed. The result was
// `Dexie.dependencies.indexedDB === undefined` and a MissingAPIError on every
// single tools/call — the whole tool surface, not just an empty one.
// `tests/fixtures/e2e-seeded-mcp-server.ts` has always done it this way, which
// is why the e2e path passed while the shipped binary did not.
const { EXOCORTEX_MCP_TOOLS, executeExocortexMcpTool } = await import("./server");
const { startDesktopWindowPoller, resolveDesktopPolling } = await import("./desktop-ingest");

console.error("[Exocortex MCP] Memory Interface Server started on stdio.");

const bridgeEnabled = process.env.EXOCORTEX_NATIVE_BRIDGE !== "0";
const socketPath =
  process.env.EXOCORTEX_NATIVE_BRIDGE_SOCKET ||
  `${process.env.XDG_RUNTIME_DIR || "/tmp"}/exocortex-mcp-bridge.sock`;

let nativeBridge = bridgeEnabled ? new NativeBridgeServer(socketPath) : null;
if (nativeBridge) {
  try {
    await nativeBridge.start();
    console.error(`[Exocortex MCP] Native browser bridge ready on socket: ${socketPath}`);
  } catch (err) {
    // A bridge that failed to start cannot serve anything, so it must not be
    // allowed to label a response `live` on the strength of merely existing.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Exocortex MCP] Native browser bridge unavailable: ${message}`);
    nativeBridge = null;
  }
} else {
  console.error("[Exocortex MCP] Native browser bridge disabled (EXOCORTEX_NATIVE_BRIDGE=0).");
}
console.error(startupProvenanceBanner(Boolean(nativeBridge)));

const desktopPolling = resolveDesktopPolling();
let stopDesktopPoller: (() => void) | null = null;
if (desktopPolling.enabled) {
  const pollInterval = Number(process.env.EXOCORTEX_DESKTOP_POLL_INTERVAL_MS) || 2000;
  stopDesktopPoller = startDesktopWindowPoller(pollInterval);
  console.error(`[Exocortex MCP] Desktop active-window poller started (${desktopPolling.reason}; interval: ${pollInterval}ms).`);
} else {
  console.error(
    `[Exocortex MCP] Desktop active-window poller off (${desktopPolling.reason}). ` +
      "omaCortex is the durable OS-level desktop source; see docs/desktop-ingest.md."
  );
}

process.on("exit", () => {
  stopDesktopPoller?.();
  void nativeBridge?.close();
});

// stdin is a byte stream, not a line stream: a single JSON-RPC request can arrive
// split across two 'data' events, and two requests can arrive in one. Splitting each
// chunk independently — as this did — turned a large request (a long
// cleanTextExcerpt on exocortex_record_frame, a 2000-char stateSummary) into two
// unparseable halves. Both failed JSON.parse, the catch below re-parsed and failed
// too, so NO response and NO error was ever written and the client hung forever.
// bridge/server.ts:69 and scripts/exocortex-native-host.ts already frame correctly;
// this is the same pattern. The trailing partial line is carried to the next chunk.
let stdinBuffer = "";

process.stdin.on("data", async (chunk: Buffer | string) => {
  // Split synchronously, before any await, so concurrent 'data' events cannot
  // interleave and corrupt the carried partial line.
  stdinBuffer += chunk.toString();
  const lines = stdinBuffer.split("\n");
  stdinBuffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "exocortex", version: "0.1.0" }
          }
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "notifications/initialized") {
        // Notification, no response needed
      } else if (request.method === "ping") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: {}
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "tools/list") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: EXOCORTEX_MCP_TOOLS }
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "tools/call") {
        const { name, arguments: toolArgs } = request.params || {};
        let result: unknown;
        let servedByBridge = false;

        if (name === "exocortex_get_bridge_status") {
          result = await executeExocortexMcpTool(name, {
            ...toolArgs,
            bridgeInfo: {
              listening: Boolean(nativeBridge?.isListening()),
              peerConnected: Boolean(nativeBridge?.isPeerConnected()),
              socketPath: nativeBridge?.getPath() || socketPath
            }
          });
          servedByBridge = Boolean(nativeBridge?.isListening());
        } else {
          // A bridge miss stays an error rather than falling back to the empty
          // in-process database: the S1 contract is fail-closed within 2s, and a
          // warned-but-answered fallback would defeat it.
          const bridgeType = TOOL_TO_BRIDGE_TYPE[name];
          servedByBridge = Boolean(nativeBridge) && BRIDGE_BACKED_TOOLS.has(name) && bridgeType !== undefined;
          result = servedByBridge
            ? await nativeBridge!.request(bridgeType, toolArgs || {})
            : await executeExocortexMcpTool(name, toolArgs);
        }

        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: JSON.stringify(envelope(name, result, servedByBridge), null, 2) }] }
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.id !== undefined) {
        // Every request must get a reply. Unknown methods (resources/list,
        // prompts/list, anything a future client probes with) previously fell off
        // the end of this chain and were answered with silence, which a client
        // cannot distinguish from a hung server. Notifications — no id — are
        // correctly left unanswered.
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` }
        }) + "\n");
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : "Invalid request";
      console.error("[Exocortex MCP] Request failed:", error);
      try {
        const request = JSON.parse(line);
        if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: error } }) + "\n");
      } catch { /* malformed JSON has no trustworthy request id */ }
    }
  }
});
