/**
 * Direct offscreen-document probe: open the extension offscreen page, call the
 * REAL embedder path (GENERATE_EMBEDDING) and capture EVERYTHING it logs,
 * with a clean resolver EXCLUDE for HF hosts.
 */
import puppeteer from "puppeteer";
import path from "path";
import { BROWSER_LAUNCH_ARGS } from "../tests/fixtures/browser-launch";

const REPO = path.resolve(import.meta.dir, "..");
const extPath = path.join(REPO, "dist");

const waitFor = async <T>(fn: () => T | Promise<T>, ms: number, desc: string): Promise<T> => {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${desc}`);
};

async function main() {
  // Clean resolver: map everything to localhost EXCEPT HF model hosts.
  const args = BROWSER_LAUNCH_ARGS.filter((a) => !a.startsWith("--host-resolver-rules"));
  args.push("--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE huggingface.co, EXCLUDE cdn-lfs.huggingface.co, EXCLUDE hf.co");
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...args] } as any);
  const logs: string[] = [];
  try {
    const swTarget = await waitFor(() => browser.targets().find((t) => t.type() === "service_worker"), 15000, "sw");
    const extId = new URL(swTarget.url()).host;

    // find the offscreen document target (it may take a moment; first trigger creation by embedding through the SW)
    const sw = await swTarget.worker();
    sw.on("console", (m) => logs.push(`[SW] ${m.text()}`));

    // Trigger a REQUEST_VECTOR_EMBEDDING from a plain panel page, then find the offscreen target
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 800 });
    await page.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "networkidle0" });
    await waitFor(() => page.evaluate(() => Boolean((window as any).__exocortex_db)), 10000, "db");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      (window as any).__reply = null;
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          const t0 = performance.now();
          const r = orig(msg, (resp: any) => {
            (window as any).__reply = { status: resp?.status ?? null, source: resp?.source ?? null, ms: Math.round(performance.now() - t0) };
            cb(resp);
          });
          return r;
        }
        return orig(msg, cb);
      };
    });

    let offscreenPage: puppeteer.Page | null = null;
    browser.on("targetcreated", (t) => {
      if (t.url().includes("offscreen")) {
        t.page().then((p) => {
          if (p) {
            offscreenPage = p;
            p.on("console", (m) => logs.push(`[OFFSCREEN-PAGE] ${m.text()}`));
            p.on("pageerror", (e) => logs.push(`[OFFSCREEN-ERROR] ${e}`));
            p.on("requestfailed", (r) => logs.push(`[OFFSCREEN-REQ-FAIL] ${r.url()} :: ${r.failure()?.errorText}`));
          }
        }).catch(() => {});
      }
    });

    const reply = await page.evaluate(() => new Promise<unknown[]>((resolve) => {
      // call the embedder directly via the panel's own mechanism — simplest: type a query
      const input = document.getElementById("search-input") as HTMLInputElement;
      input.value = "canine companion";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const check = () => {
        const r = (window as any).__reply;
        if (r) clearInterval(iv), resolve([r]);
      };
      const iv = setInterval(check, 250);
      setTimeout(() => { clearInterval(iv); resolve([(window as any).__reply ?? { timeout: true }]); }, 180000);
    }));

    console.log("REPLY:", JSON.stringify(reply));
    await new Promise((r) => setTimeout(r, 10000));
    console.log("OFFSCREEN TARGETS:", browser.targets().filter((t) => t.url().includes("offscreen")).map((t) => t.url()));
    console.log("=== LOGS ===");
    logs.forEach((l) => console.log(l));
  } finally {
    await browser.close();
  }
}
main().then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1); });