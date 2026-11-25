import { describe, expect, it } from "bun:test";
import {
  determineMobileFreshness,
  determineMobileHealth,
  renderMobileFocusGlance,
  renderMobileRecall,
  renderMobileSliceView,
  type MobileSliceViewDocument
} from "../src/sidepanel/mobile-slice-view";
import type { MobileFocusGlance, MobileRecallResponse } from "../src/lib/mobile-slice";

function createMockElement(id: string) {
  return {
    id,
    textContent: "" as string | null,
    innerHTML: "" as string,
    className: "" as string,
    hidden: false as boolean | string,
    classList: {
      _classes: new Set<string>(),
      add(...cls: string[]) {
        cls.forEach((c) => this._classes.add(c));
        this._sync();
      },
      remove(...cls: string[]) {
        cls.forEach((c) => this._classes.delete(c));
        this._sync();
      },
      contains(c: string) {
        return this._classes.has(c);
      },
      _sync() {
        // sync
      }
    }
  };
}

function createMockDocument(): MobileSliceViewDocument & { elements: Map<string, ReturnType<typeof createMockElement>> } {
  const elements = new Map<string, ReturnType<typeof createMockElement>>();
  const ids = [
    "mobile-slice-panel",
    "mobile-freshness-badge",
    "mobile-health-badge",
    "mobile-focus-card",
    "mobile-focus-entity",
    "mobile-state-digest",
    "mobile-intent-category",
    "mobile-cognitive-load",
    "mobile-task-ref",
    "mobile-origin-ref",
    "mobile-focus-updated",
    "mobile-recall-status",
    "mobile-recall-list"
  ];
  for (const id of ids) {
    elements.set(id, createMockElement(id));
  }

  return {
    elements,
    getElementById(id: string) {
      return elements.get(id) || null;
    }
  };
}

describe("Mobile Slice View in Sidepanel (Task #462 TDD)", () => {
  describe("Freshness & Health State Determination", () => {
    it("determines live freshness for recent timestamps (< 5 mins)", () => {
      const now = 1000000000;
      const recent = now - 60 * 1000; // 1 min ago
      expect(determineMobileFreshness(recent, now)).toBe("live");
    });

    it("determines stale freshness for older timestamps (5 mins - 24 hours)", () => {
      const now = 1000000000;
      const stale = now - 15 * 60 * 1000; // 15 mins ago
      expect(determineMobileFreshness(stale, now)).toBe("stale");
    });

    it("determines offline freshness for timestamps older than 24 hours or missing", () => {
      const now = 1000000000;
      const ancient = now - 25 * 3600 * 1000; // 25 hours ago
      expect(determineMobileFreshness(ancient, now)).toBe("offline");
      expect(determineMobileFreshness(undefined, now)).toBe("offline");
    });

    it("determines corresponding health status from freshness and errors", () => {
      expect(determineMobileHealth("live", false)).toBe("healthy");
      expect(determineMobileHealth("stale", false)).toBe("degraded");
      expect(determineMobileHealth("offline", false)).toBe("unavailable");
      expect(determineMobileHealth("live", true)).toBe("degraded");
    });
  });

  describe("Focus Glance Rendering", () => {
    it("renders active focus glance with all fields and task reference", () => {
      const doc = createMockDocument();
      const mockGlance: MobileFocusGlance = {
        contract_version: "1.0",
        status: "live",
        focusEntity: "Investigating Unified Agent Workflows",
        stateDigest: "Refactoring step executor at [redacted-link]",
        intentCategory: "Deep Work (Drafting/Coding)",
        cognitiveLoadLevel: "Medium",
        updatedAt: 1723805000000,
        suggestedTaskRef: "ua://task/421",
        originRef: "0a1b2c3d4e5f6789"
      };

      renderMobileFocusGlance(doc, mockGlance);

      expect(doc.getElementById("mobile-focus-entity")?.textContent).toBe("Investigating Unified Agent Workflows");
      expect(doc.getElementById("mobile-state-digest")?.textContent).toBe("Refactoring step executor at [redacted-link]");
      expect(doc.getElementById("mobile-intent-category")?.textContent).toBe("Deep Work (Drafting/Coding)");
      expect(doc.getElementById("mobile-cognitive-load")?.textContent).toBe("Medium");
      expect(doc.getElementById("mobile-task-ref")?.textContent).toBe("ua://task/421");
      expect(doc.getElementById("mobile-task-ref")?.hidden).toBe(false);
      expect(doc.getElementById("mobile-origin-ref")?.textContent).toBe("0a1b2c3d4e5f6789");
    });

    it("renders empty focus state gracefully without collapsing into blank panel", () => {
      const doc = createMockDocument();
      const emptyGlance: MobileFocusGlance = {
        contract_version: "1.0",
        status: "empty",
        focusEntity: "No active focus",
        stateDigest: "No active working state captured",
        intentCategory: "Idle / Transition",
        cognitiveLoadLevel: "Low",
        updatedAt: Date.now(),
        suggestedTaskRef: null,
        originRef: "0000000000000000"
      };

      renderMobileFocusGlance(doc, emptyGlance);

      expect(doc.getElementById("mobile-focus-entity")?.textContent).toBe("No active focus");
      expect(doc.getElementById("mobile-state-digest")?.textContent).toBe("No active working state captured");
      expect(doc.getElementById("mobile-task-ref")?.hidden).toBe(true);
    });
  });

  describe("Mobile Recall State Rendering (4 distinct states)", () => {
    it("State 1: 'ok' - renders sanitized items with opaque mem_<id> handles and no raw URLs", () => {
      const doc = createMockDocument();
      const resp: MobileRecallResponse = {
        status: "ok",
        query: "sqlite",
        results: [
          {
            handle: "mem_101",
            title: "sqlite3 — DB-API 2.0 interface",
            excerpt: "SQLite provides a lightweight database at [redacted-link].",
            parsedAt: 1723800000000,
            score: 3
          }
        ],
        totalCount: 1
      };

      renderMobileRecall(doc, resp);

      const statusEl = doc.getElementById("mobile-recall-status");
      const listEl = doc.getElementById("mobile-recall-list");

      expect(statusEl?.textContent).toContain("1 match for \"sqlite\"");
      expect(listEl?.innerHTML).toContain("mem_101");
      expect(listEl?.innerHTML).toContain("sqlite3 — DB-API 2.0 interface");
      expect(listEl?.innerHTML).toContain("[redacted-link]");
      // Strict privacy check: no http/https URLs rendered
      expect(listEl?.innerHTML).not.toContain("http://");
      expect(listEl?.innerHTML).not.toContain("https://");
    });

    it("State 2: 'empty' - renders distinct empty notice", () => {
      const doc = createMockDocument();
      const resp: MobileRecallResponse = {
        status: "empty",
        query: "nonexistent",
        results: [],
        totalCount: 0
      };

      renderMobileRecall(doc, resp);

      const statusEl = doc.getElementById("mobile-recall-status");
      const listEl = doc.getElementById("mobile-recall-list");

      expect(statusEl?.textContent).toBe("No matching mobile memory found.");
      expect(listEl?.innerHTML).toContain("empty-state");
      expect(listEl?.innerHTML).toContain("No results for query \"nonexistent\"");
    });

    it("State 3: 'privacy_blocked' - renders explicit privacy shield banner (fail-closed)", () => {
      const doc = createMockDocument();
      const resp: MobileRecallResponse = {
        status: "privacy_blocked",
        query: "[blocked-query]",
        results: [],
        totalCount: 0,
        errorMessage: "Search query matches privacy blocklist"
      };

      renderMobileRecall(doc, resp);

      const statusEl = doc.getElementById("mobile-recall-status");
      const listEl = doc.getElementById("mobile-recall-list");

      expect(statusEl?.textContent).toContain("Privacy Guard Block");
      expect(listEl?.innerHTML).toContain("privacy-blocked-state");
      expect(listEl?.innerHTML).toContain("Search query matches privacy blocklist");
      expect(listEl?.innerHTML).not.toContain("http://");
      expect(listEl?.innerHTML).not.toContain("https://");
    });

    it("State 4: 'error' - renders distinct service error state", () => {
      const doc = createMockDocument();
      const resp: MobileRecallResponse = {
        status: "error",
        query: "test",
        results: [],
        totalCount: 0,
        errorMessage: "Local database read timeout"
      };

      renderMobileRecall(doc, resp);

      const statusEl = doc.getElementById("mobile-recall-status");
      const listEl = doc.getElementById("mobile-recall-list");

      expect(statusEl?.textContent).toContain("Error");
      expect(listEl?.innerHTML).toContain("error-state");
      expect(listEl?.innerHTML).toContain("Local database read timeout");
    });
  });

  describe("Top-Level Envelope Integration (3 freshness states)", () => {
    it("renders live + healthy envelope", () => {
      const doc = createMockDocument();
      const glance: MobileFocusGlance = {
        contract_version: "1.0",
        status: "live",
        focusEntity: "Task Execution",
        stateDigest: "Executing step 3",
        intentCategory: "Coding",
        cognitiveLoadLevel: "Low",
        updatedAt: Date.now(),
        suggestedTaskRef: null,
        originRef: "abc123"
      };
      const recall: MobileRecallResponse = {
        status: "ok",
        query: "task",
        results: [],
        totalCount: 0
      };

      renderMobileSliceView(doc, {
        focus: glance,
        recall,
        freshness: "live",
        health: "healthy"
      });

      const freshnessEl = doc.getElementById("mobile-freshness-badge");
      const healthEl = doc.getElementById("mobile-health-badge");

      expect(freshnessEl?.textContent).toBe("LIVE");
      expect(freshnessEl?.classList.contains("freshness-live")).toBe(true);
      expect(healthEl?.textContent).toBe("HEALTHY");
      expect(healthEl?.classList.contains("health-healthy")).toBe(true);
    });

    it("renders stale + degraded envelope", () => {
      const doc = createMockDocument();
      const glance: MobileFocusGlance = {
        contract_version: "1.0",
        status: "stale",
        focusEntity: "Task Execution",
        stateDigest: "Executing step 3",
        intentCategory: "Coding",
        cognitiveLoadLevel: "Low",
        updatedAt: Date.now() - 10 * 60 * 1000,
        suggestedTaskRef: null,
        originRef: "abc123"
      };
      const recall: MobileRecallResponse = {
        status: "empty",
        query: "",
        results: [],
        totalCount: 0
      };

      renderMobileSliceView(doc, {
        focus: glance,
        recall,
        freshness: "stale",
        health: "degraded"
      });

      const freshnessEl = doc.getElementById("mobile-freshness-badge");
      const healthEl = doc.getElementById("mobile-health-badge");

      expect(freshnessEl?.textContent).toBe("STALE");
      expect(freshnessEl?.classList.contains("freshness-stale")).toBe(true);
      expect(healthEl?.textContent).toBe("DEGRADED");
      expect(healthEl?.classList.contains("health-degraded")).toBe(true);
    });

    it("renders offline + unavailable envelope", () => {
      const doc = createMockDocument();
      const glance: MobileFocusGlance = {
        contract_version: "1.0",
        status: "offline",
        focusEntity: "No active focus",
        stateDigest: "No active working state captured",
        intentCategory: "Idle",
        cognitiveLoadLevel: "Low",
        updatedAt: Date.now() - 48 * 3600 * 1000,
        suggestedTaskRef: null,
        originRef: "0000000000000000"
      };
      const recall: MobileRecallResponse = {
        status: "empty",
        query: "",
        results: [],
        totalCount: 0
      };

      renderMobileSliceView(doc, {
        focus: glance,
        recall,
        freshness: "offline",
        health: "unavailable"
      });

      const freshnessEl = doc.getElementById("mobile-freshness-badge");
      const healthEl = doc.getElementById("mobile-health-badge");

      expect(freshnessEl?.textContent).toBe("OFFLINE");
      expect(freshnessEl?.classList.contains("freshness-offline")).toBe(true);
      expect(healthEl?.textContent).toBe("UNAVAILABLE");
      expect(healthEl?.classList.contains("health-unavailable")).toBe(true);
    });
  });
});
