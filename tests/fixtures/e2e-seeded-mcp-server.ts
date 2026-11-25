/**
 * End-to-End Test Fixture: Seeded MCP Server over stdio.
 *
 * Seeds a realistic page capture into the real Dexie schema via `upsertPageText()`,
 * then starts the stdio MCP JSON-RPC server loop.
 */

import "fake-indexeddb/auto";

// Dynamically import db & server AFTER fake-indexeddb polyfill is installed globally.
const { upsertPageText } = await import("../../src/lib/db");
const { EXOCORTEX_MCP_TOOLS, executeExocortexMcpTool } = await import("../../src/mcp/server");
const { envelope } = await import("../../src/mcp/source-envelope");

await upsertPageText({
  url: "https://example.com/research/exocortex-alpha",
  title: "Exocortex Alpha Architecture and Cognitive Anchors",
  byline: "DeepMind Agentic Systems Team",
  excerpt: "Detailed breakdown of Exocortex memory indexing, neuroergonomic focus shields, and Dexie storage.",
  textContent:
    "Exocortex Alpha introduces a high-performance local memory layer for web browser navigation. " +
    "It captures active page text and indexes cognitive state frames in Dexie IndexedDB. " +
    "Search memory queries retrieve relevant excerpts using hybrid keyword scoring.",
  siteName: "Exocortex Docs",
  parsedAt: Date.now(),
});

console.error("[Exocortex E2E MCP] Seeded test page capture into real Dexie schema.");
console.error("[Exocortex E2E MCP] Memory Interface Server started on stdio.");

process.stdin.on("data", async (chunk: Buffer | string) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "exocortex", version: "0.1.0" },
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "notifications/initialized") {
        // Notification, no response needed
      } else if (request.method === "ping") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: {},
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "tools/list") {
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: EXOCORTEX_MCP_TOOLS },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (request.method === "tools/call") {
        const { name, arguments: toolArgs } = request.params || {};
        const result = await executeExocortexMcpTool(name, toolArgs);
        // This fixture seeds the in-process database rather than reaching a
        // browser, so its answers are `ephemeral` by construction — and saying
        // so is the point: an e2e pass here is an emulated pass, not an S1 one.
        const response = {
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: JSON.stringify(envelope(name, result, false), null, 2) }] },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (e) {
      console.error("[Exocortex E2E MCP] Parse error:", e);
    }
  }
});
