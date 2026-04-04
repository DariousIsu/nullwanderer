"""
Google Workspace tool — Drive, Docs, and Sheets access via existing OAuth2 credentials.

Reuses google_service.py for credential loading and refresh.
Extended scopes (drive, documents, spreadsheets) are now in google_service.SCOPES.

NOTE: The user must re-authorize via Settings → Google Connect after this scope
expansion. Existing calendar/gmail tokens will prompt for re-consent on next use.

Operations:
  drive_search  — search files in Drive
  drive_get     — get file metadata
  docs_read     — read a Google Doc as plain text
  docs_create   — create a new Google Doc
  sheets_read   — read a range from a Spreadsheet
  sheets_write  — write values to a range
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _get_creds(account_id: str | None = None):
    """Load and refresh Google credentials via GoogleService."""
    from app.service.google_service import get_google_service
    svc = get_google_service()
    creds = svc._load_creds(account_id)
    if creds:
        svc._refresh_if_needed(creds, account_id)
    return creds


def _drive_service(creds):
    from googleapiclient.discovery import build  # type: ignore
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _docs_service(creds):
    from googleapiclient.discovery import build  # type: ignore
    return build("docs", "v1", credentials=creds, cache_discovery=False)


def _sheets_service(creds):
    from googleapiclient.discovery import build  # type: ignore
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


# ── Operation implementations ─────────────────────────────────────────────────

def _drive_search_sync(query: str, max_results: int, creds) -> list[dict]:
    svc = _drive_service(creds)
    resp = svc.files().list(
        q=query,
        pageSize=min(max_results, 50),
        fields="files(id,name,mimeType,modifiedTime,webViewLink)",
    ).execute()
    return resp.get("files", [])


def _drive_get_sync(file_id: str, creds) -> dict:
    svc = _drive_service(creds)
    return svc.files().get(
        fileId=file_id,
        fields="id,name,mimeType,modifiedTime,size,webViewLink,parents",
    ).execute()


def _docs_read_sync(document_id: str, creds) -> dict:
    svc = _docs_service(creds)
    doc = svc.documents().get(documentId=document_id).execute()
    # Extract plain text from the document body
    text_parts = []
    for elem in doc.get("body", {}).get("content", []):
        paragraph = elem.get("paragraph")
        if paragraph:
            for pe in paragraph.get("elements", []):
                text_run = pe.get("textRun")
                if text_run:
                    text_parts.append(text_run.get("content", ""))
    full_text = "".join(text_parts)
    # Absorb document content into LightRAG knowledge graph (non-blocking)
    if full_text and len(full_text) > 200:
        try:
            from app.service.lightrag_service import LightRAGService
            LightRAGService.get_instance().enqueue_ingest(
                full_text, f"gdoc:{document_id}", "document"
            )
        except Exception as _lg_exc:
            import logging as _lg; _lg.getLogger(__name__).debug("[gdocs] LightRAG enqueue failed: %s", _lg_exc)
    return {
        "title": doc.get("title", ""),
        "document_id": document_id,
        "text": full_text,
    }


def _docs_create_sync(title: str, content: str, creds) -> dict:
    svc = _docs_service(creds)
    doc = svc.documents().create(body={"title": title}).execute()
    doc_id = doc["documentId"]
    if content:
        svc.documents().batchUpdate(
            documentId=doc_id,
            body={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
        ).execute()
    return {"document_id": doc_id, "title": title, "url": f"https://docs.google.com/document/d/{doc_id}"}


def _sheets_read_sync(spreadsheet_id: str, range_: str, creds) -> dict:
    svc = _sheets_service(creds)
    result = svc.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=range_,
    ).execute()
    values = result.get("values", [])
    # Absorb sheet content into LightRAG knowledge graph (non-blocking)
    if values:
        sheet_text = "\n".join(", ".join(str(cell) for cell in row) for row in values[:100])
        if len(sheet_text) > 100:
            try:
                from app.service.lightrag_service import LightRAGService
                LightRAGService.get_instance().enqueue_ingest(
                    sheet_text, f"gdoc:{spreadsheet_id}", "document"
                )
            except Exception as _lg_exc:
                import logging as _lg; _lg.getLogger(__name__).debug("[gsheets] LightRAG enqueue failed: %s", _lg_exc)
    return {
        "range": result.get("range"),
        "values": values,
    }


def _sheets_write_sync(spreadsheet_id: str, range_: str, values: list[list], creds) -> dict:
    svc = _sheets_service(creds)
    result = svc.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=range_,
        valueInputOption="USER_ENTERED",
        body={"values": values},
    ).execute()
    return {
        "updated_range": result.get("updatedRange"),
        "updated_cells": result.get("updatedCells"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "google_workspace",
    "description": (
        "Read and write Google Drive files, Docs, and Sheets. "
        "Requires Google account connected via Settings → Google Connect. "
        "Operations: drive_search, drive_get, docs_read, docs_create, sheets_read, sheets_write."
    ),
    "expose_components": True,
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["drive_search", "drive_get", "docs_read", "docs_create", "sheets_read", "sheets_write"],
                "description": "Operation to perform",
            },
            "query":          {"type": "string",  "description": "Search query for drive_search"},
            "file_id":        {"type": "string",  "description": "File ID for drive_get"},
            "document_id":    {"type": "string",  "description": "Google Doc ID for docs_read"},
            "title":          {"type": "string",  "description": "Document title for docs_create"},
            "content":        {"type": "string",  "description": "Initial text content for docs_create"},
            "spreadsheet_id": {"type": "string",  "description": "Spreadsheet ID for sheets operations"},
            "range":          {"type": "string",  "description": "A1 notation range e.g. 'Sheet1!A1:C10'"},
            "values":         {"type": "array",   "description": "2D array of values for sheets_write"},
            "max_results":    {"type": "integer", "description": "Max files for drive_search (default 20)"},
            "account_id":     {"type": "string",  "description": "Google account ID if multiple accounts connected"},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    """MCP-compatible wrapper for Google Workspace operations."""
    op         = inputs.get("operation", "")
    account_id = inputs.get("account_id")

    try:
        creds = await asyncio.to_thread(_get_creds, account_id)
        if not creds or not creds.valid:
            return {
                "error": "Google account not authenticated. "
                         "Connect via Settings → Google Connect, then re-authorize "
                         "(new scopes require re-consent)."
            }

        if op == "drive_search":
            query = inputs.get("query", "")
            if not query:
                return {"error": "query is required for drive_search"}
            files = await asyncio.to_thread(
                _drive_search_sync, query, int(inputs.get("max_results", 20)), creds
            )
            return {"files": files}

        elif op == "drive_get":
            file_id = inputs.get("file_id", "")
            if not file_id:
                return {"error": "file_id is required for drive_get"}
            return await asyncio.to_thread(_drive_get_sync, file_id, creds)

        elif op == "docs_read":
            doc_id = inputs.get("document_id", "")
            if not doc_id:
                return {"error": "document_id is required for docs_read"}
            return await asyncio.to_thread(_docs_read_sync, doc_id, creds)

        elif op == "docs_create":
            title = inputs.get("title", "Untitled")
            content = inputs.get("content", "")
            return await asyncio.to_thread(_docs_create_sync, title, content, creds)

        elif op == "sheets_read":
            sid   = inputs.get("spreadsheet_id", "")
            range_ = inputs.get("range", "")
            if not sid or not range_:
                return {"error": "spreadsheet_id and range are required for sheets_read"}
            return await asyncio.to_thread(_sheets_read_sync, sid, range_, creds)

        elif op == "sheets_write":
            sid    = inputs.get("spreadsheet_id", "")
            range_ = inputs.get("range", "")
            values = inputs.get("values", [])
            if not sid or not range_ or not values:
                return {"error": "spreadsheet_id, range, and values are required for sheets_write"}
            return await asyncio.to_thread(_sheets_write_sync, sid, range_, values, creds)

        else:
            return {"error": f"Unknown operation: {op!r}"}

    except Exception as exc:
        logger.error("[google_workspace] operation=%s error: %s", op, exc)
        return {"error": str(exc)}
