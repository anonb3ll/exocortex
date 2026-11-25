// Service Worker (Background) for Project Exocortex
import { db, pruneOldData, getRetentionCutoff, type CognitiveStateFrame, type EmbeddingSource } from "../lib/db";
import { DWELL_RECORD, DWELL_UPDATE, readDwellRecordPayload, readDwellUpdatePayload } from "../lib/dwell-message";
import {
  applyVisitDwell,
  captureInputFromDwell,
  findVisitMeta,
  visitKey,
  visitMetaFromDwell,
  VisitLedger,
  type VisitMeta
} from "../lib/dwell-store";
import { applyRetentionDays, loadRetentionSetting, RETENTION_STORAGE_KEY } from "../lib/retention-setting";
import { chromeNativeSend, createOmacortexFeed, OMACORTEX_FEED_STORAGE_KEY } from "../lib/omacortex-feed";
import { isSearchQueryBlocked, isUrlBlocked, sanitizeCaptureUrl, sanitizeCapturedText } from "../content/privacy";
import { captureContext } from "../lib/context-workflow";
import { createCognitiveFrame } from "../lib/models/cognitive-frame";
import { evaluateContextDrift } from "../lib/agents/drift-detector";
import { stateObserver } from "../lib/agents/state-observer";
import { contextAnchorAgent } from "../lib/agents/context-anchor-agent";
import { focusEntityDerivedFromPageTitle, safeCaptureLabel, safeGoalTitle } from "../lib/title-provenance";
import { neuroergonomicNudgeAgent, type NeuroergonomicNudge } from "../lib/agents/neuroergonomic-nudge-agent";
import { librarianAgent } from "../lib/agents/librarian-agent";
import { classifyIntentAndFocusAsync } from "../lib/agents/taxonomy-agent";
import { focusShieldManager, type FocusShieldConfig, type FocusShieldEvaluation } from "../lib/focus-shield/focus-shield";
import {
  addOwnedParkedGroupId,
  normalizeOwnedParkedGroupIds,
  normalizeTabContextSignals,
  PARKED_GROUP_IDS_STORAGE_KEY,
  PARKED_GROUP_TITLE,
  selectTabsToPark,
  TAB_CONTEXT_SIGNALS_STORAGE_KEY,
  upsertTabContextSignal,
  type TabContextSignal,
  type ParkableTab
} from "../lib/focus-shield/tab-parking";
import {
  isMatchingActiveCaptureTab,
  loadFocusShieldConfig,
  persistObserverState as persistObserverStateToStorage,
  persistTabContextSignals as persistTabContextSignalsToStorage,
  removeTabContextSignalAfterReady,
  withFocusShieldReady
} from "../lib/focus-shield/runtime";
import { searchBrowserMemory, parseMemoryHandle } from "../lib/browser-memory-search";
import { startNativeBridgeClient, type BridgeHandlers, type BridgePort } from "./native-bridge-client";
import {
  handleGetCognitiveLoadTelemetry,
  handleGetFocusAnchor,
  handleGetSanitizedTelemetryExport,
  handleGetWorkingMemoryStack,
  handleProjectTaskReference,
  handleQueryFrames,
  handleRestoreContext,
  handleSemanticSearch,
  handleSetFocusAnchor
} from "../mcp/tools";
import type {
  QueryFramesParams,
  RestoreContextParams,
  SemanticSearchParams
} from "../mcp/types";

console.log("[Exocortex] Service worker initialized with Layer 2 Agents & Phase 3.1 Local AI Pipeline.");

interface WorkerSessionState {
  activeAnchorFrame: CognitiveStateFrame | null;
  activeNudge: NeuroergonomicNudge | null;
  activeSession: {
    sessionId: string;
    tabId: number;
    url: string;
    title: string;
    startTime: number;
  } | null;
  currentSessionId: string;
}

const defaultSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
const sessionStore = typeof chrome !== "undefined" && chrome.storage ? (chrome.storage.session ?? chrome.storage.local) : null;

let activeAnchorFrame: CognitiveStateFrame | null = null;
let activeNudge: NeuroergonomicNudge | null = null;
let activeSession: WorkerSessionState["activeSession"] = null;
let currentSessionId = defaultSessionId;

async function syncSessionState(): Promise<void> {
  if (!sessionStore) return;
  try {
    const raw = await sessionStore.get({
      activeAnchorFrame: null,
      activeNudge: null,
      activeSession: null,
      currentSessionId: defaultSessionId
    });
    const data = raw as unknown as WorkerSessionState;
    // Retention applies to session-restored state too (#661): a frame captured
    // before a long Chrome sleep must not keep driving drift detection past
    // the retention window — pruneOldData() only touches IndexedDB.
    const retentionCutoffMs = getRetentionCutoff();
    if (data.activeAnchorFrame) {
      activeAnchorFrame =
        (data.activeAnchorFrame.timestampUtc ?? 0) >= retentionCutoffMs ? data.activeAnchorFrame : null;
    }
    if (data.activeNudge) activeNudge = data.activeNudge;
    if (data.activeSession) {
      activeSession = (data.activeSession.startTime ?? 0) >= retentionCutoffMs ? data.activeSession : null;
    }
    if (data.currentSessionId) currentSessionId = data.currentSessionId;
  } catch {
    // Storage session unavailable or error reading
  }
}

let sessionWriteQueue: Promise<void> = Promise.resolve();

async function persistWorkerSessionState(updates: Partial<WorkerSessionState>): Promise<void> {
  if (updates.activeAnchorFrame !== undefined) activeAnchorFrame = updates.activeAnchorFrame;
  if (updates.activeNudge !== undefined) activeNudge = updates.activeNudge;
  if (updates.activeSession !== undefined) activeSession = updates.activeSession;
  if (updates.currentSessionId !== undefined) currentSessionId = updates.currentSessionId;
  if (sessionStore) {
    sessionWriteQueue = sessionWriteQueue
      .then(async () => {
        await sessionStore.set(updates);
      })
      .catch(() => undefined);
    await sessionWriteQueue;
  }
}

// The stored retention window has to be in force before anything compares a
// timestamp against it: session restore below, and the startup prune.
const retentionReady = loadRetentionSetting(chrome.storage.local);
const sessionReady = retentionReady.then(() => syncSessionState());

const CAPTURE_CONSENT_STORAGE_KEY = "exocortexCaptureConsent";

// Optional omaCortex feed. Both switches must be on: the feed toggle, and the
// capture consent without which no visit exists to send.
let omacortexFeedEnabled = false;
let captureConsentGranted = false;
const feedSettingsReady = chrome.storage.local
  .get({ [OMACORTEX_FEED_STORAGE_KEY]: false, [CAPTURE_CONSENT_STORAGE_KEY]: false })
  .then((stored) => {
    omacortexFeedEnabled = stored[OMACORTEX_FEED_STORAGE_KEY] === true;
    captureConsentGranted = stored[CAPTURE_CONSENT_STORAGE_KEY] === true;
  })
  .catch(() => undefined);

const omacortexFeed = createOmacortexFeed({
  send: chromeNativeSend,
  isEnabled: async () => {
    await feedSettingsReady;
    return omacortexFeedEnabled && captureConsentGranted;
  }
});

const visitLedger = new VisitLedger();

/** Sends one visit update to omaCortex when the feed is on. Never throws, never logs. */
async function feedVisitToOmacortex(
  url: string,
  meta: VisitMeta,
  dwellMs: number,
  visitStartedAtMs: number
): Promise<void> {
  await omacortexFeed
    .sendVisit({
      url,
      title: meta.title,
      siteName: meta.siteName,
      byline: meta.byline,
      contentKind: meta.contentKind,
      dwellMs,
      visitStartedAtMs
    })
    .catch(() => undefined);
}

const tabContextSignals = new Map<number, TabContextSignal>();

async function loadFocusShieldRuntime(): Promise<void> {
  const signals = await loadFocusShieldConfig({
    storage: chrome.storage.local,
    queryTabs: () => chrome.tabs.query({}),
    focusShieldManager,
    stateObserver
  });
  tabContextSignals.clear();
  for (const signal of signals) tabContextSignals.set(signal.tabId, signal);
}

const focusShieldReady = loadFocusShieldRuntime().catch((error) => {
  console.warn("[Exocortex] Focus Shield settings unavailable:", error);
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[RETENTION_STORAGE_KEY]) {
    // Applied before the prune, and the prune runs now: shortening the window
    // deletes what falls outside it immediately rather than at the next start.
    applyRetentionDays(changes[RETENTION_STORAGE_KEY].newValue);
    pruneOldData().catch((err) => console.error("[Exocortex] Prune error after retention change:", err));
  }
  if (changes[OMACORTEX_FEED_STORAGE_KEY]) {
    omacortexFeedEnabled = changes[OMACORTEX_FEED_STORAGE_KEY].newValue === true;
    // Turning the feed on is the user asking for a fresh attempt.
    if (omacortexFeedEnabled) omacortexFeed.resetBackoff();
  }
  if (changes[CAPTURE_CONSENT_STORAGE_KEY]) {
    captureConsentGranted = changes[CAPTURE_CONSENT_STORAGE_KEY].newValue === true;
  }
  const next: Partial<FocusShieldConfig> = {};
  if (changes.focus_shield_enabled) next.enabled = changes.focus_shield_enabled.newValue === true;
  if (changes.fatigueThreshold && typeof changes.fatigueThreshold.newValue === "number") {
    next.fatigueThreshold = changes.fatigueThreshold.newValue;
  }
  if (changes.minInterventionIntervalMs && typeof changes.minInterventionIntervalMs.newValue === "number") {
    next.minInterventionIntervalMs = changes.minInterventionIntervalMs.newValue;
  }
  if (Object.keys(next).length > 0) focusShieldManager.configure(next);
});

async function sendToTab(tabId: number, message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Restricted pages and tabs that navigated away do not host the content script.
  }
}

async function persistObserverState(): Promise<void> {
  await persistObserverStateToStorage(chrome.storage.local, stateObserver);
}

async function persistTabContextSignals(): Promise<void> {
  await persistTabContextSignalsToStorage(chrome.storage.local, tabContextSignals.values());
}

function setTabContextSignal(signal: TabContextSignal): void {
  const normalized = upsertTabContextSignal([...tabContextSignals.values()], signal);
  tabContextSignals.clear();
  for (const next of normalized) tabContextSignals.set(next.tabId, next);
}

async function isCurrentActiveCaptureTab(tabId: number, windowId: number | undefined, cleanUrl: string): Promise<boolean> {
  try {
    const activeTabs = await chrome.tabs.query(windowId === undefined ? { active: true } : { active: true, windowId });
    return isMatchingActiveCaptureTab(activeTabs, tabId, cleanUrl);
  } catch {
    return false;
  }
}

async function parkDistractionTabs(windowId: number, activeTabId?: number): Promise<number> {
  const tabs = await chrome.tabs.query({ windowId });
  const candidates = selectTabsToPark(
    tabs.map((tab): ParkableTab => {
      const url = tab.url ? sanitizeCaptureUrl(tab.url) ?? undefined : undefined;
      const signal = tab.id === undefined ? undefined : tabContextSignals.get(tab.id);
      return {
        id: tab.id ?? -1,
        active: tab.active,
        pinned: tab.pinned,
        groupId: tab.groupId,
        url,
        classifiedUrl: url && signal?.url === url ? url : undefined,
        intentCategory: signal?.intentCategory
      };
    }),
    activeTabId
  );
  if (candidates.length === 0) return 0;

  const tabIds: [number, ...number[]] = [candidates[0], ...candidates.slice(1)];
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  try {
    const stored = await chrome.storage.local.get({ [PARKED_GROUP_IDS_STORAGE_KEY]: [] });
    const ownedGroupIds = addOwnedParkedGroupId(
      normalizeOwnedParkedGroupIds(stored[PARKED_GROUP_IDS_STORAGE_KEY]),
      groupId
    );
    await chrome.storage.local.set({ [PARKED_GROUP_IDS_STORAGE_KEY]: ownedGroupIds });
  } catch (error) {
    // Do not leave a newly-created group behind if ownership could not be persisted.
    await chrome.tabs.ungroup(tabIds).catch(() => undefined);
    throw error;
  }
  if (chrome.tabGroups?.update) {
    await chrome.tabGroups.update(groupId, { title: PARKED_GROUP_TITLE, color: "grey", collapsed: true });
  }
  return candidates.length;
}

async function restoreParkedTabs(windowId?: number): Promise<number> {
  if (!chrome.tabGroups?.get) return 0;
  const stored = await chrome.storage.local.get({ [PARKED_GROUP_IDS_STORAGE_KEY]: [] });
  const ownedGroupIds = normalizeOwnedParkedGroupIds(stored[PARKED_GROUP_IDS_STORAGE_KEY]);
  const remainingGroupIds: number[] = [];
  let restored = 0;
  for (const groupId of ownedGroupIds) {
    let group: chrome.tabGroups.TabGroup;
    try {
      group = await chrome.tabGroups.get(groupId);
    } catch {
      // The group was deleted outside the extension; discard its stale ownership record.
      continue;
    }
    if (windowId !== undefined && group.windowId !== windowId) {
      remainingGroupIds.push(groupId);
      continue;
    }
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({ windowId: group.windowId });
    } catch {
      remainingGroupIds.push(groupId);
      continue;
    }
    const tabIds = tabs.filter((tab) => tab.groupId === group.id && tab.id !== undefined).map((tab) => tab.id!);
    if (tabIds.length > 0) {
      await chrome.tabs.ungroup([tabIds[0], ...tabIds.slice(1)] as [number, ...number[]]);
      restored += tabIds.length;
    } else {
      remainingGroupIds.push(groupId);
    }
  }
  await chrome.storage.local.set({ [PARKED_GROUP_IDS_STORAGE_KEY]: remainingGroupIds });
  return restored;
}

// Chrome authenticates the native host by its manifest's allowed_origins.
// Each handler below runs the same pure logic the MCP process runs against
// its own (empty, ephemeral) database — here it runs against the real one.
// Request validation and response minimization happen in
// startNativeBridgeClient/../bridge/protocol, not here: every handler
// receives already-validated args and its result is minimized before it
// reaches port.postMessage. The host is optional, so connection failure is
// an expected steady state.
/**
 * Sliding-window rate limit for bridge-driven tab opens.
 *
 * Exported for tests; the window is deliberately short and the cap small, because
 * the legitimate use is "re-open the memory we just discussed", not bulk retrieval.
 */
export const MEMORY_OPEN_LIMIT = 5;
export const MEMORY_OPEN_WINDOW_MS = 60_000;
const memoryOpenTimestamps: number[] = [];

export function allowMemoryOpen(now: number = Date.now()): boolean {
  while (memoryOpenTimestamps.length > 0 && now - memoryOpenTimestamps[0] > MEMORY_OPEN_WINDOW_MS) {
    memoryOpenTimestamps.shift();
  }
  if (memoryOpenTimestamps.length >= MEMORY_OPEN_LIMIT) return false;
  memoryOpenTimestamps.push(now);
  return true;
}

const bridgeHandlers: BridgeHandlers = {
  search_memory: (args) => searchBrowserMemory(args.query as string, args.limit as number),
  query_frames: (args) => handleQueryFrames(args as QueryFramesParams),
  semantic_search: async (args) => {
    // The embedder lives in the offscreen document, so the extension is the only
    // place a query vector can be produced — this is what makes semantic_search
    // actually semantic rather than a title substring match. A fallback vector is
    // deliberately not passed on: rescoring against a hash bag-of-words would
    // return confident nonsense, so those calls degrade to labelled lexical ranking.
    const params = args as unknown as SemanticSearchParams;
    if (isSearchQueryBlocked(params.query || "")) {
      throw new Error("Search query matches privacy blocklist");
    }
    const embedding = await requestVectorEmbedding(params.query || "");
    const queryVector = embedding.source === "model" ? embedding.vector : undefined;
    return handleSemanticSearch(params, queryVector);
  },
  get_working_memory_stack: () => handleGetWorkingMemoryStack(),
  restore_context: (args) => handleRestoreContext({ focusEntity: (args as RestoreContextParams | undefined)?.focusEntity }),
  get_focus_anchor: () => handleGetFocusAnchor({ wireSafe: true }),
  set_focus_anchor: (args) => handleSetFocusAnchor(args as Parameters<typeof handleSetFocusAnchor>[0]),
  project_task_reference: (args) => handleProjectTaskReference(args as unknown as Parameters<typeof handleProjectTaskReference>[0]),
  get_cognitive_load_telemetry: () => handleGetCognitiveLoadTelemetry(),
  get_sanitized_telemetry_export: (args) => handleGetSanitizedTelemetryExport(args),
  open_memory: async (args) => {
    // Handles are sequential and the validator accepts any well-formed one, so an
    // agent can enumerate mem_1..mem_N and open every captured page. No content
    // crosses the wire either way — this is not a leak — but it is an unbounded
    // side-effect primitive pointed at the user's browser, and "opened 400 tabs"
    // is a bad outcome regardless of what the agent could read. Cap the rate.
    if (!allowMemoryOpen()) {
      return { status: "rate_limited", handle: args.handle };
    }
    // Resolving a handle happens here and only here. The URL is read, opened, and
    // discarded without ever being returned — the agent learns whether the memory
    // still exists, nothing more. Blocked URLs are re-checked at open time because
    // the privacy blocklist may have grown since the page was captured.
    const id = parseMemoryHandle(args.handle as string);
    if (id === null) return { status: "invalid_handle", handle: args.handle };
    const page = await db.page_text.get(id);
    if (!page) return { status: "not_found", handle: args.handle };
    if (isUrlBlocked(page.url)) return { status: "blocked", handle: args.handle };
    await chrome.tabs.create({ url: page.url, active: true });
    return { status: "opened", handle: args.handle };
  }
};

const nativeBridgeClient = startNativeBridgeClient({
  connect: () => chrome.runtime.connectNative("io.exocortex.mcp_bridge") as unknown as BridgePort,
  handlers: bridgeHandlers,
  readLastError: () => chrome.runtime.lastError?.message ?? null,
});

/**
 * Single-flight latch around offscreen document creation.
 *
 * `hasDocument()` + `createDocument()` is a check-then-act, and two concurrent
 * DWELL_RECORDs both pass the check and the second throws "Only a single offscreen
 * document may be created". That throw used to be swallowed into an empty embedding,
 * so the race presented as silently missing vectors rather than an error.
 */
let offscreenSetupPromise: Promise<void> | null = null;

async function setupOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    // Requires the "offscreen" permission in the shipped manifest. Without it this
    // API is undefined and the whole embedding pipeline is dead — loudly, now.
    throw new Error("chrome.offscreen unavailable — the 'offscreen' permission is missing from the manifest");
  }
  if (!offscreenSetupPromise) {
    offscreenSetupPromise = (async () => {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: "src/offscreen/offscreen.html",
          reasons: [chrome.offscreen.Reason.WORKERS || chrome.offscreen.Reason.BLOBS],
          justification: "Compute 384-dimensional vector embeddings for local cognitive state search"
        });
      }
    })().catch((err) => {
      // Let the next caller retry rather than caching the failure forever.
      offscreenSetupPromise = null;
      throw err;
    });
  }
  return offscreenSetupPromise;
}

export interface EmbeddingResult {
  vector: number[];
  source: EmbeddingSource;
}

/**
 * Returns the embedding *and how it was produced*. An empty vector is reported as
 * `fallback`, never as a real embedding — callers decide whether a non-`model`
 * vector is fit for their purpose.
 */
async function requestVectorEmbedding(text: string): Promise<EmbeddingResult> {
  try {
    await setupOffscreenDocument();
    return await new Promise<EmbeddingResult>((resolve) => {
      chrome.runtime.sendMessage({ type: "GENERATE_EMBEDDING", payload: { text } }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== "success") {
          resolve({ vector: [], source: "fallback" });
        } else {
          resolve({
            vector: response.vector || [],
            source: response.source === "model" ? "model" : "fallback"
          });
        }
      });
    });
  } catch (err) {
    console.warn("[Exocortex] Embedding unavailable:", err);
    return { vector: [], source: "fallback" };
  }
}

/**
 * Prunes with the user's stored retention window, never the built-in default.
 *
 * The setting is re-read here rather than trusted from module state, and if it
 * cannot be read the prune is skipped: pruning on the 7-day default after a
 * storage error would delete months of history from someone who chose a year.
 */
async function pruneWithStoredRetention(): Promise<void> {
  const { loaded } = await loadRetentionSetting(chrome.storage.local);
  if (!loaded) {
    console.warn("[Exocortex] Retention setting unreadable; skipping prune.");
    return;
  }
  await pruneOldData();
}

// On installed or started, prune data older than configured retention window
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Exocortex] Extension installed. Running initial LRU pruning...");
  pruneWithStoredRetention().catch((err) => console.error("[Exocortex] Prune error:", err));
});

// Run pruning on startup
pruneWithStoredRetention().catch((err) => console.error("[Exocortex] Startup prune error:", err));

// Message Listener for Dwell Records from Content Scripts & Popup Requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === DWELL_UPDATE && message.payload) {
    const update = readDwellUpdatePayload(message.payload);
    if (!update) {
      sendResponse({ status: "invalid" });
      return true;
    }
    const cleanUrl = sanitizeCaptureUrl(update.url);
    if (!cleanUrl) {
      sendResponse({ status: "blocked" });
      return true;
    }
    const key = visitKey(cleanUrl, update.capturedAt);
    // Noted synchronously, before any await: if the record for this visit is
    // still in its pipeline, it reads this total back when it writes its rows.
    const dwellMs = visitLedger.noteDwell(key, update.dwellDurationMs);

    (async () => {
      try {
        const updated = await applyVisitDwell({
          url: cleanUrl,
          capturedAt: update.capturedAt,
          dwellDurationMs: dwellMs
        });
        // Only a visit this worker captured (ledger) or finds in the database is
        // sent on — an update for an unknown visit describes nothing that passed
        // the privacy guard.
        const meta = visitLedger.meta(key) ?? (await findVisitMeta(cleanUrl, update.capturedAt));
        if (meta) await feedVisitToOmacortex(cleanUrl, meta, dwellMs, update.visitStartedAt);
        sendResponse({ status: "success", updated });
      } catch (err) {
        sendResponse({ status: "error", error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === DWELL_RECORD && message.payload) {
    const payload = readDwellRecordPayload(message.payload);
    if (!payload) {
      sendResponse({ status: "invalid" });
      return true;
    }
    const { url, title, excerpt, textContent, siteName, byline, contentKind } = payload;
    const cleanUrl = sanitizeCaptureUrl(url);
    if (!cleanUrl) {
      sendResponse({ status: "blocked" });
      return true;
    }
    const senderTabId = sender.tab?.id;
    const senderWindowId = sender.tab?.windowId;
    // Shared activity clock for the dwell row and the eventual cognitive frame.
    // Embedding/classification can finish later; timestampUtc must still reflect
    // when the page was captured so side-panel freshness picks the right source.
    // It is also the visit's identity: dwell updates find these rows by it.
    const capturedAt = payload.capturedAt;
    const key = visitKey(cleanUrl, capturedAt);
    visitLedger.noteDwell(key, payload.dwellDurationMs);
    // Latest cumulative dwell for the visit — an update may land mid-pipeline.
    const dwellMsNow = () => visitLedger.dwellMs(key) ?? payload.dwellDurationMs;

    // A captured page is activity: give a bridge that gave up another chance.
    nativeBridgeClient.nudge();

    (async () => {
      try {
        await focusShieldReady;
        const captured = await captureContext({
          ...captureInputFromDwell(payload, cleanUrl, currentSessionId),
          dwellTime: dwellMsNow()
        });
        if (!captured) {
          sendResponse({ status: "blocked" });
          return;
        }

        // Past the privacy guard: this visit may now be described to omaCortex
        // (if the user turned the feed on) and by later dwell updates.
        const visitMeta = visitMetaFromDwell(payload, cleanUrl);
        visitLedger.setMeta(key, visitMeta);
        void feedVisitToOmacortex(cleanUrl, visitMeta, dwellMsNow(), payload.visitStartedAt);

        // Layer 1: Compute vector & create Cognitive State Frame
        await sessionReady;
        const textForEmbedding = `${title} ${excerpt || ""} ${textContent || ""}`;
        const embedding = await requestVectorEmbedding(textForEmbedding);
        // Only a real model embedding is allowed onto the frame, because the frame's
        // vectorAnchor is what drift detection compares. A hash-bag-of-words fallback
        // has an embedding's shape but not its semantics; blending it in would produce
        // confident nonsense. It is still persisted below (tagged) for diagnostics.
        const vectorAnchor = embedding.source === "model" ? embedding.vector : undefined;
        const recentSwitches = stateObserver.getRecentTabSwitchesCount();
        const cumulativeMins = stateObserver.getCumulativeSessionMinutes();

        // Hybrid Zero-Shot Taxonomy / Regex Classification
        const classification = await classifyIntentAndFocusAsync({
          url: cleanUrl,
          title: title || "Untitled Page",
          excerpt,
          siteName,
          byline,
          contentKind
        });

        const frame = createCognitiveFrame({
          sessionId: currentSessionId,
          url: cleanUrl,
          pageTitle: title || "Untitled Page",
          activeDwellSeconds: Math.round(dwellMsNow() / 1000),
          cleanTextExcerpt: excerpt || textContent || "",
          vectorAnchor,
          recentTabSwitchesIn5Min: recentSwitches,
          cumulativeSessionMinutes: cumulativeMins,
          timestampUtc: capturedAt
        });

        // Override userState with hybrid classification
        frame.userState.intentCategory = classification.intentCategory;
        frame.userState.primaryFocusEntity = classification.primaryFocusEntity;
        frame.userState.workingStateSummary = classification.workingStateSummary;

        if (senderTabId !== undefined) {
          setTabContextSignal({
            tabId: senderTabId,
            intentCategory: classification.intentCategory,
            url: cleanUrl,
            title: title || "Untitled Page"
          });
          await persistTabContextSignals();
        }

        await db.cognitive_frames.put(frame);

        // Store in Phase 3.1 Dexie frames & embeddings tables
        try {
          let domainName = "";
          try {
            domainName = new URL(cleanUrl).hostname;
          } catch {
            domainName = siteName || "";
          }

          const frameRecordId = await db.frames.add({
            url: cleanUrl,
            title: title || "Untitled Page",
            domain: domainName,
            category: classification.intentCategory,
            summary: excerpt || (textContent ? textContent.slice(0, 200) : title),
            dwellTime: Math.round(dwellMsNow() / 1000),
            timestamp: capturedAt,
            synced: false,
            siteName: visitMeta.siteName,
            byline: visitMeta.byline,
            contentKind: visitMeta.contentKind
          });

          if (embedding.vector.length === 384 && frameRecordId) {
            await db.embeddings.put({
              frameId: frameRecordId,
              vector: new Float32Array(embedding.vector),
              dimension: 384,
              createdAt: capturedAt,
              source: embedding.source
            });
          }
        } catch (e) {
          console.warn("[Exocortex] Failed writing to Phase 3.1 frames/embeddings:", e);
        }

        // A dwell update that arrived while this record was being embedded found
        // no rows to raise. They exist now; bring them up to the latest total.
        if (dwellMsNow() > payload.dwellDurationMs) {
          await applyVisitDwell({ url: cleanUrl, capturedAt, dwellDurationMs: dwellMsNow() });
        }

        // Layer 3: Index in Semantic Vault via Librarian Agent
        await librarianAgent.indexPageExcerpt({
          url: cleanUrl,
          title: title || "Untitled Page",
          excerpt: excerpt || textContent || "",
          primaryFocusEntity: frame.userState.primaryFocusEntity,
          vectorAnchor
        });

        // Layer 2: Observer & Anchoring Agents
        const telemetry = stateObserver.evaluateTelemetry(frame);
        await persistObserverState();
        let shieldEvaluation: FocusShieldEvaluation = {
          activated: false,
          intervention: null,
          reason: "Capture tab is no longer the active tab"
        };
        if (senderTabId !== undefined && await isCurrentActiveCaptureTab(senderTabId, senderWindowId, cleanUrl)) {
          const previousInterventionTime = focusShieldManager.getLastInterventionTime();
          shieldEvaluation = focusShieldManager.evaluateFrameSequence([frame], telemetry.currentMetrics);

          if (shieldEvaluation.activated) {
            const stillActive = await isCurrentActiveCaptureTab(senderTabId, senderWindowId, cleanUrl);
            if (!stillActive) {
              focusShieldManager.rollbackIntervention(shieldEvaluation.intervention?.timestamp ?? 0, previousInterventionTime);
              shieldEvaluation = {
                activated: false,
                intervention: null,
                reason: "Capture tab changed before the intervention could be delivered"
              };
            } else {
              await chrome.storage.local.set({
                focus_shield_last_intervention_at: focusShieldManager.getLastInterventionTime()
              });
              await sendToTab(senderTabId, {
                type: "FOCUS_SHIELD_SHOW",
                intervention: shieldEvaluation.intervention
              });
              if (senderWindowId !== undefined) {
                const parkedCount = await parkDistractionTabs(senderWindowId, senderTabId);
                if (parkedCount > 0) {
                  await sendToTab(senderTabId, { type: "FOCUS_SHIELD_PARK_RESULT", parkedCount });
                }
              }
            }
          }
        }

        // Auto-checkpoint when transitioning out of Deep Work
        if (
          activeAnchorFrame &&
          activeAnchorFrame.userState.intentCategory === "Deep Work (Drafting/Coding)" &&
          frame.userState.intentCategory === "Distraction / Rabbit Hole"
        ) {
          await contextAnchorAgent.captureCheckpoint({
            frame: activeAnchorFrame,
            goalTitle: `Deep Work: ${activeAnchorFrame.userState.primaryFocusEntity}`,
            openTabsContext: [{ url: cleanUrl, title: title || "Page", excerpt }]
          });
        }

        if (!activeAnchorFrame && frame.userState.intentCategory !== "Distraction / Rabbit Hole") {
          activeAnchorFrame = frame;
          await persistWorkerSessionState({ activeAnchorFrame });
          const derived = focusEntityDerivedFromPageTitle(
            frame.userState.primaryFocusEntity,
            frame.provenance,
            frame.userState.intentCategory
          );
          const entity = frame.userState.primaryFocusEntity;
          await contextAnchorAgent.pushWorkingMemoryStack(`Focus: ${entity}`, undefined, {
            derived,
            safeGoalLabel: derived
              ? safeGoalTitle(`Focus: ${entity}`, entity, safeCaptureLabel(frame.provenance, frame.userState.intentCategory))
              : undefined
          });
        } else if (activeAnchorFrame) {
          const drift = evaluateContextDrift(activeAnchorFrame, frame, recentSwitches);
          activeNudge = neuroergonomicNudgeAgent.generateIntervention(drift, telemetry.currentMetrics, frame);
          await persistWorkerSessionState({ activeNudge });
        }

        await recordSessionStep(cleanUrl, title);
        sendResponse({
          status: "success",
          frameId: frame.frameId,
          softNudge: activeNudge?.message || null,
          nudge: activeNudge,
          telemetry: telemetry.currentMetrics,
          focusShield: {
            enabled: focusShieldManager.isEnabled(),
            state: focusShieldManager.getState(),
            activated: shieldEvaluation.activated,
            intervention: shieldEvaluation.intervention
          }
        });
      } catch (err) {
        console.error("[Exocortex] Error saving cognitive frame to Dexie:", err);
        sendResponse({ status: "error", error: String(err) });
      }
    })();

    return true;
  }

  if (message.type === "GET_LAST_CONTEXT") {
    (async () => {
      try {
        const lastBlock = await db.dwell_blocks.orderBy("timestamp").reverse().first();
        if (lastBlock) {
          const pageText = await db.page_text.where("url").equals(lastBlock.url).first();
          sendResponse({ status: "success", data: { block: lastBlock, pageText } });
        } else {
          sendResponse({ status: "success", data: null });
        }
      } catch (err) {
        sendResponse({ status: "error", error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "GET_TELEMETRY") {
    (async () => {
      try {
        await sessionReady;
        const snapshot = await stateObserver.getLatestObserverSnapshot();
        const activeStack = await contextAnchorAgent.getActiveWorkingMemoryStack(5);
        sendResponse({ status: "success", telemetry: snapshot, nudge: activeNudge, activeStack });
      } catch (err) {
        sendResponse({ status: "error", error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "GET_BRIDGE_HEALTH") {
    sendResponse({ status: "success", bridge: nativeBridgeClient.health() });
    return true;
  }

  if (message.type === "REQUEST_VECTOR_EMBEDDING") {
    (async () => {
      try {
        const embedding = await requestVectorEmbedding(String(message.payload?.text ?? ""));
        sendResponse({ status: "success", vector: embedding.vector, source: embedding.source });
      } catch (err) {
        sendResponse({ status: "error", error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "GET_FOCUS_SHIELD_CONFIG") {
    (async () => {
      await focusShieldReady;
      sendResponse({ status: "success", config: focusShieldManager.getConfig() });
    })().catch((error) => sendResponse({ status: "error", error: String(error) }));
    return true;
  }

  if (message.type === "SET_FOCUS_SHIELD_CONFIG") {
    (async () => {
      await focusShieldReady;
      const configUpdate: Partial<FocusShieldConfig> = {};
      const storageUpdate: Record<string, unknown> = {};
      if (typeof message.payload?.enabled === "boolean") {
        configUpdate.enabled = message.payload.enabled;
        storageUpdate.focus_shield_enabled = message.payload.enabled;
      }
      if (typeof message.payload?.fatigueThreshold === "number") {
        configUpdate.fatigueThreshold = message.payload.fatigueThreshold;
        storageUpdate.fatigueThreshold = message.payload.fatigueThreshold;
      }
      if (typeof message.payload?.minInterventionIntervalMs === "number") {
        configUpdate.minInterventionIntervalMs = message.payload.minInterventionIntervalMs;
        storageUpdate.minInterventionIntervalMs = message.payload.minInterventionIntervalMs;
      }
      if (Object.keys(configUpdate).length > 0) {
        focusShieldManager.configure(configUpdate);
        await chrome.storage.local.set(storageUpdate);
      }
      sendResponse({ status: "success", config: focusShieldManager.getConfig() });
    })().catch((error) => sendResponse({ status: "error", error: String(error) }));
    return true;
  }

  if (message.type === "FOCUS_SHIELD_DISMISS") {
    focusShieldManager.dismiss();
    sendResponse({ status: "success" });
    return true;
  }

  if (message.type === "FOCUS_SHIELD_OPEN_CONTEXT") {
    (async () => {
      try {
        if (sender.tab?.id === undefined || !chrome.sidePanel?.open) {
          sendResponse({ status: "error", error: "Exocortex side panel is unavailable" });
          return;
        }
        await chrome.sidePanel.open({ tabId: sender.tab.id });
        // Opening an already-visible panel does not reload its script. Notify it
        // so Restore always fetches the current checkpoint instead of stale text.
        await chrome.runtime.sendMessage({ type: "FOCUS_SHIELD_CONTEXT_REFRESH", tabId: sender.tab.id }).catch(() => undefined);
        sendResponse({ status: "success" });
      } catch (error) {
        sendResponse({ status: "error", error: String(error) });
      }
    })();
    return true;
  }

  if (message.type === "GET_FOCUS_SHIELD_CONTEXT") {
    (async () => {
      try {
        await focusShieldReady;
        // The one local caller: the user's own machine, so their own text. It does
        // not go through the MCP-facing handler, which cannot be asked for this.
        const prompt = await contextAnchorAgent.getContextRestorationKit(undefined, { wireSafe: false });
        sendResponse({ status: "success", prompt });
      } catch (error) {
        sendResponse({ status: "error", error: String(error) });
      }
    })();
    return true;
  }

  if (message.type === "FOCUS_SHIELD_PARK_TABS") {
    (async () => {
      try {
        const parkedCount = await withFocusShieldReady(focusShieldReady, () =>
          sender.tab?.windowId === undefined
            ? Promise.resolve(0)
            : parkDistractionTabs(sender.tab.windowId, sender.tab.id)
        );
        if (sender.tab?.id !== undefined) {
          await sendToTab(sender.tab.id, { type: "FOCUS_SHIELD_PARK_RESULT", parkedCount });
        }
        sendResponse({ status: "success", parkedCount });
      } catch (error) {
        sendResponse({ status: "error", error: String(error) });
      }
    })();
    return true;
  }

  if (message.type === "RESTORE_PARKED_TABS") {
    (async () => {
      try {
        const restoredCount = await restoreParkedTabs(message.payload?.windowId);
        sendResponse({ status: "success", restoredCount });
      } catch (error) {
        sendResponse({ status: "error", error: String(error) });
      }
    })();
    return true;
  }

  if (message.type === "GET_SEMANTIC_KNOWLEDGE") {
    (async () => {
      try {
        const focusEntity = message.payload?.primaryFocusEntity;
        const query = message.payload?.query;
        // searchSemanticVault has always accepted a vectorAnchor and weighted it
        // heavily, but no caller ever passed one, so its cosine branch was dead and
        // scoring was keyword-only despite the method's own docstring. The service
        // worker can reach the embedder, so it supplies one here.
        const embedding = query ? await requestVectorEmbedding(query) : null;
        const vectorAnchor = embedding?.source === "model" ? embedding.vector : undefined;
        const results = await librarianAgent.searchSemanticVault({ query, vectorAnchor, primaryFocusEntity: focusEntity, limit: 5 });
        sendResponse({ status: "success", results });
      } catch (err) {
        sendResponse({ status: "error", error: String(err) });
      }
    })();
    return true;
  }
});

async function recordSessionStep(url: string, title: string) {
  const cleanUrl = sanitizeCaptureUrl(url);
  if (!cleanUrl) return;
  await sessionReady;
  const now = Date.now();

  if (activeSession) {
    const duration = now - activeSession.startTime;
    const previousUrl = sanitizeCaptureUrl(activeSession.url);
    try {
      if (previousUrl) {
        await db.sessions.add({
          sessionId: activeSession.sessionId,
          startTime: activeSession.startTime,
          endTime: now,
          url: previousUrl,
          title: sanitizeCapturedText(activeSession.title),
          activeDuration: duration
        });
      }
    } catch (e) {
      console.warn("[Exocortex] Failed to write session record:", e);
    }
  }

  const nextActiveSession = {
    sessionId: currentSessionId,
    tabId: -1,
    url: cleanUrl,
    title: sanitizeCapturedText(title) || "Active Page",
    startTime: now
  };
  await persistWorkerSessionState({ activeSession: nextActiveSession, currentSessionId });
}

// Active Tab Listeners
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    await focusShieldReady;
    stateObserver.recordTabSwitch();
    await persistObserverState();
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url && !isUrlBlocked(tab.url)) {
      await recordSessionStep(tab.url, tab.title || "");
    }
  } catch {
    // Ignore invalid tab error
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined) {
    void removeTabContextSignalAfterReady(focusShieldReady, chrome.storage.local, tabContextSignals, _tabId).catch(
      () => undefined
    );
  }
  if (changeInfo.status === "complete" && tab.url) {
    await recordSessionStep(tab.url, tab.title || "");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabContextSignalAfterReady(focusShieldReady, chrome.storage.local, tabContextSignals, tabId).catch(
    () => undefined
  );
});
