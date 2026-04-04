"""
AURA NX-Alpha — Legislative Daily Updater

Delta pulls from OpenStates API (50 states) and Congress.gov API (federal).
Detects new bills and changes vs the local legislation DB, writes change events,
and updates leg_sync_state per source.

PUBLIC API:
    await run_daily_update(states=None, emit_fn=None) -> dict
        states: list of 2-letter codes (or 'US') — None = auto from active profiles
        emit_fn: async callable(event_type, data) for SSE progress
        returns: {updated, added, states_processed, errors}
"""

import asyncio
import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Awaitable, Optional

import httpx

from app.service.leg_db_importer import (
    LEG_DB_PATH,
    normalize_status,
    normalize_chamber,
    ensure_monitor_schema,
)

logger = logging.getLogger(__name__)

# ── API config ────────────────────────────────────────────────────────────────

_OPENSTATES_BASE = "https://v3.openstates.org"
_CONGRESS_BASE   = "https://api.congress.gov/v3"

# ── Congress.gov status keyword map ──────────────────────────────────────────

_CONGRESS_STATUS_MAP = {
    "introduced": "active",
    "referred":   "active",
    "reported":   "active",
    "committee":  "active",
    "passed":     "pending",
    "passage":    "pending",
    "enrolled":   "pending",
    "signed":     "passed",
    "enacted":    "passed",
    "became law": "passed",
    "vetoed":     "dropped",
    "failed":     "dropped",
    "withdrawn":  "dropped",
    "tabled":     "dropped",
    "defeated":   "dropped",
}


def _normalize_congress_status(action_text: str) -> str:
    t = action_text.lower()
    for kw, status in _CONGRESS_STATUS_MAP.items():
        if kw in t:
            return status
    return "active"


# ── DB helpers ────────────────────────────────────────────────────────────────

def _write_conn() -> sqlite3.Connection:
    con = sqlite3.connect(str(LEG_DB_PATH), check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA foreign_keys=OFF;")  # speed — we manage integrity ourselves
    return con


def _get_api_keys() -> tuple[str, str]:
    """Return (openstates_key, congress_key) from environment."""
    import os
    openstates = os.environ.get("AURA_KNOWLEDGE__OPENSTATES_API_KEY", "")
    congress   = os.environ.get("AURA_KNOWLEDGE__CONGRESS_API_KEY", "")
    return openstates, congress


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _upsert_session(con: sqlite3.Connection, session_id: str, state_code: str, identifier: str) -> None:
    """Ensure a session row exists (no-op if already present)."""
    con.execute(
        """INSERT OR IGNORE INTO sessions (id, state_code, identifier, is_active)
           VALUES (?, ?, ?, 0)""",
        (session_id, state_code.upper(), identifier),
    )


def _record_change(
    con: sqlite3.Connection,
    bill_id: str,
    change_type: str,
    old_value: Optional[str] = None,
    new_value: Optional[str] = None,
) -> None:
    con.execute(
        """INSERT OR IGNORE INTO bill_change_events
           (id, bill_id, change_type, old_value, new_value, detected_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (uuid.uuid4().hex[:16], bill_id, change_type, old_value, new_value, _now_iso()),
    )


def _update_sync_state(
    con: sqlite3.Connection,
    state_code: str,
    status: str,
    error_msg: str = "",
    bills_added: int = 0,
    bills_updated: int = 0,
) -> None:
    now = _now_iso()
    con.execute(
        """INSERT INTO leg_sync_state
               (state_code, last_run, last_success, status, error_msg, bills_added, bills_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(state_code) DO UPDATE SET
               last_run      = excluded.last_run,
               last_success  = CASE WHEN excluded.status='ok' THEN excluded.last_success ELSE last_success END,
               status        = excluded.status,
               error_msg     = excluded.error_msg,
               bills_added   = excluded.bills_added,
               bills_updated = excluded.bills_updated""",
        (state_code, now, now if status == "ok" else None, status, error_msg, bills_added, bills_updated),
    )
    con.commit()


def _get_last_run(con: sqlite3.Connection, state_code: str) -> Optional[str]:
    row = con.execute(
        "SELECT last_success FROM leg_sync_state WHERE state_code = ?",
        (state_code,),
    ).fetchone()
    if row and row["last_success"]:
        return row["last_success"]
    # Default: 24h ago for first run
    from datetime import timedelta
    return (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()


# ── OpenStates delta pull ────────────────────────────────────────────────────

async def _pull_openstates_state(
    client: httpx.AsyncClient,
    state_code: str,
    api_key: str,
    con: sqlite3.Connection,
    emit_fn,
) -> tuple[int, int]:
    """Pull updated bills for one state from OpenStates v3.
    Returns (bills_added, bills_updated)."""

    last_run = _get_last_run(con, state_code)
    # OpenStates uses lowercase jurisdiction names (e.g. 'oh', 'fl')
    jurisdiction = state_code.lower()

    added = 0
    updated = 0
    page = 1
    max_page = 999

    while page <= max_page:
        params = {
            "jurisdiction":  jurisdiction,
            "updated_since": last_run,
            "sort":          "updated_desc",
            "per_page":      20,
            "page":          page,
        }
        try:
            resp = await client.get(
                f"{_OPENSTATES_BASE}/bills",
                headers={"X-API-KEY": api_key},
                params=params,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.warning("[daily_updater] OpenStates %s page %d error: %s", state_code, page, exc)
            break

        bills = data.get("results", [])
        pagination = data.get("pagination", {})
        max_page = pagination.get("max_page", 1)

        for bill in bills:
            try:
                a, u = _upsert_openstates_bill(con, state_code, bill)
                added += a
                updated += u
            except Exception as exc:
                logger.warning("[daily_updater] Bill upsert error (%s): %s", bill.get("id", "?"), exc)

        if bills:
            con.commit()
            await emit_fn("leg_sync_progress", {
                "state": state_code,
                "pct": min(99, int(page / max(max_page, 1) * 100)),
                "bills_added": added,
                "bills_updated": updated,
            })

        if not bills or page >= max_page:
            break

        page += 1
        await asyncio.sleep(0.2)  # free tier rate limit guard

    return added, updated


def _upsert_openstates_bill(
    con: sqlite3.Connection,
    state_code: str,
    bill: dict,
) -> tuple[int, int]:
    """Insert or update one OpenStates bill. Returns (added, updated)."""

    bill_id = bill.get("id", "")
    if not bill_id:
        return 0, 0

    identifier = bill.get("identifier", "")
    title = bill.get("title", "")

    # Derive session_id
    session = bill.get("session", "") or bill.get("legislative_session", {})
    if isinstance(session, dict):
        session_ident = session.get("identifier", "")
    else:
        session_ident = str(session)
    session_id = f"{state_code.upper()}_{session_ident}"
    _upsert_session(con, session_id, state_code, session_ident)

    # Chamber
    from_org = bill.get("from_organization") or {}
    org_classification = (from_org.get("classification") or "").lower()
    chamber = normalize_chamber(identifier, org_classification)

    # Status from actions list
    actions_raw = bill.get("actions", [])
    actions_for_norm = []
    for a in actions_raw:
        clsf = a.get("classification", [])
        if isinstance(clsf, list):
            clsf_str = str(clsf)
        else:
            clsf_str = str(clsf)
        org = (a.get("organization_classification") or "").lower()
        actions_for_norm.append({
            "date":               a.get("date", ""),
            "classification":     clsf_str,
            "org_classification": org,
        })
    status = normalize_status(actions_for_norm) if actions_for_norm else "active"

    subjects_raw = bill.get("subject", []) or bill.get("subjects", [])
    subjects = json.dumps(subjects_raw) if isinstance(subjects_raw, list) else str(subjects_raw)

    abstract_list = bill.get("abstracts", [])
    abstract = abstract_list[0].get("abstract", "") if abstract_list else ""

    # Last action
    last_action_date = ""
    last_action_text = ""
    if actions_for_norm:
        latest = max(actions_for_norm, key=lambda a: a.get("date", ""))
        last_action_date = latest.get("date", "")
        # get description from original
        for a in actions_raw:
            if a.get("date", "") == last_action_date:
                last_action_text = a.get("description", "")
                break

    # Check existing
    existing = con.execute(
        "SELECT id, status, last_action_date FROM bills WHERE id = ?", (bill_id,)
    ).fetchone()

    if existing:
        old_status = existing["status"]
        old_date = existing["last_action_date"] or ""
        changed = False

        if old_status != status:
            _record_change(con, bill_id, "status_change", old_status, status)
            changed = True
        if last_action_date and last_action_date > old_date:
            _record_change(con, bill_id, "new_action", old_date, last_action_date)
            changed = True

        if changed:
            con.execute(
                """UPDATE bills SET status = ?, last_action = ?, last_action_date = ?,
                          subjects = ?, abstract = ?
                   WHERE id = ?""",
                (status, last_action_text, last_action_date, subjects, abstract, bill_id),
            )
            return 0, 1
        return 0, 0
    else:
        # New bill
        bill_type = ""
        clsf = bill.get("classification", [])
        if clsf:
            bill_type = clsf[0] if isinstance(clsf, list) else str(clsf)

        con.execute(
            """INSERT OR IGNORE INTO bills
               (id, session_id, state_code, identifier, title, bill_type,
                chamber, status, subjects, last_action, last_action_date, abstract)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                bill_id, session_id, state_code.upper(), identifier, title, bill_type,
                chamber, status, subjects, last_action_text, last_action_date, abstract,
            ),
        )
        _record_change(con, bill_id, "new_bill", None, status)

        # Sponsors
        for sp in (bill.get("sponsorships") or []):
            sp_id = f"{bill_id}_sp_{uuid.uuid4().hex[:8]}"
            con.execute(
                """INSERT OR IGNORE INTO bill_sponsors (id, bill_id, name, primary_sponsor)
                   VALUES (?, ?, ?, ?)""",
                (sp_id, bill_id, sp.get("name", ""), 1 if sp.get("primary") else 0),
            )

        # Sources
        for src in (bill.get("sources") or []):
            src_id = f"{bill_id}_src_{uuid.uuid4().hex[:8]}"
            con.execute(
                """INSERT OR IGNORE INTO bill_sources (id, bill_id, url, note)
                   VALUES (?, ?, ?, '')""",
                (src_id, bill_id, src.get("url", "")),
            )

        return 1, 0


# ── Congress.gov delta pull ──────────────────────────────────────────────────

async def _pull_congress(
    client: httpx.AsyncClient,
    api_key: str,
    con: sqlite3.Connection,
    emit_fn,
) -> tuple[int, int]:
    """Pull updated federal bills from Congress.gov v3.
    Returns (bills_added, bills_updated)."""

    last_run = _get_last_run(con, "US")
    added = 0
    updated = 0
    offset = 0
    limit = 250
    total_fetched = 0

    while True:
        params = {
            "fromDateTime": last_run,
            "sort":         "updateDate+desc",
            "limit":        limit,
            "offset":       offset,
            "api_key":      api_key,
        }
        try:
            resp = await client.get(
                f"{_CONGRESS_BASE}/bill",
                params=params,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.warning("[daily_updater] Congress.gov offset %d error: %s", offset, exc)
            break

        bills = data.get("bills", [])
        if not bills:
            break

        for bill in bills:
            try:
                a, u = _upsert_congress_bill(con, bill)
                added += a
                updated += u
            except Exception as exc:
                logger.warning("[daily_updater] Congress bill upsert error: %s", exc)

        total_fetched += len(bills)
        con.commit()
        await emit_fn("leg_sync_progress", {
            "state": "US",
            "pct": min(99, total_fetched // 10),
            "bills_added": added,
            "bills_updated": updated,
        })

        if len(bills) < limit:
            break

        offset += limit
        await asyncio.sleep(0.2)

    return added, updated


def _upsert_congress_bill(con: sqlite3.Connection, bill: dict) -> tuple[int, int]:
    """Insert or update one Congress.gov bill. Returns (added, updated)."""

    congress = bill.get("congress", "")
    bill_type = (bill.get("type") or "").upper()
    number = bill.get("number", "")

    if not (congress and bill_type and number):
        return 0, 0

    bill_id = f"US_{congress}_{bill_type}_{number}"
    session_id = f"US_{congress}"
    identifier = f"{bill_type} {number}"

    _upsert_session(con, session_id, "US", str(congress))

    origin = (bill.get("originChamber") or "").lower()
    chamber = "house" if origin == "house" else "senate"

    latest_action = bill.get("latestAction") or {}
    action_text = latest_action.get("text", "")
    action_date = latest_action.get("actionDate", "")
    status = _normalize_congress_status(action_text)

    title = bill.get("title") or bill.get("shortTitle") or identifier
    subjects = json.dumps(bill.get("subjects", []))

    existing = con.execute(
        "SELECT id, status, last_action_date FROM bills WHERE id = ?", (bill_id,)
    ).fetchone()

    if existing:
        old_status = existing["status"]
        old_date = existing["last_action_date"] or ""
        changed = False

        if old_status != status:
            _record_change(con, bill_id, "status_change", old_status, status)
            changed = True
        if action_date and action_date > old_date:
            _record_change(con, bill_id, "new_action", old_date, action_date)
            changed = True

        if changed:
            con.execute(
                "UPDATE bills SET status = ?, last_action = ?, last_action_date = ? WHERE id = ?",
                (status, action_text, action_date, bill_id),
            )
            return 0, 1
        return 0, 0
    else:
        con.execute(
            """INSERT OR IGNORE INTO bills
               (id, session_id, state_code, identifier, title, bill_type,
                chamber, status, subjects, last_action, last_action_date, abstract)
               VALUES (?, ?, 'US', ?, ?, ?, ?, ?, ?, ?, ?, '')""",
            (
                bill_id, session_id, identifier, title,
                bill_type.lower(), chamber, status, subjects,
                action_text, action_date,
            ),
        )
        _record_change(con, bill_id, "new_bill", None, status)
        return 1, 0


# ── Active-profile state resolver ────────────────────────────────────────────

def _get_profile_states(con: sqlite3.Connection) -> list[str]:
    """Return all state_codes tracked by at least one active profile."""
    rows = con.execute(
        """SELECT DISTINCT ps.state_code
           FROM profile_states ps
           JOIN monitoring_profiles mp ON ps.profile_id = mp.id
           WHERE mp.active = 1""",
    ).fetchall()
    return [r["state_code"] for r in rows]


# ── Main entry point ─────────────────────────────────────────────────────────

async def run_daily_update(
    states: Optional[list[str]] = None,
    emit_fn=None,
) -> dict:
    """
    Run delta pulls for given states (or all states in active profiles if None).
    Returns {updated, added, states_processed, errors}.
    """
    if not LEG_DB_PATH.exists():
        return {"updated": 0, "added": 0, "states_processed": [], "errors": ["Legislation DB not found"]}

    openstates_key, congress_key = _get_api_keys()

    async def _noop_emit(event_type: str, data: dict) -> None:
        pass

    _emit = emit_fn or _noop_emit

    con = _write_conn()
    ensure_monitor_schema(con)

    # Determine which states to process
    if states is None:
        states = _get_profile_states(con)
        if not states:
            # Fallback: sync a small default set so the system has something
            states = ["US"]

    total_added = 0
    total_updated = 0
    states_processed: list[str] = []
    errors: list[str] = []

    async with httpx.AsyncClient() as client:
        for state_code in states:
            sc = state_code.upper()
            try:
                _update_sync_state(con, sc, "running")

                if sc == "US":
                    if not congress_key:
                        raise RuntimeError("AURA_KNOWLEDGE__CONGRESS_API_KEY not set")
                    added, updated = await _pull_congress(client, congress_key, con, _emit)
                else:
                    if not openstates_key:
                        raise RuntimeError("AURA_KNOWLEDGE__OPENSTATES_API_KEY not set")
                    added, updated = await _pull_openstates_state(
                        client, sc, openstates_key, con, _emit
                    )

                _update_sync_state(con, sc, "ok", bills_added=added, bills_updated=updated)
                total_added += added
                total_updated += updated
                states_processed.append(sc)

                await _emit("leg_sync_progress", {
                    "state": sc,
                    "pct": 100,
                    "bills_added": added,
                    "bills_updated": updated,
                    "done": True,
                })

            except Exception as exc:
                msg = str(exc)
                logger.error("[daily_updater] State %s failed: %s", sc, msg)
                _update_sync_state(con, sc, "error", error_msg=msg[:500])
                errors.append(f"{sc}: {msg[:100]}")

    con.close()

    logger.info(
        "[daily_updater] Done — added=%d updated=%d states=%s errors=%d",
        total_added, total_updated, states_processed, len(errors),
    )
    return {
        "updated":          total_updated,
        "added":            total_added,
        "states_processed": states_processed,
        "errors":           errors,
    }
