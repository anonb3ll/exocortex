"""Runnable proof: Citetrail capture -> governed recall -> explain (task #1048).

Runs the whole round trip against a throwaway Citetrail store in a temp dir:

1. ``citetrail.capture.capture`` writes real rows through Citetrail's own
   privacy-gated code path (one allowed page, one blocklisted page).
2. ``InMemoryCore`` sits over the same sqlite file via ``CitetrailMemoryStore``
   and serves governed ``recall`` / ``explain``.
3. ``reference_for`` resolves the winning handle back to Citetrail's bounded
   reference (url + position) at the consumer edge.
4. A ``core.capture`` of an SDK-native NOTE lands as a real Citetrail row and
   is visible to Citetrail's own ``search``.
5. Governance contrast: foreign-scope explain and a blocklisted query.

Run from the repo root:

    uv run --group citetrail-consumer python examples/citetrail_consumer/demo.py
"""

from __future__ import annotations

import socket
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from citetrail.capture import CaptureRequest as CitetrailCaptureRequest
from citetrail.capture import capture as citetrail_capture
from citetrail.store import Store

from citetrail_adapter import CitetrailMemoryStore
from exocortex_sdk import (
    CaptureRequest,
    InMemoryCore,
    MemoryItem,
    MemoryKind,
    RecallRequest,
    Scope,
    make_provenance,
)


def _banner(text: str) -> None:
    print(f"\n=== {text} ===")


def _show_item(item: MemoryItem) -> None:
    print(f"  handle   : {item.handle}")
    print(f"  kind     : {item.kind.value}")
    print(f"  title    : {item.title}")
    print(f"  excerpt  : {item.excerpt[:80]}")
    print(f"  has url field on wire item: {hasattr(item, 'url')}")


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="citetrail-sdk-demo-"))
    machine = socket.gethostname()
    now_ms = int(time.time() * 1000)
    print(f"citetrail store: {workdir} (throwaway)")
    print(f"origin machine : {machine}")

    _banner("1. Citetrail's own capture path (URL + privacy policy stay inside Citetrail)")
    store = Store.create(workdir)
    store.block_host("bank.example.test")
    policy = store.privacy_policy()

    pages = [
        CitetrailCaptureRequest(
            url="https://docs.example.test/retry-guide",
            title="Retry guide",
            text="Use exponential retry backoff for transient failures.",
            captured_at="2026-09-19T09:00:00Z",
        ),
        CitetrailCaptureRequest(
            url="https://blog.example.test/agent-memory",
            title="Agent memory notes",
            text="A governed memory layer needs provenance on every recall hit.",
            captured_at="2026-09-19T09:05:00Z",
        ),
        CitetrailCaptureRequest(
            url="https://bank.example.test/accounts",
            title="Accounts",
            text="Account balances and statements.",
            captured_at="2026-09-19T09:10:00Z",
        ),
    ]
    for page in pages:
        result = citetrail_capture(store, page, policy)
        print(f"  citetrail.capture({page.url}) -> {result.status}")

    _banner("2. Governed Core over the same sqlite store (CitetrailMemoryStore adapter)")
    adapter = CitetrailMemoryStore(store, origin_machine=machine)
    core = InMemoryCore(store=adapter, now_ms=now_ms)
    scope = Scope(
        caller_id="citetrail-cli",
        project="citetrail",
        trust_tier="local",
        allow_kinds=frozenset(MemoryKind),
    )
    print(
        f"  adapter sees {len(tuple(adapter.iter_items()))} citetrail rows "
        "(the bank page was never stored)"
    )

    _banner("3. recall: governed search over Citetrail content")
    result = core.recall(scope, RecallRequest(query="retry backoff"))
    print(
        f"  core.recall('retry backoff') -> status={result.status.value}, "
        f"freshness={result.freshness.value}"
    )
    for item, evidence in zip(result.items, result.evidence, strict=True):
        _show_item(item)
        print(
            f"  evidence : kind={evidence.kind.value} "
            f"source_ref={evidence.source_ref} match_kind={evidence.match_kind}"
        )
    hit = result.items[0]

    _banner("4. explain: provenance for the winning handle")
    explained = core.explain(scope, hit.handle)
    assert explained.provenance is not None
    print(f"  core.explain({hit.handle}) -> freshness={explained.freshness.value}")
    prov = explained.provenance
    print(f"  provenance: surface={prov.origin_surface} machine={prov.origin_machine}")
    print(f"              consent_basis={prov.consent_basis} trust_tier={prov.trust_tier}")
    ref = adapter.reference_for(hit.handle)
    assert ref is not None
    print("  consumer-edge citation (reference_for, URL never left the SDK):")
    print(f"    url={ref.url}")
    print(f"    captured_at={ref.captured_at} position={ref.position}")

    _banner("5. SDK-native write lands in Citetrail's real store")
    note = core.capture(
        scope,
        CaptureRequest(
            kind=MemoryKind.NOTE,
            title="Agent note",
            excerpt="The retry guide resolved the backoff question.",
            parsed_at=now_ms,
            provenance=make_provenance(
                captured_at=now_ms,
                consent_basis="explicit_user_action",
                origin_surface="desktop",
                origin_machine=machine,
            ),
        ),
    )
    assert isinstance(note, MemoryItem)
    print(f"  core.capture(NOTE) -> handle={note.handle}")
    citetrail_hits = store.search("backoff question")
    print(f"  citetrail store.search('backoff question') -> {len(citetrail_hits)} match(es)")
    for match in citetrail_hits:
        print(f"    citetrail sees: url={match.reference.url} title={match.reference.title}")

    _banner("6. Governance contrast (what Citetrail alone does not enforce)")
    foreign = Scope(
        caller_id="other-agent",
        project="runroom",
        trust_tier="local",
        allow_kinds=frozenset(MemoryKind),
    )
    denied = core.explain(foreign, hit.handle)
    assert denied.error is not None
    print(f"  explain(cite_1) as foreign project 'runroom' -> {denied.error.code.value}")
    blocked = core.recall(scope, RecallRequest(query="account password"))
    print(
        f"  recall('account password') -> status={blocked.status.value}, items={len(blocked.items)}"
    )
    foreign_recall = core.recall(foreign, RecallRequest(query="retry"))
    print(
        f"  recall('retry') as project 'runroom' -> status={foreign_recall.status.value}, "
        f"items={len(foreign_recall.items)}"
    )

    _banner("round trip complete")
    print("  capture(citetrail) -> store(sqlite) -> adapter -> recall -> explain -> citation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
