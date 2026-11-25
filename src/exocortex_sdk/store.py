"""Append-only memory store seam used by the minimal Core (task #1047).

This is an in-process boundary, not a new persistent database. Production
adapters (hub memory/vault/gbrain) project into the same MemoryItem shape via
``exocortex_sdk.adapters``.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol, runtime_checkable

from exocortex_sdk.types import CoreError, CoreErrorCode, MemoryItem


@runtime_checkable
class MemoryStore(Protocol):
    """Minimal append-only store behind ExocortexCore."""

    def get(self, handle: str) -> MemoryItem | None:
        """Return the item for ``handle``, or None if absent."""
        ...

    def append(self, item: MemoryItem) -> MemoryItem | CoreError:
        """Insert ``item``. Refuse handle collisions with divergent content."""
        ...

    def iter_items(self) -> Iterable[MemoryItem]:
        """Iterate all stored items (unordered)."""
        ...


class InMemoryStore:
    """Process-local append-only store. No disk, no second-brain DB."""

    def __init__(self) -> None:
        self._items: dict[str, MemoryItem] = {}

    def get(self, handle: str) -> MemoryItem | None:
        return self._items.get(handle)

    def append(self, item: MemoryItem) -> MemoryItem | CoreError:
        existing = self._items.get(item.handle)
        if existing is not None:
            if existing == item:
                return existing
            return CoreError(
                code=CoreErrorCode.CONFLICT,
                message="append refused: handle already bound to divergent content",
            )
        self._items[item.handle] = item
        return item

    def iter_items(self) -> Iterable[MemoryItem]:
        return tuple(self._items.values())

    def __len__(self) -> int:
        return len(self._items)
