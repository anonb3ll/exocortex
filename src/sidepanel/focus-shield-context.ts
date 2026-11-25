export interface FocusShieldContextResponse {
  status?: unknown;
  prompt?: unknown;
}

export interface FocusShieldContextDocument {
  getElementById(id: string): {
    hidden: boolean | string;
    textContent: string | null;
  } | null;
}

export function getFocusShieldContextPrompt(response: FocusShieldContextResponse | null | undefined): string | null {
  return response?.status === "success" && typeof response.prompt === "string" && response.prompt.length > 0
    ? response.prompt
    : null;
}

export function renderFocusShieldContext(
  documentRef: FocusShieldContextDocument,
  response: FocusShieldContextResponse | null | undefined
): boolean {
  const promptText = getFocusShieldContextPrompt(response);
  if (!promptText) return false;

  const panel = documentRef.getElementById("focus-shield-context-panel");
  const prompt = documentRef.getElementById("focus-shield-context-prompt");
  if (!panel || !prompt) return false;

  prompt.textContent = promptText;
  panel.hidden = false;
  return true;
}

export type SendFocusShieldMessage = (
  message: { type: "GET_FOCUS_SHIELD_CONTEXT" },
  callback: (response: FocusShieldContextResponse | undefined) => void
) => void;

export function requestFocusShieldContext(
  sendMessage: SendFocusShieldMessage,
  render: (response: FocusShieldContextResponse | undefined) => boolean
): void {
  sendMessage({ type: "GET_FOCUS_SHIELD_CONTEXT" }, (response) => {
    render(response);
  });
}
