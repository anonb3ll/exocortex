/**
 * Shared launch policy for the real-browser (B*) layer.
 *
 * Opt-in only: set `EXOCORTEX_BROWSER_TESTS=1` to run these tests. A live
 * desktop DISPLAY (Hyprland, etc.) must never be treated as a test display —
 * otherwise Chrome steals focus on the operator's real session.
 *
 * Always launch headless. Chrome's new headless supports extensions; CI and
 * local full-suite runs still use `xvfb-run -a` so a display exists for any
 * path that still needs one, but windows never appear on the operator desktop.
 *
 *   EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run test
 */
export const BROWSER_TESTS_ENABLED = Boolean(process.env.EXOCORTEX_BROWSER_TESTS);

export const BROWSER_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  // Resolve every hostname locally. The privacy-guard tests need a *blocked-looking*
  // hostname (bank.*) that still serves a local page, and previously got one via
  // bank.127.0.0.1.nip.io — a third-party wildcard DNS service. That made a layer CI
  // now depends on fail whenever an external resolver was slow, filtered, or down.
  // Chrome's own resolver rules give the same capability with no network at all.
  "--host-resolver-rules=MAP * 127.0.0.1",
];

export function extensionLaunchOptions(extPath: string) {
  return {
    // Always headless — never attach to the operator's live Wayland/X11 session.
    headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...BROWSER_LAUNCH_ARGS],
  };
}

/**
 * Grant the capture-consent opt-in inside a test browser profile.
 *
 * The content-script dwell pipeline is gated on `exocortexCaptureConsent`
 * (src/content/tracker.ts) — fail-closed for CWS consent compliance. B* tests
 * that exercise real capture must seed it once per launched browser, exactly
 * like a user flipping the side-panel toggle.
 */
export async function seedCaptureConsent(browser: Browser): Promise<void> {
  // Wait for the worker — some suites call this straight after launch, before
  // Chrome has finished registering the extension service worker.
  let sw = browser.targets().find((t) => t.type() === 'service_worker');
  for (let i = 0; !sw && i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sw = browser.targets().find((t) => t.type() === 'service_worker');
  }
  if (!sw) throw new Error('extension service worker not found — consent cannot be seeded');
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  try {
    await page.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: 'load' });
    await page.evaluate(() => chrome.storage.local.set({ exocortexCaptureConsent: true }));
  } finally {
    await page.close().catch(() => undefined);
  }
}
