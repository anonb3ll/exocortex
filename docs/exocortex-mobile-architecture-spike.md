# Exocortex Mobile Architecture Spike & Thin Slice ADR

**Status**: Accepted / Implemented  
**Date**: 2026-08-17  
**Parent**: Tasks #408, #411, #421  
**Author**: anonb3ll  

> **Operator note (2026-10-19):** Desktop capture is consent-gated
> dwell + Readability (`docs/capture-consent.md`). OCR is not shipped
> (`extractOcrTextFromImageData` returns `""`). The executive-summary
> mention of "OCR frames" below is historical framing, not current
> behavior. Live embedder: `docs/on-device-embeddings.md`.
> `isSearchQueryBlocked` is the **shared** query gate (panel, MCP
> `exocortex_semantic_search`, mobile recall) — not mobile-only — and
> is still narrower than the capture hostname guard
> (`docs/privacy-guard.md`, `docs/semantic-search.md`).  

---

## 1. Executive Summary & Problem Framing

A mobile surfaces program prioritized an Apple Watch interface for `unified-agent`, followed by an Exocortex mobile architecture spike and thin-slice implementation.

On desktop (Linux/macOS), Exocortex operates as a Manifest V3 browser extension and native MCP relay capturing DOM, tab dwell time, and OCR frames with local Dexie storage and vector search. 

On mobile (iOS/iPadOS), platform boundaries fundamentally change what is viable:
- iOS restricts continuous background execution, cross-app screen capture, and arbitrary tab scraping.
- Mobile Safari WebExtensions require explicit user activation or per-domain permissions and do not run continuous desktop-like background daemons.
- Mobile usage patterns demand **instant recall, glanceable focus state, and task projection**, rather than high-overhead background passive capture.

---

## 2. Architectural Options Evaluated

### Option A: Direct Port of MV3 Extension to Safari WebExtension (Rejected)
* **Concept**: Port the desktop MV3 extension to Safari WebExtension on iOS.
* **Drawbacks**: Background workers are suspended aggressively by iOS; native messaging to local binaries is unsupported on iOS; local ONNX/WASM embeddings and OCR incur heavy battery and memory penalties; passive cross-app browsing capture is impossible.
* **Verdict**: Rejected for background capture.

### Option B: Full Standalone Mobile App with Heavy Local DB Sync (Rejected for Initial Slice)
* **Concept**: Build a full Swift/React-Native app that replicates Dexie, embeddings, and full-text search locally via CloudKit or SQLite sync.
* **Drawbacks**: High complexity, large payload sync surface, potential secret/token leakage on lost devices, and high maintenance overhead before mobile usage patterns are proven.
* **Verdict**: Deferred.

### Option C: Shared Core with Mobile Projection & Sanitized Recall (Recommended / Selected)
* **Concept**: Position Exocortex mobile as a **lightweight, privacy-preserving projection and recall client**:
  1. **Recall**: Search over sanitized metadata and opaque handles (`mem_<id>`) rather than raw URLs or full DOM text.
  2. **Focus Anchor Projection**: Expose the current working context, cognitive load level, and intent category as a glanceable envelope.
  3. **Task Projection**: Bidirectional linkage between active tasks (`ua://task/<id>`) and focus state.
  4. **Honest States**: Distinguish `live`, `stale`, `offline`, and `privacy_blocked` conditions without fabricating data.
* **Advantages**: Minimal latency, Zero credential exposure, strict privacy filtering at the source, and 100% compatibility with `unified-agent`'s `mobile.v1` contract.

---

## 3. Data Flow & Privacy Contract

```
+---------------------------+       Sanitized Recall Query
|   Exocortex Mobile        | -----------------------------------> +-------------------------+
|   Client (Watch / iOS)    |                                      |  Exocortex Service /    |
|                           | <----------------------------------- |  MCP Projection Layer   |
| - Opaque Handles (mem_1)  |      Sanitized Metadata Envelope     +-------------------------+
| - Redacted Link Texts     |      (No raw URLs / No Auth Tokens)               |
| - Focus State & Task Ref  |                                                   v
+---------------------------+                                        +--------------------+
                                                                     | Dexie DB / Storage |
                                                                     +--------------------+
```

### Privacy & Sanitization Guarantees:
1. **Opaque Handles**: Memories are referenced via opaque handles (`mem_<id>`) rather than URLs or URL hashes, preventing rainbow-table deanonymization of browsing history.
2. **Link Redaction**: Free-text excerpts and titles strip URL-like patterns (`/(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi` -> `[redacted-link]`).
3. **Fail-Closed Privacy Guard**: Query blocking is a narrow fixed list in `isSearchQueryBlocked()` (shared by mobile recall, the side-panel search box, and MCP `exocortex_semantic_search`) — credential-ish keywords (`password`, `credential`, `secret`) plus specific banking/password-manager host substrings (`chase.com`, `bankofamerica.com`, `wellsfargo.com`, `1password.com`, `bitwarden.com`, `lastpass.com`, `coinbase.com`, `robinhood.com`). Generic terms such as `bank account`, `login`, `auth`, or `token` are **not** blocked. URL-shaped queries still go through the full `isUrlBlocked()` domain guard used elsewhere. `exocortex_search_memory` does not use this gate.
4. **Bounded Payloads**: All records strictly enforce size limits (≤ 8 KB per record) and field truncation ceilings.

---

## 4. Acceptance Criteria & Test Matrix

- [x] Opaque handle generation and resolution (`mem_<id>`).
- [x] URL and sensitive pattern redaction in search excerpts and titles.
- [x] Privacy guard blocking the listed sensitive host/keyword substrings from recall (not a general banking/login category filter).
- [x] Focus anchor projection with intent category, cognitive load, and state digest.
- [x] Task reference projection linking active focus to task IDs.
- [x] Envelopes supporting honest status states: `live`, `stale`, `offline`, `auth_required`, `hub_unavailable`, `privacy_blocked`.
- [x] Automated test coverage verifying contract compliance and error handling.

---

## 5. Platform Capability Breakdown

| Layer | Technology | Responsibilities | Constraints / Platform Realities |
|---|---|---|---|
| **Shared Core** | TypeScript / ESM (`mobile-slice.ts`) | Query sanitization, link redaction, privacy blocklist, projection envelopes, task linking | Runs in WebExtension background or headless Node/Bun test environments; zero platform-specific dependencies |
| **Mobile Web / PWA** | Vanilla HTML/CSS/TS | Responsive companion UI for tablets and phones; read-only attention, focus, and memory recall | Fast delivery; runs within standard browser sandboxes without App Store review cycles |
| **Native iOS / iPadOS** | Swift / SwiftUI | View layouts, deep-link routing (`ua://...`), background push receipt (APNs) | Requires developer provisioning and Xcode toolchain; sandbox blocks arbitrary filesystem or inter-app memory scraping |
| **Native watchOS** | Swift / WatchKit / WidgetKit | Complications, Glance cards, urgent alerts | Strict execution budget (~8 KB payload limits, limited background wakeups); read-only first |

---

## 6. Risk Register & Non-Goals

### Explicit Non-Goals:
1. **No Continuous Background Screen Capture**: iOS prohibits passive background frame capture across other applications. Exocortex mobile will not attempt to bypass this with private APIs.
2. **No Raw Password or Auth Token Projection**: Credentials, login queries, and secret-bearing parameters are strictly scrubbed before transmission.
3. **No Direct Watch Credential Storage**: Apple Watch acts solely as a projection receiver from the paired iPhone companion or local hub.

### Risk Register & Mitigations:
- **Risk 1 (Stale Data During Connectivity Drop)**: Mitigated by `freshness` timestamps and explicit `stale`/`offline` status markers in the top-level envelope.
- **Risk 2 (Replay / Duplicate Notifications)**: Mitigated by opaque `projection_id` and stable `event_ref` tracking on client surfaces.
- **Risk 3 (Token Leakage via URL Fragments)**: Mitigated by `sanitizeUrl` stripping sensitive query params and free-text regex redacting `[redacted-link]`.

---

## 7. Desktop side-panel preview (task #462)

No Watch or iOS binary ships in this repo. The Chrome side panel hosts a
human-facing projection of the same mobile-slice contract so a developer
can see what a companion client would receive without leaving the
extension.

| Piece | Path |
|---|---|
| Shared sanitizers / envelopes | `src/lib/mobile-slice.ts` (`MOBILE_SLICE_VERSION = "1.0"`) |
| View + freshness | `src/sidepanel/mobile-slice-view.ts` |
| Wiring | `renderMobileSliceProjection()` in `src/sidepanel/sidepanel.ts` |
| Markup | `#mobile-slice-panel` in `src/sidepanel/sidepanel.html` |

**What it shows**

- Focus glance: entity, state digest, intent category, cognitive-load
  level, optional `ua://task/<id>` ref, origin ref.
- Sanitized recall: the side-panel search box feeds
  `searchMobileMemoryPure(..., { limit: 5 })` over local `page_text`.
  Results are opaque `mem_<id>` handles, titles/excerpts with URL-like
  substrings replaced by `[redacted-link]`, and no raw URLs.

The same `#search-input` (200ms debounce) also replaces the
**timeline** via `searchPanelMemory` / `hybridVectorSearch`. That is a
different contract: `matchKind` badges, clickable page URLs, and
**Reopen Tab**. Do not treat timeline cards as the mobile-slice
envelope. Operator surface for both paths, plus Librarian Vault vs
MCP `exocortex_search_semantic_vault`: `docs/sidepanel.md`.

**Freshness / health** (clock, not a network probe):

| Age of latest focus source | Freshness | Health (no error) |
|---|---|---|
| ≤ 5 minutes (`LIVE_THRESHOLD_MS`) | `live` | `healthy` |
| ≤ 24 hours (`STALE_THRESHOLD_MS`) | `stale` | `degraded` |
| older / missing | `offline` | `unavailable` |

Recall status is independent: `ok`, `empty`, `privacy_blocked`, or
`error`. The query blocklist is the fixed keyword/host list in
`isSearchQueryBlocked()` (see §3) — not a general banking/credential
category filter — and blocked queries return `privacy_blocked` without
searching.

**Constraints / quirks**

- Title ≤ 100 chars, excerpt ≤ 160 chars, envelope records ≤ 8 KB
  (ADR §3). The desktop preview uses the same sanitizers.
- `originMachine` is currently hardcoded to `"DesktopUbuntu"` in the
  side-panel projection. That is a label, not a security claim.
- This is a read-only preview of local Dexie state. It does not sync to
  a phone, send APNs, or open `ua://` deep links.
- Freshness compares `dwell_blocks.timestamp` and
  `cognitive_frames.timestampUtc` as a **shared capture clock**. The dwell
  path stamps both with the dwell payload time (`971fdfa`), not "when
  MiniLM finished", so a slower embed cannot make an older page look
  newer. MCP `exocortex_record_frame` still uses wall-clock completion.

