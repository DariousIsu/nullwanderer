"""
AURA NX-Alpha — File System Service

Safe OS-level file operations for agent use.  All destructive operations
(delete, overwrite-write, move) require explicit confirmation to prevent
accidental data loss.

DESIGN:
    - Reads and directory listings are always safe (no gate)
    - Writes/edits delegate to the existing file_write_tool (no duplication)
    - Moves and deletes require confirmed=True OR a pre-authorised op_id
    - Deletes send files to ~/.aura/trash/ (recoverable) not the OS trash
    - Search delegates to file_index_service (Windows Search OLE DB)
      with an fnmatch walk fallback for paths outside the search index

SINGLETON:
    init_file_system()   — create and return instance
    get_file_system()    — get instance (None if not yet initialised)
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_HOME = Path.home()
_TRASH_DIR = _HOME / ".aura" / "trash"

# Directories to skip during directory listing / recursive search
# (mirrors file_monitor_service._SKIP_DIRS pattern)
_SKIP_DIRS: frozenset[str] = frozenset({
    ".git", "__pycache__", "node_modules", ".venv", "venv",
    ".tox", "dist", "build", ".cache", ".npm", ".yarn",
    "AppData", "Windows", "Program Files", "Program Files (x86)",
})

# ── Singleton ─────────────────────────────────────────────────────────────────
_instance: "FileSystemService | None" = None


def init_file_system() -> "FileSystemService":
    """Instantiate and register the global FileSystemService singleton."""
    global _instance
    _instance = FileSystemService()
    return _instance


def get_file_system() -> "FileSystemService | None":
    """Return the global singleton, or None if not yet initialised."""
    return _instance


# ── Service ────────────────────────────────────────────────────────────────────

class FileSystemService:
    """
    Safe file system operations for AURA agents.

    Never instantiate directly — use init_file_system() / get_file_system().
    """

    def __init__(self) -> None:
        _TRASH_DIR.mkdir(parents=True, exist_ok=True)
        # op_id → expiry_timestamp  (30-second pre-authorisation window)
        self._authorized_ops: dict[str, float] = {}

    # ── Authorization gate ────────────────────────────────────────────────────

    def authorize_operation(self, op_id: str) -> None:
        """
        Pre-authorise a destructive operation for 30 seconds.

        Called by the Electron confirmation dialog callback
        (POST /computer-use/authorize).
        """
        self._authorized_ops[op_id] = time.time() + 30.0
        # Prune expired entries
        now = time.time()
        self._authorized_ops = {k: v for k, v in self._authorized_ops.items() if v > now}

    def _is_authorized(self, op_id: Optional[str], confirmed: bool) -> bool:
        if confirmed:
            return True
        if not op_id:
            return False
        expiry = self._authorized_ops.get(op_id)
        return expiry is not None and time.time() < expiry

    # ── Directory listing ─────────────────────────────────────────────────────

    def list_directory(self, path: str, depth: int = 1) -> dict:
        """
        List the contents of a directory.

        Parameters
        ----------
        path : str
            Directory path (~ expanded).
        depth : int
            1 = immediate children only; >1 = recursive up to that depth.

        Returns
        -------
        dict
            {"path": str, "entries": [{name, type, size_kb, modified, ext}]}
        """
        resolved = Path(os.path.expanduser(path)).resolve()
        if not resolved.exists():
            return {"error": f"Path does not exist: {resolved}"}
        if not resolved.is_dir():
            return {"error": f"Not a directory: {resolved}"}

        entries = self._scan_dir(resolved, depth=depth, current_depth=0)
        return {"path": str(resolved), "entries": entries}

    def _scan_dir(self, dirpath: Path, depth: int, current_depth: int) -> list[dict]:
        entries: list[dict] = []
        try:
            for item in sorted(dirpath.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
                if item.name in _SKIP_DIRS:
                    continue
                try:
                    stat = item.stat()
                    entry: dict = {
                        "name":     item.name,
                        "type":     "dir" if item.is_dir() else "file",
                        "size_kb":  round(stat.st_size / 1024, 1),
                        "modified": stat.st_mtime,
                        "ext":      item.suffix.lower() if item.is_file() else "",
                    }
                    if item.is_dir() and current_depth < depth - 1:
                        entry["children"] = self._scan_dir(
                            item, depth=depth, current_depth=current_depth + 1
                        )
                    entries.append(entry)
                except (PermissionError, OSError):
                    pass
        except (PermissionError, OSError) as exc:
            entries.append({"error": str(exc)})
        return entries

    # ── File reading ──────────────────────────────────────────────────────────

    def read_file(self, path: str, max_bytes: int = 500_000) -> dict:
        """
        Read the contents of a file.

        Binary files are identified by a null-byte scan and returned with
        binary=True so the agent knows not to try to parse them as text.

        Returns
        -------
        dict
            Text file:   {"path", "content", "encoding", "truncated", "size_kb"}
            Binary file: {"path", "binary": True, "size_kb"}
            Error:       {"error": str}
        """
        resolved = Path(os.path.expanduser(path)).resolve()
        if not resolved.exists():
            return {"error": f"File not found: {resolved}"}
        if not resolved.is_file():
            return {"error": f"Not a file: {resolved}"}

        try:
            size = resolved.stat().st_size
            size_kb = round(size / 1024, 1)

            # Detect binary via first 8 KB
            probe = resolved.read_bytes()[:8192]
            if b"\x00" in probe:
                return {"path": str(resolved), "binary": True, "size_kb": size_kb}

            # Text read with size cap
            raw = resolved.read_bytes()
            truncated = len(raw) > max_bytes
            if truncated:
                raw = raw[:max_bytes]

            for enc in ("utf-8", "utf-8-sig", "latin-1"):
                try:
                    content = raw.decode(enc)
                    return {
                        "path":      str(resolved),
                        "content":   content,
                        "encoding":  enc,
                        "truncated": truncated,
                        "size_kb":   size_kb,
                    }
                except UnicodeDecodeError:
                    continue

            return {"path": str(resolved), "binary": True, "size_kb": size_kb}

        except (PermissionError, OSError) as exc:
            return {"error": f"Permission denied: {exc}"}
        except Exception as exc:
            return {"error": str(exc)}

    # ── File info ─────────────────────────────────────────────────────────────

    def get_file_info(self, path: str) -> dict:
        """Return metadata about a file or directory."""
        resolved = Path(os.path.expanduser(path)).resolve()
        if not resolved.exists():
            return {"error": f"Path not found: {resolved}"}
        try:
            stat = resolved.stat()
            return {
                "path":     str(resolved),
                "name":     resolved.name,
                "type":     "dir" if resolved.is_dir() else "file",
                "size_kb":  round(stat.st_size / 1024, 1),
                "created":  stat.st_ctime,
                "modified": stat.st_mtime,
                "ext":      resolved.suffix.lower(),
            }
        except Exception as exc:
            return {"error": str(exc)}

    # ── File search ───────────────────────────────────────────────────────────

    def search_files(
        self,
        query: str,
        root: Optional[str] = None,
        extensions: Optional[list[str]] = None,
        max_results: int = 50,
    ) -> list[dict]:
        """
        Search for files by name/content.

        Tries file_index_service (Windows Search OLE DB) first; if root is
        specified and not indexed, falls back to a recursive fnmatch walk.

        Returns
        -------
        list[dict]
            [{"path", "name", "size_kb", "modified"}]
        """
        # Try Windows Search via file_index_service
        try:
            from app.service.file_index_service import search_files as _idx_search
            results = _idx_search(query, max_results=max_results)
            if results:
                filtered = results
                if extensions:
                    exts_lower = {e.lower().lstrip(".") for e in extensions}
                    filtered = [
                        r for r in results
                        if Path(r.get("path", "")).suffix.lower().lstrip(".") in exts_lower
                    ]
                return filtered[:max_results]
        except Exception:
            pass

        # Fallback: fnmatch walk
        if not root:
            root = str(_HOME)
        return self._walk_search(root, query, extensions, max_results)

    def _walk_search(
        self,
        root: str,
        query: str,
        extensions: Optional[list[str]],
        max_results: int,
    ) -> list[dict]:
        import fnmatch
        resolved_root = Path(os.path.expanduser(root)).resolve()
        exts_lower = {e.lower().lstrip(".") for e in extensions} if extensions else None
        results: list[dict] = []
        pattern = f"*{query}*"

        for dirpath, dirnames, filenames in os.walk(resolved_root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            for fname in filenames:
                if not fnmatch.fnmatch(fname.lower(), pattern.lower()):
                    continue
                if exts_lower and Path(fname).suffix.lower().lstrip(".") not in exts_lower:
                    continue
                fpath = Path(dirpath) / fname
                try:
                    stat = fpath.stat()
                    results.append({
                        "path":     str(fpath),
                        "name":     fname,
                        "size_kb":  round(stat.st_size / 1024, 1),
                        "modified": stat.st_mtime,
                    })
                except OSError:
                    pass
                if len(results) >= max_results:
                    return results
        return results

    # ── Directory creation ────────────────────────────────────────────────────

    def create_directory(self, path: str) -> dict:
        """Create a directory (and any missing parents). No confirmation needed."""
        resolved = Path(os.path.expanduser(path)).resolve()
        try:
            resolved.mkdir(parents=True, exist_ok=True)
            return {"created": True, "path": str(resolved)}
        except Exception as exc:
            return {"error": str(exc)}

    # ── File copy ─────────────────────────────────────────────────────────────

    def copy_file(self, src: str, dst: str) -> dict:
        """Copy a file. No confirmation needed (source is preserved)."""
        src_p = Path(os.path.expanduser(src)).resolve()
        dst_p = Path(os.path.expanduser(dst)).resolve()
        if not src_p.exists():
            return {"error": f"Source not found: {src_p}"}
        try:
            dst_p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_p, dst_p)
            return {"copied": True, "src": str(src_p), "dst": str(dst_p)}
        except Exception as exc:
            return {"error": str(exc)}

    # ── File move (REQUIRES CONFIRMATION) ────────────────────────────────────

    def move_file(
        self,
        src: str,
        dst: str,
        confirmed: bool = False,
        op_id: Optional[str] = None,
    ) -> dict:
        """
        Move a file or directory.  Requires confirmed=True or a pre-authorised op_id.
        """
        if not self._is_authorized(op_id, confirmed):
            return {
                "requires_confirmation": True,
                "action": "move",
                "src": src,
                "dst": dst,
                "message": "Set confirmed=True or call POST /computer-use/authorize first.",
            }
        src_p = Path(os.path.expanduser(src)).resolve()
        dst_p = Path(os.path.expanduser(dst)).resolve()
        if not src_p.exists():
            return {"error": f"Source not found: {src_p}"}
        try:
            dst_p.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src_p), str(dst_p))
            return {"moved": True, "src": str(src_p), "dst": str(dst_p)}
        except Exception as exc:
            return {"error": str(exc)}

    # ── File delete → trash (REQUIRES CONFIRMATION) ───────────────────────────

    def delete_file(
        self,
        path: str,
        confirmed: bool = False,
        op_id: Optional[str] = None,
    ) -> dict:
        """
        Move a file/directory to ~/.aura/trash/ (recoverable).
        Requires confirmed=True or a pre-authorised op_id.
        """
        if not self._is_authorized(op_id, confirmed):
            return {
                "requires_confirmation": True,
                "action": "delete",
                "path": path,
                "message": "Set confirmed=True or call POST /computer-use/authorize first.",
            }
        resolved = Path(os.path.expanduser(path)).resolve()
        if not resolved.exists():
            return {"error": f"Path not found: {resolved}"}
        try:
            ts_prefix = int(time.time())
            trash_path = _TRASH_DIR / f"{ts_prefix}_{resolved.name}"
            shutil.move(str(resolved), str(trash_path))
            return {"deleted": True, "path": str(resolved), "trash_path": str(trash_path)}
        except Exception as exc:
            return {"error": str(exc)}

    # ── File write / edit (delegates to existing tools) ───────────────────────

    async def write_file(
        self,
        path: str,
        content: str,
        confirmed: bool = False,
        op_id: Optional[str] = None,
    ) -> dict:
        """Write a new file or overwrite an existing one."""
        resolved = Path(os.path.expanduser(path)).resolve()
        # Overwriting existing file requires confirmation
        if resolved.exists() and not self._is_authorized(op_id, confirmed):
            return {
                "requires_confirmation": True,
                "action": "write",
                "path": str(resolved),
                "message": "File exists — set confirmed=True to overwrite.",
            }
        try:
            from app.tools.file_write_tool import file_write
            result = await file_write(str(resolved), content)
            return result if isinstance(result, dict) else {"written": True, "path": str(resolved)}
        except Exception as exc:
            return {"error": str(exc)}

    async def edit_file(self, path: str, old_text: str, new_text: str) -> dict:
        """Edit a file by replacing old_text with new_text."""
        try:
            from app.tools.file_write_tool import file_edit
            result = await file_edit(str(Path(os.path.expanduser(path)).resolve()), old_text, new_text)
            return result if isinstance(result, dict) else {"edited": True}
        except Exception as exc:
            return {"error": str(exc)}
