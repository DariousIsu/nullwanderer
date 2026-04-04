"""
AURA NX-Alpha — File Index Service

Queries existing OS and cloud indexes for relevant files given a topic.
Does NOT build its own index — queries Windows Search and Google Drive's
own indexes, both of which are already maintained by the OS/service.

PUBLIC API:
    search_files(query, max_results=10) → list[FileResult]

Results are normalized to a common shape:
    {name, path, source, type, modified, size_kb, drive_id}

SOURCES:
    windows_search  — Windows Search OLE DB (SystemIndex catalog)
                      Covers Desktop, Documents, Downloads, OneDrive sync.
                      Falls back to PowerShell if win32com unavailable.
    google_drive    — Drive API files().list() with fullText search.
                      Only runs if Google is authenticated.

MEMORY COST:
    Only file metadata is returned — name, path, type, modified date.
    File content is never loaded here. Total injection cost is ~5 tokens
    per file regardless of file size.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# RESULT TYPE
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class FileResult:
    name:     str
    path:     str          # local absolute path or Drive URL
    source:   str          # "local" | "drive"
    type:     str          # extension without dot, e.g. "docx"
    modified: str          # ISO date string
    size_kb:  float = 0.0
    drive_id: str = ""     # Google Drive file ID (empty for local)

    def to_dict(self) -> dict:
        return {
            "name":     self.name,
            "path":     self.path,
            "source":   self.source,
            "type":     self.type,
            "modified": self.modified,
            "size_kb":  round(self.size_kb, 1),
            "drive_id": self.drive_id,
        }


# ─────────────────────────────────────────────────────────────────────────────
# WINDOWS SEARCH
# ─────────────────────────────────────────────────────────────────────────────

def _windows_search_sync(query: str, max_results: int) -> list[FileResult]:
    """
    Query the Windows Search index (SystemIndex) via OLE DB.
    Falls back to PowerShell if win32com is unavailable.

    Only returns files (not folders). Excludes system/temp files.
    """
    # Sanitize query for SQL injection — Windows Search uses parameterized
    # CONTAINS() but we build a LIKE fallback so escape both ways.
    safe = query.replace("'", "''").replace('"', '""')[:200]

    try:
        return _windows_search_oledb(safe, max_results)
    except Exception as exc:
        logger.debug("[file_index] OLE DB failed (%s), trying PowerShell", exc)
        try:
            return _windows_search_powershell(safe, max_results)
        except Exception as exc2:
            logger.debug("[file_index] PowerShell search failed: %s", exc2)
            return []


def _windows_search_oledb(query: str, max_results: int) -> list[FileResult]:
    """Query SystemIndex via win32com ADO."""
    import win32com.client  # type: ignore

    conn = win32com.client.Dispatch("ADODB.Connection")
    conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")

    # CONTAINS() for full-text ranking; fall back to LIKE for partial names.
    # We exclude common noise paths.
    sql = f"""
        SELECT TOP {max_results}
            System.FileName,
            System.ItemPathDisplay,
            System.ItemType,
            System.DateModified,
            System.Size
        FROM SystemIndex
        WHERE CONTAINS(*, '{query}')
          AND System.Kind = 'document'
          AND System.ItemPathDisplay NOT LIKE '%\\AppData\\%'
          AND System.ItemPathDisplay NOT LIKE '%\\Temp\\%'
          AND System.ItemPathDisplay NOT LIKE '%\\.git\\%'
        ORDER BY System.Search.Rank DESC
    """
    rs = win32com.client.Dispatch("ADODB.Recordset")
    rs.Open(sql, conn)

    results: list[FileResult] = []
    while not rs.EOF:
        name     = str(rs.Fields["System.FileName"].Value or "")
        path     = str(rs.Fields["System.ItemPathDisplay"].Value or "")
        ext      = str(rs.Fields["System.ItemType"].Value or "").lstrip(".").lower()
        modified = str(rs.Fields["System.DateModified"].Value or "")[:10]
        size_b   = rs.Fields["System.Size"].Value or 0
        if name and path:
            results.append(FileResult(
                name=name, path=path, source="local",
                type=ext, modified=modified, size_kb=size_b / 1024,
            ))
        rs.MoveNext()

    rs.Close()
    conn.Close()
    return results


def _windows_search_powershell(query: str, max_results: int) -> list[FileResult]:
    """
    Fallback: use PowerShell Get-ChildItem against common user directories.
    Slower than OLE DB but requires no extra dependencies.
    """
    import subprocess
    import json as _json

    # Search user's common directories
    search_dirs = [
        str(Path.home() / "Desktop"),
        str(Path.home() / "Documents"),
        str(Path.home() / "Downloads"),
        r"C:\Users\azrae\Desktop",  # project-specific
    ]
    dirs_ps = ", ".join(f'"{d}"' for d in search_dirs if os.path.isdir(d))

    ps_script = f"""
$dirs = @({dirs_ps})
$results = @()
foreach ($dir in $dirs) {{
    Get-ChildItem -Path $dir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {{ $_.Name -like '*{query}*' -or $_.DirectoryName -like '*{query}*' }} |
    Select-Object -First {max_results} |
    ForEach-Object {{
        $results += [PSCustomObject]@{{
            Name     = $_.Name
            Path     = $_.FullName
            Ext      = $_.Extension.TrimStart('.')
            Modified = $_.LastWriteTime.ToString('yyyy-MM-dd')
            SizeKB   = [math]::Round($_.Length / 1024, 1)
        }}
    }}
}}
$results | Select-Object -First {max_results} | ConvertTo-Json -Compress
"""
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_script],
        capture_output=True, text=True, timeout=10,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return []

    raw = _json.loads(proc.stdout.strip())
    if isinstance(raw, dict):
        raw = [raw]

    results = []
    for item in raw[:max_results]:
        results.append(FileResult(
            name=item.get("Name", ""),
            path=item.get("Path", ""),
            source="local",
            type=item.get("Ext", "").lower(),
            modified=item.get("Modified", ""),
            size_kb=item.get("SizeKB", 0.0),
        ))
    return [r for r in results if r.name and r.path]


# ─────────────────────────────────────────────────────────────────────────────
# GOOGLE DRIVE
# ─────────────────────────────────────────────────────────────────────────────

_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

# MIME types we care about — skip raw binary formats, focus on readable docs
_DRIVE_MIME_INCLUDE = {
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/msword",
    "text/plain",
    "application/pdf",
}

_MIME_TO_EXT = {
    "application/vnd.google-apps.document":      "gdoc",
    "application/vnd.google-apps.spreadsheet":   "gsheet",
    "application/vnd.google-apps.presentation":  "gslide",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":       "xlsx",
    "application/msword":                        "doc",
    "application/vnd.ms-excel":                  "xls",
    "text/plain":                                "txt",
    "application/pdf":                           "pdf",
}


def _drive_search_sync(query: str, max_results: int) -> list[FileResult]:
    """
    Search Google Drive using the Drive API v3 files().list().
    Uses Drive's own full-text search index — no content downloaded here.

    Requires drive.readonly scope. If not yet authorized, returns [].
    """
    try:
        from app.service.google_service import GoogleService
        svc = GoogleService()
        creds = svc._get_valid_creds()
        if creds is None:
            logger.debug("[file_index] Google not authenticated — skipping Drive search")
            return []

        # Check if drive scope is present
        if _DRIVE_SCOPE not in (creds.scopes or []):
            logger.debug("[file_index] drive.readonly scope not granted — skipping Drive search")
            return []

        from googleapiclient.discovery import build  # type: ignore
        service = build("drive", "v3", credentials=creds)

        # Drive full-text search — 'fullText contains' searches content too
        q = f"fullText contains '{query}' and trashed = false"
        resp = service.files().list(
            q=q,
            pageSize=max_results,
            fields="files(id, name, mimeType, modifiedTime, size, webViewLink)",
        ).execute()

        results = []
        for f in resp.get("files", []):
            mime = f.get("mimeType", "")
            if mime not in _DRIVE_MIME_INCLUDE:
                continue
            ext = _MIME_TO_EXT.get(mime, "")
            size_bytes = int(f.get("size", 0))
            modified = (f.get("modifiedTime") or "")[:10]
            results.append(FileResult(
                name=f.get("name", ""),
                path=f.get("webViewLink", f"https://drive.google.com/file/d/{f['id']}"),
                source="drive",
                type=ext,
                modified=modified,
                size_kb=size_bytes / 1024,
                drive_id=f.get("id", ""),
            ))
        return results

    except Exception as exc:
        logger.debug("[file_index] Drive search error: %s", exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def search_files(
    query: str,
    max_results: int = 10,
    sources: list[str] | None = None,  # None = all, or ["local", "drive"]
) -> list[FileResult]:
    """
    Search both Windows Search and Google Drive for files matching the query.
    Runs both searches concurrently. Returns combined results, deduplicated by name.

    Memory cost: metadata only (~5 tokens per result). No content loaded.
    """
    if not query or not query.strip():
        return []

    use_local = sources is None or "local" in sources
    use_drive = sources is None or "drive" in sources

    tasks = []
    if use_local:
        tasks.append(asyncio.to_thread(_windows_search_sync, query, max_results))
    if use_drive:
        tasks.append(asyncio.to_thread(_drive_search_sync, query, max_results))

    results_nested = await asyncio.gather(*tasks, return_exceptions=True)

    combined: list[FileResult] = []
    seen_names: set[str] = set()
    for chunk in results_nested:
        if isinstance(chunk, list):
            for r in chunk:
                key = r.name.lower()
                if key not in seen_names:
                    seen_names.add(key)
                    combined.append(r)

    # Sort: local files first (already on disk), then drive
    combined.sort(key=lambda r: (0 if r.source == "local" else 1, r.name.lower()))
    return combined[:max_results]


def format_file_manifest(files: list[FileResult]) -> str:
    """
    Format a compact file list for prompt injection.
    ~5 tokens per file — safe to include in every message where relevant.

    Example output:
        Files on standby: Pricing Sheet.xlsx (local), GLEIPNIR CONSULTING CORP.docx (local), Budget 2026.gsheet (drive)
    """
    if not files:
        return ""
    items = [f"{f.name} ({f.source})" for f in files[:8]]
    return "Files on standby: " + ", ".join(items) + "."
