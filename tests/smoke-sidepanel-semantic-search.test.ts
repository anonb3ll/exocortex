import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { Browser } from "puppeteer";
import path from "path";
import fs from "fs";
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from "./fixtures/browser-launch";
import { BROWSER_SETUP_HOOK_TIMEOUT_MS, BROWSER_SETUP_TIMEOUT_MS, waitForCondition } from "./fixtures/wait-for";

describe("Side Panel Semantic Search Smoke Test", () => {
  let browser: Browser;
  let extensionId = "";
  const extPath = path.resolve(import.meta.dir, "../dist");
  const screenshotsDir = path.resolve(import.meta.dir, "../dist/screenshots");

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!fs.existsSync(extPath)) {
      throw new Error(`Extension path does not exist: ${extPath}. Please run 'bun run build' first.`);
    }

    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    browser = await puppeteer.launch({
      ...extensionLaunchOptions(extPath)
    });

    const backgroundTarget = await waitForCondition(
      () => browser.targets().find((t) => t.type() === "service_worker"),
      { timeoutMs: BROWSER_SETUP_TIMEOUT_MS, description: "extension service worker target" }
    );

    const workerUrl = backgroundTarget.url();
    extensionId = workerUrl.split("/")[2];
  }, BROWSER_SETUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)(
    "performs vector search and privacy shield in side panel",
    async () => {
      const page = await browser.newPage();
      page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
      page.on("pageerror", (err) => console.log("PAGE ERROR:", err));
      await page.setViewport({ width: 420, height: 800 });

      // 1. Open sidepanel
      const sidepanelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`;
      await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => Boolean((window as unknown as { __exocortex_db: any }).__exocortex_db));

      // 2. Seed Dexie via page.evaluate
      await page.evaluate(async () => {
        const db = (window as unknown as { __exocortex_db: any }).__exocortex_db;
        await db.frames.clear();
        await db.embeddings.clear();

        const paraphraseId = await db.frames.add({
          url: "https://example.test/dog",
          title: "Caring for your dog",
          summary: "Grooming and feeding a puppy",
          domain: "example.test",
          category: "Research",
          dwellTime: 30,
          timestamp: Date.now(),
          synced: false
        });

        const unrelatedId = await db.frames.add({
          url: "https://example.test/tax",
          title: "Quarterly tax filing deadlines",
          summary: "Corporate tax guidelines",
          domain: "example.test",
          category: "Finance",
          dwellTime: 30,
          timestamp: Date.now(),
          synced: false
        });

        const fixedV = new Float32Array(384);
        fixedV[0] = 1;
        fixedV[1] = 0.5;

        const orthogonalV = new Float32Array(384);
        orthogonalV[300] = 1;

        await db.embeddings.put({
          frameId: paraphraseId,
          vector: fixedV,
          dimension: 384,
          createdAt: Date.now(),
          source: "model"
        });

        await db.embeddings.put({
          frameId: unrelatedId,
          vector: orthogonalV,
          dimension: 384,
          createdAt: Date.now(),
          source: "model"
        });
      });

      // 3. Stub the embedder reply deterministically
      await page.evaluate(() => {
        const fixed = new Float32Array(384);
        fixed[0] = 1;
        fixed[1] = 0.5;
        const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg: any, cb: any) => {
          if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
            cb({ status: "success", vector: Array.from(fixed), source: "model" });
            return;
          }
          orig(msg, cb);
        };
      });

      // 4. Type canine companion into #search-input; wait for semantic render
      await page.type("#search-input", "canine companion");
      await page.waitForFunction(
        () => {
          const el = document.getElementById("timeline");
          return el && el.innerHTML.includes("vector · cos");
        },
        { timeout: 10_000 }
      );
      const timelineHtml = await page.$eval("#timeline", (el) => el.innerHTML);
      expect(timelineHtml).toContain("vector · cos");
      expect(timelineHtml).toContain("Caring for your dog");
      await page.screenshot({ path: path.join(screenshotsDir, "semantic-vector-hit.png") });

      // 5. Clear the input; type chase.com; wait for privacy shield
      await page.evaluate(() => {
        const input = document.getElementById("search-input") as HTMLInputElement;
        if (input) input.value = "";
      });
      await page.type("#search-input", "chase.com");
      await page.waitForFunction(
        () => {
          const el = document.getElementById("timeline");
          return el && el.innerHTML.includes("Fail-Closed Privacy Shield");
        },
        { timeout: 10_000 }
      );
      const blockedTimelineHtml = await page.$eval("#timeline", (el) => el.innerHTML);
      expect(blockedTimelineHtml).toContain("Fail-Closed Privacy Shield");
      expect(blockedTimelineHtml).not.toContain("https://");
      await page.screenshot({ path: path.join(screenshotsDir, "semantic-privacy-blocked.png") });

      await page.close();
    },
    60_000
  );
});
