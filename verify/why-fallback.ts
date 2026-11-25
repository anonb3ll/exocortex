/** Capture why the real offscreen model did not produce a model vector in B*. */
import puppeteer from "puppeteer";
import path from "path";
import { extensionLaunchOptions } from "../tests/fixtures/browser-launch";

const REPO = path.resolve(import.meta.dir, "..");
const extPath = path.join(REPO, "dist");

const waitFor = async <T>(fn: () => T | Promise<T>, ms: number, desc: string): Promise<T> => {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${desc}`);
};

async function main() {
  const browser = await puppeteer.launch({ ...extensionLaunchOptions(extPath) });
  const logs: string[] = [];
  try {
    const swTarget = await waitFor(
      () => browser.targets().find((t) => t.type() === "service_worker"),
      15000, "service worker"
    );
    const extId = new URL(swTarget.url()).host;
    const sw = await swTarget.worker();
    sw?.on("console", (m) => logs.push(`[SW] ${m.type()}: ${m.text()}`));

    // capture offscreen doc console if present
    browser.on("targetcreated", (t) => {
      const u = t.url();
      if (u.includes("offscreen")) {
        t.worker().then((w) => w?.on("console", (m) => logs.push(`[OFFSCREEN] ${m.type()}: ${m.text()}`))).catch(() => {});
      }
    });
    // find existing offscreen target after creation
    const poll = setInterval(() => {
      for (const t of browser.targets()) {
        if (t.url().includes("offscreen")) {
          t.worker().then((w) => w?.on("console", (m) => logs.push(`[OFFSCREEN] ${m.type()}: ${m.text()}`))).catch(() => {});
        }
      }
    }, 2000);
    setTimeout(() => clearInterval(poll), 120000);

    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 800 });
    await page.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "networkidle0" });
    await waitFor(() => page.evaluate(() => Boolean((window as any).__exocortex_db)), 10000, "db");

    // seed one frame
    await page.evaluate(async () => {
      const db = (window as any).__exocortex_db;
      await db.frames.clear(); await db.embeddings.clear();
      const id = await db.frames.add({
        url: "https://example.test/dog", title: "Caring for your dog",
        summary: "Grooming and feeding a puppy", domain: "example.test", dwellTime: 30,
        timestamp: Date.now(), synced: false,
      });
      const v = new Float32Array(384); v[0] = 1; v[1] = 0.5;
      await db.embeddings.put({ frameId: id, vector: v, dimension: 384, createdAt: Date.now(), source: "model" });
    });

    // instrument to record the actual embedder reply
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      (window as any).__indyReply = null;
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          const t0 = performance.now();
          const real = orig(msg, (resp: any) => {
            (window as any).__indyReply = { resp: resp && resp.status, err: chrome.runtime.lastError?.message ?? null, ms: Math.round(performance.now() - t0) };
            cb(resp);
          });
          return real;
        }
        return orig(msg, cb);
      };
    });

    const input = await page.$("#search-input");
    await input!.type("canine companion");
    await waitFor(() => page.$eval("#timeline", (el) => el.innerHTML.includes("lexical")).catch(() => false), 20000, "lexical render");
    const reply = await page.evaluate(() => (window as any).__indyReply);
    const html = await page.$eval("#timeline", (el) => el.innerHTML);
    console.log("INDY-REPLY:", JSON.stringify(reply));
    console.log("TIMELINE:", html.slice(0, 600));
    await new Promise((r) => setTimeout(r, 15000)); // allow model download/fallback to finish logging
    console.log("=== LOGS ===");
    logs.forEach((l) => console.log(l));
  } finally {
    await browser.close();
  }
}
main().then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1); });