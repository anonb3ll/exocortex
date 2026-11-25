export interface OcrImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

export interface OcrCanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): { getImageData(sx: number, sy: number, sw: number, sh: number): OcrImageData } | null;
}

/**
 * No real OCR engine is wired up yet, so no frame can yield text. The previous
 * dark-pixel heuristic returned a fixed placeholder string, which was then
 * embedded and stored as page text — every qualifying frame became the same
 * vector, polluting similarity search. Until an engine lands, extract nothing.
 */
export function extractOcrTextFromImageData(_imgData: OcrImageData): string {
  return "";
}

export function shouldEmbedOcrText(ocrText: string): boolean {
  return ocrText.trim().length > 0;
}

export async function extractOcrTextWithTimeout(
  canvas: OcrCanvasLike,
  timeoutMs: number = 3000
): Promise<string> {
  const ocrPromise = (async () => {
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      return extractOcrTextFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } catch {
      return "";
    }
  })();

  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(""), timeoutMs);
  });

  return Promise.race([ocrPromise, timeoutPromise]);
}
