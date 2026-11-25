"""Factory for the minimal Core + optional hub existing-store seam."""

from __future__ import annotations

import os

from exocortex_sdk.adapters.existing_store import ExistingStorePort, WritePolicy
from exocortex_sdk.adapters.hub import (
    HUB_STORE_FEATURE_FLAG,
    HubExistingStoreAdapter,
    hub_store_enabled,
)
from exocortex_sdk.core import InMemoryCore
from exocortex_sdk.store import InMemoryStore, MemoryStore


def build_core(
    *,
    now_ms: int = 0,
    store: MemoryStore | None = None,
    hub: bool | None = None,
    hub_adapter: ExistingStorePort | None = None,
    write_policy: WritePolicy = WritePolicy.REFUSE,
    env: dict[str, str] | None = None,
) -> InMemoryCore:
    """Build the governed in-memory Core.

    When the hub feature flag is on (or ``hub=True``), a
    ``HubExistingStoreAdapter`` is constructed for the caller to use via
    ``core.hub_store`` — the Core itself stays in-memory (no new DB). Hub
    writes remain refuse-closed unless ``write_policy=WritePolicy.ALLOW``.

    ``write_policy`` is intentionally unused here: the factory never auto-writes
    to the hub. Callers must pass ``WritePolicy.ALLOW`` to ``hub_store.append``.
    """
    _ = write_policy
    memory = store if store is not None else InMemoryStore()
    core = InMemoryCore(store=memory, now_ms=now_ms)
    enabled = hub if hub is not None else hub_store_enabled(env)
    if enabled:
        core.hub_store = hub_adapter if hub_adapter is not None else HubExistingStoreAdapter()
    else:
        core.hub_store = None
    return core


def describe_seam(env: dict[str, str] | None = None) -> dict[str, str | bool]:
    """Operator-visible seam status (no secrets, no remote endpoints)."""
    source = env if env is not None else dict(os.environ)
    return {
        "feature_flag": HUB_STORE_FEATURE_FLAG,
        "hub_store_enabled": hub_store_enabled(source),
        "default_write_policy": WritePolicy.REFUSE.value,
        "store_backend": "in_memory",
    }


__all__ = [
    "HUB_STORE_FEATURE_FLAG",
    "build_core",
    "describe_seam",
    "hub_store_enabled",
]
