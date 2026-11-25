/**
 * Hostname matching on label boundaries.
 *
 * `url.includes("x.com")` is true for netflix.com and dropbox.com, and for any
 * URL that merely mentions the domain in its path or query. Matching the parsed
 * hostname against a registrable domain — equal to it, or a subdomain of it —
 * is the only test that means "this page is on that site".
 */

/** Lowercased hostname of an http(s)-style URL, or "" when it cannot be parsed. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when `hostname` is `domain` or a subdomain of it. */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = (hostname || "").toLowerCase().replace(/\.$/, "");
  const target = (domain || "").toLowerCase();
  if (!host || !target) return false;
  return host === target || host.endsWith(`.${target}`);
}

export function hostMatchesAny(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostMatchesDomain(hostname, domain));
}

/** Hostname without a leading `www.`, for display. */
export function displayHost(hostname: string): string {
  return (hostname || "").toLowerCase().replace(/^www\./, "");
}
