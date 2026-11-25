/**
 * One test per surface for the Lows on the #2632 review (comment 7109124993),
 * the follow-up the owner asked for before the exocortex public export.
 *
 *   L-A  the stdio path must not be able to ask for the local, un-redacted prompt
 *   L-B  a host that cannot be a public site is never printed — tab list, search domain
 *   L-C  query_frames must not filter on the stored title
 *   L-D  an agent push must not merge into a title-derived stack row
 */
import { beforeEach, describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { db, type CognitiveStateFrame } from "../src/lib/db";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";
import { classifyIntentAndFocus } from "../src/lib/agents/taxonomy-agent";
import { contextAnchorAgent } from "../src/lib/agents/context-anchor-agent";
import { handleQueryFrames } from "../src/mcp/tools";
import { executeExocortexMcpTool } from "../src/mcp/server";
import { minimizeSemanticSearchResults } from "../src/bridge/protocol";
import { printableHost } from "../src/lib/title-provenance";

const TITLE = "Zanzibar Quokka Migration Handbook";
const EXCERPT =
  "Persimmon lanterns drift over the marsh while the cartographers argue about tides, ledgers and the price of saffron in spring.";

/** A frame as the service worker's DWELL_RECORD pipeline produces it. */
function capturedFrame(url: string, extra: { title?: string } = {}): CognitiveStateFrame {
  const title = extra.title ?? TITLE;
  const frame = createCognitiveFrame({
    sessionId: "s1",
    url,
    pageTitle: title,
    activeDwellSeconds: 30,
    cleanTextExcerpt: EXCERPT,
    timestampUtc: Date.now()
  });
  const classification = classifyIntentAndFocus({ url, title, excerpt: EXCERPT });
  frame.userState.intentCategory = classification.intentCategory;
  frame.userState.primaryFocusEntity = classification.primaryFocusEntity;
  frame.userState.workingStateSummary = classification.workingStateSummary;
  return frame;
}

const LEAK_MARKERS = ["Zanzibar", "Quokka", "Handbook", "Persimmon", "cartographers", "saffron"];

function expectNoCapturedText(wire: unknown) {
  const text = JSON.stringify(wire);
  for (const marker of LEAK_MARKERS) expect(text).not.toContain(marker);
}

describe("the follow-up Lows", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("L-C: query_frames answers on the entity the caller can see, not the stored title", async () => {
    await db.cognitive_frames.put(capturedFrame("https://en.wikipedia.org/wiki/Quokka"));

    // Round trip: the caller was handed the site, so asking for it finds the row.
    const byLabel = await handleQueryFrames({ primaryFocusEntity: "en.wikipedia.org" });
    expect(byLabel.length).toBe(1);

    // Oracle: a growing substring probe against the stored title finds nothing,
    // because the filter no longer runs against the stored value.
    for (const probe of ["Zan", "Zanzibar", "Zanzibar Quokka", TITLE]) {
      expect((await handleQueryFrames({ primaryFocusEntity: probe })).length).toBe(0);
    }
  });

  test("L-A: stdio restore_context always returns the wire-safe prompt", async () => {
    await contextAnchorAgent.captureCheckpoint({
      frame: capturedFrame("https://en.wikipedia.org/wiki/Quokka"),
      goalTitle: `Deep Work: ${TITLE}`
    });

    const result = await executeExocortexMcpTool("exocortex_restore_context", { wireSafe: false });
    expectNoCapturedText(result);
    expect(result.restorationPrompt).toContain("en.wikipedia.org");
  });

  test("L-B: a host that cannot be a public site is never printed", () => {
    for (const host of ["jira.", "foo.test", "foo.localhost", "foo.localdomain", "foo.home", "foo.private", "10.1.2.3", "intranet"]) {
      expect(printableHost(host)).toBe("");
    }
    expect(printableHost("Example.COM.")).toBe("example.com");
  });

  test("L-B: the restored prompt's tab list prints the category, not an intranet host", async () => {
    await contextAnchorAgent.captureCheckpoint({
      frame: capturedFrame("https://wiki.internal/handbook"),
      goalTitle: "Task: handbook",
      openTabsContext: [{ url: "https://wiki.internal/handbook", title: "Team handbook" }]
    });

    const prompt = await contextAnchorAgent.getContextRestorationKit(undefined, { wireSafe: true });
    expect(prompt).not.toContain("wiki.internal");
    expect(prompt).toContain("(captured page)");
  });

  test("L-B: semantic search drops a domain that cannot be printed", () => {
    const [intranet, publicSite] = minimizeSemanticSearchResults([
      { frameId: 1, domain: "wiki.internal", category: "Research & Gathering", timestamp: 1, matchKind: "vector", cosineSimilarity: 0.5, score: 0.5 },
      { frameId: 2, domain: "example.com", category: "Research & Gathering", timestamp: 2, matchKind: "vector", cosineSimilarity: 0.5, score: 0.5 }
    ]);
    expect(intranet.domain).toBeUndefined();
    expect(publicSite.domain).toBe("example.com");
  });

  test("L-D: an agent push does not merge into a title-derived row", async () => {
    await contextAnchorAgent.pushWorkingMemoryStack("Focus: secret project", undefined, {
      derived: true,
      safeGoalLabel: "Focus: example.com"
    });
    // The agent claims the same goal text. Merging would confirm the title is in
    // the stack and hand back the derived row's label, so it gets its own row.
    await contextAnchorAgent.pushWorkingMemoryStack("Focus: secret project");

    const rows = await db.working_memory_stack.toArray();
    expect(rows.length).toBe(2);
    const derived = rows.find((r) => r.goalDerivedFromPageTitle === true);
    const agentRow = rows.find((r) => r.goalDerivedFromPageTitle === false);
    expect(derived?.safeGoalLabel).toBe("Focus: example.com");
    expect(agentRow).toBeDefined();
  });

  test("L-D: repeated agent pushes reuse the agent row when a captured match is older", async () => {
    const goal = "Focus: shared label";
    await contextAnchorAgent.pushWorkingMemoryStack(goal, undefined, { derived: true, safeGoalLabel: "Focus: example.com" });
    const first = await contextAnchorAgent.pushWorkingMemoryStack(goal);
    const again = await contextAnchorAgent.pushWorkingMemoryStack(goal);
    expect(again.stackId).toBe(first.stackId);
    expect(await db.working_memory_stack.count()).toBe(2);
  });

  test("L-D: later capture cannot change an existing agent row's provenance", async () => {
    const goal = "Focus: shared label";
    const agent = await contextAnchorAgent.pushWorkingMemoryStack(goal);
    const captured = await contextAnchorAgent.pushWorkingMemoryStack(goal, undefined, { derived: true, safeGoalLabel: "Focus: example.com" });
    expect(captured.stackId).not.toBe(agent.stackId);
    const again = await contextAnchorAgent.pushWorkingMemoryStack(goal, undefined, { derived: true, safeGoalLabel: "Focus: example.com" });
    expect(again.stackId).toBe(captured.stackId);
    expect(await db.working_memory_stack.count()).toBe(2);
  });

  test("L-D: two captured pushes of one goal still collapse to one row", async () => {
    for (let i = 0; i < 2; i += 1) {
      await contextAnchorAgent.pushWorkingMemoryStack("Focus: Zanzibar", undefined, {
        derived: true,
        safeGoalLabel: "Focus: en.wikipedia.org"
      });
    }
    expect((await db.working_memory_stack.toArray()).length).toBe(1);
  });
});
