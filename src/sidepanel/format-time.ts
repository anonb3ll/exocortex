/**
 * Timestamps for recall rows.
 *
 * Rows used to show hour and minute only, which answers "when" for the last
 * few hours and nothing older: with a retention window of days or months,
 * "14:05" does not say which day. The date is always present now, relative
 * for the two days people actually think of by name.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Time spent on a page: "45s", "12 min", "1h 05m". Returns "" when unknown,
 * so a row captured before dwell was measured shows nothing rather than "0s".
 */
export function formatDwell(seconds: number | undefined | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/**
 * "Today 14:05", "Yesterday 09:12", "Nov 12 16:40", or "Nov 12 2025 16:40" for
 * another year. Local time, 24-hour clock. Returns "" for an unusable timestamp.
 */
export function formatRecallTime(timestamp: number, now: number = Date.now()): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  // Calendar days, not 24-hour spans: 23:50 last night is "Yesterday" at 00:10.
  const dayDelta = Math.round((startOfLocalDay(today) - startOfLocalDay(date)) / 86_400_000);
  if (dayDelta === 0) return `Today ${clock}`;
  if (dayDelta === 1) return `Yesterday ${clock}`;

  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${day} ${date.getFullYear()} ${clock}`;
}
