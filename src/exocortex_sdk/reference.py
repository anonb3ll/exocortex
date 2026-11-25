"""In-memory reference Core used as the #1046 contract oracle.

Task #1047 promotes the governed implementation to ``InMemoryCore``. This
module re-exports that implementation under the historical ``ReferenceCore``
name so existing contract tests keep their import path.
"""

from __future__ import annotations

from exocortex_sdk.core import InMemoryCore, make_provenance

# Contract oracle ≡ production in-memory Core (same governance choke point).
ReferenceCore = InMemoryCore

__all__ = ["ReferenceCore", "make_provenance"]
