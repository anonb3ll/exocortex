/**
 * Real dwell: the tracker keeps a foreground clock running after the one-off
 * capture and reports the cumulative total when the page leaves the foreground,
 * unloads, or its SPA URL changes.
 *
 * Before this, the only dwell ever sent was the ~5 s that had passed when the
 * capture timer fired, so a forty-minute video and a five-second glance were
 * stored as the same visit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DWELL_RECORD, DWELL_UPDATE } from "../src/lib/dwell-message";

type Listener = (...args: any[]) => void;

describe("tracker dwell updates", () => {
  let sent: any[] = [];
  let timers: Array<{ id: number; fn: () => void }> = [];
  let windowListeners: Record<string, Listener[]> = {};
  let documentListeners: Record<string, Listener[]> = {};
  let storageListeners: Listener[] = [];
  let consent = true;
  let now = 1_800_000_000_000;
  let importCounter = 0;
  const realDateNow = Date.now;

  const fire = (listeners: Record<string, Listener[]>, event: string) =>
    (listeners[event] || []).forEach((listener) => listener());
  /** Lets the async consent read inside startDwellTimer settle. */
  const settle = () => Bun.sleep(0);
  const advance = (ms: number) => {
    now += ms;
  };
  const updates = () => sent.filter((m) => m.type === DWELL_UPDATE);
  const records = () => sent.filter((m) => m.type === DWELL_RECORD);

  /** A fresh copy of the tracker module, so each test starts with clean module state. */
  async function loadTracker() {
    importCounter += 1;
    const tracker = await import(`../src/content/tracker?dwell-update-${importCounter}`);
    await settle();
    return tracker as typeof import("../src/content/tracker");
  }

  /** Runs the armed capture timer; with no requestIdleCallback the capture is synchronous. */
  function fireCaptureTimer() {
    expect(timers.length).toBe(1);
    timers.shift()!.fn();
  }

  beforeEach(() => {
    sent = [];
    timers = [];
    windowListeners = {};
    documentListeners = {};
    storageListeners = [];
    consent = true;
    now = 1_800_000_000_000;
    Date.now = () => now;
    let nextTimerId = 1;

    (globalThis as any).window = {
      location: { href: "https://example.com/article", hostname: "example.com" },
      addEventListener: (event: string, listener: Listener) => {
        (windowListeners[event] ||= []).push(listener);
      },
      setTimeout: (fn: () => void) => {
        const id = nextTimerId++;
        timers.push({ id, fn });
        return id;
      },
      clearTimeout: (id: number) => {
        timers = timers.filter((t) => t.id !== id);
      }
    };
    // The tracker calls the bare global clearTimeout for its own timer.
    (globalThis as any).__realClearTimeout = globalThis.clearTimeout;
    (globalThis as any).clearTimeout = (id: any) => {
      if (typeof id === "number") timers = timers.filter((t) => t.id !== id);
      else (globalThis as any).__realClearTimeout(id);
    };

    (globalThis as any).document = {
      title: "An Article",
      visibilityState: "visible",
      addEventListener: (event: string, listener: Listener) => {
        (documentListeners[event] ||= []).push(listener);
      },
      cloneNode: () => ({ querySelectorAll: () => [], documentElement: {} }),
      body: null
    };

    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message: any, callback?: Listener) => {
          sent.push(message);
          callback?.({ status: "success" });
        },
        onMessage: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async () => ({ exocortexCaptureConsent: consent }),
          set: async () => {}
        },
        onChanged: { addListener: (listener: Listener) => storageListeners.push(listener) }
      }
    };

    (globalThis as any).MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    Date.now = realDateNow;
    (globalThis as any).clearTimeout = (globalThis as any).__realClearTimeout;
    delete (globalThis as any).__realClearTimeout;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).chrome;
    delete (globalThis as any).MutationObserver;
  });

  test("the record carries the measured dwell and a stable visit identity", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();

    expect(records().length).toBe(1);
    const payload = records()[0].payload;
    expect(payload.dwellDurationMs).toBe(5_000);
    expect(payload.capturedAt).toBe(now);
    expect(payload.visitStartedAt).toBe(now - 5_000);
    // Metadata falls back to the hostname when the page declares nothing.
    expect(payload.siteName).toBe("example.com");
    expect(payload.contentKind).toBe("page");
  });

  test("hiding the page sends the cumulative dwell with the record's capturedAt", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();
    const record = records()[0].payload;

    advance(55_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");

    expect(updates().length).toBe(1);
    expect(updates()[0].payload).toEqual({
      url: record.url,
      capturedAt: record.capturedAt,
      visitStartedAt: record.visitStartedAt,
      dwellDurationMs: 60_000
    });
  });

  test("time spent hidden is not dwell; a second foreground stretch adds to the total", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();
    const record = records()[0].payload;

    advance(10_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");
    expect(updates()[0].payload.dwellDurationMs).toBe(15_000);

    // An hour in a background tab.
    advance(3_600_000);
    (globalThis as any).document.visibilityState = "visible";
    fire(documentListeners, "visibilitychange");
    await settle();
    // Coming back restarts the clock but does not arm a second capture.
    expect(timers.length).toBe(0);

    advance(20_000);
    fire(windowListeners, "pagehide");

    expect(records().length).toBe(1);
    expect(updates().length).toBe(2);
    expect(updates()[1].payload.dwellDurationMs).toBe(35_000);
    expect(updates()[1].payload.capturedAt).toBe(record.capturedAt);
    expect(updates()[1].payload.visitStartedAt).toBe(record.visitStartedAt);
  });

  test("an unchanged total is not sent twice", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();

    advance(8_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");
    // Closing a tab fires both; the second has nothing new to say.
    fire(windowListeners, "pagehide");

    expect(updates().length).toBe(1);
  });

  test("a brief blur does not report, a long one does", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();

    advance(3_000);
    fire(windowListeners, "blur");
    expect(updates().length).toBe(0);

    fire(windowListeners, "focus");
    await settle();
    advance(30_000);
    fire(windowListeners, "blur");
    expect(updates().length).toBe(1);
    expect(updates()[0].payload.dwellDurationMs).toBe(38_000);
  });

  test("focus moving into an embedded frame does not stop the clock", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();

    // Clicking a video player in an iframe blurs the window, but the document
    // still reports focus: the page is still the one in use.
    (globalThis as any).document.hasFocus = () => true;
    advance(10_000);
    fire(windowListeners, "blur");
    advance(50_000);
    fire(windowListeners, "pagehide");

    expect(updates().length).toBe(1);
    expect(updates()[0].payload.dwellDurationMs).toBe(65_000);
  });

  test("an SPA URL change closes out the old visit before starting the new one", async () => {
    const tracker = await loadTracker();
    advance(5_000);
    fireCaptureTimer();
    const first = records()[0].payload;

    advance(40_000);
    (globalThis as any).window.location.href = "https://example.com/next";
    tracker.handleUrlChange();
    await settle();

    expect(updates().length).toBe(1);
    expect(updates()[0].payload.url).toBe(first.url);
    expect(updates()[0].payload.dwellDurationMs).toBe(45_000);

    // The new page starts from zero and is captured as its own visit.
    advance(5_000);
    fireCaptureTimer();
    expect(records().length).toBe(2);
    const second = records()[1].payload;
    expect(second.url).toBe("https://example.com/next");
    expect(second.dwellDurationMs).toBe(5_000);
    expect(second.capturedAt).not.toBe(first.capturedAt);
  });

  test("nothing is sent before the capture", async () => {
    await loadTracker();
    advance(3_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");
    fire(windowListeners, "pagehide");

    expect(sent).toEqual([]);
  });

  test("no consent, no messages", async () => {
    consent = false;
    await loadTracker();
    expect(timers.length).toBe(0);

    advance(120_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");
    fire(windowListeners, "pagehide");

    expect(sent).toEqual([]);
  });

  test("withdrawing consent after the capture stops dwell updates at once", async () => {
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();
    expect(records().length).toBe(1);

    consent = false;
    for (const listener of storageListeners) {
      listener({ exocortexCaptureConsent: { oldValue: true, newValue: false } }, "local");
    }

    advance(60_000);
    (globalThis as any).document.visibilityState = "hidden";
    fire(documentListeners, "visibilitychange");
    fire(windowListeners, "pagehide");

    expect(updates().length).toBe(0);
  });

  test("consent found withdrawn on the next start signal also stops updates", async () => {
    // The path for a browser without storage.onChanged delivery to this page:
    // the re-read on every start is what notices.
    await loadTracker();
    advance(5_000);
    fireCaptureTimer();

    consent = false;
    fire(windowListeners, "focus");
    await settle();

    advance(60_000);
    fire(windowListeners, "pagehide");
    expect(updates().length).toBe(0);
  });

  test("a blocked page never reports dwell", async () => {
    (globalThis as any).window.location.href = "https://login.example.com/";
    await loadTracker();
    expect(timers.length).toBe(0);

    advance(60_000);
    fire(windowListeners, "pagehide");
    expect(sent).toEqual([]);
  });
});
