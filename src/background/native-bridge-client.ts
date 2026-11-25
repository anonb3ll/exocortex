/**
 * Service-worker side of the native bridge.
 *
 * Extracted from the service worker so the connect/disconnect/reconnect
 * lifecycle can be driven by tests: a Chrome port that never attaches (no
 * native host installed) is the normal case, and the extension must degrade
 * quietly rather than spin or surface unchecked runtime errors.
 *
 * Generalized from a single hardcoded search_memory handler to a `handlers`
 * map covering every `BridgeRequestType` (roadmap task #373, 5.2) — request
 * validation and response minimization both live in `../bridge/protocol`,
 * shared with the MCP-process side of the bridge (`../bridge/server`), so the
 * two cannot drift on what is allowed to cross.
 */
import {
  BRIDGE_ARG_VALIDATORS,
  BRIDGE_PROTOCOL_VERSION,
  minimizeBridgeResult,
  type BridgeRequestType
} from "../bridge/protocol";

export { BRIDGE_PROTOCOL_VERSION } from "../bridge/protocol";
export const RECONNECT_DELAYS_MS = [1_000, 5_000, 30_000];
/**
 * Minimum gap between connection attempts made after the client gave up.
 *
 * Giving up used to be permanent for the life of the worker: start the MCP CLI
 * or install the native host an hour into a browsing session and the bridge
 * stayed dead until Chrome restarted. `nudge()` — called on activity, such as
 * a captured page — now tries again, at most once per this interval, so a
 * missing host costs one cheap failed connect a minute while the user is
 * browsing and nothing at all while they are not.
 */
export const RETRY_AFTER_GIVE_UP_MS = 60_000;

export type BridgePort = {
  postMessage(message: unknown): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
};

export type BridgeHealth = {
  connected: boolean;
  connectAttempts: number;
  disconnects: number;
  served: number;
  rejected: number;
  lastError: string | null;
  gaveUp: boolean;
};

export type BridgeMessage = { version: number; id: string; type: BridgeRequestType; args: Record<string, unknown> };

/** One handler per `BridgeRequestType`, called with already-validated args and run against the real browser DB. */
export type BridgeHandlers = Record<BridgeRequestType, (args: Record<string, unknown>) => Promise<unknown>>;

export type BridgeClientOptions = {
  connect(): BridgePort;
  handlers: BridgeHandlers;
  /** Reads chrome.runtime.lastError so Chrome does not report it as unchecked. */
  readLastError?(): string | null;
  schedule?(callback: () => void, delayMs: number): void;
  reconnectDelaysMs?: number[];
  now?(): number;
  retryAfterGiveUpMs?: number;
};

export type BridgeClient = {
  health(): BridgeHealth;
  /**
   * Call on activity. If the client has given up and the cooldown has passed,
   * makes one more connection attempt; otherwise does nothing. Returns whether
   * an attempt was made.
   */
  nudge(): boolean;
};

/** A bridge message carries a bounded, per-type-validated args object only — never DOM or page payloads. */
export function isValidBridgeMessage(message: unknown): message is BridgeMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  const allowed = new Set(["version", "id", "type", "args"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return false;
  if (value.version !== BRIDGE_PROTOCOL_VERSION) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  const validator = BRIDGE_ARG_VALIDATORS[value.type as BridgeRequestType];
  if (!validator) return false;
  try {
    validator(value.args);
  } catch {
    return false;
  }
  return true;
}

export function startNativeBridgeClient(options: BridgeClientOptions): BridgeClient {
  const delays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const now = options.now ?? (() => Date.now());
  const retryAfterGiveUpMs = options.retryAfterGiveUpMs ?? RETRY_AFTER_GIVE_UP_MS;
  let lastAttemptAt = 0;
  const health: BridgeHealth = {
    connected: false,
    connectAttempts: 0,
    disconnects: 0,
    served: 0,
    rejected: 0,
    lastError: null,
    gaveUp: false
  };

  const open = (attempt: number) => {
    health.connectAttempts += 1;
    health.gaveUp = false;
    lastAttemptAt = now();
    let port: BridgePort;
    try {
      port = options.connect();
    } catch (error) {
      // A missing nativeMessaging host must not take the service worker down.
      health.lastError = error instanceof Error ? error.message : "connect failed";
      health.gaveUp = true;
      return;
    }
    health.connected = true;

    const safePostMessage = (payload: unknown): boolean => {
      if (!health.connected) return false;
      try {
        port.postMessage(payload);
        return true;
      } catch {
        return false;
      }
    };

    // A port that delivered a valid request had a real MCP process behind it.
    let hostWasLive = false;

    port.onMessage.addListener((message) => {
      if (!isValidBridgeMessage(message)) {
        health.rejected += 1;
        return;
      }
      hostWasLive = true;
      // isValidBridgeMessage already ran the type's validator once to check
      // validity; re-run it here to get the normalized args object rather
      // than trusting the raw (still merely well-typed) message payload.
      const args = BRIDGE_ARG_VALIDATORS[message.type](message.args);
      (async () => {
        try {
          const result = await options.handlers[message.type](args);
          health.served += 1;
          safePostMessage({
            version: BRIDGE_PROTOCOL_VERSION,
            id: message.id,
            ok: true,
            result: minimizeBridgeResult(message.type, result)
          });
        } catch {
          health.rejected += 1;
          safePostMessage({ version: BRIDGE_PROTOCOL_VERSION, id: message.id, ok: false });
        }
      })().catch(() => undefined);
    });

    port.onDisconnect.addListener(() => {
      health.connected = false;
      health.disconnects += 1;
      health.lastError = options.readLastError?.() ?? null;
      // A host that was really there and then dropped (the MCP CLI restarted)
      // earns the full backoff again; one that never spoke continues the chain.
      const nextAttempt = hostWasLive ? 0 : attempt;
      const delay = delays[nextAttempt];
      if (delay === undefined) {
        health.gaveUp = true;
        return;
      }
      schedule(() => open(nextAttempt + 1), delay);
    });
  };

  open(0);
  return {
    health: () => ({ ...health }),
    nudge: () => {
      if (health.connected || !health.gaveUp) return false;
      if (now() - lastAttemptAt < retryAfterGiveUpMs) return false;
      // One attempt, past the end of the backoff chain: if it fails the client
      // gives up again at once and waits for the next nudge.
      open(delays.length);
      return true;
    }
  };
}
