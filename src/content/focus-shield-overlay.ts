import { isUrlBlocked } from "./privacy";

const OVERLAY_ID = "exocortex-focus-shield-overlay";

type FocusShieldMessage = {
  type: "FOCUS_SHIELD_SHOW" | "FOCUS_SHIELD_HIDE" | "FOCUS_SHIELD_PARK_RESULT";
  intervention?: { reason?: string; fatigueScore?: number };
  parkedCount?: number;
};

let overlay: HTMLElement | null = null;
let overlayRoot: ShadowRoot | null = null;

function sendAction(type: string): void {
  chrome.runtime.sendMessage({ type }, () => {
    // The service worker may be asleep or the page may be navigating. The overlay
    // is best-effort UI and must never surface an unchecked runtime error.
    void chrome.runtime.lastError;
  });
}

function renderMessage(message: FocusShieldMessage): void {
  if (!overlayRoot) return;
  const root = overlayRoot;
  const body = root.querySelector<HTMLElement>("[data-exocortex-body]");
  if (!body) return;
  if (message.parkedCount !== undefined) {
    root.querySelector<HTMLElement>("[data-exocortex-status]")?.replaceChildren(
      document.createTextNode(`${message.parkedCount} distraction tab${message.parkedCount === 1 ? "" : "s"} parked.`)
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hideOverlay(): void {
  sendAction("FOCUS_SHIELD_DISMISS");
  overlay?.remove();
  overlay = null;
  overlayRoot = null;
}

function showOverlay(intervention: FocusShieldMessage["intervention"]): void {
  if (isUrlBlocked(window.location.href)) return;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.all = "initial";
    // Keep page-facing chrome isolated. Restored context is rendered only in the
    // extension-owned side panel, never in a page-accessible shadow root.
    const shadow = overlay.attachShadow({ mode: "closed" });
    overlayRoot = shadow;
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; width: min(360px, calc(100vw - 40px)); box-sizing: border-box; padding: 18px; border: 1px solid #818cf8; border-radius: 14px; background: #111827; color: #f8fafc; box-shadow: 0 18px 50px rgba(15,23,42,.35); font: 14px/1.45 system-ui, sans-serif; }
        h2 { margin: 0 0 6px; color: #a5b4fc; font-size: 15px; } p { margin: 8px 0 14px; color: #cbd5e1; } button { border: 0; border-radius: 7px; padding: 8px 10px; margin: 3px 3px 0 0; cursor: pointer; font: inherit; color: #0f172a; background: #c7d2fe; } button.secondary { color: #e0e7ff; background: #3730a3; } button.dismiss { color: #cbd5e1; background: #334155; }
      </style>
      <section class="card" role="dialog" aria-labelledby="title" aria-live="polite">
        <h2 id="title">Focus Shield</h2>
        <p data-exocortex-reason>${escapeHtml(intervention?.reason || "Your recent activity indicates cognitive fatigue.")}</p>
        <p data-exocortex-score>Fatigue score: ${intervention?.fatigueScore ?? "—"}</p>
        <p data-exocortex-status></p>
        <div data-exocortex-body>
          <button data-action="restore">Restore context</button>
          <button data-action="park" class="secondary">Park distraction tabs</button>
          <button data-action="dismiss" class="dismiss">Keep working</button>
        </div>
      </section>`;
    document.documentElement.appendChild(overlay);
    shadow.querySelector<HTMLButtonElement>("[data-action=restore]")?.addEventListener("click", () => sendAction("FOCUS_SHIELD_OPEN_CONTEXT"));
    shadow.querySelector<HTMLButtonElement>("[data-action=park]")?.addEventListener("click", () => sendAction("FOCUS_SHIELD_PARK_TABS"));
    shadow.querySelector<HTMLButtonElement>("[data-action=dismiss]")?.addEventListener("click", hideOverlay);
  }
}

if (!isUrlBlocked(window.location.href)) {
  chrome.runtime.onMessage.addListener((message: FocusShieldMessage) => {
    if (message.type === "FOCUS_SHIELD_SHOW") showOverlay(message.intervention);
    if (message.type === "FOCUS_SHIELD_HIDE") hideOverlay();
    if (message.parkedCount !== undefined) renderMessage(message);
  });
}
