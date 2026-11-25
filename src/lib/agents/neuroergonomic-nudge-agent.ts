import type { CognitiveStateFrame } from "../db";
import type { DriftEvaluation } from "./drift-detector";
import type { TelemetryMetrics } from "../models/cognitive-state-engine";

export interface NeuroergonomicNudge {
  type: "RestRecommendation" | "ContextReconnection" | "FocusAnchorNudge" | "None";
  severity: "Info" | "Soft" | "GentleWarning";
  message: string;
  actionableCTA?: string;
  targetFocusEntity?: string;
}

export class NeuroergonomicNudgeAgent {
  /**
   * Synthesizes continuous state metrics and semantic drift evaluation into neuroergonomic nudges.
   */
  public generateIntervention(
    drift: DriftEvaluation,
    telemetry: TelemetryMetrics,
    currentFrame?: CognitiveStateFrame
  ): NeuroergonomicNudge {
    // 1. Fatigue & Rest Recommendation (High cumulative strain)
    if (telemetry.fatigueIndex >= 75) {
      return {
        type: "RestRecommendation",
        severity: "GentleWarning",
        message: "High mental fatigue detected. Taking a 5-minute eye rest restores focus faster than grinding.",
        actionableCTA: "Step away for 5m"
      };
    }

    // 2. High Context Drift (Rabbit Hole detected while working on deep task)
    if (drift.isContextDrift && drift.driftSeverity === "High (Rabbit Hole)") {
      return {
        type: "FocusAnchorNudge",
        severity: "Soft",
        message: `You were in the flow on "${drift.activeAnchorEntity}". Would you like to resume?`,
        actionableCTA: `Resume "${drift.activeAnchorEntity}"`,
        targetFocusEntity: drift.activeAnchorEntity
      };
    }

    // 3. High Context Switching Overhead (Tab hopping cost > 60 seconds loss)
    if (telemetry.contextSwitchCost > 60 && currentFrame?.userState.intentCategory !== "Distraction / Rabbit Hole") {
      return {
        type: "ContextReconnection",
        severity: "Info",
        message: `Frequent tab hopping detected (~${telemetry.contextSwitchCost}s context restore overhead). Pause & pick 1 main thread.`,
        actionableCTA: "View Active Stack"
      };
    }

    // 4. Mild Drift
    if (drift.isContextDrift && drift.driftSeverity === "Mild" && drift.activeAnchorEntity) {
      return {
        type: "FocusAnchorNudge",
        severity: "Info",
        message: `Active Anchor: ${drift.activeAnchorEntity}`,
        targetFocusEntity: drift.activeAnchorEntity
      };
    }

    return {
      type: "None",
      severity: "Info",
      message: ""
    };
  }
}

export const neuroergonomicNudgeAgent = new NeuroergonomicNudgeAgent();
