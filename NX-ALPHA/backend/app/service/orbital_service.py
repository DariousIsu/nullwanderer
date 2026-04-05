"""
AURA NX-Alpha — Orbital Service

TLE data from CelesTrak (pub/TLE endpoint), propagated via skyfield.
Cached in SQLite at ~/.aura/orbital.db. Cache is valid for 24 hours.

INSTALL:
    pip install skyfield sgp4
"""
import logging
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

ORBITAL_DB = Path.home() / ".aura" / "orbital.db"

CELESTRAK_TLE_BASE = "https://celestrak.org/pub/TLE"
CATALOGS = {
    "stations":  "stations.txt",
    "active":    "active.txt",
    "starlink":  "starlink.txt",
    "weather":   "weather.txt",
    "amateur":   "amateur.txt",
    "debris":    "cosmos-2251-debris.txt",
}
CACHE_TTL_HOURS = 24

# Backoff state for failed refresh attempts
_consecutive_failures: int = 0
_last_failure_time: Optional[datetime] = None
_BACKOFF_BASE_SECONDS = 60   # 1 min after first failure
_BACKOFF_MAX_SECONDS = 600   # cap at 10 min

# CelesTrak-specific cooldown (separate from overall refresh backoff)
_celestrak_consecutive_failures: int = 0
_celestrak_last_failure: Optional[datetime] = None
_CELESTRAK_COOLDOWN_THRESHOLD = 3     # After 3 failures, enter long cooldown
_CELESTRAK_COOLDOWN_SECONDS = 1800    # 30-minute cooldown before retrying CelesTrak


# ─────────────────────────────────────────────────────────────────────────────
# DB
# ─────────────────────────────────────────────────────────────────────────────

def _init_db() -> sqlite3.Connection:
    ORBITAL_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(ORBITAL_DB))
    con.execute("""
        CREATE TABLE IF NOT EXISTS tle_cache (
            norad_id   TEXT PRIMARY KEY,
            name       TEXT,
            line1      TEXT,
            line2      TEXT,
            category   TEXT,
            fetched_at TEXT
        )
    """)
    con.commit()
    return con


def _is_stale(category: str) -> bool:
    """Return True if the category hasn't been refreshed within CACHE_TTL_HOURS."""
    con = _init_db()
    row = con.execute(
        "SELECT fetched_at FROM tle_cache WHERE category=? LIMIT 1", (category,)
    ).fetchone()
    con.close()
    if not row:
        return True
    try:
        fetched = datetime.fromisoformat(row[0])
        return datetime.utcnow() - fetched > timedelta(hours=CACHE_TTL_HOURS)
    except Exception:
        return True


# ─────────────────────────────────────────────────────────────────────────────
# FETCH / REFRESH
# ─────────────────────────────────────────────────────────────────────────────

async def _fetch_satnogs_tle(category: str, now_iso: str) -> list:
    """
    Fallback TLE source: SatNOGS DB API (Space-Track.org mirror).
    Returns list of (norad_id, name, line1, line2, category, fetched_at) tuples.
    Only used when CelesTrak is unreachable.
    """
    # SatNOGS doesn't have the same category split as CelesTrak — fetch all active
    # and label them with the requested category for cache keying.
    url = "https://db.satnogs.org/api/tle/?format=json&limit=5000"
    logger.info("[orbital] CelesTrak unavailable — falling back to SatNOGS: %s", url)

    satellites = []
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.get(url)
        res.raise_for_status()
        data = res.json()

    for entry in data:
        tle0 = entry.get("tle0", "")
        l1   = entry.get("tle1", "")
        l2   = entry.get("tle2", "")
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        # tle0 may be prefixed with "0 " by SatNOGS; strip it for the name
        name     = tle0.lstrip("0 ").strip() or tle0.strip()
        norad_id = l1[2:7].strip()
        satellites.append((norad_id, name, l1, l2, category, now_iso))

    return satellites


async def refresh_catalog(category: str = "active") -> int:
    """
    Fetch TLE catalog from CelesTrak (primary) with SatNOGS fallback.
    Returns count of satellites stored.
    """
    global _celestrak_consecutive_failures, _celestrak_last_failure

    now_iso  = datetime.utcnow().isoformat()
    filename = CATALOGS.get(category, "active.txt")
    url      = f"{CELESTRAK_TLE_BASE}/{filename}"

    satellites = []
    skip_celestrak = False

    # Check if CelesTrak is in cooldown after repeated failures
    if _celestrak_consecutive_failures >= _CELESTRAK_COOLDOWN_THRESHOLD and _celestrak_last_failure:
        elapsed = (datetime.utcnow() - _celestrak_last_failure).total_seconds()
        if elapsed < _CELESTRAK_COOLDOWN_SECONDS:
            skip_celestrak = True
            logger.debug(
                "[orbital] CelesTrak in cooldown (%d failures, %ds remaining) — using SatNOGS directly",
                _celestrak_consecutive_failures,
                int(_CELESTRAK_COOLDOWN_SECONDS - elapsed),
            )

    # ── Primary: CelesTrak TLE text format ───────────────────────────────────
    if not skip_celestrak:
        logger.info("[orbital] Fetching TLE catalog: %s", url)
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                res = await client.get(url)
                res.raise_for_status()

            lines = [l for l in res.text.strip().splitlines() if l.strip()]
            for i in range(0, len(lines) - 2, 3):
                name = lines[i].strip()
                l1   = lines[i + 1].strip()
                l2   = lines[i + 2].strip()
                if l1.startswith("1 ") and l2.startswith("2 "):
                    norad_id = l1[2:7].strip()
                    satellites.append((norad_id, name, l1, l2, category, now_iso))

            if satellites:
                # CelesTrak succeeded — reset cooldown
                _celestrak_consecutive_failures = 0
                _celestrak_last_failure = None
            else:
                logger.warning("[orbital] No satellites parsed from CelesTrak %s", url)
        except Exception as exc:
            _celestrak_consecutive_failures += 1
            _celestrak_last_failure = datetime.utcnow()
            logger.warning(
                "[orbital] CelesTrak fetch failed (attempt %d): %s — trying SatNOGS fallback",
                _celestrak_consecutive_failures, exc,
            )

    # ── Fallback: SatNOGS DB (reachable when CelesTrak is blocked) ───────────
    if not satellites:
        try:
            satellites = await _fetch_satnogs_tle(category, now_iso)
        except Exception as exc:
            logger.warning("[orbital] SatNOGS fallback also failed: %s", exc)

    if not satellites:
        logger.warning("[orbital] No TLE data from any source for category: %s", category)
        return 0

    con = _init_db()
    con.executemany(
        "INSERT OR REPLACE INTO tle_cache VALUES (?,?,?,?,?,?)", satellites
    )
    con.commit()
    con.close()
    logger.info("[orbital] Cached %d satellites for category: %s", len(satellites), category)
    return len(satellites)


async def _ensure_fresh(category: str):
    """Auto-refresh if stale. Silent on failure with exponential backoff."""
    global _consecutive_failures, _last_failure_time

    if not _is_stale(category):
        return

    # If we've been failing, check if enough time has passed before retrying
    if _consecutive_failures > 0 and _last_failure_time:
        backoff = min(
            _BACKOFF_BASE_SECONDS * (2 ** (_consecutive_failures - 1)),
            _BACKOFF_MAX_SECONDS,
        )
        elapsed = (datetime.utcnow() - _last_failure_time).total_seconds()
        if elapsed < backoff:
            return  # Still in backoff window, skip retry

    try:
        await refresh_catalog(category)
        _consecutive_failures = 0
        _last_failure_time = None
    except Exception as exc:
        _consecutive_failures += 1
        _last_failure_time = datetime.utcnow()
        backoff = min(
            _BACKOFF_BASE_SECONDS * (2 ** (_consecutive_failures - 1)),
            _BACKOFF_MAX_SECONDS,
        )
        logger.warning(
            "[orbital] Background refresh failed for %s (attempt %d, next retry in %ds): %s",
            category, _consecutive_failures, backoff, exc,
        )


# ─────────────────────────────────────────────────────────────────────────────
# QUERIES
# ─────────────────────────────────────────────────────────────────────────────

async def get_satellites(category: str = "active") -> list[dict]:
    """
    Return all satellites in category with current lat/lon/alt.
    Auto-refreshes from CelesTrak if cache is stale.
    """
    await _ensure_fresh(category)

    con = _init_db()
    rows = con.execute(
        "SELECT norad_id, name, line1, line2 FROM tle_cache WHERE category=?",
        (category,)
    ).fetchall()
    con.close()

    results = []
    for norad_id, name, l1, l2 in rows:
        pos = _propagate(norad_id, name, l1, l2)
        if pos:
            results.append(pos)

    return results


def get_satellite(norad_id: str) -> Optional[dict]:
    """Return current position for a single satellite by NORAD ID."""
    con = _init_db()
    row = con.execute(
        "SELECT name, line1, line2 FROM tle_cache WHERE norad_id=?", (norad_id,)
    ).fetchone()
    con.close()
    if not row:
        return None
    name, l1, l2 = row
    return _propagate(norad_id, name, l1, l2)


def get_ground_track(norad_id: str, hours: float = 2.0) -> dict:
    """
    Compute GeoJSON LineString ground track for next N hours.
    Samples every 2 minutes.
    """
    con = _init_db()
    row = con.execute(
        "SELECT name, line1, line2 FROM tle_cache WHERE norad_id=?", (norad_id,)
    ).fetchone()
    con.close()

    if not row:
        return {"type": "LineString", "coordinates": []}

    name, l1, l2 = row
    try:
        from skyfield.api import load, EarthSatellite
        ts = load.timescale()
        satellite = EarthSatellite(l1, l2, name, ts)
        now = datetime.utcnow()

        coords = []
        for minutes in range(0, int(hours * 60), 2):
            t_dt = now + timedelta(minutes=minutes)
            t = ts.utc(t_dt.year, t_dt.month, t_dt.day,
                       t_dt.hour, t_dt.minute, t_dt.second)
            sub = satellite.at(t).subpoint()
            coords.append([sub.longitude.degrees, sub.latitude.degrees])

        return {"type": "LineString", "coordinates": coords}

    except Exception as exc:
        logger.warning("[orbital] Ground track failed for %s: %s", norad_id, exc)
        return {"type": "LineString", "coordinates": []}


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL
# ─────────────────────────────────────────────────────────────────────────────

def _propagate(norad_id: str, name: str, l1: str, l2: str) -> Optional[dict]:
    """Propagate TLE to current UTC time and return position dict."""
    try:
        from skyfield.api import load, EarthSatellite
        ts = load.timescale()
        satellite = EarthSatellite(l1, l2, name, ts)
        t = ts.now()
        sub = satellite.at(t).subpoint()
        return {
            "norad_id":  norad_id,
            "name":      name,
            "lat":       sub.latitude.degrees,
            "lon":       sub.longitude.degrees,
            "alt_km":    sub.elevation.km,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception:
        return None
