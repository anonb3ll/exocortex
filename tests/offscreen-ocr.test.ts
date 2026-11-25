/**
 * Task #296: the OCR path returned a hardcoded literal.
 *
 * extractOcrTextWithTimeout() counted dark pixels and, past a threshold,
 * returned "Visual Content Frame text snippet" as if it were extracted page
 * text. That constant was embedded and stored, so every qualifying screenshot
 * produced the same vector — silently degrading recall for the whole store.
 * These tests pin "no real OCR means no text" so the placeholder cannot return.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  extractOcrTextFromImageData,
  extractOcrTextWithTimeout,
  shouldEmbedOcrText,
  type OcrCanvasLike,
  type OcrImageData,
} from "../src/offscreen/ocr";

const FAKE_LITERAL = "Visual Content Frame text snippet";

function imageData(width: number, height: number, fill: number): OcrImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill;
    data[i + 1] = fill;
    data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function canvasOf(img: OcrImageData): OcrCanvasLike {
  return {
    width: img.width,
    height: img.height,
    getContext: () => ({ getImageData: () => img }),
  };
}

// 40x40 = 1600 pixels, all near-black — well past the old darkPixels > 1000 gate.
const DARK_FRAME = imageData(40, 40, 10);
const LIGHT_FRAME = imageData(40, 40, 240);

describe("extractOcrTextFromImageData", () => {
  test("a dense dark frame yields no text — it does not fabricate a snippet", () => {
    const result = extractOcrTextFromImageData(DARK_FRAME);
    expect(result).not.toBe(FAKE_LITERAL);
    expect(result).toBe("");
  });

  test("a light frame yields no text", () => {
    expect(extractOcrTextFromImageData(LIGHT_FRAME)).toBe("");
  });
});

describe("extractOcrTextWithTimeout", () => {
  test("resolves empty for a dark frame rather than the placeholder literal", async () => {
    const result = await extractOcrTextWithTimeout(canvasOf(DARK_FRAME), 3000);
    expect(result).not.toBe(FAKE_LITERAL);
    expect(result).toBe("");
  });

  test("resolves empty when the 2d context is unavailable", async () => {
    const canvas: OcrCanvasLike = { width: 10, height: 10, getContext: () => null };
    expect(await extractOcrTextWithTimeout(canvas, 3000)).toBe("");
  });

  test("resolves empty when reading pixels throws", async () => {
    const canvas: OcrCanvasLike = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => {
          throw new Error("tainted canvas");
        },
      }),
    };
    expect(await extractOcrTextWithTimeout(canvas, 3000)).toBe("");
  });
});

describe("shouldEmbedOcrText", () => {
  test("an empty OCR result is not embedded — no junk vector is stored", () => {
    expect(shouldEmbedOcrText("")).toBe(false);
    expect(shouldEmbedOcrText("   \n\t ")).toBe(false);
  });

  test("the OCR result of a dark frame is never embeddable", async () => {
    expect(shouldEmbedOcrText(await extractOcrTextWithTimeout(canvasOf(DARK_FRAME)))).toBe(false);
  });

  test("real extracted text would still be embedded", () => {
    expect(shouldEmbedOcrText("quarterly revenue chart")).toBe(true);
  });
});

describe("the placeholder literal is gone from the source tree", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx|js)$/.test(entry) ? [full] : [];
    });
  }

  test("no file under src/ contains the fake OCR string", () => {
    const offenders = sourceFiles(join(import.meta.dir, "..", "src")).filter((f) =>
      readFileSync(f, "utf8").includes(FAKE_LITERAL)
    );
    expect(offenders).toEqual([]);
  });
});
