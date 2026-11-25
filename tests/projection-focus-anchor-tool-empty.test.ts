/**
 * Separate file from projection-focus-anchor-tool.test.ts on purpose: bun
 * runs test files in one process, so the "nothing captured yet" case needs
 * its own file that clears the table itself rather than depending on file
 * execution order to find the DB empty.
 */

import { test, expect } from "bun:test";
import "fake-indexeddb/auto";
import { db } from "../src/lib/db";
import { handleProjectFocusAnchor } from "../src/mcp/tools";

test("throws when no focus anchor has been captured yet", async () => {
  await db.cognitive_frames.clear();
  await expect(handleProjectFocusAnchor({})).rejects.toThrow("no focus anchor captured yet");
});
