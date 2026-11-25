import { describe, expect, test } from "bun:test";
import {
  getFocusShieldContextPrompt,
  renderFocusShieldContext,
  requestFocusShieldContext
} from "../src/sidepanel/focus-shield-context";

describe("Focus Shield side-panel context flow", () => {
  test("requests the latest context and renders a successful response", () => {
    const messages: { type: string }[] = [];
    const elements = new Map([
      ["focus-shield-context-panel", { hidden: true, textContent: null }],
      ["focus-shield-context-prompt", { hidden: false, textContent: null }]
    ]);
    const documentRef = { getElementById: (id: string) => elements.get(id) ?? null };

    requestFocusShieldContext((message, callback) => {
      messages.push(message);
      callback({ status: "success", prompt: "Resume the draft from the checkpoint." });
    }, (response) => renderFocusShieldContext(documentRef, response));

    expect(messages).toEqual([{ type: "GET_FOCUS_SHIELD_CONTEXT" }]);
    expect(elements.get("focus-shield-context-panel")).toEqual({ hidden: false, textContent: null });
    expect(elements.get("focus-shield-context-prompt")?.textContent).toBe("Resume the draft from the checkpoint.");
  });

  test("does not render errors or empty prompts", () => {
    const panel = { hidden: true, textContent: null };
    const prompt = { hidden: false, textContent: null };
    const documentRef = { getElementById: (id: string) => id.includes("panel") ? panel : prompt };

    expect(getFocusShieldContextPrompt({ status: "error", prompt: "secret" })).toBeNull();
    expect(renderFocusShieldContext(documentRef, { status: "success", prompt: "" })).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(prompt.textContent).toBeNull();
  });
});
