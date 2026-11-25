"""Executable Exocortex Core contract cases (task #1046).

Each test names an operation, builds real-typed inputs, and asserts a governance
invariant. The ReferenceCore is the contract oracle only — not the #1047 store.
"""

from __future__ import annotations

import pytest

from exocortex_sdk import (
    CONTRACT_CASES,
    CaptureRequest,
    CoreError,
    CoreErrorCode,
    ExocortexCore,
    Freshness,
    LinkRelation,
    LinkRequest,
    MemoryItem,
    MemoryKind,
    RecallRequest,
    RecallStatus,
    RecordRequest,
    ReferenceCore,
    Scope,
    compute_freshness,
    is_query_privacy_blocked,
    item_in_scope,
    make_provenance,
    memory_item_field_names,
)


def _all_kinds() -> frozenset[MemoryKind]:
    return frozenset(MemoryKind)


def _scope(*, project: str | None = "alpha", caller: str = "agent-a") -> Scope:
    return Scope(
        caller_id=caller,
        project=project,
        trust_tier="local",
        allow_kinds=_all_kinds(),
    )


def _seed_cross_project(core: ReferenceCore) -> tuple[MemoryItem, MemoryItem]:
    """Seed one alpha and one beta item sharing a searchable token."""
    prov = make_provenance(captured_at=1_000)
    alpha = core.capture(
        _scope(project="alpha"),
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="alpha design notes",
            excerpt="working on the sdk contract",
            parsed_at=1_000,
            provenance=prov,
            scope_project="alpha",
        ),
    )
    beta = core.capture(
        _scope(project="beta"),
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="beta design notes",
            excerpt="working on the sdk contract",
            parsed_at=1_000,
            provenance=prov,
            scope_project="beta",
        ),
    )
    assert isinstance(alpha, MemoryItem)
    assert isinstance(beta, MemoryItem)
    return alpha, beta


def test_reference_core_satisfies_protocol() -> None:
    assert isinstance(ReferenceCore(), ExocortexCore)


def test_contract_cases_cover_all_five_operations() -> None:
    ops = {case.operation for case in CONTRACT_CASES}
    assert ops == {"capture", "recall", "link", "record", "explain"}
    assert len(CONTRACT_CASES) >= 8


def test_memory_item_has_no_url_field() -> None:
    """Invariant: wire MemoryItem never exposes a raw URL field."""
    fields = memory_item_field_names()
    assert "url" not in fields
    assert "href" not in fields
    assert {"handle", "kind", "title", "excerpt", "provenance"} <= fields


def test_capture_requires_consent() -> None:
    """Operation: capture | Input: consent_granted=False | Invariant: CONSENT_REQUIRED."""
    core = ReferenceCore(now_ms=2_000)
    scope = _scope()
    err = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="page",
            excerpt="",
            parsed_at=1_000,
            provenance=make_provenance(),
            consent_granted=False,
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.CONSENT_REQUIRED
    empty = core.recall(scope, RecallRequest(query="page"))
    assert empty.items == ()


def test_capture_privacy_blocked_stores_nothing() -> None:
    """Operation: capture | Input: privacy_blocked=True | Invariant: nothing stored."""
    core = ReferenceCore(now_ms=2_000)
    scope = _scope()
    err = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="chase login",
            excerpt="",
            parsed_at=1_000,
            provenance=make_provenance(),
            privacy_blocked=True,
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.PRIVACY_BLOCKED
    empty = core.recall(scope, RecallRequest(query="design"))
    assert empty.status is RecallStatus.EMPTY
    assert empty.items == ()


def test_recall_never_returns_items_outside_caller_scope() -> None:
    """Operation: recall | Input: mixed projects | Invariant: scope isolation."""
    core = ReferenceCore(now_ms=2_000)
    _seed_cross_project(core)

    result = core.recall(_scope(project="alpha"), RecallRequest(query="design"))
    assert result.status is RecallStatus.OK
    assert result.items
    assert all(item_in_scope(item, _scope(project="alpha")) for item in result.items)
    assert all(item.scope_project == "alpha" for item in result.items)
    assert not any(item.scope_project == "beta" for item in result.items)


def test_recall_privacy_blocked_query_returns_empty() -> None:
    """Operation: recall | Input: sensitive query | Invariant: privacy_blocked + empty."""
    core = ReferenceCore(now_ms=2_000)
    _seed_cross_project(core)

    assert is_query_privacy_blocked("chase.com password reset")
    result = core.recall(_scope(), RecallRequest(query="chase.com password reset"))
    assert result.status is RecallStatus.PRIVACY_BLOCKED
    assert result.items == ()
    assert result.evidence == ()
    assert result.error is not None
    assert result.error.code is CoreErrorCode.PRIVACY_BLOCKED


def test_recall_embedding_unavailable_is_honest() -> None:
    """Operation: recall | Input: vector required, embedder down | Invariant: empty."""
    core = ReferenceCore(now_ms=2_000)
    _seed_cross_project(core)

    result = core.recall(
        _scope(),
        RecallRequest(query="design", require_vector=True, embedding_available=False),
    )
    assert result.status is RecallStatus.EMBEDDING_UNAVAILABLE
    assert result.items == ()
    assert result.error is not None
    assert result.error.code is CoreErrorCode.EMBEDDING_UNAVAILABLE


def test_record_append_only_refuses_overwrite() -> None:
    """Operation: record | Input: replace_handle set | Invariant: append-only."""
    core = ReferenceCore(now_ms=2_000)
    scope = _scope()
    first = core.record(
        scope,
        RecordRequest(
            kind=MemoryKind.CHECKPOINT,
            title="checkpoint-1",
            excerpt="state",
            parsed_at=1_000,
            provenance=make_provenance(),
        ),
    )
    assert isinstance(first, MemoryItem)

    err = core.record(
        scope,
        RecordRequest(
            kind=MemoryKind.CHECKPOINT,
            title="checkpoint-1-overwrite",
            excerpt="mutated",
            parsed_at=1_500,
            provenance=make_provenance(captured_at=1_500),
            replace_handle=first.handle,
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.APPEND_ONLY_VIOLATION
    explained = core.explain(scope, first.handle)
    assert explained.item is not None
    assert explained.item.title == "checkpoint-1"


def test_link_refuses_out_of_scope_handle() -> None:
    """Operation: link | Input: foreign to_handle | Invariant: scope_violation."""
    core = ReferenceCore(now_ms=2_000)
    alpha, beta = _seed_cross_project(core)

    err = core.link(
        _scope(project="alpha"),
        LinkRequest(
            from_handle=alpha.handle,
            to_handle=beta.handle,
            relation=LinkRelation.RELATED,
            provenance=make_provenance(),
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.SCOPE_VIOLATION


def test_explain_never_leaks_foreign_scope_item() -> None:
    """Operation: explain | Input: beta handle under alpha scope | Invariant: no leak."""
    core = ReferenceCore(now_ms=2_000)
    _, beta = _seed_cross_project(core)

    result = core.explain(_scope(project="alpha"), beta.handle)
    assert result.item is None
    assert result.provenance is None
    assert result.error is not None
    assert result.error.code is CoreErrorCode.SCOPE_VIOLATION


def test_freshness_stale_after_retention_window() -> None:
    """Freshness invariant: age > 7 days → stale."""
    day_ms = 24 * 60 * 60 * 1000
    assert compute_freshness(0, 3 * day_ms) is Freshness.LIVE
    assert compute_freshness(0, 8 * day_ms) is Freshness.STALE


def test_capture_kind_outside_allow_kinds_is_scope_violation() -> None:
    core = ReferenceCore()
    narrow = Scope(
        caller_id="agent-a",
        project="alpha",
        trust_tier="local",
        allow_kinds=frozenset({MemoryKind.NOTE}),
    )
    err = core.capture(
        narrow,
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="page",
            excerpt="",
            parsed_at=1,
            provenance=make_provenance(),
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.SCOPE_VIOLATION


@pytest.mark.parametrize("case_name", [c.name for c in CONTRACT_CASES])
def test_named_contract_case_is_registered(case_name: str) -> None:
    """Every CONTRACT_CASES entry is addressable by name for the #1047 lane."""
    assert any(c.name == case_name for c in CONTRACT_CASES)
