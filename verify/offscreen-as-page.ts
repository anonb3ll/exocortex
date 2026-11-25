/**
 * Open the offscreen document AS A PAGE and call GENERATE_EMBEDDING through the
 * extension's real code path to capture exactly why embedWithFallback fails in
 * this environment (model fetch? wasm? backend?).
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
  const args = BROWSER_LAUNCH_ARGS.filter((a) => !a.startsWith("--host-resolver-rules"));
  args.push("--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE huggingface.co, EXCLUDE cdn-lfs.huggingface.co, EXCLUDE hf.co");
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...args] } as any);
  try {
    const swTarget = await waitFor(() => browser.targets().find((t) => t.type() === "service_worker"), 15000, "sw");
    const extId = new URL(swTarget.url()).host;

    // Open the offscreen HTML as a normal extension page; its onMessage listener
    // is the same code, and as a page we get full console/network capture.
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on("console", (m) => logs.push(`[PAGE.${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[PAGE.ERROR] ${e}`));
    page.on("requestfailed", (r) => logs.push(`[REQ-FAIL] ${r.url()} :: ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) logs.push(`[HTTP ${r.status()}] ${r.url()}`); });

    await page.goto(`chrome-extension://${extId}/src/offscreen/offscreen.html`, { waitUntil: "networkidle0", timeout: 60000 });

    const embedResult = await page.evaluate(() => new Promise<any>((resolve) => {
      chrome.runtime.sendMessage({ type: "GENERATE_EMBEDDING", payload: { text: "canine companion" } }, (resp) => {
        resolve({ status: resp?.status ?? null, source: resp?.source ?? null, vectorLen: resp?.vector?.length ?? null, error: resp?.error ?? null, lastError: chrome.runtime.lastError?.message ?? null });
      });
      setTimeout(() => resolve({ TIMEOUT: true }), 240000);
    }));
    console.log("EMBED RESULT:", JSON.stringify(embedResult));
    await new Promise((r) => setTimeout(r, 3000));
    console.log("=== LOGS ===");
    logs.forEach((l) => console.log(l));
  } finally {
    await browser.close();
  }
}
main().then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1); });