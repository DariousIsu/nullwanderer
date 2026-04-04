"""
Notion — MCP tool wrapper.

Query databases, create/read pages, search. Requires Integration Token.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.notion.com/v1"
_VERSION = "2022-06-28"

TOOL_DEF = {
    "name": "notion",
    "description": (
        "Interact with Notion: search pages, query databases, create pages, "
        "and read page content. Use for policy document tracking, team wikis, "
        "and project management."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action":      {"type": "string", "enum": ["search", "query_database", "get_page", "create_page"], "description": "Notion action"},
            "query":       {"type": "string", "description": "Search query (for search action)"},
            "database_id": {"type": "string", "description": "Database ID (for query_database)"},
            "page_id":     {"type": "string", "description": "Page ID (for get_page)"},
            "parent_id":   {"type": "string", "description": "Parent page or database ID (for create_page)"},
            "title":       {"type": "string", "description": "Page title (for create_page)"},
            "content":     {"type": "string", "description": "Page content in plain text (for create_page)"},
            "limit":       {"type": "integer", "default": 10},
        },
        "required": ["action"],
    },
}


def _headers() -> dict:
    token = _get_setting("notion_integration_token")
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": _VERSION,
        "Content-Type": "application/json",
    } if token else {}


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    token = _get_setting("notion_integration_token")
    if not token:
        return _error("notion_integration_token not configured in settings")

    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_headers()) as client:

            if action == "search":
                query = inputs.get("query", "")
                body = {"query": query, "page_size": inputs.get("limit", 10)}
                r = await client.post(f"{_BASE}/search", json=body)
                r.raise_for_status()
                data = r.json()
                results = []
                for item in data.get("results", []):
                    title_prop = item.get("properties", {}).get("title") or item.get("properties", {}).get("Name")
                    title = ""
                    if title_prop and title_prop.get("title"):
                        title = title_prop["title"][0].get("plain_text", "") if title_prop["title"] else ""
                    results.append({"id": item["id"], "type": item["object"], "title": title, "url": item.get("url", ""), "last_edited": item.get("last_edited_time", "")})
                return {"results": results, "total": len(results), "query": query}

            elif action == "query_database":
                db_id = inputs.get("database_id", "")
                if not db_id:
                    return _error("database_id required")
                r = await client.post(f"{_BASE}/databases/{db_id}/query", json={"page_size": inputs.get("limit", 10)})
                r.raise_for_status()
                data = r.json()
                rows = []
                for page in data.get("results", []):
                    props = {}
                    for key, val in page.get("properties", {}).items():
                        t = val.get("type", "")
                        if t == "title" and val.get("title"):
                            props[key] = val["title"][0].get("plain_text", "")
                        elif t == "rich_text" and val.get("rich_text"):
                            props[key] = val["rich_text"][0].get("plain_text", "")
                        elif t == "number":
                            props[key] = val.get("number")
                        elif t == "select" and val.get("select"):
                            props[key] = val["select"].get("name", "")
                        elif t == "date" and val.get("date"):
                            props[key] = val["date"].get("start", "")
                        elif t == "checkbox":
                            props[key] = val.get("checkbox", False)
                    page_id_row = page["id"]
                    rows.append({"id": page_id_row, "properties": props, "url": page.get("url", "")})
                    # Absorb row metadata into LightRAG (non-blocking)
                    if props:
                        try:
                            from app.service.lightrag_service import LightRAGService
                            LightRAGService.get_instance().enqueue_ingest(
                                str(props), f"notion:{page_id_row}", "document"
                            )
                        except Exception as _lg_exc:
                            import logging as _lg; _lg.getLogger(__name__).debug("[notion] LightRAG enqueue failed: %s", _lg_exc)
                return {"rows": rows, "count": len(rows)}

            elif action == "get_page":
                page_id = inputs.get("page_id", "")
                if not page_id:
                    return _error("page_id required")
                r = await client.get(f"{_BASE}/pages/{page_id}")
                r.raise_for_status()
                page = r.json()
                # Also get blocks (content)
                r2 = await client.get(f"{_BASE}/blocks/{page_id}/children", params={"page_size": 50})
                blocks = r2.json().get("results", []) if r2.status_code == 200 else []
                content_parts = []
                for block in blocks:
                    btype = block.get("type", "")
                    rich_text = block.get(btype, {}).get("rich_text", [])
                    text = " ".join(rt.get("plain_text", "") for rt in rich_text) if rich_text else ""
                    if text:
                        content_parts.append(text)
                full_content = "\n".join(content_parts)
                # Absorb page content into LightRAG knowledge graph (non-blocking)
                if full_content and len(full_content) > 100:
                    try:
                        from app.service.lightrag_service import LightRAGService
                        LightRAGService.get_instance().enqueue_ingest(
                            full_content, f"notion:{page_id}", "document"
                        )
                    except Exception as _lg_exc:
                        import logging as _lg; _lg.getLogger(__name__).debug("[notion] LightRAG enqueue failed: %s", _lg_exc)
                return {"id": page["id"], "url": page.get("url", ""), "content": full_content[:3000], "last_edited": page.get("last_edited_time", "")}

            elif action == "create_page":
                parent_id = inputs.get("parent_id", "")
                title = inputs.get("title", "")
                if not parent_id or not title:
                    return _error("parent_id and title required")
                body = {
                    "parent": {"page_id": parent_id},
                    "properties": {"title": {"title": [{"text": {"content": title}}]}},
                }
                content = inputs.get("content", "")
                if content:
                    body["children"] = [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": content[:2000]}}]}}]
                r = await client.post(f"{_BASE}/pages", json=body)
                r.raise_for_status()
                page = r.json()
                return {"id": page["id"], "url": page.get("url", ""), "created": True}

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[notion_api] %s", exc)
        return _error(str(exc))
