import { describe, expect, test } from "bun:test";
import { SESSION_INACTIVITY_RESET_MS, StateObserverAgent } from "../src/lib/agents/state-observer";

describe("StateObserverAgent persistence", () => {
  test("restores the session clock and only recent tab switches", () => {
    const observer = new StateObserverAgent();
    const now = Date.now();

    observer.restorePersistenceState({
      sessionStartTimestamp: now - 120_000,
      lastActivityTimestamp: now - 120_000,
      recentTabSwitchTimestamps: [now - 1_000, now - 6 * 60 * 1000, "invalid", -1]
    });

    expect(observer.getPersistenceState()).toEqual({
      sessionStartTimestamp: now - 120_000,
      lastActivityTimestamp: now - 120_000,
      recentTabSwitchTimestamps: [now - 1_000]
    });
    expect(observer.getRecentTabSwitchesCount()).toBe(1);
    expect(observer.getCumulativeSessionMinutes()).toBe(2);
  });

  test("starts a fresh session after prolonged inactivity", () => {
    const observer = new StateObserverAgent();
    const now = Date.now();

    observer.restorePersistenceState({
      sessionStartTimestamp: now - SESSION_INACTIVITY_RESET_MS - 30_000,
      lastActivityTimestamp: now - SESSION_INACTIVITY_RESET_MS - 30_000,
      recentTabSwitchTimestamps: [now - 1_000]
    });

    expect(observer.getCumulativeSessionMinutes()).toBe(0);
    expect(observer.getRecentTabSwitchesCount()).toBe(0);
    expect(observer.getPersistenceState().lastActivityTimestamp).toBeGreaterThanOrEqual(now);
  });

  test("resets an active worker session before recording returned activity", () => {
    const observer = new StateObserverAgent();
    const now = Date.now();

    observer.restorePersistenceState({
      sessionStartTimestamp: now - SESSION_INACTIVITY_RESET_MS - 30_000,
      lastActivityTimestamp: now - SESSION_INACTIVITY_RESET_MS - 30_000,
      recentTabSwitchTimestamps: [now - 1_000]
    });

    observer.recordTabSwitch();

    expect(observer.getCumulativeSessionMinutes()).toBe(0);
    expect(observer.getRecentTabSwitchesCount()).toBe(1);
  });
});
