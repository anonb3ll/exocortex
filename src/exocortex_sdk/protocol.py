"""Exocortex Core operation protocol (task #1046).

Shape A (selected): one deep Protocol with capture/recall/link/record/explain.
See docs/exocortex-sdk-core-contract.md for the Shape A vs Shape B comparison.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from exocortex_sdk.types import (
    CaptureRequest,
    CoreError,
    ExplainResult,
    LinkRequest,
    MemoryItem,
    RecallRequest,
    RecallResult,
    RecordRequest,
    Scope,
)


@runtime_checkable
class ExocortexCore(Protocol):
    """Governed context interface over existing stores.

    Implementations (#1047) must enforce Scope isolation, append-only writes,
    consent on capture, and privacy-blocked query/result handling.
    """

    def capture(self, scope: Scope, request: CaptureRequest) -> MemoryItem | CoreError:
        """Append a new memory item. Never overwrites an existing handle."""
        ...

    def recall(self, scope: Scope, request: RecallRequest) -> RecallResult:
        """Search within Scope. Never returns out-of-scope items."""
        ...

    def link(self, scope: Scope, request: LinkRequest) -> MemoryItem | CoreError:
        """Create a link item between two in-scope handles."""
        ...

    def record(self, scope: Scope, request: RecordRequest) -> MemoryItem | CoreError:
        """Append a structured record. Overwrite attempts are refused."""
        ...

    def explain(self, scope: Scope, handle: str) -> ExplainResult:
        """Return provenance + evidence for an in-scope handle."""
        ...
