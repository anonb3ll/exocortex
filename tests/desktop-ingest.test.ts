import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import {
  startDesktopWindowPoller,
  isDesktopPollerRunning,
  resetDesktopPollerState,
  resolveDesktopPolling,
  type ActiveWindowInfo,
} from "../src/mcp/desktop-ingest";

describe("Desktop Window Ingestion Engine (Task #674)", () => {
  beforeEach(async () => {
    resetDesktopPollerState();
    await db.frames.clear();
  });

  afterEach(() => {
    resetDesktopPollerState();
  });

  test("tracks poller lifecycle with isDesktopPollerRunning", () => {
    expect(isDesktopPollerRunning()).toBe(false);

    const stop = startDesktopWindowPoller(500, async () => null);
    expect(isDesktopPollerRunning()).toBe(true);

    stop();
    expect(isDesktopPollerRunning()).toBe(false);
  });

  test("records desktop frame upon window transition after dwell", async () => {
    let mockWindow: ActiveWindowInfo | null = {
      appName: "VS Code",
      windowTitle: "exocortex - src/mcp/cli.ts",
      timestamp: Date.now(),
    };

    const stop = startDesktopWindowPoller(50, async () => mockWindow);

    // Initial poll establishes baseline
    await new Promise((r) => setTimeout(r, 80));

    // Transition to another window after dwell
    await new Promise((r) => setTimeout(r, 1100)); // wait >1s dwell

    mockWindow = {
      appName: "Alacritty",
      windowTitle: "shell: exocortex",
      timestamp: Date.now(),
    };

    // Trigger transition poll
    await new Promise((r) => setTimeout(r, 120));

    stop();

    const frames = await db.frames.toArray();
    expect(frames.length).toBeGreaterThanOrEqual(1);

    const firstFrame = frames[0];
    expect(firstFrame.domain).toBe("VS Code");
    expect(firstFrame.title).toBe("exocortex - src/mcp/cli.ts");
    expect(firstFrame.sourceType).toBe("desktop_window");
    expect(firstFrame.category).toBe("Deep Work (Drafting/Coding)");
    expect(firstFrame.dwellTime).toBeGreaterThanOrEqual(1);
  });

  test("CLI startup follows the resolved polling decision, not just an env flag", async () => {
    // 1. EXOCORTEX_DESKTOP_POLLING=1 starts it whatever the session is (and says why).
    const proc = Bun.spawn(["bun", "src/mcp/cli.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        EXOCORTEX_NATIVE_BRIDGE: "0",
        EXOCORTEX_DESKTOP_POLLING: "1",
        EXOCORTEX_DESKTOP_POLL_INTERVAL_MS: "5000"
      },
    });

    let stderr = "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !stderr.includes("Desktop active-window poller started")) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }

    proc.kill();
    expect(stderr).toContain("Desktop active-window poller started (EXOCORTEX_DESKTOP_POLLING=1");

    // 2. EXOCORTEX_DESKTOP_POLLING=0 turns it off and points at omaCortex.
    const disabledProc = Bun.spawn(["bun", "src/mcp/cli.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, EXOCORTEX_NATIVE_BRIDGE: "0", EXOCORTEX_DESKTOP_POLLING: "0" },
    });

    let disabledStderr = "";
    const disabledReader = disabledProc.stderr.getReader();

    const deadlineDisabled = Date.now() + 5000;
    while (Date.now() < deadlineDisabled && !disabledStderr.includes("Desktop active-window poller off")) {
      const { value, done } = await disabledReader.read();
      if (done) break;
      disabledStderr += decoder.decode(value, { stream: true });
    }

    disabledProc.kill();
    expect(disabledStderr).toContain("Desktop active-window poller off (EXOCORTEX_DESKTOP_POLLING=0)");
    expect(disabledStderr).toContain("omaCortex is the durable OS-level desktop source");
  });
});

/**
 * The defect this closes (task #2626): the Linux sensor shells out to
 * `xdotool`, which reads X11 windows only. Under Wayland — the Hyprland
 * desktop — it returns null forever while the poller reports itself healthy.
 * The decision below is what keeps it from running where it records nothing.
 */
describe("desktop polling decision (task #2626)", () => {
  const X11 = { DISPLAY: ":0" };
  const WAYLAND = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };
  const HYPRLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };

  test("macOS and an X11 session run by default", () => {
    expect(resolveDesktopPolling({}, "darwin")).toEqual({ enabled: true, reason: "default on for macOS System Events" });
    expect(resolveDesktopPolling(X11, "linux")).toEqual({ enabled: true, reason: "default on for X11 session" });
  });

  const WAYLAND_CASES: Array<[string, Record<string, string | undefined>]> = [
    ["WAYLAND_DISPLAY", WAYLAND],
    ["XDG_SESSION_TYPE=wayland", HYPRLAND]
  ];

  test.each(WAYLAND_CASES)("a %s session is off by default because the poller would record nothing", (_name: string, env: Record<string, string | undefined>) => {
    const decision = resolveDesktopPolling(env, "linux");
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain("xdotool sees only XWayland windows");
  });

  test("a Linux box with no DISPLAY is off by default", () => {
    expect(resolveDesktopPolling({}, "linux")).toEqual({
      enabled: false,
      reason: "no DISPLAY set: there is no X server to query",
    });
  });

  test("an explicit flag wins either way, and warns when forcing it on where it cannot read", () => {
    expect(resolveDesktopPolling({ ...X11, EXOCORTEX_DESKTOP_POLLING: "0" }, "linux").enabled).toBe(false);
    expect(resolveDesktopPolling({ ...WAYLAND, EXOCORTEX_DESKTOP_POLLING: "0" }, "linux").enabled).toBe(false);

    const forced = resolveDesktopPolling({ ...WAYLAND, EXOCORTEX_DESKTOP_POLLING: "1" }, "linux");
    expect(forced.enabled).toBe(true);
    expect(forced.reason).toContain("forced on, but");
    expect(forced.reason).toContain("xdotool sees only XWayland windows");

    expect(resolveDesktopPolling({ ...X11, EXOCORTEX_DESKTOP_POLLING: "true" }, "linux").enabled).toBe(true);
  });
});
