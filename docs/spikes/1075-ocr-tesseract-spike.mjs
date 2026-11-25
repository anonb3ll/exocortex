// SPIKE SCRIPT — task #1075. NOT part of the shipped extension.
//
// Measures Tesseract.js (WASM) OCR recognition latency inside a real Chromium
// page — the same rendering/WASM engine a chrome.offscreen document uses —
// loading every tesseract.js asset (worker script, WASM core, traineddata)
// from a local static server instead of the jsdelivr CDN, to prove the
// engine can run fully local (see the spike report in this directory for why
// that matters: MV3 CSP `script-src 'self'` blocks the CDN defaults anyway).
//
// This file is a reproducibility record, not shipped code. It is not wired
// into src/offscreen/ocr.ts and has no effect on the built extension.
//
// Setup (from a scratch directory, NOT this repo's node_modules):
//   npm init -y
//   npm install tesseract.js@5 puppeteer@25
//   curl -L https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz \
//     -o eng.traineddata.gz && gunzip -k eng.traineddata.gz
//   node 1075-ocr-tesseract-spike.mjs   (run from that scratch directory,
//     with this file's `puppeteer` import path adjusted to its node_modules)
//
// Measured results from the 2026-09-21 run are in
// docs/spikes/1075-ocr-tesseract-spike-report.md — this script is kept for
// anyone who wants to reproduce or extend the measurement.

import puppeteer from "puppeteer";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // static root: expects ./node_modules and ./eng.traineddata beside this file

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
};

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }
  const filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`[spike] static server on ${base}`);

if (!existsSync(path.join(ROOT, "eng.traineddata"))) {
  console.error("Missing eng.traineddata — download it first (see header comment).");
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("requestfailed", (req) => console.log("[requestfailed]", req.url(), req.failure()?.errorText));
page.setDefaultTimeout(120000);

const html = `<!doctype html><html><body>
<canvas id="c" width="1280" height="800"></canvas>
<script src="${base}/node_modules/tesseract.js/dist/tesseract.min.js"></script>
</body></html>`;

await page.setContent(html, { waitUntil: "load" });

// Realistic "screen capture with text" frame: a paragraph of body text at
// typical UI font size, matching the 1280px-wide downsampled screenshot
// docs/on-device-embeddings.md describes for visual frames.
const paragraph = `The quarterly revenue report shows a 12% increase over Q2, driven
primarily by growth in the enterprise segment. Customer retention remained
steady at 94%, while new account acquisition slowed slightly due to
macroeconomic headwinds. The product team shipped three major features this
quarter: unified search, offline sync, and the new onboarding flow. Support
ticket volume decreased 8% month over month following the documentation
overhaul completed in August. Engineering velocity held constant with 42
merged pull requests, of which 6 were reverted for regressions caught in
staging before reaching production users this cycle.`;

await page.evaluate((text) => {
  const c = document.getElementById("c");
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#111111";
  ctx.font = "16px sans-serif";
  const words = text.split(/\s+/);
  let line = "";
  let y = 40;
  const maxWidth = c.width - 80;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth) {
      ctx.fillText(line, 40, y);
      line = w;
      y += 24;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, 40, y);
}, paragraph);

// --- Measurement 1: cold init + recognize (worst case, first frame ever
//     with a pre-bundled/pre-downloaded model already on local disk) ---
let coldResult;
try {
  coldResult = await page.evaluate(async (base) => {
    const t0 = performance.now();
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: `${base}/node_modules/tesseract.js/dist/worker.min.js`,
      corePath: `${base}/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js`,
      langPath: base,
      gzip: false,
      logger: (m) => console.log("[tesseract]", JSON.stringify(m)),
    });
    const t1 = performance.now();
    const { data } = await worker.recognize(document.getElementById("c"));
    const t2 = performance.now();
    await worker.terminate();
    return {
      initMs: t1 - t0,
      recognizeMs: t2 - t1,
      totalMs: t2 - t0,
      textLen: data.text.length,
      textSample: data.text.slice(0, 120),
    };
  }, base);
} catch (e) {
  coldResult = { error: e.message };
}
console.log("[spike] COLD (init+load model+recognize):", JSON.stringify(coldResult, null, 2));

// --- Measurement 2: warm recognize only (worker + model already resident,
//     simulating a long-lived offscreen document processing frame N>1) ---
let warmResult;
try {
  warmResult = await page.evaluate(async (base) => {
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: `${base}/node_modules/tesseract.js/dist/worker.min.js`,
      corePath: `${base}/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js`,
      langPath: base,
      gzip: false,
      logger: () => {},
    });
    await worker.recognize(document.getElementById("c")); // warm-up pass
    const t0 = performance.now();
    const { data } = await worker.recognize(document.getElementById("c"));
    const t1 = performance.now();
    await worker.terminate();
    return { recognizeMs: t1 - t0, textLen: data.text.length };
  }, base);
} catch (e) {
  warmResult = { error: e.message };
}
console.log("[spike] WARM (recognize only, model already resident):", JSON.stringify(warmResult, null, 2));

await browser.close();
server.close();
