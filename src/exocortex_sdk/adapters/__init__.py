"""Existing-store adapter seam for unified-agent memory / vault / gbrain.

This package is the #1047 production seam only: Protocols + a thin localhost
HTTP/MCP-backed adapter behind a feature flag. It does not create a new
persistent database and does not wire broad connectors.
"""

from __future__ import annotations

from exocortex_sdk.adapters.existing_store import (
    ExistingStorePort,
    StoreDraft,
    StoreRecord,
    WritePolicy,
    project_store_record,
)
from exocortex_sdk.adapters.factory import (
    HUB_STORE_FEATURE_FLAG,
    build_core,
    hub_store_enabled,
)
from exocortex_sdk.adapters.hub import HubExistingStoreAdapter, HubTransport

__all__ = [
    "HUB_STORE_FEATURE_FLAG",
    "ExistingStorePort",
    "HubExistingStoreAdapter",
    "HubTransport",
    "StoreDraft",
    "StoreRecord",
    "WritePolicy",
    "build_core",
    "hub_store_enabled",
    "project_store_record",
]
