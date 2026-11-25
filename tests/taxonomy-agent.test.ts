/**
 * Rule-based taxonomy: sites are matched on the hostname, and a video page is
 * named instead of being filed as an anonymous feed.
 */
import { describe, expect, test } from "bun:test";
import { classifyIntentAndFocus } from "../src/lib/agents/taxonomy-agent";
import { INTENT_CATEGORIES } from "../src/bridge/protocol";

const DISTRACTION = "Distraction / Rabbit Hole";

describe("host matching", () => {
  test("x.com does not match hosts that merely end in the same letters", () => {
    // `url.includes("x.com")` was true for all of these.
    for (const url of [
      "https://www.netflix.com/browse",
      "https://www.dropbox.com/home",
      "https://www.fedex.com/tracking",
      "https://box.com/files",
      "https://www.linux.com/news"
    ]) {
      expect(classifyIntentAndFocus({ url, title: "A page" }).intentCategory).not.toBe(DISTRACTION);
    }
  });

  test("x.com and its subdomains still match", () => {
    for (const url of ["https://x.com/home", "https://www.x.com/i/lists", "https://mobile.twitter.com/home"]) {
      expect(classifyIntentAndFocus({ url, title: "Home" }).intentCategory).toBe(DISTRACTION);
    }
  });

  test("a site named only in the path or query is not that site", () => {
    const shared = classifyIntentAndFocus({
      url: "https://example.com/share?u=https://reddit.com/r/rust&via=youtube.com",
      title: "Share"
    });
    expect(shared.intentCategory).toBe("Research & Gathering");

    const lookalike = classifyIntentAndFocus({ url: "https://github.com.evil.test/login", title: "x" });
    expect(lookalike.intentCategory).not.toBe("Deep Work (Drafting/Coding)");
  });

  test("the other rules keep working on hostnames", () => {
    const cases: Array<[string, string]> = [
      ["https://app.slack.com/client/T1/C1", "Communication & Async"],
      ["https://mail.google.com/mail/u/0/", "Communication & Async"],
      ["https://stackoverflow.com/questions/1", "Deep Work (Drafting/Coding)"],
      ["http://localhost:5173/", "Deep Work (Drafting/Coding)"],
      ["http://127.0.0.1:8080/", "Deep Work (Drafting/Coding)"],
      ["https://docs.python.org/3/", "Deep Work (Drafting/Coding)"],
      ["https://linear.app/team/issue/ABC-1", "Task Execution & Ops"],
      ["https://jira.example.com/browse/ABC-1", "Task Execution & Ops"],
      ["https://example.atlassian.net/jira/software/projects/ABC", "Task Execution & Ops"],
      ["https://console.cloud.google.com/run", "Task Execution & Ops"],
      ["https://en.wikipedia.org/wiki/Rust", "Research & Gathering"]
    ];
    for (const [url, category] of cases) {
      expect(classifyIntentAndFocus({ url, title: "A page" }).intentCategory).toBe(category as never);
    }
  });

  test("a GitHub page is still focused on its owner/repo", () => {
    const result = classifyIntentAndFocus({ url: "https://github.com/Owner/Repo/pull/12", title: "Fix things" });
    expect(result.primaryFocusEntity).toBe("owner/repo");
  });

  test("an unparseable URL falls through to the default instead of throwing", () => {
    expect(classifyIntentAndFocus({ url: "", title: "Untitled" }).intentCategory).toBe("Research & Gathering");
    expect(classifyIntentAndFocus({ url: "not a url", title: "Untitled" }).intentCategory).toBe("Research & Gathering");
  });
});

describe("video pages", () => {
  const WATCH = {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Rust in 100 Seconds - YouTube",
    siteName: "YouTube",
    byline: "Fireship",
    contentKind: "video" as const
  };

  test("a YouTube watch page is named by its video, not labelled Social Feed", () => {
    const result = classifyIntentAndFocus(WATCH);
    expect(result.primaryFocusEntity).not.toBe("Social Feed");
    expect(result.primaryFocusEntity).toBe("Rust in 100 Seconds");
    expect(result.workingStateSummary).toBe("Watching Fireship on YouTube");
  });

  test("its category is unchanged, so Focus Shield and drift detection behave as before", () => {
    expect(classifyIntentAndFocus(WATCH).intentCategory).toBe(DISTRACTION);
  });

  test("without a channel or a title it is still described as a video", () => {
    const bare = classifyIntentAndFocus({ url: WATCH.url, title: "", contentKind: "video" });
    expect(bare.primaryFocusEntity).toBe("youtube.com video");
    expect(bare.workingStateSummary).toBe("Watching a video on youtube.com");
  });

  test("a feed page on the same site keeps the feed label", () => {
    const home = classifyIntentAndFocus({ url: "https://www.youtube.com/", title: "YouTube", contentKind: "page" });
    expect(home.primaryFocusEntity).toBe("Social Feed");
    const withSite = classifyIntentAndFocus({ url: "https://www.reddit.com/", title: "Reddit", siteName: "Reddit" });
    expect(withSite.primaryFocusEntity).toBe("Reddit");
  });

  test("a video elsewhere does not become a distraction because it is a video", () => {
    const lecture = classifyIntentAndFocus({
      url: "https://university.example.edu/lectures/12",
      title: "Lecture 12",
      contentKind: "video"
    });
    expect(lecture.intentCategory).toBe("Research & Gathering");
  });
});

describe("category names", () => {
  test("every classification is one of the categories the rest of the code depends on", () => {
    const urls = [
      "https://x.com/",
      "https://www.youtube.com/watch?v=1",
      "https://app.slack.com/",
      "https://github.com/a/b",
      "https://linear.app/x",
      "https://example.com/"
    ];
    for (const url of urls) {
      const { intentCategory } = classifyIntentAndFocus({ url, title: "t", contentKind: "video" });
      expect((INTENT_CATEGORIES as readonly string[]).includes(intentCategory)).toBe(true);
    }
  });
});
