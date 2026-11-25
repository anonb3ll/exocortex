// Transformers.js v3 embedding path shared by the live offscreen document and
// the benchmark harness. Browser runtimes use WebGPU when available and WASM
// otherwise; Bun/Node uses the CPU provider supported by its runtime bundle.
//
// Finding worth recording: @huggingface/transformers v3 ships two different
// runtimes and they support different device sets. The browser bundle (used
// by an extension offscreen document, backed by onnxruntime-web) accepts
// "webgpu" and "wasm". The Node/Bun bundle actually loaded here in a non-
// browser context (backed by onnxruntime-node) only accepts "cpu"/"cuda" —
// passing "wasm" or "webgpu" to it throws "Unsupported device". So the real
// fallback ladder is environment-dependent, not just device-dependent:
//   browser-like runtime (window or a worker's importScripts): webgpu -> wasm
//   node-like runtime (this benchmark harness, its tests, Bun): cpu only
// This module picks the ladder for the runtime it's actually in rather than
// assuming "wasm" is a universal floor.

export type EmbeddingBackend = "webgpu" | "wasm" | "cpu";

export interface EmbedResult {
  vector: number[];
  dimension: number;
  backend: EmbeddingBackend;
  durationMs: number;
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_DIMENSION = 384;

// Resource limits: bound both the amount of text sent to the model and how
// long a single embed call is allowed to run before we treat it as failed.
export const MAX_INPUT_CHARS = 8000;
export const EMBED_TIMEOUT_MS = 15000;

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && (navigator as any).gpu != null;
}

/** True in an extension offscreen document / content script / worker; false under Bun or plain Node. */
export function isBrowserLikeRuntime(): boolean {
  return typeof window !== "undefined" || typeof importScripts === "function";
}

/** Runtime ladder before demotions — best device first for this environment. */
export function runtimeLadder(): EmbeddingBackend[] {
  if (isBrowserLikeRuntime()) {
    return isWebGpuAvailable() ? ["webgpu", "wasm"] : ["wasm"];
  }
  return ["cpu"];
}

type Pipeline = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array; dispose?: () => void }>;

const pipelineCache = new Map<EmbeddingBackend, Promise<Pipeline>>();

/**
 * Backends that failed after a usable lower rung remained. Remembered for the
 * process lifetime so a broken WebGPU session (device loss, repeated timeouts)
 * does not burn the full embed timeout on every subsequent capture.
 */
const demotedBackends = new Set<EmbeddingBackend>();

export function demoteBackend(backend: EmbeddingBackend): void {
  demotedBackends.add(backend);
}

export function isBackendDemoted(backend: EmbeddingBackend): boolean {
  return demotedBackends.has(backend);
}

/** Test/harness helper — clears demotions and the pipeline cache. */
export function resetEmbedderRuntimeState(): void {
  demotedBackends.clear();
  pipelineCache.clear();
}

/** Drop demoted backends; if that would empty the ladder, keep the original floor. */
export function applyDemotions(ladder: EmbeddingBackend[]): EmbeddingBackend[] {
  const filtered = ladder.filter((backend) => !demotedBackends.has(backend));
  return filtered.length > 0 ? filtered : ladder;
}

/** The ordered list of devices worth trying in the current runtime, best first. */
export function fallbackLadder(): EmbeddingBackend[] {
  return applyDemotions(runtimeLadder());
}

async function loadPipeline(backend: EmbeddingBackend): Promise<Pipeline> {
  let cached = pipelineCache.get(backend);
  if (cached) return cached;

  cached = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    // The browser Cache API only exists in an actual browser/extension
    // context (offscreen document). This module also runs under Bun for
    // the benchmark harness and its tests, where `caches` is undefined.
    env.useBrowserCache = typeof caches !== "undefined";
    const extractor = await pipeline("feature-extraction", MODEL_ID, { device: backend });
    return extractor as unknown as Pipeline;
  })();

  // Don't let a transient failure (e.g. a flaky model download) permanently
  // poison the cache for this backend: evict the rejected entry so the next
  // call gets a fresh attempt instead of reusing the same rejection forever.
  cached.catch(() => {
    if (pipelineCache.get(backend) === cached) pipelineCache.delete(backend);
  });

  pipelineCache.set(backend, cached);
  return cached;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function embedWithBackend(text: string, backend: EmbeddingBackend): Promise<EmbedResult> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const extractor = await withTimeout(loadPipeline(backend), EMBED_TIMEOUT_MS, `${backend} model load`);
  const inference = extractor(text, { pooling: "mean", normalize: true });
  let output: Awaited<typeof inference>;
  try {
    output = await withTimeout(inference, EMBED_TIMEOUT_MS, `${backend} embed call`);
  } catch (err) {
    // The timeout won the race; the inference is still running in the
    // background. Dispose its tensor whenever it eventually settles so a
    // slow WebGPU/WASM call can't leak ONNX heap allocations in the
    // long-running offscreen context. Attached only here (not on the
    // success path) since `.then` handlers on the same promise fire in
    // registration order — attaching it unconditionally would dispose the
    // tensor before the success path below finishes reading `.data`.
    inference.then((result) => result.dispose?.(), () => {});
    throw err;
  }
  const vector = Array.from(output.data);
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (output.dispose) output.dispose();

  if (vector.length !== EXPECTED_DIMENSION) {
    throw new Error(`${backend} produced a ${vector.length}-dim vector, expected ${EXPECTED_DIMENSION}`);
  }

  return { vector, dimension: vector.length, backend, durationMs: ended - started };
}

/**
 * Embeds text on the best device this runtime supports, falling back down
 * the ladder (fallbackLadder()) on any failure of a higher rung. Only
 * throws for input validation or exhausting the whole ladder — the last
 * rung (wasm in a browser, cpu in Node/Bun) is the floor with nothing left
 * to fall back to.
 */
export async function embedWithFallback(text: string): Promise<EmbedResult> {
  const cleaned = (text ?? "").trim();
  if (!cleaned) {
    throw new Error("embedWithFallback: text must be non-empty");
  }
  const bounded = cleaned.length > MAX_INPUT_CHARS ? cleaned.slice(0, MAX_INPUT_CHARS) : cleaned;

  const ladder = fallbackLadder();
  let lastErr: unknown;
  for (let i = 0; i < ladder.length; i++) {
    const backend = ladder[i];
    try {
      return await embedWithBackend(bounded, backend);
    } catch (err) {
      lastErr = err;
      const isLastRung = i === ladder.length - 1;
      if (isLastRung) throw err;
      // A constructed pipeline can still fail inference repeatedly (device loss,
      // timeouts). Demote so later requests skip straight to the next rung.
      demoteBackend(backend);
      console.warn(`[webgpu-embedder] ${backend} path failed, falling back to ${ladder[i + 1]}:`, err);
    }
  }
  // Unreachable (ladder is always non-empty), but keeps TypeScript honest.
  throw lastErr;
}
