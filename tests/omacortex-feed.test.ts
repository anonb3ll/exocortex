/**
 * The optional omaCortex feed: what a message contains, what it can never
 * contain, and how a missing host is handled.
 *
 * The host upserts on (url, at). So the two properties that matter most are
 * that the URL is minimized the same way every time, and that `at` is
 * identical on every update for one visit.
 */
import { describe, expect, test } from "bun:test";
import {
  buildOmacortexPageMessage,
  buildOmacortexStatusMessage,
  createOmacortexFeed,
  describeOmacortexStatus,
  FEED_UNAVAILABLE_BACKOFF_MS,
  MAX_FEED_TITLE_LENGTH,
  minimizeFeedUrl,
  OMACORTEX_FEED_STORAGE_KEY,
  OMACORTEX_NATIVE_HOST,
  probeOmacortexStatus,
  type FeedVisitInput,
  type NativeSend
} from "../src/lib/omacortex-feed";

const VISIT: FeedVisitInput = {
  url: "https://someone.substack.com/p/a-post?utm_source=share#comments",
  title: "A Post About Things",
  siteName: "Someone's Newsletter",
  byline: "Jane Doe",
  contentKind: "article",
  dwellMs: 5_000,
  visitStartedAtMs: 1_800_000_000_123
};

describe("URL minimization", () => {
  test("drops the query string and the fragment", () => {
    expect(minimizeFeedUrl("https://example.com/a/b?session=abc&page=2#section")).toBe("https://example.com/a/b");
    expect(minimizeFeedUrl("http://example.com/")).toBe("http://example.com/");
    expect(minimizeFeedUrl("https://example.com:8443/a?x=1")).toBe("https://example.com:8443/a");
  });

  test("keeps only the v parameter of a YouTube watch URL", () => {
    expect(
      minimizeFeedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s&si=tracking#t=1")
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(minimizeFeedUrl("https://m.youtube.com/watch?feature=share&v=abc_-123")).toBe(
      "https://m.youtube.com/watch?v=abc_-123"
    );
  });

  test("the v exception applies to youtube.com/watch only", () => {
    // Another site's ?v=, another YouTube path, and a lookalike host all lose it.
    expect(minimizeFeedUrl("https://example.com/watch?v=abc")).toBe("https://example.com/watch");
    expect(minimizeFeedUrl("https://www.youtube.com/results?v=abc&search_query=private")).toBe(
      "https://www.youtube.com/results"
    );
    expect(minimizeFeedUrl("https://notyoutube.com/watch?v=abc")).toBe("https://notyoutube.com/watch");
    expect(minimizeFeedUrl("https://youtube.com.evil.test/watch?v=abc")).toBe("https://youtube.com.evil.test/watch");
  });

  test("a v value that is not a video id is dropped, not passed through", () => {
    expect(minimizeFeedUrl("https://www.youtube.com/watch?v=a%20b%26token%3Dsecret")).toBe(
      "https://www.youtube.com/watch"
    );
    expect(minimizeFeedUrl("https://www.youtube.com/watch?v=")).toBe("https://www.youtube.com/watch");
  });

  test("credentials in the authority are removed", () => {
    expect(minimizeFeedUrl("https://user:hunter2@example.com/a?x=1")).toBe("https://example.com/a");
  });

  test("only http(s) is sent", () => {
    for (const url of [
      "chrome://settings",
      "chrome-extension://abc/page.html",
      "file:///home/user/notes.txt",
      "about:blank",
      "device://mcp/thing",
      "ftp://example.com/file",
      "not a url",
      ""
    ]) {
      expect(minimizeFeedUrl(url)).toBeNull();
    }
  });

  test("every URL the privacy guard blocks is refused here too", () => {
    for (const url of [
      "https://www.chase.com/accounts",
      "https://login.example.com/",
      "https://auth.example.com/callback",
      "https://mybank.example.com/",
      "https://vault.bitwarden.com/"
    ]) {
      expect(minimizeFeedUrl(url)).toBeNull();
      expect(buildOmacortexPageMessage({ ...VISIT, url })).toBeNull();
    }
  });
});

describe("page message", () => {
  test("has exactly the contract's fields", () => {
    expect(buildOmacortexPageMessage(VISIT)).toEqual({
      v: 1,
      type: "page",
      source: "exocortex",
      url: "https://someone.substack.com/p/a-post",
      title: "A Post About Things",
      site: "Someone's Newsletter",
      author: "Jane Doe",
      content: "article",
      seconds: 5,
      at: 1_800_000_000.123
    });
  });

  test("scrubs stored visit metadata again before sending it to the native host", () => {
    const marker = "fixture-only-material42";
    expect(buildOmacortexPageMessage({
      ...VISIT,
      title: `Release notes Bearer ${marker}`,
      siteName: `secret=${marker}`,
      byline: `password=${marker}`
    })).toMatchObject({
      title: "Release notes Bearer [REDACTED_TOKEN]",
      site: "secret=[REDACTED_SECRET]",
      author: "password=[REDACTED_SECRET]"
    });
  });

  test("refuses a credential-bearing path instead of sending it to the native host", () => {
    expect(buildOmacortexPageMessage({
      ...VISIT,
      url: "https://example.com/magic-link/fixture-only-material42"
    })).toBeNull();
  });

  test("upsert identity: url and at are identical on every update of a visit", () => {
    const initial = buildOmacortexPageMessage(VISIT)!;
    const later = buildOmacortexPageMessage({ ...VISIT, dwellMs: 754_321 })!;
    const last = buildOmacortexPageMessage({ ...VISIT, dwellMs: 2_400_000, title: "A Post About Things (edited)" })!;

    for (const update of [later, last]) {
      expect(update.url).toBe(initial.url);
      expect(update.at).toBe(initial.at);
    }
    // Only the dwell moves.
    expect(initial.seconds).toBe(5);
    expect(later.seconds).toBe(754.3);
    expect(last.seconds).toBe(2400);
  });

  test("at is epoch seconds as a float, not milliseconds", () => {
    const message = buildOmacortexPageMessage(VISIT)!;
    expect(message.at).toBeCloseTo(1_800_000_000.123, 3);
    expect(message.at).toBeLessThan(10_000_000_000);
    expect(Number.isInteger(message.at)).toBe(false);
  });

  test("the title is at most 300 characters and never ends in half a character", () => {
    const long = buildOmacortexPageMessage({ ...VISIT, title: "x".repeat(1_000) })!;
    expect(long.title.length).toBe(MAX_FEED_TITLE_LENGTH);

    const emoji = buildOmacortexPageMessage({ ...VISIT, title: "😀".repeat(400) })!;
    expect(Array.from(emoji.title).length).toBe(MAX_FEED_TITLE_LENGTH);
    expect(emoji.title).toBe("😀".repeat(MAX_FEED_TITLE_LENGTH));
  });

  test("whitespace in the title is collapsed; an empty title falls back to the hostname", () => {
    expect(buildOmacortexPageMessage({ ...VISIT, title: "  A\n\tPost  " })!.title).toBe("A Post");
    expect(buildOmacortexPageMessage({ ...VISIT, title: "   " })!.title).toBe("someone.substack.com");
  });

  test("optional fields are omitted when unknown, and an unknown kind is not sent", () => {
    const bare = buildOmacortexPageMessage({ ...VISIT, siteName: "", byline: undefined, contentKind: "podcast" })!;
    expect("site" in bare).toBe(false);
    expect("author" in bare).toBe(false);
    expect("content" in bare).toBe(false);
  });

  test("no page text, excerpt, embedding or query can ride along", () => {
    // Everything a caller might be tempted to pass. The builder's result must
    // carry none of it, whatever the input object holds.
    const greedy = {
      ...VISIT,
      excerpt: "SECRET-EXCERPT",
      textContent: "SECRET-BODY-TEXT",
      summary: "SECRET-SUMMARY",
      vector: [0.1, 0.2, 0.3],
      embedding: new Float32Array(384),
      query: "SECRET-QUERY"
    } as FeedVisitInput;
    const message = buildOmacortexPageMessage(greedy)!;

    expect(Object.keys(message).sort()).toEqual(
      ["at", "author", "content", "seconds", "site", "source", "title", "type", "url", "v"].sort()
    );
    const wire = JSON.stringify(message);
    for (const leaked of ["SECRET", "excerpt", "textContent", "summary", "vector", "embedding", "query", "utm_source"]) {
      expect(wire).not.toContain(leaked);
    }
  });

  test("an unusable visit start or dwell produces no message", () => {
    expect(buildOmacortexPageMessage({ ...VISIT, visitStartedAtMs: 0 })).toBeNull();
    expect(buildOmacortexPageMessage({ ...VISIT, visitStartedAtMs: Number.NaN })).toBeNull();
    expect(buildOmacortexPageMessage({ ...VISIT, dwellMs: -5 })).toBeNull();
  });

  test("the status probe carries nothing about the user", () => {
    expect(buildOmacortexStatusMessage()).toEqual({ v: 1, type: "status" });
  });
});

describe("sending", () => {
  function stubHost(reply: unknown | (() => unknown)) {
    const calls: Array<{ host: string; message: any }> = [];
    const send: NativeSend = async (host, message) => {
      calls.push({ host, message });
      const value = typeof reply === "function" ? (reply as () => unknown)() : reply;
      if (value instanceof Error) throw value;
      return value;
    };
    return { calls, send };
  }

  test("the feed is off unless enabled", async () => {
    const host = stubHost({ ok: true, stored: true, recording: true, version: "0.3.0" });
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => false });

    expect(await feed.sendVisit(VISIT)).toEqual({ status: "skipped", reason: "disabled" });
    expect(host.calls).toEqual([]);
  });

  test("the default setting is off", () => {
    // The storage default the service worker and side panel both read with.
    expect(OMACORTEX_FEED_STORAGE_KEY).toBe("exocortexOmacortexFeed");
    const stored: Record<string, unknown> = {};
    expect(stored[OMACORTEX_FEED_STORAGE_KEY] === true).toBe(false);
  });

  test("when on, one message goes to the omaCortex host per visit update", async () => {
    const host = stubHost({ ok: true, stored: true, recording: true, version: "0.3.0" });
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true });

    expect(await feed.sendVisit(VISIT)).toEqual({ status: "stored" });
    expect(await feed.sendVisit({ ...VISIT, dwellMs: 90_000 })).toEqual({ status: "stored" });

    expect(host.calls.length).toBe(2);
    expect(host.calls[0].host).toBe(OMACORTEX_NATIVE_HOST);
    expect(OMACORTEX_NATIVE_HOST).toBe("io.github.anonb3ll.omacortex");
    expect(host.calls[0].message.at).toBe(host.calls[1].message.at);
    expect(host.calls[0].message.url).toBe(host.calls[1].message.url);
    expect(host.calls[1].message.seconds).toBe(90);
  });

  test("stored: false with a reason is a normal answer, not a failure", async () => {
    for (const reason of ["paused", "excluded", "too short"]) {
      const host = stubHost({ ok: true, stored: false, recording: false, reason, version: "0.3.0" });
      const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true });
      expect(await feed.sendVisit(VISIT)).toEqual({ status: "not_stored", reason });
      // It does not put the feed into backoff.
      expect(await feed.sendVisit(VISIT)).toEqual({ status: "not_stored", reason });
      expect(host.calls.length).toBe(2);
    }
  });

  test("an error reply is reported and does not stop later visits", async () => {
    const host = stubHost({ ok: false, error: "bad request" });
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true });
    expect(await feed.sendVisit(VISIT)).toEqual({ status: "rejected", error: "bad request" });
    expect(await feed.sendVisit(VISIT)).toEqual({ status: "rejected", error: "bad request" });
    expect(host.calls.length).toBe(2);
  });

  test("a missing host is quiet: no throw, no log, no retry until the backoff passes", async () => {
    const host = stubHost(() => new Error("Specified native messaging host not found."));
    let now = 1_000_000;
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true, now: () => now });

    const logged: unknown[][] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    console.log = console.warn = console.error = console.debug = (...args: unknown[]) => void logged.push(args);
    try {
      expect(await feed.sendVisit(VISIT)).toEqual({ status: "unavailable" });
      // A browsing session's worth of pages while the host is missing.
      for (let i = 0; i < 50; i += 1) {
        now += 1_000;
        expect(await feed.sendVisit({ ...VISIT, dwellMs: 5_000 + i })).toEqual({ status: "skipped", reason: "backoff" });
      }
      expect(host.calls.length).toBe(1);

      now += FEED_UNAVAILABLE_BACKOFF_MS;
      expect(await feed.sendVisit(VISIT)).toEqual({ status: "unavailable" });
      expect(host.calls.length).toBe(2);
    } finally {
      Object.assign(console, original);
    }
    expect(logged).toEqual([]);
  });

  test("turning the feed on again clears the backoff", async () => {
    let installed = false;
    const host = stubHost(() =>
      installed ? { ok: true, stored: true, recording: true, version: "0.3.0" } : new Error("not found")
    );
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true, now: () => 1_000_000 });

    expect((await feed.sendVisit(VISIT)).status).toBe("unavailable");
    installed = true;
    expect((await feed.sendVisit(VISIT)).status).toBe("skipped");
    feed.resetBackoff();
    expect((await feed.sendVisit(VISIT)).status).toBe("stored");
  });

  test("a blocked or non-web visit is never handed to the host", async () => {
    const host = stubHost({ ok: true, stored: true, recording: true, version: "0.3.0" });
    const feed = createOmacortexFeed({ send: host.send, isEnabled: () => true });
    for (const url of ["https://www.chase.com/", "chrome://history", "device://mcp/x"]) {
      expect(await feed.sendVisit({ ...VISIT, url })).toEqual({ status: "skipped", reason: "not_sendable" });
    }
    expect(host.calls).toEqual([]);
  });

  test("a malformed reply is not mistaken for success", async () => {
    for (const reply of [undefined, null, "ok", 42, []]) {
      const feed = createOmacortexFeed({ send: stubHost(reply).send, isEnabled: () => true });
      expect((await feed.sendVisit(VISIT)).status).toBe("rejected");
    }
  });
});

describe("status probe", () => {
  const probe = (reply: unknown) =>
    probeOmacortexStatus(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });

  test("maps the host's answer to what the side panel shows", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: true, consent: true, paused: false, recording: true, version: "0.3.0" }, "connected"],
      [{ ok: true, consent: true, paused: true, recording: false, version: "0.3.0" }, "paused"],
      [{ ok: true, consent: false, paused: false, recording: false, version: "0.3.0" }, "connected, recording off"],
      [new Error("Specified native messaging host not found."), "not installed"],
      [{ ok: false, error: "unsupported" }, "not responding"],
      [undefined, "not responding"]
    ];
    for (const [reply, label] of cases) {
      expect(describeOmacortexStatus(await probe(reply))).toBe(label);
    }
  });

  test("sends only the status request, to the omaCortex host", async () => {
    const calls: Array<[string, unknown]> = [];
    await probeOmacortexStatus(async (host, message) => {
      calls.push([host, message]);
      return { ok: true, consent: true, paused: false, recording: true, version: "0.3.0" };
    });
    expect(calls).toEqual([[OMACORTEX_NATIVE_HOST, { v: 1, type: "status" }]]);
  });
});
