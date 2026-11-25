import { describe, test, expect, beforeEach } from "bun:test";
import { FocusShieldManager, focusShieldManager } from "../src/lib/focus-shield/focus-shield";
import type { CognitiveStateFrame } from "../src/lib/db";
import type { TelemetryMetrics } from "../src/lib/models/cognitive-state-engine";

function createMockFrame(url: string, intentCategory: any = "Research & Gathering"): CognitiveStateFrame {
  return {
    frameId: `frame_test_${Math.random()}`,
    timestampUtc: Date.now(),
    sessionId: "session_test",
    userState: {
      intentCategory,
      primaryFocusEntity: "Testing Focus Shield",
      workingStateSummary: "Running focus shield test suite",
      cognitiveLoadLevel: "High",
      frictionScore: 0,
      cognitiveLoadScore: 0.85,
      fatigueIndex: 85,
      contextSwitchCost: 36
    },
    provenance: {
      url,
      pageTitle: "Test Page",
      activeDwellSeconds: 30,
      userActions: ["dwell"],
      cleanTextExcerpt: "Sample text"
    }
  };
}

describe("Task #180: Phase 3.3 Neuroergonomic Focus Shield", () => {
  let manager: FocusShieldManager;

  beforeEach(() => {
    manager = new FocusShieldManager({ enabled: false });
  });

  test("DoD #5: User Flag Defaults OFF (focus_shield_enabled: false)", () => {
    expect(focusShieldManager.isEnabled()).toBe(false);
    expect(manager.isEnabled()).toBe(false);
    expect(manager.getState()).toBe("INACTIVE");

    const mockFrame = createMockFrame("https://example.com/docs");
    const metrics: TelemetryMetrics = { cognitiveLoadScore: 0.9, fatigueIndex: 85, contextSwitchCost: 36 };

    const result = manager.evaluateFrameSequence([mockFrame], metrics);
    expect(result.activated).toBe(false);
    expect(result.intervention).toBeNull();
    expect(manager.getState()).toBe("INACTIVE");
  });

  test("DoD #1: Observable Activation on Fatigue State", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80 });
    expect(manager.getState()).toBe("IDLE");

    const mockFrame = createMockFrame("https://example.com/deep-work");
    const fatigueMetrics: TelemetryMetrics = {
      cognitiveLoadScore: 0.95,
      fatigueIndex: 85, // Fatigue state >= 80
      contextSwitchCost: 40
    };

    const now = 1000000;
    const result = manager.evaluateFrameSequence([mockFrame], fatigueMetrics, now);

    expect(result.activated).toBe(true);
    expect(result.intervention).not.toBeNull();
    expect(result.intervention?.fatigueScore).toBe(85);
    expect(result.intervention?.action).toBe("CONTEXT_RESTORATION");
    expect(manager.getState()).toBe("ACTIVE_SHIELD");
    expect(manager.getLastInterventionTime()).toBe(now);
  });

  test("DoD #2: False-Positive Prevention on Benign Sequences", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80 });

    const benignFrame = createMockFrame("https://example.com/reading");
    const benignMetrics: TelemetryMetrics = {
      cognitiveLoadScore: 0.3,
      fatigueIndex: 30, // Benign state < 80
      contextSwitchCost: 0
    };

    const result = manager.evaluateFrameSequence([benignFrame], benignMetrics);

    expect(result.activated).toBe(false);
    expect(result.intervention).toBeNull();
    expect(manager.getState()).toBe("IDLE");
  });

  test("DoD #3: Intervention Frequency Capping", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80, minInterventionIntervalMs: 30 * 60 * 1000 });

    const mockFrame = createMockFrame("https://example.com/work");
    const fatigueMetrics: TelemetryMetrics = { cognitiveLoadScore: 0.9, fatigueIndex: 90, contextSwitchCost: 50 };

    const t0 = 1000000;
    const firstResult = manager.evaluateFrameSequence([mockFrame], fatigueMetrics, t0);
    expect(firstResult.activated).toBe(true);
    expect(manager.getState()).toBe("ACTIVE_SHIELD");

    // Second evaluation 10 minutes later (below 30 min cooldown)
    const t1 = t0 + 10 * 60 * 1000;
    const secondResult = manager.evaluateFrameSequence([mockFrame], fatigueMetrics, t1);
    expect(secondResult.activated).toBe(false);
    expect(secondResult.reason).toContain("Intervention frequency capped");

    // Third evaluation 31 minutes later (after cooldown)
    const t2 = t0 + 31 * 60 * 1000;
    const thirdResult = manager.evaluateFrameSequence([mockFrame], fatigueMetrics, t2);
    expect(thirdResult.activated).toBe(true);
    expect(thirdResult.intervention?.timestamp).toBe(t2);
  });

  test("restores the intervention cooldown after a worker restart", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80, minInterventionIntervalMs: 30 * 60 * 1000 });
    manager.restoreLastInterventionTime(1_000_000);

    const mockFrame = createMockFrame("https://example.com/work");
    const fatigueMetrics: TelemetryMetrics = { cognitiveLoadScore: 0.9, fatigueIndex: 90, contextSwitchCost: 50 };

    expect(manager.evaluateFrameSequence([mockFrame], fatigueMetrics, 1_000_000 + 10 * 60 * 1000).activated).toBe(false);
    expect(manager.evaluateFrameSequence([mockFrame], fatigueMetrics, 1_000_000 + 31 * 60 * 1000).activated).toBe(true);
  });

  test("rolls back an intervention that cannot reach the active tab", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80 });
    const mockFrame = createMockFrame("https://example.com/work");
    const fatigueMetrics: TelemetryMetrics = { cognitiveLoadScore: 0.9, fatigueIndex: 90, contextSwitchCost: 50 };
    const first = manager.evaluateFrameSequence([mockFrame], fatigueMetrics, 1_000_000);
    expect(first.activated).toBe(true);

    manager.rollbackIntervention(first.intervention!.timestamp, 0);

    expect(manager.getLastInterventionTime()).toBe(0);
    expect(manager.getInterventionHistory()).toHaveLength(0);
    expect(manager.getState()).toBe("IDLE");
  });

  test("DoD #4: Privacy Non-Bypass — Blocked domains strictly uncaptured", () => {
    manager.configure({ enabled: true, fatigueThreshold: 80 });

    // Blocked domain frame (financial/auth domain from privacy guard)
    const blockedFrame = createMockFrame("https://chase.com/accounts/overview");
    const fatigueMetrics: TelemetryMetrics = { cognitiveLoadScore: 0.9, fatigueIndex: 95, contextSwitchCost: 50 };

    const result = manager.evaluateFrameSequence([blockedFrame], fatigueMetrics);

    expect(result.activated).toBe(false);
    expect(result.intervention).toBeNull();
    expect(result.reason).toContain("Blocked domain uncaptured");
  });
});
