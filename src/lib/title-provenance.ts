/**
 * Whether a stored focus entity or goal carries text captured from a page.
 *
 * The rule-based classifier copies the title into `userState.primaryFocusEntity`
 * for research, mail and task pages, and Chrome's built-in AI classifier rewrites
 * it into a paraphrase instead. Neither form carries provenance, so once the frame
 * is gone a stored string can no longer be compared with the page it came from —
 * which is why `wireSafeUserState`'s literal-repeat test cannot catch the stored
 * copies in the working-memory stack and the cognitive checkpoints (task #2632).
 *
 * The decision is made at capture, while the frame is still in hand, and stored
 * beside the goal; wire-facing readers substitute the label computed here.
 *
 * The rule is the entity's *source*, not its shape. Anything on a captured page
 * that is not already the site label or the intent category came out of the page:
 * the title, a paraphrase of it, or the URL path (`owner/repo`, a gist id) — and a
 * URL path plus the site is enough to rebuild a URL, which is what the projection
 * contract forbids. Judging by shape (whitespace, say) passed those through. A
 * frame an agent wrote through MCP (`device://`) is the opposite case: its
 * "title" is the entity the agent itself supplied, so nothing was captured.
 */
import { displayHost, hostnameOf } from "./host-match";

export type CapturedProvenance = { url?: string | null; pageTitle?: string | null } | undefined;

const DEVICE_URL = /^device:/i;

/** The stand-in used when a row carries no usable label. */
export const CAPTURED_PAGE_LABEL = "(captured page)";

/** True for frames an agent wrote through MCP (`set_focus_anchor` / `record_frame`). */
export function isDeviceProvenance(url?: string | null): boolean {
  return DEVICE_URL.test(url ?? "");
}

function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalize a DNS root dot before rejecting IPs, single labels, and known internal suffixes. */
export function printableHost(host: string): string {
  const normalized = host.trim().replace(/\.$/, "").toLowerCase();
  if (!normalized) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return "";
  if (normalized.includes(":")) return ""; // IPv6 literal
  if (!normalized.includes(".")) return ""; // "localhost", "intranet"
  if (/(^|\.)(localhost|test|localdomain|home|private|local|internal|intranet|lan|corp|home\.arpa)$/.test(normalized)) {
    return "";
  }
  return normalized;
}

/** The wire-safe stand-in for a captured entity: the site, else the intent category. */
export function safeCaptureLabel(provenance: CapturedProvenance, intentCategory: string): string {
  return printableHost(displayHost(hostnameOf(provenance?.url ?? ""))) || intentCategory || CAPTURED_PAGE_LABEL;
}

/**
 * True when `entity` carries anything taken from the page.
 *
 * Called at capture with the frame in hand, and again on the frame path
 * (`wireSafeUserState`) where the frame is still available. Over-redacting costs
 * the agent a less specific label; under-redacting ships the page.
 */
export function focusEntityDerivedFromPageTitle(
  entity: string,
  provenance: CapturedProvenance,
  intentCategory: string
): boolean {
  if (isDeviceProvenance(provenance?.url)) return false;
  const value = normalizeForMatch(entity);
  if (!value) return false;
  return value !== normalizeForMatch(safeCaptureLabel(provenance, intentCategory));
}

/**
 * The label to store for a title-derived entity when the frame is far away —
 * used to rebuild a goal string that already embeds the entity.
 */
export function safeGoalTitle(goalTitle: string, entity: string, label: string): string {
  const trimmed = goalTitle.trim();
  const entitySuffix = `: ${entity.trim()}`;
  if (trimmed.endsWith(entitySuffix)) {
    return `${trimmed.slice(0, trimmed.length - entitySuffix.length)}: ${label}`;
  }
  return label;
}
