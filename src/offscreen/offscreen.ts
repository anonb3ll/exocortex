// Offscreen Document: Local Transformers.js v3 Embedding Engine & Visual Frame Processing
// Spec Section 3.2 & Task #166
import { db } from "../lib/db";
import { embedWithFallback } from "../lib/models/webgpu-embedder";
import { computeFallbackVector } from "../lib/models/hash-fallback";
import type { EmbeddingSource } from "../lib/db";
import { extractOcrTextWithTimeout, shouldEmbedOcrText } from "./ocr";

console.log("[Exocortex Offscreen] Transformers.js v3 embedding worker initialized.");

async function getEmbedding(text: string): Promise<{ vector: number[]; source: EmbeddingSource }> {
  try {
    const result = await embedWithFallback(text);
    return { vector: result.vector, source: "model" };
  } catch (error) {
    console.warn("[Exocortex Offscreen] Transformers.js v3 embedding failed, using fallback vector:", error);
    return { vector: computeFallbackVector(text), source: "fallback" };
  }
}

/**
 * Downsamples dataUrl to 720p max width (1280px) and converts to WebP Blob
 */
async function processCanvasDownsample(dataUrl: string): Promise<{ blob: Blob | undefined; canvas: HTMLCanvasElement }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const maxWidth = 1280;
  let targetWidth = img.width;
  let targetHeight = img.height;

  if (targetWidth > maxWidth) {
    const scale = maxWidth / targetWidth;
    targetWidth = maxWidth;
    targetHeight = Math.round(targetHeight * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
  }

  const blob: Blob | undefined = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b || undefined), "image/webp", 0.8);
  });

  return { blob, canvas };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GENERATE_EMBEDDING" && message.payload) {
    const cleanedText = (message.payload.text || "").trim();

    (async () => {
      try {
        if (!cleanedText) {
          // A zero vector is not an embedding of anything — label it so no consumer
          // mistakes it for one.
          sendResponse({ status: "success", vector: new Array(384).fill(0), dimension: 384, source: "fallback" });
          return;
        }

        const { vector, source } = await getEmbedding(cleanedText);

        sendResponse({ status: "success", vector, dimension: 384, source });
      } catch (err) {
        console.error("[Exocortex Offscreen] Embedding error:", err);
        sendResponse({ status: "error", error: String(err) });
      }
    })();

    return true; // Keep channel open for async response
  }

  if (message.type === "PROCESS_VISUAL_FRAME" && message.payload) {
    const { frameId, dataUrl } = message.payload;
    (async () => {
      try {
        const { blob, canvas } = await processCanvasDownsample(dataUrl);
        const ocrText = await extractOcrTextWithTimeout(canvas, 3000);

        if (shouldEmbedOcrText(ocrText) && frameId) {
          const { vector, source } = await getEmbedding(ocrText);

          if (vector.length === 384) {
            await db.embeddings.put({
              frameId,
              vector: new Float32Array(vector),
              dimension: 384,
              createdAt: Date.now(),
              source
            });
          }
        }

        if (frameId) {
          await db.frame_visuals.put({
            frameId,
            thumbnailWebP: blob,
            ocrText: shouldEmbedOcrText(ocrText) ? ocrText : undefined
          });
          await db.frames.update(frameId, { hasVisualThumb: true });
        }

        sendResponse({ status: "success", frameId, ocrText });
      } catch (err) {
        console.error("[Exocortex Offscreen] Visual frame processing error:", err);
        sendResponse({ status: "error", error: String(err) });
      }
    })();

    return true;
  }
});
