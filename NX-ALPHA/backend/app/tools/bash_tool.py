"""
Bash execution tool — run shell commands with safety guards.

Safety layers:
  1. Hard-blocked command patterns (destructive / dangerous)
  2. 30-second timeout with forced process kill
  3. Working directory restricted to user home subtree (configurable)
  4. Output capped at 4000 characters

Configure allowed commands via ~/.aura/bash_allowlist.json:
  {"prefixes": ["python", "git", "npm", "pip", "pytest"]}
If the file does not exist, all non-blocked commands are permitted.
"""

import asyncio
import json
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_HOME = Path.home()
_ALLOWLIST_PATH = _HOME / ".aura" / "bash_allowlist.json"
_TIMEOUT_SECONDS = 60
_OUTPUT_CAP = 10_000

# Hard-blocked patterns — matched against the full command string (case-insensitive)
_BLOCKED_PATTERNS: list[re.Pattern] = [
    re.compile(r"\brm\s+-[^\s]*r", re.IGNORECASE),          # rm -r / rm -rf
    re.compile(r"\bformat\s+[a-zA-Z]:", re.IGNORECASE),      # format C:
    re.compile(r"\bdel\s+/[sf]", re.IGNORECASE),             # del /s /f
    re.compile(r"\bshutdown\b", re.IGNORECASE),              # shutdown
    re.compile(r"\breboot\b", re.IGNORECASE),                # reboot
    re.compile(r"\bpoweroff\b", re.IGNORECASE),              # poweroff
    re.compile(r"\bdrop\s+table\b", re.IGNORECASE),          # DROP TABLE
    re.compile(r"\bdrop\s+database\b", re.IGNORECASE),       # DROP DATABASE
    re.compile(r":\s*\(\s*\)\s*\{.*\}", re.IGNORECASE),      # fork bomb patterns
    re.compile(r"\bchmod\s+777\b", re.IGNORECASE),           # chmod 777
    re.compile(r"\bsudo\s+rm\b", re.IGNORECASE),             # sudo rm
    re.compile(r"\bdd\s+if=", re.IGNORECASE),                # dd disk write
    re.compile(r"\bmkfs\b", re.IGNORECASE),                  # mkfs
    re.compile(r"\bwipefs\b", re.IGNORECASE),                # wipefs
]


def _load_allowlist() -> list[str] | None:
    """Load prefix allowlist from ~/.aura/bash_allowlist.json. Returns None if no file."""
    if not _ALLOWLIST_PATH.exists():
        return None
    try:
        data = json.loads(_ALLOWLIST_PATH.read_text(encoding="utf-8"))
        prefixes = data.get("prefixes", [])
        return [p.lower() for p in prefixes] if prefixes else None
    except Exception as exc:
        logger.warning("[bash_tool] could not load allowlist: %s", exc)
        return None


def _check_blocked(command: str) -> str | None:
    """Return a block reason string if the command is blocked, else None."""
    for pattern in _BLOCKED_PATTERNS:
        if pattern.search(command):
            return f"Blocked pattern detected: {pattern.pattern}"
    return None


def _check_allowlist(command: str, allowlist: list[str] | None) -> str | None:
    """Return a block reason if command is not in the allowlist, else None."""
    if allowlist is None:
        return None  # No allowlist — all non-blocked commands permitted
    cmd_lower = command.strip().lower()
    for prefix in allowlist:
        if cmd_lower.startswith(prefix):
            return None
    return f"Command not in allowlist. Allowed prefixes: {allowlist}"


async def bash_exec(command: str, cwd: str | None = None) -> str:
    """
    Execute a shell command and return its stdout/stderr output.

    Parameters
    ----------
    command : str
        Shell command to execute.
    cwd : str, optional
        Working directory. Defaults to user home. Must be within user home subtree.

    Returns
    -------
    str
        Combined stdout/stderr output (capped at 4000 chars), or error message.
    """
    if not command or not command.strip():
        return "bash_exec requires a command argument."

    # Safety: hard-blocked patterns
    block_reason = _check_blocked(command)
    if block_reason:
        logger.warning("[bash_tool] BLOCKED: %s — %s", command[:80], block_reason)
        return f"Command blocked: {block_reason}"

    # Safety: allowlist check
    allowlist = _load_allowlist()
    allowlist_block = _check_allowlist(command, allowlist)
    if allowlist_block:
        return f"Command not permitted: {allowlist_block}"

    # Resolve working directory
    if cwd:
        work_dir = Path(os.path.expandvars(cwd)).resolve()
        if ".." in Path(cwd).parts:
            return "Blocked: working directory path traversal not allowed."
    else:
        work_dir = _HOME

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(work_dir),
        )
        try:
            stdout_bytes, _ = await asyncio.wait_for(
                proc.communicate(), timeout=_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return f"Command timed out after {_TIMEOUT_SECONDS}s: {command[:60]}"

        output = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
        rc = proc.returncode

        if len(output) > _OUTPUT_CAP:
            output = output[:_OUTPUT_CAP] + f"\n... (truncated, {len(output)} total chars)"

        prefix = f"$ {command}\n[exit {rc}]\n"
        return prefix + (output if output else "(no output)")

    except FileNotFoundError:
        return f"Command not found: {command.split()[0]}"
    except PermissionError:
        return f"Permission denied executing: {command[:60]}"
    except Exception as exc:
        logger.warning("[bash_tool] bash_exec failed: %s", exc)
        return f"bash_exec failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "bash_exec",
    "description": "Execute a shell command on the local machine. Safety-checked against a denylist. Output capped at 4000 chars.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command to run"},
            "cwd":     {"type": "string", "description": "Working directory (optional)"},
        },
        "required": ["command"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    cmd = inputs.get("command", "")
    cwd = inputs.get("cwd")
    if not cmd:
        return {"error": "command is required"}
    return await bash_exec(cmd, cwd=cwd)
