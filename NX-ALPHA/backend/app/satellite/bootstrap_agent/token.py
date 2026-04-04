"""
AURA Bootstrap Agent — Single-use token management.

Tokens are file-backed so they survive process restarts.
Each token is valid for 24 hours and can only be used once.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from pathlib import Path

logger = logging.getLogger(__name__)

TOKEN_FILE = Path("C:/ProgramData/AURA/bootstrap_token.txt")


class TokenExpiredError(Exception):
    pass


class TokenUsedError(Exception):
    pass


class TokenInvalidError(Exception):
    pass


def _ensure_dir() -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)


def generate_token() -> str:
    """Generate a new single-use token. Overwrites any existing token."""
    _ensure_dir()
    token = secrets.token_urlsafe(32)
    data = {
        "token": token,
        "expires": time.time() + 86400,  # 24 hours
        "used": False,
    }
    TOKEN_FILE.write_text(json.dumps(data), encoding="utf-8")
    logger.info("[bootstrap_token] New token generated, expires in 24h")
    return token


def validate_token(token: str) -> bool:
    """
    Validate a token. Returns True on first valid use, marks it used.
    Raises TokenExpiredError, TokenUsedError, or TokenInvalidError on failure.
    """
    if not TOKEN_FILE.exists():
        raise TokenInvalidError("No bootstrap token file found")

    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise TokenInvalidError("Token file corrupt or unreadable")

    if data.get("token") != token:
        raise TokenInvalidError("Token mismatch")

    if time.time() > data.get("expires", 0):
        raise TokenExpiredError("Token has expired")

    if data.get("used"):
        raise TokenUsedError("Token has already been used")

    # Mark as used (single-use)
    data["used"] = True
    try:
        TOKEN_FILE.write_text(json.dumps(data), encoding="utf-8")
    except OSError as exc:
        logger.warning("[bootstrap_token] Could not mark token used: %s", exc)

    return True


def get_or_generate() -> str:
    """Return an existing valid (unused, unexpired) token, or generate a new one."""
    if TOKEN_FILE.exists():
        try:
            data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            if (
                not data.get("used")
                and time.time() < data.get("expires", 0)
                and data.get("token")
            ):
                return data["token"]
        except (json.JSONDecodeError, OSError):
            pass
    return generate_token()
