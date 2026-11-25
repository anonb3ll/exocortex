import { describe, expect, test, beforeEach } from "bun:test";
import {
  embedWithFallback,
  isWebGpuAvailable,
  isBrowserLikeRuntime,
  fallbackLadder,
  runtimeLadder,
  applyDemotions,
  demoteBackend,
  isBackendDemoted,
  resetEmbedderRuntimeState,
  MAX_INPUT_CHARS,
  EMBED_TIMEOUT_MS,
} from "../src/lib/models/webgpu-embedder";
import { FIXTURES, runReproducibleLeg, notReproducedLeg } from "../scripts/benchmark-webgpu-embeddings";

// These three tests download Xenova/all-MiniLM-L6-v2. That fetch is not part
// of the extension under test, and the suite must stay green when
// huggingface.co is unreachable. Opt in the same way as the browser layer.
// Assertions inside a test that runs are unchanged.
const EMBEDDER_TESTS_ENABLED = Boolean(process.env.EXOCORTEX_EMBEDDER_TESTS);

// This suite runs under Bun (no window/importScripts, no navigator), so
// @huggingface/transformers loads its Node bundle, which only accepts
// cpu/cuda devices. fallbackLadder() reflects that: it resolves to ["cpu"]
// here, not ["wasm"] or ["webgpu"] — those are browser-only execution
// providers and proving them needs a real browser (Puppeteer B*-layer, same
// pattern as the rest of this repo's browser-only evidence). That gap is
// labeled NOT-REPRODUCED below rather than skipped silently.

beforeEach(() => {
  resetEmbedderRuntimeState();
});

describe("webgpu-embedder: environment detection", () => {
  test("reports no WebGPU and no browser-like runtime under Bun", () => {
    expect(isWebGpuAvailable()).toBe(false);
    expect(isBrowserLikeRuntime()).toBe(false);
  });

  test("fallback ladder is cpu-only in this Node/Bun runtime", () => {
    expect(runtimeLadder()).toEqual(["cpu"]);
    expect(fallbackLadder()).toEqual(["cpu"]);
  });
});

describe("webgpu-embedder: backend demotion", () => {
  test("applyDemotions drops a demoted higher rung and keeps the floor", () => {
    demoteBackend("webgpu");
    expect(isBackendDemoted("webgpu")).toBe(true);
    expect(applyDemotions(["webgpu", "wasm"])).toEqual(["wasm"]);
  });

  test("applyDemotions keeps the original ladder when demoting would empty it", () => {
    demoteBackend("cpu");
    expect(applyDemotions(["cpu"])).toEqual(["cpu"]);
  });

  test("resetEmbedderRuntimeState clears demotions", () => {
    demoteBackend("webgpu");
    resetEmbedderRuntimeState();
    expect(isBackendDemoted("webgpu")).toBe(false);
    expect(applyDemotions(["webgpu", "wasm"])).toEqual(["webgpu", "wasm"]);
  });
});

describe("webgpu-embedder: fallback behavior", () => {
  test.skipIf(!EMBEDDER_TESTS_ENABLED)("lands on cpu and returns a valid 384-dim normalized vector", async () => {
    const result = await embedWithFallback("a short piece of synthetic fixture text");
    expect(result.backend).toBe("cpu");
    expect(result.dimension).toBe(384);
    expect(result.vector).toHaveLength(384);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const norm = Math.sqrt(result.vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeGreaterThan(0.9);
    expect(norm).toBeLessThan(1.1);
  }, 30000);

  test("rejects empty input instead of silently embedding nothing", async () => {
    await expect(embedWithFallback("   ")).rejects.toThrow(/non-empty/);
  });

  test.skipIf(!EMBEDDER_TESTS_ENABLED)("bounds oversized input rather than sending it whole to the model", async () => {
    const huge = "x ".repeat(MAX_INPUT_CHARS); // well over MAX_INPUT_CHARS once trimmed
    const result = await embedWithFallback(huge);
    expect(result.dimension).toBe(384);
  }, 30000);
});

describe("webgpu-embedder: resource limits", () => {
  test("timeout and input-length limits are finite and positive", () => {
    expect(EMBED_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MAX_INPUT_CHARS).toBeGreaterThan(0);
  });
});

describe("benchmark harness", () => {
  test.skipIf(!EMBEDDER_TESTS_ENABLED)("cpu leg reproduces on a fixed fixture set with timing stats", async () => {
    const leg = await runReproducibleLeg();
    expect(leg.backend).toBe("cpu");
    expect(leg.reproduced).toBe(true);
    expect(leg.runs).toBe(FIXTURES.length);
    expect(leg.durationsMs).toHaveLength(FIXTURES.length);
    expect(leg.meanMs).toBeGreaterThanOrEqual(0);
    expect(leg.p50Ms).toBeGreaterThanOrEqual(0);
    expect(leg.p95Ms).toBeGreaterThanOrEqual(leg.p50Ms as number);
  }, 60000);

  test("webgpu and wasm legs are explicitly labeled NOT-REPRODUCED in this environment, not silently skipped", () => {
    for (const backend of ["webgpu", "wasm"] as const) {
      const leg = notReproducedLeg(backend);
      expect(leg.backend).toBe(backend);
      expect(leg.reproduced).toBe(false);
      expect(leg.runs).toBe(0);
      expect(leg.reason).toBeTruthy();
    }
  });

  test("fixture set is fixed, non-empty, and free of obvious PII markers", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const text of FIXTURES) {
      expect(text).not.toMatch(/@|\bssn\b|\bpassword\b/i);
    }
  });
});
