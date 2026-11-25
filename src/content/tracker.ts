// Content Script: Active Tab Tracker & Dwell Handler
import { Readability } from "@mozilla/readability";
import { isUrlBlocked, sanitizeCaptureUrl, scrubSensitiveDom } from "./privacy";
import { collectPageMetadata, type PageMetadata } from "./page-metadata";
import { dwellRecordMessage, dwellUpdateMessage, type DwellMessage } from "../lib/dwell-message";
import "./focus-shield-overlay";

const DWELL_THRESHOLD_MS = 5000;
/** A blur alone only reports dwell once this much new foreground time has built up. */
const BLUR_FLUSH_MIN_DELTA_MS = 15_000;
const CONSENT_STORAGE_KEY = "exocortexCaptureConsent";
let dwellTimer: number | null = null;
let currentUrl = window.location.href;
let dwellLoggedForCurrentPage = false;
let navigationEpoch = 0;
let startGeneration = 0;

// Foreground clock for the current page. `activeSince` is the start of the
// stretch the page is visible and focused right now; `accumulatedMs` is every
// earlier stretch. Together they are the real dwell, which keeps growing after
// the one-off capture at DWELL_THRESHOLD_MS.
let activeSince: number | null = null;
let accumulatedMs = 0;
let visitStartedAt: number | null = null;

/** Last consent value read from storage. Dwell updates are sent only while it is true. */
let consentGranted = false;

/** The captured visit that later dwell updates belong to. */
let visit: { url: string; capturedAt: number; visitStartedAt: number; lastSentMs: number } | null = null;

function foregroundMs(now: number = Date.now()): number {
  return accumulatedMs + (activeSince !== null ? Math.max(0, now - activeSince) : 0);
}

function pauseForegroundClock() {
  if (activeSince !== null) {
    accumulatedMs += Math.max(0, Date.now() - activeSince);
    activeSince = null;
  }
}

function resetForegroundClock() {
  activeSince = null;
  accumulatedMs = 0;
  visitStartedAt = null;
}

function stopDwellTimer() {
  if (dwellTimer !== null) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
  pauseForegroundClock();
}

function sendToWorker(message: DwellMessage) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    // The extension was reloaded under this page; there is nobody to tell.
  }
}

/**
 * Reports the cumulative dwell for the captured visit.
 *
 * Sent with the same `capturedAt` as the record so the worker updates the rows
 * it already wrote instead of creating a second visit. Nothing is sent before
 * the initial capture, without consent, or when the total has not grown.
 */
function flushDwellUpdate(minDeltaMs = 1) {
  if (!visit || !consentGranted) return;
  const total = foregroundMs();
  if (total - visit.lastSentMs < minDeltaMs) return;
  visit.lastSentMs = total;
  sendToWorker(
    dwellUpdateMessage({
      url: visit.url,
      capturedAt: visit.capturedAt,
      visitStartedAt: visit.visitStartedAt,
      dwellDurationMs: total
    })
  );
}

// CWS requirement: no web-history / activity / content capture may run before
// an affirmative opt-in. Consent is one affirmative user action stored by the
// side-panel toggle under the key above; absent or false means never collect.
// Re-read on every start so a toggle-off stops capture without a page reload.
async function loadConsent(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get({ [CONSENT_STORAGE_KEY]: false });
    return stored[CONSENT_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

async function startDwellTimer() {
  // Bump the generation first: any earlier in-flight startDwellTimer that
  // resumes after this point is superseded and must not install a timer.
  const myGeneration = ++startGeneration;
  stopDwellTimer();

  const consented = await loadConsent();

  // Consent lookup awaited — a second start signal may have superseded this
  // one; only the newest signal may install a timer.
  if (myGeneration !== startGeneration) {
    return;
  }

  consentGranted = consented;
  if (!consented) {
    // Consent was withdrawn: the visit stops reporting dwell as well.
    visit = null;
    return;
  }

  const url = window.location.href;
  if (isUrlBlocked(url)) {
    return;
  }

  if (document.visibilityState !== "visible") {
    return;
  }

  const now = Date.now();
  activeSince = now;
  if (visitStartedAt === null) visitStartedAt = now;
  // The capture happens once per page; the foreground clock above keeps
  // running after it so later dwell updates carry the real total.
  if (!dwellLoggedForCurrentPage) {
    dwellTimer = window.setTimeout(onDwellReached, DWELL_THRESHOLD_MS);
  }
}

export function executeDwellCapture(expectedUrl?: string, expectedEpoch?: number) {
  if (expectedEpoch !== undefined && expectedEpoch !== navigationEpoch) return;
  if (expectedUrl !== undefined && window.location.href !== expectedUrl) return;
  if (dwellLoggedForCurrentPage) return;

  const rawUrl = window.location.href;
  const cleanUrl = sanitizeCaptureUrl(rawUrl);
  if (!cleanUrl) return;
  const capturedAt = Date.now();
  const measuredMs = foregroundMs(capturedAt);
  const dwellDuration = measuredMs > 0 ? measuredMs : DWELL_THRESHOLD_MS;
  const startedAt = visitStartedAt ?? capturedAt - dwellDuration;

  // Clone document for Readability to avoid mutating live DOM
  let parsedArticle: ReturnType<InstanceType<typeof Readability>["parse"]> = null;

  try {
    const documentClone = document.cloneNode(true) as Document;
    const cleanDoc = scrubSensitiveDom(documentClone);
    const reader = new Readability(cleanDoc);
    parsedArticle = reader.parse();
  } catch (err) {
    console.warn("[Exocortex] Readability parsing failed:", err);
  }

  // Declared metadata only (meta tags, JSON-LD, the YouTube channel link): no
  // page text beyond the Readability extract above is read.
  let metadata: PageMetadata;
  try {
    metadata = collectPageMetadata(document, rawUrl, {
      byline: parsedArticle?.byline,
      siteName: parsedArticle?.siteName
    });
  } catch {
    metadata = collectPageMetadata(null, rawUrl);
  }

  dwellLoggedForCurrentPage = true;
  visit = { url: cleanUrl, capturedAt, visitStartedAt: startedAt, lastSentMs: dwellDuration };
  sendToWorker(
    dwellRecordMessage({
      url: cleanUrl,
      title: document.title,
      excerpt: parsedArticle?.excerpt ?? "",
      textContent: parsedArticle?.textContent ?? "",
      dwellDurationMs: dwellDuration,
      capturedAt,
      visitStartedAt: startedAt,
      siteName: metadata.siteName,
      byline: metadata.byline,
      contentKind: metadata.contentKind
    })
  );
}

export function onDwellReached() {
  if (dwellLoggedForCurrentPage) return;
  const capturedUrl = window.location.href;
  const capturedEpoch = navigationEpoch;

  const callback = () => executeDwellCapture(capturedUrl, capturedEpoch);

  if (typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function") {
    (window as any).requestIdleCallback(callback, { timeout: 2000 });
  } else {
    callback();
  }
}

// Event Listeners for Tab Focus / Visibility / Navigation
// After the capture these still call startDwellTimer(): it re-checks consent
// and restarts the foreground clock without arming a second capture.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startDwellTimer();
  } else {
    stopDwellTimer();
    flushDwellUpdate();
  }
});

window.addEventListener("focus", () => {
  if (document.visibilityState === "visible") {
    startDwellTimer();
  }
});

// A tab can finish navigation while Chrome is still promoting its window to
// the foreground. `pageshow` is the reliable lifecycle signal for that case;
// retrying here keeps dwell capture from depending on test or window ordering.
window.addEventListener("pageshow", () => {
  if (document.visibilityState === "visible") {
    startDwellTimer();
  }
});

window.addEventListener("blur", () => {
  // Clicking into an embedded frame (a video player, a comment box) blurs this
  // window while the page is still the one in use; hasFocus() stays true then.
  if (typeof document.hasFocus === "function" && document.hasFocus()) return;
  stopDwellTimer();
  // A window that loses focus and is never looked at again fires no
  // visibilitychange, so report here too — but only once a meaningful amount
  // has built up, because blur also fires for the address bar and DevTools.
  flushDwellUpdate(BLUR_FLUSH_MIN_DELTA_MS);
});

// The last chance to report: tab closed, navigated away, or put in bfcache.
window.addEventListener("pagehide", () => {
  stopDwellTimer();
  flushDwellUpdate();
});

// Withdrawing consent stops reporting at once instead of at the next start
// signal; granting it starts the clock on a page that is already in view.
chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[CONSENT_STORAGE_KEY]) return;
  if (changes[CONSENT_STORAGE_KEY].newValue === true) {
    if (document.visibilityState === "visible") startDwellTimer();
    return;
  }
  startGeneration += 1;
  consentGranted = false;
  visit = null;
  stopDwellTimer();
});

// Handle SPA / PushState URL changes
export function handleUrlChange() {
  if (window.location.href !== currentUrl) {
    // Close out the page being left before its clock is reset.
    stopDwellTimer();
    flushDwellUpdate();
    visit = null;
    resetForegroundClock();
    navigationEpoch += 1;
    currentUrl = window.location.href;
    dwellLoggedForCurrentPage = false;
    startDwellTimer();
  }
}

// Observe body for SPA changes with debounce
let spaDebounceTimer: number | null = null;
const observer = new MutationObserver(() => {
  if (spaDebounceTimer !== null) return;
  spaDebounceTimer = window.setTimeout(() => {
    spaDebounceTimer = null;
    handleUrlChange();
  }, 250);
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

// Initial start if active
if (!isUrlBlocked(window.location.href) && document.visibilityState === "visible") {
  console.log("[Exocortex] Content script active on:", window.location.hostname);
  startDwellTimer();
}