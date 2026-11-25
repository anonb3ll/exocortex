import { sanitizeCaptureUrl } from "../../content/privacy";
import { OBSERVER_STATE_STORAGE_KEY, type ObserverPersistenceState, type StateObserverAgent } from "../agents/state-observer";
import {
  normalizeTabContextSignals,
  TAB_CONTEXT_SIGNALS_STORAGE_KEY,
  type TabContextSignal
} from "./tab-parking";
import type { FocusShieldManager } from "./focus-shield";

export const FOCUS_SHIELD_STORAGE_DEFAULTS = {
  focus_shield_enabled: false,
  fatigueThreshold: 80,
  minInterventionIntervalMs: 30 * 60 * 1000,
  focus_shield_last_intervention_at: 0,
  [OBSERVER_STATE_STORAGE_KEY]: null,
  [TAB_CONTEXT_SIGNALS_STORAGE_KEY]: []
} as const;

export interface FocusShieldStorage {
  get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface FocusShieldTabSnapshot {
  id?: number;
  url?: string;
}

export interface FocusShieldConfigLoadDependencies {
  storage: FocusShieldStorage;
  queryTabs: () => Promise<FocusShieldTabSnapshot[]>;
  focusShieldManager: Pick<FocusShieldManager, "configure" | "restoreLastInterventionTime">;
  stateObserver: Pick<StateObserverAgent, "restorePersistenceState">;
}

/** Load persisted Focus Shield state and retain only classifications for live matching tabs. */
export async function loadFocusShieldConfig({
  storage,
  queryTabs,
  focusShieldManager,
  stateObserver
}: FocusShieldConfigLoadDependencies): Promise<TabContextSignal[]> {
  const values = await storage.get(FOCUS_SHIELD_STORAGE_DEFAULTS);
  focusShieldManager.configure({
    enabled: values.focus_shield_enabled === true,
    fatigueThreshold: typeof values.fatigueThreshold === "number" ? values.fatigueThreshold : 80,
    minInterventionIntervalMs:
      typeof values.minInterventionIntervalMs === "number" ? values.minInterventionIntervalMs : 30 * 60 * 1000
  });
  if (typeof values.focus_shield_last_intervention_at === "number") {
    focusShieldManager.restoreLastInterventionTime(values.focus_shield_last_intervention_at);
  }
  stateObserver.restorePersistenceState(values[OBSERVER_STATE_STORAGE_KEY]);

  const persistedSignals = normalizeTabContextSignals(values[TAB_CONTEXT_SIGNALS_STORAGE_KEY]);
  let tabs: FocusShieldTabSnapshot[] = [];
  try {
    tabs = await queryTabs();
  } catch {
    // A browser shutdown can race service-worker startup; the next startup retries.
  }
  return persistedSignals.filter((signal) => {
    const tab = tabs.find((candidate) => candidate.id === signal.tabId);
    return Boolean(tab?.url && sanitizeCaptureUrl(tab.url) === signal.url);
  });
}

export function persistObserverState(
  storage: FocusShieldStorage,
  stateObserver: Pick<StateObserverAgent, "getPersistenceState">
): Promise<void> {
  const state: ObserverPersistenceState = stateObserver.getPersistenceState();
  return storage.set({ [OBSERVER_STATE_STORAGE_KEY]: state });
}

export function persistTabContextSignals(
  storage: FocusShieldStorage,
  signals: Iterable<TabContextSignal>
): Promise<void> {
  return storage.set({ [TAB_CONTEXT_SIGNALS_STORAGE_KEY]: [...signals] });
}

export async function withFocusShieldReady<T>(ready: Promise<unknown>, operation: () => Promise<T>): Promise<T> {
  await ready;
  return operation();
}

export async function removeTabContextSignalAfterReady(
  ready: Promise<unknown>,
  storage: FocusShieldStorage,
  signals: Map<number, TabContextSignal>,
  tabId: number
): Promise<void> {
  await withFocusShieldReady(ready, async () => {
    signals.delete(tabId);
    await persistTabContextSignals(storage, signals.values());
  });
}

export function isMatchingActiveCaptureTab(
  activeTabs: readonly FocusShieldTabSnapshot[],
  tabId: number,
  cleanUrl: string
): boolean {
  const activeTab = activeTabs.find((tab) => tab.id === tabId);
  return Boolean(activeTab?.url && sanitizeCaptureUrl(activeTab.url) === cleanUrl);
}
