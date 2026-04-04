"""
AURA NX-Alpha — Legislative Report Service

Assembles a canvas document block from undelivered profile alerts.
Sections: new bills, status changes, new actions, news sweep.
News sweep uses existing free_sources.news_search() batched per profile×state.

PUBLIC API:
    await generate_brief(profile_id, emit_fn, days_back=7) → dict
        emit_fn: async callable(event_type, data) for SSE canvas output
        returns: {report_id, alert_count, sections}
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

# State code → display name (abbreviated list; fallback to code)
_STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "US": "Federal (Congress)",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _date_range_str(days_back: int) -> str:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)
    return f"{start.strftime('%b %d')} – {end.strftime('%b %d, %Y')}"


def _from_date_str(days_back: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")


def _state_name(code: str) -> str:
    return _STATE_NAMES.get(code.upper(), code.upper())


# ── News sweep ────────────────────────────────────────────────────────────────

async def _news_sweep_for_profile(
    profile: dict,
    days_back: int,
    alert_states: set[str],
) -> dict[str, list[dict]]:
    """
    Run NewsAPI sweep for each profile × state combination.
    Batches all topic keywords per state into a single query.
    Rate-limit guard: if >8 profile×state combos, only sweep states with active alerts.
    Returns {state_code: [article, ...]}
    """
    try:
        from app.agents.tools.free_sources import get_free_sources
        src = get_free_sources()
    except Exception as exc:
        logger.warning("[report_service] FreeSources unavailable: %s", exc)
        return {}

    topics = profile.get("topics", [])
    states = profile.get("states", [])
    from_date = _from_date_str(days_back)

    # Rate-limit guard
    if len(states) > 8:
        states = [s for s in states if s in alert_states] or states[:8]

    results: dict[str, list[dict]] = {}

    for state_code in states:
        # Gather up to 2 keywords per topic, max 5 total
        kws = []
        for topic in topics:
            kw_list = topic.get("keywords", [])
            kws.extend(kw_list[:2])
            if len(kws) >= 5:
                break

        if not kws:
            continue

        state_name = _state_name(state_code)
        kw_part = " OR ".join(f'"{kw}"' for kw in kws[:5])
        if state_code == "US":
            q = f"({kw_part}) AND (legislation OR congress OR bill OR law)"
        else:
            q = f"({kw_part}) AND (legislation OR bill OR law) AND {state_name}"

        try:
            articles = await src.news_search(q, from_date=from_date, page_size=5)
            if articles:
                results[state_code] = articles
        except Exception as exc:
            logger.warning("[report_service] News sweep %s failed: %s", state_code, exc)

    return results


# ── Document assembly ─────────────────────────────────────────────────────────

def _build_document(
    profile: dict,
    alerts: list[dict],
    news_by_state: dict[str, list[dict]],
    days_back: int,
) -> str:
    """Assemble markdown content for the canvas document block."""
    date_range = _date_range_str(days_back)
    lines = [f"# {profile['name']} — Legislative Brief", f"**{date_range}**", ""]

    new_bills      = [a for a in alerts if a.get("alert_type") == "new_bill"]
    status_changes = [a for a in alerts if a.get("alert_type") == "status_change"]
    new_actions    = [a for a in alerts if a.get("alert_type") == "new_action"]

    # ── Section 1: New Bills ──────────────────────────────────────────────────
    lines.append("## New Bills Matching Your Topics")
    if new_bills:
        lines.append("| State | Bill | Topic | Status | Title |")
        lines.append("|-------|------|-------|--------|-------|")
        for a in new_bills:
            state = a.get("state_code", "")
            bill  = a.get("identifier", "")
            topic = a.get("topic_name", "")
            status = (a.get("status") or "").title()
            title = (a.get("title") or "")[:80]
            lines.append(f"| {state} | {bill} | {topic} | {status} | {title} |")
    else:
        lines.append("_No new bills detected this period._")
    lines.append("")

    # ── Section 2: Status Changes ─────────────────────────────────────────────
    lines.append("## Status Changes on Tracked Bills")
    if status_changes:
        lines.append("| State | Bill | Topic | Summary | Date |")
        lines.append("|-------|------|-------|---------|------|")
        for a in status_changes:
            state = a.get("state_code", "")
            bill  = a.get("identifier", "")
            topic = a.get("topic_name", "")
            summary = a.get("summary", "")
            date = (a.get("detected_at") or "")[:10]
            lines.append(f"| {state} | {bill} | {topic} | {summary} | {date} |")
    else:
        lines.append("_No status changes detected this period._")
    lines.append("")

    # ── Section 3: New Actions ────────────────────────────────────────────────
    lines.append("## New Actions on Tracked Bills")
    if new_actions:
        lines.append("| State | Bill | Topic | Action | Date |")
        lines.append("|-------|------|-------|--------|------|")
        for a in new_actions:
            state  = a.get("state_code", "")
            bill   = a.get("identifier", "")
            topic  = a.get("topic_name", "")
            action = (a.get("last_action") or a.get("summary") or "")[:100]
            date   = a.get("last_action_date") or (a.get("detected_at") or "")[:10]
            lines.append(f"| {state} | {bill} | {topic} | {action} | {date} |")
    else:
        lines.append("_No new actions detected this period._")
    lines.append("")

    # ── Section 4: In The News ────────────────────────────────────────────────
    lines.append("## In The News")
    lines.append(f"_Coverage from the last {days_back} days across tracked states._")
    lines.append("")
    if news_by_state:
        for state_code, articles in news_by_state.items():
            state_label = _state_name(state_code)
            lines.append(f"### {state_label}")
            for art in articles[:5]:
                title   = art.get("title", "No title")
                source  = art.get("source", "")
                pub     = (art.get("published_at") or "")[:10]
                desc    = (art.get("description") or "")[:200]
                lines.append(f"- **{title}** — {source} ({pub})")
                if desc:
                    lines.append(f"  {desc}")
            lines.append("")
    else:
        lines.append("_No news coverage found for tracked topics this period._")
        lines.append("")

    return "\n".join(lines)


# ── Main entry point ──────────────────────────────────────────────────────────

async def generate_brief(
    profile_id: str,
    emit_fn,
    days_back: int = 7,
) -> dict:
    """
    Assemble a legislative monitoring brief for the given profile.
    Emits a render_canvas event with a document block.
    Marks all included alerts as delivered.
    Returns {report_id, alert_count, sections}.
    """
    from app.service.leg_monitor_service import get_monitor_service

    mon = get_monitor_service()
    profile = mon.get_profile(profile_id)
    if not profile:
        await emit_fn("token", {"text": f"Profile '{profile_id}' not found."})
        return {"report_id": None, "alert_count": 0, "sections": []}

    alerts = mon.get_undelivered_alerts(profile["id"])
    alert_states = {a.get("state_code", "") for a in alerts if a.get("state_code")}

    # News sweep (async — OK to run even if alerts = 0 for a weekly digest feel)
    news_by_state = await _news_sweep_for_profile(profile, days_back, alert_states)

    # Assemble document
    content = _build_document(profile, alerts, news_by_state, days_back)

    report_id = f"brief_{uuid.uuid4().hex[:12]}"
    date_range = _date_range_str(days_back)
    doc_title = f"{profile['name']} Legislative Brief — {date_range}"

    # Emit canvas document block
    await emit_fn("render_canvas", {
        "title": doc_title,
        "blocks": [{
            "type": "document",
            "data": {
                "title":   doc_title,
                "content": content,
            },
        }],
    })

    # Mark alerts delivered
    alert_ids = [a["id"] for a in alerts]
    mon.mark_alerts_delivered(alert_ids, report_id)

    sections = []
    if any(a["alert_type"] == "new_bill" for a in alerts):
        sections.append("new_bills")
    if any(a["alert_type"] == "status_change" for a in alerts):
        sections.append("status_changes")
    if any(a["alert_type"] == "new_action" for a in alerts):
        sections.append("new_actions")
    if news_by_state:
        sections.append("news")

    logger.info("[report_service] Brief generated: %s — %d alerts, %d sections",
                report_id, len(alerts), len(sections))

    return {
        "report_id":   report_id,
        "alert_count": len(alerts),
        "sections":    sections,
    }
