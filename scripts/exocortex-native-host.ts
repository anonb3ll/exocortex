#!/usr/bin/env bun
/** Chrome Native Messaging relay. It contains no page data and logs nothing. */
import { connect, type Socket } from "node:net";

const socketPath = process.env.EXOCORTEX_NATIVE_BRIDGE_SOCKET || `${process.env.XDG_RUNTIME_DIR || "/tmp"}/exocortex-mcp-bridge.sock`;

let socket: Socket | null = null;
let nativeBuffer = Buffer.alloc(0);
let bridgeBuffer = "";

function writeNative(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function connectBridge() {
  socket = connect(socketPath);
  socket.on("data", (chunk) => {
    bridgeBuffer += chunk.toString();
    const lines = bridgeBuffer.split("\n");
    bridgeBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try { writeNative(JSON.parse(line)); } catch { socket?.destroy(); }
    }
  });
  socket.on("error", () => process.exit(1));
  socket.on("close", () => process.exit(0));
}

process.stdin.on("data", (chunk: Buffer) => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    // An over-long declared frame can never complete; returning would leave the
    // same header at the head of the buffer and stall the relay silently.
    if (length > 64 * 1024) process.exit(1);
    if (nativeBuffer.length < length + 4) return;
    const body = nativeBuffer.subarray(4, length + 4); nativeBuffer = nativeBuffer.subarray(length + 4);
    try {
      const response = JSON.parse(body.toString());
      if (typeof response?.id === "string" && typeof response?.ok === "boolean") socket?.write(JSON.stringify(response) + "\n");
    } catch { process.exit(1); }
  }
});

connectBridge();
