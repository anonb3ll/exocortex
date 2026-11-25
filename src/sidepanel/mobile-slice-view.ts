import {
  type MobileFocusGlance,
  type MobileRecallResponse,
  type MobileFreshness,
  type MobileHealthStatus
} from "../lib/mobile-slice";

export interface MobileSliceViewElement {
  id?: string;
  textContent: string | null;
  innerHTML?: string;
  className?: string;
  hidden?: boolean | string;
  classList?: {
    add(...cls: string[]): void;
    remove(...cls: string[]): void;
    contains(cls: string): boolean;
  };
}

export interface MobileSliceViewDocument {
  getElementById(id: string): MobileSliceViewElement | null;
}

export const LIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function determineMobileFreshness(lastTimestampUtc?: number, now: number = Date.now()): MobileFreshness {
  if (!lastTimestampUtc || typeof lastTimestampUtc !== "number") {
    return "offline";
  }
  const age = Math.max(0, now - lastTimestampUtc);
  if (age <= LIVE_THRESHOLD_MS) {
    return "live";
  }
  if (age <= STALE_THRESHOLD_MS) {
    return "stale";
  }
  return "offline";
}

export function determineMobileHealth(freshness: MobileFreshness, hasError: boolean = false): MobileHealthStatus {
  if (hasError) {
    return freshness === "offline" ? "unavailable" : "degraded";
  }
  switch (freshness) {
    case "live":
      return "healthy";
    case "stale":
      return "degraded";
    case "offline":
    default:
      return "unavailable";
  }
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderMobileFocusGlance(documentRef: MobileSliceViewDocument, glance: MobileFocusGlance): void {
  const entityEl = documentRef.getElementById("mobile-focus-entity");
  const digestEl = documentRef.getElementById("mobile-state-digest");
  const categoryEl = documentRef.getElementById("mobile-intent-category");
  const loadEl = documentRef.getElementById("mobile-cognitive-load");
  const taskRefEl = documentRef.getElementById("mobile-task-ref");
  const originRefEl = documentRef.getElementById("mobile-origin-ref");
  const updatedEl = documentRef.getElementById("mobile-focus-updated");

  if (entityEl) entityEl.textContent = glance.focusEntity || "No active focus";
  if (digestEl) digestEl.textContent = glance.stateDigest || "No active working state captured";
  if (categoryEl) categoryEl.textContent = glance.intentCategory || "Idle / Transition";
  if (loadEl) loadEl.textContent = glance.cognitiveLoadLevel || "Low";
  if (originRefEl) originRefEl.textContent = glance.originRef || "0000000000000000";

  if (taskRefEl) {
    if (glance.suggestedTaskRef) {
      taskRefEl.textContent = glance.suggestedTaskRef;
      taskRefEl.hidden = false;
    } else {
      taskRefEl.textContent = "";
      taskRefEl.hidden = true;
    }
  }

  if (updatedEl) {
    if (glance.updatedAt && glance.updatedAt > 0) {
      const timeStr = new Date(glance.updatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      updatedEl.textContent = `Updated ${timeStr}`;
    } else {
      updatedEl.textContent = "Never updated";
    }
  }
}

export function renderMobileRecall(documentRef: MobileSliceViewDocument, response: MobileRecallResponse): void {
  const statusEl = documentRef.getElementById("mobile-recall-status");
  const listEl = documentRef.getElementById("mobile-recall-list");

  if (!listEl) return;

  switch (response.status) {
    case "ok": {
      if (statusEl) {
        statusEl.textContent = `${response.results.length} match${response.results.length === 1 ? "" : "es"} for "${response.query}"`;
      }
      listEl.innerHTML = response.results
        .map((item) => {
          const timeStr = new Date(item.parsedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          });
          return `
            <div class="mobile-recall-item" style="background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span class="mobile-handle" style="font-size: 10px; font-family: monospace; font-weight: 700; color: #38bdf8; background: #0f172a; padding: 2px 5px; border-radius: 3px;">${escapeHtml(item.handle)}</span>
                <span style="font-size: 9px; color: #64748b;">${timeStr} (score: ${item.score})</span>
              </div>
              <div class="mobile-title" style="font-size: 12px; font-weight: 600; color: #f8fafc; margin-bottom: 3px; word-break: break-word;">
                ${escapeHtml(item.title)}
              </div>
              ${
                item.excerpt
                  ? `<div class="mobile-excerpt" style="font-size: 11px; color: #cbd5e1; line-height: 1.35; word-break: break-word;">${escapeHtml(item.excerpt)}</div>`
                  : ""
              }
            </div>
          `;
        })
        .join("");
      break;
    }

    case "empty": {
      if (statusEl) {
        statusEl.textContent = "No matching mobile memory found.";
      }
      const querySnippet = response.query ? ` for query "${escapeHtml(response.query)}"` : "";
      listEl.innerHTML = `
        <div class="empty-state" style="background: #0f172a; border: 1px dashed #334155; border-radius: 6px; padding: 12px; text-align: center; color: #94a3b8; font-size: 11px;">
          No results${querySnippet}. Try another search term.
        </div>
      `;
      break;
    }

    case "privacy_blocked": {
      if (statusEl) {
        statusEl.textContent = "⚠️ Privacy Guard Block";
      }
      listEl.innerHTML = `
        <div class="privacy-blocked-state" style="background: #450a0a; border: 1px solid #b91c1c; border-radius: 6px; padding: 10px 12px; color: #fca5a5; font-size: 11px;">
          <div style="font-weight: 700; margin-bottom: 3px;">🛡️ Fail-Closed Privacy Shield</div>
          <div>${escapeHtml(response.errorMessage || "Search query matches privacy blocklist")}</div>
        </div>
      `;
      break;
    }

    case "error":
    default: {
      if (statusEl) {
        statusEl.textContent = "❌ Error retrieving mobile recall";
      }
      listEl.innerHTML = `
        <div class="error-state" style="background: #3b0764; border: 1px solid #9333ea; border-radius: 6px; padding: 10px 12px; color: #d8b4fe; font-size: 11px;">
          <div style="font-weight: 700; margin-bottom: 3px;">Service Error</div>
          <div>${escapeHtml(response.errorMessage || "Unknown error occurred while accessing mobile recall")}</div>
        </div>
      `;
      break;
    }
  }
}

export function renderMobileSliceView(
  documentRef: MobileSliceViewDocument,
  params: {
    focus: MobileFocusGlance;
    recall: MobileRecallResponse;
    freshness: MobileFreshness;
    health: MobileHealthStatus;
  }
): void {
  // Update Freshness Badge
  const freshnessEl = documentRef.getElementById("mobile-freshness-badge");
  if (freshnessEl) {
    freshnessEl.textContent = params.freshness.toUpperCase();
    freshnessEl.classList?.remove?.("freshness-live", "freshness-stale", "freshness-offline");
    freshnessEl.classList?.add?.(`freshness-${params.freshness}`);
  }

  // Update Health Badge
  const healthEl = documentRef.getElementById("mobile-health-badge");
  if (healthEl) {
    healthEl.textContent = params.health.toUpperCase();
    healthEl.classList?.remove?.("health-healthy", "health-degraded", "health-unavailable");
    healthEl.classList?.add?.(`health-${params.health}`);
  }

  // Render Focus Glance
  renderMobileFocusGlance(documentRef, params.focus);

  // Render Mobile Recall
  renderMobileRecall(documentRef, params.recall);
}
