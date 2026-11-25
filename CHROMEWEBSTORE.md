# Chrome Web Store Listing — Project Exocortex

> Last Updated: 2026-09-14

## Store Listing

**Extension Name** [REQUIRED]
Project Exocortex

**Short Description** [REQUIRED]
Local Footprint & Externalized Working Memory for Chrome

**Detailed Description** [REQUIRED]
Project Exocortex helps knowledge workers, researchers, and engineers maintain focus and recover cognitive context without context-switch fatigue.

Key features:
- Cognitive state tracking: Records active dwell and reading sessions locally to reconstruct working context.
- Where Was I popup: Instantly recall your latest focused reading session and resume your prior workflow.
- Focus Shield: Detects rapid tab thrashing and cognitive fatigue, parking distraction tabs into a group and surfacing context restoration prompts.
- Side Panel Dashboard: View your real-time cognitive load telemetry, working memory stack, and historical semantic knowledge.
- Local First Privacy: All indexed content, embeddings, and cognitive frames reside strictly in your local browser storage (IndexedDB). When enabled, sanitized context summaries are written to your local Obsidian Wiki/vault, and minimized query results or telemetry are exchanged strictly over localhost via the local unified-agent socket. Zero page content or telemetry is ever sold or transmitted off-device.

How to use:
1. Browse normally. Capture is **off by default** — after you enable "Local footprint capture" in the side panel (the in-product consent disclosure), pages you spend >5 seconds on are recorded as local dwell checkpoints.
2. Click the toolbar icon or "Open Side Panel" to inspect your cognitive trail and active memory stack.
3. If Focus Shield activates during high fatigue, click "Restore context" to see your previous deep work anchor or "Park distraction tabs" to clean up your workspace.

Privacy note:
All page text analysis, vector embeddings, and cognitive evaluations execute 100% locally on your machine via WebGPU/WASM and browser IndexedDB. Sanitized content written to the local Obsidian Wiki/vault or exchanged with the local unified-agent socket remains entirely on-device. A prominent in-product disclosure with affirmative user consent is required before collecting any web history, user activity, or website content; internal Focus Shield states or consentBasis metadata do not constitute consent.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Externalizes user cognitive context by tracking active reading dwell locally and surfacing context anchors to prevent task fatigue.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `public/icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | `docs/screenshots/sidepanel.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | `docs/screenshots/popup.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | `docs/screenshots/focus-shield.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | Reads tab URLs and titles to detect active reading sessions, monitor task transitions, and calculate context switch penalties. |
| `storage` | permissions | Persists capture consent (`exocortexCaptureConsent`), Focus Shield preferences, parked group IDs, and ephemeral service worker session state across browser wakeups. |
| `sidePanel` | permissions | Provides the primary Exocortex user dashboard displaying cognitive timeline, working memory stack, and telemetry metrics. Opening the panel requires chrome.sidePanel.open() which must be triggered strictly by direct user gestures (such as clicking the popup button or Focus Shield action). |
| `activeTab` | permissions | Grants temporary access to the current foreground tab upon user invocation to inspect active tab context and trigger restoration actions. |
| `tabGroups` | permissions | Creates and manages the "Exocortex — Parked Context" tab group to temporarily collapse distraction tabs during fatigue interventions. |
| `offscreen` | permissions | Hosts the local WebGPU and WASM embedding pipeline to generate vector representations of saved excerpts off the main thread. |
| `nativeMessaging` | permissions | Communicates with the optional local Exocortex MCP server on localhost for external agent integration, and — only if the user turns on the off-by-default "Also send page titles to omaCortex" setting — passes page titles and minimized URLs (never page text) to the user's local omaCortex recorder. |
| `<all_urls>` | host_permissions | Required to capture reading dwell and extract article summaries across arbitrary documentation and research websites visited by the user. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes (stored locally only; never transmitted off-device)

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | No | No | N/A | No |
| Personal communications | No | No | N/A | No |
| Location | No | No | N/A | No |
| Web history | Yes (Local only) | No | Reconstructing working context and active dwell; stored locally in IndexedDB and optional local Obsidian Wiki/vault | No |
| User activity | Yes (Local only) | No | Detecting tab switches and cognitive fatigue index; minimized telemetry exchanged strictly via local unified-agent socket | No |
| Website content | Yes (Local only) | No | Local search indexing and vector embeddings via on-device models; optional local Obsidian notes | No |

### In-Product Disclosure & Consent Requirement
Collection of web history, user activity, or website content begins only after the user affirmatively enables "Local footprint capture" in the side panel — a prominent in-product disclosure stating that recording stays on-device. Operational mechanics like Focus Shield activation or internal `consentBasis` metadata tokens do not substitute for this affirmative user opt-in, and the capture pipeline (content-script dwell timers) is gated on that stored consent state at runtime.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://github.com/anonb3ll/exocortex/blob/main/docs/PRIVACY.md

---

## Distribution

**Visibility**: Unlisted
**Regions**: All regions
**Pricing**: Free

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-09-04 | Initial Manifest V3 build with side panel, focus shield, and local embeddings | Draft |
