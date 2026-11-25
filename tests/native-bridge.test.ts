import { describe, expect, test } from "bun:test";
import { NativeBridgeServer, BridgeUnavailableError, validateBridgeRequest } from "../src/bridge/server";
import { minimizeSearchMemoryResults } from "../src/bridge/protocol";

describe("native browser bridge boundary", () => {
  test("accepts only a bounded search request and rejects payload-bearing requests", () => {
    expect(validateBridgeRequest({ id: "a", type: "search_memory", args: { query: "alpha", limit: 3 } })).toEqual({
      id: "a", type: "search_memory", args: { query: "alpha", limit: 3 },
    });
    expect(() =>
      validateBridgeRequest({ id: "a", type: "search_memory", args: { query: "alpha", textContent: "private page" } }),
    ).toThrow("unknown field");
    expect(() => validateBridgeRequest({ id: "a", type: "capture", args: { query: "alpha" } })).toThrow("unsupported");
  });

  test("redacts page fields before a browser result crosses the bridge", () => {
    // Was asserting against redactBridgeMemoryResults, a second copy of this rule
    // that production never called — so the duplicate could drift from the real
    // minimizer without any test noticing. Points at the shipped path now.
    expect(minimizeSearchMemoryResults([{
      url: "https://example.test/private?token=secret", title: "Private page", excerpt: "raw page text", parsedAt: 1, score: 3, handle: "mem_4",
    } as never])).toEqual([{ parsedAt: 1, score: 3, handle: "mem_4" }]);
  });

  test("fails closed while no browser native host is connected", async () => {
    const bridge = new NativeBridgeServer("/tmp/exocortex-test.sock", 25);
    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).rejects.toBeInstanceOf(BridgeUnavailableError);
    await bridge.close();
  });

  test("refuses blocklisted semantic_search before sending to the browser", async () => {
    const bridge = new NativeBridgeServer("/tmp/exocortex-test-blocked-semantic.sock", 25);
    let sends = 0;
    bridge.attachForTest({ connected: true, send: () => { sends++; } });
    await expect(bridge.request("semantic_search", { query: "chase.com", limit: 1 })).rejects.toThrow("privacy blocklist");
    expect(sends).toBe(0);
    await bridge.close();
  });

  test("times out without leaking the request payload", async () => {
    const bridge = new NativeBridgeServer("/tmp/exocortex-test.sock", 25);
    bridge.attachForTest({ send: () => {}, connected: true });
    await expect(bridge.request("search_memory", { query: "secret-looking-value", limit: 1 })).rejects.toThrow("timed out");
    await bridge.close();
  });

  test("returns only the browser response associated with the pending request", async () => {
    const bridge = new NativeBridgeServer("/tmp/exocortex-test.sock", 100);
    bridge.attachForTest({
      connected: true,
      send: (message) => queueMicrotask(() => bridge.receiveForTest({ id: message.id, ok: true, result: [{ score: 3 }] })),
    });
    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).resolves.toEqual([{ score: 3 }]);
    await bridge.close();
  });
});
