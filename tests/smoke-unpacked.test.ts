import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import puppeteer, { Browser } from 'puppeteer';
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from './fixtures/browser-launch';
import { BROWSER_SETUP_TIMEOUT_MS, waitForCondition } from './fixtures/wait-for';
import path from 'path';
import fs from 'fs';

describe('B1: Exocortex Smoke Test - Load Unpacked', () => {
  let browser: Browser;
  let extensionId: string;
  const errors: string[] = [];
  const extPath = path.resolve(import.meta.dir, '../dist');

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!fs.existsSync(extPath)) {
      throw new Error(`Extension path does not exist: ${extPath}. Please run 'bun run build' first.`);
    }
    
    console.log(`Loading extension from: ${extPath}`);
    browser = await puppeteer.launch({
      ...extensionLaunchOptions(extPath),
    });
    // bun's default hook timeout is 5s and a cold Chrome launch with an unpacked
    // extension exceeds it. Untimed, this file passed only when something else had
    // already warmed Chrome — i.e. on test-file ordering, not on the extension
    // actually loading.
  }, BROWSER_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)('Extension loads without immediate runtime errors', async () => {
    const backgroundTarget = await waitForCondition(
      () => browser.targets().find(t => t.type() === 'service_worker'),
      { timeoutMs: BROWSER_SETUP_TIMEOUT_MS, description: 'the extension service worker to start' },
    );

    expect(backgroundTarget).toBeDefined();
    
    if (backgroundTarget) {
      const workerUrl = backgroundTarget.url();
      expect(workerUrl).toContain('chrome-extension://');
      
      extensionId = workerUrl.split('/')[2];
      console.log(`Extension ID: ${extensionId}`);
      
      const workerSession = await backgroundTarget.createCDPSession();
      
      workerSession.on('Runtime.exceptionThrown', (e: any) => {
        errors.push(`Exception in SW: ${e.exceptionDetails.text} ${e.exceptionDetails.exception?.description || ''}`);
      });
      
      await workerSession.send('Runtime.enable');
      
      // Also check if offscreen document is open
      const currentTargets = browser.targets();
      const offscreenTarget = currentTargets.find(t => t.url().includes('offscreen.html'));
      if (offscreenTarget) {
         console.log('Offscreen document is active.');
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
    expect(errors).toEqual([]);
  });
});
