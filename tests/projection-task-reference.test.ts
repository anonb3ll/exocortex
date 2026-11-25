import { describe, expect, test } from "bun:test";
import { projectFocusAnchor, projectTaskReference } from "../src/lib/projection/contract-v1";

const OPTIONS = {
  originMachine: "desktop",
  originSurface: "browser" as const,
  trustTier: "local" as const,
  consentBasis: "explicit_user_action" as const,
  projectedAt: 1754524801000
};

describe("task-reference projection", () => {
  test("derives the v1 task edge without leaking browsing context", async () => {
    const anchor = await projectFocusAnchor(
      {
        activeFocusEntity: "Extension overlay",
        workingStateSummary: "Implementing https://private.example/page",
        intentCategory: "Deep Work (Drafting/Coding)",
        cognitiveLoadLevel: "High",
        timestampUtc: 1754524800000,
        url: "https://private.example/page"
      },
      OPTIONS
    );
    const record = projectTaskReference(anchor, 279, 0.87654);

    expect(record.kind).toBe("task_reference");
    expect(record.payload).toEqual({
      task_ref: "ua://task/279",
      relation: "suggested_by_focus",
      confidence: 0.8765,
      focus_entity: "Extension overlay"
    });
    expect(JSON.stringify(record)).not.toContain("private.example");
    expect(Object.keys(record.payload).sort()).toEqual(["confidence", "focus_entity", "relation", "task_ref"]);
  });

  test("fails closed for invalid task ids and confidence", async () => {
    const anchor = await projectFocusAnchor(
      {
        activeFocusEntity: "Extension overlay",
        workingStateSummary: "",
        intentCategory: "Deep Work (Drafting/Coding)",
        cognitiveLoadLevel: "High",
        timestampUtc: 1,
        url: "https://example.test"
      },
      OPTIONS
    );
    expect(() => projectTaskReference(anchor, 0, 0.5)).toThrow();
    expect(() => projectTaskReference(anchor, 279, 1.1)).toThrow();
  });
});
