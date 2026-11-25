/**
 * Roadmap task #373, 5.2 — the generalized bridge protocol shared between the
 * MCP-process side (src/bridge/server.ts) and the browser side
 * (src/background/native-bridge-client.ts): argument validation, response
 * minimization, and the three name lists that must never drift apart
 * (BRIDGE_BACKED_TOOLS, TOOL_TO_BRIDGE_TYPE, BRIDGE_REQUEST_TYPES).
 */
import { describe, expect, test } from "bun:test";
import {
  BRIDGE_ARG_VALIDATORS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_TIMEOUTS_MS,
  BRIDGE_REQUEST_TYPES,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  minimizeBridgeResult,
  minimizeFocusAnchor,
  minimizeFrame,
  minimizeFrames,
  minimizeRestorationPrompt,
  minimizeSearchMemoryResults,
  minimizeSemanticSearchResults,
  redactUrls,
  validateBridgeRequestEnvelope,
} from "../src/bridge/protocol";
import { memoryHandle, parseMemoryHandle } from "../src/lib/browser-memory-search";
import { BRIDGE_BACKED_TOOLS } from "../src/mcp/source-envelope";
import { TOOL_TO_BRIDGE_TYPE } from "../src/mcp/cli";
import type { CognitiveStateFrame } from "../src/lib/db";

const FRAME: CognitiveStateFrame = {
  frameId: "f1",
  timestampUtc: 1_754_524_800_000,
  sessionId: "s1",
  userState: {
    intentCategory: "Deep Work (Drafting/Coding)",
    primaryFocusEntity: "S2 projection contract",
    workingStateSummary: "Drafting the schema.",
    cognitiveLoadLevel: "High",
    frictionScore: 1,
    cognitiveLoadScore: 0.5,
    fatigueIndex: 0.1,
    contextSwitchCost: 0,
  },
  provenance: {
    url: "https://example.test/secret-doc",
    pageTitle: "Secret Document",
    activeDwellSeconds: 42,
    userActions: ["scroll", "click"],
    cleanTextExcerpt: "This is confidential text.",
  },
  sourceType: "web",
};

describe("name-list consistency", () => {
  test("BRIDGE_BACKED_TOOLS, TOOL_TO_BRIDGE_TYPE, and BRIDGE_REQUEST_TYPES agree exactly", () => {
    const backedTools = [...BRIDGE_BACKED_TOOLS].sort();
    const mappedTools = Object.keys(TOOL_TO_BRIDGE_TYPE).sort();
    expect(mappedTools).toEqual(backedTools);

    const mappedTypes = [...new Set(Object.values(TOOL_TO_BRIDGE_TYPE))].sort();
    const declaredTypes = [...BRIDGE_REQUEST_TYPES].sort();
    expect(mappedTypes).toEqual(declaredTypes);

    // Every declared type has both a validator and participates in
    // minimizeBridgeResult's exhaustive switch (verified separately below by
    // actually calling it — a missing case throws there, not here).
    for (const type of BRIDGE_REQUEST_TYPES) {
      expect(typeof BRIDGE_ARG_VALIDATORS[type]).toBe("function");
    }
  });

  test("every bridge request type has a minimizer that does not throw on a representative result", () => {
    const representative: Record<(typeof BRIDGE_REQUEST_TYPES)[number], unknown> = {
      search_memory: [{ parsedAt: 1, score: 1, handle: "mem_1" }],
      query_frames: [FRAME],
      semantic_search: [{ frameId: 1, url: "https://x", title: "t", timestamp: 1, cosineSimilarity: 0.5, score: 0.5 }],
      get_working_memory_stack: [],
      restore_context: { restorationPrompt: null },
      get_focus_anchor: { activeFocusEntity: null, url: null },
      set_focus_anchor: { status: "success", frameId: "f1" },
      project_task_reference: {
        contract_version: "1.0",
        kind: "task_reference",
        record_id: "tr_fa_test_279",
        provenance: { origin_machine: "desktop", origin_surface: "browser", captured_at: 1, projected_at: 2, consent_basis: "standing_local_capture", trust_tier: "local" },
        payload: { task_ref: "ua://task/279", relation: "suggested_by_focus", confidence: 0.8, focus_entity: "focus" }
      },
      get_cognitive_load_telemetry: { activeFrame: null, recentTabSwitchesIn5Mins: 0, cumulativeSessionMinutes: 0 },
      get_sanitized_telemetry_export: { sanitized: true },
      open_memory: { status: "opened", handle: "mem_1" },
    };
    for (const type of BRIDGE_REQUEST_TYPES) {
      expect(() => minimizeBridgeResult(type, representative[type])).not.toThrow();
    }
  });
});

describe("protocol version", () => {
  test("is pinned, so a wire-contract change cannot ship without a deliberate bump", () => {
    // Deliberately a literal. The other tests reference the constant so they do not
    // drift, but something has to fail when the wire contract changes and the
    // version does not — that is the whole mechanism by which mismatched
    // components find out. Bumped 3 -> 4 for the task-reference request.
    expect(BRIDGE_PROTOCOL_VERSION).toBe(4);
  });

  test("semantic_search gets a longer deadline than the fail-closed default", () => {
    // The browser has to embed the query, and the first call after a cold start
    // initializes the ONNX model — routinely longer than 2s. Without an override the
    // MCP call failed closed while the extension went on computing an answer nobody
    // was waiting for.
    expect(DEFAULT_BRIDGE_TIMEOUT_MS).toBe(2_000);
    expect(BRIDGE_REQUEST_TIMEOUTS_MS.semantic_search).toBeGreaterThan(DEFAULT_BRIDGE_TIMEOUT_MS);

    // And it stays an exception: everything else keeps the tight contract, so this
    // cannot quietly become a blanket relaxation of the fail-closed guarantee.
    for (const type of BRIDGE_REQUEST_TYPES) {
      if (type === "semantic_search") continue;
      expect(BRIDGE_REQUEST_TIMEOUTS_MS[type]).toBeUndefined();
    }
  });
});

describe("BRIDGE_ARG_VALIDATORS", () => {
  test("search_memory: requires a bounded query, defaults limit to 10", () => {
    expect(BRIDGE_ARG_VALIDATORS.search_memory({ query: "alpha" })).toEqual({ query: "alpha", limit: 10 });
    expect(() => BRIDGE_ARG_VALIDATORS.search_memory({ query: "" })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.search_memory({ query: "x".repeat(501) })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.search_memory({ query: "a", limit: 21 })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.search_memory({ query: "a", extra: 1 })).toThrow("unknown field");
  });

  test("query_frames: every field optional, intentCategory is an allowlist", () => {
    expect(BRIDGE_ARG_VALIDATORS.query_frames({})).toEqual({});
    expect(BRIDGE_ARG_VALIDATORS.query_frames({ intentCategory: "Deep Work (Drafting/Coding)" })).toEqual({
      intentCategory: "Deep Work (Drafting/Coding)",
    });
    expect(() => BRIDGE_ARG_VALIDATORS.query_frames({ intentCategory: "Not A Real Category" })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.query_frames({ sinceTimestamp: -1 })).toThrow();
  });

  test("semantic_search: bounds min_score to [0, 1] and sourceType to the known set", () => {
    expect(BRIDGE_ARG_VALIDATORS.semantic_search({ query: "a", min_score: 0.5 })).toEqual({ query: "a", min_score: 0.5 });
    expect(() => BRIDGE_ARG_VALIDATORS.semantic_search({ query: "chase.com" })).toThrow("privacy blocklist");
    expect(() => BRIDGE_ARG_VALIDATORS.semantic_search({ query: "a", min_score: 1.5 })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.semantic_search({ query: "a", sourceType: "bogus" })).toThrow();
  });

  test("get_working_memory_stack / get_focus_anchor / get_cognitive_load_telemetry take no args", () => {
    expect(BRIDGE_ARG_VALIDATORS.get_working_memory_stack({})).toEqual({});
    expect(() => BRIDGE_ARG_VALIDATORS.get_focus_anchor({ anything: 1 })).toThrow("unknown field");
    expect(BRIDGE_ARG_VALIDATORS.get_cognitive_load_telemetry(undefined)).toEqual({});
  });

  test("set_focus_anchor: requires goalTitle and primaryFocusEntity, bounds free text", () => {
    expect(() => BRIDGE_ARG_VALIDATORS.set_focus_anchor({ goalTitle: "g" })).toThrow();
    expect(
      BRIDGE_ARG_VALIDATORS.set_focus_anchor({ goalTitle: "g", primaryFocusEntity: "e" }),
    ).toEqual({ goalTitle: "g", primaryFocusEntity: "e" });
    expect(() =>
      BRIDGE_ARG_VALIDATORS.set_focus_anchor({
        goalTitle: "g",
        primaryFocusEntity: "e",
        workingStateSummary: "x".repeat(2001),
      }),
    ).toThrow();
  });

  test("project_task_reference: forwards bounded provenance controls", () => {
    expect(
      BRIDGE_ARG_VALIDATORS.project_task_reference({
        taskId: 279,
        confidence: 0.8,
        originMachine: "laptop",
        trustTier: "remote",
        consentBasis: "explicit_user_action",
      }),
    ).toEqual({
      taskId: 279,
      confidence: 0.8,
      originMachine: "laptop",
      trustTier: "remote",
      consentBasis: "explicit_user_action",
    });
    expect(() => BRIDGE_ARG_VALIDATORS.project_task_reference({ taskId: 279, confidence: 0.8, trustTier: "bogus" })).toThrow();
    expect(() => BRIDGE_ARG_VALIDATORS.project_task_reference({ taskId: 279, confidence: 0.8, originMachine: "" })).toThrow();
  });

  test("get_sanitized_telemetry_export: sourceDevice is optional and bounded", () => {
    expect(BRIDGE_ARG_VALIDATORS.get_sanitized_telemetry_export({})).toEqual({});
    expect(BRIDGE_ARG_VALIDATORS.get_sanitized_telemetry_export({ sourceDevice: "laptop" })).toEqual({
      sourceDevice: "laptop",
    });
    expect(() => BRIDGE_ARG_VALIDATORS.get_sanitized_telemetry_export({ sourceDevice: "x".repeat(65) })).toThrow();
  });
});

describe("validateBridgeRequestEnvelope", () => {
  test("accepts a well-formed envelope and rejects unknown top-level fields", () => {
    expect(validateBridgeRequestEnvelope({ id: "a", type: "get_focus_anchor", args: {} })).toEqual({
      id: "a",
      type: "get_focus_anchor",
      args: {},
    });
    expect(() => validateBridgeRequestEnvelope({ id: "a", type: "get_focus_anchor", args: {}, extra: 1 })).toThrow(
      "unknown field",
    );
    expect(() => validateBridgeRequestEnvelope({ type: "get_focus_anchor", args: {} })).toThrow("id is required");
    expect(() => validateBridgeRequestEnvelope({ id: "a", type: "not_a_real_type", args: {} })).toThrow("unsupported");
  });
});

describe("response minimization", () => {
  test("minimizeFrame strips url, pageTitle, userActions, and cleanTextExcerpt", () => {
    const minimized = minimizeFrame(FRAME);
    const asStr = JSON.stringify(minimized);
    expect(asStr).not.toContain("secret-doc");
    expect(asStr).not.toContain("Secret Document");
    expect(asStr).not.toContain("confidential");
    expect(asStr).not.toContain("scroll");
    // The summary is capture text on any browser frame ("Working on <title>", the
    // excerpt head, or a paraphrase), so it does not cross either — the entity and
    // the summary both become the site label. `example.test` is a reserved TLD, so
    // the label is the category instead of a name that cannot be a real site.
    expect(minimized).toEqual({
      frameId: "f1",
      timestampUtc: 1_754_524_800_000,
      sessionId: "s1",
      sourceType: "web",
      userState: {
        ...FRAME.userState,
        primaryFocusEntity: "Deep Work (Drafting/Coding)",
        workingStateSummary: "Deep Work (Drafting/Coding)",
      },
      activeDwellSeconds: 42,
    });
  });

  test("minimizeFrames maps an array", () => {
    expect(minimizeFrames([FRAME])).toEqual([minimizeFrame(FRAME)]);
  });

  test("minimizeSemanticSearchResults strips url, title, and summary", () => {
    const results = minimizeSemanticSearchResults([
      { frameId: 1, url: "https://x", title: "t", summary: "raw excerpt", timestamp: 1, cosineSimilarity: 0.5, score: 0.5 },
    ]);
    const asStr = JSON.stringify(results);
    expect(asStr).not.toContain("https://x");
    expect(asStr).not.toContain('"t"');
    expect(asStr).not.toContain("raw excerpt");
    expect(results[0]).toMatchObject({ frameId: 1, timestamp: 1, cosineSimilarity: 0.5, score: 0.5 });
  });

  test("minimizeSearchMemoryResults keeps parsedAt/score/handle and nothing else", () => {
    // Deliberate contract change from the S1 {parsedAt, score} shape: an opaque
    // handle now crosses so the agent can act on a result via exocortex_open_memory.
    // The content fields are still stripped — that part is not negotiable, and the
    // assertions below name each one so a regression cannot pass quietly.
    const minimized = minimizeSearchMemoryResults([
      {
        parsedAt: 1,
        score: 3,
        handle: "mem_7",
        url: "https://x",
        title: "t",
        excerpt: "secret excerpt",
      } as never,
    ]);
    expect(minimized).toEqual([{ parsedAt: 1, score: 3, handle: "mem_7" }]);

    const wire = JSON.stringify(minimized);
    expect(wire).not.toContain("https://x");
    expect(wire).not.toContain("secret excerpt");
    for (const leaked of ["url", "title", "excerpt"]) {
      expect(Object.keys(minimized[0])).not.toContain(leaked);
    }
  });

  test("a handle is not derived from the url it points at", () => {
    // The privacy claim rests on this. A hash of the URL would still let anyone
    // holding a list of candidate URLs confirm which the user had visited; a local
    // row id carries no such relationship.
    expect(memoryHandle(7)).toBe("mem_7");
    expect(parseMemoryHandle("mem_7")).toBe(7);
    expect(parseMemoryHandle("https://example.test")).toBeNull();
    expect(parseMemoryHandle("mem_notanumber")).toBeNull();
  });

  test("open_memory rejects anything that is not an opaque handle", () => {
    // Accepting a URL-shaped value here would turn the browser side into an
    // open-redirect driven by whatever is on the MCP end of the socket.
    const validate = BRIDGE_ARG_VALIDATORS.open_memory;
    expect(validate({ handle: "mem_12" })).toEqual({ handle: "mem_12" });
    expect(() => validate({ handle: "https://evil.test" })).toThrow();
    expect(() => validate({ handle: "mem_12; rm -rf /" })).toThrow();
    expect(() => validate({ handle: "mem_12", url: "https://evil.test" })).toThrow();
    expect(() => validate({})).toThrow();
  });

  test("minimizeFocusAnchor strips url only", () => {
    const anchor = { activeFocusEntity: "e", url: "https://x", timestampUtc: 1 };
    expect(minimizeFocusAnchor(anchor)).toEqual({ activeFocusEntity: "e", timestampUtc: 1 });
  });

  test("minimizeRestorationPrompt redacts urls embedded in the free-text prompt", () => {
    const prompt = "Key Working Tabs:\n• Secret Doc (https://example.test/secret)";
    const result = minimizeRestorationPrompt({ restorationPrompt: prompt });
    expect(result.restorationPrompt).not.toContain("example.test");
    expect(result.restorationPrompt).toContain("[redacted-link]");
    expect(minimizeRestorationPrompt({ restorationPrompt: null })).toEqual({ restorationPrompt: null });
  });

  test("redactUrls handles multiple schemes and bare www.", () => {
    expect(redactUrls("see https://a.test and http://b.test and www.c.test")).toBe(
      "see [redacted-link] and [redacted-link] and [redacted-link]",
    );
  });

  test("minimizeBridgeResult dispatches get_cognitive_load_telemetry's nested activeFrame", () => {
    const result = minimizeBridgeResult("get_cognitive_load_telemetry", {
      activeFrame: FRAME,
      recentTabSwitchesIn5Mins: 2,
      cumulativeSessionMinutes: 5,
    }) as { activeFrame: unknown };
    const asStr = JSON.stringify(result);
    expect(asStr).not.toContain("secret-doc");
    expect(asStr).not.toContain("Secret Document");
    expect(result.activeFrame).toEqual(minimizeFrame(FRAME));
  });

  test("minimizeBridgeResult takes the goal out of a stack item unless capture marked it agent-supplied", () => {
    // No flag: the row predates the provenance decision (task #2632). A missing
    // flag must not read as "safe", so the goal is replaced.
    expect(
      minimizeBridgeResult("get_working_memory_stack", [
        { stackId: "s1", activeGoal: "Focus: Zanzibar Quokka Migration Handbook", status: "active", lastUpdatedUtc: 1 },
      ]),
    ).toMatchObject([{ stackId: "s1", activeGoal: "(captured page)", status: "active" }]);

    // Capture recorded that the goal is the agent's own words, so it crosses.
    expect(
      minimizeBridgeResult("get_working_memory_stack", [
        { stackId: "s2", activeGoal: "Ship 5.2", goalDerivedFromPageTitle: false, status: "active", lastUpdatedUtc: 2 },
      ]),
    ).toMatchObject([{ stackId: "s2", activeGoal: "Ship 5.2" }]);
  });

  test("minimizeBridgeResult passes through tools with nothing sensitive in their shape", () => {
    expect(minimizeBridgeResult("set_focus_anchor", { status: "success", frameId: "f1" })).toEqual({
      status: "success",
      frameId: "f1",
    });
    expect(minimizeBridgeResult("get_sanitized_telemetry_export", { sanitized: true })).toEqual({ sanitized: true });
  });
});
