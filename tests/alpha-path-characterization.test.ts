/**
 * Task #297: Exocortex Alpha Path Practical Limits Characterization Suite
 *
 * Benchmark & Practical Limits Coverage:
 * 1. Capture latency under high mock page volume (p50, p95, p99, throughput).
 * 2. Dexie storage growth curve over simulated daily ingest (14-day simulation, LRU pruning plateau).
 * 3. Memory allocation ceiling & behavior when limit is hit (5MB truncation, concurrent loads, fail-closed privacy).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db, upsertPageText, pruneOldData, truncateText } from "../src/lib/db";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";
import { searchBrowserMemory } from "../src/lib/browser-memory-search";
import { isUrlBlocked, sanitizeUrl } from "../src/content/privacy";

async function clearAllTables() {
  await Promise.all([
    db.sessions.clear(),
    db.dwell_blocks.clear(),
    db.page_text.clear(),
    db.cognitive_frames.clear(),
    db.cognitive_checkpoints.clear(),
    db.working_memory_stack.clear(),
    db.semantic_vault.clear(),
    db.frames.clear(),
    db.embeddings.clear(),
    db.anchors.clear(),
    db.telemetry.clear(),
    db.frame_visuals.clear(),
  ]);
}

describe("Alpha Path Practical Limits Characterization", () => {
  beforeEach(async () => {
    await clearAllTables();
  });

  afterEach(async () => {
    await clearAllTables();
  });

  describe("1. Capture Latency Under High Mock Page Volume", () => {
    test("characterizes ingestion throughput & latency percentiles for 100 pages", async () => {
      const pageCount = 100;
      const latencies: number[] = [];
      const startTime = performance.now();

      for (let i = 0; i < pageCount; i++) {
        const pageStart = performance.now();
        const url = `https://example.com/research/topic-${i}`;
        const title = `Research Topic ${i}: Deep Dive into Cognitive Architecture`;
        const textContent = `This is full text content for mock page ${i}. `.repeat(50);
        const excerpt = `Excerpt for page ${i} discussing cognitive anchors.`;

        await upsertPageText({
          url,
          title,
          textContent,
          excerpt,
          parsedAt: Date.now() - i * 60000,
        });

        const frame = createCognitiveFrame({
          sessionId: `session_${i}`,
          url,
          pageTitle: title,
          activeDwellSeconds: 30,
          cleanTextExcerpt: excerpt,
        });
        await db.cognitive_frames.put(frame);

        const pageEnd = performance.now();
        latencies.push(pageEnd - pageStart);
      }

      const totalTime = performance.now() - startTime;
      latencies.sort((a, b) => a - b);

      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const avg = totalTime / pageCount;
      const throughput = (pageCount / (totalTime / 1000)).toFixed(1);

      console.log(`[Latency 100 pages] Total: ${totalTime.toFixed(1)}ms, Avg: ${avg.toFixed(2)}ms, p50: ${p50.toFixed(2)}ms, p95: ${p95.toFixed(2)}ms, p99: ${p99.toFixed(2)}ms, Throughput: ${throughput} pages/sec`);

      expect(await db.page_text.count()).toBe(pageCount);
      expect(await db.cognitive_frames.count()).toBe(pageCount);
      expect(avg).toBeLessThan(20); // Average latency per page under 20ms
      expect(totalTime).toBeLessThan(2000); // 100 pages under 2 sec
    });

    test("characterizes ingestion throughput for 500 pages", async () => {
      const pageCount = 500;
      const startTime = performance.now();

      const batchPromises = Array.from({ length: pageCount }, async (_, i) => {
        const url = `https://benchmark.org/docs/page-${i}`;
        const title = `Benchmark Page ${i}`;
        const textContent = `Benchmark document text payload for item ${i}. `.repeat(20);

        await upsertPageText({
          url,
          title,
          textContent,
          parsedAt: Date.now() - i * 10000,
        });
      });

      await Promise.all(batchPromises);
      const totalTime = performance.now() - startTime;
      const throughput = (pageCount / (totalTime / 1000)).toFixed(1);

      console.log(`[Latency 500 pages concurrent batch] Total: ${totalTime.toFixed(1)}ms, Throughput: ${throughput} pages/sec`);

      expect(await db.page_text.count()).toBe(pageCount);
      expect(totalTime).toBeLessThan(5000); // 500 pages under 5 sec
    });

    test("characterizes search recall latency across 1,000 indexed pages", async () => {
      const pageCount = 1000;
      // Seed 1,000 pages, with 5 target pages containing needle phrase
      for (let i = 0; i < pageCount; i++) {
        const isTarget = i % 200 === 42;
        const textContent = isTarget
          ? `Special content with target keyword neuroergonomic focus anchor in record ${i}.`
          : `Generic background page text content for record ${i} with random filler words.`;

        await upsertPageText({
          url: `https://knowledge.org/item-${i}`,
          title: isTarget ? `Target Page ${i} Neuroergonomics` : `Generic Page ${i}`,
          textContent,
          excerpt: isTarget ? "Neuroergonomic focus anchor excerpt" : "Generic excerpt",
          parsedAt: Date.now() - i * 60000,
        });
      }

      expect(await db.page_text.count()).toBe(1000);

      // Measure search query latency
      const searchStart = performance.now();
      const results = await searchBrowserMemory("neuroergonomic focus", 10);
      const searchTime = performance.now() - searchStart;

      console.log(`[Search 1,000 pages] Query Latency: ${searchTime.toFixed(2)}ms, Returned: ${results.length} matches`);

      expect(results.length).toBe(5);
      expect(results[0].title).toContain("Target Page");
      expect(searchTime).toBeLessThan(100); // Search over 1,000 pages under 100ms
    });
  });

  describe("2. Dexie Storage Growth Curve Over Simulated Daily Ingest", () => {
    test("simulates 14-day ingest and verifies LRU pruning plateau", async () => {
      const days = 14;
      const pagesPerDay = 100;
      const msPerDay = 24 * 60 * 60 * 1000;
      const now = Date.now();

      const dailyCounts: { day: number; pageText: number; frames: number; totalRecords: number }[] = [];

      for (let day = 1; day <= days; day++) {
        const dayTimestamp = now - (days - day) * msPerDay;

        // Ingest daily pages
        for (let p = 0; p < pagesPerDay; p++) {
          const pageIndex = (day - 1) * pagesPerDay + p;
          const url = `https://daily-browse.com/day-${day}/page-${p}`;
          const title = `Day ${day} Page ${p}`;
          const textContent = `Simulated daily browsing content for day ${day} page ${p}. `.repeat(15);
          const excerpt = `Day ${day} excerpt ${p}`;

          await upsertPageText({
            url,
            title,
            textContent,
            excerpt,
            parsedAt: dayTimestamp + p * 1000,
          });

          await db.dwell_blocks.add({
            sessionId: `session_day_${day}`,
            url,
            title,
            timestamp: dayTimestamp + p * 1000,
            dwellTime: 10000,
          });

          const frame = createCognitiveFrame({
            sessionId: `session_day_${day}`,
            url,
            pageTitle: title,
            activeDwellSeconds: 10,
            cleanTextExcerpt: excerpt,
          });
          frame.timestampUtc = dayTimestamp + p * 1000;
          await db.cognitive_frames.put(frame);

          const frameId = await db.frames.add({
            url,
            title,
            domain: "daily-browse.com",
            category: frame.userState.intentCategory,
            dwellTime: 10,
            timestamp: dayTimestamp + p * 1000,
            synced: false,
          });

          await db.embeddings.put({
            frameId,
            vector: new Float32Array(384).fill(0.05),
            dimension: 384,
            createdAt: dayTimestamp + p * 1000,
            source: "model",
          });
        }

        // Run daily LRU prune (retain max 7 days)
        await pruneOldData(7, dayTimestamp - 7 * msPerDay);

        const pageTextCount = await db.page_text.count();
        const cognitiveFramesCount = await db.cognitive_frames.count();
        const dwellCount = await db.dwell_blocks.count();
        const framesCount = await db.frames.count();
        const embeddingsCount = await db.embeddings.count();

        const totalRecords = pageTextCount + cognitiveFramesCount + dwellCount + framesCount + embeddingsCount;
        dailyCounts.push({ day, pageText: pageTextCount, frames: framesCount, totalRecords });
      }

      console.log("[Storage Growth Curve 14 Days]:");
      dailyCounts.forEach((c) => {
        console.log(`  Day ${c.day.toString().padStart(2, " ")}: PageText=${c.pageText}, Frames=${c.frames}, TotalRecords=${c.totalRecords}`);
      });

      // Verification of growth curve and LRU plateau:
      // Days 1-7: linear growth (each day adds ~100 records per table)
      expect(dailyCounts[6].pageText).toBe(700); // Day 7 unpruned: 700 pages
      
      // Days 8-14: LRU pruning keeps steady state around ~7-8 days of records
      expect(dailyCounts[13].pageText).toBeLessThanOrEqual(800); // Day 14 plateaued at ~7-8 days
      expect(dailyCounts[13].pageText).toBeGreaterThanOrEqual(700);
      expect(dailyCounts[13].frames).toBeLessThanOrEqual(800);
      // 60s, not 15s. This test performs ~7,000 Dexie writes (14 days x 100 pages x
      // 5 tables), and its assertions are about the shape of the LRU plateau, not
      // about speed — the per-op latency budgets live in their own tests above. At
      // 15s it was marginal rather than wrong: green on an idle machine, ~16.7s on a
      // loaded one, where bun aborted it mid-loop and the file's own afterEach then
      // cleared the tables underneath the still-running body — which is why the
      // failure reported "Day 14: PageText=0" and took unrelated test files down
      // with it. Same fixed-budget fragility as the B-layer sleeps this PR replaced.
    }, 60_000);
  });

  describe("3. Memory Allocation Ceiling & Fail-Closed Behavior", () => {
    test("enforces strict 50KB text truncation ceiling on huge 5MB text payloads", async () => {
      const hugeText = "A".repeat(5 * 1024 * 1024); // 5 MB payload
      const hugeExcerpt = "E".repeat(100 * 1024); // 100 KB excerpt

      const truncated = truncateText(hugeText);
      expect(truncated.length).toBe(50 * 1024); // 50 KB strict cap

      await upsertPageText({
        url: "https://huge-document.com/article",
        title: "Huge 5MB Article Test",
        textContent: hugeText,
        excerpt: hugeExcerpt,
        parsedAt: Date.now(),
      });

      const stored = await db.page_text.where("url").equals("https://huge-document.com/article").first();
      expect(stored).toBeDefined();
      expect(stored!.textContent.length).toBe(50 * 1024);
      expect(stored!.length).toBe(50 * 1024);
      expect(stored!.excerpt.length).toBe(1024); // Excerpt capped at 1024 chars
    });

    test("handles heavy concurrent load with max text payloads gracefully", async () => {
      const batchSize = 50;
      const maxTextPayload = "X".repeat(50 * 1024); // 50 KB text per page = 2.5 MB batch text payload

      const startTime = performance.now();
      const promises = Array.from({ length: batchSize }, (_, i) => {
        return upsertPageText({
          url: `https://heavy-load.com/page-${i}`,
          title: `Heavy Load Page ${i}`,
          textContent: maxTextPayload,
          excerpt: `Excerpt ${i}`,
          parsedAt: Date.now() - i * 1000,
        });
      });

      await expect(Promise.all(promises)).resolves.toBeDefined();
      const elapsed = performance.now() - startTime;

      console.log(`[Memory Ceiling 50 Concurrent Max-Payload Pages] Elapsed: ${elapsed.toFixed(1)}ms`);
      expect(await db.page_text.count()).toBe(batchSize);
    });

    test("fails closed on sensitive banking and credential URLs under high load", async () => {
      const sensitiveUrls = [
        "https://www.chase.com/myaccount/bank",
        "https://wellsfargo.com/login",
        "https://bankofamerica.com/auth",
        "https://paypal.com/checkout?token=secret123",
        "https://1password.com/vault",
        "chrome://settings",
        "file:///etc/passwd",
        "https://login.example.com/oauth",
      ];

      for (const rawUrl of sensitiveUrls) {
        expect(isUrlBlocked(rawUrl)).toBe(true);
      }

      // Verify sanitizeUrl strips sensitive query params and credentials
      const sanitizedAuth = sanitizeUrl("https://user:pass@example.com/docs?access_token=xyz&api_key=123&topic=exocortex");
      expect(sanitizedAuth).not.toContain("user:pass");
      expect(sanitizedAuth).not.toContain("access_token");
      expect(sanitizedAuth).not.toContain("api_key");
      expect(sanitizedAuth).toContain("topic=exocortex");
    });
  });
});
