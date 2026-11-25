/**
 * Layer 4: the MCP tool surface, over stdio, against the real binary.
 *
 * This spawns `bun src/mcp/cli.ts` and talks JSON-RPC to it rather than
 * importing the registry, and the distinction is the entire point: importing
 * EXOCORTEX_MCP_TOOLS proves an array exists, while spawning proves the process
 * starts, survives its own imports (cli.ts pulls in fake-indexeddb and the
 * Dexie singleton at module load), and answers. A server that crashes on
 * startup exports a perfectly good array.
 *
 * The tool set is asserted as a set, not a count. A count catches a deletion
 * but passes a rename, and a rename is the silent breakage — every configured
 * client keeps calling the old name and gets "unknown tool" at runtime.
 */

import { describe, expect, test } from "bun:test";

// Every tool the server is contracted to expose. Adding a tool should require
// editing this list — that is the review checkpoint, not an inconvenience.
const EXPECTED_TOOLS = [
  "exocortex_align_federated_kg",
  "exocortex_create_cognitive_checkpoint",
  "exocortex_detect_drift",
  "exocortex_get_bridge_status",
  "exocortex_get_cognitive_load_telemetry",
  "exocortex_get_focus_anchor",
  "exocortex_get_sanitized_telemetry_export",
  "exocortex_open_memory",
  "exocortex_get_working_memory_stack",
  "exocortex_project_focus_anchor",
  "exocortex_project_task_reference",
  "exocortex_query_frames",
  "exocortex_record_desktop_frame",
  "exocortex_record_frame",
  "exocortex_restore_context",
  "exocortex_search_memory",
  "exocortex_search_semantic_vault",
  "exocortex_semantic_search",
  "exocortex_set_focus_anchor",
  "exocortex_summarize_page",
].sort();

const SPAWN_TIMEOUT_MS = 30_000;

interface RpcResult {
  responses: Record<string, unknown>[];
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn the CLI, write each request as a line, and collect the replies.
 *
 * Reads until `expected` responses have arrived rather than until the process
 * exits: the server is a long-lived stdio loop and will never exit on its own.
 */
async function rpc(requests: unknown[], expected: number): Promise<RpcResult> {
  return rpcRaw([requests.map((r) => JSON.stringify(r)).join("\n") + "\n"], expected);
}

/**
 * Same, but writes caller-controlled raw byte chunks with a gap between them.
 *
 * stdin is a byte stream: the client controls where a request is split, not the
 * server. This lets a test put a chunk boundary mid-token, which is what a large
 * request does in practice through a pipe.
 */
async function rpcRaw(chunks: string[], expected: number): Promise<RpcResult> {
  const proc = Bun.spawn(["bun", "src/mcp/cli.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...Bun.env,
      EXOCORTEX_NATIVE_BRIDGE: "0",
      EXOCORTEX_DESKTOP_POLLING: "0",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const responses: Record<string, unknown>[] = [];
  let stderr = "";
  const stderrDone = (async () => {
    stderr = await new Response(proc.stderr).text();
  })();

  void (async () => {
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await Bun.sleep(150);
      proc.stdin.write(chunk);
      proc.stdin.flush();
    }
  })();

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (responses.length < expected && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    proc.kill();
    await stderrDone.catch(() => {});
  }

  return { responses, stderr, exitCode: proc.exitCode };
}

describe("the MCP server over stdio", () => {
  test(
    "initializes and lists exactly the contracted tool set",
    async () => {
      const { responses, stderr } = await rpc(
        [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ],
        2,
      );

      const init = responses.find((r) => r.id === 1) as
        | { result?: { serverInfo?: { name?: string }; protocolVersion?: string } }
        | undefined;
      expect(init, `no initialize response; stderr was: ${stderr}`).toBeDefined();
      expect(init?.result?.serverInfo?.name).toBe("exocortex");
      expect(init?.result?.protocolVersion).toBe("2024-11-05");

      const list = responses.find((r) => r.id === 2) as
        | { result?: { tools?: { name: string }[] } }
        | undefined;
      expect(list, `no tools/list response; stderr was: ${stderr}`).toBeDefined();

      const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
      // Set equality in both directions: a dropped tool and a tool nobody
      // declared are both failures, and only this catches a rename.
      expect(names).toEqual(EXPECTED_TOOLS);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "every listed tool carries a description and an input schema",
    async () => {
      const { responses } = await rpc(
        [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
        1,
      );
      const tools =
        ((responses[0] as { result?: { tools?: Record<string, unknown>[] } })?.result?.tools) ?? [];

      expect(tools.length).toBe(EXPECTED_TOOLS.length);
      for (const tool of tools) {
        // A tool with no description is invisible to a model choosing between
        // fifteen of them — advertised but unusable.
        expect(tool.description, `${tool.name} has no description`).toBeTruthy();
        expect(tool.inputSchema, `${tool.name} has no inputSchema`).toBeDefined();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "refuses a blocklisted semantic_search call with the guard error",
    async () => {
      const { responses } = await rpc(
        [{
          jsonrpc: "2.0",
          id: 55,
          method: "tools/call",
          params: {
            name: "exocortex_semantic_search",
            arguments: { query: "chase.com", limit: 1 },
          },
        }],
        1,
      );

      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 55,
        error: { code: -32001, message: "Search query matches privacy blocklist" },
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "answers ping, so the loop survives an unrecognised-looking request",
    async () => {
      const { responses } = await rpc([{ jsonrpc: "2.0", id: 9, method: "ping" }], 1);
      expect(responses[0]).toMatchObject({ jsonrpc: "2.0", id: 9, result: {} });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "reassembles a request split across stdin chunks",
    async () => {
      // The server used to split each 'data' chunk independently, so a request
      // delivered in two pieces became two unparseable halves. Both failed
      // JSON.parse, the error handler's re-parse failed too, and the client got
      // neither a result nor an error — it just hung. A long stateSummary through
      // a pipe is enough to trigger it in normal use.
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "exocortex_record_frame",
          arguments: {
            intentCategory: "Deep Work (Drafting/Coding)",
            primaryFocusEntity: "Split Request",
            workingStateSummary: "S".repeat(2000),
          },
        },
      });
      const cut = Math.floor(request.length / 2);
      // Deliberately mid-token, which is what a pipe boundary actually does.
      const { responses, stderr } = await rpcRaw(
        [request.slice(0, cut), request.slice(cut) + "\n"],
        1,
      );

      expect(responses.length, `no response to a split request; stderr was: ${stderr}`).toBe(1);
      expect(responses[0]).toMatchObject({ jsonrpc: "2.0", id: 42 });
      expect(responses[0]).toHaveProperty("result");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "answers an unknown method with -32601 rather than silence",
    async () => {
      // A client cannot tell silence from a hung server. Unknown methods used to
      // fall off the end of the dispatch chain with no reply at all — including
      // resources/list and prompts/list, which real MCP clients probe for.
      const { responses } = await rpc(
        [{ jsonrpc: "2.0", id: 7, method: "resources/list", params: {} }],
        1,
      );
      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601 },
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "stays silent for a notification, which has no id to answer",
    async () => {
      // The -32601 path must not invent a reply to a notification. Ask for a ping
      // afterwards: if the notification were answered, this would see two responses.
      const { responses } = await rpc(
        [
          { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
          { jsonrpc: "2.0", id: 3, method: "ping" },
        ],
        1,
      );
      expect(responses.length).toBe(1);
      expect(responses[0]).toMatchObject({ id: 3, result: {} });
    },
    SPAWN_TIMEOUT_MS,
  );
});
