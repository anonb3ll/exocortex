"""#1048 consumer proof: Citetrail's real store behind the governed Core.

Skips (not fails) when the ``citetrail-consumer`` dependency group is absent —
same opt-in convention as the B* browser layer. Run the real proof with:

    uv run --group citetrail-consumer pytest tests/test_sdk_citetrail_consumer.py -q
"""

from __future__ import annotations

import pytest

pytest.importorskip(
    "citetrail",
    reason="install the citetrail-consumer dependency group to run the consumer proof",
)

from citetrail.capture import CaptureRequest as CitetrailCaptureRequest
from citetrail.capture import capture as citetrail_capture
from citetrail.store import Store

from citetrail_adapter import CitetrailMemoryStore, iso_to_ms, ms_to_iso
from exocortex_sdk import (
    CaptureRequest,
    CoreError,
    CoreErrorCode,
    InMemoryCore,
    MemoryItem,
    MemoryKind,
    RecallRequest,
    RecallStatus,
    Scope,
    make_provenance,
    memory_item_field_names,
)

# Fixed clock one hour after the seeded capture so freshness is deterministic.
NOW_MS = iso_to_ms("2026-09-19T10:00:00+00:00")
PAGE_URL = "https://docs.example.test/retry-guide"


def _scope(project: str | None = "citetrail", caller: str = "citetrail-cli") -> Scope:
    return Scope(
        caller_id=caller,
        project=project,
        trust_tier="local",
        allow_kinds=frozenset(MemoryKind),
    )


def _seeded(tmp_path):
    """A citetrail store with one real capture, fronted by the governed Core."""
    store = Store.create(tmp_path / "store")
    citetrail_capture(
        store,
        CitetrailCaptureRequest(
            url=PAGE_URL,
            title="Retry guide",
            text="Use exponential retry backoff for transient failures.",
            captured_at="2026-09-19T09:00:00Z",
        ),
    )
    adapter = CitetrailMemoryStore(store, origin_machine="test-machine")
    core = InMemoryCore(store=adapter, now_ms=NOW_MS)
    return store, adapter, core


def test_capture_recall_explain_round_trip_with_provenance(tmp_path) -> None:
    store, adapter, core = _seeded(tmp_path)
    scope = _scope()

    result = core.recall(scope, RecallRequest(query="retry backoff"))
    assert result.status is RecallStatus.OK
    assert len(result.items) == 1
    item = result.items[0]
    assert item.handle == "cite_1"
    assert item.kind is MemoryKind.PAGE_DWELL
    assert "url" not in memory_item_field_names()
    assert not hasattr(item, "url")

    explained = core.explain(scope, item.handle)
    assert explained.error is None
    assert explained.freshness.value == "live"
    assert explained.provenance is not None
    assert explained.provenance.origin_surface == "browser"
    assert explained.provenance.origin_machine == "test-machine"
    assert explained.provenance.consent_basis == "standing_local_capture"

    # The bounded reference resolves only at the consumer edge.
    reference = adapter.reference_for(item.handle)
    assert reference is not None
    assert reference.url == PAGE_URL
    assert reference.title == "Retry guide"
    assert reference.position == {"start": 0, "end": 53}


def test_citetrail_privacy_blocked_capture_never_reaches_core(tmp_path) -> None:
    store = Store.create(tmp_path / "store")
    store.block_host("bank.example.test")
    policy = store.privacy_policy()

    result = citetrail_capture(
        store,
        CitetrailCaptureRequest(
            url="https://bank.example.test/accounts",
            title="Accounts",
            text="Balances",
            captured_at="2026-09-19T09:10:00Z",
        ),
        policy,
    )
    assert result.status == "privacy-blocked"

    adapter = CitetrailMemoryStore(store, origin_machine="test-machine")
    core = InMemoryCore(store=adapter, now_ms=NOW_MS)
    recall = core.recall(_scope(), RecallRequest(query="balances"))
    assert recall.status is RecallStatus.EMPTY
    assert recall.items == ()


def test_sdk_capture_appends_a_real_citetrail_row(tmp_path) -> None:
    store, adapter, core = _seeded(tmp_path)
    note = core.capture(
        _scope(),
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="Agent note",
            excerpt="The retry guide resolved the backoff question.",
            parsed_at=NOW_MS,
            provenance=make_provenance(
                captured_at=NOW_MS,
                consent_basis="explicit_user_action",
                origin_surface="desktop",
                origin_machine="test-machine",
            ),
        ),
    )
    assert isinstance(note, MemoryItem)
    assert note.handle == "mem_1"

    # Citetrail's own search sees the SDK write — the row is real.
    hits = store.search("backoff question")
    assert len(hits) == 1
    assert hits[0].reference.url == "urn:exocortex-sdk:mem_1"

    # And the SDK can explain its own handle back.
    explained = core.explain(_scope(), note.handle)
    assert explained.item == note
    reference = adapter.reference_for(note.handle)
    assert reference is not None
    assert reference.url.startswith("urn:exocortex-sdk:")


def test_scope_isolation_over_citetrail_store(tmp_path) -> None:
    _, _, core = _seeded(tmp_path)
    foreign = _scope(project="runroom", caller="other-agent")

    recall = core.recall(foreign, RecallRequest(query="retry"))
    assert recall.items == ()

    explained = core.explain(foreign, "cite_1")
    assert explained.item is None
    assert explained.error is not None
    assert explained.error.code is CoreErrorCode.SCOPE_VIOLATION


def test_privacy_blocked_query_over_citetrail_content(tmp_path) -> None:
    _, _, core = _seeded(tmp_path)
    result = core.recall(_scope(), RecallRequest(query="password reset"))
    assert result.status is RecallStatus.PRIVACY_BLOCKED
    assert result.items == ()


def test_explain_unknown_handle_reports_offline(tmp_path) -> None:
    _, _, core = _seeded(tmp_path)
    explained = core.explain(_scope(), "cite_999")
    assert explained.item is None
    assert explained.error is not None
    assert explained.error.code is CoreErrorCode.NOT_FOUND
    assert explained.freshness.value == "offline"


def test_adapter_append_refuses_divergent_handle_reuse(tmp_path) -> None:
    _, adapter, core = _seeded(tmp_path)
    scope = _scope()
    first = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="n1",
            excerpt="first",
            parsed_at=NOW_MS,
            provenance=make_provenance(origin_machine="test-machine"),
        ),
    )
    assert isinstance(first, MemoryItem)
    divergent = adapter.append(
        MemoryItem(
            handle=first.handle,
            kind=MemoryKind.NOTE,
            scope_project=first.scope_project,
            title="n1",
            excerpt="different content",
            parsed_at=NOW_MS,
            provenance=first.provenance,
        )
    )
    assert isinstance(divergent, CoreError)
    assert divergent.code is CoreErrorCode.CONFLICT


def test_timestamp_mapping_round_trip() -> None:
    assert ms_to_iso(iso_to_ms("2026-09-19T09:00:00+00:00")) == "2026-09-19T09:00:00Z"
