/**
 * Layer 2: the privacy guard.
 *
 * src/content/privacy.ts is pure and security-relevant — it is the only thing
 * standing between the sensor layer and a user's bank session. It had no tests.
 * These pin the behaviour so a refactor cannot quietly narrow the blocklist.
 */

import { describe, expect, test } from "bun:test";
import { isUrlBlocked, sanitizeCaptureUrl, sanitizeUrl } from "../src/content/privacy";

describe("isUrlBlocked", () => {
  test.each([
    ["https://chase.com/accounts", "financial domain"],
    ["https://www.bankofamerica.com/", "financial domain, www"],
    ["https://mybank.example.com/", "'bank' substring"],
    ["https://paypal.com/checkout", "payments"],
    ["https://1password.com/vault", "password manager"],
    ["https://coinbase.com/portfolio", "crypto"],
    ["https://login.example.com/", "'login' host"],
    ["https://auth.example.com/", "'auth' host"],
    ["https://accounts.google.com/signin/v2/identifier", "account host"],
    ["https://myaccount.google.com/security", "account settings host"],
    ["https://signin.aws.amazon.com/console", "'signin' host"],
  ])("blocks %s (%s)", (url) => {
    expect(isUrlBlocked(url)).toBe(true);
  });

  test.each([
    ["chrome://settings"],
    ["chrome-extension://abc/page.html"],
    ["about:blank"],
    ["file:///home/user/secrets.txt"],
    ["edge://flags"],
    ["brave://settings"],
    ["view-source:https://example.com"],
  ])("blocks the privileged scheme %s", (url) => {
    expect(isUrlBlocked(url)).toBe(true);
  });

  test("blocks anything unparseable or empty — fails closed", () => {
    expect(isUrlBlocked("")).toBe(true);
    expect(isUrlBlocked("not a url")).toBe(true);
    // @ts-expect-error deliberately wrong type: the guard must not throw
    expect(isUrlBlocked(null)).toBe(true);
    // @ts-expect-error deliberately wrong type
    expect(isUrlBlocked(undefined)).toBe(true);
  });

  test("allows an ordinary page", () => {
    expect(isUrlBlocked("https://example.com/articles/1")).toBe(false);
    expect(isUrlBlocked("https://en.wikipedia.org/wiki/Memory")).toBe(false);
    // The account-host fragments are host-only: a path or a look-alike word does not match.
    expect(isUrlBlocked("https://example.com/accounts.html")).toBe(false);
    expect(isUrlBlocked("https://designing.example.com/")).toBe(false);
  });
});

describe("sanitizeUrl", () => {
  test("strips an access_token from the query string", () => {
    const out = sanitizeUrl("https://example.com/cb?access_token=abc123&page=2");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("access_token");
    expect(out).toContain("page=2");
  });

  test.each([
    "token",
    "auth",
    "api_key",
    "apikey",
    "secret",
    "session_id",
    "jwt",
    "password",
    "credential",
    "refresh_token",
    "oauth_token",
  ])("strips ?%s=", (param) => {
    const out = sanitizeUrl(`https://example.com/?${param}=SENSITIVE_VALUE`);
    expect(out).not.toContain("SENSITIVE_VALUE");
  });

  test("strips embedded credentials", () => {
    const out = sanitizeUrl("https://user:hunter2@example.com/dashboard");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("user:");
  });

  test("strips an auth fragment (implicit OAuth flow)", () => {
    const out = sanitizeUrl("https://example.com/cb#access_token=abc123&token_type=bearer");
    expect(out).not.toContain("abc123");
  });

  test("keeps a harmless fragment and harmless params", () => {
    const out = sanitizeUrl("https://example.com/doc?page=3&sort=asc#section-2");
    expect(out).toContain("page=3");
    expect(out).toContain("sort=asc");
    expect(out).toContain("#section-2");
  });

  test("returns the input unchanged when it cannot be parsed", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });
});

describe("sanitizeCaptureUrl", () => {
  // A visit refused here is never recorded and never resumed, so the path rule
  // refuses only on explicit credential evidence. Ordinary opaque identifiers
  // (a commit SHA, a document id, a Notion page id) are identity, not secrets.
  test.each([
    ["https://github.com/anonb3ll/exocortex/commit/b8d79b843c96fec89e2de61b2780c19696f4b7aa", "commit SHA"],
    ["https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef/edit", "document id"],
    ["https://www.notion.so/ws/Page-Title-0123456789abcdef0123456789abcdef", "page id"],
    ["https://example.com/blog/2026/11/a-normal-post-title", "ordinary post"],
  ])("keeps %s (%s)", (url: string) => {
    expect(sanitizeCaptureUrl(url)).not.toBeNull();
  });

  test.each([
    ["https://example.com/reset-password/abc", "reset-password segment"],
    ["https://example.com/magic-link/fixture-only-material42", "magic-link segment"],
    ["https://example.com/users/ghp_abcdefghijklmnopqrstuvwxyz012345", "token prefix"],
  ])("refuses %s (%s)", (url: string) => {
    expect(sanitizeCaptureUrl(url)).toBeNull();
  });

  test("strips credential-shaped query values and fragments instead of refusing the visit", () => {
    expect(sanitizeCaptureUrl(`https://example.com/page?access_token=${["abcdef01", "23456789", "abcdef"].join("")}`))
      .toBe("https://example.com/page");
    expect(sanitizeCaptureUrl("https://example.com/oauth?code=0123456789abcdef0123456789abcdef"))
      .toBe("https://example.com/oauth");
    expect(sanitizeCaptureUrl(`https://example.com/page#token=${["01234567", "89abcdef", "01234567", "89abcdef"].join("")}`))
      .toBe("https://example.com/page");
  });

  test("keeps a benign query and fragment", () => {
    expect(sanitizeCaptureUrl("https://example.com/search?q=hello+world#results"))
      .toBe("https://example.com/search?q=hello+world#results");
  });

  // Documented tradeoff, not an oversight: a bare high-entropy path segment
  // with no credential cue is kept. Refusing it is what silently dropped every
  // GitHub commit, Google Doc and Notion page from capture.
  test("keeps a bare opaque path segment with no credential cue", () => {
    expect(sanitizeCaptureUrl("https://example.com/p/0123456789abcdef0123456789abcdef")).not.toBeNull();
  });
});
