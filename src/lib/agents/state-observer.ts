import { db, type CognitiveStateFrame } from "../db";
import { calculateContinuousLoadAndFatigue, type TelemetryMetrics, type HighLevelTelemetryExport } from "../models/cognitive-state-engine";


export interface ObserverStateSnapshot {
  activeFrame: CognitiveStateFrame | null;
  recentTabSwitchesIn5Mins: number;
  cumulativeSessionMinutes: number;
  currentMetrics: TelemetryMetrics;
}

export const OBSERVER_STATE_STORAGE_KEY = "focus_shield_observer_state";
export const SESSION_INACTIVITY_RESET_MS = 2 * 60 * 60 * 1000;

export interface ObserverPersistenceState {
  recentTabSwitchTimestamps: number[];
  sessionStartTimestamp: number;
  lastActivityTimestamp: number;
}

export class StateObserverAgent {
  private recentTabSwitchTimestamps: number[] = [];
  private sessionStartTimestamp: number = Date.now();
  private lastActivityTimestamp: number = this.sessionStartTimestamp;

  public recordTabSwitch(): void {
    const now = Date.now();
    this.markActivity(now);
    this.recentTabSwitchTimestamps.push(now);
    this.cleanupTabSwitches(now);
  }

  public getPersistenceState(): ObserverPersistenceState {
    this.cleanupTabSwitches(Date.now());
    return {
      recentTabSwitchTimestamps: [...this.recentTabSwitchTimestamps],
      sessionStartTimestamp: this.sessionStartTimestamp,
      lastActivityTimestamp: this.lastActivityTimestamp
    };
  }

  public restorePersistenceState(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const state = value as Record<string, unknown>;
    const now = Date.now();
    const persistedSessionStart = typeof state.sessionStartTimestamp === "number" && Number.isFinite(state.sessionStartTimestamp)
      ? Math.min(Math.max(0, Math.trunc(state.sessionStartTimestamp)), now)
      : now;
    const persistedLastActivity = typeof state.lastActivityTimestamp === "number" && Number.isFinite(state.lastActivityTimestamp)
      ? Math.min(Math.max(0, Math.trunc(state.lastActivityTimestamp)), now)
      : persistedSessionStart;

    if (now - persistedLastActivity > SESSION_INACTIVITY_RESET_MS) {
      this.sessionStartTimestamp = now;
      this.lastActivityTimestamp = now;
      this.recentTabSwitchTimestamps = [];
      return;
    }

    this.sessionStartTimestamp = persistedSessionStart;
    this.lastActivityTimestamp = persistedLastActivity;
    if (Array.isArray(state.recentTabSwitchTimestamps)) {
      this.recentTabSwitchTimestamps = state.recentTabSwitchTimestamps.filter(
        (timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
      );
      this.cleanupTabSwitches(now);
    }
  }

  public getRecentTabSwitchesCount(): number {
    this.cleanupTabSwitches(Date.now());
    return this.recentTabSwitchTimestamps.length;
  }

  public getCumulativeSessionMinutes(): number {
    return Math.round((Date.now() - this.sessionStartTimestamp) / 60000);
  }

  private cleanupTabSwitches(now: number): void {
    const cutoff = now - 5 * 60 * 1000;
    this.recentTabSwitchTimestamps = this.recentTabSwitchTimestamps.filter((t) => t >= cutoff);
  }

  public evaluateTelemetry(frame: CognitiveStateFrame): ObserverStateSnapshot {
    this.markActivity(Date.now());
    const recentSwitches = this.getRecentTabSwitchesCount();
    const sessionMins = this.getCumulativeSessionMinutes();

    const metrics = calculateContinuousLoadAndFatigue({
      intentCategory: frame.userState.intentCategory,
      activeDwellSeconds: frame.provenance.activeDwellSeconds,
      recentTabSwitchesIn5Min: recentSwitches,
      cumulativeSessionMinutes: sessionMins
    });

    return {
      activeFrame: frame,
      recentTabSwitchesIn5Mins: recentSwitches,
      cumulativeSessionMinutes: sessionMins,
      currentMetrics: metrics
    };
  }

  public async getLatestObserverSnapshot(): Promise<ObserverStateSnapshot> {
    const latestFrame = await db.cognitive_frames.orderBy("timestampUtc").reverse().first();
    const recentSwitches = this.getRecentTabSwitchesCount();
    const sessionMins = this.getCumulativeSessionMinutes();

    if (!latestFrame) {
      return {
        activeFrame: null,
        recentTabSwitchesIn5Mins: recentSwitches,
        cumulativeSessionMinutes: sessionMins,
        currentMetrics: {
          cognitiveLoadScore: 0.1,
          fatigueIndex: 0,
          contextSwitchCost: 0
        }
      };
    }

    const metrics = calculateContinuousLoadAndFatigue({
      intentCategory: latestFrame.userState.intentCategory,
      activeDwellSeconds: latestFrame.provenance.activeDwellSeconds,
      recentTabSwitchesIn5Min: recentSwitches,
      cumulativeSessionMinutes: sessionMins
    });

    return {
      activeFrame: latestFrame,
      recentTabSwitchesIn5Mins: recentSwitches,
      cumulativeSessionMinutes: sessionMins,
      currentMetrics: metrics
    };
  }

  public async getSanitizedTelemetryExport(sourceDevice: string = "local"): Promise<HighLevelTelemetryExport> {
    const snapshot = await this.getLatestObserverSnapshot();
    const intentCategory = snapshot.activeFrame?.userState.intentCategory || "Idle / Transition";

    return {
      cognitiveLoadScore: snapshot.currentMetrics.cognitiveLoadScore,
      fatigueIndex: snapshot.currentMetrics.fatigueIndex,
      contextSwitchCost: snapshot.currentMetrics.contextSwitchCost,
      intentCategory,
      recentTabSwitchesIn5Mins: snapshot.recentTabSwitchesIn5Mins,
      cumulativeSessionMinutes: snapshot.cumulativeSessionMinutes,
      timestampUtc: snapshot.activeFrame?.timestampUtc || Date.now(),
      sourceDevice,
      sanitized: true
    };
  }

  private markActivity(now: number): void {
    if (now - this.lastActivityTimestamp > SESSION_INACTIVITY_RESET_MS) {
      this.sessionStartTimestamp = now;
      this.recentTabSwitchTimestamps = [];
    }
    this.lastActivityTimestamp = now;
  }
}


export const stateObserver = new StateObserverAgent();
