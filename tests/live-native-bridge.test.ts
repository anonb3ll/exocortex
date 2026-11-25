/**
 * B5: End-to-end live native-messaging bridge.
 *
 * Drives the whole Alpha bridge path with no shims: real Chrome, real unpacked
 * extension, real Chrome-spawned native host process, real Unix socket, real
 * Dexie data. Chrome resolves user-level native-messaging manifests relative to
 * its user-data directory, so the host is registered inside a throwaway profile
 * and never touches the developer's own Chrome configuration.
 *
 * Opt-in via EXOCORTEX_BROWSER_TESTS=1; prefer `xvfb-run -a bun test`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeBridgeServer } from "../src/bridge/server";
import { BROWSER_LAUNCH_ARGS, BROWSER_TESTS_ENABLED } from "./fixtures/browser-launch";

const extPath = path.resolve(import.meta.dir, "../dist");
const hostScript = path.resolve(import.meta.dir, "../scripts/exocortex-native-host.ts");
const enabled = BROWSER_TESTS_ENABLED && existsSync(extPath);

describe("B5: live native-messaging bridge", () => {
  let profile = "";
  let browser: Browser | undefined;
  let bridge: NativeBridgeServer | undefined;
  let extensionId = "";

  const launch = (userDataDir: string) =>
    puppeteer.launch({
      headless: true,
      userDataDir,
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...BROWSER_LAUNCH_ARGS],
    });

  const serviceWorkerId = async (b: Browser) => {
    const deadline = Date.now() + 15_000;
    let target = b.targets().find((t) => t.type() === "service_worker");
    while (!target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      target = b.targets().find((t) => t.type() === "service_worker");
    }
    if (!target) throw new Error("extension service worker never started");
    return target.url().split("/")[2]!;
  };

  beforeAll(async () => {
    if (!enabled) return;
    profile = await mkdtemp(path.join(tmpdir(), "exo-profile-"));

    // Pass 1: learn the unpacked extension ID so the host can allow-list it.
    const probe = await launch(profile);
    extensionId = await serviceWorkerId(probe);
    await probe.close();

    const socketPath = path.join(profile, "bridge.sock");
    bridge = new NativeBridgeServer(socketPath, 5_000);
    await bridge.start();

    // Chrome execs this directly, so it must be an executable that pins the socket.
    const wrapper = path.join(profile, "exocortex-native-host");
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport EXOCORTEX_NATIVE_BRIDGE_SOCKET="${socketPath}"\nexec "${process.execPath}" "${hostScript}"\n`,
    );
    await chmod(wrapper, 0o755);

    const hostDir = path.join(profile, "NativeMessagingHosts");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, "io.exocortex.mcp_bridge.json"),
      JSON.stringify({
        name: "io.exocortex.mcp_bridge",
        description: "Exocortex local MCP bridge",
        path: wrapper,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
    );

    // Pass 2: same profile, now with the host registered.
    browser = await launch(profile);
    await serviceWorkerId(browser);
    await new Promise((r) => setTimeout(r, 2_000));
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await bridge?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  test.skipIf(!enabled)("Chrome connects the extension to the MCP bridge", async () => {
    expect(bridge).toBeDefined();
    const page = await browser!.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const health = (await page.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: "GET_BRIDGE_HEALTH" }, (r: unknown) => resolve(r)),
        ),
    )) as { bridge: Record<string, unknown> };

    expect(health.bridge.connected).toBe(true);
    expect(health.bridge.gaveUp).toBe(false);
    await page.close();
  }, 30_000);

  test.skipIf(!enabled)("a live search returns real captures as metadata only", async () => {
    const page = await browser!.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    // Seed a synthetic capture through the extension's own Dexie database.
    await page.evaluate(async () => {
      const open = indexedDB.open("ExocortexVault");
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("page_text", "readwrite");
        tx.objectStore("page_text").put({
          url: "https://synthetic.test/alpha-dogfood?token=supersecret",
          title: "Alpha dogfood synthetic capture",
          excerpt: "synthetic excerpt body",
          textContent: "synthetic body text about zebrafish telemetry",
          // Fresh timestamp: retention (#661) filters records older than 7 days,
          // so a fixed 2023 parsedAt would be silently dropped from search.
          parsedAt: Date.now() - 60_000,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    });
    await page.close();

    const result = (await bridge!.request("search_memory", { query: "zebrafish", limit: 5 })) as Array<
      Record<string, unknown>
    >;

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // `handle` joins parsedAt/score deliberately: it is what lets an agent act on
    // a result it is not allowed to read. Everything captured from the page is
    // still absent, asserted term by term below.
    expect(Object.keys(result[0]!).sort()).toEqual(["handle", "parsedAt", "score"]);
    expect(String(result[0]!.handle)).toMatch(/^mem_[0-9]+$/);

    const serialized = JSON.stringify(result);
    for (const leak of ["supersecret", "synthetic.test", "zebrafish", "Alpha dogfood", "synthetic excerpt"]) {
      expect(serialized).not.toContain(leak);
    }
  }, 30_000);

  test.skipIf(!enabled)("a handle opens the memory in the browser without ever returning it", async () => {
    const results = (await bridge!.request("search_memory", { query: "zebrafish", limit: 5 })) as Array<
      Record<string, unknown>
    >;
    const handle = String(results[0]!.handle);

    const before = (await browser!.pages()).length;
    const opened = (await bridge!.request("open_memory", { handle })) as Record<string, unknown>;

    expect(opened.status).toBe("opened");
    // The acknowledgement carries the handle back and nothing else — the URL the
    // browser resolved it to never crosses the wire.
    expect(Object.keys(opened).sort()).toEqual(["handle", "status"]);
    expect(JSON.stringify(opened)).not.toContain("synthetic.test");
    expect(JSON.stringify(opened)).not.toContain("supersecret");

    // The side effect really happened in the real browser. Poll targets —
    // chrome-error:// interstitials may not surface in browser.pages(), but the
    // page target with the synthetic URL always registers.
    await (async () => {
      for (let i = 0; i < 40; i++) {
        const urls = browser!.targets().filter((t) => t.type() === "page").map((t) => t.url());
        if (urls.some((u) => u.startsWith("https://synthetic.test"))) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("opened memory never appeared as a browser page target");
    })();
  }, 30_000);

  test.skipIf(!enabled)("an unknown handle is reported, not fabricated", async () => {
    const result = (await bridge!.request("open_memory", { handle: "mem_999999" })) as Record<string, unknown>;
    expect(result.status).toBe("not_found");
  }, 30_000);

  test.skipIf(!enabled)("enumerating handles is rate limited, not unbounded", async () => {
    // Handles are sequential and the validator accepts any well-formed one, so
    // mem_1..mem_N is trivially enumerable. Nothing leaks — but an agent should not
    // be able to drive an unbounded number of tab opens in the user's browser.
    const statuses: unknown[] = [];
    for (let i = 1; i <= 12; i++) {
      const result = (await bridge!.request("open_memory", { handle: `mem_${i}` })) as Record<string, unknown>;
      statuses.push(result.status);
    }
    expect(statuses).toContain("rate_limited");
    // And it is a cap, not a kill switch: the early calls were served.
    expect(statuses.filter((s) => s === "rate_limited").length).toBeLessThan(statuses.length);
  }, 60_000);

  test.skipIf(!enabled)("a query matching nothing returns an empty result, not an error", async () => {
    const result = (await bridge!.request("search_memory", { query: "no-such-capture-xyz", limit: 5 })) as unknown[];
    expect(result).toEqual([]);
  }, 30_000);

  test.skipIf(!enabled)("the extension service worker is what answered those searches", async () => {
    const page = await browser!.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const health = (await page.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: "GET_BRIDGE_HEALTH" }, (r: unknown) => resolve(r)),
        ),
    )) as { bridge: Record<string, number> };

    expect(health.bridge.served).toBeGreaterThanOrEqual(2);
    expect(health.bridge.rejected).toBe(0);
    await page.close();
  }, 30_000);
});
