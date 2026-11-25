import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import fs from "fs";
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from "./fixtures/browser-launch";
import { BROWSER_SETUP_HOOK_TIMEOUT_MS, BROWSER_SETUP_TIMEOUT_MS, waitForCondition } from "./fixtures/wait-for";

describe("B7: Side Panel Mobile Slice Human-Facing Projection (Task #462)", () => {
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

    // Poll to the full BROWSER_SETUP_TIMEOUT_MS budget, not a shorter inline
    // deadline. A hardcoded 15s deadline here (the pattern the rest of the B*
    // layer moved off of — see the docstring in fixtures/wait-for.ts) races
    // against Chrome cold start on a loaded machine: any host slow or busy
    // enough (e.g. concurrent agents also launching browsers) surfaced a spurious
    // "service worker target not found" even though the extension loads fine given
    // the time already budgeted. waitForCondition is the shared fix for exactly
    // this race; use it instead of reinventing the inline poll. The hook itself
    // is given BROWSER_SETUP_HOOK_TIMEOUT_MS (the poll budget plus margin for
    // puppeteer.launch()) so Bun doesn't abort the hook before this poll's own
    // deadline can produce its descriptive timeout error.
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
    "renders live focus glance, recall states, and preserves privacy fail-closed",
    async () => {
      const page = await browser.newPage();
      page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
      page.on("pageerror", (err) => console.log("PAGE ERROR:", err));
      await page.setViewport({ width: 420, height: 800 });

      // 1. Open sidepanel
      const sidepanelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`;
      await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => Boolean((window as unknown as { __exocortex_db: any }).__exocortex_db));

      // 2. Seed Dexie with a LIVE cognitive frame and page text
      const now = Date.now();
      await page.evaluate(async (currentTime) => {
        const db = (window as unknown as { __exocortex_db: any }).__exocortex_db;
        await db.cognitive_frames.clear();
        await db.page_text.clear();

        await db.cognitive_frames.add({
          frameId: "frame-live-1",
          sessionId: "session-1",
          timestampUtc: currentTime,
          provenance: {
            url: "https://github.com/exocortex/repo",
            pageTitle: "Exocortex Architecture & Design",
            domain: "github.com",
            tabId: 1
          },
          userState: {
            primaryFocusEntity: "Investigating Mobile Slice Integration",
            workingStateSummary: "Wiring mobile-slice projection to side panel at https://github.com/exocortex/repo",
            intentCategory: "Deep Work (Coding)",
            cognitiveLoadScore: 0.5,
            cognitiveLoadLevel: "Medium",
            fatigueIndex: 12,
            contextSwitchCost: 0
          }
        });

        await db.page_text.add({
          id: 101,
          url: "https://docs.exocortex.dev/mobile-slice",
          title: "Mobile Thin Slice Spec and Projection API",
          textContent: "Comprehensive reference on mobile recall and focus glance projections.",
          excerpt: "Mobile slice reference available at https://docs.exocortex.dev/mobile-slice for companion clients.",
          parsedAt: currentTime
        });
      }, now);

      // Reload sidepanel to load seeded data
      await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => Boolean((window as unknown as { __exocortex_db: any }).__exocortex_db));
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-focus-entity", (el) => el.textContent?.trim())) ===
          "Investigating Mobile Slice Integration",
        { description: "live mobile focus projection" }
      );

      // Assert Live + Healthy State
      const freshnessText = await page.$eval("#mobile-freshness-badge", (el) => el.textContent?.trim());
      const healthText = await page.$eval("#mobile-health-badge", (el) => el.textContent?.trim());
      const focusEntityText = await page.$eval("#mobile-focus-entity", (el) => el.textContent?.trim());
      const stateDigestText = await page.$eval("#mobile-state-digest", (el) => el.textContent?.trim());
      const taskRefHidden = await page.$eval("#mobile-task-ref", (el) => (el as HTMLElement).hidden);

      expect(freshnessText).toBe("LIVE");
      expect(healthText).toBe("HEALTHY");
      expect(focusEntityText).toBe("Investigating Mobile Slice Integration");
      expect(stateDigestText).toBe("Wiring mobile-slice projection to side panel at [redacted-link]");
      // No real task association exists for this seeded fixture, so the task-ref
      // chip must stay hidden rather than showing a hardcoded placeholder task.
      expect(taskRefHidden).toBe(true);

      // Capture screenshot of Live State
      await page.screenshot({ path: path.join(screenshotsDir, "state-live-healthy.png") });

      // 3. Test Mobile Recall State 1: 'ok' with query
      await page.type("#search-input", "mobile");
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-recall-list", (el) => el.innerHTML)).includes("mem_101"),
        { description: "mobile recall results" }
      );

      const recallStatus = await page.$eval("#mobile-recall-status", (el) => el.textContent?.trim());
      const recallListHtml = await page.$eval("#mobile-recall-list", (el) => el.innerHTML);

      expect(recallStatus).toContain("match");
      expect(recallListHtml).toContain("mem_101");
      expect(recallListHtml).toContain("Mobile Thin Slice Spec and Projection API");
      expect(recallListHtml).toContain("[redacted-link]");
      // Strict privacy assertion: NO raw URL in rendered DOM
      expect(recallListHtml).not.toContain("https://docs.exocortex.dev");
      expect(recallListHtml).not.toContain("http://");

      await page.screenshot({ path: path.join(screenshotsDir, "recall-ok.png") });

      // 4. Test Mobile Recall State 2: 'empty'
      await page.evaluate(() => {
        const input = document.getElementById("search-input") as HTMLInputElement;
        if (input) input.value = "";
      });
      await page.type("#search-input", "nonexistentquery12345");
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-recall-list", (el) => el.innerHTML)).includes(
            'No results for query "nonexistentquery12345"'
          ),
        { description: "empty mobile recall state" }
      );

      const emptyRecallList = await page.$eval("#mobile-recall-list", (el) => el.innerHTML);
      expect(emptyRecallList).toContain("empty-state");
      expect(emptyRecallList).toContain("No results for query \"nonexistentquery12345\"");

      await page.screenshot({ path: path.join(screenshotsDir, "recall-empty.png") });

      // 5. Test Mobile Recall State 3: 'privacy_blocked' (Fail-Closed)
      await page.evaluate(() => {
        const input = document.getElementById("search-input") as HTMLInputElement;
        if (input) input.value = "";
      });
      await page.type("#search-input", "chase.com");
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-recall-list", (el) => el.innerHTML)).includes(
            "privacy-blocked-state"
          ),
        { description: "privacy-blocked mobile recall state" }
      );

      const blockedRecallList = await page.$eval("#mobile-recall-list", (el) => el.innerHTML);
      expect(blockedRecallList).toContain("privacy-blocked-state");
      expect(blockedRecallList).toContain("Fail-Closed Privacy Shield");
      expect(blockedRecallList).toContain("Search query matches privacy blocklist");
      expect(blockedRecallList).not.toContain("https://");

      await page.screenshot({ path: path.join(screenshotsDir, "recall-privacy-blocked.png") });

      // 6. Test Stale + Degraded State
      const fifteenMinsAgo = Date.now() - 15 * 60 * 1000;
      await page.evaluate(async (staleTime) => {
        const db = (window as unknown as { __exocortex_db: any }).__exocortex_db;
        await db.cognitive_frames.clear();
        await db.cognitive_frames.add({
          frameId: "frame-stale-1",
          sessionId: "session-1",
          timestampUtc: staleTime,
          provenance: {
            url: "https://github.com/exocortex/stale",
            pageTitle: "Past Work",
            domain: "github.com",
            tabId: 1
          },
          userState: {
            primaryFocusEntity: "Previous Task Investigation",
            workingStateSummary: "Previous session context summary",
            intentCategory: "Drafting",
            cognitiveLoadScore: 0.3,
            cognitiveLoadLevel: "Low",
            fatigueIndex: 5,
            contextSwitchCost: 0
          }
        });
      }, fifteenMinsAgo);

      await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => Boolean((window as unknown as { __exocortex_db: any }).__exocortex_db));
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-freshness-badge", (el) => el.textContent?.trim())) === "STALE",
        { description: "stale mobile projection" }
      );

      const staleFreshness = await page.$eval("#mobile-freshness-badge", (el) => el.textContent?.trim());
      const degradedHealth = await page.$eval("#mobile-health-badge", (el) => el.textContent?.trim());

      expect(staleFreshness).toBe("STALE");
      expect(degradedHealth).toBe("DEGRADED");

      await page.screenshot({ path: path.join(screenshotsDir, "state-stale-degraded.png") });

      // 7. Test Offline + Unavailable State
      await page.evaluate(async () => {
        const db = (window as unknown as { __exocortex_db: any }).__exocortex_db;
        await db.cognitive_frames.clear();
        await db.dwell_blocks.clear();
      });

      await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => Boolean((window as unknown as { __exocortex_db: any }).__exocortex_db));
      await waitForCondition(
        async () =>
          (await page.$eval("#mobile-freshness-badge", (el) => el.textContent?.trim())) === "OFFLINE",
        { description: "offline mobile projection" }
      );

      const offlineFreshness = await page.$eval("#mobile-freshness-badge", (el) => el.textContent?.trim());
      const unavailableHealth = await page.$eval("#mobile-health-badge", (el) => el.textContent?.trim());
      const emptyFocusEntity = await page.$eval("#mobile-focus-entity", (el) => el.textContent?.trim());

      expect(offlineFreshness).toBe("OFFLINE");
      expect(unavailableHealth).toBe("UNAVAILABLE");
      expect(emptyFocusEntity).toBe("No active focus");

      await page.screenshot({ path: path.join(screenshotsDir, "state-offline-unavailable.png") });

      await page.close();
    },
    60_000
  );
});
