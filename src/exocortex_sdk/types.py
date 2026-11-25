"""Exocortex Core SDK contract types (task #1046).

These types are the implementation seam for task #1047. They deliberately omit
raw URLs and page bodies on the wire-facing MemoryItem so adapters can keep
sensitive fields behind the local store boundary (see mobile-slice redaction and
projection contract-v1).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

OriginSurface = Literal["browser", "desktop", "vault", "mobile"]
TrustTier = Literal["local", "remote", "vault"]
ConsentBasis = Literal[
    "explicit_user_action",
    "standing_local_capture",
    "derived_aggregate",
]


class MemoryKind(StrEnum):
    """Closed vocabulary of memory kinds for the Core interface.

    Aligns with projection KIND_FIELDS in src/lib/projection/contract-v1.ts and
    the dwell/page capture path — not a broad ontology.
    """

    PAGE_DWELL = "page_dwell"
    FOCUS_ANCHOR = "focus_anchor"
    COGNITIVE_FRAME = "cognitive_frame"
    CHECKPOINT = "checkpoint"
    LINK = "link"
    NOTE = "note"
    TASK_REFERENCE = "task_reference"


class Freshness(StrEnum):
    LIVE = "live"
    STALE = "stale"
    OFFLINE = "offline"


class RecallStatus(StrEnum):
    OK = "ok"
    EMPTY = "empty"
    PRIVACY_BLOCKED = "privacy_blocked"
    EMBEDDING_UNAVAILABLE = "embedding_unavailable"
    ERROR = "error"


class CoreErrorCode(StrEnum):
    PRIVACY_BLOCKED = "privacy_blocked"
    CONSENT_REQUIRED = "consent_required"
    SCOPE_VIOLATION = "scope_violation"
    NOT_FOUND = "not_found"
    STALE = "stale"
    CONFLICT = "conflict"
    EMBEDDING_UNAVAILABLE = "embedding_unavailable"
    INVALID_INPUT = "invalid_input"
    APPEND_ONLY_VIOLATION = "append_only_violation"


class EvidenceKind(StrEnum):
    VECTOR = "vector"
    LEXICAL = "lexical"
    USER_ACTION = "user_action"
    LINK = "link"
    PROJECTION = "projection"


class LinkRelation(StrEnum):
    DERIVED_FROM = "derived_from"
    SUPPORTS = "supports"
    TASK_REF = "task_ref"
    RELATED = "related"


# ---------------------------------------------------------------------------
# Core domain types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Scope:
    """Caller authority boundary for every Core operation.

    Items returned by recall/explain must be inside this scope. A project set to
    None means "any project the caller may see within allow_kinds"; a non-None
    project restricts to that project id only.
    """

    caller_id: str
    project: str | None
    trust_tier: TrustTier
    allow_kinds: frozenset[MemoryKind]


@dataclass(frozen=True, slots=True)
class Provenance:
    """Where and under what consent a memory item was produced."""

    origin_machine: str
    origin_surface: OriginSurface
    captured_at: int  # epoch ms — user activity time
    recorded_at: int  # epoch ms — when Core accepted the write
    consent_basis: ConsentBasis
    trust_tier: TrustTier


@dataclass(frozen=True, slots=True)
class Evidence:
    """Evidence backing a recall hit or explain chain.

    ``source_ref`` is an opaque handle (e.g. mem_42), never a raw URL — matching
    the MCP search_memory redaction boundary and mobile-slice handles.
    """

    kind: EvidenceKind
    source_ref: str
    score: float | None = None
    match_kind: Literal["vector", "lexical"] | None = None


@dataclass(frozen=True, slots=True)
class MemoryItem:
    """Wire-facing memory record.

    Intentionally has no ``url`` field. Adapters may hold URLs internally; the
    Core contract surfaces handles + sanitized text only.
    """

    handle: str
    kind: MemoryKind
    scope_project: str | None
    title: str
    excerpt: str
    parsed_at: int
    provenance: Provenance
    tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CoreError:
    code: CoreErrorCode
    message: str


@dataclass(frozen=True, slots=True)
class RecallResult:
    status: RecallStatus
    query: str
    items: tuple[MemoryItem, ...]
    evidence: tuple[Evidence, ...]
    freshness: Freshness
    error: CoreError | None = None


@dataclass(frozen=True, slots=True)
class CaptureRequest:
    kind: MemoryKind
    title: str
    excerpt: str
    parsed_at: int
    provenance: Provenance
    scope_project: str | None = None
    tags: tuple[str, ...] = ()
    # Mirrors tracker.ts loadConsent(): capture is refuse-closed without opt-in.
    consent_granted: bool = True
    # Adapter-private: blocked URL / sensitive content marker (never returned).
    privacy_blocked: bool = False


@dataclass(frozen=True, slots=True)
class RecallRequest:
    query: str
    limit: int = 10
    require_vector: bool = False
    # When True, simulate embedder outage (maps to panel embedding_unavailable).
    embedding_available: bool = True


@dataclass(frozen=True, slots=True)
class LinkRequest:
    from_handle: str
    to_handle: str
    relation: LinkRelation
    provenance: Provenance


@dataclass(frozen=True, slots=True)
class RecordRequest:
    kind: MemoryKind
    title: str
    excerpt: str
    parsed_at: int
    provenance: Provenance
    scope_project: str | None = None
    tags: tuple[str, ...] = ()
    # If set, attempts to overwrite an existing handle — must be refused.
    replace_handle: str | None = None


@dataclass(frozen=True, slots=True)
class ExplainResult:
    handle: str
    item: MemoryItem | None
    provenance: Provenance | None
    evidence: tuple[Evidence, ...]
    freshness: Freshness
    error: CoreError | None = None


@dataclass(frozen=True, slots=True)
class ContractCase:
    """Named contract case for the #1047 implementation lane."""

    name: str
    operation: Literal["capture", "recall", "link", "record", "explain"]
    input_summary: str
    asserted_invariant: str


# Default stale threshold used by freshness helpers (7 days, matches retention).
DEFAULT_STALE_AFTER_MS: int = 7 * 24 * 60 * 60 * 1000

# Sensitive query tokens mirroring the spirit of isSearchQueryBlocked / hostname
# heuristics — a minimal Python-side stand-in for contract tests, not a fork of
# the TypeScript blocklist.
SENSITIVE_QUERY_MARKERS: frozenset[str] = frozenset(
    {
        "password",
        "credential",
        "secret",
        "chase.com",
        "1password.com",
    }
)


CONTRACT_CASES: tuple[ContractCase, ...] = (
    ContractCase(
        name="capture_requires_consent",
        operation="capture",
        input_summary="CaptureRequest.consent_granted=False (tracker opt-in off)",
        asserted_invariant="capture refuses writes without consent (CONSENT_REQUIRED)",
    ),
    ContractCase(
        name="capture_privacy_blocked",
        operation="capture",
        input_summary="CaptureRequest.privacy_blocked=True",
        asserted_invariant="capture returns PRIVACY_BLOCKED and stores nothing",
    ),
    ContractCase(
        name="recall_scope_isolation",
        operation="recall",
        input_summary="mixed-project store, Scope.project='alpha'",
        asserted_invariant="RecallResult never returns items outside the caller Scope",
    ),
    ContractCase(
        name="recall_privacy_blocked_query",
        operation="recall",
        input_summary="query containing a sensitive marker",
        asserted_invariant="status is PRIVACY_BLOCKED and items is empty",
    ),
    ContractCase(
        name="recall_embedding_unavailable",
        operation="recall",
        input_summary="RecallRequest(require_vector=True, embedding_available=False)",
        asserted_invariant="status is EMBEDDING_UNAVAILABLE and items is empty",
    ),
    ContractCase(
        name="record_append_only",
        operation="record",
        input_summary="RecordRequest.replace_handle set to an existing handle",
        asserted_invariant="record refuses overwrite (APPEND_ONLY_VIOLATION)",
    ),
    ContractCase(
        name="link_both_handles_in_scope",
        operation="link",
        input_summary="to_handle owned by another project",
        asserted_invariant="link refuses when either handle is outside Scope",
    ),
    ContractCase(
        name="explain_scope_gated",
        operation="explain",
        input_summary="handle in a foreign project",
        asserted_invariant="explain returns SCOPE_VIOLATION / NOT_FOUND, never foreign item",
    ),
)


def is_query_privacy_blocked(query: str) -> bool:
    """Contract-level query guard (Python stand-in for isSearchQueryBlocked)."""
    lowered = (query or "").strip().lower()
    if not lowered:
        return False
    return any(marker in lowered for marker in SENSITIVE_QUERY_MARKERS)


def item_in_scope(item: MemoryItem, scope: Scope) -> bool:
    """Return True iff ``item`` is visible under ``scope``."""
    if item.kind not in scope.allow_kinds:
        return False
    if scope.project is not None and item.scope_project != scope.project:
        return False
    # Remote callers may not see local-only trust unless tier allows.
    if scope.trust_tier == "local" and item.provenance.trust_tier == "remote":
        return False
    return True


def compute_freshness(
    captured_at: int,
    now_ms: int,
    stale_after_ms: int = DEFAULT_STALE_AFTER_MS,
) -> Freshness:
    if now_ms < captured_at:
        return Freshness.LIVE
    age = now_ms - captured_at
    if age > stale_after_ms:
        return Freshness.STALE
    return Freshness.LIVE


def memory_item_field_names() -> frozenset[str]:
    """Closed field set for MemoryItem — used to assert no URL leakage."""
    return frozenset(MemoryItem.__dataclass_fields__.keys())
