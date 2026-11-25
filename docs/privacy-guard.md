# Privacy guard

Fail-closed filter between capture, search, Focus Shield, and vault
export. Banking, credentials, privileged schemes, and unparseable URLs
never become dwell rows, embeddings, or MCP-visible memory.

This is **not** capture consent (`docs/capture-consent.md`). Consent
decides whether a dwell timer may arm. The privacy guard decides whether
a URL is eligible even after consent is on.

## Intent

Keep sensitive sessions out of IndexedDB and off every downstream
surface. The guard is substring-based on hostname by design: it would
rather over-block `login.example.com` than miss `mybank.example.com`.

Pinned by L2 (`tests/privacy-guard.test.ts`). Do not narrow the
blocklist to make a fixture pass.

## Architecture

```
raw URL
        │ isUrlBlocked()?  — hostname substring + privileged schemes
        │                   fail-closed on empty / unparseable
        ▼
sanitizeUrl()              — strip userinfo, secret query keys, auth hash
        │
        ├ dwell capture    — tracker + captureContext
        ├ Focus Shield     — no overlay / no parking on blocked tabs
        ├ open_memory      — re-check at open time (blocklist may have grown)
        ├ mobile recall    — skip blocked pages; shared query gate
        ├ panel / MCP semantic search — isSearchQueryBlocked before embed
        ├ federated KG     — sanitizeUrlForKg + sanitizeExcerpt
        └ omaCortex feed   — opt-in; repeats capture URL and text scrubbing,
                             then minimizes the URL for the native host
```

| Piece | Path | Role |
|---|---|---|
| Guard | `src/content/privacy.ts` | Block, sanitize, DOM scrub, excerpt/KG, query gate |
| Capture | `src/content/tracker.ts` | No timer, no `DWELL_RECORD` on blocked URLs |
| Workflow | `src/lib/context-workflow.ts` | `captureContext` returns false if blocked |
| Shield | `src/lib/focus-shield/*` | Overlay and parking skip blocked tabs |
| Bridge | `src/background/service-worker.ts` | `open_memory` re-checks before `tabs.create`; `semantic_search` re-checks the query |
| Panel | `src/sidepanel/semantic-search.ts` | Shared query gate before `REQUEST_VECTOR_EMBEDDING` |
| MCP | `src/mcp/tools.ts` / `src/bridge/protocol.ts` | `handleSemanticSearch` + `semantic_search` validator |
| Mobile | `src/lib/mobile-slice.ts` | Same query gate; `isUrlBlocked` over candidate pages |
| Vault | `src/mcp/federated-kg-aligner.ts` | Writes sanitized markdown only |
| omaCortex feed | `src/lib/omacortex-feed.ts` | Off by default; never sends a blocked or non-`http(s)` URL (`docs/omacortex-feed.md`) |

## Hostname blocklist

`isUrlBlocked` lowercases `url.hostname` and returns true if **any**
`SENSITIVE_DOMAINS` entry is a substring of that hostname
(`host.includes(domain)`). Path, query, and title are not consulted.

`SENSITIVE_HOST_FRAGMENTS` (`accounts.`, `myaccount.`, `signin.`) is checked
the same way. It covers account and sign-in hosts that contain none of the
tokens below, such as `accounts.google.com` and `signin.aws.amazon.com`. It
is a separate list because `SENSITIVE_DOMAINS` entries containing a dot also
feed the free-text query guard, where `accounts.` would block ordinary
sentences.

| Token | Why it is there |
|---|---|
| `bank` | Catches `chase` siblings and `mybank.example.com` |
| `login`, `auth` | Login/IdP hosts (`login.example.com`, `auth.example.com`) |
| `chase.com`, `wellsfargo.com`, `bankofamerica.com` | Named retail banks |
| `paypal.com`, `stripe.com`, `plaid.com` | Payments |
| `1password.com`, `bitwarden.com`, `lastpass.com`, `dashlane.com` | Password managers |
| `coinbase.com`, `robinhood.com` | Brokerage / crypto |
| `fidelity.com`, `vanguard.com`, `schwab.com` | Brokerage |
| `intuit.com`, `turbotax.com` | Tax / financial filing |

Privileged schemes are blocked before parse: `chrome://`,
`chrome-extension://`, `about:`, `file://`, `edge://`, `brave://`,
`view-source:`. Empty, non-string, and unparseable URLs are blocked.

`https://example.com/articles/1` and Wikipedia are allowed (L2).

## URL sanitization

`sanitizeUrl` is **not** a second blocklist. It keeps the URL but
strips:

- `username` / `password` in the authority
- Query keys whose lowercased name **equals or contains** a
  `SENSITIVE_QUERY_PARAMS` token
- The fragment if it contains any of those tokens (implicit OAuth
  `#access_token=…`)

Tokens: `token`, `access_token`, `auth`, `api_key`, `apikey`, `secret`,
`session_id`, `sid`, `bearer`, `jwt`, `code`, `password`, `pass`,
`credential`, `key`, `state`, `oauth_token`, `refresh_token`.

Because the match is `includes`, `?key=` also drops `keyboard_layout`,
`?code=` drops `postal_code`, `?pass=` can drop `bypass`, and `?auth=`
can drop `author`. Harmless `?page=` / `#section-2` stay.

Unparseable input is returned **unchanged**. Capture still fail-closes:
the tracker calls `isUrlBlocked(rawUrl)` before `sanitizeUrl`.

## Dwell capture and session metadata

Before sending a dwell record and again at worker ingress, captured titles,
excerpts, body text, site names, and bylines pass through the text scrubber.
Recognizable credentials and credential-bearing links are removed before the
worker sends text to classification or embeddings, writes visit/frame data,
or derives feed metadata. The direct local capture writer also applies this
policy. Body truncation happens after scrubbing.

`sanitizeCaptureUrl` retains ordinary HTTP(S) paths, query values, and section
links, drops sensitive or opaque query/fragment material, and rejects paths
that look like credential URLs rather than storing a broken resume link.
Dwell records and updates use the same canonical URL. This is pattern-based
minimization, not a guarantee that arbitrary strings contain no secret. It
protects new capture; it does not rewrite older rows, vectors, or files.

## DOM scrub and excerpt redaction

Before Readability, `scrubSensitiveDom` clones the document and removes
password / `cc-` / OTP / `name*="token|secret|password|ssn"` inputs and
`[data-sensitive="true"]`.

`sanitizeExcerpt` (vault + KG) replaces, in order: PEM private keys,
Bearer/JWT material, `sk-` / `ghp_` / `AIza` key prefixes, password /
api_key / access_token assignments, US SSNs, and 16-digit card-shaped
runs.

`sanitizeUrlForKg` returns `null` for blocked or non-`http(s)` URLs;
otherwise the sanitized URL. Blocked-domain entities can still produce
a Wiki note, but without a Captured Sources link. Vault path,
write-dir allowlist, and the CLI-Dexie vs Chrome-vault split:
`docs/federated-kg.md`.

## Two query guards

`isSearchQueryBlocked` is the **shared query gate for every semantic /
mobile recall surface**, not a mobile-only filter. Source comment in
`src/content/privacy.ts`: hostname fragments (`bank`, `login`, `auth`,
bare brands) stay on the URL guard so ordinary prose ("chase the dog",
"login page design") is not over-blocked.

| Guard | Used by | Behaviour |
|---|---|---|
| `isUrlBlocked` | Capture, Shield, KG, `open_memory`, mobile **page** filter | Hostname substrings + privileged schemes |
| `isSearchQueryBlocked` | Side-panel `searchPanelMemory`, MCP `exocortex_semantic_search` (tool + bridge validator + service worker), mobile recall **query** | Narrow keyword list (`password`, `credential`, `secret`, plus named bank/PM hosts that contain `.`). Generic `login` / `auth` / `chase` / `bank account` / `token` are **not** blocked. URL-shaped queries (`http(s)://`, `chrome://`) still go through `isUrlBlocked`. Omitting a scheme does not bypass: `chase.com` matches the host term. |

**Not on this gate:** `exocortex_search_memory` / `searchBrowserMemory`.
Keyword search can still match `page_text` for a string that semantic
search would refuse. Do not describe "all search" as query-guarded.

Do not describe mobile (or panel) search as using the full capture
blocklist. The Python SDK's `is_query_privacy_blocked` is a **contract
stand-in** (`password`, `credential`, `secret`, `chase.com`,
`1password.com` only) — not a clone of `SENSITIVE_SEARCH_TERMS`.

## Usage

Consent on + dwell ≥ 5s still records nothing on a blocked host.
`open_memory` can `blocked` a handle whose URL would be allowed at
capture time if the list grew later.

There is no UI to allowlist a domain and no MCP tool to bypass the
guard.

## Tests

- L2: `tests/privacy-guard.test.ts` — named banks, `'bank'` /
  `'login'` / `'auth'` substrings, privileged schemes, fail-closed
  garbage, query/fragment stripping
- Query gate: `tests/sidepanel-semantic-search.test.ts`,
  `tests/mobile-slice.test.ts` — `chase.com` blocked, bare `chase`
  and `bank of america login` allowed; embedder not called on block
- Adversarial (opt-in): `bun test verify/adversarial-probes.test.ts` —
  not part of `bun run test` (`package.json` runs `bun test tests/`);
  see `docs/verify.md`
- B*: `tests/smoke-privacy-guard.test.ts` (needs
  `seedCaptureConsent()`)

## Pitfalls

- **`login.` and `auth.` hosts never capture.** Docs, staging IdPs, and
  `auth0`-style subdomains match `login` / `auth` in the hostname.
- **`bank` is a substring.** `hamburg` is fine; `mybank.example.com` is
  not. Path `/login` on an otherwise allowed host is **not** blocked, so
  `github.com/login` and `id.atlassian.com/login` are still captured.
- **Not capture consent.** A blocked URL with the toggle on still
  produces no dwell. An allowed URL with the toggle off also produces
  none.
- **Query gate ≠ URL guard, and it is not mobile-only.** Searching for
  `login` or `chase` is allowed on panel, MCP semantic search, and
  mobile recall; capturing `https://login.example.com/` or querying
  `chase.com` is not.
- **Keyword search skips the query gate.** `exocortex_search_memory`
  can return hits for strings semantic search would throw on.
- **`sanitizeUrl` does not fail closed.** Garbage in, garbage out —
  callers must block first.
- **Query-key `includes` is aggressive.** Any param name containing
  `key`, `code`, `pass`, `auth`, or `state` is stripped.
- **Vault write is local disk.** KG sanitization is the disk-side
  twin of the wire redaction; `locked: true` notes are skipped, not
  rewritten. The aligner does **not** read Chrome Dexie
  (`docs/federated-kg.md`).
