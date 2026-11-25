import { recallLatestContext } from "../lib/context-workflow";

async function renderWhereWasI() {
  const container = document.getElementById("quick-context");
  if (!container) return;

  try {
    const context = await recallLatestContext();

    if (!context) {
      container.innerHTML = `<p class="empty-state">No recent activity recorded. Browse pages for &gt;5s to capture context.</p>`;
      return;
    }

    const timeAgo = formatTimeAgo(context.capturedAt);

    container.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(context.title)}</div>
        <div class="card-meta">
          <span>${timeAgo}</span> • <span>Dwell: ${context.dwellSeconds}s</span>
        </div>
        <div class="card-excerpt">${escapeHtml(context.excerpt)}</div>
        <div style="margin-top: 10px;">
          <a class="link" href="${escapeHtml(context.resumeAction.url)}" target="_blank" rel="noopener">${context.resumeAction.label} ↗</a>
        </div>
      </div>
    `;
  } catch (err) {
    console.error("[Exocortex Popup] Error loading context:", err);
    container.innerHTML = `<p class="empty-state">Failed to load recent context.</p>`;
  }
}

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setupSidePanelButton(): void {
  const btn = document.getElementById("open-sidepanel-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId !== undefined && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        if (tab.id !== undefined) {
          await chrome.runtime.sendMessage({ type: "FOCUS_SHIELD_CONTEXT_REFRESH", tabId: tab.id }).catch(() => undefined);
        }
        window.close();
      }
    } catch (err) {
      console.error("[Exocortex Popup] Failed to open side panel:", err);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderWhereWasI();
  setupSidePanelButton();
});
