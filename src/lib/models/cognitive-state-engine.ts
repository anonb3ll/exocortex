import type { CognitiveStateFrame, CognitiveCheckpoint } from "../db";
import { displayHost, hostnameOf } from "../host-match";
import { CAPTURED_PAGE_LABEL, printableHost } from "../title-provenance";

export interface TelemetryMetrics {
  cognitiveLoadScore: number; // 0.0 to 1.0
  fatigueIndex: number; // 0.0 to 100.0
  contextSwitchCost: number; // calculated overhead penalty in seconds
}

export interface HighLevelTelemetryExport {
  cognitiveLoadScore: number;
  fatigueIndex: number;
  contextSwitchCost: number;
  intentCategory: CognitiveStateFrame["userState"]["intentCategory"] | "Idle / Transition";
  recentTabSwitchesIn5Mins: number;
  cumulativeSessionMinutes: number;
  timestampUtc: number;
  sourceDevice: string;
  sanitized: true;
}


/**
 * Calculates continuous cognitive load score, fatigue accumulation, and context switch cost.
 */
export function calculateContinuousLoadAndFatigue(params: {
  intentCategory: CognitiveStateFrame["userState"]["intentCategory"];
  activeDwellSeconds: number;
  recentTabSwitchesIn5Min: number;
  cumulativeSessionMinutes?: number;
}): TelemetryMetrics {
  const { intentCategory, activeDwellSeconds, recentTabSwitchesIn5Min, cumulativeSessionMinutes = 0 } = params;

  // Base load factor per intent category
  let baseLoad = 0.5;
  switch (intentCategory) {
    case "Deep Work (Drafting/Coding)":
      baseLoad = 0.85;
      break;
    case "Research & Gathering":
      baseLoad = 0.65;
      break;
    case "Task Execution & Ops":
      baseLoad = 0.6;
      break;
    case "Communication & Async":
      baseLoad = 0.45;
      break;
    case "Distraction / Rabbit Hole":
      baseLoad = 0.2;
      break;
    case "Idle / Transition":
      baseLoad = 0.1;
      break;
  }

  // Velocity penalty from rapid tab hopping (0.05 per extra switch above 3)
  const tabHoppingPenalty = Math.min(0.3, Math.max(0, (recentTabSwitchesIn5Min - 3) * 0.05));
  const cognitiveLoadScore = Math.min(1.0, Math.max(0.0, baseLoad + tabHoppingPenalty));

  // Context Switch Overhead Calculation (approx. 18 seconds loss per non-linear switch)
  const contextSwitchCost = Math.round(recentTabSwitchesIn5Min * 18);

  // Fatigue Index calculation:
  // Combines cumulative focus time without break + high-velocity tab switching strain
  const timeFatigue = Math.min(60, (cumulativeSessionMinutes / 60) * 40); // Max 60 pts after 90 mins
  const velocityFatigue = Math.min(40, recentTabSwitchesIn5Min * 4); // Max 40 pts
  const fatigueIndex = Math.min(100, Math.round(timeFatigue + velocityFatigue));

  return {
    cognitiveLoadScore: Number(cognitiveLoadScore.toFixed(2)),
    fatigueIndex,
    contextSwitchCost
  };
}

/**
 * Builds a clear, neuroergonomic context restoration prompt for resuming work.
 *
 * `wireSafe` is set wherever the prompt leaves this process's trust boundary (the
 * MCP tool surface, the native bridge). The stored checkpoint holds the page title
 * in `primaryFocusEntity` / `goalTitle` and in each tab's `title` and `url`; the
 * wire-safe form prints the site for tabs and nothing captured for the focus, so
 * `restore_context` cannot hand an agent the title the rest of the bridge strips.
 * The side panel keeps calling this without the option.
 */
export function buildContextRestorationSummary(
  checkpoint: CognitiveCheckpoint,
  options: { wireSafe?: boolean } = {}
): string {
  const wireSafe = options.wireSafe === true;
  const timeAgoMins = Math.max(1, Math.round((Date.now() - checkpoint.timestampUtc) / 60000));
  const topTabs = checkpoint.openTabsContext
    .slice(0, 3)
    .map((t) =>
      wireSafe
        ? `• ${printableHost(displayHost(hostnameOf(t.url))) || CAPTURED_PAGE_LABEL}`
        : `• ${t.title} (${t.url})`
    )
    .join("\n");

  return `### Mental State Resumption (${timeAgoMins}m ago)
**Active Focus:** ${checkpoint.primaryFocusEntity}
**Goal:** ${checkpoint.goalTitle}

**Context Snapshot:**
${checkpoint.stateSummary}

**Key Working Tabs:**
${topTabs || "None captured"}
`;
}
