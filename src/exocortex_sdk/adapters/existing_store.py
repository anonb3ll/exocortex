"""Narrow port onto existing unified-agent stores (memory / vault / gbrain)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable

from exocortex_sdk.types import (
    CoreError,
    MemoryItem,
    MemoryKind,
    Provenance,
)

ExistingStoreSource = Literal["memory", "vault", "gbrain"]


class WritePolicy(StrEnum):
    """Explicit write gate — autonomous hub writes are refuse-closed by default."""

    REFUSE = "refuse"
    ALLOW = "allow"


@dataclass(frozen=True, slots=True)
class StoreRecord:
    """Redacted record projected from an existing store.

    No URL / page body fields — matches the Core MemoryItem wire boundary.
    """

    external_id: str
    source: ExistingStoreSource
    title: str
    excerpt: str
    captured_at: int
    project: str | None = None
    kind: MemoryKind = MemoryKind.NOTE
    tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class StoreDraft:
    """Append draft for an existing store. Writes require WritePolicy.ALLOW."""

    title: str
    excerpt: str
    source: ExistingStoreSource = "memory"
    project: str | None = None
    kind: MemoryKind = MemoryKind.NOTE
    tags: tuple[str, ...] = ()
    captured_at: int = 0


@runtime_checkable
class ExistingStorePort(Protocol):
    """Seam for reading/appending through existing UA stores — not a new DB."""

    @property
    def source_name(self) -> str:
        """Adapter identity (e.g. ``memory``, ``vault``, ``gbrain``, ``hub``)."""
        ...

    def fetch(self, external_id: str) -> StoreRecord | None:
        """Fetch one redacted record by opaque external id."""
        ...

    def search(self, query: str, *, limit: int = 10) -> tuple[StoreRecord, ...]:
        """Search within the existing store; returns redacted hits only."""
        ...

    def append(
        self,
        draft: StoreDraft,
        *,
        write_policy: WritePolicy = WritePolicy.REFUSE,
    ) -> StoreRecord | CoreError:
        """Append only when ``write_policy`` is ALLOW; otherwise refuse."""
        ...


def project_store_record(
    record: StoreRecord,
    *,
    provenance: Provenance,
    handle: str | None = None,
) -> MemoryItem:
    """Project an existing-store hit into a Core MemoryItem (no URL fields)."""
    return MemoryItem(
        handle=handle if handle is not None else f"ext_{record.source}_{record.external_id}",
        kind=record.kind,
        scope_project=record.project,
        title=record.title,
        excerpt=record.excerpt,
        parsed_at=record.captured_at,
        provenance=provenance,
        tags=record.tags + (f"source:{record.source}", f"ext:{record.external_id}"),
    )
