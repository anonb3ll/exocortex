/**
 * The user-facing retention setting: 7, 30, 90 or 365 days, stored in
 * chrome.storage.local and loaded into the retention policy before any prune.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  db,
  DEFAULT_RETENTION_MAX_AGE_DAYS,
  getRetentionMaxAgeDays,
  pruneOldData,
  setRetentionMaxAgeDays
} from "../src/lib/db";
import { hybridVectorSearch } from "../src/lib/models/vector-search";
import {
  applyRetentionDays,
  loadRetentionSetting,
  normalizeRetentionDays,
  RETENTION_CHOICES_DAYS,
  RETENTION_STORAGE_KEY
} from "../src/lib/retention-setting";

const DAY_MS = 24 * 60 * 60 * 1000;

function storageWith(values: Record<string, unknown>) {
  return { get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...values }) };
}

describe("retention setting", () => {
  const originalEnv = process.env.EXOCORTEX_RETENTION_DAYS;

  beforeEach(async () => {
    delete process.env.EXOCORTEX_RETENTION_DAYS;
    setRetentionMaxAgeDays(null);
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    setRetentionMaxAgeDays(null);
    if (originalEnv === undefined) delete process.env.EXOCORTEX_RETENTION_DAYS;
    else process.env.EXOCORTEX_RETENTION_DAYS = originalEnv;
  });

  test("offers 7, 30, 90 and 365 days, and the default is still 7", () => {
    expect([...RETENTION_CHOICES_DAYS]).toEqual([7, 30, 90, 365]);
    expect(DEFAULT_RETENTION_MAX_AGE_DAYS).toBe(7);
    expect(normalizeRetentionDays(undefined)).toBe(7);
  });

  test("only the offered windows are accepted; anything else is the default", () => {
    for (const choice of RETENTION_CHOICES_DAYS) {
      expect(normalizeRetentionDays(choice)).toBe(choice);
      // A <select> hands back strings.
      expect(normalizeRetentionDays(String(choice))).toBe(choice);
    }
    for (const bad of [0, -1, 8, 3650, Number.POSITIVE_INFINITY, Number.NaN, "", "forever", null, {}, [30], true]) {
      expect(normalizeRetentionDays(bad)).toBe(7);
    }
  });

  test("with nothing stored the window is 7 days", async () => {
    const result = await loadRetentionSetting(storageWith({}));
    expect(result).toEqual({ days: 7, loaded: true });
    expect(getRetentionMaxAgeDays()).toBe(7);
  });

  test("a stored choice becomes the policy for this context", async () => {
    const result = await loadRetentionSetting(storageWith({ [RETENTION_STORAGE_KEY]: 90 }));
    expect(result).toEqual({ days: 90, loaded: true });
    expect(getRetentionMaxAgeDays()).toBe(90);
  });

  test("a storage failure reports loaded: false and leaves the policy alone", async () => {
    setRetentionMaxAgeDays(365);
    const result = await loadRetentionSetting({
      get: async () => {
        throw new Error("storage unavailable");
      }
    });
    // The caller must not prune on this: the 7-day default would delete a
    // year-long history because of one failed read.
    expect(result.loaded).toBe(false);
    expect(getRetentionMaxAgeDays()).toBe(365);
  });

  test("a longer window keeps, and makes searchable, what 7 days would have deleted", async () => {
    const now = Date.now();
    const id = await db.frames.add({
      url: "https://example.com/month-old",
      title: "Month old tutorial",
      timestamp: now - 30 * DAY_MS + 60_000,
      dwellTime: 30
    });

    // Default window: hidden from search, and prune would delete it.
    expect(await hybridVectorSearch({ queryText: "tutorial" })).toEqual([]);

    applyRetentionDays(90);
    const found = await hybridVectorSearch({ queryText: "tutorial" });
    expect(found.map((r) => r.frameId)).toEqual([id]);

    expect((await pruneOldData()).framesDeleted).toBe(0);
    expect(await db.frames.count()).toBe(1);
  });

  test("shortening the window prunes immediately", async () => {
    const now = Date.now();
    applyRetentionDays(365);
    await db.frames.bulkAdd([
      { url: "https://example.com/200d", title: "200 days", timestamp: now - 200 * DAY_MS, dwellTime: 10 },
      { url: "https://example.com/20d", title: "20 days", timestamp: now - 20 * DAY_MS, dwellTime: 10 },
      { url: "https://example.com/2d", title: "2 days", timestamp: now - 2 * DAY_MS, dwellTime: 10 }
    ]);
    await db.dwell_blocks.bulkAdd([
      { url: "https://example.com/200d", title: "200 days", timestamp: now - 200 * DAY_MS, dwellTime: 10_000 },
      { url: "https://example.com/2d", title: "2 days", timestamp: now - 2 * DAY_MS, dwellTime: 10_000 }
    ]);
    expect((await pruneOldData()).framesDeleted).toBe(0);

    // What the service worker does when the setting changes: apply, then prune.
    applyRetentionDays(30);
    const result = await pruneOldData();
    expect(result.framesDeleted).toBe(1);
    expect(result.dwellBlocksDeleted).toBe(1);

    applyRetentionDays(7);
    expect((await pruneOldData()).framesDeleted).toBe(1);
    expect((await db.frames.toArray()).map((f) => f.title)).toEqual(["2 days"]);
  });
});
