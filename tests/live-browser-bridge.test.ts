/**
 * B4: Live-browser bridge reliability.
 *
 * Loads the built extension into a real Chrome and asserts the steady state
 * that ships to every user who has not installed the native host: the service
 * worker boots clean, the bridge degrades instead of throwing, and the health
 * diagnostic is answerable from an extension page.
 *
 * Opt-in via EXOCORTEX_BROWSER_TESTS=1. Prefer `xvfb-run -a` so any residual
 * display need does not touch a live desktop session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer";
import { existsSync } from "node:fs";
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from "./fixtures/browser-launch";
import { BROWSER_SETUP_HOOK_TIMEOUT_MS, BROWSER_SETUP_TIMEOUT_MS, waitForCondition } from "./fixtures/wait-for";
import path from "node:path";

const extPath = path.resolve(import.meta.dir, "../dist");

describe("B4: live-browser bridge reliability", () => {
  let browser: Browser | undefined;
  let extensionId = "";
  const workerExceptions: string[] = [];

  beforeAll(async () => {
    if (!BROWSER_TESTS_ENABLED) return;
    if (!existsSync(extPath)) throw new Error(`Missing ${extPath}. Run 'bun run build' first.`);

    browser = await puppeteer.launch(extensionLaunchOptions(extPath));

    const target = await waitForCondition(
      () => browser?.targets().find((t) => t.type() === "service_worker"),
      { timeoutMs: BROWSER_SETUP_TIMEOUT_MS, description: "the extension service worker to start" },
    );

    extensionId = target.url().split("/")[2]!;
    const session = await target.createCDPSession();
    session.on("Runtime.exceptionThrown", (event: any) =>
      workerExceptions.push(event.exceptionDetails?.text ?? "unknown service worker exception"),
    );
    await session.send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 2_000));
  }, BROWSER_SETUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)("service worker boots without an installed native host", () => {
    expect(extensionId).not.toBe("");
    expect(workerExceptions).toEqual([]);
  });

  test.skipIf(!BROWSER_TESTS_ENABLED)("reports bridge health as degraded rather than crashing", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

      const response = (await page.evaluate(
        () =>
          new Promise((resolve) =>
            chrome.runtime.sendMessage({ type: "GET_BRIDGE_HEALTH" }, (r: unknown) =>
              resolve(r ?? { status: "no-response", error: chrome.runtime.lastError?.message }),
            ),
          ),
      )) as { status: string; bridge?: Record<string, unknown> };

      expect(response.status).toBe("success");
      expect(response.bridge).toBeDefined();
      // No native host is registered in this environment, so the port must have
      // been refused or dropped — and the worker must still be answering.
      expect(response.bridge!.connected).toBe(false);
      expect(typeof response.bridge!.connectAttempts).toBe("number");
      expect(response.bridge!.served).toBe(0);
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 30_000);

  test.skipIf(!BROWSER_TESTS_ENABLED)("keeps capture working while the bridge is unavailable", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

      const reachable = await page.evaluate(async () => {
        const request = indexedDB.open("ExocortexVault");
        const database: IDBDatabase = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const names = Array.from(database.objectStoreNames);
        database.close();
        return names;
      });

      expect(reachable).toContain("dwell_blocks");
      expect(reachable).toContain("page_text");
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 30_000);
});
