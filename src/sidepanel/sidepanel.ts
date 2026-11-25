import { db, type CognitiveStateFrame, type DwellBlockRecord, type FrameRecord, type PageTextRecord, type WorkingMemoryItem, type SemanticVaultRecord } from "../lib/db";
import {
  renderFocusShieldContext,
  requestFocusShieldContext as requestFocusShieldContextFlow,
  type FocusShieldContextResponse
} from "./focus-shield-context";
import {
  projectMobileFocusGlance,
  searchMobileMemoryPure,
  type PageRecordLike
} from "../lib/mobile-slice";
import {
  determineMobileFreshness,
  determineMobileHealth,
  renderMobileSliceView
} from "./mobile-slice-view";
import type { FocusAnchorSource } from "../lib/projection/contract-v1";
import {
  requestPanelEmbedding,
  searchPanelMemory,
  type PanelSemanticSearchResult,
} from "./semantic-search";
import { hybridVectorSearch, type VectorSearchResult } from "../lib/models/vector-search";
import { formatRecallTime } from "./format-time";
import { appendResultCards, describeResultSourceAndDwell } from "./result-cards";
import { applyRetentionDays, loadRetentionSetting, RETENTION_STORAGE_KEY } from "../lib/retention-setting";
import {
  chromeNativeSend,
  describeOmacortexStatus,
  OMACORTEX_FEED_STORAGE_KEY,
  probeOmacortexStatus
} from "../lib/omacortex-feed";

let cognitiveFrames: CognitiveStateFrame[] = [];
let allDwellBlocks: DwellBlockRecord[] = [];
let pageTextMap: Map<string, PageTextRecord> = new Map();
let allPageTextsList: PageTextRecord[] = [];
let workingMemoryStack: WorkingMemoryItem[] = [];
let semanticVaultItems: SemanticVaultRecord[] = [];
/** `frames` rows by visit (capture time + URL): where page metadata and real dwell live. */
let frameRecordsByVisit: Map<string, FrameRecord> = new Map();

function visitLookupKey(timestamp: number, url: string): string {
  return `${timestamp}|${url}`;
}

/**
 * "YouTube · Fireship · video · 12 min" for a timeline row.
 *
 * A cognitive frame has no site, author or kind of its own; the `frames` row
 * written for the same visit does. Rows from before that metadata existed fall
 * back to the hostname and the dwell recorded on the frame itself.
 */
function describeVisit(url: string, timestamp: number, fallbackDwellSeconds?: number): string {
  const record = frameRecordsByVisit.get(visitLookupKey(timestamp, url));
  return describeResultSourceAndDwell({
    url,
    siteName: record?.siteName,
    domain: record?.domain,
    byline: record?.byline,
    contentKind: record?.contentKind,
    dwellTime: record?.dwellTime ?? fallbackDwellSeconds
  });
}

/**
 * Fills the `.item-source` placeholders the timeline templates leave empty.
 * The text comes from captured pages, so it is assigned as text after the
 * markup is in place rather than interpolated into it.
 */
function fillVisitSources(container: HTMLElement, sources: string[]): void {
  container.querySelectorAll<HTMLElement>("[data-source-index]").forEach((node) => {
    const index = Number(node.dataset.sourceIndex);
    node.textContent = sources[index] ?? "";
  });
}

if (typeof window !== "undefined") {
  (window as unknown as { __exocortex_db: typeof db }).__exocortex_db = db;
}

async function loadTimeline() {
  const timelineContainer = document.getElementById("timeline");
  if (!timelineContainer) return;

  try {
    cognitiveFrames = await db.cognitive_frames.orderBy("timestampUtc").reverse().limit(30).toArray();
    allDwellBlocks = await db.dwell_blocks.orderBy("timestamp").reverse().toArray();
    workingMemoryStack = await db.working_memory_stack.orderBy("lastUpdatedUtc").reverse().limit(5).toArray();
    semanticVaultItems = await db.semantic_vault.orderBy("timestampUtc").reverse().limit(5).toArray();
    const recentFrameRecords = await db.frames.orderBy("timestamp").reverse().limit(200).toArray();
    frameRecordsByVisit = new Map(recentFrameRecords.map((f) => [visitLookupKey(f.timestamp, f.url), f]));

    const allPageTexts = await db.page_text.toArray();
    allPageTextsList = allPageTexts;
    pageTextMap.clear();
    allPageTexts.forEach((pt) => pageTextMap.set(pt.url, pt));

    renderTelemetry();
    renderWorkingMemoryStack();
    renderSemanticVault();
    renderTimeline();
    await renderMobileSliceProjection();

    // Query live telemetry from background worker if chrome runtime is present
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "GET_FOCUS_SHIELD_CONFIG" }, (response) => {
        const toggle = document.getElementById("focus-shield-toggle") as HTMLInputElement | null;
        if (toggle && response?.status === "success") toggle.checked = response.config?.enabled === true;
      });
      chrome.runtime.sendMessage({ type: "GET_TELEMETRY" }, (response) => {
        if (response && response.status === "success") {
          if (response.telemetry?.currentMetrics) {
            updateTelemetryMeters(response.telemetry.currentMetrics);
          }
          if (response.nudge && response.nudge.type !== "None") {
            renderNudgeBanner(response.nudge);
          }
        }
      });
      requestFocusShieldContext();
    }
  } catch (err) {
    console.error("[Exocortex Sidepanel] Error loading cognitive timeline:", err);
    timelineContainer.innerHTML = `<p class="empty">Error loading cognitive state history.</p>`;
  }
}

function updateTelemetryMeters(metrics: { cognitiveLoadScore: number; fatigueIndex: number; contextSwitchCost: number }) {
  const switchCostEl = document.getElementById("telemetry-switch-cost");
  const loadValEl = document.getElementById("load-score-val");
  const loadBarEl = document.getElementById("load-score-bar");
  const fatigueValEl = document.getElementById("fatigue-val");
  const fatigueBarEl = document.getElementById("fatigue-bar");

  if (switchCostEl) switchCostEl.textContent = `${metrics.contextSwitchCost}s switch penalty`;
  if (loadValEl) loadValEl.textContent = metrics.cognitiveLoadScore.toFixed(2);
  if (loadBarEl) loadBarEl.style.width = `${Math.min(100, metrics.cognitiveLoadScore * 100)}%`;
  if (fatigueValEl) fatigueValEl.textContent = `${metrics.fatigueIndex} / 100`;
  if (fatigueBarEl) fatigueBarEl.style.width = `${Math.min(100, metrics.fatigueIndex)}%`;
}

function renderTelemetry() {
  if (cognitiveFrames.length > 0) {
    const latest = cognitiveFrames[0];
    updateTelemetryMeters({
      cognitiveLoadScore: latest.userState.cognitiveLoadScore ?? 0.5,
      fatigueIndex: latest.userState.fatigueIndex ?? 10,
      contextSwitchCost: latest.userState.contextSwitchCost ?? 0
    });
  }
}

function requestFocusShieldContext(): void {
  requestFocusShieldContextFlow(chrome.runtime.sendMessage, (response: FocusShieldContextResponse | undefined) =>
    renderFocusShieldContext(document, response)
  );
}

function renderNudgeBanner(nudge: { type: string; message: string; actionableCTA?: string; targetFocusEntity?: string }) {
  const banner = document.getElementById("nudge-banner");
  const msgEl = document.getElementById("nudge-message");
  const btn = document.getElementById("nudge-action-btn");

  if (!banner || !msgEl || !btn) return;

  if (nudge && nudge.message) {
    banner.style.display = "block";
    msgEl.textContent = nudge.message;
    if (nudge.actionableCTA) {
      btn.style.display = "inline-block";
      btn.textContent = nudge.actionableCTA;
    } else {
      btn.style.display = "none";
    }
  } else {
    banner.style.display = "none";
  }
}

function renderWorkingMemoryStack() {
  const container = document.getElementById("working-memory-stack-list");
  if (!container) return;

  if (workingMemoryStack.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: #64748b; margin: 0;">No saved goal checkpoints.</p>`;
    return;
  }

  container.innerHTML = workingMemoryStack
    .map(
      (item) => `
    <div style="background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-size: 12px; font-weight: 600; color: #f8fafc;">${escapeHtml(item.activeGoal)}</div>
        <div style="font-size: 10px; color: #94a3b8;">Updated ${escapeHtml(formatRecallTime(item.lastUpdatedUtc))}</div>
      </div>
      <button class="restore-btn" data-goal="${escapeHtml(item.activeGoal)}" style="padding: 4px 8px; background: #38bdf8; color: #0f172a; border: none; border-radius: 4px; font-weight: 600; font-size: 10px; cursor: pointer;">
        Resume
      </button>
    </div>
  `
    )
    .join("");
}

function renderSemanticVault() {
  const container = document.getElementById("semantic-vault-list");
  if (!container) return;

  if (semanticVaultItems.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: #64748b; margin: 0;">No historical snippets indexed yet.</p>`;
    return;
  }

  container.innerHTML = semanticVaultItems
    .map(
      (item) => `
    <div style="background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
        <span style="font-size: 10px; font-weight: 600; color: #38bdf8;">${escapeHtml(item.primaryFocusEntity)}</span>
        <span style="font-size: 10px; color: #64748b;">${escapeHtml(formatRecallTime(item.timestampUtc))}</span>
      </div>
      <div style="font-size: 12px; font-weight: 600; color: #f8fafc; margin-bottom: 4px;">
        <a class="item-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
      </div>
      ${item.excerpt ? `<div style="font-size: 11px; color: #cbd5e1; line-height: 1.3;">${escapeHtml(item.excerpt.substring(0, 100))}...</div>` : ""}
    </div>
  `
    )
    .join("");
}

function renderTimeline() {
  const container = document.getElementById("timeline");
  const searchInput = document.getElementById("search-input") as HTMLInputElement;

  if (!container) return;

  const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

  // Render Cognitive State Cards if frames exist
  if (cognitiveFrames.length > 0) {
    const activeFrame = cognitiveFrames[0];
    const precedingFrames = cognitiveFrames.slice(1);

    const filteredPreceding = precedingFrames.filter((frame) => {
      if (!query) return true;
      const titleMatch = (frame.provenance.pageTitle || "").toLowerCase().includes(query);
      const focusMatch = (frame.userState.primaryFocusEntity || "").toLowerCase().includes(query);
      const summaryMatch = (frame.userState.workingStateSummary || "").toLowerCase().includes(query);
      const categoryMatch = (frame.userState.intentCategory || "").toLowerCase().includes(query);
      return titleMatch || focusMatch || summaryMatch || categoryMatch;
    });

    const visitSources = [activeFrame, ...filteredPreceding].map((frame) =>
      describeVisit(frame.provenance.url, frame.timestampUtc, frame.provenance.activeDwellSeconds)
    );

    container.innerHTML = `
      <!-- ACTIVE FOCUS ANCHOR HERO CARD -->
      <section style="background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 700;">
          🎯 Active Focus Anchor
        </div>
        <h3 style="margin: 6px 0 2px 0; font-size: 15px; color: #0f172a; font-weight: 700;">
          ${escapeHtml(activeFrame.userState.primaryFocusEntity)}
        </h3>
        <div style="font-size: 11px; color: #2563eb; font-weight: 600; margin-bottom: 4px;">
          ${escapeHtml(activeFrame.userState.intentCategory)}
        </div>
        <p style="margin: 0 0 4px 0; font-size: 12px; color: #475569;">
          ${escapeHtml(activeFrame.userState.workingStateSummary)}
        </p>
        <div style="font-size: 11px; color: #64748b; margin: 0 0 10px 0;">
          <span>${escapeHtml(formatRecallTime(activeFrame.timestampUtc))}</span> • <span class="item-source" data-source-index="0"></span>
        </div>
        <button class="restore-btn" data-url="${escapeHtml(activeFrame.provenance.url)}" style="width: 100%; padding: 8px 12px; background: #2563eb; color: #ffffff; border: none; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer;">
          Resume Focus State
        </button>
      </section>

      <!-- PRECEDING THOUGHT UNITS FEED -->
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 700; margin-bottom: 8px;">
        Preceding Thought Units
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${
          filteredPreceding.length === 0
            ? `<p class="empty">No matching cognitive frames found.</p>`
            : filteredPreceding
                .map((frame, index) => {
                  const timeStr = escapeHtml(formatRecallTime(frame.timestampUtc));
                  return `
                  <div class="timeline-item" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px;">
                    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-bottom: 2px;">
                      <span style="color: #2563eb; font-weight: 600;">${escapeHtml(frame.userState.intentCategory)}</span>
                      <span>${timeStr}</span>
                    </div>
                    <div style="font-size: 13px; font-weight: 600; color: #1e293b;">
                      ${escapeHtml(frame.userState.primaryFocusEntity)}
                    </div>
                    <div style="font-size: 11px; color: #475569; margin: 2px 0 2px 0;">
                      <a class="item-link" href="${escapeHtml(frame.provenance.url)}" target="_blank" rel="noopener">${escapeHtml(frame.provenance.pageTitle)}</a>
                    </div>
                    <div class="item-source" data-source-index="${index + 1}" style="font-size: 10px; color: #64748b; margin: 0 0 6px 0;"></div>
                    <button class="restore-btn" data-url="${escapeHtml(frame.provenance.url)}" style="padding: 4px 8px; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 11px; cursor: pointer;">
                      Reopen Tab
                    </button>
                  </div>
                `;
                })
                .join("")
        }
      </div>
    `;
    fillVisitSources(container, visitSources);
    return;
  }

  // Fallback to Raw Dwell Blocks if cognitive frames are empty
  const filteredBlocks = allDwellBlocks.filter((block) => {
    if (!query) return true;
    const pageText = pageTextMap.get(block.url);
    const titleMatch = (block.title || "").toLowerCase().includes(query);
    const urlMatch = (block.url || "").toLowerCase().includes(query);
    const textMatch = (pageText?.textContent || "").toLowerCase().includes(query);
    return titleMatch || urlMatch || textMatch;
  });

  if (filteredBlocks.length === 0) {
    container.innerHTML = `<p class="empty">${
      allDwellBlocks.length === 0 ? "No activity captured yet. Dwell on a page for &gt;5s." : "No matching footprint found."
    }</p>`;
    return;
  }

  const blockSources = filteredBlocks.map((block) =>
    describeVisit(block.url, block.timestamp, Math.round((block.dwellTime || 0) / 1000))
  );

  container.innerHTML = filteredBlocks
    .map((block, index) => {
      const pageText = pageTextMap.get(block.url);
      const title = block.title || pageText?.title || "Untitled Page";
      const excerpt = pageText?.excerpt || (pageText?.textContent ? pageText.textContent.substring(0, 120) + "..." : "");
      const timeStr = escapeHtml(formatRecallTime(block.timestamp));

      return `
        <div class="timeline-item">
          <div class="item-title">
            <a class="item-link" href="${escapeHtml(block.url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
          </div>
          <div class="item-meta">
            <span>${timeStr}</span> • <span class="item-source" data-source-index="${index}"></span> • <button class="restore-btn" data-url="${escapeHtml(block.url)}">Reopen Tab</button>
          </div>
          ${excerpt ? `<div class="item-excerpt">${escapeHtml(excerpt)}</div>` : ""}
        </div>
      `;
    })
    .join("");
  fillVisitSources(container, blockSources);
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeIntentCategory(cat?: string): string {
  if (!cat) return "Idle / Transition";
  if (cat.includes("Deep Work") || cat.includes("Coding") || cat.includes("Drafting")) {
    return "Deep Work (Drafting/Coding)";
  }
  if (cat.includes("Research") || cat.includes("Gathering") || cat.includes("Browsing")) {
    return "Research & Gathering";
  }
  if (cat.includes("Task") || cat.includes("Ops") || cat.includes("Execution")) {
    return "Task Execution & Ops";
  }
  if (cat.includes("Communication") || cat.includes("Async") || cat.includes("Chat")) {
    return "Communication & Async";
  }
  if (cat.includes("Distraction") || cat.includes("Rabbit")) {
    return "Distraction / Rabbit Hole";
  }
  return "Idle / Transition";
}

function normalizeCognitiveLoad(level?: string): "Low" | "Medium" | "High" | "Overload" {
  if (level === "Medium" || level === "High" || level === "Overload") return level;
  return "Low";
}

async function renderMobileSliceProjection() {
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  const query = searchInput ? searchInput.value.trim() : "";

  let focusSource: FocusAnchorSource | null = null;
  let sourceTimestamp: number | undefined = undefined;

  const latestFrame = cognitiveFrames.length > 0 ? cognitiveFrames[0] : null;
  const latestBlock = allDwellBlocks.length > 0 ? allDwellBlocks[0] : null;

  // Both clocks are activity/capture time (dwell.timestamp and frame.timestampUtc
  // from the originating dwell). Prefer whichever source is newer.
  if (latestFrame && (!latestBlock || latestFrame.timestampUtc >= latestBlock.timestamp)) {
    sourceTimestamp = latestFrame.timestampUtc;
    focusSource = {
      activeFocusEntity: latestFrame.userState.primaryFocusEntity,
      workingStateSummary: latestFrame.userState.workingStateSummary,
      intentCategory: normalizeIntentCategory(latestFrame.userState.intentCategory),
      cognitiveLoadLevel: normalizeCognitiveLoad(
        latestFrame.userState.cognitiveLoadLevel ||
        ((latestFrame.userState.cognitiveLoadScore ?? 0) > 0.7
          ? "High"
          : (latestFrame.userState.cognitiveLoadScore ?? 0) > 0.3
            ? "Medium"
            : "Low")
      ),
      timestampUtc: latestFrame.timestampUtc,
      url: latestFrame.provenance.url
    };
  } else if (latestBlock) {
    const pageText = pageTextMap.get(latestBlock.url);
    sourceTimestamp = latestBlock.timestamp;
    focusSource = {
      activeFocusEntity: latestBlock.title || pageText?.title || "Active Page",
      workingStateSummary: pageText?.excerpt || pageText?.textContent?.slice(0, 200) || "Viewing page",
      intentCategory: "Research & Gathering",
      cognitiveLoadLevel: "Low",
      timestampUtc: latestBlock.timestamp,
      url: latestBlock.url
    };
  }

  const freshness = determineMobileFreshness(sourceTimestamp);
  const health = determineMobileHealth(freshness);

  const focusGlance = await projectMobileFocusGlance(focusSource, {
    originMachine: "DesktopUbuntu",
    freshness
  });

  const recallPages: PageRecordLike[] = allPageTextsList.map((pt) => ({
    id: pt.id,
    url: pt.url,
    title: pt.title || "",
    excerpt: pt.excerpt || pt.textContent?.slice(0, 300) || "",
    textContent: pt.textContent || "",
    parsedAt: pt.parsedAt || Date.now()
  }));

  const recallResp = searchMobileMemoryPure(query, recallPages, { limit: 5 });

  renderMobileSliceView(document, {
    focus: focusGlance,
    recall: recallResp,
    freshness,
    health
  });
}

/**
 * Replaces the container's content with result rows.
 *
 * `leadingHtml` is fixed panel markup (a banner); the rows themselves are DOM
 * nodes whose captured strings are only ever set as text — see result-cards.ts.
 */
function showResultCards(container: HTMLElement, results: VectorSearchResult[], leadingHtml = ""): void {
  container.innerHTML = leadingHtml;
  appendResultCards<HTMLElement>(document, container, results);
}

async function renderSemanticResults(result: PanelSemanticSearchResult, container: HTMLElement): Promise<void> {
  switch (result.status) {
    case "ok": {
      if (result.results.length > 0) {
        showResultCards(container, result.results);
      } else {
        const querySnippet = result.query ? ` for query "${escapeHtml(result.query)}"` : "";
        container.innerHTML = `
          <div class="empty-state" style="background: #0f172a; border: 1px dashed #334155; border-radius: 6px; padding: 12px; text-align: center; color: #94a3b8; font-size: 11px;">
            No results${querySnippet}. Try another search term.
          </div>
        `;
      }
      break;
    }
    case "privacy_blocked": {
      container.innerHTML = `
        <div class="privacy-blocked-state" style="background: #450a0a; border: 1px solid #b91c1c; border-radius: 6px; padding: 10px 12px; color: #fca5a5; font-size: 11px;">
          <div style="font-weight: 700; margin-bottom: 3px;">🛡️ Fail-Closed Privacy Shield</div>
          <div>${escapeHtml(result.errorMessage || "Search query matches privacy blocklist")}</div>
        </div>
      `;
      break;
    }
    case "embedding_unavailable": {
      const fallbackResult = await searchPanelMemory(result.query, {
        requestEmbedding: async () => ({ vector: [], source: "fallback" }),
        search: hybridVectorSearch
      });
      const bannerHtml = `
        <div class="fallback-banner" style="background: #451a03; border: 1px solid #d97706; border-radius: 6px; padding: 8px 10px; color: #fcd34d; font-size: 11px; margin-bottom: 12px;">
          Semantic search unavailable — showing lexical matches
        </div>
      `;
      if (fallbackResult.results.length > 0) {
        showResultCards(container, fallbackResult.results, bannerHtml);
      } else {
        const querySnippet = result.query ? ` for query "${escapeHtml(result.query)}"` : "";
        container.innerHTML = bannerHtml + `
          <div class="empty-state" style="background: #0f172a; border: 1px dashed #334155; border-radius: 6px; padding: 12px; text-align: center; color: #94a3b8; font-size: 11px;">
            No results${querySnippet}. Try another search term.
          </div>
        `;
      }
      break;
    }
    case "empty":
    default: {
      container.innerHTML = `
        <div class="empty-state" style="background: #0f172a; border: 1px dashed #334155; border-radius: 6px; padding: 12px; text-align: center; color: #94a3b8; font-size: 11px;">
          No matching memory found. Try another search term.
        </div>
      `;
      break;
    }
  }
}

let searchDebounceTimer: number | null = null;

function debouncedRenderTimeline() {
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(async () => {
    const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
    const query = searchInput ? searchInput.value.trim() : "";
    const timelineContainer = document.getElementById("timeline");
    if (query && timelineContainer) {
      // Active-query path: honest hybrid search replaces substring-only filtering.
      const result = await searchPanelMemory(query, { requestEmbedding: requestPanelEmbedding });
      renderSemanticResults(result, timelineContainer);
    } else {
      renderTimeline();
    }
    renderMobileSliceProjection();
    searchDebounceTimer = null;
  }, 200);
}

function restoreSessionUrl(url: string) {
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url, active: true });
  } else {
    window.open(url, "_blank");
  }
}

const CONSENT_STORAGE_KEY = "exocortexCaptureConsent";

function applyConsentToggleState(checked: boolean): void {
  const toggle = document.getElementById("capture-consent-toggle") as HTMLInputElement | null;
  if (toggle) toggle.checked = checked;
}

async function loadConsentToggleState(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get({ [CONSENT_STORAGE_KEY]: false });
    applyConsentToggleState(stored[CONSENT_STORAGE_KEY] === true);
  } catch (err) {
    console.warn("[Exocortex Sidepanel] Failed to read capture consent:", err);
  }
}

/**
 * Loads the stored retention window into this page before anything is read.
 *
 * The side panel runs its own search against IndexedDB, and the retention
 * policy is per-context module state — without this the panel would filter on
 * the 7-day default whatever the user chose.
 */
async function loadRetentionControl(): Promise<void> {
  const { days } = await loadRetentionSetting(chrome.storage.local);
  const select = document.getElementById("retention-select") as HTMLSelectElement | null;
  if (select) select.value = String(days);
}

async function onRetentionChanged(event: Event): Promise<void> {
  const days = applyRetentionDays((event.target as HTMLSelectElement).value);
  // The service worker listens for this key, applies it and prunes at once.
  await chrome.storage.local.set({ [RETENTION_STORAGE_KEY]: days });
  await loadTimeline();
  // Once more after the worker's prune has had time to finish.
  window.setTimeout(loadTimeline, 1500);
}

function setOmacortexStatus(text: string): void {
  const status = document.getElementById("omacortex-feed-status");
  if (status) status.textContent = text;
}

/**
 * Asks omaCortex whether it is there, once. Only called while the feed is on:
 * a user who never opted in never causes the native host to be started.
 */
async function refreshOmacortexStatus(enabled: boolean): Promise<void> {
  if (!enabled) {
    setOmacortexStatus("off");
    return;
  }
  setOmacortexStatus("checking…");
  setOmacortexStatus(describeOmacortexStatus(await probeOmacortexStatus(chromeNativeSend)));
}

async function loadOmacortexFeedControl(): Promise<void> {
  let enabled = false;
  try {
    const stored = await chrome.storage.local.get({ [OMACORTEX_FEED_STORAGE_KEY]: false });
    enabled = stored[OMACORTEX_FEED_STORAGE_KEY] === true;
  } catch {
    enabled = false;
  }
  const toggle = document.getElementById("omacortex-feed-toggle") as HTMLInputElement | null;
  if (toggle) toggle.checked = enabled;
  await refreshOmacortexStatus(enabled);
}

document.addEventListener("DOMContentLoaded", () => {
  loadRetentionControl()
    .catch(() => undefined)
    .then(loadTimeline);

  loadConsentToggleState();
  document.getElementById("capture-consent-toggle")?.addEventListener("change", async (event) => {
    const consented = (event.target as HTMLInputElement).checked;
    await chrome.storage.local.set({ [CONSENT_STORAGE_KEY]: consented });
  });

  document.getElementById("retention-select")?.addEventListener("change", (event) => {
    void onRetentionChanged(event);
  });

  void loadOmacortexFeedControl();
  document.getElementById("omacortex-feed-toggle")?.addEventListener("change", async (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    await chrome.storage.local.set({ [OMACORTEX_FEED_STORAGE_KEY]: enabled });
    await refreshOmacortexStatus(enabled);
  });

  document.getElementById("refresh-btn")?.addEventListener("click", loadTimeline);
  document.getElementById("search-input")?.addEventListener("input", debouncedRenderTimeline);
  document.getElementById("focus-shield-toggle")?.addEventListener("change", (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    chrome.runtime.sendMessage({ type: "SET_FOCUS_SHIELD_CONFIG", payload: { enabled } });
  });
  document.getElementById("restore-parked-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RESTORE_PARKED_TABS" });
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target && target.classList.contains("restore-btn")) {
      const url = target.getAttribute("data-url");
      if (url) restoreSessionUrl(url);
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "FOCUS_SHIELD_CONTEXT_REFRESH") requestFocusShieldContext();
});
