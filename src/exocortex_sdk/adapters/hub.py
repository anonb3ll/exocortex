"""Thin localhost HTTP/MCP-backed adapter for existing UA stores.

Enabled only when ``EXOCORTEX_SDK_HUB_STORE=1``. The base URL must be loopback;
private hub endpoints are never exposed as a public surface from this seam.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlparse

from exocortex_sdk.adapters.existing_store import (
    StoreDraft,
    StoreRecord,
    WritePolicy,
)
from exocortex_sdk.types import CoreError, CoreErrorCode, MemoryKind

HUB_STORE_FEATURE_FLAG = "EXOCORTEX_SDK_HUB_STORE"
_DEFAULT_HUB_BASE = "http://127.0.0.1:8765"


@runtime_checkable
class HubTransport(Protocol):
    """Injectable transport so tests never need a live hub."""

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]: ...


def hub_store_enabled(env: dict[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    return source.get(HUB_STORE_FEATURE_FLAG, "").strip() == "1"


def require_loopback_base_url(base_url: str) -> str:
    """Refuse non-loopback bases so the seam cannot publish hub endpoints."""
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(
            f"hub adapter base_url must be loopback (got host={host!r}); "
            "refusing to target a non-local endpoint"
        )
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"hub adapter base_url scheme must be http(s), got {parsed.scheme!r}")
    return base_url.rstrip("/")


class UrllibHubTransport:
    """stdlib HTTP transport aimed at the local unified-agent hub."""

    def __init__(self, base_url: str, *, timeout_s: float = 2.0) -> None:
        self._base_url = require_loopback_base_url(base_url)
        self._timeout_s = timeout_s

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method=method.upper(),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.URLError as exc:
            raise ConnectionError(f"hub transport failed: {exc}") from exc
        if not raw.strip():
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("hub response must be a JSON object")
        return parsed


class HubExistingStoreAdapter:
    """Minimal memory/vault/gbrain projection over the local hub HTTP surface.

    Paths are intentionally narrow placeholders for the existing-store seam.
    No broad connector matrix — callers inject ``HubTransport`` in tests.
    """

    def __init__(
        self,
        *,
        base_url: str = _DEFAULT_HUB_BASE,
        transport: HubTransport | None = None,
        source: str = "hub",
    ) -> None:
        self._base_url = require_loopback_base_url(base_url)
        self._transport: HubTransport = (
            transport if transport is not None else UrllibHubTransport(self._base_url)
        )
        self._source_name = source

    @property
    def source_name(self) -> str:
        return self._source_name

    def fetch(self, external_id: str) -> StoreRecord | None:
        try:
            payload = self._transport.request_json(
                "GET",
                "/mcp/memory/get",
                params={"id": external_id},
            )
        except (ConnectionError, ValueError, KeyError):
            return None
        return _record_from_payload(payload, default_source="memory")

    def search(self, query: str, *, limit: int = 10) -> tuple[StoreRecord, ...]:
        try:
            payload = self._transport.request_json(
                "POST",
                "/mcp/memory/search",
                body={"query": query, "limit": limit},
            )
        except (ConnectionError, ValueError):
            return ()
        hits = payload.get("results") or payload.get("items") or []
        if not isinstance(hits, list):
            return ()
        out: list[StoreRecord] = []
        for hit in hits[: max(1, limit)]:
            if not isinstance(hit, dict):
                continue
            record = _record_from_payload(hit, default_source="memory")
            if record is not None:
                out.append(record)
        return tuple(out)

    def append(
        self,
        draft: StoreDraft,
        *,
        write_policy: WritePolicy = WritePolicy.REFUSE,
    ) -> StoreRecord | CoreError:
        if write_policy is not WritePolicy.ALLOW:
            return CoreError(
                code=CoreErrorCode.CONSENT_REQUIRED,
                message="hub append refused: WritePolicy.ALLOW required (no autonomous writes)",
            )
        path = {
            "memory": "/mcp/memory/save",
            "vault": "/mcp/vault/write",
            "gbrain": "/mcp/gbrain/put_page",
        }.get(draft.source)
        if path is None:
            return CoreError(
                code=CoreErrorCode.INVALID_INPUT,
                message=f"unknown existing-store source: {draft.source!r}",
            )
        try:
            payload = self._transport.request_json(
                "POST",
                path,
                body={
                    "title": draft.title,
                    "excerpt": draft.excerpt,
                    "project": draft.project,
                    "kind": draft.kind.value,
                    "tags": list(draft.tags),
                    "captured_at": draft.captured_at,
                    "source": draft.source,
                },
            )
        except (ConnectionError, ValueError) as exc:
            return CoreError(
                code=CoreErrorCode.INVALID_INPUT,
                message=f"hub append failed: {exc}",
            )
        record = _record_from_payload(payload, default_source=draft.source)
        if record is None:
            return CoreError(
                code=CoreErrorCode.INVALID_INPUT,
                message="hub append returned no usable record",
            )
        return record


def _record_from_payload(
    payload: dict[str, Any],
    *,
    default_source: str,
) -> StoreRecord | None:
    external_id = str(
        payload.get("id")
        or payload.get("external_id")
        or payload.get("handle")
        or payload.get("slug")
        or ""
    ).strip()
    if not external_id:
        return None
    title = str(payload.get("title") or payload.get("snippet") or "").strip()
    excerpt = str(
        payload.get("excerpt") or payload.get("content") or payload.get("snippet") or ""
    ).strip()
    # Hard redaction: never carry URL-shaped keys into StoreRecord.
    source_raw = str(payload.get("source") or default_source).strip().lower()
    source = source_raw if source_raw in {"memory", "vault", "gbrain"} else default_source
    if source not in {"memory", "vault", "gbrain"}:
        source = "memory"
    kind_raw = str(payload.get("kind") or MemoryKind.NOTE.value)
    try:
        kind = MemoryKind(kind_raw)
    except ValueError:
        kind = MemoryKind.NOTE
    captured_at = int(payload.get("captured_at") or payload.get("updated_at_ms") or 0)
    project = payload.get("project")
    tags_raw = payload.get("tags") or ()
    tags = tuple(str(t) for t in tags_raw) if isinstance(tags_raw, (list, tuple)) else ()
    return StoreRecord(
        external_id=external_id,
        source=source,  # type: ignore[arg-type]
        title=title,
        excerpt=excerpt,
        captured_at=captured_at,
        project=str(project) if project is not None else None,
        kind=kind,
        tags=tags,
    )
