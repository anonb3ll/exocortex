import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_TIMEOUTS_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  validateBridgeRequestEnvelope,
  type BridgeRequest,
  type BridgeRequestType
} from "./protocol";

export { BRIDGE_PROTOCOL_VERSION, BRIDGE_REQUEST_TIMEOUTS_MS, DEFAULT_BRIDGE_TIMEOUT_MS, MAX_QUERY_LENGTH, MAX_RESULT_LIMIT, type BridgeRequest, type BridgeRequestType } from "./protocol";
export const validateBridgeRequest = validateBridgeRequestEnvelope;

type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
type BridgePeer = {
  connected: boolean;
  send(message: BridgeRequest): void;
  /** Absent for test-injected peers (attachForTest), which have no real socket. */
  destroy?(): void;
};

export class BridgeUnavailableError extends Error {
  constructor(message = "Exocortex browser bridge is unavailable") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export class NativeBridgeServer {
  private server: Server | null = null;
  private peer: BridgePeer | null = null;
  private sockets = new Set<Socket>();
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly path: string, private readonly timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS) {}

  /**
   * Deadline for one request type. Most keep the fail-closed default; a few declare
   * a longer one because the browser genuinely cannot answer in 2s (see
   * BRIDGE_REQUEST_TIMEOUTS_MS — semantic_search has to embed the query, which on a
   * cold start includes initializing the ONNX model).
   */
  private timeoutFor(type: BridgeRequestType): number {
    return BRIDGE_REQUEST_TIMEOUTS_MS[type] ?? this.timeoutMs;
  }

  async start(): Promise<void> {
    await unlink(this.path).catch(() => {});
    this.server = createServer((socket) => this.attachSocket(socket));
    // The socket is created by listen() with the process umask, and the default
    // path is under /tmp when XDG_RUNTIME_DIR is unset — so between listen() and
    // chmod() it was briefly world-connectable. Tightening the umask across
    // listen() closes that window; the chmod stays as the authoritative final
    // state in case the umask is ignored.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
    } finally {
      process.umask(previousUmask);
    }
    await chmod(this.path, 0o600);
  }

  async close(): Promise<void> {
    this.failPending(new BridgeUnavailableError());
    this.peer = null;
    // node's server.close() only resolves once every accepted socket is gone,
    // so a browser that reconnected at least once would otherwise wedge shutdown.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
    await unlink(this.path).catch(() => {});
  }

  async request(type: BridgeRequestType, args: Record<string, unknown>): Promise<unknown> {
    if (!this.peer?.connected) {
      throw new BridgeUnavailableError("Exocortex browser bridge is unavailable (no browser extension connected)");
    }
    const request = validateBridgeRequestEnvelope({ id: crypto.randomUUID(), type, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new BridgeUnavailableError("Exocortex browser bridge timed out")); }, this.timeoutFor(type));
      this.pending.set(request.id, { resolve, reject, timer });
      this.peer!.send(request);
    });
  }

  isListening(): boolean {
    return this.server !== null && Boolean(this.server.listening);
  }

  isPeerConnected(): boolean {
    return Boolean(this.peer?.connected);
  }

  getPath(): string {
    return this.path;
  }

  attachForTest(peer: BridgePeer): void { this.peer = peer; }
  receiveForTest(response: BridgeResponse): void { this.receive(response); }

  private attachSocket(socket: Socket): void {
    let buffer = "";
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    const peer: BridgePeer = {
      connected: true,
      send: (message) => socket.write(JSON.stringify({ version: BRIDGE_PROTOCOL_VERSION, ...message }) + "\n"),
      destroy: () => socket.destroy(),
    };
    // Exactly one browser may hold the bridge. This used to assign unconditionally,
    // so a second connection silently became the peer while the first stayed open
    // and believed it was still serving; the displaced socket's 'close' was then a
    // no-op because it was no longer the current peer, stranding its in-flight
    // requests until they timed out. Supersede explicitly: fail anything in flight
    // and destroy the socket we are replacing.
    const displaced = this.peer;
    if (displaced && displaced !== peer) {
      displaced.connected = false;
      this.failPending(new BridgeUnavailableError("Exocortex browser bridge superseded by a new connection"));
      // Actually close it. Marking the peer disconnected only changed *our* view:
      // the displaced socket stayed open, stayed in this.sockets, and its own
      // 'close' handler early-returns because it is no longer the current peer — so
      // the old browser kept a live connection believing it still served, which is
      // the exact condition this block claims to resolve.
      displaced.destroy?.();
    }
    this.peer = peer;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        try { this.receive(JSON.parse(line)); } catch { socket.destroy(); }
      }
    });
    // A dropped browser must fail in-flight searches now; waiting for each
    // request's own timer would stall the caller long after recovery is possible.
    socket.on("close", () => {
      if (this.peer !== peer) return;
      this.peer = null;
      this.failPending(new BridgeUnavailableError("Exocortex browser bridge disconnected"));
    });
    socket.on("error", () => socket.destroy());
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private receive(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const response = input as Partial<BridgeResponse>;
    if (typeof response.id !== "string" || typeof response.ok !== "boolean") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id); clearTimeout(pending.timer);
    response.ok ? pending.resolve(response.result) : pending.reject(new BridgeUnavailableError("Exocortex browser bridge rejected the request"));
  }
}
