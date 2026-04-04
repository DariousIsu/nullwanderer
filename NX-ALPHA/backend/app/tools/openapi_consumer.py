"""
OpenAPI Consumer — execute any OpenAPI 3.x REST endpoint as a tool.

Feed it a spec URL (or inline JSON string) + an operationId, and it
builds + fires the HTTP request automatically.  Parsed specs are cached
in-process by URL so repeated calls to the same API are fast.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── Spec cache ────────────────────────────────────────────────────────────────
_spec_cache: dict[str, dict] = {}


async def _fetch_spec(source: str, refresh: bool = False) -> dict:
    """
    Fetch and return an OpenAPI spec dict.
    source: URL (http/https) or inline JSON string.
    refresh: if True, bypass cache and re-fetch.
    """
    if source.startswith("http://") or source.startswith("https://"):
        if not refresh and source in _spec_cache:
            return _spec_cache[source]
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(source)
            resp.raise_for_status()
            # Support both JSON and YAML (try JSON first)
            try:
                spec = resp.json()
            except Exception:
                try:
                    import yaml  # type: ignore
                    spec = yaml.safe_load(resp.text)
                except ImportError:
                    raise ValueError("Spec is YAML but PyYAML is not installed. Install it with: pip install pyyaml")
        _spec_cache[source] = spec
        return spec
    else:
        # Treat as inline JSON
        return json.loads(source)


def _find_operation(spec: dict, operation_id: str) -> tuple[str, str, dict]:
    """
    Locate operationId in the spec paths.
    Returns (path_template, http_method, operation_object).
    Raises ValueError if not found.
    """
    version = spec.get("openapi", spec.get("swagger", ""))
    if not str(version).startswith("3"):
        raise ValueError(
            f"Only OpenAPI 3.x is supported (found: {version!r}). "
            "Convert Swagger 2.x specs with editor.swagger.io first."
        )

    paths = spec.get("paths", {})
    for path_template, path_item in paths.items():
        for method in ("get", "post", "put", "patch", "delete", "head", "options"):
            operation = path_item.get(method)
            if isinstance(operation, dict) and operation.get("operationId") == operation_id:
                return path_template, method, operation

    available = [
        op.get("operationId")
        for path_item in paths.values()
        for method in ("get", "post", "put", "patch", "delete")
        for op in [path_item.get(method, {})]
        if isinstance(op, dict) and op.get("operationId")
    ]
    raise ValueError(
        f"operationId {operation_id!r} not found in spec. "
        f"Available: {available[:20]}"
    )


def _build_request(
    spec: dict,
    path_template: str,
    method: str,
    operation: dict,
    params: dict,
    base_url: str | None,
) -> tuple[str, dict, dict, Any]:
    """
    Build (url, query_params, headers, request_body) from spec + user params.
    """
    # Resolve base URL
    if base_url:
        server_url = base_url.rstrip("/")
    else:
        servers = spec.get("servers", [{}])
        server_url = (servers[0].get("url") or "").rstrip("/")

    # Separate path / query / header parameters
    path_params: dict[str, str] = {}
    query_params: dict[str, str] = {}
    headers: dict[str, str] = {}
    body: Any = None

    for param_def in operation.get("parameters", []):
        name = param_def.get("name", "")
        location = param_def.get("in", "query")
        if name in params:
            value = str(params[name])
            if location == "path":
                path_params[name] = value
            elif location == "header":
                headers[name] = value
            else:
                query_params[name] = value

    # Build path
    url_path = path_template
    for name, value in path_params.items():
        url_path = url_path.replace(f"{{{name}}}", value)

    url = server_url + url_path

    # Request body (requestBody in operation)
    if "requestBody" in operation and params.get("body"):
        body = params["body"]

    return url, query_params, headers, body


async def _call_operation(
    spec: str,
    operation_id: str,
    params: dict,
    auth_header: str | None,
    base_url: str | None,
    refresh_cache: bool,
) -> dict:
    spec_dict = await _fetch_spec(spec, refresh=refresh_cache)
    path_template, method, operation = _find_operation(spec_dict, operation_id)
    url, query_params, headers, body = _build_request(
        spec_dict, path_template, method, operation, params, base_url
    )

    if auth_header:
        headers["Authorization"] = auth_header

    async with httpx.AsyncClient(timeout=30.0) as client:
        req_kwargs: dict[str, Any] = {"params": query_params, "headers": headers}
        if body is not None:
            if isinstance(body, (dict, list)):
                req_kwargs["json"] = body
            else:
                req_kwargs["content"] = str(body)

        resp = await getattr(client, method)(url, **req_kwargs)

    try:
        return {
            "status_code": resp.status_code,
            "result": resp.json(),
        }
    except Exception:
        return {
            "status_code": resp.status_code,
            "result": resp.text[:4000],
        }


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "openapi_consumer",
    "description": (
        "Execute any REST API operation described by an OpenAPI 3.x spec. "
        "Provide the spec URL (or raw JSON string), the operationId to call, "
        "and a params dict matching the operation's path/query/header parameters. "
        "Optionally supply a base_url override and an auth_header value."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "spec_source":    {"type": "string",  "description": "URL to fetch OpenAPI spec, or inline spec as JSON string"},
            "operation_id":   {"type": "string",  "description": "operationId from the spec to invoke"},
            "params":         {"type": "object",  "description": "Parameter values keyed by parameter name (path, query, header, or body)"},
            "auth_header":    {"type": "string",  "description": "Value for the Authorization header (e.g. 'Bearer <token>')"},
            "base_url":       {"type": "string",  "description": "Override the server URL defined in the spec"},
            "refresh_cache":  {"type": "boolean", "description": "Re-fetch the spec even if it's cached (default false)"},
        },
        "required": ["spec_source", "operation_id"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    """MCP-compatible wrapper for openapi_consumer."""
    spec_source  = inputs.get("spec_source", "")
    operation_id = inputs.get("operation_id", "")

    if not spec_source:
        return {"error": "spec_source is required"}
    if not operation_id:
        return {"error": "operation_id is required"}

    try:
        return await _call_operation(
            spec=spec_source,
            operation_id=operation_id,
            params=inputs.get("params") or {},
            auth_header=inputs.get("auth_header"),
            base_url=inputs.get("base_url"),
            refresh_cache=bool(inputs.get("refresh_cache", False)),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    except httpx.HTTPStatusError as exc:
        return {"error": f"HTTP {exc.response.status_code}: {exc.response.text[:500]}"}
    except Exception as exc:
        logger.error("[openapi_consumer] error: %s", exc)
        return {"error": str(exc)}
