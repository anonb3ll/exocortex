/**
 * Sanitized telemetry export — a plain Dexie/tools unit test.
 *
 * Renamed off the `smoke-` prefix, which the docs and tests/fixtures/browser-launch.ts
 * both use to mean "drives real Chrome via Puppeteer and skips without a display".
 * This file launches no browser and never skips, so the old name made a green run
 * look like evidence Chrome had been exercised when it was not.
 */
import { test, expect, beforeAll } from 'bun:test';
import "fake-indexeddb/auto";
import { db } from "../src/lib/db";
import { handleGetSanitizedTelemetryExport } from "../src/mcp/tools";

beforeAll(async () => {
  // Insert a mock cognitive frame with sensitive/PII data
  await db.cognitive_frames.add({
    frameId: "test-frame-123",
    timestampUtc: Date.now(),
    sessionId: "test-session-abc",
    userState: {
      intentCategory: "Deep Work (Drafting/Coding)",
      primaryFocusEntity: "Top Secret Project Alpha",
      workingStateSummary: "Writing confidential algorithms for Exocortex.",
      cognitiveLoadLevel: "Medium",
      frictionScore: 2,
      cognitiveLoadScore: 0.65,
      fatigueIndex: 0.2,
      contextSwitchCost: 0
    },
    provenance: {
      url: "https://internal.corp.com/secret-doc",
      pageTitle: "Confidential Algorithms Document",
      activeDwellSeconds: 45,
      userActions: ["scroll", "click"],
      cleanTextExcerpt: "This algorithm uses a novel vector hashing approach..."
    },
    sourceType: "web"
  });
});

test('exocortex_get_sanitized_telemetry_export returns high-level metrics without raw content', async () => {
  const result: any = await handleGetSanitizedTelemetryExport({ sourceDevice: "laptop" });

  expect(result).toBeDefined();
  expect(result.sanitized).toBe(true);
  
  // High-level telemetry should be present
  expect(typeof result.cognitiveLoadScore).toBe("number");
  expect(result.intentCategory).toBe("Deep Work (Drafting/Coding)");
  expect(result.sourceDevice).toBe("laptop");
  
  // Ensure NO raw content is exposed in the export
  const exportStr = JSON.stringify(result).toLowerCase();
  
  expect(exportStr).not.toContain("secret");
  expect(exportStr).not.toContain("internal.corp.com");
  expect(exportStr).not.toContain("confidential");
  expect(exportStr).not.toContain("algorithm");
  
  // Ensure properties are strictly bounded
  expect(result.url).toBeUndefined();
  expect(result.pageTitle).toBeUndefined();
  expect(result.workingStateSummary).toBeUndefined();
  expect(result.primaryFocusEntity).toBeUndefined();
  expect(result.cleanTextExcerpt).toBeUndefined();
});
