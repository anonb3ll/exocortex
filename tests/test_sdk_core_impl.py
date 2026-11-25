"""Focused #1047 tests: provenance, scope, stale/conflict, append, hub seam."""

from __future__ import annotations

from typing import Any

import pytest

from exocortex_sdk import (
    HUB_STORE_FEATURE_FLAG,
    CaptureRequest,
    CoreError,
    CoreErrorCode,
    ExocortexCore,
    Freshness,
    HubExistingStoreAdapter,
    InMemoryCore,
    InMemoryStore,
    MemoryItem,
    MemoryKind,
    RecallRequest,
    RecallStatus,
    RecordRequest,
    Scope,
    StoreDraft,
    StoreRecord,
    WritePolicy,
    build_core,
    hub_store_enabled,
    item_in_scope,
    make_provenance,
    project_store_record,
)
from exocortex_sdk.adapters.hub import require_loopback_base_url


def _all_kinds() -> frozenset[MemoryKind]:
    return frozenset(MemoryKind)


def _scope(*, project: str | None = "alpha", caller: str = "agent-a") -> Scope:
    return Scope(
        caller_id=caller,
        project=project,
        trust_tier="local",
        allow_kinds=_all_kinds(),
    )


def test_in_memory_core_satisfies_protocol() -> None:
    assert isinstance(InMemoryCore(), ExocortexCore)


def test_provenance_round_trips_through_capture_and_explain() -> None:
    core = InMemoryCore(now_ms=2_000)
    scope = _scope()
    prov = make_provenance(
        captured_at=1_500,
        recorded_at=1_600,
        origin_machine="laptop",
        origin_surface="desktop",
        consent_basis="explicit_user_action",
        trust_tier="local",
    )
    item = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="provenance probe",
            excerpt="evidence chain",
            parsed_at=1_500,
            provenance=prov,
            scope_project="alpha",
        ),
    )
    assert isinstance(item, MemoryItem)
    explained = core.explain(scope, item.handle)
    assert explained.item is not None
    assert explained.provenance is not None
    assert explained.provenance == prov
    assert explained.evidence
    assert explained.evidence[0].source_ref == item.handle
    assert "url" not in item.__dataclass_fields__


def test_scope_isolation_on_recall_and_explain() -> None:
    core = InMemoryCore(now_ms=2_000)
    prov = make_provenance()
    alpha = core.capture(
        _scope(project="alpha"),
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="alpha notes",
            excerpt="sdk core",
            parsed_at=1_000,
            provenance=prov,
            scope_project="alpha",
        ),
    )
    beta = core.capture(
        _scope(project="beta"),
        CaptureRequest(
            kind=MemoryKind.PAGE_DWELL,
            title="beta notes",
            excerpt="sdk core",
            parsed_at=1_000,
            provenance=prov,
            scope_project="beta",
        ),
    )
    assert isinstance(alpha, MemoryItem)
    assert isinstance(beta, MemoryItem)

    recalled = core.recall(_scope(project="alpha"), RecallRequest(query="sdk"))
    assert recalled.status is RecallStatus.OK
    assert all(item_in_scope(item, _scope(project="alpha")) for item in recalled.items)
    assert all(item.scope_project == "alpha" for item in recalled.items)

    leaked = core.explain(_scope(project="alpha"), beta.handle)
    assert leaked.item is None
    assert leaked.provenance is None
    assert leaked.error is not None
    assert leaked.error.code is CoreErrorCode.SCOPE_VIOLATION


def test_stale_visibility_on_recall_and_explain() -> None:
    day_ms = 24 * 60 * 60 * 1000
    core = InMemoryCore(now_ms=8 * day_ms)
    scope = _scope()
    item = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="old note",
            excerpt="aged content",
            parsed_at=0,
            provenance=make_provenance(captured_at=0),
        ),
    )
    assert isinstance(item, MemoryItem)

    recalled = core.recall(scope, RecallRequest(query="aged"))
    assert recalled.status is RecallStatus.OK
    assert recalled.freshness is Freshness.STALE

    explained = core.explain(scope, item.handle)
    assert explained.item is not None
    assert explained.freshness is Freshness.STALE
    assert explained.error is not None
    assert explained.error.code is CoreErrorCode.STALE


def test_conflict_visibility_on_diverging_record() -> None:
    core = InMemoryCore(now_ms=2_000)
    scope = _scope()
    first = core.record(
        scope,
        RecordRequest(
            kind=MemoryKind.CHECKPOINT,
            title="checkpoint-shared",
            excerpt="state-a",
            parsed_at=1_000,
            provenance=make_provenance(),
        ),
    )
    assert isinstance(first, MemoryItem)

    err = core.record(
        scope,
        RecordRequest(
            kind=MemoryKind.CHECKPOINT,
            title="checkpoint-shared",
            excerpt="state-b-diverged",
            parsed_at=1_500,
            provenance=make_provenance(captured_at=1_500),
        ),
    )
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.CONFLICT

    explained = core.explain(scope, first.handle)
    assert explained.item is not None
    assert explained.item.excerpt == "state-a"


def test_safe_append_semantics_never_overwrite() -> None:
    store = InMemoryStore()
    core = InMemoryCore(store=store, now_ms=2_000)
    scope = _scope()
    first = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="same-title",
            excerpt="first",
            parsed_at=1_000,
            provenance=make_provenance(),
        ),
    )
    second = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="same-title",
            excerpt="first",
            parsed_at=1_100,
            provenance=make_provenance(captured_at=1_100),
        ),
    )
    assert isinstance(first, MemoryItem)
    assert isinstance(second, MemoryItem)
    assert first.handle != second.handle
    assert store.get(first.handle) == first
    assert store.get(second.handle) == second

    refused = core.record(
        scope,
        RecordRequest(
            kind=MemoryKind.CHECKPOINT,
            title="x",
            excerpt="y",
            parsed_at=1_200,
            provenance=make_provenance(captured_at=1_200),
            replace_handle=first.handle,
        ),
    )
    assert isinstance(refused, CoreError)
    assert refused.code is CoreErrorCode.APPEND_ONLY_VIOLATION


def test_store_append_handle_collision_is_conflict() -> None:
    store = InMemoryStore()
    prov = make_provenance()
    item = MemoryItem(
        handle="mem_fixed",
        kind=MemoryKind.NOTE,
        scope_project="alpha",
        title="a",
        excerpt="one",
        parsed_at=1,
        provenance=prov,
    )
    assert store.append(item) == item
    divergent = MemoryItem(
        handle="mem_fixed",
        kind=MemoryKind.NOTE,
        scope_project="alpha",
        title="a",
        excerpt="two",
        parsed_at=2,
        provenance=prov,
    )
    err = store.append(divergent)
    assert isinstance(err, CoreError)
    assert err.code is CoreErrorCode.CONFLICT
    assert store.get("mem_fixed") == item


class _FakeHubTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self._records: dict[str, dict[str, Any]] = {
            "m1": {
                "id": "m1",
                "title": "hub note",
                "excerpt": "from memory",
                "source": "memory",
                "captured_at": 100,
                "project": "alpha",
                "url": "https://should.never.leak.example/secret",
            }
        }

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        self.calls.append((method, path, body))
        if method.upper() == "GET" and path == "/mcp/memory/get":
            assert params is not None
            return dict(self._records[params["id"]])
        if method.upper() == "POST" and path == "/mcp/memory/search":
            assert body is not None
            return {"results": [dict(self._records["m1"])]}
        if method.upper() == "POST" and path == "/mcp/memory/save":
            assert body is not None
            new_id = f"m{len(self._records) + 1}"
            record = {
                "id": new_id,
                "title": body["title"],
                "excerpt": body["excerpt"],
                "source": "memory",
                "captured_at": body.get("captured_at", 0),
                "project": body.get("project"),
            }
            self._records[new_id] = record
            return dict(record)
        raise AssertionError(f"unexpected hub call {method} {path}")


def test_hub_adapter_feature_flag_and_write_policy() -> None:
    assert hub_store_enabled({}) is False
    assert hub_store_enabled({HUB_STORE_FEATURE_FLAG: "1"}) is True

    transport = _FakeHubTransport()
    adapter = HubExistingStoreAdapter(transport=transport)
    hit = adapter.fetch("m1")
    assert hit is not None
    assert hit.external_id == "m1"
    assert hit.title == "hub note"
    assert not hasattr(hit, "url")

    refused = adapter.append(
        StoreDraft(title="x", excerpt="y", captured_at=1),
        write_policy=WritePolicy.REFUSE,
    )
    assert isinstance(refused, CoreError)
    assert refused.code is CoreErrorCode.CONSENT_REQUIRED

    saved = adapter.append(
        StoreDraft(title="allowed", excerpt="body", project="alpha", captured_at=2),
        write_policy=WritePolicy.ALLOW,
    )
    assert isinstance(saved, StoreRecord)
    assert saved.title == "allowed"


def test_hub_adapter_rejects_non_loopback_base_url() -> None:
    with pytest.raises(ValueError, match="loopback"):
        require_loopback_base_url("http://example.com:8765")


def test_project_store_record_redacts_to_memory_item() -> None:
    record = StoreRecord(
        external_id="v1",
        source="vault",
        title="vault page",
        excerpt="wikilink body",
        captured_at=50,
        project="alpha",
        kind=MemoryKind.NOTE,
    )
    item = project_store_record(record, provenance=make_provenance(captured_at=50))
    assert item.handle.startswith("ext_vault_")
    assert "url" not in item.__dataclass_fields__
    assert "source:vault" in item.tags


def test_build_core_attaches_hub_store_only_when_flag_on() -> None:
    off = build_core(env={})
    assert off.hub_store is None

    fake = HubExistingStoreAdapter(transport=_FakeHubTransport())
    on = build_core(hub=True, hub_adapter=fake, now_ms=1)
    assert on.hub_store is fake
    assert isinstance(on, InMemoryCore)
