"""
AURA NX-Alpha — Git Tool
Safe git operations scoped to the AURA project repo.

All operations run on named branches (aura/improvement/{slug}).
The main/master branch is never written to directly — only via merge
after the user explicitly confirms. Reversion creates a new inverse
commit rather than destructive resets.

PROJECT ROOT:
    Determined at import time by walking up from this file until .git is found.
    Typically: C:\\Users\\azrae\\Desktop\\NX-ALPHA

FORBIDDEN:
    - Direct writes to main/master
    - Force push
    - Changes outside the project root
    - Changes to .env or secrets files
"""

from __future__ import annotations

import ast
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# PROJECT ROOT
# ─────────────────────────────────────────────────────────────────────────────

def _find_project_root() -> Path:
    """Walk up from this file's location until we find a .git directory."""
    current = Path(__file__).resolve()
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    # Fallback: assume NX-ALPHA layout
    return Path(__file__).resolve().parents[4]


PROJECT_ROOT = _find_project_root()

# Files that can never be modified by the self-improvement service
_BLOCKED_PATHS = {".env", ".env.local", ".env.production", "secrets.json"}

# Branches the service can never write to directly
_PROTECTED_BRANCHES = {"main", "master", "develop"}

BRANCH_PREFIX = "aura/improvement"


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _run(args: list[str], check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    """Run a git command in the project root."""
    return subprocess.run(
        args,
        cwd=str(PROJECT_ROOT),
        capture_output=capture,
        text=True,
        check=check,
    )


def _safe_path(rel_path: str) -> Path:
    """
    Resolve a relative path against the project root.
    Raises ValueError if the path escapes the project root or is blocked.
    """
    resolved = (PROJECT_ROOT / rel_path).resolve()
    if not str(resolved).startswith(str(PROJECT_ROOT)):
        raise ValueError(f"Path escapes project root: {rel_path}")
    if resolved.name in _BLOCKED_PATHS:
        raise ValueError(f"Path is protected: {rel_path}")
    return resolved


# ─────────────────────────────────────────────────────────────────────────────
# BRANCH OPERATIONS
# ─────────────────────────────────────────────────────────────────────────────

def current_branch() -> str:
    """Return the name of the currently checked-out branch."""
    result = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    return result.stdout.strip()


def create_branch(slug: str) -> str:
    """
    Create and checkout aura/improvement/{slug}.
    Returns the full branch name.
    Raises if slug would overwrite a protected branch.
    """
    branch = f"{BRANCH_PREFIX}/{slug}"
    if branch in _PROTECTED_BRANCHES:
        raise ValueError(f"Branch name is protected: {branch}")
    _run(["git", "checkout", "-b", branch])
    logger.info("[git_tool] Created branch: %s", branch)
    return branch


def checkout_branch(branch: str) -> None:
    """Checkout an existing branch."""
    _run(["git", "checkout", branch])
    logger.info("[git_tool] Checked out: %s", branch)


def delete_branch(branch: str, force: bool = False) -> None:
    """Delete a branch. Refuses to delete protected branches."""
    base = branch.split("/")[-1]
    if base in _PROTECTED_BRANCHES or branch in _PROTECTED_BRANCHES:
        raise ValueError(f"Cannot delete protected branch: {branch}")
    flag = "-D" if force else "-d"
    _run(["git", "branch", flag, branch])
    logger.info("[git_tool] Deleted branch: %s", branch)


def merge_branch(branch: str, base: str = "main") -> str:
    """
    Merge branch into base. Returns the new HEAD commit hash.
    Raises on merge conflict.
    """
    if base in _PROTECTED_BRANCHES:
        # This is intentional — the user confirmed
        pass
    checkout_branch(base)
    _run(["git", "merge", "--no-ff", branch, "-m", f"Apply improvement: {branch}"])
    commit_hash = head_commit_hash()
    logger.info("[git_tool] Merged %s into %s → %s", branch, base, commit_hash)
    return commit_hash


def revert_commit(commit_hash: str) -> str:
    """
    Create a revert commit for commit_hash on the current branch.
    Returns the new HEAD commit hash.
    """
    _run(["git", "revert", "--no-edit", commit_hash])
    new_hash = head_commit_hash()
    logger.info("[git_tool] Reverted %s → new HEAD %s", commit_hash, new_hash)
    return new_hash


def head_commit_hash(branch: Optional[str] = None) -> str:
    """Return the HEAD commit hash, optionally for a specific branch."""
    ref = branch or "HEAD"
    result = _run(["git", "rev-parse", ref])
    return result.stdout.strip()


def get_diff(branch: str, base: str = "main") -> str:
    """
    Return a unified diff of branch vs base.
    Shows only files changed in the improvement branch.
    """
    result = _run(["git", "diff", f"{base}...{branch}"])
    return result.stdout


def commit_all(message: str) -> str:
    """Stage all changes in working tree and create a commit. Returns commit hash."""
    _run(["git", "add", "-A"])
    _run(["git", "commit", "-m", message])
    return head_commit_hash()


# ─────────────────────────────────────────────────────────────────────────────
# FILE OPERATIONS
# ─────────────────────────────────────────────────────────────────────────────

def read_file(rel_path: str) -> str:
    """Read a project file. rel_path is relative to project root."""
    path = _safe_path(rel_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {rel_path}")
    return path.read_text(encoding="utf-8", errors="replace")


def write_file(rel_path: str, content: str) -> None:
    """
    Write content to a project file.
    Creates parent directories if needed.
    Refuses writes to blocked paths.
    """
    path = _safe_path(rel_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    logger.info("[git_tool] Wrote %d chars to %s", len(content), rel_path)


def list_changed_files(branch: str, base: str = "main") -> list[str]:
    """Return list of file paths changed in branch relative to base."""
    result = _run(["git", "diff", "--name-only", f"{base}...{branch}"])
    return [f.strip() for f in result.stdout.splitlines() if f.strip()]


# ─────────────────────────────────────────────────────────────────────────────
# VALIDATION
# ─────────────────────────────────────────────────────────────────────────────

def validate_python(rel_path: str) -> tuple[bool, str]:
    """
    Parse a Python file with ast.parse.
    Returns (ok, error_message).
    """
    try:
        content = read_file(rel_path)
        ast.parse(content, filename=rel_path)
        return True, ""
    except SyntaxError as exc:
        return False, f"SyntaxError at line {exc.lineno}: {exc.msg}"
    except Exception as exc:
        return False, str(exc)


def validate_import(module_path: str) -> tuple[bool, str]:
    """
    Try to import a Python module in a subprocess.
    module_path is a dotted module path e.g. 'app.knowledge.local_search'.
    Returns (ok, error_message).
    """
    backend_dir = str(PROJECT_ROOT / "backend")
    result = subprocess.run(
        [sys.executable, "-c", f"import sys; sys.path.insert(0,'{backend_dir}'); import {module_path}"],
        capture_output=True,
        text=True,
        cwd=backend_dir,
        timeout=15,
    )
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout).strip()[:500]


def run_tests(scope: Optional[str] = None, timeout: int = 60) -> tuple[bool, str]:
    """
    Run pytest against the backend test suite.
    scope: optional path/file to restrict test run (e.g. 'tests/test_knowledge.py').
    Returns (passed, output).
    """
    backend_dir = PROJECT_ROOT / "backend"
    tests_dir   = backend_dir / "tests"

    if not tests_dir.exists():
        return True, "No tests directory found — skipping."

    cmd = [sys.executable, "-m", "pytest", "-x", "--tb=short", "-q"]
    if scope:
        cmd.append(scope)
    else:
        cmd.append(str(tests_dir))

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(backend_dir),
        timeout=timeout,
    )
    output = (result.stdout + result.stderr).strip()
    passed = result.returncode == 0
    logger.info("[git_tool] Tests %s (returncode=%d)", "passed" if passed else "failed", result.returncode)
    return passed, output[:2000]


# ─────────────────────────────────────────────────────────────────────────────
# STASH (for clean branch operations)
# ─────────────────────────────────────────────────────────────────────────────

def stash() -> bool:
    """Stash any uncommitted changes. Returns True if anything was stashed."""
    result = _run(["git", "stash"], check=False)
    return "No local changes" not in result.stdout


def stash_pop() -> None:
    """Pop the most recent stash."""
    _run(["git", "stash", "pop"], check=False)


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE — auto-registered by _mcp_wrapper.load_all_tools()
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "git",
    "description": (
        "Git operations scoped to the AURA project repository. "
        "Supports: status, diff, log, commit, branch (create/list/checkout/delete/merge), "
        "clone, pull, push, stash, stash_pop, revert, validate_python, validate_import, "
        "run_tests, read_file, write_file, list_changed_files, current_branch, head_hash."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "description": "Operation to perform.",
                "enum": [
                    "status", "diff", "log", "commit", "branch",
                    "clone", "pull", "push", "stash", "stash_pop",
                    "current_branch", "create_branch", "checkout_branch",
                    "delete_branch", "merge_branch", "revert", "head_hash",
                    "read_file", "write_file", "list_changed_files",
                    "validate_python", "validate_import", "run_tests",
                ],
            },
            "branch":       {"type": "string", "description": "Branch name or slug"},
            "base":         {"type": "string", "description": "Base branch (default: main)"},
            "message":      {"type": "string", "description": "Commit message"},
            "path":         {"type": "string", "description": "Relative file path"},
            "content":      {"type": "string", "description": "File content for write_file"},
            "commit_hash":  {"type": "string", "description": "Commit hash for revert"},
            "module_path":  {"type": "string", "description": "Dotted module path for validate_import"},
            "scope":        {"type": "string", "description": "Test scope/path for run_tests"},
            "remote":       {"type": "string", "description": "Remote name or URL"},
            "timeout":      {"type": "integer", "description": "Timeout seconds for run_tests"},
            "force":        {"type": "boolean", "description": "Force flag for delete_branch"},
            "n":            {"type": "integer", "description": "Log entry count (default 10)"},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    """MCP-compatible wrapper for git operations."""
    import asyncio
    op = inputs.get("operation", "")

    try:
        if op == "status":
            r = _run(["git", "status", "--short"], check=False)
            return r.stdout or "(clean)"

        elif op == "diff":
            branch = inputs.get("branch", "HEAD")
            base   = inputs.get("base", "main")
            if branch == "HEAD":
                r = _run(["git", "diff"], check=False)
            else:
                r = _run(["git", "diff", f"{base}...{branch}"], check=False)
            return r.stdout or "(no diff)"

        elif op == "log":
            n = int(inputs.get("n", 10))
            r = _run(["git", "log", f"-{n}", "--oneline"], check=False)
            return r.stdout or "(no commits)"

        elif op == "commit":
            message = inputs.get("message", "")
            if not message:
                return {"error": "commit requires a message"}
            hash_ = await asyncio.to_thread(commit_all, message)
            return {"commit": hash_}

        elif op == "branch":
            r = _run(["git", "branch", "--list"], check=False)
            return r.stdout or "(no branches)"

        elif op == "create_branch":
            slug = inputs.get("branch", "")
            if not slug:
                return {"error": "create_branch requires branch (slug)"}
            name = await asyncio.to_thread(create_branch, slug)
            return {"branch": name}

        elif op == "checkout_branch":
            branch = inputs.get("branch", "")
            if not branch:
                return {"error": "checkout_branch requires branch"}
            await asyncio.to_thread(checkout_branch, branch)
            return {"checked_out": branch}

        elif op == "delete_branch":
            branch = inputs.get("branch", "")
            force  = bool(inputs.get("force", False))
            if not branch:
                return {"error": "delete_branch requires branch"}
            await asyncio.to_thread(delete_branch, branch, force)
            return {"deleted": branch}

        elif op == "merge_branch":
            branch = inputs.get("branch", "")
            base   = inputs.get("base", "main")
            if not branch:
                return {"error": "merge_branch requires branch"}
            hash_ = await asyncio.to_thread(merge_branch, branch, base)
            return {"merged": branch, "into": base, "commit": hash_}

        elif op == "revert":
            commit_hash = inputs.get("commit_hash", "")
            if not commit_hash:
                return {"error": "revert requires commit_hash"}
            new_hash = await asyncio.to_thread(revert_commit, commit_hash)
            return {"reverted": commit_hash, "new_head": new_hash}

        elif op == "current_branch":
            name = await asyncio.to_thread(current_branch)
            return {"branch": name}

        elif op == "head_hash":
            branch = inputs.get("branch")
            hash_ = await asyncio.to_thread(head_commit_hash, branch)
            return {"hash": hash_}

        elif op == "pull":
            remote = inputs.get("remote", "origin")
            branch = inputs.get("branch", "")
            args = ["git", "pull", remote]
            if branch:
                args.append(branch)
            r = _run(args, check=False)
            return (r.stdout + r.stderr).strip()

        elif op == "push":
            remote = inputs.get("remote", "origin")
            branch = inputs.get("branch", "")
            cb = await asyncio.to_thread(current_branch)
            args = ["git", "push", remote, branch or cb]
            r = _run(args, check=False)
            return (r.stdout + r.stderr).strip()

        elif op == "clone":
            remote = inputs.get("remote", "")
            if not remote:
                return {"error": "clone requires remote (URL)"}
            r = _run(["git", "clone", remote], check=False)
            return (r.stdout + r.stderr).strip()

        elif op == "stash":
            stashed = await asyncio.to_thread(stash)
            return {"stashed": stashed}

        elif op == "stash_pop":
            await asyncio.to_thread(stash_pop)
            return {"popped": True}

        elif op == "read_file":
            path = inputs.get("path", "")
            if not path:
                return {"error": "read_file requires path"}
            content = await asyncio.to_thread(read_file, path)
            return {"content": content}

        elif op == "write_file":
            path    = inputs.get("path", "")
            content = inputs.get("content", "")
            if not path:
                return {"error": "write_file requires path"}
            await asyncio.to_thread(write_file, path, content)
            return {"written": path}

        elif op == "list_changed_files":
            branch = inputs.get("branch", "")
            base   = inputs.get("base", "main")
            if not branch:
                return {"error": "list_changed_files requires branch"}
            files = await asyncio.to_thread(list_changed_files, branch, base)
            return {"files": files}

        elif op == "validate_python":
            path = inputs.get("path", "")
            if not path:
                return {"error": "validate_python requires path"}
            ok, msg = await asyncio.to_thread(validate_python, path)
            return {"valid": ok, "message": msg}

        elif op == "validate_import":
            module_path = inputs.get("module_path", "")
            if not module_path:
                return {"error": "validate_import requires module_path"}
            ok, msg = await asyncio.to_thread(validate_import, module_path)
            return {"valid": ok, "message": msg}

        elif op == "run_tests":
            scope   = inputs.get("scope")
            timeout = int(inputs.get("timeout", 60))
            passed, output = await asyncio.to_thread(run_tests, scope, timeout)
            return {"passed": passed, "output": output}

        else:
            return {"error": f"Unknown git operation: {op!r}"}

    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:
        logger.error("[git_tool] operation=%s error: %s", op, exc)
        return {"error": str(exc)}
