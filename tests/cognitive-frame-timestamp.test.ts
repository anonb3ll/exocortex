import { describe, expect, test } from "bun:test";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";

describe("createCognitiveFrame activity timestamp", () => {
  test("uses an explicit capture timestamp instead of wall-clock completion time", () => {
    const capturedAt = 1_700_000_000_000;
    const frame = createCognitiveFrame({
      sessionId: "session_test",
      url: "https://example.com/docs",
      pageTitle: "Example Docs",
      activeDwellSeconds: 8,
      cleanTextExcerpt: "notes about the example",
      timestampUtc: capturedAt
    });
    expect(frame.timestampUtc).toBe(capturedAt);
  });

  test("defaults to now when no capture timestamp is supplied", () => {
    const before = Date.now();
    const frame = createCognitiveFrame({
      sessionId: "session_test",
      url: "https://example.com/now",
      pageTitle: "Now",
      activeDwellSeconds: 5
    });
    const after = Date.now();
    expect(frame.timestampUtc).toBeGreaterThanOrEqual(before);
    expect(frame.timestampUtc).toBeLessThanOrEqual(after);
  });
});
