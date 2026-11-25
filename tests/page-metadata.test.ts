/**
 * Page metadata: site name, author and content kind, read only from what a
 * page declares about itself.
 */
import { describe, expect, test } from "bun:test";
import {
  cleanByline,
  collectPageMetadata,
  deriveContentKind,
  isYouTubeWatchUrl,
  MAX_BYLINE_LENGTH,
  type MetaDocumentLike,
  type MetaElementLike
} from "../src/content/page-metadata";

/** A document that answers exactly the selectors it was given, and records what was asked. */
function fakeDocument(spec: {
  content?: Record<string, string>;
  text?: Record<string, string>;
  jsonLd?: unknown[];
}): MetaDocumentLike & { asked: string[] } {
  const asked: string[] = [];
  const element = (attrs: Record<string, string>, textContent = ""): MetaElementLike => ({
    getAttribute: (name) => attrs[name] ?? null,
    textContent
  });
  return {
    asked,
    querySelector(selector) {
      asked.push(selector);
      if (spec.content && selector in spec.content) return element({ content: spec.content[selector] });
      if (spec.text && selector in spec.text) return element({}, spec.text[selector]);
      return null;
    },
    querySelectorAll(selector) {
      asked.push(selector);
      if (selector !== 'script[type="application/ld+json"]') return [];
      return (spec.jsonLd || []).map((value) =>
        element({}, typeof value === "string" ? value : JSON.stringify(value))
      );
    }
  };
}

describe("site name", () => {
  test("uses og:site_name when the page declares one", () => {
    const doc = fakeDocument({ content: { 'meta[property="og:site_name"]': "The Example Times" } });
    expect(collectPageMetadata(doc, "https://www.example.com/a").siteName).toBe("The Example Times");
  });

  test("falls back to the hostname without www", () => {
    expect(collectPageMetadata(fakeDocument({}), "https://www.example.com/a").siteName).toBe("example.com");
  });

  test("survives a document that cannot be queried at all", () => {
    expect(collectPageMetadata({}, "https://example.com/a")).toEqual({
      siteName: "example.com",
      byline: "",
      contentKind: "page"
    });
    expect(collectPageMetadata(null, "https://example.com/a").siteName).toBe("example.com");
  });

  test("survives a selector engine that throws", () => {
    const doc: MetaDocumentLike = {
      querySelector() {
        throw new Error("bad selector");
      },
      querySelectorAll() {
        throw new Error("bad selector");
      }
    };
    expect(collectPageMetadata(doc, "https://example.com/a").siteName).toBe("example.com");
  });
});

describe("author", () => {
  test("meta[name=author] comes first", () => {
    const doc = fakeDocument({
      content: { 'meta[name="author"]': "Jane Doe", 'meta[property="article:author"]': "Someone Else" },
      jsonLd: [{ "@type": "Article", author: { name: "A Third Person" } }]
    });
    expect(collectPageMetadata(doc, "https://example.com/a", { byline: "By Fourth" }).byline).toBe("Jane Doe");
  });

  test("article:author is used when it is a name", () => {
    const doc = fakeDocument({ content: { 'meta[property="article:author"]': "Jane Doe" } });
    expect(collectPageMetadata(doc, "https://example.com/a").byline).toBe("Jane Doe");
  });

  test("article:author is skipped when it is a profile URL", () => {
    // Facebook's convention is to put a profile URL here. A URL is not a name.
    const doc = fakeDocument({
      content: { 'meta[property="article:author"]': "https://www.facebook.com/janedoe" },
      jsonLd: [{ "@type": "NewsArticle", author: [{ "@type": "Person", name: "Jane Doe" }] }]
    });
    expect(collectPageMetadata(doc, "https://example.com/a").byline).toBe("Jane Doe");
  });

  test("JSON-LD author may be an object, a list, a string, or inside @graph", () => {
    const cases: unknown[] = [
      { "@type": "Article", author: { "@type": "Person", name: "Jane Doe" } },
      { "@type": "Article", author: [{ name: "Jane Doe" }, { name: "John Roe" }] },
      { "@type": "Article", author: "Jane Doe" },
      { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, { "@type": "Article", author: { name: "Jane Doe" } }] }
    ];
    for (const jsonLd of cases) {
      expect(collectPageMetadata(fakeDocument({ jsonLd: [jsonLd] }), "https://example.com/a").byline).toBe("Jane Doe");
    }
  });

  test("the Readability byline is the last resort, with its 'By' removed", () => {
    expect(collectPageMetadata(fakeDocument({}), "https://example.com/a", { byline: "By  Jane\n Doe" }).byline).toBe(
      "Jane Doe"
    );
  });

  test("malformed JSON-LD is ignored", () => {
    const doc = fakeDocument({ jsonLd: ["{not json", { "@type": "Article", author: { name: "Jane Doe" } }] });
    expect(collectPageMetadata(doc, "https://example.com/a").byline).toBe("Jane Doe");
  });

  test("cleanByline rejects URLs and bounds length", () => {
    expect(cleanByline("https://example.com/authors/jane")).toBe("");
    expect(cleanByline("www.example.com")).toBe("");
    expect(cleanByline("//cdn.example.com/x")).toBe("");
    expect(cleanByline("  by: Jane Doe ")).toBe("Jane Doe");
    expect(cleanByline("x".repeat(500)).length).toBe(MAX_BYLINE_LENGTH);
    expect(cleanByline(undefined)).toBe("");
  });
});

describe("YouTube", () => {
  const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  test("a watch page is a video by its URL, whatever stale metadata the SPA still carries", () => {
    // A tab opened on the home page keeps og:type=website after navigating to a video.
    const doc = fakeDocument({ content: { 'meta[property="og:type"]': "website" } });
    expect(collectPageMetadata(doc, WATCH).contentKind).toBe("video");
  });

  test("the channel name is the byline, read from the rendered owner link", () => {
    const doc = fakeDocument({
      content: { 'meta[property="og:site_name"]': "YouTube", 'meta[name="author"]': "Not The Channel" },
      text: { "ytd-watch-metadata ytd-channel-name a": "\n  Fireship\n " }
    });
    expect(collectPageMetadata(doc, WATCH)).toEqual({ siteName: "YouTube", byline: "Fireship", contentKind: "video" });
  });

  test("falls back to the author microdata when the owner link is not rendered yet", () => {
    const doc = fakeDocument({ content: { 'span[itemprop="author"] link[itemprop="name"]': "Fireship" } });
    expect(collectPageMetadata(doc, WATCH).byline).toBe("Fireship");
  });

  test("the channel selectors are not consulted on other sites", () => {
    const doc = fakeDocument({ text: { "ytd-watch-metadata ytd-channel-name a": "Fireship" } });
    expect(collectPageMetadata(doc, "https://example.com/watch?v=1").byline).toBe("");
    expect(doc.asked.some((selector) => selector.includes("ytd-"))).toBe(false);
  });

  test("recognises watch, shorts, live and youtu.be; not the home page or a channel", () => {
    for (const url of [
      WATCH,
      "https://m.youtube.com/watch?v=abc",
      "https://www.youtube.com/shorts/abc",
      "https://www.youtube.com/live/abc",
      "https://youtu.be/abc"
    ]) {
      expect(isYouTubeWatchUrl(url)).toBe(true);
    }
    for (const url of [
      "https://www.youtube.com/",
      "https://www.youtube.com/@fireship",
      "https://www.youtube.com/results?search_query=rust",
      "https://notyoutube.com/watch?v=abc",
      "https://example.com/?next=youtube.com/watch"
    ]) {
      expect(isYouTubeWatchUrl(url)).toBe(false);
    }
  });
});

describe("content kind", () => {
  test("og:type and JSON-LD @type decide when the URL does not", () => {
    expect(deriveContentKind({ url: "https://example.com/a", ogType: "article" })).toBe("article");
    expect(deriveContentKind({ url: "https://example.com/a", ogType: "video.other" })).toBe("video");
    expect(deriveContentKind({ url: "https://example.com/a", ldTypes: ["NewsArticle"] })).toBe("article");
    expect(deriveContentKind({ url: "https://example.com/a", ldTypes: ["WebPage", "VideoObject"] })).toBe("video");
    expect(deriveContentKind({ url: "https://example.com/a", ogType: "website" })).toBe("page");
    expect(deriveContentKind({ url: "https://example.com/a" })).toBe("page");
  });

  test("a Substack post is an article; the publication's home page is not", () => {
    expect(deriveContentKind({ url: "https://someone.substack.com/p/a-post" })).toBe("article");
    expect(deriveContentKind({ url: "https://someone.substack.com/" })).toBe("page");
  });

  test("JSON-LD @type may be a list", () => {
    const doc = fakeDocument({ jsonLd: [{ "@type": ["Article", "BlogPosting"] }] });
    expect(collectPageMetadata(doc, "https://example.com/a").contentKind).toBe("article");
  });
});

describe("what is read", () => {
  test("only metadata selectors are queried — never body text", () => {
    const doc = fakeDocument({});
    collectPageMetadata(doc, "https://www.youtube.com/watch?v=abc");
    for (const selector of doc.asked) {
      expect(selector).toMatch(/^(meta\[|script\[type="application\/ld\+json"\]|span\[itemprop="author"\]|ytd-|#owner )/);
    }
    expect(doc.asked.some((selector) => /^(body|article|main|p|div)\b/.test(selector))).toBe(false);
  });

  test("an oversized JSON-LD block is skipped rather than parsed", () => {
    const huge = JSON.stringify({ "@type": "Article", author: { name: "Jane Doe" }, articleBody: "x".repeat(250_000) });
    expect(collectPageMetadata(fakeDocument({ jsonLd: [huge] }), "https://example.com/a").byline).toBe("");
  });
});
