/**
 * In-Browser Drift Detector Agent with Dynamic Hysteresis & Sensitivity
 * Spec Section 4 & Task #166
 */
import type { CognitiveStateFrame } from "../db";

export interface DriftEvaluation {
  isContextDrift: boolean;
  driftSeverity: "None" | "Mild" | "High (Rabbit Hole)";
  activeAnchorEntity: string;
  suggestedSoftNudge: string | null;
  semanticDistance?: number;
  dynamicThreshold?: number;
  consecutiveDriftCount?: number;
  /**
   * False when no usable embedding pair was available, i.e. `semanticDistance` is a
   * placeholder rather than a measurement and drift is running on category and
   * tab-velocity signals alone. Surfaced so "no drift" cannot be read as "on task"
   * when it really means "we cannot tell".
   */
  vectorSignalAvailable?: boolean;
}

// In-memory state tracking consecutive high-dwell drift frames for hysteresis
let consecutiveHighDwellDriftFrames: number = 0;
let lastEvaluatedFrameId: string | null = null;

/**
 * Reset consecutive drift state (e.g., when anchor is updated)
 */
export function resetDriftHysteresis(): void {
  consecutiveHighDwellDriftFrames = 0;
  lastEvaluatedFrameId = null;
}

/**
 * True when two vectors can actually be compared for meaning.
 *
 * `[]` is truthy, so a plain `if (a && b)` guard let empty vectors — the value
 * `requestVectorEmbedding` returns on *every* failure path — reach `cosineDistance`,
 * which answers 0.0 for them. A distance of 0.0 reads as "identical content", so a
 * totally dead embedding pipeline presented as perfect focus and drift detection
 * silently failed open. Callers must gate on this before trusting a distance.
 */
export function hasComparableVectors(
  a: number[] | Float32Array | undefined,
  b: number[] | Float32Array | undefined
): boolean {
  return Boolean(a && b && a.length > 0 && a.length === b.length);
}

/**
 * Calculates Cosine Distance between two numerical vectors (384-dim MiniLM vectors)
 *
 * Returns 0.0 for incomparable input. That is only safe behind `hasComparableVectors`;
 * do not call this directly on possibly-empty vectors.
 */
export function cosineDistance(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0.0;
  let dot = 0.0, normA = 0.0, normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0.0;
  return 1.0 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/**
 * Length-scaled dynamic sensitivity threshold:
 * Threshold_drift = 0.65 + alpha * e^(-length / 100)
 */
export function computeDynamicDriftThreshold(textLength: number): number {
  const alpha = 0.15;
  const len = Math.max(0, textLength || 0);
  return 0.65 + alpha * Math.exp(-len / 100.0);
}

/**
 * Evaluates context drift using temporal tab velocity, vector distance, dynamic length scaling,
 * and 2-frame dwell hysteresis.
 */
export function evaluateContextDrift(
  activeAnchorFrame: CognitiveStateFrame,
  currentFrame: CognitiveStateFrame,
  recentTabSwitchCountInLast5Mins: number = 0,
  previousFrames: CognitiveStateFrame[] = []
): DriftEvaluation {
  const anchorEntity = activeAnchorFrame?.userState?.primaryFocusEntity || "Active Project";

  // Pause web context-drift calculations when frame is from native desktop window
  if (
    currentFrame?.sourceType === "desktop_window" ||
    currentFrame?.provenance?.url?.startsWith("desktop://")
  ) {
    return {
      isContextDrift: false,
      driftSeverity: "None",
      activeAnchorEntity: anchorEntity,
      suggestedSoftNudge: null,
      semanticDistance: 0.0,
      vectorSignalAvailable: false
    };
  }

  // 1. Calculate semantic distance if vectors are available.
  // `hasComparableVectors` — not a truthiness check — is what keeps an empty vector
  // from being scored as distance 0.0, i.e. "identical to the anchor".
  let semanticDistance = 0.0;
  const vectorSignalAvailable = hasComparableVectors(activeAnchorFrame.vectorAnchor, currentFrame.vectorAnchor);
  if (vectorSignalAvailable) {
    semanticDistance = cosineDistance(activeAnchorFrame.vectorAnchor!, currentFrame.vectorAnchor!);
  }

  // 2. Length-scaled dynamic sensitivity threshold
  const textLen = (currentFrame.provenance?.cleanTextExcerpt || "").length;
  const dynamicThreshold = computeDynamicDriftThreshold(textLen);

  // 3. Distraction category check
  const isDistractionCategory = currentFrame.userState?.intentCategory === "Distraction / Rabbit Hole";
  const rapidTabHopping = recentTabSwitchCountInLast5Mins > 6;

  // 4. Dwell Hysteresis: Requires TWO consecutive high-dwell frames (>15s each) exceeding distance threshold
  const isHighDwell = (currentFrame.provenance?.activeDwellSeconds || 0) >= 15;
  const exceedsThreshold = vectorSignalAvailable && semanticDistance >= dynamicThreshold;

  if (currentFrame.frameId !== lastEvaluatedFrameId) {
    lastEvaluatedFrameId = currentFrame.frameId;
    if (isHighDwell && (exceedsThreshold || isDistractionCategory)) {
      consecutiveHighDwellDriftFrames += 1;
    } else if (isHighDwell && !exceedsThreshold && !isDistractionCategory) {
      consecutiveHighDwellDriftFrames = Math.max(0, consecutiveHighDwellDriftFrames - 1);
    }
  }

  // Also check previousFrames array if passed explicitly
  let passedHysteresis = consecutiveHighDwellDriftFrames >= 2;
  if (!passedHysteresis && previousFrames.length >= 2) {
    const f0 = previousFrames[0];
    const f1 = previousFrames[1];
    const f0Dwell = (f0.provenance?.activeDwellSeconds || 0) >= 15;
    const f1Dwell = (f1.provenance?.activeDwellSeconds || 0) >= 15;
    const f0Comparable = hasComparableVectors(activeAnchorFrame.vectorAnchor, f0.vectorAnchor);
    const f1Comparable = hasComparableVectors(activeAnchorFrame.vectorAnchor, f1.vectorAnchor);
    const f0Dist = f0Comparable ? cosineDistance(activeAnchorFrame.vectorAnchor!, f0.vectorAnchor!) : 0;
    const f1Dist = f1Comparable ? cosineDistance(activeAnchorFrame.vectorAnchor!, f1.vectorAnchor!) : 0;

    if (f0Comparable && f1Comparable && f0Dwell && f1Dwell && f0Dist >= dynamicThreshold && f1Dist >= dynamicThreshold) {
      passedHysteresis = true;
    }
  }

  // 5. Threshold Evaluation
  if (isDistractionCategory || (passedHysteresis && rapidTabHopping)) {
    return {
      isContextDrift: true,
      driftSeverity: "High (Rabbit Hole)",
      activeAnchorEntity: anchorEntity,
      suggestedSoftNudge: `You were working on "${anchorEntity}". Need help stepping back?`,
      semanticDistance: Number(semanticDistance.toFixed(4)),
      dynamicThreshold: Number(dynamicThreshold.toFixed(4)),
      consecutiveDriftCount: consecutiveHighDwellDriftFrames,
      vectorSignalAvailable
    };
  }

  if (passedHysteresis || semanticDistance > dynamicThreshold) {
    return {
      isContextDrift: true,
      driftSeverity: "Mild",
      activeAnchorEntity: anchorEntity,
      suggestedSoftNudge: `Content seems distant from "${anchorEntity}".`,
      semanticDistance: Number(semanticDistance.toFixed(4)),
      dynamicThreshold: Number(dynamicThreshold.toFixed(4)),
      consecutiveDriftCount: consecutiveHighDwellDriftFrames,
      vectorSignalAvailable
    };
  }

  return {
    isContextDrift: false,
    driftSeverity: "None",
    activeAnchorEntity: anchorEntity,
    suggestedSoftNudge: null,
    semanticDistance: Number(semanticDistance.toFixed(4)),
    dynamicThreshold: Number(dynamicThreshold.toFixed(4)),
    consecutiveDriftCount: consecutiveHighDwellDriftFrames,
    vectorSignalAvailable
  };
}
