import { afterEach, describe, expect, test } from "bun:test";
import { BROWSER_TESTS_ENABLED, extensionLaunchOptions } from "./fixtures/browser-launch";

describe("browser launch policy", () => {
  const prev = process.env.EXOCORTEX_BROWSER_TESTS;

  afterEach(() => {
    if (prev === undefined) delete process.env.EXOCORTEX_BROWSER_TESTS;
    else process.env.EXOCORTEX_BROWSER_TESTS = prev;
  });

  test("extensionLaunchOptions is always headless regardless of DISPLAY", () => {
    const prevDisplay = process.env.DISPLAY;
    try {
      process.env.DISPLAY = ":0";
      expect(extensionLaunchOptions("/tmp/ext").headless).toBe(true);
      delete process.env.DISPLAY;
      expect(extensionLaunchOptions("/tmp/ext").headless).toBe(true);
    } finally {
      if (prevDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prevDisplay;
    }
  });

  test("BROWSER_TESTS_ENABLED is opt-in via EXOCORTEX_BROWSER_TESTS", async () => {
    delete process.env.EXOCORTEX_BROWSER_TESTS;
    const off = await import(`./fixtures/browser-launch.ts?policy=${Date.now()}-off`);
    expect(off.BROWSER_TESTS_ENABLED).toBe(false);

    process.env.EXOCORTEX_BROWSER_TESTS = "1";
    const on = await import(`./fixtures/browser-launch.ts?policy=${Date.now()}-on`);
    expect(on.BROWSER_TESTS_ENABLED).toBe(true);

    // Module-load snapshot for this process matches whatever was set at first import.
    expect(typeof BROWSER_TESTS_ENABLED).toBe("boolean");
  });
});
