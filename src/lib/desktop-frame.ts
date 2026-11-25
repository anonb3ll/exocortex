import { db } from "./db";

const DEFAULT_APP_NAME = "Desktop App";
const DEFAULT_WINDOW_TITLE = "Desktop Window";

function normalizeLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

/** Persist a privacy-minimized desktop-window observation. */
export async function recordDesktopFrame(
  appName: string,
  windowTitle: string,
  dwellTimeSeconds = 2
): Promise<number> {
  const cleanApp = normalizeLabel(appName, DEFAULT_APP_NAME);
  const cleanTitle = normalizeLabel(windowTitle, DEFAULT_WINDOW_TITLE);
  const appLower = cleanApp.toLowerCase();
  const titleLower = cleanTitle.toLowerCase();

  let category = "Deep Work (Drafting/Coding)";
  if (
    appLower.includes("slack") ||
    appLower.includes("discord") ||
    appLower.includes("mail") ||
    appLower.includes("telegram") ||
    appLower.includes("teams") ||
    appLower.includes("zoom")
  ) {
    category = "Communication & Async";
  } else if (
    appLower.includes("spotify") ||
    titleLower.includes("youtube") ||
    appLower.includes("steam") ||
    appLower.includes("netflix") ||
    appLower.includes("twitch")
  ) {
    category = "Distraction / Rabbit Hole";
  }

  const validDwell = Number.isFinite(dwellTimeSeconds) ? dwellTimeSeconds : 2;

  return db.frames.add({
    url: `desktop://app/${encodeURIComponent(cleanApp)}`,
    title: cleanTitle,
    domain: cleanApp,
    category,
    summary: `${cleanApp}: ${cleanTitle}`,
    sourceType: "desktop_window",
    dwellTime: Math.max(1, Math.round(validDwell)),
    timestamp: Date.now(),
    synced: false
  });
}
