/**
 * Side-panel recall rows: a date on every timestamp, and site / author / kind
 * shown as plain text.
 */
import { describe, expect, test } from "bun:test";
import { formatDwell, formatRecallTime } from "../src/sidepanel/format-time";
import {
  appendResultCards,
  buildResultCard,
  describeResultSource,
  describeResultSourceAndDwell,
  type CardElement
} from "../src/sidepanel/result-cards";
import type { VectorSearchResult } from "../src/lib/models/vector-search";

/** Local-time timestamp, so the assertions hold in any timezone. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe("formatRecallTime", () => {
  const now = at(2026, 11, 19, 15, 30);

  test("today, yesterday, and an earlier date this year", () => {
    expect(formatRecallTime(at(2026, 11, 19, 14, 5), now)).toBe("Today 14:05");
    expect(formatRecallTime(at(2026, 11, 18, 9, 12), now)).toBe("Yesterday 09:12");
    expect(formatRecallTime(at(2026, 11, 12, 16, 40), now)).toBe("Nov 12 16:40");
  });

  test("never just an hour and minute", () => {
    for (const ts of [at(2026, 11, 19, 0, 0), at(2026, 11, 18, 23, 59), at(2026, 3, 1, 7, 7), at(2025, 12, 31, 12, 0)]) {
      expect(formatRecallTime(ts, now)).not.toMatch(/^\d{1,2}:\d{2}$/);
    }
  });

  test("yesterday is a calendar day, not the last 24 hours", () => {
    const justAfterMidnight = at(2026, 11, 19, 0, 10);
    // 20 minutes ago, but on the previous day.
    expect(formatRecallTime(at(2026, 11, 18, 23, 50), justAfterMidnight)).toBe("Yesterday 23:50");
    // 23 hours ago and still today.
    expect(formatRecallTime(at(2026, 11, 19, 0, 30), at(2026, 11, 19, 23, 30))).toBe("Today 00:30");
    // Two calendar days back is a date even when under 48 hours.
    expect(formatRecallTime(at(2026, 11, 17, 23, 0), justAfterMidnight)).toBe("Nov 17 23:00");
  });

  test("another year includes the year", () => {
    expect(formatRecallTime(at(2025, 12, 31, 8, 0), now)).toBe("Dec 31 2025 08:00");
  });

  test("a day-length change between the two dates does not shift the label", () => {
    // Around a DST transition a day is 23 or 25 hours long.
    const afterShift = at(2026, 3, 9, 12, 0);
    expect(formatRecallTime(at(2026, 3, 8, 12, 0), afterShift)).toBe("Yesterday 12:00");
    expect(formatRecallTime(at(2026, 3, 7, 12, 0), afterShift)).toBe("Mar 7 12:00");
  });

  test("an unusable timestamp renders as nothing rather than 'Invalid Date'", () => {
    expect(formatRecallTime(Number.NaN, now)).toBe("");
    expect(formatRecallTime(undefined as unknown as number, now)).toBe("");
    expect(formatRecallTime(Number.MAX_VALUE, now)).toBe("");
  });
});

describe("formatDwell", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDwell(5)).toBe("5s");
    expect(formatDwell(59)).toBe("59s");
    expect(formatDwell(60)).toBe("1 min");
    expect(formatDwell(754)).toBe("13 min");
    expect(formatDwell(3_600)).toBe("1h 00m");
    expect(formatDwell(3_900)).toBe("1h 05m");
    expect(formatDwell(9_000)).toBe("2h 30m");
  });

  test("unknown dwell renders as nothing", () => {
    for (const unknown of [undefined, null, 0, -3, Number.NaN]) expect(formatDwell(unknown)).toBe("");
  });
});

/** A document that records how each node was filled, and has no innerHTML at all. */
class FakeElement implements CardElement<FakeElement> {
  className = "";
  textContent: string | null = null;
  style = { cssText: "" };
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  constructor(public tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML must never be assigned on a result row");
  }
  find(className: string): FakeElement | undefined {
    if (this.className === className) return this;
    for (const child of this.children) {
      const hit = child.find(className);
      if (hit) return hit;
    }
    return undefined;
  }
  allText(): string {
    return [this.textContent ?? "", ...this.children.map((c) => c.allText())].join("");
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };

const RESULT: VectorSearchResult = {
  frameId: 1,
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Rust in 100 Seconds - YouTube",
  domain: "www.youtube.com",
  summary: "A fast introduction.",
  timestamp: at(2026, 11, 12, 16, 40),
  siteName: "YouTube",
  byline: "Fireship",
  contentKind: "video",
  matchKind: "lexical",
  cosineSimilarity: null,
  lexicalScore: 1,
  recencyScore: 0.5,
  dwellScore: 1,
  score: 0.8
};

describe("result rows", () => {
  const now = at(2026, 11, 19, 15, 30);

  test("show the site, the author and the kind", () => {
    expect(describeResultSource(RESULT)).toBe("YouTube · Fireship · video");
    const card = buildResultCard(fakeDocument, RESULT, now);
    expect(card.find("item-source")!.textContent).toBe("YouTube · Fireship · video");
  });

  test("show how long the page was really in front of the user", () => {
    expect(describeResultSourceAndDwell({ ...RESULT, dwellTime: 754 })).toBe("YouTube · Fireship · video · 13 min");
    const card = buildResultCard(fakeDocument, { ...RESULT, dwellTime: 754 }, now);
    expect(card.find("item-source")!.textContent).toBe("YouTube · Fireship · video · 13 min");
    // No dwell recorded: nothing is invented.
    expect(describeResultSourceAndDwell(RESULT)).toBe("YouTube · Fireship · video");
  });

  test("show the date, not just the time", () => {
    const card = buildResultCard(fakeDocument, RESULT, now);
    expect(card.find("item-time")!.textContent).toBe("Nov 12 16:40");
  });

  test("leave out what is not known", () => {
    expect(describeResultSource({ ...RESULT, byline: undefined, contentKind: undefined })).toBe("YouTube");
    expect(describeResultSource({ ...RESULT, byline: "", contentKind: "page" })).toBe("YouTube");
    expect(describeResultSource({ ...RESULT, contentKind: "article" })).toBe("YouTube · Fireship · article");
  });

  test("fall back to the hostname for rows captured before metadata existed", () => {
    const legacy = { ...RESULT, siteName: undefined, byline: undefined, contentKind: undefined };
    expect(describeResultSource(legacy)).toBe("youtube.com");
    expect(describeResultSource({ ...legacy, domain: undefined })).toBe("youtube.com");
  });

  test("captured strings are set as text and are never parsed as markup", () => {
    const hostile: VectorSearchResult = {
      ...RESULT,
      title: `<img src=x onerror="alert(1)">`,
      siteName: `<script>alert(2)</script>`,
      byline: `"><svg onload=alert(3)>`,
      summary: `<b>bold</b> & <i>italic</i>`
    };
    // FakeElement throws on any innerHTML assignment, so reaching the
    // assertions at all means none happened.
    const card = buildResultCard(fakeDocument, hostile, now);

    expect(card.find("item-link")!.textContent).toBe(hostile.title);
    expect(card.find("item-source")!.textContent).toBe(`<script>alert(2)</script> · "><svg onload=alert(3)> · video`);
    expect(card.find("item-excerpt")!.textContent).toBe(hostile.summary!);
    // No node was created from the captured strings.
    const tags = new Set<string>();
    const walk = (node: FakeElement) => {
      tags.add(node.tagName);
      node.children.forEach(walk);
    };
    walk(card);
    expect([...tags].sort()).toEqual(["a", "button", "div", "span"]);
  });

  test("only a web address becomes a link", () => {
    const web = buildResultCard(fakeDocument, RESULT, now).find("item-link")!;
    expect(web.attributes.href).toBe(RESULT.url);
    expect(web.attributes.rel).toBe("noopener");

    for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "desktop://app/Terminal"]) {
      const link = buildResultCard(fakeDocument, { ...RESULT, url }, now).find("item-link")!;
      expect(link.attributes.href).toBeUndefined();
    }
  });

  test("keep the match badge and the reopen button the panel relies on", () => {
    const lexical = buildResultCard(fakeDocument, RESULT, now);
    expect(lexical.className).toBe("timeline-item");
    expect(lexical.find("badge")!.textContent).toBe("lexical");
    const reopen = lexical.find("restore-btn")!;
    expect(reopen.textContent).toBe("Reopen Tab");
    expect(reopen.attributes["data-url"]).toBe(RESULT.url);

    const vector = buildResultCard(fakeDocument, { ...RESULT, matchKind: "vector", cosineSimilarity: 0.8731 }, now);
    expect(vector.find("badge")!.textContent).toBe("vector · cos 0.87");
  });

  test("appendResultCards adds one row per result, in order", () => {
    const container = new FakeElement("div");
    appendResultCards(fakeDocument, container, [RESULT, { ...RESULT, frameId: 2, title: "Second" }], now);
    expect(container.children.length).toBe(2);
    expect(container.children[1].find("item-link")!.textContent).toBe("Second");
  });
});
