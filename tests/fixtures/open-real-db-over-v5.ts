/**
 * Seeds a v5-shaped "ExocortexVault" and opens the real ExocortexDatabase on
 * top of it, printing the result as JSON.
 *
 * This runs as its own process on purpose. The check is only meaningful
 * against the singleton's real database *name*, and fake-indexeddb is global
 * to a process — so doing it in-band would leave a shared `ExocortexVault` in
 * a state other test files' `beforeEach` hooks trip over, which is exactly the
 * cross-file pollution that turned this suite red in CI while passing locally.
 * A subprocess cannot pollute anything.
 */

import "fake-indexeddb/auto";

// Dexie is imported dynamically, not statically: ESM hoists every static
// import, and Dexie captures `indexedDB` off the global at module evaluation.
// A static `import Dexie from "dexie"` therefore binds it before
// fake-indexeddb/auto has installed the polyfill, and open() dies with
// MissingAPIError. Under `bun test` the bunfig preload hides this; a fixture
// run with `bun run` gets no preload, so the order has to be explicit.
const { default: Dexie } = await import("dexie");

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

const old = new Dexie("ExocortexVault");
old.version(5).stores(V5_STORES);
await old.open();
await old.table("frames").bulkAdd([
  { url: "https://example.com/a", title: "A", domain: "example.com", timestamp: 1 },
  { url: "https://example.com/b", title: "B", domain: "example.com", timestamp: 2 },
  { url: "https://example.com/c", title: "C", domain: "example.com", timestamp: 3 },
]);
// Embeddings written before `source` existed — no provenance field at all. This is
// what every installed extension actually has on disk, and what the v7 upgrade has
// to stamp so it is never mistaken for a real model embedding.
await old.table("embeddings").bulkAdd([
  { frameId: 1, dimension: 384, createdAt: 1 },
  { frameId: 2, dimension: 384, createdAt: 2 },
]);
old.close();

// Imported only now: constructing the singleton first would create the
// database at v6 and there would be nothing to upgrade.
const { db } = await import("../../src/lib/db");
await db.open();

console.log(
  JSON.stringify({
    frames: await db.table("frames").count(),
    tables: db.tables.map((t) => t.name),
    verno: db.verno,
    embeddingSources: (await db.table("embeddings").toArray()).map((e) => e.source ?? null),
  }),
);
db.close();
