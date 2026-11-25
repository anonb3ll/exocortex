/**
 * Page titles must not cross the bridge inside `userState`.
 *
 * `minimizeFrame` strips `provenance.pageTitle`, and other tests assert the
 * wire is title-free. But the rule-based classifier *copies* the title into
 * `userState.primaryFocusEntity` for research, mail and task pages, puts
 * "Working on <title>" or the first 100 characters of the excerpt into
 * `workingStateSummary`, and `userState` was passed across whole. The title
 * left by the front door and came back in through the side.
 *
 * These tests build frames exactly the way the service worker does — through
 * the real classifier — and assert nothing of the title or excerpt survives
 * any bridge-facing path.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db, type CognitiveStateFrame } from "../src/lib/db";
import { classifyIntentAndFocus } from "../src/lib/agents/taxonomy-agent";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";
import { minimizeBridgeResult, minimizeFrame, wireSafeUserState } from "../src/bridge/protocol";
import {
  handleCreateCognitiveCheckpoint,
  handleGetFocusAnchor,
  handleGetWorkingMemoryStack,
  handleProjectFocusAnchor,
  handleProjectTaskReference,
  handleQueryFrames,
  handleRestoreContext,
  handleSetFocusAnchor
} from "../src/mcp/tools";
import { contextAnchorAgent } from "../src/lib/agents/context-anchor-agent";

const TITLE = "Zanzibar Quokka Migration Handbook";
const EXCERPT =
  "Persimmon lanterns drift over the marsh while the cartographers argue about tides, ledgers and the price of saffron in spring.";

/** A frame as the service worker's DWELL_RECORD pipeline produces it. */
function capturedFrame(url: string, extra: { siteName?: string; byline?: string; contentKind?: "video" | "article" | "page"; title?: string } = {}): CognitiveStateFrame {
  const title = extra.title ?? TITLE;
  const frame = createCognitiveFrame({
    sessionId: "s1",
    url,
    pageTitle: title,
    activeDwellSeconds: 30,
    cleanTextExcerpt: EXCERPT,
    timestampUtc: Date.now()
  });
  const classification = classifyIntentAndFocus({ url, title, excerpt: EXCERPT, ...extra });
  frame.userState.intentCategory = classification.intentCategory;
  frame.userState.primaryFocusEntity = classification.primaryFocusEntity;
  frame.userState.workingStateSummary = classification.workingStateSummary;
  return frame;
}

/** The distinctive words of the title and excerpt; none may appear on the wire. */
const LEAK_MARKERS = ["Zanzibar", "Quokka", "Handbook", "Persimmon", "cartographers", "saffron"];

function expectNoCapturedText(wire: unknown) {
  const text = JSON.stringify(wire);
  for (const marker of LEAK_MARKERS) expect(text).not.toContain(marker);
  expect(text.toLowerCase()).not.toContain(TITLE.toLowerCase());
}

const PAGES: Array<[string, string]> = [
  ["research page", "https://en.wikipedia.org/wiki/Quokka"],
  ["Gmail", "https://mail.google.com/mail/u/0/#inbox/abc"],
  ["task page", "https://linear.app/team/issue/ABC-1"],
  ["docs page", "https://docs.example.com/guide"],
  ["Jira", "https://jira.example.com/browse/ABC-1"]
];

describe("the defect: the classifier copies the title into userState", () => {
  test.each(PAGES)("%s: primaryFocusEntity is the page title at rest", (_name, url) => {
    // This is what makes passing userState through whole a leak. It stays true
    // at rest — the side panel shows it to the user — and is fixed on the wire.
    expect(capturedFrame(url).userState.primaryFocusEntity).toBe(TITLE);
  });

  test("workingStateSummary is the head of the page excerpt on a research page", () => {
    const frame = capturedFrame("https://en.wikipedia.org/wiki/Quokka");
    expect(frame.userState.workingStateSummary).toBe(EXCERPT.substring(0, 100));
  });
});

describe("minimizeFrame", () => {
  test.each(PAGES)("%s: no title or excerpt text crosses", (_name, url) => {
    const minimized = minimizeFrame(capturedFrame(url));
    expectNoCapturedText(minimized);
    expect(JSON.stringify(minimized)).not.toContain(url);
  });

  test("a title-derived entity becomes the site, and the summary the category on that site", () => {
    const minimized = minimizeFrame(capturedFrame("https://en.wikipedia.org/wiki/Quokka"));
    expect(minimized.userState.primaryFocusEntity).toBe("en.wikipedia.org");
    expect(minimized.userState.workingStateSummary).toBe("Research & Gathering on en.wikipedia.org");
    // Everything that is not captured text is untouched.
    expect(minimized.userState.intentCategory).toBe("Research & Gathering");
    expect(minimized.userState.cognitiveLoadLevel).toBe("Medium");
    expect(minimized.activeDwellSeconds).toBe(30);
  });

  test("a video title with its site suffix trimmed is still recognised as the title", () => {
    const frame = capturedFrame("https://www.youtube.com/watch?v=abc", {
      title: `${TITLE} - YouTube`,
      siteName: "YouTube",
      byline: "Some Channel",
      contentKind: "video"
    });
    expect(frame.userState.primaryFocusEntity).toBe(TITLE);

    const minimized = minimizeFrame(frame);
    expectNoCapturedText(minimized);
    expect(minimized.userState.primaryFocusEntity).toBe("youtube.com");
  });

  test("matching ignores case and whitespace differences", () => {
    const frame = capturedFrame("https://en.wikipedia.org/wiki/Quokka");
    frame.userState.primaryFocusEntity = `  ${TITLE.toUpperCase()}  `;
    frame.userState.workingStateSummary = `Reading   ${TITLE.toLowerCase()}`;
    expectNoCapturedText(minimizeFrame(frame));
  });

  test("the stored frame is not modified", async () => {
    const frame = capturedFrame("https://en.wikipedia.org/wiki/Quokka");
    const before = JSON.stringify(frame);
    minimizeFrame(frame);
    expect(JSON.stringify(frame)).toBe(before);
  });

  test("an entity that is not the site label or the category is treated as captured", () => {
    const frame = capturedFrame("https://github.com/owner/repo/pull/12");
    // GitHub pages are focused on owner/repo — no space, and not in this title, so
    // a shape test ("looks like a phrase") passed it. But `owner/repo` is the URL
    // path: with the site it rebuilds the URL, which is what the projection
    // contract forbids. Provenance is decided by source, so it becomes the site.
    expect(frame.userState.primaryFocusEntity).toBe("owner/repo");
    const safe = wireSafeUserState(frame);
    expect(safe.primaryFocusEntity).toBe("github.com");
    expectNoCapturedText(safe);
  });

  test("a frame an agent wrote through MCP keeps the entity the agent supplied", async () => {
    await db.cognitive_frames.clear();
    await db.working_memory_stack.clear();
    await handleSetFocusAnchor({
      goalTitle: "Ship 5.2",
      primaryFocusEntity: "bridge protocol",
      workingStateSummary: "wiring validators"
    });
    const [frame] = await db.cognitive_frames.toArray();
    // Its "page title" is the agent's own entity; there is nothing captured in it.
    expect(frame.provenance.pageTitle).toBe("bridge protocol");
    expect(minimizeFrame(frame).userState).toEqual(frame.userState);
  });

  test("the telemetry snapshot's activeFrame goes through the same minimization", () => {
    const result = minimizeBridgeResult("get_cognitive_load_telemetry", {
      activeFrame: capturedFrame("https://mail.google.com/mail/u/0/#inbox"),
      recentTabSwitchesIn5Mins: 1,
      cumulativeSessionMinutes: 3
    });
    expectNoCapturedText(result);
  });
});

describe("the bridge-facing handlers", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("query_frames: what reaches the wire carries no title", async () => {
    for (const [, url] of PAGES) await db.cognitive_frames.put(capturedFrame(url));
    const wire = minimizeBridgeResult("query_frames", await handleQueryFrames({ limit: 10 }));
    expect((wire as unknown[]).length).toBe(PAGES.length);
    expectNoCapturedText(wire);
  });

  test("get_focus_anchor: the bridge handler's answer carries no title", async () => {
    await db.cognitive_frames.put(capturedFrame("https://en.wikipedia.org/wiki/Quokka"));

    // What the service worker's handler returns, then the bridge minimizer.
    const wire = minimizeBridgeResult("get_focus_anchor", await handleGetFocusAnchor({ wireSafe: true }));
    expectNoCapturedText(wire);
    expect(wire).toMatchObject({
      activeFocusEntity: "en.wikipedia.org",
      workingStateSummary: "Research & Gathering on en.wikipedia.org",
      intentCategory: "Research & Gathering"
    });
    expect(JSON.stringify(wire)).not.toContain("wiki/Quokka");
  });

  test("get_focus_anchor in-process is unchanged: it is the user's own machine and already returns the URL", async () => {
    await db.cognitive_frames.put(capturedFrame("https://en.wikipedia.org/wiki/Quokka"));
    const local = await handleGetFocusAnchor();
    expect(local.activeFocusEntity).toBe(TITLE);
    expect(local.url).toBe("https://en.wikipedia.org/wiki/Quokka");
  });

  test("the contract-v1 projections carry no title either", async () => {
    await db.cognitive_frames.put(capturedFrame("https://linear.app/team/issue/ABC-1"));

    const anchor = await handleProjectFocusAnchor({});
    expectNoCapturedText(anchor);
    expect(anchor.payload.focus_entity).toBe("linear.app");

    const reference = await handleProjectTaskReference({ taskId: 279, confidence: 0.8 });
    expectNoCapturedText(minimizeBridgeResult("project_task_reference", reference));
  });

  test("an agent-set anchor still comes back as the agent set it", async () => {
    await handleSetFocusAnchor({ goalTitle: "Ship 5.2", primaryFocusEntity: "bridge protocol" });
    const wire = minimizeBridgeResult("get_focus_anchor", await handleGetFocusAnchor({ wireSafe: true }));
    expect(wire).toMatchObject({ activeFocusEntity: "bridge protocol" });
  });
});

/**
 * The same title, through the two tools that store it instead of passing a frame
 * along: the working-memory stack and the checkpoint behind `restore_context`.
 * `wireSafeUserState` compares a field against the frame's own title, which these
 * paths cannot do — the frame is gone by the time the stack is read. So the answer
 * is recorded at capture and the readers minimize by flag (task #2632).
 */
describe("the working-memory stack and restore_context", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  const captureDeepWorkCheckpoint = async () =>
    contextAnchorAgent.captureCheckpoint({
      frame: capturedFrame("https://en.wikipedia.org/wiki/Quokka"),
      goalTitle: `Deep Work: ${TITLE}`,
      openTabsContext: [{ url: "https://en.wikipedia.org/wiki/Quokka", title: TITLE, excerpt: EXCERPT }]
    });

  test("capture records that the goal came out of the page title", async () => {
    const checkpoint = await captureDeepWorkCheckpoint();

    // At rest the full text stays: this is the user's own machine and their side panel.
    expect(checkpoint.primaryFocusEntity).toBe(TITLE);
    expect(checkpoint.goalTitle).toBe(`Deep Work: ${TITLE}`);

    // Beside it, the answer the wire-facing reads use.
    expect(checkpoint.focusDerivedFromPageTitle).toBe(true);
    expect(checkpoint.safeFocusLabel).toBe("en.wikipedia.org");
    expect(checkpoint.safeGoalTitle).toBe("Deep Work: en.wikipedia.org");

    const [item] = await db.working_memory_stack.toArray();
    expect(item.activeGoal).toBe(`Deep Work: ${TITLE}`);
    expect(item.goalDerivedFromPageTitle).toBe(true);
    expect(item.safeGoalLabel).toBe("Deep Work: en.wikipedia.org");
  });

  test("get_working_memory_stack over MCP carries no title", async () => {
    await captureDeepWorkCheckpoint();
    const wire = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expectNoCapturedText(wire);
    expect((wire as Array<{ activeGoal: string }>)[0].activeGoal).toBe("Deep Work: en.wikipedia.org");
  });

  test("restore_context carries no title, excerpt, tab title or url", async () => {
    await captureDeepWorkCheckpoint();
    const wire = minimizeBridgeResult("restore_context", await handleRestoreContext({}));
    expectNoCapturedText(wire);
    const prompt = (wire as { restorationPrompt: string }).restorationPrompt;
    expect(prompt).toContain("**Active Focus:** en.wikipedia.org");
    expect(prompt).not.toContain("wiki/Quokka");
  });

  test("the in-process restoration kit still shows the user their own text", async () => {
    await captureDeepWorkCheckpoint();
    const local = await contextAnchorAgent.getContextRestorationKit();
    expect(local).toContain(TITLE);
    expect(local).toContain("wiki/Quokka");
  });

  test("a checkpoint of an agent-supplied goal crosses unchanged", async () => {
    await handleSetFocusAnchor({
      goalTitle: "Ship 5.2",
      primaryFocusEntity: "bridge protocol",
      workingStateSummary: "wiring validators"
    });
    const [frame] = await db.cognitive_frames.toArray();
    const checkpoint = await contextAnchorAgent.captureCheckpoint({ frame, goalTitle: "Ship 5.2" });

    expect(checkpoint.focusDerivedFromPageTitle).toBe(false);
    const wire = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expect((wire as Array<{ activeGoal: string }>)[0].activeGoal).toBe("Ship 5.2");
    const prompt = (minimizeBridgeResult("restore_context", await handleRestoreContext({})) as {
      restorationPrompt: string;
    }).restorationPrompt;
    expect(prompt).toContain("**Goal:** Ship 5.2");
  });

  test("a stack row written before the flag existed is treated as captured, not assumed safe", async () => {
    await db.working_memory_stack.put({
      stackId: "legacy",
      activeGoal: `Focus: ${TITLE}`,
      status: "active",
      lastUpdatedUtc: Date.now()
    });

    const wire = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expectNoCapturedText(wire);
    expect((wire as Array<{ activeGoal: string }>)[0].activeGoal).toBe("(captured page)");
  });

  test("a checkpoint written before the flag existed is rebuilt title-free", async () => {
    // The stored prompt of a pre-#2632 row still contains the title; the reader
    // must not hand that string back.
    await db.cognitive_checkpoints.put({
      checkpointId: "chk_legacy",
      timestampUtc: Date.now(),
      sessionId: "s1",
      goalTitle: `Deep Work: ${TITLE}`,
      primaryFocusEntity: TITLE,
      stateSummary: EXCERPT.substring(0, 100),
      openTabsContext: [{ url: "https://en.wikipedia.org/wiki/Quokka", title: TITLE }],
      restorationPrompt: `### Mental State Resumption (4m ago)\n**Active Focus:** ${TITLE}\n**Goal:** Deep Work: ${TITLE}\n\n**Context Snapshot:**\n${EXCERPT}\n\n**Key Working Tabs:**\n• ${TITLE} (https://en.wikipedia.org/wiki/Quokka)\n`
    });

    const wire = minimizeBridgeResult("restore_context", await handleRestoreContext({}));
    expectNoCapturedText(wire);
    expect((wire as { restorationPrompt: string }).restorationPrompt).toContain("en.wikipedia.org");
  });
});

/**
 * The independent privacy review at ea3c601 found a hole one layer over from the
 * entity: `stateSummary` is "Working on <title>" on any captured page, whatever
 * the entity looks like, so hiding only a derived entity still printed the title
 * under `Context Snapshot` — and the whitespace test for "is this a phrase" let
 * URL-path entities (`owner/repo`, a gist id) through. These cases hold the fix:
 * provenance by source, and the summary replaced on every browser frame.
 */
describe("the privacy review's cases (H1, M1-M3, Lows)", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  /** A gist page: the classifier hands back `<user>/<hash>`, the title is "notes.md · GitHub". */
  function gistFrame(): CognitiveStateFrame {
    const frame = capturedFrame("https://gist.github.com/someuser/9f2c1ab", { title: "notes.md · GitHub" });
    frame.userState.primaryFocusEntity = "someuser/9f2c1ab";
    frame.userState.workingStateSummary = "Working on notes.md · GitHub";
    return frame;
  }

  test("H1: restore_context does not print the title through stateSummary on a gist", async () => {
    await contextAnchorAgent.captureCheckpoint({
      frame: gistFrame(),
      goalTitle: "Task: someuser/9f2c1ab",
      openTabsContext: [{ url: "https://gist.github.com/someuser/9f2c1ab", title: "notes.md · GitHub" }]
    });

    const wire = minimizeBridgeResult("restore_context", await handleRestoreContext({})) as {
      restorationPrompt: string;
    };
    expect(wire.restorationPrompt).not.toContain("notes.md");
    expect(wire.restorationPrompt).not.toContain("someuser/9f2c1ab");
    expect(wire.restorationPrompt).toContain("gist.github.com");

    const stack = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expect(JSON.stringify(stack)).not.toContain("notes.md");
    expect(JSON.stringify(stack)).not.toContain("someuser/9f2c1ab");
  });

  test("M1: a URL-path entity is the page's, not the agent's", async () => {
    const frame = capturedFrame("https://github.com/owner/repo/pull/12");
    expect(frame.userState.primaryFocusEntity).toBe("owner/repo");

    await contextAnchorAgent.captureCheckpoint({ frame, goalTitle: "Task: owner/repo" });
    const wire = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expect((wire as Array<{ activeGoal: string }>)[0].activeGoal).toBe("Task: github.com");
    expect(JSON.stringify(wire)).not.toContain("owner/repo");
  });

  test("M3: an AI paraphrase does not cross query_frames or the telemetry snapshot", () => {
    const frame = capturedFrame("https://docs.google.com/document/d/abc123");
    frame.userState.primaryFocusEntity = "Quarterly budget planning";
    frame.userState.workingStateSummary = "Reviewing the quarterly numbers";

    const minimized = minimizeFrame(frame);
    expect(minimized.userState.primaryFocusEntity).toBe("docs.google.com");
    expect(JSON.stringify(minimized)).not.toContain("Quarterly");

    const telemetry = minimizeBridgeResult("get_cognitive_load_telemetry", {
      activeFrame: frame,
      recentTabSwitchesIn5Mins: 1,
      cumulativeSessionMinutes: 2
    });
    expect(JSON.stringify(telemetry)).not.toContain("Quarterly");
  });

  test("M2: the side panel still shows the user their own prompt", async () => {
    await contextAnchorAgent.captureCheckpoint({
      frame: capturedFrame("https://en.wikipedia.org/wiki/Quokka"),
      goalTitle: `Deep Work: ${TITLE}`
    });

    // What GET_FOCUS_SHIELD_CONTEXT asks for: the agent method directly, because
    // the MCP-facing handler no longer takes a local option an MCP request could
    // set (L-A). This is the panel's own path in service-worker.ts.
    const local = await contextAnchorAgent.getContextRestorationKit(undefined, { wireSafe: false });
    expect(local).toContain(TITLE);

    // What the MCP tool surface answers.
    const wire = await handleRestoreContext({});
    expect(wire.restorationPrompt).not.toContain(TITLE);
  });

  test("L1: a captured title cannot be used as a lookup oracle", async () => {
    await contextAnchorAgent.captureCheckpoint({
      frame: capturedFrame("https://en.wikipedia.org/wiki/Quokka"),
      goalTitle: `Deep Work: ${TITLE}`
    });
    // Distinct capture times: the fallback picks the latest checkpoint.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // An agent checkpoint, written after it, as the latest row.
    const deviceFrame = createCognitiveFrame({
      sessionId: "s-mcp",
      url: "device://mcp/bridge%20protocol",
      pageTitle: "bridge protocol",
      activeDwellSeconds: 60
    });
    deviceFrame.userState.primaryFocusEntity = "bridge protocol";
    deviceFrame.userState.workingStateSummary = "wiring validators";
    await contextAnchorAgent.captureCheckpoint({ frame: deviceFrame, goalTitle: "Ship 5.2" });

    const prompt = await contextAnchorAgent.getContextRestorationKit(TITLE, { wireSafe: true });
    expect(prompt).not.toContain(TITLE);
    expect(prompt).toContain("Ship 5.2");

    // The safe label is a legitimate key.
    const byLabel = await contextAnchorAgent.getContextRestorationKit("en.wikipedia.org", { wireSafe: true });
    expect(byLabel).toContain("en.wikipedia.org");
  });

  test("L2: a later agent push leaves the captured row and its safe label intact", async () => {
    const captured = await contextAnchorAgent.pushWorkingMemoryStack("Focus: secret project", "captured-checkpoint", {
      derived: true,
      safeGoalLabel: "Focus: example.com"
    });
    const agent = await contextAnchorAgent.pushWorkingMemoryStack("Focus: secret project");
    expect(agent.stackId).not.toBe(captured.stackId);
    expect(agent.contextCheckpointId).toBeUndefined();
    const persisted = (await contextAnchorAgent.getWireSafeWorkingMemoryStack()).find((row) => row.stackId === captured.stackId);
    expect(persisted?.goalDerivedFromPageTitle).toBe(true);
    expect(persisted?.activeGoal).toBe("Focus: example.com");
    expect(persisted?.contextCheckpointId).toBe("captured-checkpoint");
  });

  test("L3: create_cognitive_checkpoint uses the agent's own summary, not the open page's", async () => {
    await db.cognitive_frames.put(capturedFrame("https://en.wikipedia.org/wiki/Quokka"));

    await handleCreateCognitiveCheckpoint({
      goalTitle: "Ship 5.2",
      primaryFocusEntity: "bridge protocol",
      stateSummary: "wiring validators"
    });

    const wire = minimizeBridgeResult("restore_context", await handleRestoreContext({})) as {
      restorationPrompt: string;
    };
    expectNoCapturedText(wire);
    expect(wire.restorationPrompt).toContain("bridge protocol");
    expect(wire.restorationPrompt).toContain("wiring validators");
  });

  test("L4: an intranet host is replaced by the category, not printed", async () => {
    const frame = capturedFrame("https://wiki.internal/handbook");
    await contextAnchorAgent.captureCheckpoint({ frame, goalTitle: `Task: ${frame.userState.primaryFocusEntity}` });

    const wire = minimizeBridgeResult("get_working_memory_stack", await handleGetWorkingMemoryStack());
    expect(JSON.stringify(wire)).not.toContain("wiki.internal");
    expect((wire as Array<{ activeGoal: string }>)[0].activeGoal).toBe(`Task: ${frame.userState.intentCategory}`);
  });
});
