import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

describe("tracker dwell invalidation across navigation", () => {
  let sentMessages: any[] = [];
  let idleCallbacks: Array<() => void> = [];
  let timers: Array<{ id: number; fn: Function; delay: number }> = [];
  let nextTimerId = 1;

  beforeEach(() => {
    sentMessages = [];
    idleCallbacks = [];
    timers = [];
    nextTimerId = 1;

    (globalThis as any).window = {
      location: {
        href: "https://example.com/page-initial",
        hostname: "example.com"
      },
      addEventListener: () => {},
      setTimeout: (fn: Function, delay: number = 0) => {
        const id = nextTimerId++;
        timers.push({ id, fn, delay });
        return id;
      },
      clearTimeout: (id: number) => {
        timers = timers.filter((t) => t.id !== id);
      },
      requestIdleCallback: (cb: () => void) => {
        idleCallbacks.push(cb);
      }
    };

    (globalThis as any).document = {
      title: "Initial Page",
      visibilityState: "visible",
      addEventListener: () => {},
      cloneNode: () => ({
        querySelectorAll: () => [],
        documentElement: {}
      }),
      body: null
    };

    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg: any, cb?: Function) => {
          sentMessages.push(msg);
          cb?.({ status: "success" });
        },
        onMessage: {
          addListener: () => {}
        }
      },
      storage: {
        local: {
          get: async (_defaults: Record<string, unknown>) => ({ exocortexCaptureConsent: true }),
          set: async (_updates: Record<string, unknown>) => {}
        }
      }
    };

    (globalThis as any).MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).chrome;
    delete (globalThis as any).MutationObserver;
  });

  test("discards scheduled dwell capture if URL navigates before idle callback runs", async () => {
    const { handleUrlChange } = await import("../src/content/tracker");

    // Advance dwell timer for initial page -> fires onDwellReached -> schedules idle callback
    expect(timers.length).toBeGreaterThanOrEqual(1);
    const initialTimer = timers.shift()!;
    initialTimer.fn();
    expect(idleCallbacks.length).toBe(1);

    // User navigates to a new page before idle callback fires
    (globalThis as any).window.location.href = "https://example.com/page-navigated";
    (globalThis as any).document.title = "Navigated Page";
    handleUrlChange();
    // startDwellTimer is async (consent check awaits storage); drain microtasks
    // so the navigated page's dwell timer is scheduled before assertions.
    await Bun.sleep(0);

    // Now run the stale deferred callback from initial page
    idleCallbacks[0]();

    // Stale callback must be discarded: no DWELL_RECORD sent
    expect(sentMessages).toEqual([]);

    // Advance dwell timer for the navigated page -> schedules new idle callback
    expect(timers.length).toBeGreaterThanOrEqual(1);
    const nextTimer = timers.shift()!;
    nextTimer.fn();
    expect(idleCallbacks.length).toBe(2);

    // Run the new page idle callback
    idleCallbacks[1]();

    // The new page was NOT prematurely marked as logged, so its dwell capture succeeds
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].type).toBe("DWELL_RECORD");
    expect(sentMessages[0].payload.url).toBe("https://example.com/page-navigated");
  });
});
