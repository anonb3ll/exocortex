import { db, type CognitiveCheckpoint, type CognitiveStateFrame, type WorkingMemoryItem } from "../db";
import { buildContextRestorationSummary } from "../models/cognitive-state-engine";
import {
  CAPTURED_PAGE_LABEL,
  focusEntityDerivedFromPageTitle,
  isDeviceProvenance,
  safeCaptureLabel,
  safeGoalTitle
} from "../title-provenance";

/**
 * What capture learned about a goal's provenance. Callers that push an
 * agent-authored goal (`set_focus_anchor`) pass nothing: nothing was captured,
 * so the goal is safe as written.
 */
export type GoalProvenance = { derived: boolean; safeGoalLabel?: string };

export class ContextAnchorAgent {
  /**
   * Captures a mental state checkpoint when transitioning tasks or leaving a deep work session.
   *
   * The provenance flag is decided here, while the frame is still in hand, and
   * stored beside the goal (task #2632): the title-derived `primaryFocusEntity` /
   * `goalTitle` stay at rest for the side panel, and every wire-facing read uses
   * the label computed here instead of trying to re-recognise a title it no longer
   * has. See src/lib/title-provenance.ts.
   */
  public async captureCheckpoint(params: {
    frame: CognitiveStateFrame;
    openTabsContext?: { url: string; title: string; excerpt?: string }[];
    goalTitle?: string;
  }): Promise<CognitiveCheckpoint> {
    const { frame, openTabsContext = [], goalTitle } = params;

    const checkpointId = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const entity = frame.userState.primaryFocusEntity;
    const captured = !isDeviceProvenance(frame.provenance?.url);
    const derived = focusEntityDerivedFromPageTitle(entity, frame.provenance, frame.userState.intentCategory);
    const label = captured ? safeCaptureLabel(frame.provenance, frame.userState.intentCategory) : undefined;
    const effectiveGoal = goalTitle || `Task: ${entity}`;

    const checkpoint: CognitiveCheckpoint = {
      checkpointId,
      timestampUtc: Date.now(),
      sessionId: frame.sessionId,
      goalTitle: effectiveGoal,
      primaryFocusEntity: entity,
      stateSummary: frame.userState.workingStateSummary,
      openTabsContext,
      vectorAnchor: frame.vectorAnchor,
      fromCapturedPage: captured,
      focusDerivedFromPageTitle: derived,
      // Stored for either use: the entity when it is title-derived, and the
      // summary whenever the checkpoint came from a page (see wireSafeCheckpoint).
      safeFocusLabel: label,
      safeGoalTitle: derived && label ? safeGoalTitle(effectiveGoal, entity, label) : undefined
    };

    checkpoint.restorationPrompt = buildContextRestorationSummary(checkpoint);

    await db.cognitive_checkpoints.put(checkpoint);
    await this.pushWorkingMemoryStack(effectiveGoal, checkpointId, {
      derived,
      safeGoalLabel: checkpoint.safeGoalTitle
    });

    return checkpoint;
  }

  /**
   * Pushes or updates an active goal in the working memory stack.
   */
  public async pushWorkingMemoryStack(
    goalTitle: string,
    checkpointId?: string,
    provenance: GoalProvenance = { derived: false }
  ): Promise<WorkingMemoryItem> {
    // Match within the same provenance, even when an older same-text row has
    // different provenance. Legacy rows are treated as captured on reads and
    // must never be reused by an agent push.
    const reusable = await db.working_memory_stack
      .where("activeGoal")
      .equals(goalTitle)
      .filter((row) => (row.goalDerivedFromPageTitle !== false) === provenance.derived)
      .first();
    const stackId = reusable?.stackId || `stack_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const item: WorkingMemoryItem = {
      id: reusable?.id,
      stackId,
      activeGoal: goalTitle,
      status: "active",
      lastUpdatedUtc: Date.now(),
      contextCheckpointId: checkpointId || reusable?.contextCheckpointId,
      goalDerivedFromPageTitle: provenance.derived,
      safeGoalLabel: provenance.derived ? provenance.safeGoalLabel ?? reusable?.safeGoalLabel : undefined
    };

    await db.working_memory_stack.put(item);
    return item;
  }

  /**
   * Retrieves the active working memory stack (sorted by recency).
   *
   * Local, full-fidelity read — the side panel shows the user their own goals.
   * Anything leaving the process goes through `getWireSafeWorkingMemoryStack`.
   */
  public async getActiveWorkingMemoryStack(limit: number = 5): Promise<WorkingMemoryItem[]> {
    return await db.working_memory_stack
      .orderBy("lastUpdatedUtc")
      .reverse()
      .limit(limit)
      .toArray();
  }

  /**
   * The title-free view of the stack: what the MCP tool surface and the native
   * bridge may return. A goal is replaced by the label stored at capture; a row
   * from before task #2632 has no flag, so it is treated as derived rather than
   * assumed safe.
   */
  public async getWireSafeWorkingMemoryStack(limit: number = 5): Promise<WorkingMemoryItem[]> {
    const items = await this.getActiveWorkingMemoryStack(limit);
    return items.map((item) => {
      const derived = item.goalDerivedFromPageTitle !== false;
      return {
        stackId: item.stackId,
        activeGoal: derived ? item.safeGoalLabel || CAPTURED_PAGE_LABEL : item.activeGoal,
        parentGoal: derived ? undefined : item.parentGoal,
        status: item.status,
        lastUpdatedUtc: item.lastUpdatedUtc,
        contextCheckpointId: item.contextCheckpointId,
        goalDerivedFromPageTitle: derived,
        safeGoalLabel: item.safeGoalLabel
      };
    });
  }

  /**
   * Generates a context restoration prompt for the last active deep-work checkpoint.
   *
   * `wireSafe` rebuilds the prompt from the stored fields with the captured title
   * and tab titles taken out, rather than trusting the prompt string written at
   * capture time — which, on a row from before task #2632, still contains them.
   */
  public async getContextRestorationKit(
    focusEntity?: string,
    options: { wireSafe?: boolean } = {}
  ): Promise<string | null> {
    let checkpoint: CognitiveCheckpoint | undefined;

    if (focusEntity) {
      // Only a checkpoint an agent wrote may be looked up by its exact entity. A
      // captured one stores the page title there, and matching those would turn
      // `restore_context(focusEntity)` into a "does this title exist" oracle.
      checkpoint = (
        await db.cognitive_checkpoints.where("primaryFocusEntity").equals(focusEntity).reverse().toArray()
      ).find((c) => c.focusDerivedFromPageTitle === false);

      // The stored label is a legitimate key: it is what the wire exposes, and it
      // is not indexed, so this is a bounded scan of recent rows rather than a query.
      if (!checkpoint) {
        const recent = await db.cognitive_checkpoints.orderBy("timestampUtc").reverse().limit(50).toArray();
        checkpoint = recent.find((c) => c.safeFocusLabel === focusEntity);
      }
    }

    if (!checkpoint) {
      checkpoint = await db.cognitive_checkpoints
        .orderBy("timestampUtc")
        .reverse()
        .first();
    }

    if (!checkpoint) return null;

    if (options.wireSafe) {
      return buildContextRestorationSummary(wireSafeCheckpoint(checkpoint), { wireSafe: true });
    }
    return checkpoint.restorationPrompt || buildContextRestorationSummary(checkpoint);
  }
}

/**
 * The stored checkpoint with everything captured taken out of the fields the
 * prompt prints.
 *
 * Three separate questions, because they have different answers:
 *   - did this come from a page at all (`fromCapturedPage`)?
 *   - is the entity page text (`focusDerivedFromPageTitle`)?
 *   - is the summary page text? On a captured page, always: the classifier writes
 *     "Working on <title>", the head of the excerpt, or an AI paraphrase of the
 *     title, whatever the entity turned out to be. Hiding only the derived entity
 *     left the title standing in `Context Snapshot`.
 *
 * Legacy rows carry no flags and are treated as captured. Their label comes from
 * what was stored at capture or the bare marker — never from the first tab, which
 * on an auto-capture is often the distraction page that triggered it.
 */
function wireSafeCheckpoint(checkpoint: CognitiveCheckpoint): CognitiveCheckpoint {
  if (checkpoint.fromCapturedPage === false) return checkpoint;

  const label = checkpoint.safeFocusLabel || CAPTURED_PAGE_LABEL;
  const entityIsCaptured = checkpoint.focusDerivedFromPageTitle !== false;

  return {
    ...checkpoint,
    primaryFocusEntity: entityIsCaptured ? label : checkpoint.primaryFocusEntity,
    goalTitle: entityIsCaptured ? checkpoint.safeGoalTitle || label : checkpoint.goalTitle,
    stateSummary: label
  };
}

export const contextAnchorAgent = new ContextAnchorAgent();
