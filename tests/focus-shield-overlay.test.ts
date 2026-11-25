import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { serve } from "bun";
import path from "node:path";
import { existsSync } from "node:fs";
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from "./fixtures/browser-launch";
import { BROWSER_SETUP_HOOK_TIMEOUT_MS, BROWSER_SETUP_TIMEOUT_MS, waitForCondition } from "./fixtures/wait-for";

describe("B6: Focus Shield overlay", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let testUrl = "";
  let extensionId = "";
  const extPath = path.resolve(import.meta.dir, "../dist");

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!existsSync(extPath)) throw new Error(`Missing ${extPath}. Run 'bun run build' first.`);
    server = serve({
      port: 0,
      fetch: () => new Response("<html><head><title>Focus test</title></head><body><h1>Focus test</h1></body></html>", {
        headers: { "Content-Type": "text/html" }
      })
    });
    testUrl = `http://localhost:${server.port}/focus`;
    browser = await puppeteer.launch({ ...extensionLaunchOptions(extPath) });
    const target = await waitForCondition(
      () => browser?.targets().find((candidate) => candidate.type() === "service_worker"),
      { timeoutMs: BROWSER_SETUP_TIMEOUT_MS, description: "the extension service worker to start" },
    );
    extensionId = target.url().split("/")[2]!;
  }, BROWSER_SETUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    server?.stop();
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)("shows and dismisses the user-facing overlay", async () => {
    page = await browser!.newPage();
    await page.goto(testUrl, { waitUntil: "networkidle2" });
    await page.bringToFront();

    const control = await browser!.newPage();
    await control.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await control.evaluate((url) => new Promise<void>((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const target = tabs.find((tab) => tab.url === url);
        if (!target?.id) return resolve();
        chrome.tabs.sendMessage(target.id, {
          type: "FOCUS_SHIELD_SHOW",
          intervention: { reason: "Test fatigue intervention", fatigueScore: 91 }
        }, () => resolve());
      });
    }), testUrl);

    await page.waitForFunction(() => Boolean(document.querySelector("#exocortex-focus-shield-overlay")));
    expect(await page.$eval("#exocortex-focus-shield-overlay", (node) => (node as HTMLElement).shadowRoot)).toBe(null);

    await control.evaluate((url) => new Promise<void>((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const target = tabs.find((tab) => tab.url === url);
        if (!target?.id) return resolve();
        chrome.tabs.sendMessage(target.id, { type: "FOCUS_SHIELD_CONTEXT", prompt: "secret restored context" }, () => resolve());
      });
    }), testUrl);
    expect(await page.$eval("body", (body) => body.textContent?.includes("secret restored context") === true)).toBe(false);

    await control.evaluate((url) => new Promise<void>((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const target = tabs.find((tab) => tab.url === url);
        if (!target?.id) return resolve();
        chrome.tabs.sendMessage(target.id, { type: "FOCUS_SHIELD_HIDE" }, () => resolve());
      });
    }), testUrl);
    await control.close();
    await page.waitForFunction(() => !document.querySelector("#exocortex-focus-shield-overlay"));
  }, 30_000);
});
