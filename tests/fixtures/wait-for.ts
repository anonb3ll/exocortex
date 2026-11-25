/**
 * Deadline polling for the real-browser (B*) layer.
 *
 * The B-layer used to wait on the capture pipeline with a fixed
 * `setTimeout(6000)` against a 5000ms dwell threshold (src/content/tracker.ts).
 * That is one second of slack for: content-script inject -> chrome.runtime
 * sendMessage -> service-worker cold start -> Readability parse -> Dexie open ->
 * write. It fits on an idle CI runner and does not fit on a working desktop, so
 * the same commit was green in Actions and red on a developer's machine.
 *
 * Polling to a generous deadline removes the race without weakening anything: the
 * assertion is unchanged and the test still fails if the row never arrives. It
 * just stops failing when the row arrives late. This is the pattern
 * live-browser-bridge.test.ts already used inline to wait for the service worker;
 * it is shared here so every B-layer test can stop inventing its own.
 */

/** Chrome cold-start plus unpacked-extension load, comfortably. */
export const BROWSER_SETUP_TIMEOUT_MS = 60_000;

/**
 * Timeout for the `beforeAll` hook that launches Chrome and then polls for
 * BROWSER_SETUP_TIMEOUT_MS. Must exceed BROWSER_SETUP_TIMEOUT_MS: puppeteer.launch()
 * itself takes real time before the poll even starts, so a hook timeout equal to
 * the poll budget lets Bun abort the hook before waitForCondition's own deadline
 * fires, replacing its descriptive "X timed out waiting for Y" error with Bun's
 * generic hook-timeout message.
 */
export const BROWSER_SETUP_HOOK_TIMEOUT_MS = BROWSER_SETUP_TIMEOUT_MS + 15_000;

/** Dwell threshold (5s) plus room for the whole write path on a loaded machine. */
export const CAPTURE_TIMEOUT_MS = 25_000;

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Included in the timeout message so a failure says what never happened. */
  description?: string;
}

/**
 * Polls `probe` until it returns a truthy value, or throws at the deadline.
 *
 * Errors thrown by `probe` are swallowed and retried — a CDP session against a
 * service worker that has not booted yet throws rather than returning null, and
 * that is a "not yet", not a failure.
 */
export async function waitForCondition<T>(
  probe: () => Promise<T> | T,
  options: WaitForOptions = {},
): Promise<T> {
  const { timeoutMs = CAPTURE_TIMEOUT_MS, intervalMs = 250, description = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const suffix = lastError ? ` Last error: ${String(lastError)}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.${suffix}`);
}
