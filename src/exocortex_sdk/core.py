"""Minimal governed Exocortex Core (task #1047).

``InMemoryCore`` is the production in-memory adapter that satisfies the Shape A
``ExocortexCore`` protocol. It enforces consent, privacy, scope isolation,
append-only writes, conflict visibility, and freshness at a single choke point.
"""

from __future__ import annotations

from exocortex_sdk.store import InMemoryStore, MemoryStore
from exocortex_sdk.types import (
    CaptureRequest,
    CoreError,
    CoreErrorCode,
    Evidence,
    EvidenceKind,
    ExplainResult,
    Freshness,
    LinkRequest,
    MemoryItem,
    MemoryKind,
    Provenance,
    RecallRequest,
    RecallResult,
    RecallStatus,
    RecordRequest,
    Scope,
    compute_freshness,
    is_query_privacy_blocked,
    item_in_scope,
)


class InMemoryCore:
    """Append-only in-memory Core with full governance enforcement."""

    def __init__(
        self,
        *,
        store: MemoryStore | None = None,
        now_ms: int = 0,
    ) -> None:
        self._store: MemoryStore = store if store is not None else InMemoryStore()
        self._seq = 0
        self._now_ms = now_ms
        # Optional existing-store seam attachment (set by build_core when flagged).
        self.hub_store: object | None = None

    def set_now(self, now_ms: int) -> None:
        self._now_ms = now_ms

    @property
    def store(self) -> MemoryStore:
        return self._store

    def _next_handle(self) -> str:
        self._seq += 1
        # Avoid colliding with any pre-seeded handles in a shared store.
        while True:
            handle = f"mem_{self._seq}"
            if self._store.get(handle) is None:
                return handle
            self._seq += 1

    def _append(self, item: MemoryItem) -> MemoryItem | CoreError:
        return self._store.append(item)

    def _find_title_conflict(
        self,
        *,
        scope: Scope,
        kind: MemoryKind,
        title: str,
        excerpt: str,
        project: str | None,
    ) -> MemoryItem | None:
        for existing in self._store.iter_items():
            if not item_in_scope(existing, scope):
                continue
            if (
                existing.kind == kind
                and existing.scope_project == project
                and existing.title == title
                and existing.excerpt != excerpt
            ):
                return existing
        return None

    def capture(self, scope: Scope, request: CaptureRequest) -> MemoryItem | CoreError:
        if not request.consent_granted:
            return CoreError(
                code=CoreErrorCode.CONSENT_REQUIRED,
                message="capture refused: local footprint consent not granted",
            )
        if request.privacy_blocked:
            return CoreError(
                code=CoreErrorCode.PRIVACY_BLOCKED,
                message="capture refused: privacy blocklist",
            )
        if request.kind not in scope.allow_kinds:
            return CoreError(
                code=CoreErrorCode.SCOPE_VIOLATION,
                message="capture kind not allowed in scope",
            )
        if scope.project is not None and request.scope_project not in (None, scope.project):
            return CoreError(
                code=CoreErrorCode.SCOPE_VIOLATION,
                message="capture project outside caller scope",
            )
        if not request.provenance.origin_machine.strip():
            return CoreError(
                code=CoreErrorCode.INVALID_INPUT,
                message="provenance.origin_machine required",
            )

        project = request.scope_project if request.scope_project is not None else scope.project
        conflict = self._find_title_conflict(
            scope=scope,
            kind=request.kind,
            title=request.title,
            excerpt=request.excerpt,
            project=project,
        )
        if conflict is not None:
            return CoreError(
                code=CoreErrorCode.CONFLICT,
                message=(
                    f"capture conflict: diverging content for kind={request.kind.value!r} "
                    f"title={request.title!r} (existing {conflict.handle})"
                ),
            )

        item = MemoryItem(
            handle=self._next_handle(),
            kind=request.kind,
            scope_project=project,
            title=request.title,
            excerpt=request.excerpt,
            parsed_at=request.parsed_at,
            provenance=request.provenance,
            tags=request.tags,
        )
        return self._append(item)

    def recall(self, scope: Scope, request: RecallRequest) -> RecallResult:
        query = (request.query or "").strip()
        if not query:
            return RecallResult(
                status=RecallStatus.EMPTY,
                query="",
                items=(),
                evidence=(),
                freshness=Freshness.LIVE,
            )

        if is_query_privacy_blocked(query):
            return RecallResult(
                status=RecallStatus.PRIVACY_BLOCKED,
                query="[blocked-query]",
                items=(),
                evidence=(),
                freshness=Freshness.LIVE,
                error=CoreError(
                    code=CoreErrorCode.PRIVACY_BLOCKED,
                    message="Search query matches privacy blocklist",
                ),
            )

        if request.require_vector and not request.embedding_available:
            return RecallResult(
                status=RecallStatus.EMBEDDING_UNAVAILABLE,
                query=query,
                items=(),
                evidence=(),
                freshness=Freshness.LIVE,
                error=CoreError(
                    code=CoreErrorCode.EMBEDDING_UNAVAILABLE,
                    message="semantic embedding unavailable",
                ),
            )

        q = query.lower()
        hits: list[MemoryItem] = []
        evidence: list[Evidence] = []
        for item in self._store.iter_items():
            if not item_in_scope(item, scope):
                continue
            haystack = f"{item.title} {item.excerpt}".lower()
            if q not in haystack and not any(tok in haystack for tok in q.split()):
                continue
            hits.append(item)
            evidence.append(
                Evidence(
                    kind=EvidenceKind.VECTOR if request.require_vector else EvidenceKind.LEXICAL,
                    source_ref=item.handle,
                    score=1.0,
                    match_kind="vector" if request.require_vector else "lexical",
                )
            )

        hits = hits[: max(1, request.limit)]
        evidence = evidence[: len(hits)]
        freshness = Freshness.LIVE
        if hits:
            freshness = compute_freshness(min(h.parsed_at for h in hits), self._now_ms)

        return RecallResult(
            status=RecallStatus.OK if hits else RecallStatus.EMPTY,
            query=query,
            items=tuple(hits),
            evidence=tuple(evidence),
            freshness=freshness,
        )

    def link(self, scope: Scope, request: LinkRequest) -> MemoryItem | CoreError:
        left = self._store.get(request.from_handle)
        right = self._store.get(request.to_handle)
        if left is None or right is None:
            return CoreError(code=CoreErrorCode.NOT_FOUND, message="link handle not found")
        if not item_in_scope(left, scope) or not item_in_scope(right, scope):
            return CoreError(
                code=CoreErrorCode.SCOPE_VIOLATION,
                message="link refused: handle outside caller scope",
            )
        item = MemoryItem(
            handle=self._next_handle(),
            kind=MemoryKind.LINK,
            scope_project=scope.project,
            title=f"{request.relation.value}:{request.from_handle}->{request.to_handle}",
            excerpt="",
            parsed_at=request.provenance.captured_at,
            provenance=request.provenance,
            tags=(request.from_handle, request.to_handle, request.relation.value),
        )
        return self._append(item)

    def record(self, scope: Scope, request: RecordRequest) -> MemoryItem | CoreError:
        if request.replace_handle is not None:
            return CoreError(
                code=CoreErrorCode.APPEND_ONLY_VIOLATION,
                message="record is append-only; overwrite refused",
            )
        if request.kind not in scope.allow_kinds:
            return CoreError(
                code=CoreErrorCode.SCOPE_VIOLATION,
                message="record kind not allowed in scope",
            )
        project = request.scope_project if request.scope_project is not None else scope.project
        conflict = self._find_title_conflict(
            scope=scope,
            kind=request.kind,
            title=request.title,
            excerpt=request.excerpt,
            project=project,
        )
        if conflict is not None:
            return CoreError(
                code=CoreErrorCode.CONFLICT,
                message=(
                    f"record conflict: diverging content for kind={request.kind.value!r} "
                    f"title={request.title!r} (existing {conflict.handle})"
                ),
            )
        item = MemoryItem(
            handle=self._next_handle(),
            kind=request.kind,
            scope_project=project,
            title=request.title,
            excerpt=request.excerpt,
            parsed_at=request.parsed_at,
            provenance=request.provenance,
            tags=request.tags,
        )
        return self._append(item)

    def explain(self, scope: Scope, handle: str) -> ExplainResult:
        item = self._store.get(handle)
        if item is None:
            return ExplainResult(
                handle=handle,
                item=None,
                provenance=None,
                evidence=(),
                freshness=Freshness.OFFLINE,
                error=CoreError(code=CoreErrorCode.NOT_FOUND, message="handle not found"),
            )
        if not item_in_scope(item, scope):
            return ExplainResult(
                handle=handle,
                item=None,
                provenance=None,
                evidence=(),
                freshness=Freshness.OFFLINE,
                error=CoreError(
                    code=CoreErrorCode.SCOPE_VIOLATION,
                    message="explain refused: item outside caller scope",
                ),
            )
        freshness = compute_freshness(item.parsed_at, self._now_ms)
        error: CoreError | None = None
        if freshness is Freshness.STALE:
            error = CoreError(
                code=CoreErrorCode.STALE,
                message="item older than retention freshness window",
            )
        return ExplainResult(
            handle=handle,
            item=item,
            provenance=item.provenance,
            evidence=(
                Evidence(
                    kind=EvidenceKind.PROJECTION,
                    source_ref=handle,
                    score=None,
                    match_kind=None,
                ),
            ),
            freshness=freshness,
            error=error,
        )


def make_provenance(
    *,
    captured_at: int = 1_000,
    recorded_at: int | None = None,
    consent_basis: str = "standing_local_capture",
    trust_tier: str = "local",
    origin_machine: str = "desktop",
    origin_surface: str = "browser",
) -> Provenance:
    return Provenance(
        origin_machine=origin_machine,
        origin_surface=origin_surface,  # type: ignore[arg-type]
        captured_at=captured_at,
        recorded_at=recorded_at if recorded_at is not None else captured_at,
        consent_basis=consent_basis,  # type: ignore[arg-type]
        trust_tier=trust_tier,  # type: ignore[arg-type]
    )
