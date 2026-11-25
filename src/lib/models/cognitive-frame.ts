import type { CognitiveStateFrame } from "../db";
import { classifyIntentAndFocus } from "../agents/taxonomy-agent";
import { calculateContinuousLoadAndFatigue } from "./cognitive-state-engine";

export function createCognitiveFrame(params: {
  sessionId: string;
  url: string;
  pageTitle: string;
  activeDwellSeconds: number;
  cleanTextExcerpt?: string;
  userActions?: string[];
  vectorAnchor?: number[];
  recentTabSwitchesIn5Min?: number;
  cumulativeSessionMinutes?: number;
  /** Activity/capture time. Defaults to now; dwell path must pass the dwell timestamp. */
  timestampUtc?: number;
}): CognitiveStateFrame {
  const classification = classifyIntentAndFocus({
    url: params.url,
    title: params.pageTitle,
    excerpt: params.cleanTextExcerpt
  });

  const telemetry = calculateContinuousLoadAndFatigue({
    intentCategory: classification.intentCategory,
    activeDwellSeconds: params.activeDwellSeconds,
    recentTabSwitchesIn5Min: params.recentTabSwitchesIn5Min || 0,
    cumulativeSessionMinutes: params.cumulativeSessionMinutes || 0
  });

  return {
    frameId: `frame_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    // Prefer the originating activity time over "when embedding finished" so
    // consumers comparing frames to dwell blocks see a shared capture clock.
    timestampUtc: params.timestampUtc ?? Date.now(),
    sessionId: params.sessionId,
    userState: {
      intentCategory: classification.intentCategory,
      primaryFocusEntity: classification.primaryFocusEntity,
      workingStateSummary: classification.workingStateSummary,
      cognitiveLoadLevel: classification.cognitiveLoadLevel,
      frictionScore: classification.frictionScore,
      cognitiveLoadScore: telemetry.cognitiveLoadScore,
      fatigueIndex: telemetry.fatigueIndex,
      contextSwitchCost: telemetry.contextSwitchCost
    },
    provenance: {
      url: params.url,
      pageTitle: params.pageTitle,
      activeDwellSeconds: params.activeDwellSeconds,
      userActions: params.userActions || ["dwell"],
      cleanTextExcerpt: (params.cleanTextExcerpt || "").substring(0, 500)
    },
    vectorAnchor: params.vectorAnchor
  };
}
