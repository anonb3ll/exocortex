import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  db,
  getRetentionMaxAgeDays,
  setRetentionMaxAgeDays,
  getRetentionCutoff,
  isTimestampExpired,
  upsertPageText,
  pruneOldData,
  DEFAULT_RETENTION_MAX_AGE_DAYS
} from "../src/lib/db";
import { searchBrowserMemory } from "../src/lib/browser-memory-search";
import { hybridVectorSearch } from "../src/lib/models/vector-search";

describe("Exocortex Configurable Retention Controls (Task #661)", () => {
  beforeEach(async () => {
    setRetentionMaxAgeDays(null);
    delete process.env.EXOCORTEX_RETENTION_DAYS;
    await db.page_text.clear();
    await db.cognitive_frames.clear();
    await db.sessions.clear();
    await db.dwell_blocks.clear();
    await db.frames.clear();
    await db.embeddings.clear();
    await db.telemetry.clear();
    await db.working_memory_stack.clear();
    await db.anchors.clear();
  });

  afterEach(async () => {
    setRetentionMaxAgeDays(null);
    delete process.env.EXOCORTEX_RETENTION_DAYS;
  });

  test("retention defaults to 7 days and is dynamically configurable", () => {
    expect(getRetentionMaxAgeDays()).toBe(DEFAULT_RETENTION_MAX_AGE_DAYS);

    setRetentionMaxAgeDays(14);
    expect(getRetentionMaxAgeDays()).toBe(14);

    setRetentionMaxAgeDays(3);
    expect(getRetentionMaxAgeDays()).toBe(3);

    // Resetting to null restores default
    setRetentionMaxAgeDays(null);
    expect(getRetentionMaxAgeDays()).toBe(DEFAULT_RETENTION_MAX_AGE_DAYS);

    // Rejects invalid values
    expect(() => setRetentionMaxAgeDays(0)).toThrow();
    expect(() => setRetentionMaxAgeDays(-5)).toThrow();
    expect(() => setRetentionMaxAgeDays(NaN)).toThrow();
  });

  test("respects EXOCORTEX_RETENTION_DAYS environment variable when configured retention is null", () => {
    process.env.EXOCORTEX_RETENTION_DAYS = "5";
    expect(getRetentionMaxAgeDays()).toBe(5);

    // Explicit setter overrides env var
    setRetentionMaxAgeDays(2);
    expect(getRetentionMaxAgeDays()).toBe(2);

    setRetentionMaxAgeDays(null);
    expect(getRetentionMaxAgeDays()).toBe(5);
  });

  test("calculates retention cutoff and expiration accurately", () => {
    const now = 1_700_000_000_000;
    setRetentionMaxAgeDays(7);
    const expectedCutoff = now - 7 * 24 * 60 * 60 * 1000;

    expect(getRetentionCutoff(now, 7)).toBe(expectedCutoff);
    expect(isTimestampExpired(expectedCutoff - 1, now, 7)).toBe(true);
    expect(isTimestampExpired(expectedCutoff + 1, now, 7)).toBe(false);
  });

  test("upsertPageText idempotently writes valid records", async () => {
    const now = Date.now();
    await upsertPageText({
      url: "https://example.com/test",
      title: "Test Page",
      textContent: "Sample content",
      parsedAt: now
    });

    const result = await db.page_text.where("url").equals("https://example.com/test").first();
    expect(result).toBeDefined();
    expect(result?.title).toBe("Test Page");
  });

  test("read-path enforcement: searchBrowserMemory excludes records outside retention window", async () => {
    setRetentionMaxAgeDays(7);
    const now = Date.now();

    // Directly insert two records into db (simulating historical data)
    await db.page_text.put({
      url: "https://example.com/old-doc",
      title: "Architecture Guide (Old)",
      textContent: "Deep memory architecture guide from 10 days ago",
      length: 50,
      parsedAt: now - 10 * 24 * 60 * 60 * 1000
    });

    await db.page_text.put({
      url: "https://example.com/new-doc",
      title: "Architecture Guide (New)",
      textContent: "Deep memory architecture guide from 2 days ago",
      length: 50,
      parsedAt: now - 2 * 24 * 60 * 60 * 1000
    });

    const results = await searchBrowserMemory("architecture", 10);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe("https://example.com/new-doc");
  });

  test("read-path enforcement: hybridVectorSearch respects dynamic retention cutoff", async () => {
    setRetentionMaxAgeDays(3); // 3-day retention
    const now = Date.now();

    const oldFrameId = await db.frames.add({
      url: "https://example.com/old-frame",
      title: "Old Frame",
      category: "Deep Work (Drafting/Coding)",
      dwellTime: 10,
      timestamp: now - 5 * 24 * 60 * 60 * 1000,
      synced: false
    });

    const newFrameId = await db.frames.add({
      url: "https://example.com/new-frame",
      title: "New Frame",
      category: "Deep Work (Drafting/Coding)",
      dwellTime: 10,
      timestamp: now - 1 * 24 * 60 * 60 * 1000,
      synced: false
    });

    const results = await hybridVectorSearch({
      queryText: "Frame",
      category: "Deep Work (Drafting/Coding)"
    });

    expect(results.length).toBe(1);
    expect(results[0].frameId).toBe(newFrameId);
  });

  test("pruneOldData purges all tables past the retention window", async () => {
    setRetentionMaxAgeDays(7);
    const now = Date.now();
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;
    const newTime = now - 1 * 24 * 60 * 60 * 1000;

    await db.page_text.bulkPut([
      { url: "https://a.com", title: "A", textContent: "A", length: 1, parsedAt: oldTime },
      { url: "https://b.com", title: "B", textContent: "B", length: 1, parsedAt: newTime }
    ]);

    await db.sessions.bulkPut([
      { sessionId: "s1", startTime: oldTime, endTime: oldTime + 1000, url: "https://a.com", title: "A", activeDuration: 1 },
      { sessionId: "s2", startTime: newTime, endTime: newTime + 1000, url: "https://b.com", title: "B", activeDuration: 1 }
    ]);

    await db.dwell_blocks.bulkPut([
      { url: "https://a.com", title: "A", timestamp: oldTime, dwellTime: 10 },
      { url: "https://b.com", title: "B", timestamp: newTime, dwellTime: 10 }
    ]);

    await db.telemetry.bulkPut([
      { sessionId: "s1", timestamp: oldTime, activeTabSwitches: 1, idleTimeTotal: 0, deepWorkDuration: 0, distractionDwellTime: 0, fatigueIndex: 10, currentLoadScore: 0.1 },
      { sessionId: "s2", timestamp: newTime, activeTabSwitches: 1, idleTimeTotal: 0, deepWorkDuration: 0, distractionDwellTime: 0, fatigueIndex: 10, currentLoadScore: 0.1 }
    ]);

    const stats = await pruneOldData();
    expect(stats.pageTextDeleted).toBe(1);
    expect(stats.sessionsDeleted).toBe(1);
    expect(stats.dwellBlocksDeleted).toBe(1);
    expect(stats.telemetryDeleted).toBe(1);

    expect(await db.page_text.count()).toBe(1);
    expect(await db.sessions.count()).toBe(1);
    expect(await db.dwell_blocks.count()).toBe(1);
    expect(await db.telemetry.count()).toBe(1);
  });
});
