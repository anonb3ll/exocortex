import { isUrlBlocked } from "../../content/privacy";
import type { CognitiveStateFrame } from "../db";
import type { TelemetryMetrics } from "../models/cognitive-state-engine";

export interface FocusShieldConfig {
  enabled: boolean; // Defaults OFF (focus_shield_enabled: false)
  fatigueThreshold: number; // Default 80 (Red Band threshold)
  minInterventionIntervalMs: number; // Frequency capping interval (default 30 mins)
}

export const DEFAULT_FOCUS_SHIELD_CONFIG: FocusShieldConfig = {
  enabled: false,
  fatigueThreshold: 80,
  minInterventionIntervalMs: 30 * 60 * 1000
};

export type FocusShieldState = "INACTIVE" | "IDLE" | "ACTIVE_SHIELD";

export interface FocusShieldIntervention {
  timestamp: number;
  reason: string;
  fatigueScore: number;
  action: "COLLAPSE_UI" | "PARK_TABS" | "CONTEXT_RESTORATION";
}

export interface FocusShieldEvaluation {
  activated: boolean;
  intervention: FocusShieldIntervention | null;
  reason: string;
}

export class FocusShieldManager {
  private config: FocusShieldConfig = { ...DEFAULT_FOCUS_SHIELD_CONFIG };

  private currentState: FocusShieldState = "INACTIVE";
  private lastInterventionTime: number = 0;
  private interventionHistory: FocusShieldIntervention[] = [];

  constructor(config?: Partial<FocusShieldConfig>) {
    if (config) {
      this.configure(config);
    }
  }

  public configure(config: Partial<FocusShieldConfig>): void {
    this.config = { ...this.config, ...config };
    if (!this.config.enabled) {
      this.currentState = "INACTIVE";
    } else if (this.currentState === "INACTIVE") {
      this.currentState = "IDLE";
    }
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public getConfig(): FocusShieldConfig {
    return { ...this.config };
  }

  public getState(): FocusShieldState {
    return this.currentState;
  }

  public getLastInterventionTime(): number {
    return this.lastInterventionTime;
  }

  /** Restore the cooldown marker after an MV3 service-worker restart. */
  public restoreLastInterventionTime(timestamp: number): void {
    this.lastInterventionTime = Number.isFinite(timestamp) && timestamp >= 0 ? Math.trunc(timestamp) : 0;
  }

  /** Undo an intervention that could not be delivered to the active tab. */
  public rollbackIntervention(interventionTimestamp: number, previousTimestamp: number): void {
    if (this.lastInterventionTime !== interventionTimestamp) return;
    this.lastInterventionTime = previousTimestamp;
    const last = this.interventionHistory[this.interventionHistory.length - 1];
    if (last?.timestamp === interventionTimestamp) this.interventionHistory.pop();
    this.currentState = this.config.enabled ? "IDLE" : "INACTIVE";
  }

  public getInterventionHistory(): FocusShieldIntervention[] {
    return [...this.interventionHistory];
  }

  /** Dismiss the current UI state without resetting the frequency cap. */
  public dismiss(): void {
    this.currentState = this.config.enabled ? "IDLE" : "INACTIVE";
  }

  /**
   * Evaluates a frame sequence and fatigue telemetry metrics.
   * Enforces privacy non-bypass, false-positive prevention, and frequency capping.
   */
  public evaluateFrameSequence(
    frames: CognitiveStateFrame[],
    metrics: TelemetryMetrics,
    now: number = Date.now()
  ): FocusShieldEvaluation {
    // Rule 5: User Flag Defaults OFF
    if (!this.config.enabled) {
      this.currentState = "INACTIVE";
      return {
        activated: false,
        intervention: null,
        reason: "Focus shield is disabled (focus_shield_enabled: false)"
      };
    }

    // Rule 4: Privacy Non-Bypass — Blocked domains must remain strictly uncaptured
    for (const frame of frames) {
      if (frame.provenance?.url && isUrlBlocked(frame.provenance.url)) {
        return {
          activated: false,
          intervention: null,
          reason: "Blocked domain uncaptured by focus shield (privacy guard)"
        };
      }
    }

    // Rule 2: False-Positive Prevention — Benign sequences DO NOT trigger activation
    const isFatigueState = metrics.fatigueIndex >= this.config.fatigueThreshold;
    if (!isFatigueState) {
      this.currentState = "IDLE";
      return {
        activated: false,
        intervention: null,
        reason: `Benign frame sequence (fatigueIndex ${metrics.fatigueIndex} < ${this.config.fatigueThreshold})`
      };
    }

    // Rule 3: Intervention Capping — Frequency capped
    const elapsedSinceLast = now - this.lastInterventionTime;
    if (this.lastInterventionTime > 0 && elapsedSinceLast < this.config.minInterventionIntervalMs) {
      return {
        activated: false,
        intervention: null,
        reason: `Intervention frequency capped (${Math.round((this.config.minInterventionIntervalMs - elapsedSinceLast) / 1000)}s remaining)`
      };
    }

    // Rule 1: Observable Activation — Activate shield and record intervention state
    this.currentState = "ACTIVE_SHIELD";
    const intervention: FocusShieldIntervention = {
      timestamp: now,
      reason: `Fatigue score ${metrics.fatigueIndex} reached threshold ${this.config.fatigueThreshold}`,
      fatigueScore: metrics.fatigueIndex,
      action: "CONTEXT_RESTORATION"
    };

    this.lastInterventionTime = now;
    this.interventionHistory.push(intervention);

    return {
      activated: true,
      intervention,
      reason: "Focus shield activated due to high cognitive fatigue state"
    };
  }

  public reset(): void {
    this.currentState = this.config.enabled ? "IDLE" : "INACTIVE";
    this.lastInterventionTime = 0;
    this.interventionHistory = [];
  }
}

export const focusShieldManager = new FocusShieldManager();
