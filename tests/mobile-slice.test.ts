import { describe, expect, it } from "bun:test";
import {
  MOBILE_SLICE_VERSION,
  sanitizeMobileText,
  searchMobileMemoryPure,
  projectMobileFocusGlance,
  buildMobileStateEnvelope,
  PageRecordLike
} from "../src/lib/mobile-slice";

describe("Exocortex Mobile Thin Slice (Tasks #408, #411, #421)", () => {
  describe("sanitizeMobileText", () => {
    it("redacts http and https URLs", () => {
      const text = "Check out https://example.com/project for details";
      expect(sanitizeMobileText(text)).toBe("Check out [redacted-link] for details");
    });

    it("redacts www URLs", () => {
      const text = "Visit www.example.com today";
      expect(sanitizeMobileText(text)).toBe("Visit [redacted-link] today");
    });

    it("enforces max length with ellipsis", () => {
      const longText = "A".repeat(50);
      const sanitized = sanitizeMobileText(longText, 20);
      expect(sanitized.length).toBe(20);
      expect(sanitized.endsWith("…")).toBe(true);
    });

    it("handles empty or invalid inputs gracefully", () => {
      expect(sanitizeMobileText("")).toBe("");
      expect(sanitizeMobileText(null as unknown as string)).toBe("");
    });
  });

  describe("searchMobileMemoryPure", () => {
    const mockPages: PageRecordLike[] = [
      {
        id: 101,
        url: "https://docs.python.org/3/library/sqlite3.html",
        title: "sqlite3 — DB-API 2.0 interface for SQLite databases",
        textContent: "SQLite is a C library that provides a lightweight disk-based database.",
        excerpt: "SQLite provides a lightweight disk-based database at https://sqlite.org.",
        parsedAt: 1723800000000
      },
      {
        id: 102,
        url: "https://chase.com/banking/my-account",
        title: "Chase Bank - Account Balance and Statement",
        textContent: "Your current checking account balance is confidential.",
        parsedAt: 1723800010000
      },
      {
        id: 103,
        url: "https://login.example.com/oauth/authorize",
        title: "Sign In - OAuth Portal",
        textContent: "Enter password and token to authenticate.",
        parsedAt: 1723800020000
      },
      {
        id: 104,
        url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
        title: "IndexedDB API - Web APIs | MDN",
        textContent: "IndexedDB is a low-level API for client-side storage of significant amounts of structured data.",
        parsedAt: 1723800030000
      }
    ];

    it("returns sanitized results with opaque handles", () => {
      const resp = searchMobileMemoryPure("sqlite", mockPages);
      expect(resp.status).toBe("ok");
      expect(resp.results.length).toBe(1);
      const item = resp.results[0];
      expect(item.handle).toBe("mem_101");
      expect(item.title).toContain("sqlite3");
      expect(item.excerpt).toContain("[redacted-link]");
      expect(item.score).toBeGreaterThan(0);
    });

    it("strictly filters sensitive and banking URLs from recall results", () => {
      const respBank = searchMobileMemoryPure("account", mockPages);
      // Even though page 102 has "account" in title/content, it is blocked
      expect(respBank.results.find((r) => r.handle === "mem_102")).toBeUndefined();

      const respLogin = searchMobileMemoryPure("password", mockPages);
      expect(respLogin.results.find((r) => r.handle === "mem_103")).toBeUndefined();
    });

    it("fails closed when the search query itself matches sensitive or blocked domains", () => {
      const resp = searchMobileMemoryPure("https://chase.com/login", mockPages);
      expect(resp.status).toBe("privacy_blocked");
      expect(resp.results).toEqual([]);
      expect(resp.errorMessage).toContain("privacy blocklist");
    });

    it("bare-brand queries pass the query guard; the URL guard still filters result pages", () => {
      // Canonical contract (docs/privacy-guard.md "Two query guards"): the query
      // guard is narrower than the URL guard, so a bare brand is searchable —
      // but the chase.com page itself is still filtered out of the results.
      const brandQuery = searchMobileMemoryPure("chase", mockPages);
      expect(brandQuery.status).not.toBe("privacy_blocked");
      expect(brandQuery.results.some((result) => result.handle === "mem_102")).toBe(false);

      const fqdnQuery = searchMobileMemoryPure("chase.com", mockPages);
      expect(fqdnQuery.status).toBe("privacy_blocked");
      expect(fqdnQuery.results).toEqual([]);

      const allowedQuery = searchMobileMemoryPure("account", mockPages);
      expect(allowedQuery.results.some((result) => result.handle === "mem_102")).toBe(false);
    });

    it("handles empty query or no match cleanly", () => {
      const emptyResp = searchMobileMemoryPure("", mockPages);
      expect(emptyResp.status).toBe("empty");
      expect(emptyResp.results).toEqual([]);

      const noMatchResp = searchMobileMemoryPure("nonexistentquery123", mockPages);
      expect(noMatchResp.status).toBe("empty");
      expect(noMatchResp.results).toEqual([]);
    });

    it("omits records without a positive integer page id", () => {
      const resp = searchMobileMemoryPure("sqlite", [
        { ...mockPages[0], id: undefined },
        { ...mockPages[0], id: 0 },
        { ...mockPages[0], id: -1 },
        { ...mockPages[0], id: 1.5 },
        { ...mockPages[0], id: 105 }
      ]);

      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].handle).toBe("mem_105");
      expect(resp.results.some((result) => result.handle === "mem_0")).toBe(false);
    });
  });

  describe("projectMobileFocusGlance", () => {
    it("projects an active focus anchor into a glanceable mobile payload", async () => {
      const glance = await projectMobileFocusGlance(
        {
          activeFocusEntity: "Investigating Unified Agent Workflows",
          workingStateSummary: "Refactoring step executor at https://github.com/example/repo",
          intentCategory: "Deep Work (Drafting/Coding)",
          cognitiveLoadLevel: "Medium",
          timestampUtc: 1723805000000,
          url: "https://github.com/example/repo"
        },
        {
          originMachine: "DesktopUbuntu",
          freshness: "live",
          suggestedTaskId: 421
        }
      );

      expect(glance.contract_version).toBe(MOBILE_SLICE_VERSION);
      expect(glance.status).toBe("live");
      expect(glance.focusEntity).toBe("Investigating Unified Agent Workflows");
      expect(glance.stateDigest).toBe("Refactoring step executor at [redacted-link]");
      expect(glance.intentCategory).toBe("Deep Work (Drafting/Coding)");
      expect(glance.cognitiveLoadLevel).toBe("Medium");
      expect(glance.suggestedTaskRef).toBe("ua://task/421");
      expect(glance.originRef).toBeDefined();
    });

    it("returns honest empty glance when focus source is null", async () => {
      const glance = await projectMobileFocusGlance(null);
      expect(glance.status).toBe("empty");
      expect(glance.focusEntity).toBe("No active focus");
      expect(glance.suggestedTaskRef).toBeNull();
    });
  });

  describe("buildMobileStateEnvelope", () => {
    it("wraps focus, recalls, and health into a versioned envelope", async () => {
      const glance = await projectMobileFocusGlance(null);
      const envelope = buildMobileStateEnvelope({
        focus: glance,
        recalls: [
          {
            handle: "mem_50",
            title: "Task Coordination",
            excerpt: "Task management reference",
            parsedAt: 1723800000000,
            score: 3
          }
        ],
        freshness: "live",
        serviceHealth: "healthy"
      });

      expect(envelope.contract_version).toBe(MOBILE_SLICE_VERSION);
      expect(envelope.projection_id.startsWith("exo_mob_")).toBe(true);
      expect(envelope.freshness).toBe("live");
      expect(envelope.service_health).toBe("healthy");
      expect(envelope.recalls.length).toBe(1);
      expect(envelope.error_code).toBeNull();
    });

    it("sanitizes error message if present", async () => {
      const glance = await projectMobileFocusGlance(null);
      const envelope = buildMobileStateEnvelope({
        focus: glance,
        freshness: "offline",
        serviceHealth: "unavailable",
        errorCode: "hub_unavailable",
        errorMessage: "Failed connecting to https://hub.internal/stream"
      });

      expect(envelope.freshness).toBe("offline");
      expect(envelope.service_health).toBe("unavailable");
      expect(envelope.error_code).toBe("hub_unavailable");
      expect(envelope.error_message).toBe("Failed connecting to [redacted-link]");
    });
  });
});
