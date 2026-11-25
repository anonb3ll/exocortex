// Privacy Blocklist Guard
// Ensures sensitive URLs, financial domains, and password/sensitive inputs are NEVER captured

export const SENSITIVE_DOMAINS = [
  "bank",
  "chase.com",
  "wellsfargo.com",
  "bankofamerica.com",
  "paypal.com",
  "stripe.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "dashlane.com",
  "coinbase.com",
  "robinhood.com",
  "fidelity.com",
  "vanguard.com",
  "schwab.com",
  "intuit.com",
  "turbotax.com",
  "plaid.com",
  "login",
  "auth"
];

// Account and sign-in hosts that carry none of the fragments above:
// accounts.google.com, myaccount.google.com, signin.aws.amazon.com. Kept apart
// from SENSITIVE_DOMAINS because that list also feeds the free-text query
// guard, where "accounts." would block ordinary sentences.
export const SENSITIVE_HOST_FRAGMENTS = ["accounts.", "myaccount.", "signin."];

const SENSITIVE_QUERY_PARAMS = [
  "token",
  "access_token",
  "auth",
  "api_key",
  "apikey",
  "secret",
  "session_id",
  "sid",
  "bearer",
  "jwt",
  "code",
  "password",
  "pass",
  "credential",
  "key",
  "state",
  "oauth_token",
  "refresh_token"
];

// Query guard list: credential-ish keywords plus the *named host* entries of
// SENSITIVE_DOMAINS. Bare brand names ("chase") and the generic hostname
// fragments ("bank", "login", "auth") are deliberately NOT here — they are
// URL-guard terms, and in free text they over-block ordinary queries
// ("chase the dog", "login page design"). See docs/privacy-guard.md
// "Two query guards".
const SENSITIVE_SEARCH_TERMS = [
  "password",
  "credential",
  "secret",
  ...SENSITIVE_DOMAINS.filter((domain) => domain.includes("."))
];

export function isSensitiveSearchTextBlocked(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return SENSITIVE_SEARCH_TERMS.some((term) => lower.includes(term));
}

/**
 * Shared query guard for every search surface. Free-text queries are checked
 * against a narrow keyword list (credential terms plus named sensitive hosts
 * such as `chase.com`) — deliberately narrower than the URL guard, whose
 * hostname fragments (`bank`, `login`, `auth`, bare brands) would over-block
 * ordinary prose. URL-shaped queries still go through the full `isUrlBlocked`
 * domain guard, so omitting a scheme does not open a bypass: `chase.com`
 * typed bare still matches the `chase.com` host term.
 */
export function isSearchQueryBlocked(query: string): boolean {
  if (!query) return false;
  const trimmed = query.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("chrome://")) {
    return isUrlBlocked(trimmed);
  }
  return isSensitiveSearchTextBlocked(trimmed);
}

export function isUrlBlocked(url: string): boolean {
  if (!url || typeof url !== "string") return true;

  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.startsWith("chrome://") ||
    lowerUrl.startsWith("chrome-extension://") ||
    lowerUrl.startsWith("about:") ||
    lowerUrl.startsWith("file://") ||
    lowerUrl.startsWith("edge://") ||
    lowerUrl.startsWith("brave://") ||
    lowerUrl.startsWith("view-source:")
  ) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Check hostname against sensitive domains list
    return (
      SENSITIVE_DOMAINS.some((domain) => host.includes(domain)) ||
      SENSITIVE_HOST_FRAGMENTS.some((fragment) => host.includes(fragment))
    );
  } catch {
    return true;
  }
}

/**
 * Strips sensitive query parameters (e.g. ?token=, ?access_token=) and credentials from URLs.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Strip username/password if present in URL
    parsed.username = "";
    parsed.password = "";

    // Filter out sensitive query params
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_QUERY_PARAMS.some((param) => lowerKey === param || lowerKey.includes(param))) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => parsed.searchParams.delete(key));

    // Remove fragment if it looks like an auth hash (e.g. #access_token=...)
    if (parsed.hash) {
      const lowerHash = parsed.hash.toLowerCase();
      if (SENSITIVE_QUERY_PARAMS.some((param) => lowerHash.includes(param))) {
        parsed.hash = "";
      }
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Scrubs sensitive elements (passwords, credit cards, auth tokens, hidden inputs) from a cloned Document
 * before passing it to Readability or storing page content.
 */
export function scrubSensitiveDom(doc: Document): Document {
  const sensitiveSelectors = [
    'input[type="password"]',
    'input[autocomplete*="password"]',
    'input[autocomplete*="cc-"]',
    'input[autocomplete*="one-time-code"]',
    'input[name*="password" i]',
    'input[name*="secret" i]',
    'input[name*="token" i]',
    'input[name*="ssn" i]',
    '[data-sensitive="true"]'
  ];

  sensitiveSelectors.forEach((selector) => {
    try {
      const elements = doc.querySelectorAll(selector);
      elements.forEach((el) => {
        if (el.tagName === "INPUT") {
          (el as HTMLInputElement).value = "";
          el.setAttribute("value", "");
        }
        el.remove();
      });
    } catch {
      // ignore selector syntax issues if any
    }
  });

  return doc;
}

/**
 * Redacts sensitive credentials, auth tokens, API keys, private keys, and PII from text excerpts.
 */
export function sanitizeExcerpt(text: string): string {
  if (!text || typeof text !== "string") return "";

  let sanitized = text;

  // 1. Private keys
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );

  // 2. Bearer & JWT tokens
  sanitized = sanitized.replace(
    /\b(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/gi,
    "$1[REDACTED_TOKEN]"
  );
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g,
    "[REDACTED_JWT]"
  );

  // 3. Known API Key prefixes
  sanitized = sanitized.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "[REDACTED_API_KEY]");
  sanitized = sanitized.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, "[REDACTED_GITHUB_KEY]");
  sanitized = sanitized.replace(/\b(AIza[0-9A-Za-z-_]{35})\b/g, "[REDACTED_GOOGLE_KEY]");

  // 4. Key-value secrets (e.g. password="...", api_key: "...", secret = "...")
  sanitized = sanitized.replace(
    /\b(password|passwd|pwd|secret|api_key|apikey|access_token|private_key)\s*([:=])\s*(['"][^'"]+['"]|[^\s,;]+)/gi,
    "$1$2[REDACTED_SECRET]"
  );

  // 5. US SSN and Credit Card numbers
  sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");
  sanitized = sanitized.replace(/\b(?:\d{4}[ -]?){3}\d{4}\b/g, "[REDACTED_CC]");

  return sanitized;
}

// The browser capture boundary preserves ordinary URL identity, but refuses a
// path that looks like a credential. Removing a path segment while still
// offering it as a resume target could send the user to a different page.
const CAPTURE_SECRET_SEGMENT = /^(?:token|access[_-]token|api[_-]?key|secret|credential|password|reset[_-]?password|magic[_-]?link|invite)$/i;

function decodeCaptureComponent(value: string): string | null {
  try {
    // Also inspect once-decoded values carrying another escaped layer; do not
    // let malformed encoding escape the capture boundary.
    const decoded = decodeURIComponent(value);
    return /%[\da-f]{2}/i.test(decoded) ? decodeURIComponent(decoded) : decoded;
  } catch {
    return null;
  }
}

// Explicit credential evidence only: text the excerpt scrubber would rewrite,
// or a known token prefix. Refusing a whole visit is the strongest response
// this boundary has, so it takes evidence rather than a length heuristic.
function hasCaptureSecretCue(value: string): boolean {
  return sanitizeExcerpt(value) !== value ||
    /(?:^|[^\w])(?:github_pat_|gh[opsru]_|xox[baprs]-|sk-)[a-z\d_-]{12,}/i.test(value);
}

// The long mixed-alphabet token heuristic, used only where the response is
// stripping a component out of the URL (query parameter, fragment). There an
// over-match costs one parameter; on the path it would cost the whole visit,
// which is how a commit SHA, a document id and a Notion page id all became
// uncapturable.
function looksLikeOpaqueSecret(value: string): boolean {
  return hasCaptureSecretCue(value) ||
    value.split(/[^a-z\d_+~-]+/i).some((part) =>
      part.length >= 24 && /[a-z]/i.test(part) && /\d/.test(part)
    );
}

/** Returns a capture-safe http(s) URL, or null when the visit should not be recorded. */
export function sanitizeCaptureUrl(url: string): string | null {
  if (isUrlBlocked(url)) return null;
  const parsed = new URL(sanitizeUrl(url));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const path = decodeCaptureComponent(parsed.pathname);
  if (path === null || hasCaptureSecretCue(path)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.slice(0, -1).some((segment) => CAPTURE_SECRET_SEGMENT.test(segment))) return null;

  const keysToDelete = new Set<string>();
  for (const [key, value] of parsed.searchParams) {
    // URLSearchParams already decodes one layer. A literal '%' in ordinary
    // prose is valid; only try to decode it again when there is an escape.
    const decodedKey = /%[\da-f]{2}/i.test(key) ? decodeCaptureComponent(key) : key;
    const decodedValue = /%[\da-f]{2}/i.test(value) ? decodeCaptureComponent(value) : value;
    if (decodedKey === null || decodedValue === null ||
        CAPTURE_SECRET_SEGMENT.test(decodedKey) || looksLikeOpaqueSecret(decodedKey) ||
        looksLikeOpaqueSecret(decodedValue) || /https?:\/\/|^\/\//i.test(decodedValue)) {
      keysToDelete.add(key);
    }
  }
  for (const key of keysToDelete) parsed.searchParams.delete(key);

  const fragment = decodeCaptureComponent(parsed.hash.slice(1));
  if (fragment === null || looksLikeOpaqueSecret(fragment) ||
      /https?:\/\/|^\/\//i.test(fragment) ||
      fragment.split(/[/?#=;&]/).some((part) => CAPTURE_SECRET_SEGMENT.test(part))) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/** Scrub credential-shaped text and links before a captured field fans out. */
export function sanitizeCapturedText(text: string): string {
  return sanitizeExcerpt(text.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const link = match.replace(/[)\],.;!?]+$/, "");
    const punctuation = match.slice(link.length);
    return (sanitizeCaptureUrl(link) ?? "[REDACTED_URL]") + punctuation;
  }));
}

/**
 * Sanitizes a URL for Knowledge Graph / Vault export.
 * Returns null if the URL belongs to a blocked/sensitive domain, internal scheme, or is unparseable.
 * Otherwise returns the URL with all sensitive query parameters, auth tokens, and credentials stripped.
 */
export function sanitizeUrlForKg(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  if (isUrlBlocked(url)) return null;

  const sanitized = sanitizeUrl(url);
  try {
    const parsed = new URL(sanitized);
    // Only permit http: and https: protocols for KG source references
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
