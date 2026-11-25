/**
 * The tracker and the service worker must agree on the dwell payload.
 *
 * They did not: the tracker sent `dwellDurationMs` / `capturedAt`, the worker
 * read `dwellTime` / `timestamp` / `byline` / `siteName`. Nothing threw. Every
 * stored dwell was the worker's 5000 ms default, every timestamp was the time
 * the message happened to arrive, and site name and byline were always empty.
 *
 * These tests run the real tracker, hand its message to the worker's reader and
 * store it through the worker's capture path, so the next disagreement fails
 * here instead of in a user's history.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import { captureContext } from "../src/lib/context-workflow";
import {
  DWELL_RECORD,
  dwellRecordMessage,
  readDwellRecordPayload,
  readDwellUpdatePayload,
  type DwellRecordPayload
} from "../src/lib/dwell-message";
import { captureInputFromDwell, visitMetaFromDwell } from "../src/lib/dwell-store";

const PAYLOAD: DwellRecordPayload = {
  url: "https://example.com/post",
  title: "A Post",
  excerpt: "An excerpt.",
  textContent: "Body text of the post.",
  dwellDurationMs: 42_000,
  capturedAt: 1_800_000_042_000,
  visitStartedAt: 1_800_000_000_000,
  siteName: "Example Weekly",
  byline: "Jane Doe",
  contentKind: "article"
};

describe("dwell message contract", () => {
  let sent: any[] = [];
  let timers: Array<() => void> = [];
  let now = 1_800_000_000_000;
  const realDateNow = Date.now;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    sent = [];
    timers = [];
    now = 1_800_000_000_000;
    Date.now = () => now;

    (globalThis as any).window = {
      location: { href: "https://example.com/post?utm_source=x", hostname: "example.com" },
      addEventListener: () => {},
      setTimeout: (fn: () => void) => timers.push(fn),
      clearTimeout: () => {}
    };
    (globalThis as any).document = {
      title: "A Post",
      visibilityState: "visible",
      addEventListener: () => {},
      cloneNode: () => ({ querySelectorAll: () => [], documentElement: {} }),
      body: null
    };
    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message: any, callback?: (reply: unknown) => void) => {
          sent.push(message);
          callback?.({ status: "success" });
        },
        onMessage: { addListener: () => {} }
      },
      storage: { local: { get: async () => ({ exocortexCaptureConsent: true }), set: async () => {} } }
    };
    (globalThis as any).MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    Date.now = realDateNow;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).chrome;
    delete (globalThis as any).MutationObserver;
  });

  test("what the tracker sends is what the worker stores: real dwell, capture time, not defaults", async () => {
    await import("../src/content/tracker?dwell-contract");
    await Bun.sleep(0);

    // 12 s in the foreground before the capture runs — not the 5 s default.
    now += 12_000;
    expect(timers.length).toBe(1);
    timers[0]();

    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe(DWELL_RECORD);

    // The worker's side: read the wire payload, then store it.
    const payload = readDwellRecordPayload(sent[0].payload);
    expect(payload).not.toBeNull();
    expect(payload!.dwellDurationMs).toBe(12_000);
    expect(payload!.capturedAt).toBe(now);

    // The message is processed later than it was captured; the stored
    // timestamp must still be the capture time.
    now += 90_000;
    await captureContext(captureInputFromDwell(payload!, payload!.url, "s1"));

    const blocks = await db.dwell_blocks.toArray();
    expect(blocks.length).toBe(1);
    expect(blocks[0].dwellTime).toBe(12_000);
    expect(blocks[0].dwellTime).not.toBe(5_000);
    expect(blocks[0].timestamp).toBe(payload!.capturedAt);
    expect(blocks[0].timestamp).not.toBe(now);
  });

  test("site name and byline survive from the payload to the stored page", async () => {
    const payload = readDwellRecordPayload(dwellRecordMessage(PAYLOAD).payload)!;
    await captureContext(captureInputFromDwell(payload, payload.url));

    const page = await db.page_text.where("url").equals(PAYLOAD.url).first();
    expect(page?.siteName).toBe("Example Weekly");
    expect(page?.byline).toBe("Jane Doe");
    expect(page?.parsedAt).toBe(PAYLOAD.capturedAt);

    expect(visitMetaFromDwell(payload, payload.url)).toEqual({
      title: "A Post",
      siteName: "Example Weekly",
      byline: "Jane Doe",
      contentKind: "article"
    });
  });

  test("both sides of the dwell boundary scrub captured text before it can be reused", () => {
    const marker = "fixture-only-material42";
    const input = {
      ...PAYLOAD,
      title: `Release notes Bearer ${marker}`,
      excerpt: `secret=${marker}`,
      textContent: `password=${marker}`,
      siteName: "Example Weekly",
      byline: `Bearer ${marker}`
    };
    const sent = dwellRecordMessage(input).payload;
    const received = readDwellRecordPayload(input)!;
    expect(sent).toEqual(received);
    expect(received).toMatchObject({
      title: "Release notes Bearer [REDACTED_TOKEN]",
      excerpt: "secret=[REDACTED_SECRET]",
      textContent: "password=[REDACTED_SECRET]",
      siteName: "Example Weekly",
      byline: "Bearer [REDACTED_TOKEN]",
      capturedAt: PAYLOAD.capturedAt,
      dwellDurationMs: PAYLOAD.dwellDurationMs
    });
    expect(readDwellRecordPayload(sent)).toEqual(sent);
  });

  test("a payload in the field names the worker used to read is rejected, not defaulted", () => {
    // Exactly what the worker destructured before: no `dwellDurationMs`, no
    // `capturedAt`. Silently substituting 5000 ms and Date.now() is the defect.
    const legacy = { url: "https://example.com/", title: "t", dwellTime: 9_000, timestamp: 1_800_000_000_000 };
    expect(readDwellRecordPayload(legacy)).toBeNull();
    expect(readDwellUpdatePayload(legacy)).toBeNull();
  });

  test("the reader rejects unusable identity and dwell values", () => {
    for (const bad of [
      null,
      "string",
      [],
      { ...PAYLOAD, url: "" },
      { ...PAYLOAD, capturedAt: 0 },
      { ...PAYLOAD, capturedAt: Number.NaN },
      { ...PAYLOAD, capturedAt: "1800000000000" },
      { ...PAYLOAD, dwellDurationMs: -1 },
      { ...PAYLOAD, dwellDurationMs: Number.POSITIVE_INFINITY }
    ]) {
      expect(readDwellRecordPayload(bad)).toBeNull();
    }
  });

  test("a content script from the previous build still records, with neutral metadata", () => {
    // Tabs opened before an update keep the old script until they reload. It
    // sent the identity and dwell fields but none of the metadata.
    const old = readDwellRecordPayload({
      url: "https://example.com/old",
      title: "Old tab",
      excerpt: "",
      textContent: "text",
      dwellDurationMs: 5_000,
      capturedAt: 1_800_000_005_000
    });
    expect(old).toMatchObject({
      siteName: "",
      byline: "",
      contentKind: "page",
      visitStartedAt: 1_800_000_005_000
    });
  });

  test("an unknown content kind is read as a plain page", () => {
    expect(readDwellRecordPayload({ ...PAYLOAD, contentKind: "podcast" })!.contentKind).toBe("page");
  });

  test("a visit start later than its capture is not trusted", () => {
    expect(readDwellRecordPayload({ ...PAYLOAD, visitStartedAt: PAYLOAD.capturedAt + 1 })!.visitStartedAt).toBe(
      PAYLOAD.capturedAt
    );
  });

  test("the record and its updates always resolve to the same visit start", () => {
    // Downstream consumers (the omaCortex feed) upsert on it, so a fallback
    // that depended on the growing dwell would split one visit into several.
    for (const visitStartedAt of [PAYLOAD.visitStartedAt, undefined, 0, PAYLOAD.capturedAt + 5]) {
      const record = readDwellRecordPayload({ ...PAYLOAD, visitStartedAt })!;
      for (const dwellDurationMs of [60_000, 600_000]) {
        const update = readDwellUpdatePayload({
          url: PAYLOAD.url,
          capturedAt: PAYLOAD.capturedAt,
          visitStartedAt,
          dwellDurationMs
        })!;
        expect(update.visitStartedAt).toBe(record.visitStartedAt);
      }
    }
  });
});
