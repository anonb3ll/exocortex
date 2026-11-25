import { describe, expect, test } from "bun:test";
import { stateObserver } from "../src/lib/agents/state-observer";
import { db } from "../src/lib/db";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";

describe("Task #214 / Option B Telemetry Sync Privacy Boundaries", () => {
  test("getSanitizedTelemetryExport returns sanitized telemetry without leaking DOM or page text", async () => {
    // Seed a frame with sensitive DOM and page text content
    const frame = createCognitiveFrame({
      sessionId: "session_privacy_test_123",
      url: "https://banking.example.com/account/details?token=secret123",
      pageTitle: "Private Account Overview",
      activeDwellSeconds: 120,
      cleanTextExcerpt: "CONFIDENTIAL BALANCE: $1,000,000. Account owner: Anthony.",
      userActions: ["click_transfer", "input_password"]
    });
    frame.userState.intentCategory = "Deep Work (Drafting/Coding)";
    frame.userState.primaryFocusEntity = "Secret Financial Project";

    await db.cognitive_frames.put(frame);

    const exported = await stateObserver.getSanitizedTelemetryExport("test-laptop");

    // Assert required telemetry fields are present
    expect(exported.sanitized).toBe(true);
    expect(exported.sourceDevice).toBe("test-laptop");
    expect(typeof exported.cognitiveLoadScore).toBe("number");
    expect(typeof exported.fatigueIndex).toBe("number");
    expect(typeof exported.contextSwitchCost).toBe("number");
    expect(exported.intentCategory).toBe("Deep Work (Drafting/Coding)");

    // Privacy assertion: verify sensitive properties are NOT present in the exported object
    const exportedKeys = Object.keys(exported);
    expect(exportedKeys).not.toContain("url");
    expect(exportedKeys).not.toContain("pageTitle");
    expect(exportedKeys).not.toContain("cleanTextExcerpt");
    expect(exportedKeys).not.toContain("userActions");
    expect(exportedKeys).not.toContain("workingStateSummary");
    expect(exportedKeys).not.toContain("activeFrame");

    // Verify string serialization contains zero secret/text fragments
    const jsonStr = JSON.stringify(exported);
    expect(jsonStr).not.toContain("CONFIDENTIAL");
    expect(jsonStr).not.toContain("Secret Financial Project");
    expect(jsonStr).not.toContain("banking.example.com");
  });
});
