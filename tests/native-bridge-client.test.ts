/**
 * L5 Extension Bridge Client Contract — the service-worker half of the bridge.
 * Covers the case that dominates in the field: no native host is installed, so
 * the port disconnects immediately and the extension must stay healthy. Also
 * covers the generalized dispatch added by roadmap task #373, 5.2: one
 * handler per BridgeRequestType, each receiving validated args and minimized
 * before it reaches the wire.
 */
import { describe, expect, test } from "bun:test";
import {
  RECONNECT_DELAYS_MS,
  RETRY_AFTER_GIVE_UP_MS,
  isValidBridgeMessage,
  startNativeBridgeClient,
  type BridgeHandlers,
  type BridgePort,
} from "../src/background/native-bridge-client";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_REQUEST_TYPES } from "../src/bridge/protocol";
import type { BrowserMemorySearchResult } from "../src/lib/browser-memory-search";

function fakePort() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const sent: unknown[] = [];
  const port: BridgePort = {
    postMessage: (message) => sent.push(message),
    onMessage: { addListener: (callback) => messageListeners.push(callback) },
    onDisconnect: { addListener: (callback) => disconnectListeners.push(callback) },
  };
  return {
    port,
    sent,
    deliver: (message: unknown) => messageListeners.forEach((listener) => listener(message)),
    disconnect: () => disconnectListeners.forEach((listener) => listener()),
  };
}

const capture = (over: Partial<BrowserMemorySearchResult> = {}): BrowserMemorySearchResult => ({
  url: "https://example.test/private?token=secret",
  title: "Private page",
  excerpt: "raw page text",
  textContent: "raw page text",
  parsedAt: 1,
  score: 3,
  handle: "mem_9",
  ...over,
} as BrowserMemorySearchResult);

/** A handler map where every entry is a rejection — tests wire only the entries they need. */
function noopHandlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers {
  const base = Object.fromEntries(
    BRIDGE_REQUEST_TYPES.map((type) => [type, async () => { throw new Error(`unexpected call: ${type}`); }]),
  ) as BridgeHandlers;
  return { ...base, ...overrides };
}

const search = async () => [capture()];

describe("L5 extension bridge client", () => {
  test("answers a valid search with match metadata only", async () => {
    const peer = fakePort();
    startNativeBridgeClient({ connect: () => peer.port, handlers: noopHandlers({ search_memory: search }) });

    peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r1", args: { query: "alpha", limit: 3 } });
    await Bun.sleep(5);

    // The opaque handle crosses; every captured page field is still stripped.
    expect(peer.sent).toEqual([{ version: BRIDGE_PROTOCOL_VERSION, id: "r1", ok: true, result: [{ parsedAt: 1, score: 3, handle: "mem_9" }] }]);
    const wire = JSON.stringify(peer.sent);
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("raw page text");
    expect(wire).not.toContain("example.test");
    expect(wire).not.toContain("Private page");
  });

  test("ignores payload-bearing and malformed requests without answering them", async () => {
    const peer = fakePort();
    const client = startNativeBridgeClient({ connect: () => peer.port, handlers: noopHandlers({ search_memory: search }) });

    for (const bad of [
      { version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r", args: { query: "a", limit: 1, textContent: "page" } },
      { version: BRIDGE_PROTOCOL_VERSION, type: "capture", id: "r", args: { query: "a", limit: 1 } },
      { version: 1, type: "search_memory", id: "r", args: { query: "a", limit: 1 } },
      { version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r", args: { query: "   ", limit: 1 } },
      { version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r", args: { query: "a", limit: 999 } },
      { version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r", args: { query: "x".repeat(501), limit: 1 } },
      "not-an-object",
      null,
    ]) {
      peer.deliver(bad);
    }
    await Bun.sleep(5);

    expect(peer.sent).toEqual([]);
    expect(client.health().rejected).toBe(8);
    expect(client.health().served).toBe(0);
  });

  test("reports a failed lookup without leaking the reason to the bridge", async () => {
    const peer = fakePort();
    startNativeBridgeClient({
      connect: () => peer.port,
      handlers: noopHandlers({
        search_memory: async () => {
          throw new Error("indexeddb blocked for https://bank.test");
        },
      }),
    });

    peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r1", args: { query: "alpha", limit: 1 } });
    await Bun.sleep(5);

    expect(peer.sent).toEqual([{ version: BRIDGE_PROTOCOL_VERSION, id: "r1", ok: false }]);
    expect(JSON.stringify(peer.sent)).not.toContain("bank.test");
  });

  test("survives a native host that is not installed", () => {
    const client = startNativeBridgeClient({
      connect: () => {
        throw new Error("Specified native messaging host not found.");
      },
      handlers: noopHandlers({ search_memory: search }),
    });

    expect(client.health()).toMatchObject({ connected: false, gaveUp: true });
    expect(client.health().lastError).toContain("not found");
  });

  test("reconnects with backoff after the host drops, then serves again", async () => {
    const scheduled: number[] = [];
    let peer = fakePort();
    const client = startNativeBridgeClient({
      connect: () => (peer = fakePort()).port,
      handlers: noopHandlers({ search_memory: search }),
      schedule: (callback, delayMs) => {
        scheduled.push(delayMs);
        callback();
      },
    });

    peer.disconnect();
    expect(scheduled).toEqual([RECONNECT_DELAYS_MS[0]]);
    expect(client.health().connected).toBe(true);

    peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r2", args: { query: "alpha", limit: 1 } });
    await Bun.sleep(5);
    expect(peer.sent).toEqual([{ version: BRIDGE_PROTOCOL_VERSION, id: "r2", ok: true, result: [{ parsedAt: 1, score: 3, handle: "mem_9" }] }]);
  });

  test("stops retrying instead of spinning when the host never comes back", () => {
    let peer = fakePort();
    const client = startNativeBridgeClient({
      connect: () => (peer = fakePort()).port,
      handlers: noopHandlers({ search_memory: search }),
      schedule: (callback) => callback(),
    });

    for (let i = 0; i <= RECONNECT_DELAYS_MS.length; i += 1) peer.disconnect();

    const health = client.health();
    expect(health.gaveUp).toBe(true);
    expect(health.connected).toBe(false);
    expect(health.connectAttempts).toBe(RECONNECT_DELAYS_MS.length + 1);
  });

  test("reads lastError on disconnect so Chrome does not report it unchecked", () => {
    const peer = fakePort();
    let reads = 0;
    const client = startNativeBridgeClient({
      connect: () => peer.port,
      handlers: noopHandlers({ search_memory: search }),
      schedule: () => {},
      readLastError: () => {
        reads += 1;
        return "Native host has exited.";
      },
    });

    peer.disconnect();
    expect(reads).toBe(1);
    expect(client.health().lastError).toBe("Native host has exited.");
  });

  test("message validation matches the MCP-side request contract", () => {
    expect(isValidBridgeMessage({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "a", args: { query: "q", limit: 20 } })).toBe(true);
    expect(isValidBridgeMessage({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "a", args: { query: "q", limit: 21 } })).toBe(false);
  });

  test("dispatches a non-search request to its own handler and minimizes the result", async () => {
    const peer = fakePort();
    startNativeBridgeClient({
      connect: () => peer.port,
      handlers: noopHandlers({
        get_focus_anchor: async () => ({
          activeFocusEntity: "S2 projection contract",
          workingStateSummary: "drafting",
          intentCategory: "Deep Work (Drafting/Coding)",
          cognitiveLoadLevel: "High",
          timestampUtc: 1,
          url: "https://example.test/secret",
        }),
      }),
    });

    peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "get_focus_anchor", id: "r1", args: {} });
    await Bun.sleep(5);

    expect(peer.sent).toEqual([
      {
        version: BRIDGE_PROTOCOL_VERSION,
        id: "r1",
        ok: true,
        result: {
          activeFocusEntity: "S2 projection contract",
          workingStateSummary: "drafting",
          intentCategory: "Deep Work (Drafting/Coding)",
          cognitiveLoadLevel: "High",
          timestampUtc: 1,
        },
      },
    ]);
    expect(JSON.stringify(peer.sent)).not.toContain("example.test");
  });

  test("every request type has a wired handler in a fully-configured client", () => {
    // Guards against a new BridgeRequestType landing without a corresponding
    // handler entry — noopHandlers() would otherwise silently paper over it.
    const handlers = noopHandlers();
    for (const type of BRIDGE_REQUEST_TYPES) {
      expect(typeof handlers[type]).toBe("function");
    }
  });

  test("handles a request safely when the port disconnects before the handler settles", async () => {
    const peer = fakePort();
    let resolveHandler!: (value: any) => void;
    const delayedHandler = () => new Promise((resolve) => { resolveHandler = resolve; });

    const client = startNativeBridgeClient({
      connect: () => peer.port,
      handlers: noopHandlers({ search_memory: delayedHandler as any }),
    });

    peer.deliver({
      version: BRIDGE_PROTOCOL_VERSION,
      type: "search_memory",
      id: "r1",
      args: { query: "alpha", limit: 3 },
    });

    // Disconnect while the request is in-flight
    peer.disconnect();
    expect(client.health().connected).toBe(false);

    // Settling handler after disconnect must not throw or postMessage to dead port
    resolveHandler([capture()]);
    await Bun.sleep(10);

    expect(peer.sent).toEqual([]);
  });
  describe("trying again after giving up", () => {
    /** A host that is absent until `installed` flips: every connect fails by immediate disconnect. */
    function flakyHost() {
      const state = { installed: false, connects: 0, peer: fakePort() };
      const connect = () => {
        state.connects += 1;
        state.peer = fakePort();
        const peer = state.peer;
        if (!state.installed) queueMicrotask(() => peer.disconnect());
        return peer.port;
      };
      return { state, connect };
    }

    test("giving up is not permanent: later activity reconnects once the host exists", async () => {
      const host = flakyHost();
      let now = 0;
      const client = startNativeBridgeClient({
        connect: host.connect,
        handlers: noopHandlers({ search_memory: search }),
        schedule: (callback) => callback(),
        now: () => now,
      });
      await Bun.sleep(5);
      expect(client.health()).toMatchObject({ connected: false, gaveUp: true });
      const attemptsWhenGaveUp = client.health().connectAttempts;
      expect(attemptsWhenGaveUp).toBe(RECONNECT_DELAYS_MS.length + 1);

      // The user installs the native host and starts the MCP CLI, then keeps browsing.
      host.state.installed = true;
      now += RETRY_AFTER_GIVE_UP_MS;
      expect(client.nudge()).toBe(true);

      expect(client.health()).toMatchObject({ connected: true, gaveUp: false });
      expect(client.health().connectAttempts).toBe(attemptsWhenGaveUp + 1);

      host.state.peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r9", args: { query: "alpha", limit: 1 } });
      await Bun.sleep(5);
      expect(host.state.peer.sent).toEqual([
        { version: BRIDGE_PROTOCOL_VERSION, id: "r9", ok: true, result: [{ parsedAt: 1, score: 3, handle: "mem_9" }] },
      ]);
    });

    test("no tight loop: at most one attempt per cooldown, however much activity there is", async () => {
      const host = flakyHost();
      let now = 0;
      const client = startNativeBridgeClient({
        connect: host.connect,
        handlers: noopHandlers({ search_memory: search }),
        schedule: (callback) => callback(),
        now: () => now,
      });
      await Bun.sleep(5);
      const baseline = host.state.connects;

      // A hundred captured pages inside one cooldown window, host still missing.
      for (let i = 0; i < 100; i += 1) {
        now += 100;
        client.nudge();
        await Bun.sleep(0);
      }
      expect(host.state.connects).toBe(baseline);

      // Past the cooldown: exactly one attempt, which fails and gives up again
      // without scheduling a backoff chain of its own.
      now += RETRY_AFTER_GIVE_UP_MS;
      expect(client.nudge()).toBe(true);
      await Bun.sleep(5);
      expect(host.state.connects).toBe(baseline + 1);
      expect(client.health()).toMatchObject({ connected: false, gaveUp: true });

      // And the next burst is throttled against that attempt.
      for (let i = 0; i < 100; i += 1) client.nudge();
      await Bun.sleep(5);
      expect(host.state.connects).toBe(baseline + 1);
    });

    test("a nudge does nothing while connected or while backoff is still running", async () => {
      const pending: Array<() => void> = [];
      let peer = fakePort();
      const client = startNativeBridgeClient({
        connect: () => (peer = fakePort()).port,
        handlers: noopHandlers({ search_memory: search }),
        schedule: (callback) => void pending.push(callback),
        now: () => 10 * RETRY_AFTER_GIVE_UP_MS,
      });

      expect(client.health().connected).toBe(true);
      expect(client.nudge()).toBe(false);

      // Disconnected with a reconnect already scheduled: not given up, so no extra attempt.
      peer.disconnect();
      expect(client.health()).toMatchObject({ connected: false, gaveUp: false });
      expect(client.nudge()).toBe(false);
      expect(client.health().connectAttempts).toBe(1);
      expect(pending.length).toBe(1);
    });

    test("a throwing connect is also retried on later activity", () => {
      let installed = false;
      let now = 0;
      const peer = fakePort();
      const client = startNativeBridgeClient({
        connect: () => {
          if (!installed) throw new Error("Specified native messaging host not found.");
          return peer.port;
        },
        handlers: noopHandlers({ search_memory: search }),
        now: () => now,
      });
      expect(client.health()).toMatchObject({ connected: false, gaveUp: true });
      expect(client.nudge()).toBe(false);

      installed = true;
      now += RETRY_AFTER_GIVE_UP_MS;
      expect(client.nudge()).toBe(true);
      expect(client.health()).toMatchObject({ connected: true, gaveUp: false });
    });

    test("a host that was serving and then drops gets the full backoff again", async () => {
      const scheduled: number[] = [];
      const pending: Array<() => void> = [];
      let peer = fakePort();
      const client = startNativeBridgeClient({
        connect: () => (peer = fakePort()).port,
        handlers: noopHandlers({ search_memory: search }),
        schedule: (callback, delayMs) => {
          scheduled.push(delayMs);
          pending.push(callback);
        },
      });

      // Two silent drops walk down the chain...
      peer.disconnect();
      pending.shift()!();
      peer.disconnect();
      pending.shift()!();
      expect(scheduled).toEqual([RECONNECT_DELAYS_MS[0], RECONNECT_DELAYS_MS[1]]);

      // ...then the host really serves a request before dropping (the MCP CLI restarted).
      peer.deliver({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", id: "r1", args: { query: "alpha", limit: 1 } });
      await Bun.sleep(5);
      peer.disconnect();

      // The next delay is the first one again, not the 30 s tail or a give-up.
      expect(scheduled).toEqual([RECONNECT_DELAYS_MS[0], RECONNECT_DELAYS_MS[1], RECONNECT_DELAYS_MS[0]]);
      expect(client.health().gaveUp).toBe(false);
    });
  });
});
