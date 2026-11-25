/**
 * The provenance envelope, asserted two ways: as a unit over the pure wrapper,
 * and over the real `bun src/mcp/cli.ts` binary via stdio.
 *
 * The stdio half is the one that matters. `envelope()` returning the right
 * object proves a function works; spawning the CLI proves that the process
 * agents actually talk to labels its answers — which is the entire failure mode
 * this exists to close. A correct wrapper nobody calls is the bug, not the fix.
 */

import { describe, expect, test } from "bun:test";
import {
  BRIDGE_BACKED_TOOLS,
  WRITE_TOOLS,
  envelope,
  isEphemeral,
  startupProvenanceBanner,
} from "../src/mcp/source-envelope";

const SPAWN_TIMEOUT_MS = 30_000;

async function callTool(name: string, args: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "src/mcp/cli.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  let stderr = "";
  const stderrDone = (async () => {
    stderr = await new Response(proc.stderr).text();
  })();

  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n",
  );
  proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let buffered = "";
  let response: any;
  try {
    while (!response && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) response ??= JSON.parse(line);
    }
  } finally {
    reader.cancel().catch(() => {});
    proc.kill();
    await stderrDone.catch(() => {});
  }

  const text = response?.result?.content?.[0]?.text;
  return { parsed: text ? JSON.parse(text) : undefined, stderr, raw: response };
}

describe("envelope()", () => {
  test("labels an unbridged call ephemeral and attaches a warning", () => {
    const wrapped = envelope("exocortex_query_frames", [], false);
    expect(wrapped.source).toBe("ephemeral");
    expect(wrapped.warning).toContain("EPHEMERAL");
    expect(wrapped.data).toEqual([]);
  });

  test("labels a bridge-served call live and attaches no warning", () => {
    const wrapped = envelope("exocortex_search_memory", [{ url: "https://x" }], true);
    expect(wrapped.source).toBe("live");
    // An absent key, not an empty string: a live answer carries no caveat at all.
    expect(wrapped).not.toHaveProperty("warning");
  });

  test("a bridge that cannot serve a tool does not launder it into live", () => {
    // exocortex_summarize_page is deliberately never bridged (roadmap #373,
    // 5.2 struck real OCR / raw-content tools). Claiming `live` for a tool the
    // bridge doesn't speak, just because a bridge object happens to exist, is
    // the exact lie 5.1 closes.
    expect(isEphemeral("exocortex_summarize_page", true)).toBe(true);
    expect(isEphemeral("exocortex_search_memory", true)).toBe(false);
    expect(isEphemeral("exocortex_query_frames", true)).toBe(false);
  });

  test("write tools get the discarded-write warning, not the empty-read one", () => {
    const write = envelope("exocortex_record_frame", { status: "success" }, false);
    const read = envelope("exocortex_get_focus_anchor", null, false);
    expect(write.warning).toContain("discarded");
    expect(read.warning).toContain("NOT evidence");
    expect(write.warning).not.toBe(read.warning);
  });

  test("every declared write tool is a tool the server actually dispatches", async () => {
    // Guards against a rename leaving WRITE_TOOLS pointing at nothing, which
    // would silently downgrade a discarded write to the milder read warning.
    const { EXOCORTEX_MCP_TOOLS } = await import("../src/mcp/server");
    const declared = new Set(EXOCORTEX_MCP_TOOLS.map((t) => t.name));
    for (const name of [...WRITE_TOOLS, ...BRIDGE_BACKED_TOOLS]) {
      expect(declared.has(name), `${name} is labelled but not registered`).toBe(true);
    }
  });

  test("the startup banner names the empty database when no bridge is active", () => {
    expect(startupProvenanceBanner(false)).toContain("EMPTY in-process database for ALL tools");
    expect(startupProvenanceBanner(true)).toContain("exocortex_search_memory");
  });
});

describe("the MCP server over stdio", () => {
  test(
    "wraps an unbridged read in an ephemeral envelope rather than returning a clean empty result",
    async () => {
      const { parsed, stderr } = await callTool(
        "exocortex_query_frames",
        { limit: 5 },
        { EXOCORTEX_NATIVE_BRIDGE: "0" }
      );
      expect(parsed, `no tool response; stderr: ${stderr}`).toBeDefined();
      expect(parsed.source).toBe("ephemeral");
      expect(parsed.warning).toContain("EPHEMERAL");
      // The payload itself must survive the wrapping unchanged.
      expect(parsed.data).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "announces ephemeral data source on startup when bridge is disabled",
    async () => {
      const { stderr } = await callTool("exocortex_get_focus_anchor", {}, { EXOCORTEX_NATIVE_BRIDGE: "0" });
      expect(stderr).toContain("EMPTY in-process database for ALL tools");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "labels a discarded write as a discarded write in ephemeral mode",
    async () => {
      const { parsed, stderr } = await callTool(
        "exocortex_record_frame",
        {
          intentCategory: "Deep Work (Drafting/Coding)",
          primaryFocusEntity: "envelope test",
          workingStateSummary: "verifying the write warning",
        },
        { EXOCORTEX_NATIVE_BRIDGE: "0" }
      );
      expect(parsed, `no tool response; stderr: ${stderr}`).toBeDefined();
      expect(parsed.source).toBe("ephemeral");
      expect(parsed.warning).toContain("discarded");
      // Still reports success, because the write did succeed — against a store
      // that is about to vanish. Both halves of that are true and both are said.
      expect(parsed.data.status).toBe("success");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "exocortex_get_bridge_status surfaces bridge availability and current mode",
    async () => {
      const { parsed } = await callTool("exocortex_get_bridge_status", {}, { EXOCORTEX_NATIVE_BRIDGE: "0" });
      expect(parsed).toBeDefined();
      expect(parsed.data.mode).toBe("ephemeral");
      expect(parsed.data.bridgeListening).toBe(false);
      expect(parsed.data.peerConnected).toBe(false);
      expect(parsed.data.bridgeBackedTools).toContain("exocortex_search_memory");
      expect(parsed.data.summary).toContain("EPHEMERAL");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "normal CLI path starts bridge and fails loudly if extension is not connected",
    async () => {
      const testSocket = `/tmp/exocortex-test-bridge-${crypto.randomUUID()}.sock`;
      const { raw, stderr } = await callTool(
        "exocortex_query_frames",
        { limit: 5 },
        { EXOCORTEX_NATIVE_BRIDGE_SOCKET: testSocket }
      );
      expect(stderr).toContain("Native browser bridge ready");
      expect(raw.error).toBeDefined();
      expect(raw.error.message).toContain("Exocortex browser bridge is unavailable");
    },
    SPAWN_TIMEOUT_MS,
  );
});
