/**
 * Native Desktop Active Window Ingestion Engine (Task #166)
 * Periodically polls the OS active window (xdotool on Linux, osascript on macOS)
 * and records desktop active window state frames into Dexie.
 */
import { exec } from "child_process";
import { recordDesktopFrame } from "../lib/desktop-frame";

export { recordDesktopFrame } from "../lib/desktop-frame";

export interface ActiveWindowInfo {
  appName: string;
  windowTitle: string;
  timestamp: number;
}

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let lastActiveWindow: ActiveWindowInfo | null = null;
let lastTransitionTime: number = Date.now();

/**
 * Executes a shell command with a timeout gate
 */
function execPromise(cmd: string, timeoutMs: number = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Polls active window title & application name from OS
 */
export async function getActiveDesktopWindow(): Promise<ActiveWindowInfo | null> {
  const platform = process.platform;

  try {
    if (platform === "linux") {
      // xdotool getactivewindow getwindowname
      const windowTitle = await execPromise("xdotool getactivewindow getwindowname");
      let appName = "Desktop App";
      try {
        const xpropOutput = await execPromise("xprop -id $(xdotool getactivewindow) WM_CLASS");
        const match = xpropOutput.match(/"([^"]+)"$/);
        if (match && match[1]) {
          appName = match[1];
        }
      } catch {
        // Fallback to title parsing
        appName = windowTitle.split(" - ").pop() || "Desktop App";
      }
      return { appName, windowTitle, timestamp: Date.now() };
    } else if (platform === "darwin") {
      const script = `tell application "System Events" to set frontApp to name of first process whose frontmost is true
tell application "System Events" to set frontTitle to name of window 1 of (first process whose frontmost is true)
return frontApp & ":::" & frontTitle`;
      const output = await execPromise(`osascript -e '${script}'`);
      const [appName, windowTitle] = output.split(":::");
      return {
        appName: appName || "Desktop App",
        windowTitle: windowTitle || appName || "Desktop Window",
        timestamp: Date.now()
      };
    }
  } catch {
    // OS active window tools (xdotool / osascript) might be unavailable or failed
  }
  return null;
}

/**
 * Returns true if the desktop window poller is currently active.
 */
export function isDesktopPollerRunning(): boolean {
  return pollerTimer !== null;
}

export interface DesktopPollingSupport {
  supported: boolean;
  reason: string;
}

/**
 * Whether this session has a window system the poller can actually read.
 *
 * The Linux path shells out to `xdotool`, which only sees X11 windows. Under
 * Wayland — the Hyprland desktop this runs on — it sees XWayland windows or
 * nothing, and the errors are swallowed into a silent `null`, so the poller
 * looks healthy while recording nothing (task #2626). omaCortex records focus
 * through Hyprland's socket into a durable store and is the OS-level source
 * there: https://github.com/anonb3ll/omaCortex. See docs/desktop-ingest.md.
 */
export function desktopPollingSupport(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): DesktopPollingSupport {
  if (platform === "darwin") {
    return { supported: true, reason: "macOS System Events" };
  }
  if (platform === "linux") {
    const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
    if (wayland) {
      return {
        supported: false,
        reason: "Wayland session: xdotool sees only XWayland windows, so this poller records nothing"
      };
    }
    if (env.DISPLAY) {
      return { supported: true, reason: "X11 session" };
    }
    return { supported: false, reason: "no DISPLAY set: there is no X server to query" };
  }
  return { supported: false, reason: `unsupported platform ${platform}` };
}

export interface DesktopPollingDecision {
  enabled: boolean;
  reason: string;
}

/**
 * The startup decision: an explicit EXOCORTEX_DESKTOP_POLLING wins either way,
 * otherwise the poller is on only where it can actually read a window. It never
 * silently runs where it records nothing.
 */
export function resolveDesktopPolling(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): DesktopPollingDecision {
  const support = desktopPollingSupport(env, platform);
  const flag = (env.EXOCORTEX_DESKTOP_POLLING ?? "").trim().toLowerCase();

  if (flag === "0" || flag === "false") {
    return { enabled: false, reason: "EXOCORTEX_DESKTOP_POLLING=0" };
  }
  if (flag === "1" || flag === "true") {
    return {
      enabled: true,
      reason: support.supported
        ? `EXOCORTEX_DESKTOP_POLLING=1 (${support.reason})`
        : `EXOCORTEX_DESKTOP_POLLING=1 forced on, but ${support.reason}`
    };
  }
  return support.supported
    ? { enabled: true, reason: `default on for ${support.reason}` }
    : { enabled: false, reason: support.reason };
}


/**
 * Resets internal poller tracking state (useful for test isolation).
 */
export function resetDesktopPollerState(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  lastActiveWindow = null;
  lastTransitionTime = Date.now();
}

/**
 * Starts active window polling loop
 */
export function startDesktopWindowPoller(
  intervalMs: number = 2000,
  getWindowFn: () => Promise<ActiveWindowInfo | null> = getActiveDesktopWindow
): () => void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }

  pollerTimer = setInterval(async () => {
    try {
      const current = await getWindowFn();
      if (!current) return;

      const now = Date.now();

      if (
        !lastActiveWindow ||
        lastActiveWindow.appName !== current.appName ||
        lastActiveWindow.windowTitle !== current.windowTitle
      ) {
        if (lastActiveWindow) {
          const dwellSeconds = Math.round((now - lastTransitionTime) / 1000);
          if (dwellSeconds >= 1) {
            await recordDesktopFrame(
              lastActiveWindow.appName,
              lastActiveWindow.windowTitle,
              dwellSeconds
            );
          }
        }
        lastActiveWindow = current;
        lastTransitionTime = now;
      }
    } catch {
      // Background poller errors are ignored silently to prevent loop interruption
    }
  }, intervalMs);

  if (pollerTimer && typeof (pollerTimer as any).unref === "function") {
    (pollerTimer as any).unref();
  }

  return () => {
    if (pollerTimer) {
      clearInterval(pollerTimer);
      pollerTimer = null;
    }
  };
}
