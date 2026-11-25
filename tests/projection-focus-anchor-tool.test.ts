/**
 * The producing half of the S2 vertical slice's real-tool wiring
 * (unified-agent task #373 Tier 4, 5.3): exocortex_project_focus_anchor.
 *
 * projectFocusAnchor() itself is already covered by
 * tests/projection-contract-v1.test.ts (28 cases); this file only exercises
 * the thin handler that pulls the live focus anchor and hands it to the
 * projector with the right options.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import "fake-indexeddb/auto";
import { db } from "../src/lib/db";
import { handleProjectFocusAnchor } from "../src/mcp/tools";

beforeAll(async () => {
  await db.cognitive_frames.clear();
  await db.cognitive_frames.add({
    frameId: "test-frame-focus-anchor",
    timestampUtc: 1754524800000,
    sessionId: "test-session-focus-anchor",
    userState: {
      intentCategory: "Deep Work (Drafting/Coding)",
      primaryFocusEntity: "S2 projection contract",
      workingStateSummary: "Drafting the versioned projection schema for gate G2.",
      cognitiveLoadLevel: "High",
      frictionScore: 1,
      cognitiveLoadScore: 0.5,
      fatigueIndex: 0.1,
      contextSwitchCost: 0
    },
    provenance: {
      url: "https://example.com/issues/279",
      pageTitle: "Issue #279",
      activeDwellSeconds: 30,
      userActions: [],
      cleanTextExcerpt: "Drafting the versioned projection schema."
    },
    sourceType: "web"
  });
});

afterAll(async () => {
  await db.cognitive_frames.clear();
});

test("produces a valid contract v1 wire record from the live focus anchor", async () => {
  const record = await handleProjectFocusAnchor({});

  expect(record.kind).toBe("focus_anchor");
  expect(record.contract_version).toBe("1.0");
  // The fixture is a captured page whose entity was set to a phrase. Provenance is
  // decided by source (task #2632): on a browser frame, anything that is not
  // already the site or the category came out of the page, so the projection
  // carries the site. A phrase the classifier wrote and a phrase a fixture author
  // wrote are the same string, and under-crediting ships the page.
  expect(record.payload.focus_entity).toBe("example.com");
  expect(record.payload.intent_category).toBe("Deep Work (Drafting/Coding)");
  expect(record.payload.cognitive_load_level).toBe("High");
  expect(record.provenance.origin_machine).toBe("desktop");
  expect(record.provenance.origin_surface).toBe("browser");
  expect(record.provenance.trust_tier).toBe("local");
  expect(record.provenance.consent_basis).toBe("standing_local_capture");

  // Nothing url-shaped or the raw page title should survive projection.
  const asStr = JSON.stringify(record);
  expect(asStr).not.toContain("/issues/279");
  expect(asStr).not.toContain("Issue #279");
  expect(asStr).not.toContain("S2 projection contract");
});

test("an agent-written focus anchor projects its own entity", async () => {
  // `device://` is the case the projector is for on the agent side: nothing was
  // captured, so the entity the agent supplied is what crosses.
  await db.cognitive_frames.add({
    frameId: "test-frame-agent",
    timestampUtc: 1754524800000 + 60_000,
    sessionId: "test-session-agent",
    userState: {
      intentCategory: "Deep Work (Drafting/Coding)",
      primaryFocusEntity: "S2 projection contract",
      workingStateSummary: "Drafting the versioned projection schema for gate G2.",
      cognitiveLoadLevel: "High",
      frictionScore: 1,
      cognitiveLoadScore: 0.5,
      fatigueIndex: 0.1,
      contextSwitchCost: 0
    },
    provenance: {
      url: "device://mcp/orchestrator/S2%20projection%20contract",
      pageTitle: "S2 projection contract",
      activeDwellSeconds: 60,
      userActions: ["mcp_orchestrated_focus"],
      cleanTextExcerpt: "Drafting the versioned projection schema for gate G2."
    },
    sourceType: "desktop_window"
  });

  const record = await handleProjectFocusAnchor({});
  expect(record.payload.focus_entity).toBe("S2 projection contract");
});

test("honors explicit originMachine/trustTier/consentBasis overrides", async () => {
  const record = await handleProjectFocusAnchor({
    originMachine: "laptop",
    trustTier: "remote",
    consentBasis: "explicit_user_action"
  });

  expect(record.provenance.origin_machine).toBe("laptop");
  expect(record.provenance.trust_tier).toBe("remote");
  expect(record.provenance.consent_basis).toBe("explicit_user_action");
});
