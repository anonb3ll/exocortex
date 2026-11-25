import { describe, expect, test } from "bun:test";
import { FocusShieldManager } from "../src/lib/focus-shield/focus-shield";
import {
  FOCUS_SHIELD_STORAGE_DEFAULTS,
  isMatchingActiveCaptureTab,
  loadFocusShieldConfig,
  persistObserverState,
  persistTabContextSignals,
  removeTabContextSignalAfterReady,
  withFocusShieldReady
} from "../src/lib/focus-shield/runtime";
import { StateObserverAgent } from "../src/lib/agents/state-observer";

describe("Focus Shield runtime orchestration", () => {
  test("does not erase the hydrated tab cache before startup finishes", async () => {
    let releaseReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const signals = new Map([
      [1, { tabId: 1, intentCategory: "Deep Work (Drafting/Coding)", url: "https://example.com", title: "Example" }],
      [2, { tabId: 2, intentCategory: "Distraction / Rabbit Hole", url: "https://other.example", title: "Other" }]
    ]);
    const writes: Record<string, unknown>[] = [];
    const storage = { set: async (values: Record<string, unknown>) => writes.push(values) };

    const pending = removeTabContextSignalAfterReady(ready, storage, signals, 1);
    await Promise.resolve();
    expect(signals.has(1)).toBe(true);
    expect(writes).toHaveLength(0);

    releaseReady();
    await pending;
    expect(signals.has(1)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]["focus_shield_tab_context_signals"]).toEqual([...signals.values()]);
  });

  test("does not service cache-dependent work before startup hydration finishes", async () => {
    let releaseReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let ran = false;
    const pending = withFocusShieldReady(ready, async () => {
      ran = true;
      return 3;
    });

    await Promise.resolve();
    expect(ran).toBe(false);
    releaseReady();
    await expect(pending).resolves.toBe(3);
    expect(ran).toBe(true);
  });

  test("loads config, observer state, and only live matching tab classifications", async () => {
    const manager = new FocusShieldManager();
    const observer = new StateObserverAgent();
    const calls: Record<string, unknown>[] = [];
    const signals = await loadFocusShieldConfig({
      storage: {
        get: async (defaults) => ({
          ...defaults,
          focus_shield_enabled: true,
          fatigueThreshold: 71,
          minInterventionIntervalMs: 1234,
          ["focus_shield_last_intervention_at"]: 42,
          ["focus_shield_observer_state"]: {
            sessionStartTimestamp: Date.now() - 1000,
            lastActivityTimestamp: Date.now() - 1000,
            recentTabSwitchTimestamps: []
          },
          ["focus_shield_tab_context_signals"]: [
            { tabId: 1, intentCategory: "Distraction / Rabbit Hole", url: "https://current.test/", title: "Current" },
            { tabId: 2, intentCategory: "Distraction / Rabbit Hole", url: "https://stale.test", title: "Stale" }
          ]
        }),
        set: async (values) => calls.push(values)
      },
      queryTabs: async () => [{ id: 1, url: "https://current.test/" }, { id: 2, url: "https://changed.test/" }],
      focusShieldManager: manager,
      stateObserver: observer
    });

    expect(manager.getConfig()).toMatchObject({ enabled: true, fatigueThreshold: 71, minInterventionIntervalMs: 1234 });
    expect(manager.getLastInterventionTime()).toBe(42);
    expect(signals).toEqual([
      { tabId: 1, intentCategory: "Distraction / Rabbit Hole", url: "https://current.test/", title: "Current" }
    ]);
    expect(calls).toEqual([]);
    expect(FOCUS_SHIELD_STORAGE_DEFAULTS.focus_shield_enabled).toBe(false);
  });

  test("persists observer and classification state through storage wrappers", async () => {
    const writes: Record<string, unknown>[] = [];
    const storage = { set: async (values: Record<string, unknown>) => writes.push(values) };
    const observer = new StateObserverAgent();
    await persistObserverState(storage, observer);
    await persistTabContextSignals(storage, [{
      tabId: 5,
      intentCategory: "Research & Gathering",
      url: "https://docs.test",
      title: "Docs"
    }]);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toHaveProperty("focus_shield_observer_state");
    expect(writes[1]).toEqual({
      focus_shield_tab_context_signals: [{
        tabId: 5,
        intentCategory: "Research & Gathering",
        url: "https://docs.test",
        title: "Docs"
      }]
    });
  });

  test("revalidates the active tab against both tab id and sanitized URL", () => {
    expect(isMatchingActiveCaptureTab([{ id: 7, url: "https://work.test/?utm_source=mail" }], 7, "https://work.test/?utm_source=mail")).toBe(true);
    expect(isMatchingActiveCaptureTab([{ id: 8, url: "https://work.test/" }], 7, "https://work.test/")).toBe(false);
    expect(isMatchingActiveCaptureTab([{ id: 7, url: "https://changed.test/" }], 7, "https://work.test/")).toBe(false);
  });
});
