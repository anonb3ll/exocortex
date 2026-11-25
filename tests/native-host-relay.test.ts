/**
 * L5 Native Host Relay Contract — spawns the real relay process against a real
 * bridge socket and speaks Chrome's Native Messaging framing at it, so the
 * length-prefixed wire format and its failure modes are covered end to end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBridgeServer } from "../src/bridge/server";
import { BRIDGE_PROTOCOL_VERSION } from "../src/bridge/protocol";

const RELAY = join(import.meta.dir, "..", "scripts", "exocortex-native-host.ts");

type Relay = { proc: Bun.Subprocess; nextFrame(): Promise<unknown> };

const bridges: NativeBridgeServer[] = [];
const relays: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const proc of relays.splice(0)) proc.kill();
  for (const bridge of bridges.splice(0)) await bridge.close();
});

function frame(message: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function startBridge(timeoutMs = 2_000): Promise<{ bridge: NativeBridgeServer; path: string }> {
  const path = join(tmpdir(), `exo-relay-${crypto.randomUUID().slice(0, 8)}.sock`);
  const bridge = new NativeBridgeServer(path, timeoutMs);
  await bridge.start();
  bridges.push(bridge);
  return { bridge, path };
}

/** Spawns the relay and decodes the length-prefixed frames it writes to stdout. */
function startRelay(socketPath: string): Relay {
  const proc = Bun.spawn(["bun", RELAY], {
    env: { ...process.env, EXOCORTEX_NATIVE_BRIDGE_SOCKET: socketPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  relays.push(proc);

  let buffered = Buffer.alloc(0);
  const reader = proc.stdout.getReader();
  const nextFrame = async (): Promise<unknown> => {
    for (;;) {
      if (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length >= length + 4) {
          const body = buffered.subarray(4, length + 4);
          buffered = buffered.subarray(length + 4);
          return JSON.parse(body.toString());
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("relay closed stdout before emitting a frame");
      buffered = Buffer.concat([buffered, Buffer.from(value)]);
    }
  };
  return { proc, nextFrame };
}

async function exitCode(proc: Bun.Subprocess): Promise<number> {
  return (await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3_000)),
  ])) as number;
}

describe("L5 native host relay", () => {
  test("relays a bridge search into a Chrome native-messaging frame and back", async () => {
    const { bridge, path } = await startBridge();
    const relay = startRelay(path);
    await Bun.sleep(300);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 2 });
    const outbound = (await relay.nextFrame()) as Record<string, unknown>;
    expect(outbound).toMatchObject({ version: BRIDGE_PROTOCOL_VERSION, type: "search_memory", args: { query: "alpha", limit: 2 } });

    relay.proc.stdin.write(frame({ id: outbound.id, ok: true, result: [{ parsedAt: 7, score: 2 }] }));
    relay.proc.stdin.flush();
    expect(await pending).toEqual([{ parsedAt: 7, score: 2 }]);
  }, 10_000);

  test("carries no captured page fields in either direction", async () => {
    const { bridge, path } = await startBridge();
    const relay = startRelay(path);
    await Bun.sleep(300);

    void bridge.request("search_memory", { query: "bank statement", limit: 1 }).catch(() => {});
    const outbound = (await relay.nextFrame()) as Record<string, unknown>;
    expect(Object.keys(outbound).sort()).toEqual(["args", "id", "type", "version"]);
  }, 10_000);

  test("exits rather than idling when the bridge socket does not exist", async () => {
    const relay = startRelay(join(tmpdir(), `exo-absent-${crypto.randomUUID().slice(0, 8)}.sock`));
    expect(await exitCode(relay.proc)).toBe(1);
  }, 10_000);

  test("exits when the MCP process shuts the bridge down", async () => {
    const { bridge, path } = await startBridge();
    const relay = startRelay(path);
    await Bun.sleep(300);
    await bridge.close();
    expect(await exitCode(relay.proc)).toBe(0);
  }, 10_000);

  test("fails closed on a malformed native-messaging body", async () => {
    const { path } = await startBridge();
    const relay = startRelay(path);
    await Bun.sleep(300);

    const body = Buffer.from("{not-json");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    relay.proc.stdin.write(Buffer.concat([header, body]));
    relay.proc.stdin.flush();

    expect(await exitCode(relay.proc)).toBe(1);
  }, 10_000);

  test("fails closed on an oversized declared frame instead of stalling forever", async () => {
    const { path } = await startBridge();
    const relay = startRelay(path);
    await Bun.sleep(300);

    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 + 1);
    relay.proc.stdin.write(Buffer.concat([header, Buffer.from("partial")]));
    relay.proc.stdin.flush();

    expect(await exitCode(relay.proc)).toBe(1);
  }, 10_000);

  test("drops a response that is not a bridge acknowledgement", async () => {
    const { bridge, path } = await startBridge(400);
    const relay = startRelay(path);
    await Bun.sleep(300);

    const pending = bridge.request("search_memory", { query: "alpha", limit: 1 });
    await relay.nextFrame();
    relay.proc.stdin.write(frame({ smuggled: "raw page text", result: [{ score: 1 }] }));
    relay.proc.stdin.flush();

    await expect(pending).rejects.toThrow("timed out");
  }, 10_000);
});
