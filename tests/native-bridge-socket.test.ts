/**
 * L5 Bridge Lifecycle Contract — drives NativeBridgeServer over a real Unix
 * socket rather than the `attachForTest` shim, so socket framing, disconnect,
 * malformed payloads, and reconnect are covered by the same code path Chrome's
 * native host actually uses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeUnavailableError, NativeBridgeServer } from "../src/bridge/server";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_REQUEST_TYPES } from "../src/bridge/protocol";

const started: NativeBridgeServer[] = [];
const opened: Socket[] = [];

function socketPath(): string {
  return join(tmpdir(), `exo-bridge-${crypto.randomUUID().slice(0, 8)}.sock`);
}

async function startBridge(timeoutMs = 200): Promise<{ bridge: NativeBridgeServer; path: string }> {
  const path = socketPath();
  const bridge = new NativeBridgeServer(path, timeoutMs);
  await bridge.start();
  started.push(bridge);
  return { bridge, path };
}

/** Stands in for the Chrome native host: reads request lines, replies on demand. */
async function connectPeer(path: string): Promise<{
  socket: Socket;
  lines: string[];
  nextLine(): Promise<string>;
  reply(response: unknown): void;
}> {
  const socket = connect(path);
  opened.push(socket);
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));

  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let cursor = 0;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (!line) continue;
      lines.push(line);
      waiters.shift()?.(line);
    }
  });

  return {
    socket,
    lines,
    // Dequeues in arrival order (a `cursor` into the accumulated `lines`
    // history) rather than always returning the most recent line, so a test
    // that exchanges several requests over one connection sees each request
    // exactly once, in order.
    nextLine: () =>
      new Promise<string>((resolve) => {
        if (cursor < lines.length) { resolve(lines[cursor]!); cursor += 1; return; }
        waiters.push((line) => { cursor = lines.length; resolve(line); });
      }),
    reply: (response) => socket.write(JSON.stringify(response) + "\n"),
  };
}

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.destroy();
  for (const bridge of started.splice(0)) await bridge.close();
});

describe("L5 bridge socket lifecycle", () => {
  test("listens on a private socket that only the owning OS user can reach", async () => {
    const { path } = await startBridge();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("round-trips a search over the real socket and returns only match metadata", async () => {
    const { bridge, path } = await startBridge();
    const peer = await connectPeer(path);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 2 });
    const request = JSON.parse(await peer.nextLine());
    expect(request).toMatchObject({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", args: { query: "alpha", limit: 2 } });

    peer.reply({ id: request.id, ok: true, result: [{ parsedAt: 1, score: 3 }] });
    expect(await pending).toEqual([{ parsedAt: 1, score: 3 }]);
  });

  test("never writes captured page content onto the wire", async () => {
    const { bridge, path } = await startBridge();
    const peer = await connectPeer(path);

    void bridge.request("search_memory", { query: "banking password", limit: 1 }).catch(() => {});
    const wire = await peer.nextLine();

    for (const field of ["textContent", "excerpt", "title", "url", "byline"]) {
      expect(wire).not.toContain(field);
    }
    expect(Object.keys(JSON.parse(wire)).sort()).toEqual(["args", "id", "type", "version"]);
  });

  test("round-trips every bridge request type over the real socket", async () => {
    const { bridge, path } = await startBridge();
    const peer = await connectPeer(path);

    const cases: Record<(typeof BRIDGE_REQUEST_TYPES)[number], { args: Record<string, unknown>; result: unknown }> = {
      search_memory: { args: { query: "alpha", limit: 2 }, result: [{ parsedAt: 1, score: 3 }] },
      query_frames: { args: { limit: 5 }, result: [] },
      semantic_search: { args: { query: "beta", limit: 3 }, result: [] },
      get_working_memory_stack: { args: {}, result: [] },
      restore_context: { args: { focusEntity: "S2 contract" }, result: { restorationPrompt: null } },
      get_focus_anchor: { args: {}, result: { activeFocusEntity: null } },
      set_focus_anchor: {
        args: { goalTitle: "Ship 5.2", primaryFocusEntity: "bridge protocol" },
        result: { status: "success", frameId: "f1" },
      },
      project_task_reference: {
        args: {
          taskId: 279,
          confidence: 0.8,
          originMachine: "laptop",
          trustTier: "remote",
          consentBasis: "explicit_user_action",
        },
        result: { kind: "task_reference", payload: { task_ref: "ua://task/279" } },
      },
      get_cognitive_load_telemetry: { args: {}, result: { activeFrame: null } },
      get_sanitized_telemetry_export: { args: {}, result: { sanitized: true } },
      open_memory: { args: { handle: "mem_3" }, result: { status: "opened", handle: "mem_3" } },
    };

    for (const type of BRIDGE_REQUEST_TYPES) {
      const { args, result } = cases[type];
      const pending = bridge.request(type, args);
      const request = JSON.parse(await peer.nextLine());
      expect(request.type).toBe(type);
      peer.reply({ id: request.id, ok: true, result });
      await expect(pending).resolves.toEqual(result);
    }
  });

  test("fails closed when the browser never answers", async () => {
    const { bridge, path } = await startBridge(60);
    await connectPeer(path);
    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).rejects.toThrow("timed out");
  });

  test("semantic_search outlives the fail-closed deadline that applies to other types", async () => {
    // A bridged semantic_search makes the browser embed the query, and the first
    // call after a cold start initializes the ONNX model — well past 2s. With one
    // flat deadline the MCP call rejected while the extension went on to compute an
    // answer nobody was waiting for. Base timeout is 60ms here: search_memory must
    // still fail closed against it, semantic_search must not.
    const { bridge, path } = await startBridge(60);
    const peer = await connectPeer(path);

    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).rejects.toThrow("timed out");
    // Drain that request's line: nextLine() dequeues in arrival order, so leaving it
    // unread would hand the search_memory envelope to the assertion below.
    await peer.nextLine();

    const slow = bridge.request("semantic_search", { query: "beta", limit: 1 });
    const request = JSON.parse(await peer.nextLine());
    // Far beyond the 60ms base deadline: if the override were not applied this has
    // already rejected by now.
    await new Promise((r) => setTimeout(r, 400));
    peer.reply({ id: request.id, ok: true, result: [] });
    await expect(slow).resolves.toEqual([]);
  });

  test("fails closed and drops the peer when the browser sends a malformed payload", async () => {
    const { bridge, path } = await startBridge(60);
    const peer = await connectPeer(path);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    await peer.nextLine();
    peer.socket.write("this is not json\n");

    await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
  });

  test("fails an in-flight request immediately when the browser disconnects", async () => {
    const { bridge, path } = await startBridge(30_000);
    const peer = await connectPeer(path);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    await peer.nextLine();
    peer.socket.destroy();

    await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  test("propagates a browser-side failure without echoing the query back", async () => {
    const { bridge, path } = await startBridge();
    const peer = await connectPeer(path);

    const pending = bridge.request("search_memory", { query: "sensitive-term", limit: 1 });
    const request = JSON.parse(await peer.nextLine());
    peer.reply({ id: request.id, ok: false });

    await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(pending).rejects.not.toThrow("sensitive-term");
  });

  test("ignores unsolicited and mismatched responses instead of resolving a pending request", async () => {
    const { bridge, path } = await startBridge(120);
    const peer = await connectPeer(path);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    await peer.nextLine();
    peer.reply({ id: "not-a-pending-id", ok: true, result: [{ parsedAt: 9, score: 9 }] });
    peer.reply({ ok: true, result: [{ parsedAt: 8, score: 8 }] });

    await expect(pending).rejects.toThrow("timed out");
  });

  test("recovers after the browser restarts and reconnects", async () => {
    const { bridge, path } = await startBridge(200);
    const first = await connectPeer(path);
    first.socket.destroy();
    await expect(bridge.request("search_memory", { query: "alpha", limit: 1 })).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );

    const second = await connectPeer(path);
    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    const request = JSON.parse(await second.nextLine());
    second.reply({ id: request.id, ok: true, result: [{ parsedAt: 2, score: 1 }] });
    expect(await pending).toEqual([{ parsedAt: 2, score: 1 }]);
  });

  test("a superseding connection actually closes the one it displaces", async () => {
    // Exactly one browser may hold the bridge. Marking the displaced peer
    // disconnected only changed the server's own view of it: the old socket stayed
    // open and stayed in this.sockets, and its 'close' handler early-returns once it
    // is no longer the current peer — so the displaced browser held a live
    // connection believing it still served. Assert the socket is really closed, not
    // merely forgotten.
    const { bridge, path } = await startBridge();
    const first = await connectPeer(path);

    const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));

    const second = await connectPeer(path);
    await closed; // hangs and fails the test's timeout if the socket is only forgotten
    expect(first.socket.destroyed).toBe(true);

    // And the survivor is the new one, still fully functional.
    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    const request = JSON.parse(await second.nextLine());
    second.reply({ id: request.id, ok: true, result: [{ parsedAt: 9, score: 2, handle: "mem_9" }] });
    expect(await pending).toEqual([{ parsedAt: 9, score: 2, handle: "mem_9" }]);
  });

  test("superseding fails the displaced connection's in-flight requests immediately", async () => {
    const { bridge, path } = await startBridge(10_000); // long timeout: only supersession should fail it
    const first = await connectPeer(path);

    const stranded = bridge.request("search_memory", { query: "alpha", limit: 1 });
    await first.nextLine(); // it reached the first peer, which will never answer
    void stranded.catch(() => {});

    await connectPeer(path);
    // Without explicit supersession this sat until the 10s request timer expired.
    await expect(stranded).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  test("rejects a restart onto a socket path already held by a live bridge", async () => {
    const { path } = await startBridge();
    const duplicate = new NativeBridgeServer(path, 50);
    await expect(duplicate.request("search_memory", { query: "alpha", limit: 1 })).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
  });
});
