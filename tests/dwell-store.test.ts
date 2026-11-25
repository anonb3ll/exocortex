/**
 * Worker-side dwell updates: a visit's rows are found by (url, capturedAt) and
 * their dwell is raised to the latest cumulative total.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import { captureContext } from "../src/lib/context-workflow";
import { createCognitiveFrame } from "../src/lib/models/cognitive-frame";
import { recallLatestContext } from "../src/lib/context-workflow";
import { applyVisitDwell, findVisitMeta, visitKey, VisitLedger } from "../src/lib/dwell-store";

const URL_A = "https://example.com/a";
const CAPTURED_AT = 1_800_000_000_000;

async function seedVisit(url = URL_A, capturedAt = CAPTURED_AT, dwellMs = 5_000) {
  await captureContext({ url, title: "Page A", textContent: "text", timestamp: capturedAt, dwellTime: dwellMs });
  const frameId = await db.frames.add({
    url,
    title: "Page A",
    domain: "example.com",
    dwellTime: Math.round(dwellMs / 1000),
    timestamp: capturedAt,
    siteName: "Example",
    byline: "Jane Doe",
    contentKind: "article"
  });
  const frame = createCognitiveFrame({
    sessionId: "s1",
    url,
    pageTitle: "Page A",
    activeDwellSeconds: Math.round(dwellMs / 1000),
    timestampUtc: capturedAt
  });
  await db.cognitive_frames.put(frame);
  return { frameId, cognitiveFrameId: frame.frameId };
}

describe("applyVisitDwell", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("raises dwell on the dwell block, the frame and the cognitive frame of the visit", async () => {
    const { frameId, cognitiveFrameId } = await seedVisit();

    const updated = await applyVisitDwell({ url: URL_A, capturedAt: CAPTURED_AT, dwellDurationMs: 754_000 });
    expect(updated).toEqual({ dwellBlocks: 1, frames: 1, cognitiveFrames: 1 });

    expect((await db.dwell_blocks.toArray())[0].dwellTime).toBe(754_000);
    expect((await db.frames.get(frameId))!.dwellTime).toBe(754);
    const cognitive = await db.cognitive_frames.where("frameId").equals(cognitiveFrameId).first();
    expect(cognitive!.provenance.activeDwellSeconds).toBe(754);

    // "Where was I" now reports the real time on the page.
    expect((await recallLatestContext())!.dwellSeconds).toBe(754);
  });

  test("dwell only grows: a late, smaller update changes nothing", async () => {
    const { frameId } = await seedVisit(URL_A, CAPTURED_AT, 60_000);

    const updated = await applyVisitDwell({ url: URL_A, capturedAt: CAPTURED_AT, dwellDurationMs: 20_000 });
    expect(updated).toEqual({ dwellBlocks: 0, frames: 0, cognitiveFrames: 0 });
    expect((await db.dwell_blocks.toArray())[0].dwellTime).toBe(60_000);
    expect((await db.frames.get(frameId))!.dwellTime).toBe(60);
  });

  test("only the addressed visit is touched", async () => {
    const first = await seedVisit(URL_A, CAPTURED_AT);
    // Same page visited again later, and a different page captured in the same millisecond.
    const again = await seedVisit(URL_A, CAPTURED_AT + 3_600_000);
    const other = await seedVisit("https://example.com/b", CAPTURED_AT);

    await applyVisitDwell({ url: URL_A, capturedAt: CAPTURED_AT, dwellDurationMs: 300_000 });

    expect((await db.frames.get(first.frameId))!.dwellTime).toBe(300);
    expect((await db.frames.get(again.frameId))!.dwellTime).toBe(5);
    expect((await db.frames.get(other.frameId))!.dwellTime).toBe(5);
  });

  test("an update for a visit that was never captured writes nothing", async () => {
    const updated = await applyVisitDwell({ url: URL_A, capturedAt: CAPTURED_AT, dwellDurationMs: 90_000 });
    expect(updated).toEqual({ dwellBlocks: 0, frames: 0, cognitiveFrames: 0 });
    expect(await db.dwell_blocks.count()).toBe(0);
    expect(await db.frames.count()).toBe(0);
  });
});

describe("findVisitMeta", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("returns the frame's stored metadata", async () => {
    await seedVisit();
    expect(await findVisitMeta(URL_A, CAPTURED_AT)).toEqual({
      title: "Page A",
      siteName: "Example",
      byline: "Jane Doe",
      contentKind: "article"
    });
  });

  test("falls back to the dwell block while the frame is not written yet", async () => {
    await captureContext({ url: URL_A, title: "Page A", timestamp: CAPTURED_AT, dwellTime: 5_000 });
    expect(await findVisitMeta(URL_A, CAPTURED_AT)).toEqual({
      title: "Page A",
      siteName: "example.com",
      byline: "",
      contentKind: "page"
    });
  });

  test("an unknown visit has no metadata", async () => {
    expect(await findVisitMeta(URL_A, CAPTURED_AT)).toBeNull();
  });
});

describe("VisitLedger", () => {
  test("keeps the largest total, including one noted before the record was opened", () => {
    const ledger = new VisitLedger();
    const key = visitKey(URL_A, CAPTURED_AT);
    expect(ledger.dwellMs(key)).toBeUndefined();

    // An update that overtakes its own record in the worker.
    expect(ledger.noteDwell(key, 90_000)).toBe(90_000);
    // The record then arrives with the smaller initial dwell.
    expect(ledger.noteDwell(key, 5_000)).toBe(90_000);
    expect(ledger.dwellMs(key)).toBe(90_000);
  });

  test("the same URL at another capture time is another visit", () => {
    const ledger = new VisitLedger();
    ledger.noteDwell(visitKey(URL_A, CAPTURED_AT), 90_000);
    expect(ledger.dwellMs(visitKey(URL_A, CAPTURED_AT + 1))).toBeUndefined();
  });

  test("metadata is only attached to a visit the ledger knows", () => {
    const ledger = new VisitLedger();
    const key = visitKey(URL_A, CAPTURED_AT);
    const meta = { title: "t", siteName: "s", byline: "", contentKind: "page" as const };
    ledger.setMeta(key, meta);
    expect(ledger.meta(key)).toBeUndefined();
    ledger.noteDwell(key, 1);
    ledger.setMeta(key, meta);
    expect(ledger.meta(key)).toEqual(meta);
  });

  test("is bounded", () => {
    const ledger = new VisitLedger(3);
    for (let i = 0; i < 10; i += 1) ledger.noteDwell(visitKey(URL_A, i + 1), 1_000);
    expect(ledger.dwellMs(visitKey(URL_A, 1))).toBeUndefined();
    expect(ledger.dwellMs(visitKey(URL_A, 10))).toBe(1_000);
  });
});
