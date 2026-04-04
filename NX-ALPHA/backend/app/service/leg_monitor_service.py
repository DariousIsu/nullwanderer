"""
AURA NX-Alpha — Legislative Monitor Service

Personal monitoring profiles: per-person topic+state watchlists.
After each daily update, runs a match pass to find new/changed bills
matching each profile's keywords and generates profile_alerts.

PUBLIC API:
    get_monitor_service() → LegMonitorService
    svc.create_profile(name, description) → dict
    svc.list_profiles() → list[dict]
    svc.get_profile(profile_id) → dict | None
    svc.delete_profile(profile_id) → bool
    svc.add_topic(profile_id, topic_name, keywords) → dict
    svc.remove_topic(topic_id) → bool
    svc.update_topic_keywords(topic_id, keywords) → bool
    svc.add_state(profile_id, state_code) → bool
    svc.remove_state(profile_id, state_code) → bool
    svc.run_match_pass(profile_id=None, since=None) → dict
    svc.get_undelivered_alerts(profile_id) → list[dict]
    svc.mark_alerts_delivered(alert_ids, report_id) → None
    svc.get_profile_summary(profile_id) → dict
    svc.get_sync_status() → list[dict]
"""

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Optional

from app.service.leg_db_importer import LEG_DB_PATH, ensure_monitor_schema

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid() -> str:
    return uuid.uuid4().hex[:12]


class LegMonitorService:
    """Profile CRUD, keyword match pass, and alert management."""

    def __init__(self) -> None:
        self._db_path = LEG_DB_PATH
        self._conn: Optional[sqlite3.Connection] = None
        if self._db_path.exists():
            self._ensure_schema()

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is not None:
            try:
                self._conn.execute("SELECT 1")
                return self._conn
            except Exception:
                self._conn = None
        con = sqlite3.connect(str(self._db_path), check_same_thread=False)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL;")
        self._conn = con
        return con

    def _ensure_schema(self) -> None:
        con = self._get_conn()
        ensure_monitor_schema(con)

    def _available(self) -> bool:
        return self._db_path.exists()

    # ── Profile CRUD ──────────────────────────────────────────────────────────

    def create_profile(self, name: str, description: str = "") -> dict:
        if not self._available():
            raise RuntimeError("Legislation DB not available")
        self._ensure_schema()
        con = self._get_conn()
        pid = _uid()
        now = _now_iso()
        con.execute(
            """INSERT INTO monitoring_profiles (id, name, description, active, created_at)
               VALUES (?, ?, ?, 1, ?)""",
            (pid, name.strip(), description.strip(), now),
        )
        con.commit()
        logger.info("[monitor] Created profile %s — %s", pid, name)
        return self.get_profile(pid)

    def list_profiles(self) -> list[dict]:
        if not self._available():
            return []
        self._ensure_schema()
        con = self._get_conn()
        rows = con.execute(
            "SELECT * FROM monitoring_profiles ORDER BY created_at DESC"
        ).fetchall()
        profiles = []
        for row in rows:
            p = dict(row)
            p["topics"] = self._get_topics(p["id"])
            p["states"] = self._get_states(p["id"])
            profiles.append(p)
        return profiles

    def get_profile(self, profile_id: str) -> Optional[dict]:
        if not self._available():
            return None
        self._ensure_schema()
        con = self._get_conn()
        # Allow lookup by name as well
        row = con.execute(
            "SELECT * FROM monitoring_profiles WHERE id = ? OR LOWER(name) = LOWER(?)",
            (profile_id, profile_id),
        ).fetchone()
        if not row:
            return None
        p = dict(row)
        p["topics"] = self._get_topics(p["id"])
        p["states"] = self._get_states(p["id"])
        return p

    def delete_profile(self, profile_id: str) -> bool:
        if not self._available():
            return False
        con = self._get_conn()
        # Cascade: remove topics, states, matches, alerts
        con.execute("DELETE FROM profile_alerts WHERE profile_id = ?", (profile_id,))
        con.execute("DELETE FROM profile_bill_matches WHERE profile_id = ?", (profile_id,))
        con.execute("DELETE FROM profile_states WHERE profile_id = ?", (profile_id,))
        con.execute("DELETE FROM profile_topics WHERE profile_id = ?", (profile_id,))
        result = con.execute(
            "DELETE FROM monitoring_profiles WHERE id = ?", (profile_id,)
        )
        con.commit()
        return result.rowcount > 0

    def _get_topics(self, profile_id: str) -> list[dict]:
        con = self._get_conn()
        rows = con.execute(
            "SELECT * FROM profile_topics WHERE profile_id = ?", (profile_id,)
        ).fetchall()
        result = []
        for r in rows:
            t = dict(r)
            try:
                t["keywords"] = json.loads(t["keywords"])
            except Exception:
                t["keywords"] = [t["keywords"]]
            result.append(t)
        return result

    def _get_states(self, profile_id: str) -> list[str]:
        con = self._get_conn()
        rows = con.execute(
            "SELECT state_code FROM profile_states WHERE profile_id = ?", (profile_id,)
        ).fetchall()
        return [r["state_code"] for r in rows]

    # ── Topic management ──────────────────────────────────────────────────────

    def add_topic(self, profile_id: str, topic_name: str, keywords: list[str]) -> dict:
        if not self._available():
            raise RuntimeError("Legislation DB not available")
        con = self._get_conn()
        tid = _uid()
        con.execute(
            """INSERT INTO profile_topics (id, profile_id, topic_name, keywords)
               VALUES (?, ?, ?, ?)""",
            (tid, profile_id, topic_name.strip(), json.dumps([k.strip() for k in keywords if k.strip()])),
        )
        con.commit()
        return {"id": tid, "profile_id": profile_id, "topic_name": topic_name, "keywords": keywords}

    def remove_topic(self, topic_id: str) -> bool:
        if not self._available():
            return False
        con = self._get_conn()
        # Also remove matches for this topic
        con.execute("DELETE FROM profile_bill_matches WHERE topic_id = ?", (topic_id,))
        result = con.execute("DELETE FROM profile_topics WHERE id = ?", (topic_id,))
        con.commit()
        return result.rowcount > 0

    def update_topic_keywords(self, topic_id: str, keywords: list[str]) -> bool:
        if not self._available():
            return False
        con = self._get_conn()
        result = con.execute(
            "UPDATE profile_topics SET keywords = ? WHERE id = ?",
            (json.dumps([k.strip() for k in keywords if k.strip()]), topic_id),
        )
        con.commit()
        return result.rowcount > 0

    # ── State management ──────────────────────────────────────────────────────

    def add_state(self, profile_id: str, state_code: str) -> bool:
        if not self._available():
            return False
        con = self._get_conn()
        # Idempotent
        existing = con.execute(
            "SELECT id FROM profile_states WHERE profile_id = ? AND state_code = ?",
            (profile_id, state_code.upper()),
        ).fetchone()
        if existing:
            return True
        sid = _uid()
        con.execute(
            "INSERT INTO profile_states (id, profile_id, state_code) VALUES (?, ?, ?)",
            (sid, profile_id, state_code.upper()),
        )
        con.commit()
        return True

    def remove_state(self, profile_id: str, state_code: str) -> bool:
        if not self._available():
            return False
        con = self._get_conn()
        result = con.execute(
            "DELETE FROM profile_states WHERE profile_id = ? AND state_code = ?",
            (profile_id, state_code.upper()),
        )
        con.commit()
        return result.rowcount > 0

    # ── Match pass ────────────────────────────────────────────────────────────

    def run_match_pass(
        self,
        profile_id: Optional[str] = None,
        since: Optional[str] = None,
    ) -> dict:
        """
        For each profile (or a specific one): check bill_change_events since
        last match pass, test changed bills against each topic's keywords,
        write profile_bill_matches and profile_alerts.

        Returns {alerts_created, new_matches}.
        """
        if not self._available():
            return {"alerts_created": 0, "new_matches": 0}

        self._ensure_schema()
        con = self._get_conn()

        # Determine cutoff timestamp
        if since is None:
            # Use earliest unmatched change event time as default
            row = con.execute(
                "SELECT MIN(detected_at) FROM bill_change_events"
            ).fetchone()
            since = (row[0] or "1970-01-01T00:00:00+00:00")

        # Get profiles to process
        if profile_id:
            profiles = [self.get_profile(profile_id)]
            profiles = [p for p in profiles if p]
        else:
            profiles = self.list_profiles()

        total_alerts = 0
        total_matches = 0

        for profile in profiles:
            pid = profile["id"]
            topics = profile["topics"]
            states = profile["states"]

            if not topics or not states:
                continue

            # Get changed bill IDs in this profile's states since cutoff
            state_placeholders = ",".join("?" * len(states))
            changed_rows = con.execute(
                f"""SELECT DISTINCT bce.bill_id, bce.change_type, bce.old_value, bce.new_value
                    FROM bill_change_events bce
                    JOIN bills b ON bce.bill_id = b.id
                    WHERE bce.detected_at >= ?
                      AND b.state_code IN ({state_placeholders})""",
                [since, *states],
            ).fetchall()

            if not changed_rows:
                continue

            # Load changed bill details
            changed_bill_ids = list({r["bill_id"] for r in changed_rows})
            id_placeholders = ",".join("?" * len(changed_bill_ids))
            bill_rows = con.execute(
                f"SELECT id, identifier, title, subjects, abstract, state_code, chamber, status, last_action_date FROM bills WHERE id IN ({id_placeholders})",
                changed_bill_ids,
            ).fetchall()

            bills_by_id = {r["id"]: dict(r) for r in bill_rows}

            # For each topic, test each changed bill
            for topic in topics:
                tid = topic["id"]
                keywords = [k.lower() for k in topic.get("keywords", []) if k.strip()]
                if not keywords:
                    continue

                for bill_id, bill in bills_by_id.items():
                    if bill.get("state_code") not in states:
                        continue

                    # Python-side keyword match
                    haystack = " ".join([
                        bill.get("title", ""),
                        bill.get("subjects", ""),
                        bill.get("abstract", ""),
                        bill.get("identifier", ""),
                    ]).lower()

                    matched_kw = next((kw for kw in keywords if kw in haystack), None)
                    if not matched_kw:
                        continue

                    # Check if already matched
                    existing_match = con.execute(
                        "SELECT id FROM profile_bill_matches WHERE profile_id = ? AND topic_id = ? AND bill_id = ?",
                        (pid, tid, bill_id),
                    ).fetchone()

                    # Determine alert type from change_events for this bill
                    change_types = {r["change_type"] for r in changed_rows if r["bill_id"] == bill_id}

                    if not existing_match:
                        # New match
                        mid = _uid()
                        con.execute(
                            """INSERT OR IGNORE INTO profile_bill_matches
                               (id, profile_id, topic_id, bill_id, first_matched, active)
                               VALUES (?, ?, ?, ?, ?, 1)""",
                            (mid, pid, tid, bill_id, _now_iso()),
                        )
                        total_matches += 1

                        alert_type = "new_bill"
                        summary = f"New bill matching '{topic['topic_name']}': {bill.get('identifier', '')} — {bill.get('title', '')[:120]}"
                        alert_id = _uid()
                        con.execute(
                            """INSERT OR IGNORE INTO profile_alerts
                               (id, profile_id, topic_id, bill_id, alert_type, summary, detected_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)""",
                            (alert_id, pid, tid, bill_id, alert_type, summary, _now_iso()),
                        )
                        total_alerts += 1

                    else:
                        # Existing match — check for status/action changes
                        for change_type in change_types:
                            if change_type in ("status_change", "new_action"):
                                # Avoid duplicate alerts for same bill+type
                                dup = con.execute(
                                    """SELECT id FROM profile_alerts
                                       WHERE profile_id = ? AND bill_id = ? AND alert_type = ?
                                         AND included_in_report IS NULL""",
                                    (pid, bill_id, change_type),
                                ).fetchone()
                                if not dup:
                                    change_row = next(
                                        (r for r in changed_rows
                                         if r["bill_id"] == bill_id and r["change_type"] == change_type),
                                        None,
                                    )
                                    if change_type == "status_change" and change_row:
                                        summary = (
                                            f"{bill.get('identifier', '')} status changed: "
                                            f"{change_row['old_value']} → {change_row['new_value']}"
                                        )
                                    else:
                                        summary = (
                                            f"New action on {bill.get('identifier', '')}: "
                                            f"{bill.get('last_action_date', '')}"
                                        )
                                    alert_id = _uid()
                                    con.execute(
                                        """INSERT OR IGNORE INTO profile_alerts
                                           (id, profile_id, topic_id, bill_id, alert_type, summary, detected_at)
                                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                                        (alert_id, pid, tid, bill_id, change_type, summary, _now_iso()),
                                    )
                                    total_alerts += 1

        con.commit()
        logger.info("[monitor] Match pass done — alerts=%d new_matches=%d", total_alerts, total_matches)
        return {"alerts_created": total_alerts, "new_matches": total_matches}

    # ── Alert queries ─────────────────────────────────────────────────────────

    def get_undelivered_alerts(self, profile_id: str) -> list[dict]:
        """Return all alerts not yet included in a report, with bill details joined."""
        if not self._available():
            return []
        con = self._get_conn()
        rows = con.execute(
            """SELECT pa.*, b.identifier, b.title, b.state_code, b.chamber,
                      b.status, b.last_action_date, b.last_action,
                      pt.topic_name
               FROM profile_alerts pa
               LEFT JOIN bills b ON pa.bill_id = b.id
               LEFT JOIN profile_topics pt ON pa.topic_id = pt.id
               WHERE pa.profile_id = ? AND pa.included_in_report IS NULL
               ORDER BY pa.detected_at DESC""",
            (profile_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_alerts_delivered(self, alert_ids: list[str], report_id: str) -> None:
        if not self._available() or not alert_ids:
            return
        con = self._get_conn()
        placeholders = ",".join("?" * len(alert_ids))
        con.execute(
            f"UPDATE profile_alerts SET included_in_report = ? WHERE id IN ({placeholders})",
            [report_id, *alert_ids],
        )
        con.commit()

    def get_profile_summary(self, profile_id: str) -> dict:
        if not self._available():
            return {}
        con = self._get_conn()
        rows = con.execute(
            """SELECT alert_type, COUNT(*) as cnt
               FROM profile_alerts
               WHERE profile_id = ? AND included_in_report IS NULL
               GROUP BY alert_type""",
            (profile_id,),
        ).fetchall()
        counts = {r["alert_type"]: r["cnt"] for r in rows}
        total = sum(counts.values())
        return {"profile_id": profile_id, "undelivered_total": total, "by_type": counts}

    # ── Sync status ───────────────────────────────────────────────────────────

    def get_sync_status(self) -> list[dict]:
        if not self._available():
            return []
        self._ensure_schema()
        con = self._get_conn()
        rows = con.execute(
            "SELECT * FROM leg_sync_state ORDER BY state_code"
        ).fetchall()
        return [dict(r) for r in rows]


# ── Singleton ─────────────────────────────────────────────────────────────────

_monitor_service: Optional[LegMonitorService] = None


def get_monitor_service() -> LegMonitorService:
    global _monitor_service
    if _monitor_service is None:
        _monitor_service = LegMonitorService()
    return _monitor_service
