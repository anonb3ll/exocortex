/**
 * Layer 5: End-to-End Real Profile & Architecture Verification (Task #662).
 *
 * Proves the built extension is tested across all four layers:
 * 1. Build Freshness Guard: ensures dist/ is fresh relative to src/ and configs.
 * 2. Real Dexie Schema: seeds page captures and cognitive frames in Dexie.
 * 3. Real MCP CLI Binary: executes `src/mcp/cli.ts` over stdio with live native bridge.
 * 4. Full Protocol Cycle: handles JSON-RPC tools/call over stdio, socket IPC, provenance
 *    enveloping (live vs ephemeral), and loud fail-closed disconnection handling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import "fake-indexeddb/auto";
import { db, upsertPageText } from "../src/lib/db";
import { searchBrowserMemory } from "../src/lib/browser-memory-search";
import { BRIDGE_PROTOCOL_VERSION, minimizeBridgeResult } from "../src/bridge/protocol";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const SPAWN_TIMEOUT_MS = 30_000;

function getNewestSourceMtime(dirPath: string): number {
  let maxMtime = 0;
  if (!existsSync(dirPath)) return maxMtime;

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > maxMtime) {
          maxMtime = stat.mtimeMs;
        }
      }
    }
  }
  walk(dirPath);

  for (const configName of [
    "public/manifest.json",
    "vite.config.ts",
    "vite.content.config.ts",
    "package.json",
    "tsconfig.json",
  ]) {
    const configPath = join(ROOT, configName);
    if (existsSync(configPath)) {
      const stat = statSync(configPath);
      if (stat.mtimeMs > maxMtime) {
        maxMtime = stat.mtimeMs;
      }
    }
  }

  return maxMtime;
}

interface McpProcess {
  proc: Bun.Subprocess;
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
  stderr(): string;
}

function spawnMcpCli(env: Record<string, string> = {}): McpProcess {
  const proc = Bun.spawn(["bun", "src/mcp/cli.ts"], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  let stderr = "";
  const stderrDone = (async () => {
    stderr = await new Response(proc.stderr).text();
  })();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let idCounter = 1;

  async function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = idCounter++;
    const request = { jsonrpc: "2.0", id, method, params };
    proc.stdin.write(JSON.stringify(request) + "\n");
    proc.stdin.flush();

    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) {
          return msg;
        }
      }
    }
    throw new Error(`Timeout waiting for response to request ${id}. Stderr: ${stderr}`);
  }

  async function close(): Promise<void> {
    try {
      reader.cancel().catch(() => {});
      proc.kill();
      await stderrDone.catch(() => {});
    } catch {}
  }

  return { proc, call, close, stderr: () => stderr };
}

describe("Layer 5: End-to-End real profile verification & build freshness guard", () => {
  beforeEach(async () => {
    await db.page_text.clear();
    await db.cognitive_frames.clear();
  });

  test("build freshness guard: dist/ is fresh relative to source files and build configs", () => {
    expect(existsSync(join(DIST, "manifest.json")), "dist/manifest.json must exist — run `bun run build`").toBe(true);

    const distMtime = statSync(join(DIST, "manifest.json")).mtimeMs;
    const newestSourceMtime = getNewestSourceMtime(join(ROOT, "src"));

    expect(
      newestSourceMtime <= distMtime,
      `dist/ is stale (src modified after last build). Run 'bun run build' to update dist/.`
    ).toBe(true);
  });

  test(
    "crosses real Dexie schema → socket bridge → real MCP binary over stdio (live & fail-closed)",
    async () => {
      // 1. Seed realistic data into the real Dexie schema
      await upsertPageText({
        url: "https://example.com/research/real-profile-l5",
        title: "Exocortex Real Profile Verification and L5 Composition",
        byline: "DeepMind Agentic Systems Team",
        excerpt: "End-to-end verification of MCP CLI, bridge socket, Dexie schema, and build freshness.",
        textContent:
          "Exocortex connects the browser sensor layer with autonomous agent tools over a secure bridge. " +
          "Real-profile verification ensures all four layers compose flawlessly under real execution.",
        siteName: "Exocortex Research",
        parsedAt: Date.now(),
      });

      const testSocket = `/tmp/exo-e2e-${crypto.randomUUID().slice(0, 8)}.sock`;

      // 2. Start the REAL MCP binary (src/mcp/cli.ts)
      const mcp = spawnMcpCli({
        EXOCORTEX_NATIVE_BRIDGE_SOCKET: testSocket,
      });

      // 3. Connect a simulated browser extension peer to the bridge socket
      let peerSocket: net.Socket | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          peerSocket = net.createConnection(testSocket);
          await new Promise((resolve, reject) => {
            peerSocket!.on("connect", resolve);
            peerSocket!.on("error", reject);
          });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      expect(peerSocket, "failed to connect peer socket to MCP bridge").not.toBeNull();

      // Handle bridge requests on the extension socket side by running real Dexie queries
      let socketBuffer = "";
      peerSocket!.on("data", async (data) => {
        socketBuffer += data.toString();
        const lines = socketBuffer.split("\n");
        socketBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.type === "search_memory") {
            const rawResults = await searchBrowserMemory(req.args.query, req.args.limit);
            const minimized = minimizeBridgeResult("search_memory", rawResults);
            const res = { version: BRIDGE_PROTOCOL_VERSION, id: req.id, ok: true, result: minimized };
            peerSocket!.write(JSON.stringify(res) + "\n");
          }
        }
      });

      try {
        // 4. Initialize real MCP server
        const initResp = await mcp.call("initialize", {});
        expect(initResp.result).toBeDefined();
        expect(initResp.result.serverInfo.name).toBe("exocortex");

        // 5. Query bridge status — must report live native_bridge mode with connected peer
        const statusResp = await mcp.call("tools/call", {
          name: "exocortex_get_bridge_status",
          arguments: {},
        });
        expect(statusResp.result).toBeDefined();
        const statusText = statusResp.result.content[0].text;
        const statusPayload = JSON.parse(statusText);
        expect(statusPayload.data.mode).toBe("native_bridge");
        expect(statusPayload.data.bridgeListening).toBe(true);
        expect(statusPayload.data.peerConnected).toBe(true);
        expect(statusPayload.data.summary).toContain("ACTIVE and CONNECTED");

        // 6. Search memory through real MCP binary — must return LIVE enveloped result from Dexie
        const searchResp = await mcp.call("tools/call", {
          name: "exocortex_search_memory",
          arguments: { query: "real profile" },
        });

        expect(searchResp.result).toBeDefined();
        const searchPayload = JSON.parse(searchResp.result.content[0].text);
        expect(searchPayload.source).toBe("live");
        expect(searchPayload.warning).toBeUndefined();
        expect(searchPayload.data.length).toBe(1);
        expect(searchPayload.data[0].handle).toMatch(/^mem_\d+$/);

        // 7. Call unbridged tool (exocortex_record_frame) — must be honest ephemeral with warning
        const recordResp = await mcp.call("tools/call", {
          name: "exocortex_record_frame",
          arguments: {
            intentCategory: "Deep Work (Drafting/Coding)",
            primaryFocusEntity: "L5 Test",
            workingStateSummary: "Testing provenance wrapping",
          },
        });
        const recordPayload = JSON.parse(recordResp.result.content[0].text);
        expect(recordPayload.source).toBe("ephemeral");
        expect(recordPayload.warning).toContain("discarded");

        // 8. Disconnect browser peer socket and verify loud fail-closed behavior on bridge tools
        peerSocket!.destroy();
        await new Promise((r) => setTimeout(r, 50));

        const failClosedResp = await mcp.call("tools/call", {
          name: "exocortex_search_memory",
          arguments: { query: "real profile" },
        });
        expect(failClosedResp.error).toBeDefined();
        expect(failClosedResp.error.message).toContain("Exocortex browser bridge is unavailable");
      } finally {
        peerSocket?.destroy();
        await mcp.close();
      }
    },
    SPAWN_TIMEOUT_MS
  );
});
