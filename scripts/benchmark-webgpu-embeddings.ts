// Benchmark harness for task #474: compare WebGPU vs WASM vs CPU embedding
// latency on a fixed, synthetic, privacy-safe fixture set.
//
// Usage: bun run scripts/benchmark-webgpu-embeddings.ts
// Writes a JSON report to docs/benchmarks/webgpu-embedding-<date>.json and
// prints a human-readable summary.
//
// This script runs under Bun, a Node-like runtime with no `window`/
// `importScripts` and no `navigator`. @huggingface/transformers detects that
// and loads its Node bundle (onnxruntime-node), which only accepts
// "cpu"/"cuda" devices — "wasm" and "webgpu" are browser-only execution
// providers (onnxruntime-web) that this bundle rejects outright. So under
// Bun, embedWithFallback() always lands on "cpu" (see fallbackLadder() in
// webgpu-embedder.ts) and BOTH the webgpu and wasm legs are NOT-REPRODUCED
// here — not just webgpu. Proving either one needs a real browser context
// (Chrome offscreen document or the Puppeteer B*-layer already used
// elsewhere in this repo for browser-only evidence, e.g. tests/smoke-*).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  embedWithFallback,
  isWebGpuAvailable,
  isBrowserLikeRuntime,
  EMBED_TIMEOUT_MS,
  MAX_INPUT_CHARS,
  type EmbeddingBackend,
} from "../src/lib/models/webgpu-embedder";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixed, synthetic fixture set — no real user data, no page content.
const FIXTURES: string[] = [
  "The quarterly report summarizes revenue growth across three regions.",
  "A recipe for sourdough bread requires flour, water, salt, and a starter.",
  "The hiking trail gains two thousand feet over six miles of switchbacks.",
  "Photosynthesis converts light energy into chemical energy in plants.",
  "The meeting notes list four action items and two open questions.",
  "A short story about a lighthouse keeper who studies the tides.",
  "Instructions for assembling a bookshelf from six numbered panels.",
  "The weather forecast predicts rain through Thursday with clearing Friday.",
  "A product changelog entry describing a fixed pagination bug.",
  "Notes from a book club discussion of an unreliable narrator.",
];

interface LegResult {
  backend: EmbeddingBackend;
  reproduced: boolean;
  reason?: string;
  runs: number;
  meanMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  durationsMs?: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(durations: number[]): { meanMs: number; p50Ms: number; p95Ms: number } {
  const sorted = [...durations].sort((a, b) => a - b);
  const meanMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { meanMs, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

/** The only leg this Bun harness can actually reproduce: whatever fallbackLadder() picks here (cpu). */
async function runReproducibleLeg(): Promise<LegResult> {
  const durations: number[] = [];
  let backend: EmbeddingBackend | undefined;
  for (const text of FIXTURES) {
    const result = await embedWithFallback(text);
    if (backend && result.backend !== backend) {
      throw new Error(`backend changed mid-run: ${backend} -> ${result.backend} (fixture set should hit one backend consistently)`);
    }
    backend = result.backend;
    durations.push(result.durationMs);
  }
  return { backend: backend as EmbeddingBackend, reproduced: true, runs: durations.length, durationsMs: durations, ...summarize(durations) };
}

function notReproducedLeg(backend: "webgpu" | "wasm"): LegResult {
  const reason = isBrowserLikeRuntime()
    ? backend === "webgpu" && !isWebGpuAvailable()
      ? "browser-like runtime detected but navigator.gpu is unavailable here"
      : "not exercised by this Bun script — rerun from the Puppeteer B*-layer for a real browser measurement"
    : `no window/importScripts in this Bun runtime — @huggingface/transformers loads its Node bundle here, which rejects "${backend}" as a device (only cpu/cuda). Proof requires a real browser context (Chrome offscreen document or the Puppeteer B*-layer).`;
  return { backend, reproduced: false, reason, runs: 0 };
}

async function main() {
  console.log(`[benchmark] fixture set: ${FIXTURES.length} items, timeout=${EMBED_TIMEOUT_MS}ms, max input chars=${MAX_INPUT_CHARS}`);
  console.log(`[benchmark] runtime: ${isBrowserLikeRuntime() ? "browser-like" : "node/bun"}, webgpu available: ${isWebGpuAvailable()}`);

  const reproducedLeg = await runReproducibleLeg();
  const legs: LegResult[] = [reproducedLeg];
  for (const backend of ["webgpu", "wasm"] as const) {
    if (backend !== reproducedLeg.backend) legs.push(notReproducedLeg(backend));
  }

  const report = {
    task: "#474",
    generatedAt: new Date().toISOString(),
    environment: isBrowserLikeRuntime() ? "browser-like" : "bun (node bundle, cpu/cuda only)",
    fixtureCount: FIXTURES.length,
    resourceLimits: { embedTimeoutMs: EMBED_TIMEOUT_MS, maxInputChars: MAX_INPUT_CHARS },
    legs,
  };

  console.log(`[benchmark] ${reproducedLeg.backend} leg (reproduced):`, {
    meanMs: reproducedLeg.meanMs?.toFixed(2),
    p50Ms: reproducedLeg.p50Ms?.toFixed(2),
    p95Ms: reproducedLeg.p95Ms?.toFixed(2),
  });
  for (const leg of legs.slice(1)) {
    console.log(`[benchmark] ${leg.backend} leg: NOT-REPRODUCED —`, leg.reason);
  }

  const outDir = join(__dirname, "..", "docs", "benchmarks");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `webgpu-embedding-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`[benchmark] report written to ${outPath}`);
}

// Only run when executed directly (bun run scripts/...), not when imported by tests.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[benchmark] failed:", err);
    process.exit(1);
  });
}

export { FIXTURES, runReproducibleLeg, notReproducedLeg, summarize };
