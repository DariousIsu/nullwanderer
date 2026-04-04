"""
AURA NX-Alpha — Travel Planning Service

TREK-inspired travel planning with trip itineraries, places, reservations,
and budget tracking. Uses SQLite for storage, OSRM for routing, and
Overpass API for POI search. All free, no API keys required.

TABLES:
    trips           — Trip metadata (name, destination, dates)
    trip_days        — Days within a trip (date, sort order)
    trip_places      — Places/waypoints within a day
    reservations     — Flight/hotel/restaurant bookings
    expenses         — Budget tracking with multi-currency
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus

import httpx

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "travel.db"
_instance: "TravelService | None" = None


# ─────────────────────────────────────────────────────────────────────────────
# DB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def _rows_to_list(rows) -> list[dict]:
    return [dict(r) for r in rows]


def init_travel_db() -> None:
    """Create tables if they don't exist. Called at startup."""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS trips (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                destination     TEXT,
                start_date      TEXT,
                end_date        TEXT,
                notes           TEXT DEFAULT '',
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trip_days (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                date            TEXT NOT NULL,
                label           TEXT DEFAULT '',
                sort_order      INTEGER DEFAULT 0,
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trip_places (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                day_id          INTEGER NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
                name            TEXT NOT NULL,
                lat             REAL NOT NULL,
                lon             REAL NOT NULL,
                category        TEXT DEFAULT 'other',
                notes           TEXT DEFAULT '',
                address         TEXT DEFAULT '',
                sort_order      INTEGER DEFAULT 0,
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reservations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                type            TEXT NOT NULL CHECK(type IN ('flight','hotel','restaurant','transport','activity','other')),
                title           TEXT NOT NULL,
                details         TEXT DEFAULT '{}',
                date            TEXT,
                end_date        TEXT,
                confirmation    TEXT DEFAULT '',
                notes           TEXT DEFAULT '',
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS expenses (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                description     TEXT NOT NULL,
                amount          REAL NOT NULL,
                currency        TEXT DEFAULT 'USD',
                category        TEXT DEFAULT 'other',
                date            TEXT,
                notes           TEXT DEFAULT '',
                created_at      TEXT NOT NULL
            );
        """)
    logger.info("[travel_service] DB initialized at %s", _DB_PATH)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

def init_travel_service() -> "TravelService":
    global _instance
    _instance = TravelService()
    logger.info("[travel_service] Service initialised")
    return _instance


def get_travel_service() -> "TravelService":
    if _instance is None:
        raise RuntimeError("TravelService not initialised. Call init_travel_service() first.")
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class TravelService:
    """TREK-inspired travel planning service."""

    def __init__(self):
        self._osrm_base = "https://router.project-osrm.org"
        self._overpass_url = "https://overpass-api.de/api/interpreter"

    # ── Trips ─────────────────────────────────────────────────────────────

    def create_trip(self, name: str, destination: str = "", start_date: str = "",
                    end_date: str = "", notes: str = "") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO trips (name, destination, start_date, end_date, notes, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (name, destination, start_date, end_date, notes, now, now),
            )
            trip_id = cur.lastrowid

            # Auto-create days if date range provided
            if start_date and end_date:
                from datetime import date as _date
                try:
                    sd = _date.fromisoformat(start_date)
                    ed = _date.fromisoformat(end_date)
                    day_num = 0
                    current = sd
                    while current <= ed:
                        conn.execute(
                            "INSERT INTO trip_days (trip_id, date, label, sort_order, created_at) "
                            "VALUES (?, ?, ?, ?, ?)",
                            (trip_id, current.isoformat(), f"Day {day_num + 1}", day_num, now),
                        )
                        day_num += 1
                        current = _date.fromordinal(current.toordinal() + 1)
                except ValueError:
                    pass  # Invalid date format, skip auto-creation

            conn.commit()
        return self.get_trip(trip_id)

    def get_trip(self, trip_id: int) -> Optional[dict]:
        with _get_conn() as conn:
            row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
            if not row:
                return None

            trip = _row_to_dict(row)
            trip["days"] = _rows_to_list(
                conn.execute(
                    "SELECT * FROM trip_days WHERE trip_id = ? ORDER BY sort_order, date",
                    (trip_id,),
                ).fetchall()
            )
            for day in trip["days"]:
                day["places"] = _rows_to_list(
                    conn.execute(
                        "SELECT * FROM trip_places WHERE day_id = ? ORDER BY sort_order",
                        (day["id"],),
                    ).fetchall()
                )

            trip["reservations"] = _rows_to_list(
                conn.execute(
                    "SELECT * FROM reservations WHERE trip_id = ? ORDER BY date",
                    (trip_id,),
                ).fetchall()
            )
            # Parse JSON details
            for res in trip["reservations"]:
                try:
                    res["details"] = json.loads(res.get("details", "{}"))
                except (json.JSONDecodeError, TypeError):
                    res["details"] = {}

            trip["expenses"] = _rows_to_list(
                conn.execute(
                    "SELECT * FROM expenses WHERE trip_id = ? ORDER BY date",
                    (trip_id,),
                ).fetchall()
            )
            return trip

    def list_trips(self) -> list[dict]:
        with _get_conn() as conn:
            rows = conn.execute("SELECT * FROM trips ORDER BY start_date DESC, created_at DESC").fetchall()
        return _rows_to_list(rows)

    def update_trip(self, trip_id: int, **kwargs) -> Optional[dict]:
        now = datetime.now(timezone.utc).isoformat()
        fields = {k: v for k, v in kwargs.items() if k in ("name", "destination", "start_date", "end_date", "notes")}
        if not fields:
            return self.get_trip(trip_id)
        fields["updated_at"] = now
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [trip_id]
        with _get_conn() as conn:
            conn.execute(f"UPDATE trips SET {set_clause} WHERE id = ?", values)
            conn.commit()
        return self.get_trip(trip_id)

    def delete_trip(self, trip_id: int) -> bool:
        with _get_conn() as conn:
            conn.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
            conn.commit()
        return True

    # ── Days ──────────────────────────────────────────────────────────────

    def add_day(self, trip_id: int, date: str, label: str = "") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            max_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) FROM trip_days WHERE trip_id = ?",
                (trip_id,),
            ).fetchone()[0]
            cur = conn.execute(
                "INSERT INTO trip_days (trip_id, date, label, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
                (trip_id, date, label, max_order + 1, now),
            )
            conn.commit()
            return _row_to_dict(conn.execute("SELECT * FROM trip_days WHERE id = ?", (cur.lastrowid,)).fetchone())

    def reorder_days(self, trip_id: int, day_ids: list[int]) -> list[dict]:
        with _get_conn() as conn:
            for order, day_id in enumerate(day_ids):
                conn.execute(
                    "UPDATE trip_days SET sort_order = ? WHERE id = ? AND trip_id = ?",
                    (order, day_id, trip_id),
                )
            conn.commit()
            return _rows_to_list(
                conn.execute("SELECT * FROM trip_days WHERE trip_id = ? ORDER BY sort_order", (trip_id,)).fetchall()
            )

    def delete_day(self, day_id: int) -> bool:
        with _get_conn() as conn:
            conn.execute("DELETE FROM trip_days WHERE id = ?", (day_id,))
            conn.commit()
        return True

    # ── Places ────────────────────────────────────────────────────────────

    def add_place(self, day_id: int, name: str, lat: float, lon: float,
                  category: str = "other", notes: str = "", address: str = "") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            max_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) FROM trip_places WHERE day_id = ?",
                (day_id,),
            ).fetchone()[0]
            cur = conn.execute(
                "INSERT INTO trip_places (day_id, name, lat, lon, category, notes, address, sort_order, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (day_id, name, lat, lon, category, notes, address, max_order + 1, now),
            )
            conn.commit()
            return _row_to_dict(conn.execute("SELECT * FROM trip_places WHERE id = ?", (cur.lastrowid,)).fetchone())

    def move_place(self, place_id: int, target_day_id: int, sort_order: int = 0) -> dict:
        with _get_conn() as conn:
            conn.execute(
                "UPDATE trip_places SET day_id = ?, sort_order = ? WHERE id = ?",
                (target_day_id, sort_order, place_id),
            )
            conn.commit()
            return _row_to_dict(conn.execute("SELECT * FROM trip_places WHERE id = ?", (place_id,)).fetchone())

    def delete_place(self, place_id: int) -> bool:
        with _get_conn() as conn:
            conn.execute("DELETE FROM trip_places WHERE id = ?", (place_id,))
            conn.commit()
        return True

    # ── Reservations ──────────────────────────────────────────────────────

    def add_reservation(self, trip_id: int, type: str, title: str, details: dict = None,
                        date: str = "", end_date: str = "", confirmation: str = "",
                        notes: str = "") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO reservations (trip_id, type, title, details, date, end_date, confirmation, notes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (trip_id, type, title, json.dumps(details or {}), date, end_date, confirmation, notes, now),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM reservations WHERE id = ?", (cur.lastrowid,)).fetchone()
            r = _row_to_dict(row)
            try:
                r["details"] = json.loads(r.get("details", "{}"))
            except (json.JSONDecodeError, TypeError):
                r["details"] = {}
            return r

    def delete_reservation(self, res_id: int) -> bool:
        with _get_conn() as conn:
            conn.execute("DELETE FROM reservations WHERE id = ?", (res_id,))
            conn.commit()
        return True

    # ── Expenses & Budget ─────────────────────────────────────────────────

    def add_expense(self, trip_id: int, description: str, amount: float,
                    currency: str = "USD", category: str = "other",
                    date: str = "", notes: str = "") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO expenses (trip_id, description, amount, currency, category, date, notes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (trip_id, description, amount, currency, category, date, notes, now),
            )
            conn.commit()
            return _row_to_dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (cur.lastrowid,)).fetchone())

    def get_budget(self, trip_id: int) -> dict:
        with _get_conn() as conn:
            rows = conn.execute("SELECT * FROM expenses WHERE trip_id = ? ORDER BY date", (trip_id,)).fetchall()
        expenses = _rows_to_list(rows)
        by_currency = {}
        by_category = {}
        for e in expenses:
            curr = e.get("currency", "USD")
            cat = e.get("category", "other")
            by_currency[curr] = by_currency.get(curr, 0) + e["amount"]
            by_category[cat] = by_category.get(cat, 0) + e["amount"]
        return {
            "expenses": expenses,
            "total_by_currency": by_currency,
            "total_by_category": by_category,
            "count": len(expenses),
        }

    def delete_expense(self, expense_id: int) -> bool:
        with _get_conn() as conn:
            conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
            conn.commit()
        return True

    # ── Routing (OSRM) ───────────────────────────────────────────────────

    async def get_route(self, trip_id: int) -> dict:
        """Get optimized route for all places in a trip as GeoJSON."""
        trip = self.get_trip(trip_id)
        if not trip:
            return {"error": "Trip not found"}

        all_places = []
        for day in trip.get("days", []):
            for place in day.get("places", []):
                all_places.append(place)

        if len(all_places) < 2:
            return {"error": "Need at least 2 places for routing", "places": len(all_places)}

        coords = ";".join(f"{p['lon']},{p['lat']}" for p in all_places)
        url = f"{self._osrm_base}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true"

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(url)
                r.raise_for_status()
                data = r.json()

            if data.get("code") != "Ok":
                return {"error": f"OSRM error: {data.get('message', 'unknown')}"}

            route = data["routes"][0]
            return {
                "type": "Feature",
                "geometry": route["geometry"],
                "properties": {
                    "distance_km": round(route["distance"] / 1000, 2),
                    "duration_min": round(route["duration"] / 60, 1),
                    "waypoints": [
                        {"name": p["name"], "lat": p["lat"], "lon": p["lon"]}
                        for p in all_places
                    ],
                },
            }
        except Exception as exc:
            logger.error("[travel_service] OSRM routing failed: %s", exc)
            return {"error": str(exc)}

    # ── POI Search (Overpass API) ─────────────────────────────────────────

    async def search_places(self, query: str = "", lat: float = 0, lon: float = 0,
                            radius: int = 5000, category: str = "") -> dict:
        """Search for points of interest near a location using Overpass API."""
        if not lat or not lon:
            # Fall back to Nominatim geocoding
            return await self._nominatim_search(query)

        # Build Overpass query
        filters = ""
        if category:
            category_map = {
                "restaurant": '["amenity"="restaurant"]',
                "hotel": '["tourism"="hotel"]',
                "cafe": '["amenity"="cafe"]',
                "museum": '["tourism"="museum"]',
                "attraction": '["tourism"="attraction"]',
                "park": '["leisure"="park"]',
                "shopping": '["shop"]',
                "transport": '["public_transport"]',
                "bar": '["amenity"="bar"]',
                "pharmacy": '["amenity"="pharmacy"]',
                "hospital": '["amenity"="hospital"]',
                "gas_station": '["amenity"="fuel"]',
            }
            filters = category_map.get(category, f'["name"~"{query}",i]' if query else "")

        if not filters and query:
            filters = f'["name"~"{query}",i]'

        if not filters:
            filters = '["tourism"]'

        overpass_query = f"""
        [out:json][timeout:10];
        (
            node{filters}(around:{radius},{lat},{lon});
            way{filters}(around:{radius},{lat},{lon});
        );
        out center 20;
        """

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(
                    self._overpass_url,
                    data={"data": overpass_query},
                )
                r.raise_for_status()
                data = r.json()

            places = []
            for element in data.get("elements", []):
                tags = element.get("tags", {})
                name = tags.get("name", "")
                if not name:
                    continue

                place_lat = element.get("lat") or element.get("center", {}).get("lat")
                place_lon = element.get("lon") or element.get("center", {}).get("lon")

                places.append({
                    "name": name,
                    "lat": place_lat,
                    "lon": place_lon,
                    "category": tags.get("amenity") or tags.get("tourism") or tags.get("shop") or "other",
                    "address": tags.get("addr:street", ""),
                    "phone": tags.get("phone", ""),
                    "website": tags.get("website", ""),
                    "opening_hours": tags.get("opening_hours", ""),
                })

            return {"places": places, "count": len(places), "query": query, "radius": radius}

        except Exception as exc:
            logger.error("[travel_service] Overpass search failed: %s", exc)
            return {"error": str(exc)}

    async def _nominatim_search(self, query: str) -> dict:
        """Fallback search via Nominatim when no lat/lon provided."""
        if not query:
            return {"error": "query is required when lat/lon not provided"}

        url = f"https://nominatim.openstreetmap.org/search?q={quote_plus(query)}&format=json&limit=10"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url, headers={"User-Agent": "AURA/1.0"})
                r.raise_for_status()
                results = r.json()

            places = []
            for item in results:
                places.append({
                    "name": item.get("display_name", ""),
                    "lat": float(item.get("lat", 0)),
                    "lon": float(item.get("lon", 0)),
                    "category": item.get("type", "other"),
                    "address": item.get("display_name", ""),
                })

            return {"places": places, "count": len(places), "query": query}

        except Exception as exc:
            logger.error("[travel_service] Nominatim search failed: %s", exc)
            return {"error": str(exc)}
