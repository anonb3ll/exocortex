import { describe, expect, test } from "bun:test";
import { computeFallbackVector } from "../src/lib/models/hash-fallback";

describe("hash fallback", () => {
  test("returns a deterministic normalized vector with the requested dimension", () => {
    const vector = computeFallbackVector("Synthetic browser context", 8);
    expect(vector).toHaveLength(8);
    expect(vector).toEqual(computeFallbackVector("Synthetic browser context", 8));
    expect(Math.hypot(...vector)).toBeCloseTo(1, 8);
  });

  test("returns zeros for empty text", () => {
    expect(computeFallbackVector("", 4)).toEqual([0, 0, 0, 0]);
  });
});
