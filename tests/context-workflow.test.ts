import { beforeEach, describe, expect, test } from "bun:test";

import { db } from "../src/lib/db";
import { captureContext, recallLatestContext } from "../src/lib/context-workflow";

describe("local context workflow", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("captures a page, recalls its context, and exposes a resume action", async () => {
    await captureContext({
      url: "https://example.com/exocortex-workflow",
      title: "Exocortex workflow design",
      excerpt: "Capture context, recall it later, and resume the useful next action.",
      textContent: "A local context workflow preserves enough provenance to resume work.",
      timestamp: 1_700_000_000_000,
      dwellTime: 12_000
    });

    await expect(recallLatestContext()).resolves.toEqual({
      title: "Exocortex workflow design",
      url: "https://example.com/exocortex-workflow",
      excerpt: "Capture context, recall it later, and resume the useful next action.",
      capturedAt: 1_700_000_000_000,
      dwellSeconds: 12,
      provenance: {
        source: "local-dexie",
        url: "https://example.com/exocortex-workflow",
        capturedAt: 1_700_000_000_000
      },
      resumeAction: {
        type: "reopen-tab",
        url: "https://example.com/exocortex-workflow",
        label: "Reopen Page"
      }
    });
  });

  test("redacts page fields and embedded credential URLs before storing or recalling them", async () => {
    const marker = "fixture-only-material42";
    const embedded = `https://example.com/share?access_token=${marker}`;
    const title = `Build notes Bearer ${marker}`;
    const url = `https://example.com/notes?topic=build&redirect=${encodeURIComponent(embedded)}`;
    expect(await captureContext({
      url, title, excerpt: `Read ${embedded}`, textContent: `secret=${marker}`,
      byline: `password=${marker}`, siteName: `Bearer ${marker}`,
      timestamp: 1_700_000_000_000, dwellTime: 6_000
    })).toBe(true);

    const page = await db.page_text.toArray();
    const dwell = await db.dwell_blocks.toArray();
    const recalled = await recallLatestContext();
    expect(page).toHaveLength(1);
    expect(dwell).toHaveLength(1);
    expect(JSON.stringify({ page, dwell, recalled }).includes(marker)).toBe(false);
    expect(recalled).toMatchObject({
      title: "Build notes Bearer [REDACTED_TOKEN]",
      url: "https://example.com/notes?topic=build",
      excerpt: "Read https://example.com/share"
    });
  });

  test("refuses to persist a credential-bearing path rather than inventing a resume URL", async () => {
    const marker = "ghp_" + "SYNTHETIC_ONLY_NOT_A_KEY".replaceAll("_", "");
    await expect(captureContext({
      url: `https://example.com/share/${encodeURIComponent(marker)}`,
      title: "Share", textContent: "Page text",
      timestamp: 1_700_000_000_000, dwellTime: 6_000
    })).resolves.toBe(false);
    expect(await db.page_text.count()).toBe(0);
    expect(await db.dwell_blocks.count()).toBe(0);
  });

  test("returns no context before the first local capture", async () => {
    await expect(recallLatestContext()).resolves.toBeNull();
  });

  test("fails closed for blocked URLs and sanitizes sensitive query parameters", async () => {
    await expect(
      captureContext({
        url: "https://bank.example/account",
        title: "Sensitive account",
        textContent: "must not be captured",
        timestamp: 1_700_000_000_000,
        dwellTime: 5_000
      })
    ).resolves.toBe(false);
    await expect(recallLatestContext()).resolves.toBeNull();

    await expect(
      captureContext({
        url: "https://example.com/research?token=secret&topic=anchors",
        title: "Anchor research",
        textContent: "Local content",
        timestamp: 1_700_000_000_001,
        dwellTime: 5_000
      })
    ).resolves.toBe(true);
    await expect(recallLatestContext()).resolves.toMatchObject({
      url: "https://example.com/research?topic=anchors",
      provenance: { url: "https://example.com/research?topic=anchors" },
      resumeAction: { url: "https://example.com/research?topic=anchors" }
    });
  });
});
