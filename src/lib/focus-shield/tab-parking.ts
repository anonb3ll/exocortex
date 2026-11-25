/** Pure tab-selection policy for the Focus Shield's non-destructive grouping. */

export const PARKED_GROUP_TITLE = "Exocortex — Parked Context";
export const PARKED_GROUP_IDS_STORAGE_KEY = "focus_shield_parked_group_ids";
export const TAB_CONTEXT_SIGNALS_STORAGE_KEY = "focus_shield_tab_context_signals";
export const MAX_PERSISTED_TAB_CONTEXT_SIGNALS = 100;

export interface TabContextSignal {
  tabId: number;
  intentCategory: string;
  url: string;
  title: string;
}

export function normalizeOwnedParkedGroupIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((groupId): groupId is number => Number.isInteger(groupId) && groupId >= 0))];
}

export function addOwnedParkedGroupId(groupIds: readonly number[], groupId: number): number[] {
  return normalizeOwnedParkedGroupIds([...groupIds, groupId]);
}

export function normalizeTabContextSignals(value: unknown): TabContextSignal[] {
  if (!Array.isArray(value)) return [];
  const byTabId = new Map<number, TabContextSignal>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const signal = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(signal.tabId) ||
      (signal.tabId as number) < 0 ||
      typeof signal.intentCategory !== "string" ||
      typeof signal.url !== "string" ||
      !signal.url ||
      typeof signal.title !== "string"
    ) {
      continue;
    }
    byTabId.set(signal.tabId as number, {
      tabId: signal.tabId as number,
      intentCategory: signal.intentCategory,
      url: signal.url,
      title: signal.title
    });
  }
  return [...byTabId.values()].slice(-MAX_PERSISTED_TAB_CONTEXT_SIGNALS);
}

export function upsertTabContextSignal(signals: readonly TabContextSignal[], next: TabContextSignal): TabContextSignal[] {
  return normalizeTabContextSignals([...signals.filter((signal) => signal.tabId !== next.tabId), next]);
}

export interface ParkableTab {
  id: number;
  active?: boolean;
  pinned?: boolean;
  groupId?: number;
  url?: string;
  classifiedUrl?: string;
  intentCategory?: string;
}

const SPECIAL_SCHEMES = /^(?:chrome|chrome-extension|edge|about|brave|file|view-source):/i;

export function isTabEligibleForParking(tab: ParkableTab, activeTabId?: number): boolean {
  if (!Number.isInteger(tab.id) || tab.id < 0) return false;
  if (tab.active || tab.id === activeTabId || tab.pinned) return false;
  if (tab.groupId !== undefined && tab.groupId !== -1) return false;
  if (!tab.url || SPECIAL_SCHEMES.test(tab.url)) return false;
  if (!tab.classifiedUrl || tab.classifiedUrl !== tab.url) return false;
  return tab.intentCategory === "Distraction / Rabbit Hole";
}

export function selectTabsToPark(tabs: ParkableTab[], activeTabId?: number): number[] {
  return tabs.filter((tab) => isTabEligibleForParking(tab, activeTabId)).map((tab) => tab.id);
}
