"""
Google OAuth service for Calendar and Gmail (read-only).

Handles OAuth2 flow, token storage, and async-wrapped API calls for
Google Calendar and Gmail via the google-api-python-client library.

MULTI-ACCOUNT SUPPORT (Sprint 1+):
    Multiple Google accounts can be connected. Each account is stored
    separately with an account_id: ~/.aura/google_token_{account_id}.json
    The active account is tracked via ~/.aura/google_active_account.txt
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# OAuth2 scopes — read-only for calendar, gmail, and drive
SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    # Drive — read + write (needed for google_workspace tool: Docs, Sheets, Drive)
    # NOTE: Adding write scopes requires re-auth via Settings → Google Connect.
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]

# Default paths under ~/.aura/
_DEFAULT_CREDENTIALS_PATH = Path.home() / ".aura" / "google_credentials.json"
_GOOGLE_TOKENS_DIR = Path.home() / ".aura" / "google_tokens"
_ACTIVE_ACCOUNT_FILE = Path.home() / ".aura" / "google_active_account.txt"
_REDIRECT_URI = "http://localhost:8000/data/google/callback"

# Stored mid-flight Flow so the callback endpoint can exchange the code
_pending_flow = None
_pending_flow_account_id = None


class GoogleService:
    """
    Async wrapper around the Google Calendar and Gmail APIs.

    MULTI-ACCOUNT SUPPORT:
        - Each account is identified by account_id (email hash or user-defined string)
        - Tokens stored as: ~/.aura/google_tokens/{account_id}/token.json
        - Active account tracked in: ~/.aura/google_active_account.txt
        - All methods accept optional account_id parameter (defaults to active account)

    Authentication uses OAuth2 with credentials stored on disk.  All
    Google API calls are synchronous under the hood; they are dispatched
    via asyncio.to_thread so they never block the event loop.
    """

    def __init__(self, credentials_path: Optional[str] = None) -> None:
        self._credentials_path = Path(credentials_path) if credentials_path else _DEFAULT_CREDENTIALS_PATH
        self._tokens_dir = _GOOGLE_TOKENS_DIR
        self._active_account_file = _ACTIVE_ACCOUNT_FILE
        self._creds = None  # google.oauth2.credentials.Credentials
        self._current_account_id: Optional[str] = None

    # ------------------------------------------------------------------
    # Account Management
    # ------------------------------------------------------------------

    def _get_active_account_id(self) -> Optional[str]:
        """Return the currently active account_id, or None."""
        try:
            if self._active_account_file.exists():
                return self._active_account_file.read_text(encoding="utf-8").strip()
        except Exception:
            pass
        return None

    def _set_active_account_id(self, account_id: str) -> None:
        """Set the active account_id."""
        try:
            self._active_account_file.parent.mkdir(parents=True, exist_ok=True)
            self._active_account_file.write_text(account_id, encoding="utf-8")
            logger.info("Active Google account set to: %s", account_id)
        except Exception as exc:
            logger.warning("Failed to set active account: %s", exc)

    def _get_token_path(self, account_id: Optional[str] = None) -> Path:
        """Get the token file path for a specific account."""
        if account_id is None:
            account_id = self._get_active_account_id()
        if account_id is None:
            account_id = "default"
        return self._tokens_dir / account_id / "token.json"

    def _get_metadata_path(self, account_id: Optional[str] = None) -> Path:
        """Get the metadata file path for account info (email, display name, etc)."""
        if account_id is None:
            account_id = self._get_active_account_id()
        if account_id is None:
            account_id = "default"
        return self._tokens_dir / account_id / "metadata.json"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_creds(self, account_id: Optional[str] = None):
        """
        Load credentials from token.json for the specified account.

        Returns a Credentials object or None.
        """
        try:
            from google.oauth2.credentials import Credentials

            token_path = self._get_token_path(account_id)
            if token_path.exists():
                creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
                return creds
        except Exception as exc:
            logger.warning("Failed to load Google token: %s", exc)
        return None

    def _refresh_if_needed(self, creds, account_id: Optional[str] = None):
        """Refresh expired credentials in place using google-auth."""
        try:
            from google.auth.transport.requests import Request

            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
                self._save_token(creds, account_id)
        except Exception as exc:
            logger.warning("Failed to refresh Google token: %s", exc)

    def _save_token(self, creds, account_id: Optional[str] = None) -> None:
        """Persist credentials to account-specific token.json."""
        try:
            token_path = self._get_token_path(account_id)
            token_path.parent.mkdir(parents=True, exist_ok=True)
            token_path.write_text(creds.to_json())
            logger.debug("Google token saved to %s", token_path)
        except Exception as exc:
            logger.warning("Failed to save Google token: %s", exc)

    def _save_account_metadata(self, account_id: str, email: str, display_name: str = "") -> None:
        """Save account metadata (email, display name, etc)."""
        try:
            metadata_path = self._get_metadata_path(account_id)
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata = {
                "email": email,
                "display_name": display_name,
                "added_at": datetime.now(timezone.utc).isoformat(),
            }
            metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to save account metadata: %s", exc)

    def _get_valid_creds(self, account_id: Optional[str] = None):
        """
        Return valid credentials or None.

        Loads from disk and attempts a refresh if expired.
        """
        creds = self._load_creds(account_id)
        if creds:
            self._refresh_if_needed(creds, account_id)
            if creds and creds.valid:
                return creds
        return None

    # ------------------------------------------------------------------
    # Public API — authentication
    # ------------------------------------------------------------------

    async def is_authenticated(self, account_id: Optional[str] = None) -> bool:
        """
        Return True if a valid (non-expired) token exists for the account.

        Does not make any network requests beyond a token refresh if needed.
        If account_id is None, checks the active account.
        """
        creds = await asyncio.to_thread(self._get_valid_creds, account_id)
        return creds is not None

    async def get_auth_url(self, account_id: Optional[str] = None) -> tuple[str, str]:
        """
        Generate an OAuth2 authorization URL and store the Flow for the callback.
        The backend listens at _REDIRECT_URI and exchanges the code automatically.

        Returns:
            (auth_url, account_id) — the URL to visit and the account ID being authed.
        """
        global _pending_flow, _pending_flow_account_id

        def _build_url() -> tuple:
            from google_auth_oauthlib.flow import Flow

            if not self._credentials_path.exists():
                raise FileNotFoundError(
                    f"Google credentials file not found: {self._credentials_path}"
                )
            flow = Flow.from_client_secrets_file(
                str(self._credentials_path),
                scopes=SCOPES,
                redirect_uri=_REDIRECT_URI,
            )
            auth_url, _ = flow.authorization_url(
                access_type="offline",
                include_granted_scopes="true",
                prompt="consent",
                state=account_id or "default",
            )
            return flow, auth_url

        try:
            flow, url = await asyncio.to_thread(_build_url)
            _pending_flow = flow
            _pending_flow_account_id = account_id
            logger.info("Google OAuth URL generated (account_id: %s, redirect: %s)", account_id, _REDIRECT_URI)
            return url, account_id or ""
        except Exception as exc:
            logger.error("Failed to build Google auth URL: %s", exc)
            raise

    async def handle_callback(self, code: str, account_id: Optional[str] = None) -> bool:
        """
        Exchange the authorization code from the OAuth callback.
        Uses the stored pending flow created by get_auth_url().
        Falls back to building a fresh flow if no pending flow exists.

        If account_id is None, uses the one from get_auth_url(); if still None, uses "default".
        """
        global _pending_flow, _pending_flow_account_id

        def _exchange(flow, acct_id: str) -> bool:
            flow.fetch_token(code=code)
            self._save_token(flow.credentials, acct_id)
            # Extract email from creds if available
            try:
                creds = flow.credentials
                if hasattr(creds, 'id_token'):
                    email = creds.id_token.get("email", "unknown")
                else:
                    email = "unknown"
            except Exception:
                email = "unknown"
            self._save_account_metadata(acct_id, email)
            self._set_active_account_id(acct_id)
            return True

        def _exchange_fresh(acct_id: str) -> bool:
            from google_auth_oauthlib.flow import Flow
            if not self._credentials_path.exists():
                logger.error("Credentials file missing: %s", self._credentials_path)
                return False
            flow = Flow.from_client_secrets_file(
                str(self._credentials_path),
                scopes=SCOPES,
                redirect_uri=_REDIRECT_URI,
            )
            flow.fetch_token(code=code)
            self._save_token(flow.credentials, acct_id)
            try:
                creds = flow.credentials
                if hasattr(creds, 'id_token'):
                    email = creds.id_token.get("email", "unknown")
                else:
                    email = "unknown"
            except Exception:
                email = "unknown"
            self._save_account_metadata(acct_id, email)
            self._set_active_account_id(acct_id)
            return True

        try:
            # Determine which account_id to use
            if account_id is None:
                account_id = _pending_flow_account_id
            if account_id is None:
                account_id = "default"

            if _pending_flow is not None:
                flow = _pending_flow
                _pending_flow = None
                _pending_flow_account_id = None
                result = await asyncio.to_thread(_exchange, flow, account_id)
            else:
                result = await asyncio.to_thread(_exchange_fresh, account_id)
            if result:
                logger.info("Google OAuth tokens exchanged and saved for account: %s", account_id)
            return result
        except Exception as exc:
            logger.error("Failed to exchange Google auth code: %s", exc)
            return False

    async def exchange_code(self, code: str, account_id: Optional[str] = None) -> bool:
        """Alias for handle_callback — kept for API compatibility."""
        return await self.handle_callback(code, account_id)

    async def list_accounts(self) -> list[dict]:
        """
        Return list of all connected accounts with their metadata.

        Returns:
            [{"account_id": "...", "email": "...", "display_name": "...", "is_active": bool}, ...]
        """
        accounts = []
        active_id = self._get_active_account_id()
        try:
            if self._tokens_dir.exists():
                for account_dir in self._tokens_dir.iterdir():
                    if account_dir.is_dir():
                        account_id = account_dir.name
                        metadata_path = self._get_metadata_path(account_id)
                        metadata = {}
                        try:
                            if metadata_path.exists():
                                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                        except Exception:
                            pass
                        accounts.append({
                            "account_id": account_id,
                            "email": metadata.get("email", "unknown"),
                            "display_name": metadata.get("display_name", ""),
                            "is_active": account_id == active_id,
                        })
        except Exception as exc:
            logger.warning("Failed to list accounts: %s", exc)
        return accounts

    async def set_active_account(self, account_id: str) -> bool:
        """Set the active account. Returns True if successful."""
        # Verify the account exists
        token_path = self._get_token_path(account_id)
        if not token_path.exists():
            logger.warning("Cannot set active account: %s does not exist", account_id)
            return False
        self._set_active_account_id(account_id)
        return True

    async def remove_account(self, account_id: str) -> bool:
        """Remove an account and all its tokens. Returns True if successful."""
        try:
            account_dir = self._tokens_dir / account_id
            if account_dir.exists():
                import shutil
                shutil.rmtree(account_dir)
                logger.info("Removed Google account: %s", account_id)
                # If removing active account, switch to default if it exists
                if self._get_active_account_id() == account_id:
                    default_path = self._tokens_dir / "default" / "token.json"
                    if default_path.exists():
                        self._set_active_account_id("default")
                    else:
                        self._active_account_file.unlink(missing_ok=True)
                return True
        except Exception as exc:
            logger.warning("Failed to remove account %s: %s", account_id, exc)
        return False

    # ------------------------------------------------------------------
    # Public API — Calendar
    # ------------------------------------------------------------------

    async def get_calendar_events(self, days_ahead: int = 14, account_id: Optional[str] = None) -> list[dict]:
        """
        Fetch upcoming events from the user's primary Google Calendar.

        Parameters
        ----------
        days_ahead:
            How many days into the future to retrieve events (default 14).
        account_id:
            Which account to fetch from. If None, uses active account.

        Returns
        -------
        list[dict]
            Each item contains: id, title, start, end, location,
            description, all_day.  Returns [] if not authenticated.
        """
        creds = await asyncio.to_thread(self._get_valid_creds, account_id)
        if not creds:
            logger.info("Google not authenticated (account %s) — skipping calendar fetch", account_id or "active")
            return []

        def _fetch() -> list[dict]:
            from googleapiclient.discovery import build
            from datetime import timedelta

            service = build("calendar", "v3", credentials=creds, cache_discovery=False)

            now = datetime.now(timezone.utc)
            time_max = now + timedelta(days=days_ahead)

            result = (
                service.events()
                .list(
                    calendarId="primary",
                    timeMin=now.isoformat(),
                    timeMax=time_max.isoformat(),
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=250,
                )
                .execute()
            )

            events = []
            for item in result.get("items", []):
                start_raw = item.get("start", {})
                end_raw = item.get("end", {})
                all_day = "date" in start_raw and "dateTime" not in start_raw
                events.append(
                    {
                        "id": item.get("id", ""),
                        "title": item.get("summary", "(No title)"),
                        "start": start_raw.get("dateTime") or start_raw.get("date", ""),
                        "end": end_raw.get("dateTime") or end_raw.get("date", ""),
                        "location": item.get("location", ""),
                        "description": item.get("description", ""),
                        "all_day": all_day,
                    }
                )
            return events

        try:
            events = await asyncio.to_thread(_fetch)
            logger.info("Fetched %d calendar events", len(events))
            return events
        except Exception as exc:
            logger.error("Failed to fetch calendar events: %s", exc)
            return []

    # ------------------------------------------------------------------
    # Public API — Gmail
    # ------------------------------------------------------------------

    async def get_inbox(self, max_results: int = 20, account_id: Optional[str] = None) -> list[dict]:
        """
        Fetch recent messages from the Gmail inbox.

        Parameters
        ----------
        max_results:
            Maximum number of messages to return (default 20).
        account_id:
            Which account to fetch from. If None, uses active account.

        Returns
        -------
        list[dict]
            Each item contains: id, thread_id, subject, from_, date,
            snippet, unread.  Returns [] if not authenticated.
        """
        creds = await asyncio.to_thread(self._get_valid_creds, account_id)
        if not creds:
            logger.info("Google not authenticated (account %s) — skipping inbox fetch", account_id or "active")
            return []

        def _fetch() -> list[dict]:
            from googleapiclient.discovery import build

            service = build("gmail", "v1", credentials=creds, cache_discovery=False)

            list_result = (
                service.users()
                .messages()
                .list(userId="me", labelIds=["INBOX"], maxResults=max_results)
                .execute()
            )

            messages = []
            for msg_stub in list_result.get("messages", []):
                msg = (
                    service.users()
                    .messages()
                    .get(userId="me", id=msg_stub["id"], format="metadata",
                         metadataHeaders=["Subject", "From", "Date"])
                    .execute()
                )

                headers = {
                    h["name"]: h["value"]
                    for h in msg.get("payload", {}).get("headers", [])
                }
                label_ids = msg.get("labelIds", [])
                messages.append(
                    {
                        "id": msg.get("id", ""),
                        "thread_id": msg.get("threadId", ""),
                        "subject": headers.get("Subject", "(No subject)"),
                        "from_": headers.get("From", ""),
                        "date": headers.get("Date", ""),
                        "snippet": msg.get("snippet", ""),
                        "unread": "UNREAD" in label_ids,
                    }
                )
            return messages

        try:
            msgs = await asyncio.to_thread(_fetch)
            logger.info("Fetched %d inbox messages", len(msgs))
            return msgs
        except Exception as exc:
            logger.error("Failed to fetch inbox: %s", exc)
            return []

    async def get_message(self, message_id: str, account_id: Optional[str] = None) -> dict:
        """
        Fetch the full body of a Gmail message.

        Parameters
        ----------
        message_id:
            The Gmail message ID.
        account_id:
            Which account to fetch from. If None, uses active account.

        Returns
        -------
        dict
            Contains id, thread_id, subject, from_, date, body (plain text
            decoded), snippet.  Returns {} if not authenticated or on error.
        """
        creds = await asyncio.to_thread(self._get_valid_creds, account_id)
        if not creds:
            logger.info("Google not authenticated (account %s) — skipping message fetch", account_id or "active")
            return {}

        def _fetch() -> dict:
            import base64
            from googleapiclient.discovery import build

            service = build("gmail", "v1", credentials=creds, cache_discovery=False)
            msg = (
                service.users()
                .messages()
                .get(userId="me", id=message_id, format="full")
                .execute()
            )

            headers = {
                h["name"]: h["value"]
                for h in msg.get("payload", {}).get("headers", [])
            }

            # Extract plain-text body recursively
            def _get_body(payload: dict) -> str:
                mime = payload.get("mimeType", "")
                if mime == "text/plain":
                    data = payload.get("body", {}).get("data", "")
                    if data:
                        return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
                for part in payload.get("parts", []):
                    result = _get_body(part)
                    if result:
                        return result
                return ""

            body = _get_body(msg.get("payload", {}))

            return {
                "id": msg.get("id", ""),
                "thread_id": msg.get("threadId", ""),
                "subject": headers.get("Subject", "(No subject)"),
                "from_": headers.get("From", ""),
                "date": headers.get("Date", ""),
                "snippet": msg.get("snippet", ""),
                "body": body,
            }

        try:
            result = await asyncio.to_thread(_fetch)
            logger.debug("Fetched full message %s", message_id)
            return result
        except Exception as exc:
            logger.error("Failed to fetch message %s: %s", message_id, exc)
            return {}


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_google_service: Optional[GoogleService] = None


def init_google_service(credentials_path: Optional[str] = None) -> GoogleService:
    """
    Initialize and return the GoogleService singleton.

    Parameters
    ----------
    credentials_path:
        Optional path to google_credentials.json.  Defaults to
        ~/.aura/google_credentials.json.
    """
    global _google_service
    _google_service = GoogleService(credentials_path=credentials_path)
    logger.info("GoogleService initialized (credentials: %s)", _google_service._credentials_path)
    return _google_service


def get_google_service() -> GoogleService:
    """
    Return the GoogleService singleton, initializing with defaults if needed.
    """
    global _google_service
    if _google_service is None:
        _google_service = GoogleService()
    return _google_service
