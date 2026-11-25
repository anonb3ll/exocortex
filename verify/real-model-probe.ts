/**
 * REAL-MODEL RUNTIME PROBE — allows huggingface.co through the resolver map,
 * so the offscreen document can actually download/load Xenova/all-MiniLM-L6-v2
 * and produce a genuine "model" source vector in a live Chrome panel run.
 * Screenshot -> dist/screenshots/indy-real-model-vector.png
 */
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import { BROWSER_LAUNCH_ARGS } from "../tests/fixtures/browser-launch";

const REPO = path.resolve(import.meta.dir, "..");
const extPath = path.join(REPO, "dist");
const shotsDir = path.join(extPath, "screenshots");
fs.mkdirSync(shotsDir, { recursive: true });

// Default harness maps * -> 127.0.0.1 (privacy/no-third-party-DNS). EXCLUDE lets
// the model download actually reach Hugging Face; everything else stays mapped.
const REAL_RESOLVER = ["--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE huggingface.co, EXCLUDE cdn-lfs.huggingface.co, EXCLUDE huggingface.co/*"];

const waitFor = async <T>(fn: () => T | Promise<T>, ms: number, desc: string): Promise<T> => {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${desc} (${ms}ms)`);
};

async function main() {
  const args = BROWSER_LAUNCH_ARGS.filter((a) => !a.startsWith("--host-resolver-rules"));
  const launch = {
    headless: true as const,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...args, ...REAL_RESOLVER],
  };
  const browser = await puppeteer.launch(launch as any);
  const logs: string[] = [];
  try {
    const swTarget = await waitFor(() => browser.targets().find((t) => t.type() === "service_worker"), 15000, "service worker");
    const extId = new URL(swTarget.url()).host;
    swTarget.worker().then((w) => w?.on("console", (m) => logs.push(`[SW] ${m.text()}`))).catch(() => {});
    const poll = setInterval(() => {
      for (const t of browser.targets()) {
        if (t.url().includes("offscreen")) {
          t.worker().then((w) => w?.on("console", (m) => logs.push(`[OFFSCREEN] ${m.text()}`))).catch(() => {});
        }
      }
    }, 3000);
    setTimeout(() => clearInterval(poll), 240000);

    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 800 });
    await page.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "networkidle0" });
    await waitFor(() => page.evaluate(() => Boolean((window as any).__exocortex_db)), 15000, "db handle");

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

    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      (window as any).__indyReply = null;
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          const t0 = performance.now();
          const r = orig(msg, (resp: any) => {
            (window as any).__indyReply = {
              status: resp?.status ?? null,
              source: resp?.source ?? null,
              vectorLen: resp?.vector?.length ?? null,
              ms: Math.round(performance.now() - t0),
            };
            cb(resp);
          });
          return r;
        }
        return orig(msg, cb);
      };
    });

    const input = await page.$("#search-input");
    log("typing 'canine companion' with REAL model path enabled");
    await input!.type("canine companion");

    let vectorBadge = false;
    let cosine: number | null = null;
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById("timeline");
          return el && (el.innerHTML.includes("vector · cos") || el.innerHTML.includes("lexical") || el.innerHTML.includes("Semantic search unavailable"));
        },
        { timeout: 200_000 }
      );
      const html = await page.$eval("#timeline", (el) => el.innerHTML);
      vectorBadge = html.includes("vector · cos");
      const m = html.match(/vector · cos ([0-9.]+)/);
      cosine = m ? parseFloat(m[1]) : null;
    } catch {
      // fall through, report timeout
    }

    const reply = await page.evaluate(() => (window as any).__indyReply);
    log("REPLY:", JSON.stringify(reply));
    log("VECTOR BADGE:", vectorBadge, "cosine:", cosine);
    await page.screenshot({ path: path.join(shotsDir, "indy-real-model-vector.png") });
    await new Promise((r) => setTimeout(r, 5000));
    console.log("=== OFFScreen/SW LOGS ===");
    logs.forEach((l) => console.log(l));
    console.log(JSON.stringify({ reply, vectorBadge, cosine, screenshot: path.join(shotsDir, "indy-real-model-vector.png") }, null, 2));
  } finally {
    await browser.close();
  }
}
function log(...a: unknown[]) { console.log("[real-model]", ...a); }
main().then(() => process.exit(0), (e) => { console.error("[real-model] FAILED", e); process.exit(1); });