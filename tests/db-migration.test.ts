/**
 * Layer 3: the Dexie upgrade path.
 *
 * Every already-installed extension carries a v1-v5 IndexedDB on disk. PR #8
 * collapsed versions 1-5 into a single `version(6).stores({...})` declaration
 * to stop Dexie replaying five upgrades during service-worker init — which
 * means there is no explicit upgrade() callback left to inspect, and the only
 * thing standing between an existing user and a wiped or unopenable vault is
 * Dexie's own schema diff against a database it did not create.
 *
 * Nothing tested that. These open a genuinely v5-shaped database, close it,
 * then open the shipped schema on top and assert the data is still there —
 * the outcome, not the mechanism. A test that only asserted "open() did not
 * throw" would pass against a migration that silently dropped every row.
 */

import { afterEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";

// The v5 schema exactly as it shipped before the PR #8 consolidation: the
// Phase 3.1/3.2 tables minus frame_visuals, which v6 introduces. Declared here
// rather than imported so that editing src/lib/db.ts cannot silently redefine
// what "the old database" means — the fixture is the historical record.
const V5_STORES = {
  sessions: "++id, sessionId, startTime, endTime, url, [url+startTime]",
  dwell_blocks: "++id, sessionId, url, timestamp",
  page_text: "++id, &url, parsedAt",
  cognitive_frames:
    "&frameId, timestampUtc, sessionId, [userState.intentCategory], [userState.primaryFocusEntity]",
  cognitive_checkpoints: "&checkpointId, timestampUtc, sessionId, primaryFocusEntity",
  working_memory_stack: "&stackId, activeGoal, lastUpdatedUtc, status",
  semantic_vault: "&vaultId, timestampUtc, url, primaryFocusEntity",
  frames: "++id, url, title, domain, category, sourceType, dwellTime, timestamp, synced",
  embeddings: "++id, &frameId, createdAt",
  anchors: "++id, title, category, status, createdAt",
  telemetry: "++id, timestamp",
};

const V6_STORES = { ...V5_STORES, frame_visuals: "++id, &frameId" };

let open: Dexie[] = [];

function makeDb(name: string, version: number, stores: Record<string, string>): Dexie {
  const db = new Dexie(name);
  db.version(version).stores(stores);
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open) db.close();
  open = [];
});

/** Populate a v5-shaped database with recognisable rows, then close it. */
async function seedV5Database(name: string) {
  const v5 = makeDb(name, 5, V5_STORES);
  await v5.open();
  await v5.table("frames").bulkAdd([
    { url: "https://example.com/a", title: "A", domain: "example.com", timestamp: 1 },
    { url: "https://example.com/b", title: "B", domain: "example.com", timestamp: 2 },
    { url: "https://example.com/c", title: "C", domain: "example.com", timestamp: 3 },
  ]);
  await v5.table("cognitive_frames").add({
    frameId: "frame-from-v5",
    timestampUtc: 1000,
    sessionId: "session-1",
  });
  await v5.table("embeddings").add({ frameId: 42, createdAt: 7 });
  v5.close();
}

describe("upgrading a pre-existing v5 database to the shipped schema", () => {
  test("keeps every row that was already there", async () => {
    const name = `ExocortexVault_survives_${Date.now()}`;
    await seedV5Database(name);

    const v6 = makeDb(name, 6, V6_STORES);
    await v6.open();

    // Row counts, not just "it opened": a migration that recreated the stores
    // empty would satisfy any weaker assertion.
    expect(await v6.table("frames").count()).toBe(3);
    expect(await v6.table("embeddings").count()).toBe(1);
    expect(await v6.table("cognitive_frames").count()).toBe(1);

    // And the contents, not just the arithmetic.
    const titles = (await v6.table("frames").toArray()).map((f) => f.title).sort();
    expect(titles).toEqual(["A", "B", "C"]);
    const carried = await v6.table("cognitive_frames").get("frame-from-v5");
    expect(carried?.sessionId).toBe("session-1");
  });

  test("creates the stores v6 adds", async () => {
    const name = `ExocortexVault_newstores_${Date.now()}`;
    await seedV5Database(name);

    const v6 = makeDb(name, 6, V6_STORES);
    await v6.open();

    expect(v6.tables.map((t) => t.name)).toContain("frame_visuals");
    // Usable, not merely declared — an added store that cannot take a write is
    // the same outage as a missing one.
    await v6.table("frame_visuals").add({ frameId: 1 });
    expect(await v6.table("frame_visuals").count()).toBe(1);
  });

  test("reports the upgraded version number", async () => {
    const name = `ExocortexVault_version_${Date.now()}`;
    await seedV5Database(name);

    const v6 = makeDb(name, 6, V6_STORES);
    await v6.open();

    // Dexie reports the IndexedDB version, which is its own version * 10.
    expect(v6.verno).toBe(6);
  });

  test("the shipped ExocortexDatabase opens on top of a v5 database", async () => {
    // Run in its own process. The check only means anything against the
    // singleton's real database name, and fake-indexeddb is global to a
    // process — so doing it in-band would leave a shared "ExocortexVault"
    // behind for other test files' beforeEach hooks to trip over. That is not
    // hypothetical: it is what turned this suite red in CI while passing
    // locally, because bun's file order differed.
    const proc = Bun.spawn(["bun", "run", "tests/fixtures/open-real-db-over-v5.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, `fixture failed: ${stderr}`).toBe(0);

    const result = JSON.parse(stdout.trim());
    expect(result.frames).toBe(3);
    expect(result.tables).toContain("frame_visuals");
    expect(result.verno).toBe(7);
  }, 30_000);

  test("v7 stamps provenance onto embeddings written before `source` existed", async () => {
    // EmbeddingRecord.source became required after these rows were written, so
    // every installed extension has embeddings with no provenance at all. An
    // undefined source must never be read as "model" — those rows are
    // disproportionately the empty and fallback vectors produced while
    // chrome.offscreen was undefined and the embedder never ran.
    //
    // Same subprocess as above: the upgrade only runs against the singleton's real
    // database name, and fake-indexeddb is process-global.
    const proc = Bun.spawn(["bun", "run", "tests/fixtures/open-real-db-over-v5.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, `fixture failed: ${stderr}`).toBe(0);

    const result = JSON.parse(stdout.trim());
    // Stamped, not dropped: the rows survive the upgrade and are merely labelled.
    expect(result.embeddingSources.length).toBe(2);
    expect(result.embeddingSources).toEqual(["fallback", "fallback"]);
    expect(result.embeddingSources).not.toContain(null);
    expect(result.embeddingSources).not.toContain("model");
  }, 30_000);
});
