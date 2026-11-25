/**
 * INDEPENDENT RUNTIME PROBE — task t_19e6870c (hub #1054)
 * Drives real Chrome via the B* layer against the FRESHLY built dist.
 * Screenshots -> dist/screenshots/indy-*.png
 * Run: EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run verify/runtime-probe.ts
 * Does NOT touch implementation or shipped tests.
 */
import puppeteer, { Browser } from "puppeteer";
import path from "path";
import fs from "fs";
import { extensionLaunchOptions } from "../tests/fixtures/browser-launch";

const WORKSPACE = path.resolve(import.meta.dir);
const REPO = path.resolve(WORKSPACE, "..");
const extPath = path.join(REPO, "dist");
const shotsDir = path.join(extPath, "screenshots");

function log(...args: unknown[]) {
  console.log("[indy-probe]", ...args);
}

async function waitFor<T>(fn: () => T | Promise<T>, ms: number, desc: string): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${desc} (${ms}ms)`);
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  if (!fs.existsSync(path.join(extPath, "manifest.json"))) {
    throw new Error("dist missing — run 'bun run build' first");
  }

  const browser: Browser = await puppeteer.launch({ ...extensionLaunchOptions(extPath) });
  const report: Record<string, unknown> = {};

  try {
    // --- locate extension id from worker target ---
    const swTarget = await waitFor(
      () => browser.targets().find((t) => t.type() === "service_worker"),
      15000,
      "extension service worker"
    );
    const extensionId = new URL(swTarget.url()).host;
    log("extension id:", extensionId);

    const page = await browser.newPage();
    const pageLogs: string[] = [];
    page.on("console", (m) => pageLogs.push(`[console.${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => pageLogs.push(`[pageerror] ${e}`));
    await page.setViewport({ width: 420, height: 800 });

    const sidepanelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`;
    await page.goto(sidepanelUrl, { waitUntil: "networkidle0" });
    await waitFor(() => (page as any).evaluate(() => Boolean((window as any).__exocortex_db)), 10000, "db handle");

    // --- seed two frames: a paraphrase of "canine companion" + an unrelated decoy ---
    await page.evaluate(async () => {
      const db = (window as any).__exocortex_db;
      await db.frames.clear();
      await db.embeddings.clear();
      await db.dwell_blocks.clear();

      const paraphraseId = await db.frames.add({
        url: "https://example.test/dog", title: "Caring for your dog",
        summary: "Grooming and feeding a puppy", domain: "example.test", category: "Research",
        dwellTime: 30, timestamp: Date.now(), synced: false,
      });
      const unrelatedId = await db.frames.add({
        url: "https://example.test/tax", title: "Quarterly tax filing deadlines",
        summary: "Corporate tax guidelines", domain: "example.test", category: "Finance",
        dwellTime: 30, timestamp: Date.now(), synced: false,
      });

      // model-source vectors: same direction for the paraphrase and query
      const fixedV = new Float32Array(384); fixedV[0] = 1; fixedV[1] = 0.5;
      const orthogonalV = new Float32Array(384); orthogonalV[300] = 1;
      await db.embeddings.put({ frameId: paraphraseId, vector: fixedV, dimension: 384, createdAt: Date.now(), source: "model" });
      await db.embeddings.put({ frameId: unrelatedId, vector: orthogonalV, dimension: 384, createdAt: Date.now(), source: "model" });
      return { paraphraseId, unrelatedId };
    });

    // ---- instrumentation: count REQUEST_VECTOR_EMBEDDING messages the panel sends ----
    const counts = await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      (window as any).__indyCounts = { embeddingRequests: 0, blockedEverReachedEmbedder: false };
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          (window as any).__indyCounts.embeddingRequests++;
        }
        return orig(msg, cb);
      };
      return true;
    });

    // ================= CASE A: REAL embedder, unstubbed =================
    // Type "canine companion" with NO stub. The panel debounces 200ms, then calls
    // REQUEST_VECTOR_EMBEDDING -> SW -> offscreen document -> Transformers.js.
    // Local model cache (~/.cache/huggingface) + network are available.
    log("CASE A: real embedder attempt (no stub). typing 'canine companion'");
    const input = await page.$("#search-input");
    if (!input) throw new Error("no #search-input");
    await input.type("canine companion");

    let realVectorBadge = false;
    let realOutcome: string;
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById("timeline");
          return el && (el.innerHTML.includes("vector · cos") || el.innerHTML.includes("Semantic search unavailable") || el.innerHTML.includes("lexical"));
        },
        { timeout: 150_000 }
      );
      const html = await page.$eval("#timeline", (el) => el.innerHTML);
      realVectorBadge = html.includes("vector · cos");
      realOutcome = realVectorBadge
        ? "vector badge rendered from REAL offscreen MiniLM path"
        : html.includes("Semantic search unavailable")
          ? "embedding_unavailable banner rendered"
          : "lexical results rendered (fallback or no embed)";
    } catch {
      realOutcome = `no semantic render within 150s (embedding request count=${(await page.evaluate(() => (window as any).__indyCounts.embeddingRequests))})`;
    }
    log("CASE A outcome:", realOutcome);
    report.caseA_real_embedder = realOutcome;
    report.caseA_embeddingRequests = await page.evaluate(() => (window as any).__indyCounts.embeddingRequests);
    const realHtml = await page.$eval("#timeline", (el) => el.innerHTML).catch(() => "");
    const cosMatch = realHtml.match(/vector · cos ([0-9.]+)/);
    report.caseA_cosine = cosMatch ? parseFloat(cosMatch[1]) : null;
    if (realVectorBadge) report.caseA_real_model_vector_confirmed = true;
    await page.screenshot({ path: path.join(shotsDir, "indy-a-real-embedder.png") });

    // clear input
    await page.evaluate(() => { const i = document.getElementById("search-input") as HTMLInputElement; i.value = ""; });
    await new Promise((r) => setTimeout(r, 400));

    // ================= CASE B: blocked query reaches NO embedder =================
    log("CASE B: blocked query 'chase.com'");
    const before = await page.evaluate(() => (window as any).__indyCounts.embeddingRequests);
    const inputB = await page.$("#search-input");
    if (!inputB) throw new Error("no #search-input (B)");
    await inputB.type("chase.com");
    await waitFor(
      () => page.$eval("#timeline", (el) => el.innerHTML.includes("Fail-Closed Privacy Shield")).catch(() => false),
      15_000,
      "privacy shield render"
    );
    const after = await page.evaluate(() => (window as any).__indyCounts.embeddingRequests);
    const blockedHtml = await page.$eval("#timeline", (el) => el.innerHTML);
    const blockedEmbedRequestsDuringQuery = after - before;
    log("CASE B: embeddingRequests delta during blocked query =", blockedEmbedRequestsDuringQuery);
    report.caseB_blocked_query = blockedHtml.includes("Fail-Closed Privacy Shield") ? "privacy shield rendered" : "shield MISSING";
    report.caseB_embeddingRequestsDuringBlockedQuery = blockedEmbedRequestsDuringQuery;
    report.caseB_blockedReachedEmbedder = blockedEmbedRequestsDuringQuery > 0;
    await page.screenshot({ path: path.join(shotsDir, "indy-b-privacy-blocked.png") });

    await page.evaluate(() => { const i = document.getElementById("search-input") as HTMLInputElement; i.value = ""; });
    await new Promise((r) => setTimeout(r, 400));

    // ================= CASE C: embedder FAILURE via stub -> banner or silent? =================
    log("CASE C: embedder returns {status:'error'} (simulated outage)");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      const real = orig;
      (window as any).__indyRealSend = real;
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          // Simulate an embedder outage: service worker healthy, embedding fails.
          cb({ status: "error", error: "simulated embedder outage" });
          return undefined as any;
        }
        return real(msg, cb);
      };
    });
    const inputC = await page.$("#search-input");
    if (!inputC) throw new Error("no #search-input (C)");
    await inputC.type("canine companion");
    await waitFor(
      () => page.$eval("#timeline", (el) => el.innerHTML.includes("Semantic search unavailable") || el.innerHTML.includes("lexical") || el.innerHTML.includes("vector")).catch(() => false),
      15_000,
      "embedder-failure render"
    );
    const failHtml = await page.$eval("#timeline", (el) => el.innerHTML);
    const bannerShown = failHtml.includes("Semantic search unavailable");
    const lexicalShown = failHtml.includes("lexical");
    log("CASE C: banner shown =", bannerShown, "| lexical shown =", lexicalShown);
    report.caseC_embedder_failure_banner_shown = bannerShown;
    report.caseC_embedder_failure_lexical_shown = lexicalShown;
    await page.screenshot({ path: path.join(shotsDir, "indy-c-embedder-failure.png") });

    // ================= CASE D: deterministic stub guarantee (vector badge) =================
    // Re-stub to the deterministic model reply used by CI, to guarantee the vector-badge
    // screenshot even if the real-model path could not produce one in time.
    await page.evaluate(() => {
      const real = (window as any).__indyRealSend || chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg: any, cb: any) => {
        if (msg && msg.type === "REQUEST_VECTOR_EMBEDDING") {
          const fixed = new Float32Array(384); fixed[0] = 1; fixed[1] = 0.5;
          cb({ status: "success", vector: Array.from(fixed), source: "model" });
          return undefined as any;
        }
        return real(msg, cb);
      };
    });
    await page.evaluate(() => { const i = document.getElementById("search-input") as HTMLInputElement; i.value = ""; });
    await new Promise((r) => setTimeout(r, 400));
    const inputD = await page.$("#search-input");
    if (!inputD) throw new Error("no #search-input (D)");
    await inputD.type("canine companion");
    await waitFor(
      () => page.$eval("#timeline", (el) => el.innerHTML.includes("vector · cos")).catch(() => false),
      10_000,
      "vector badge (stub)"
    );
    const stubHtml = await page.$eval("#timeline", (el) => el.innerHTML);
    const stubCos = stubHtml.match(/vector · cos ([0-9.]+)/);
    report.caseD_stub_vector_badge = stubHtml.includes("vector · cos") ? `vector · cos ${stubCos?.[1]}` : "MISSING";
    await page.screenshot({ path: path.join(shotsDir, "indy-d-vector-hit-stub.png") });

    await page.close();

    log("=== PROBE REPORT ===");
    console.log(JSON.stringify(report, null, 2));
    log("=== PAGE LOGS (last 40) ===");
    pageLogs.slice(-40).forEach((l) => console.log(l));
  } finally {
    await browser.close();
  }
}

main().then(
  () => { console.log("[indy-probe] DONE"); process.exit(0); },
  (err) => { console.error("[indy-probe] FAILED:", err); process.exit(1); }
);