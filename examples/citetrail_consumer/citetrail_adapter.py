"""Citetrail store behind the Exocortex SDK ``MemoryStore`` seam (task #1048).

This module is the consumer-owned half of the integration proof: it lets an
external product (Citetrail) run the governed ``ExocortexCore`` operations over
its *existing* sqlite store — no schema change, no second database.

Boundary discipline:

- ``MemoryItem`` has no ``url`` field, so URLs never cross into the SDK. The
  adapter resolves an opaque handle back to the Citetrail ``Reference`` (url,
  title, captured_at, position) via :meth:`CitetrailMemoryStore.reference_for`,
  which stays at the consumer edge.
- Citetrail's own ``capture()`` remains the write path for browser pages
  (it carries the URL and the hostname privacy policy). SDK writes through
  ``append`` land as real ``captures`` rows marked with an ``urn:exocortex-sdk:``
  origin so Citetrail's own search/MCP path can see them honestly.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from citetrail.models import Reference
from citetrail.store import Store

from exocortex_sdk import (
    CoreError,
    CoreErrorCode,
    MemoryItem,
    MemoryKind,
    Provenance,
)

CITE_HANDLE_PREFIX = "cite_"
SDK_ORIGIN_URN_PREFIX = "urn:exocortex-sdk:"


def iso_to_ms(value: str) -> int:
    """Citetrail ``captured_at`` (ISO-8601 text) -> epoch ms."""
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def ms_to_iso(value: int) -> str:
    """Epoch ms -> Citetrail ``captured_at`` (ISO-8601 text, UTC)."""
    return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


class CitetrailMemoryStore:
    """``MemoryStore`` implementation over a real Citetrail ``Store``.

    Rows written by Citetrail's own capture path appear as ``cite_<rowid>``
    items (``MemoryKind.PAGE_DWELL``). Rows appended through the SDK keep their
    Core-minted handle (``mem_<n>``) and kind for the life of this adapter
    instance; on a fresh process they re-appear as ``cite_<rowid>`` page items.
    """

    def __init__(
        self,
        store: Store,
        *,
        origin_machine: str,
        project: str | None = "citetrail",
    ) -> None:
        self._store = store
        self._origin_machine = origin_machine
        self._project = project
        self._sdk_rows: dict[int, MemoryItem] = {}
        self._sdk_handles: dict[str, int] = {}

    # -- MemoryStore protocol -------------------------------------------------

    def get(self, handle: str) -> MemoryItem | None:
        rowid = self._rowid_for(handle)
        if rowid is None:
            return None
        if rowid in self._sdk_rows:
            return self._sdk_rows[rowid]
        row = self._fetch_row(rowid)
        return self._project_row(row) if row is not None else None

    def append(self, item: MemoryItem) -> MemoryItem | CoreError:
        existing = self.get(item.handle)
        if existing is not None:
            if existing == item:
                return existing
            return CoreError(
                code=CoreErrorCode.CONFLICT,
                message="append refused: handle already bound to divergent content",
            )
        with self._store.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO captures (
                    url, title, captured_at, text, position_start, position_end
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    f"{SDK_ORIGIN_URN_PREFIX}{item.handle}",
                    item.title,
                    ms_to_iso(item.parsed_at),
                    item.excerpt,
                    0,
                    len(item.excerpt),
                ),
            )
            rowid = cursor.lastrowid
        assert rowid is not None
        self._sdk_rows[rowid] = item
        self._sdk_handles[item.handle] = rowid
        return item

    def iter_items(self) -> Iterable[MemoryItem]:
        with self._store.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, url, title, captured_at, text, position_start, position_end
                FROM captures
                ORDER BY id
                """
            ).fetchall()
        return tuple(self._sdk_rows.get(row[0]) or self._project_row(row) for row in rows)

    # -- Consumer-edge provenance resolution ----------------------------------

    def reference_for(self, handle: str) -> Reference | None:
        """Resolve a Core handle back to the Citetrail bounded reference.

        This is the only place the URL resurfaces — deliberately outside the
        SDK wire types, matching Citetrail's own recall contract.
        """
        rowid = self._rowid_for(handle)
        if rowid is None:
            return None
        row = self._fetch_row(rowid)
        if row is None:
            return None
        return Reference(
            url=row[1],
            title=row[2],
            captured_at=row[3],
            position={"start": row[5], "end": row[6]},
        )

    # -- internals ------------------------------------------------------------

    def _rowid_for(self, handle: str) -> int | None:
        if handle in self._sdk_handles:
            return self._sdk_handles[handle]
        if handle.startswith(CITE_HANDLE_PREFIX):
            try:
                return int(handle[len(CITE_HANDLE_PREFIX) :])
            except ValueError:
                return None
        return None

    def _fetch_row(self, rowid: int) -> tuple | None:
        with self._store.connect() as connection:
            return connection.execute(
                """
                SELECT id, url, title, captured_at, text, position_start, position_end
                FROM captures WHERE id = ?
                """,
                (rowid,),
            ).fetchone()

    def _project_row(self, row: tuple) -> MemoryItem:
        captured_ms = iso_to_ms(row[3])
        return MemoryItem(
            handle=f"{CITE_HANDLE_PREFIX}{row[0]}",
            kind=MemoryKind.PAGE_DWELL,
            scope_project=self._project,
            title=row[2],
            excerpt=row[4],
            parsed_at=captured_ms,
            provenance=Provenance(
                origin_machine=self._origin_machine,
                origin_surface="browser",
                captured_at=captured_ms,
                recorded_at=captured_ms,
                consent_basis="standing_local_capture",
                trust_tier="local",
            ),
            tags=("source:citetrail", f"row:{row[0]}"),
        )
