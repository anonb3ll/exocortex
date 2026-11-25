import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import puppeteer, { Browser, Page } from 'puppeteer';
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions, seedCaptureConsent } from './fixtures/browser-launch';
import { BROWSER_SETUP_TIMEOUT_MS, CAPTURE_TIMEOUT_MS, waitForCondition } from './fixtures/wait-for';
import path from 'path';
import fs from 'fs';
import { serve } from 'bun';

describe('B3: Exocortex Privacy Guard Smoke Test', () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof serve>;
  const extPath = path.resolve(import.meta.dir, '../dist');
  let basePort = 0;

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!fs.existsSync(extPath)) {
      throw new Error(`Extension path does not exist: ${extPath}`);
    }

    server = serve({
      port: 0,
      fetch(req) {
        return new Response(`
          <!DOCTYPE html>
          <html>
            <head><title>Test Page</title></head>
            <body>
              <article>
                <h1>Some content here</h1>
                <input type="password" value="super_secret_password_123" />
                <input autocomplete="cc-number" value="4111222233334444" />
                <p>Safe text content.</p>
              </article>
            </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    });
    basePort = server.port;

    browser = await puppeteer.launch({
      ...extensionLaunchOptions(extPath),
    });
    // See smoke-capture-recall: bun's default 5s hook timeout does not cover a cold
    // Chrome launch with an unpacked extension.
    // Capture is consent-gated (fail-closed); grant the opt-in for these tests.
    await seedCaptureConsent(browser);
  }, BROWSER_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) server.stop();
  });

  const getDexieData = async () => {
    const targets = browser.targets();
    const bg = targets.find(t => t.type() === 'service_worker');
    if (!bg) return { blocks: [], texts: [] };
    try {
      const session = await bg.createCDPSession();
      try {
        const { result } = await session.send('Runtime.evaluate', {
          expression: `
            (async () => {
              const request = indexedDB.open("ExocortexVault");
              const db = await new Promise((resolve, reject) => {
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = () => reject(request.error);
              });
              const tx = db.transaction(["dwell_blocks", "page_text"], "readonly");
              const blocks = await new Promise(r => {
                const req = tx.objectStore("dwell_blocks").getAll();
                req.onsuccess = () => r(req.result);
              });
              const texts = await new Promise(r => {
                const req = tx.objectStore("page_text").getAll();
                req.onsuccess = () => r(req.result);
              });
              return { blocks, texts };
            })()
          `,
          awaitPromise: true,
          returnByValue: true
        });
        return result.value || { blocks: [], texts: [] };
      } finally {
        await session.detach().catch(() => undefined);
      }
    } catch (error) {
      if (
        String(error).includes('TargetCloseError') ||
        String(error).includes('Session closed') ||
        String(error).includes('Connection closed') ||
        String(error).includes('ConnectionClosedError')
      ) {
        return { blocks: [], texts: [] };
      }
      throw error;
    }
  };

  test.skipIf(!BROWSER_TESTS_ENABLED)('blocked domains are not captured (fail-closed)', async () => {
    const blockedPage = await browser.newPage();
    let controlPage: Page | null = null;
    try {
      const blockedUrl = `http://bank.test:${basePort}/`;
      await blockedPage.goto(blockedUrl, { waitUntil: 'networkidle2' });
      await blockedPage.bringToFront();

      await new Promise(r => setTimeout(r, 6000));

      controlPage = await browser.newPage();
      const controlUrl = `http://control.test:${basePort}/`;
      await controlPage.goto(controlUrl, { waitUntil: 'networkidle2' });
      await controlPage.bringToFront();
      await controlPage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
      });

      const data = await waitForCondition(
        async () => {
          const snapshot = await getDexieData();
          return snapshot.blocks.some((b: any) => b.url.includes('control.test')) ? snapshot : null;
        },
        { timeoutMs: CAPTURE_TIMEOUT_MS, description: 'the allowed control page to be captured' },
      );

      const blockMatch = data.blocks.find((b: any) => b.url.includes('bank.test'));
      expect(blockMatch).toBeUndefined(); // Must not be captured
    } finally {
      await blockedPage.close().catch(() => undefined);
      if (controlPage) await controlPage.close().catch(() => undefined);
    }
  }, CAPTURE_TIMEOUT_MS + 20_000);

  test.skipIf(!BROWSER_TESTS_ENABLED)('URL scrubbing strips secrets, DOM scrubbing removes passwords', async () => {
    const safePage = await browser.newPage();
    try {
      const safeUrl = `http://safe.test:${basePort}/?token=MY_SECRET_TOKEN#access_token=MY_HASH_SECRET`;
      await safePage.goto(safeUrl, { waitUntil: 'networkidle2' });
      await safePage.bringToFront();
      await safePage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
      });

      const data = await waitForCondition(
        async () => {
          const snapshot = await getDexieData();
          return snapshot.blocks.some((b: any) => b.url.includes('safe.test')) ? snapshot : null;
        },
        { timeoutMs: CAPTURE_TIMEOUT_MS, description: 'the allowed page to be captured' },
      );

      const blockMatch = data.blocks.find((b: any) => b.url.includes('safe.test'));
      expect(blockMatch).toBeDefined();

      // URL scrubbing check
      expect(blockMatch.url).not.toContain('MY_SECRET_TOKEN');
      expect(blockMatch.url).not.toContain('MY_HASH_SECRET');
      expect(blockMatch.url).not.toContain('token=');
      expect(blockMatch.url).toContain('safe.test');

      // DOM scrubbing check
      const textMatch = data.texts.find((t: any) => t.url === blockMatch.url);
      expect(textMatch).toBeDefined();
      expect(textMatch.textContent).toContain('Safe text content');
      expect(textMatch.textContent).not.toContain('super_secret_password_123');
      expect(textMatch.textContent).not.toContain('4111222233334444');
    } finally {
      await safePage.close().catch(() => undefined);
    }
  }, CAPTURE_TIMEOUT_MS + 20_000);
});
