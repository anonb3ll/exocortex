/**
 * The user-facing retention setting.
 *
 * `src/lib/db.ts` owns the retention *policy* (cutoff, prune, read filters);
 * this module owns where the extension keeps the user's choice and how it is
 * loaded into that policy. Every extension context that reads the database —
 * the service worker and the side panel — must load it, because the policy
 * value is module state and each context has its own copy.
 */
import { DEFAULT_RETENTION_MAX_AGE_DAYS, setRetentionMaxAgeDays } from "./db";

export const RETENTION_STORAGE_KEY = "exocortexRetentionDays";
export const RETENTION_CHOICES_DAYS = [7, 30, 90, 365] as const;
export type RetentionChoiceDays = (typeof RETENTION_CHOICES_DAYS)[number];

export interface RetentionStorage {
  get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** One of the offered windows; anything else (absent, corrupt, out of range) is the 7-day default. */
export function normalizeRetentionDays(raw: unknown): RetentionChoiceDays {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return (RETENTION_CHOICES_DAYS as readonly unknown[]).includes(value)
    ? (value as RetentionChoiceDays)
    : DEFAULT_RETENTION_MAX_AGE_DAYS;
}

/** Applies a stored value to this context's retention policy and returns the window in days. */
export function applyRetentionDays(raw: unknown): RetentionChoiceDays {
  const days = normalizeRetentionDays(raw);
  setRetentionMaxAgeDays(days);
  return days;
}

/**
 * Loads the stored setting into this context.
 *
 * `loaded: false` means storage could not be read. The 7-day default is then in
 * force for reads, but the caller must NOT prune on it: a transient storage
 * error would otherwise delete everything older than a week from a user who
 * chose a year.
 */
export async function loadRetentionSetting(
  storage: RetentionStorage
): Promise<{ days: RetentionChoiceDays; loaded: boolean }> {
  try {
    const stored = await storage.get({ [RETENTION_STORAGE_KEY]: DEFAULT_RETENTION_MAX_AGE_DAYS });
    return { days: applyRetentionDays(stored[RETENTION_STORAGE_KEY]), loaded: true };
  } catch {
    return { days: normalizeRetentionDays(undefined), loaded: false };
  }
}
