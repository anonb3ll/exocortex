import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import puppeteer, { Browser, Page } from 'puppeteer';
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions, seedCaptureConsent } from './fixtures/browser-launch';
import { BROWSER_SETUP_TIMEOUT_MS, CAPTURE_TIMEOUT_MS, waitForCondition } from './fixtures/wait-for';
import path from 'path';
import fs from 'fs';
import { serve } from 'bun';

describe('B2: Exocortex Capture to MCP Recall Loop', () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof serve>;
  const extPath = path.resolve(import.meta.dir, '../dist');
  let testUrl = '';

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!fs.existsSync(extPath)) {
      throw new Error(`Extension path does not exist: ${extPath}`);
    }

    // Start a local server to serve the synthetic page
    server = serve({
      port: 0, // random port
      fetch(req) {
        return new Response(`
          <!DOCTYPE html>
          <html>
            <head><title>Exocortex Alpha Architecture and Cognitive Anchors</title></head>
            <body>
              <article>
                <h1>Welcome to Project Exocortex</h1>
                <p>This is a test page containing the special phrase: neuroergonomic focus for the smoke test.</p>
              </article>
            </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    });

    testUrl = `http://localhost:${server.port}/test`;

    browser = await puppeteer.launch({
      ...extensionLaunchOptions(extPath),
    });
    // bun's default hook timeout is 5s, and a cold Chrome launch with an unpacked
    // extension does not fit in it. This file passed only when an earlier test file
    // had already warmed Chrome — run it in isolation and the hook timed out before
    // a single assertion ran. The live-* tests already set 60s/90s here.
  }, BROWSER_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) server.stop();
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)('captures allowed page after dwell and retrieves via DB search path', async () => {
    // 1. Open the synthetic page
    page = await browser.newPage();
    // Start the extension worker before navigation so Chrome cannot race content
    // script injection against the first worker startup in a cold profile.
    const backgroundTarget = await waitForCondition(
      () => browser.targets().find(t => t.type() === 'service_worker'),
      { timeoutMs: CAPTURE_TIMEOUT_MS, description: 'the extension service worker to start' },
    );
    expect(backgroundTarget).toBeDefined();

    if (backgroundTarget) {
      const swSession = await backgroundTarget.createCDPSession();
      swSession.on('Runtime.consoleAPICalled', (e: any) => console.log('[SW Console]', ...e.args.map((a: any) => a.value)));
      swSession.on('Runtime.exceptionThrown', (e: any) => console.error('[SW Error]', e.exceptionDetails));
      await swSession.send('Runtime.enable');
    }

    // Capture is consent-gated (fail-closed); grant the opt-in before navigation.
    await seedCaptureConsent(browser);

    page.on('console', (msg) => console.log('[Page Console]', msg.text()));
    page.on('pageerror', (err) => console.error('[Page Error]', err));

    await page.goto(testUrl, { waitUntil: 'networkidle2' });
    // startDwellTimer() returns early unless document.visibilityState === "visible"
    // (src/content/tracker.ts:19). A tab that never reaches the foreground never
    // starts the dwell timer, so the capture this test waits for cannot happen.
    await page.bringToFront();
    await waitForCondition(
      () => page.evaluate(() => document.visibilityState === 'visible'),
      { timeoutMs: CAPTURE_TIMEOUT_MS, description: 'the test page to become visible' },
    );
    // Re-emit the same browser lifecycle signals the tracker listens for. This
    // makes the test deterministic when another browser test has just occupied
    // the foreground window during the shared Bun test process.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });

    console.log(`Visited ${testUrl}, polling for capture...`);

    let cachedWorkerSession: any = null;
    const readCaptures = async () => {
      const currentWorker = browser.targets().find((t) => t.type() === "service_worker");
      if (!currentWorker) {
        cachedWorkerSession = null;
        return [];
      }
      try {
        if (!cachedWorkerSession) {
          cachedWorkerSession = await currentWorker.createCDPSession();
        }
        const { result } = await cachedWorkerSession.send("Runtime.evaluate", {
          expression: `
            (async () => {
              const request = indexedDB.open("ExocortexVault");
              const db = await new Promise((resolve, reject) => {
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = () => reject(request.error);
              });

              const tx = db.transaction("page_text", "readonly");
              const store = tx.objectStore("page_text");
              const allTexts = await new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });

              const queryLower = "neuroergonomic focus".toLowerCase();
              const results = [];
              for (const pt of allTexts) {
                const titleMatch = pt.title.toLowerCase().includes(queryLower);
                const urlMatch = pt.url.toLowerCase().includes(queryLower);
                const excerptMatch = (pt.excerpt || "").toLowerCase().includes(queryLower);
                const textMatch = pt.textContent.toLowerCase().includes(queryLower);

                if (titleMatch || urlMatch || excerptMatch || textMatch) {
                  results.push({ url: pt.url, title: pt.title, excerpt: pt.excerpt || pt.textContent.substring(0, 150) });
                }
              }
              return results;
            })()
          `,
          awaitPromise: true,
          returnByValue: true
        });
        return result.value as Array<{ url: string; title: string; excerpt: string }>;
      } catch (error) {
        cachedWorkerSession = null;
        if (
          String(error).includes("TargetCloseError") ||
          String(error).includes("Session closed") ||
          String(error).includes("Connection closed") ||
          String(error).includes("ConnectionClosedError")
        ) {
          return [];
        }
        throw error;
      }
    };

    let searchResults;
    try {
      searchResults = await waitForCondition(
        async () => {
          const rows = await readCaptures();
          return rows && rows.length > 0 ? rows : null;
        },
        { timeoutMs: CAPTURE_TIMEOUT_MS, description: `a capture of ${testUrl} to reach page_text` }
      );
    } finally {
      if (cachedWorkerSession) {
        await cachedWorkerSession.detach().catch(() => undefined);
      }
    }
    console.log('Search results:', searchResults);

    expect(searchResults).toBeDefined();
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].url).toBe(testUrl);
    expect(searchResults[0].title).toBe('Exocortex Alpha Architecture and Cognitive Anchors');
  }, CAPTURE_TIMEOUT_MS + 15_000);
});
