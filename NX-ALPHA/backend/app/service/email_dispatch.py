"""
AURA NX-Alpha — Email Dispatch Service

Gmail SMTP sending via Google OAuth credentials.
Used by the Scheduler Service to email task results.

SMTP DETAILS:
    Server: smtp.gmail.com:587 (STARTTLS)
    Auth:   OAuth2 access token from existing Google service

Gracefully degrades if Google OAuth is not configured.
"""

import asyncio
import json
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# EMAIL SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class EmailDispatchService:
    """
    Gmail SMTP email dispatch using Google OAuth credentials.

    Falls back gracefully if OAuth is not configured — logs a warning
    and returns False instead of raising.
    """

    SMTP_HOST = "smtp.gmail.com"
    SMTP_PORT = 587

    def __init__(self) -> None:
        self._available = False
        self._check_availability()

    def _check_availability(self) -> None:
        """Check if Google OAuth credentials are available for sending."""
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()
            if svc and svc._credentials_path.exists():
                self._available = True
                logger.info("[email] Email dispatch service available (Google OAuth configured)")
            else:
                logger.info("[email] Email dispatch service unavailable (no Google OAuth credentials)")
        except Exception as exc:
            logger.debug("[email] Email dispatch availability check failed: %s", exc)

    @property
    def available(self) -> bool:
        return self._available

    async def _get_oauth_token(self, account_id: Optional[str] = None) -> Optional[str]:
        """Get a valid OAuth2 access token from the Google service."""
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()
            if not svc:
                return None

            # Load valid credentials (refreshes if needed)
            creds = await asyncio.to_thread(svc._get_valid_creds, account_id)
            if creds and creds.token:
                return creds.token
        except Exception as exc:
            logger.warning("[email] Failed to get OAuth token: %s", exc)
        return None

    async def _get_user_email(self, account_id: Optional[str] = None) -> Optional[str]:
        """Get the authenticated user's email address."""
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()
            if not svc:
                return None

            # Try to get email from token info
            creds = await asyncio.to_thread(svc._get_valid_creds, account_id)
            if creds:
                # Try to extract email from token
                if hasattr(creds, 'id_token') and creds.id_token:
                    return creds.id_token.get('email')
                # Fallback: get profile from Gmail API
                from googleapiclient.discovery import build
                service = build("gmail", "v1", credentials=creds)
                profile = service.users().getProfile(userId="me").execute()
                return profile.get("emailAddress")
        except Exception as exc:
            logger.debug("[email] Failed to get user email: %s", exc)
        return None

    async def send_email(
        self,
        to_list: List[str],
        subject: str,
        body_html: str,
        sender_email: Optional[str] = None,
    ) -> bool:
        """Send an email via Gmail SMTP with OAuth2.

        Parameters
        ----------
        to_list : list[str]
            Recipient email addresses.
        subject : str
            Email subject line.
        body_html : str
            HTML body content.
        sender_email : str, optional
            Sender address. If not provided, uses the authenticated user's email.

        Returns
        -------
        bool
            True if sent successfully, False otherwise.
        """
        if not self._available:
            logger.warning("[email] Email dispatch not available — Google OAuth not configured")
            return False

        if not to_list:
            logger.warning("[email] No recipients specified, skipping email")
            return False

        # Get OAuth token
        token = await self._get_oauth_token()
        if not token:
            logger.warning("[email] No valid OAuth token, cannot send email")
            return False

        # Determine sender
        if not sender_email:
            sender_email = await self._get_user_email()
            if not sender_email:
                logger.warning("[email] Cannot determine sender email")
                return False

        # Build message
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = sender_email
        msg["To"] = ", ".join(to_list)

        # Add HTML body
        msg.attach(MIMEText(body_html, "html"))

        # Send via SMTP in a thread to avoid blocking
        try:
            result = await asyncio.to_thread(
                self._smtp_send, sender_email, to_list, msg, token
            )
            return result
        except Exception as exc:
            logger.error("[email] Failed to send email: %s", exc)
            return False

    def _smtp_send(
        self,
        sender: str,
        recipients: List[str],
        msg: MIMEMultipart,
        oauth_token: str,
    ) -> bool:
        """Synchronous SMTP send with OAuth2 XOAUTH2 auth."""
        try:
            with smtplib.SMTP(self.SMTP_HOST, self.SMTP_PORT) as smtp:
                smtp.ehlo()
                smtp.starttls()
                smtp.ehlo()

                # OAuth2 XOAUTH2 authentication
                # Format: user=<email>\x01auth=Bearer <token>\x01\x01
                auth_string = f"user={sender}\x01auth=Bearer {oauth_token}\x01\x01"
                smtp.docmd("AUTH", "XOAUTH2 " + auth_string)

                smtp.sendmail(sender, recipients, msg.as_string())

            logger.info("[email] Email sent to %d recipients: %s", len(recipients), msg["Subject"])
            return True

        except smtplib.SMTPAuthenticationError as exc:
            logger.error("[email] SMTP auth failed (OAuth token may be expired): %s", exc)
            return False
        except smtplib.SMTPException as exc:
            logger.error("[email] SMTP error: %s", exc)
            return False
        except Exception as exc:
            logger.error("[email] Unexpected send error: %s", exc)
            return False

    # ── HTML Formatting ───────────────────────────────────────────────────────

    @staticmethod
    def format_items_html(title: str, items: list) -> str:
        """Format a list of data items into a styled HTML email body.

        Works with any list of dicts — renders key fields as rows.
        """
        rows = []
        for item in items[:50]:  # Cap at 50 items
            if isinstance(item, dict):
                # Try common field names
                headline = (
                    item.get("title")
                    or item.get("name")
                    or item.get("summary")
                    or item.get("headline")
                    or str(item)[:100]
                )
                detail = (
                    item.get("description")
                    or item.get("source")
                    or item.get("url")
                    or ""
                )
                rows.append(f"""
                <tr>
                    <td style="padding:8px 12px; border-bottom:1px solid #1a2332;">
                        <strong style="color:#e2e8f0;">{_html_escape(str(headline))}</strong>
                        {f'<br><span style="color:#94a3b8; font-size:13px;">{_html_escape(str(detail)[:200])}</span>' if detail else ''}
                    </td>
                </tr>
                """)
            else:
                rows.append(f"""
                <tr>
                    <td style="padding:8px 12px; border-bottom:1px solid #1a2332; color:#e2e8f0;">
                        {_html_escape(str(item)[:200])}
                    </td>
                </tr>
                """)

        table_rows = "\n".join(rows) if rows else "<tr><td style='padding:12px; color:#94a3b8;'>No items</td></tr>"

        return f"""
        <!DOCTYPE html>
        <html>
        <body style="margin:0; padding:0; background:#04080F; font-family: -apple-system, system-ui, sans-serif;">
            <div style="max-width:640px; margin:20px auto; background:#0B1120; border-radius:12px; overflow:hidden; border:1px solid #1a2332;">
                <div style="background:linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding:20px 24px;">
                    <h1 style="margin:0; color:#4ade80; font-size:18px; font-weight:600;">
                        AURA — {_html_escape(title)}
                    </h1>
                    <p style="margin:6px 0 0 0; color:#94a3b8; font-size:13px;">
                        Automated report • {len(items)} item{"s" if len(items) != 1 else ""}
                    </p>
                </div>
                <table style="width:100%; border-collapse:collapse;">
                    {table_rows}
                </table>
                <div style="padding:16px 24px; border-top:1px solid #1a2332; color:#64748b; font-size:12px;">
                    Generated by AURA NX-Alpha Scheduled Tasks Engine
                </div>
            </div>
        </body>
        </html>
        """


def _html_escape(s: str) -> str:
    """Basic HTML escaping."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_email_service: Optional[EmailDispatchService] = None


def init_email_service() -> EmailDispatchService:
    """Initialize and return the EmailDispatchService singleton."""
    global _email_service
    _email_service = EmailDispatchService()
    return _email_service


def get_email_service() -> Optional[EmailDispatchService]:
    """Return the EmailDispatchService singleton, or None."""
    global _email_service
    if _email_service is None:
        try:
            _email_service = EmailDispatchService()
        except Exception as exc:
            logger.debug("[email] Email service init failed: %s", exc)
    return _email_service
