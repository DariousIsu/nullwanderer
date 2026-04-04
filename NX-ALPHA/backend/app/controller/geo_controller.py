"""
AURA NX-Alpha — Geo Controller

Endpoints:
  GET  /geo/satellites              ?category=active  — all satellites with current positions
  GET  /geo/satellites/{norad_id}                     — single satellite position
  GET  /geo/satellites/{norad_id}/track ?hours=2.0    — GeoJSON LineString ground track
  GET  /geo/imagery/gibs/layers                       — available NASA GIBS WMS layers
  POST /geo/geocode                                   — Nominatim forward geocoding
  GET  /geo/tle/refresh             ?category=active  — force CelesTrak refresh
  GET  /geo/events                                    — GDACS + USGS crisis events (10-min cache)
"""
import logging
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/geo", tags=["geo"])
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# NASA GIBS — hardcoded layer catalogue
# Full catalogue: https://nasa-gibs.github.io/gibs-api-docs/
# ─────────────────────────────────────────────────────────────────────────────

GIBS_WMS_BASE = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"

GIBS_LAYERS = [
    {
        "id":      "MODIS_Terra_CorrectedReflectance_TrueColor",
        "name":    "MODIS Terra — True Color",
        "wms_url": GIBS_WMS_BASE,
        "description": "Daily true-color composite. Cloud cover, vegetation, coastlines.",
    },
    {
        "id":      "VIIRS_SNPP_CorrectedReflectance_TrueColor",
        "name":    "VIIRS SNPP — True Color",
        "wms_url": GIBS_WMS_BASE,
        "description": "Higher resolution daily true-color from Suomi NPP satellite.",
    },
    {
        "id":      "BlueMarble_ShadedRelief_Bathymetry",
        "name":    "Blue Marble (Shaded Relief + Bathymetry)",
        "wms_url": GIBS_WMS_BASE,
        "description": "NASA Blue Marble with terrain shading and ocean depth.",
    },
    {
        "id":      "MODIS_Terra_Land_Surface_Temp_Day",
        "name":    "MODIS Terra — Land Surface Temperature (Day)",
        "wms_url": GIBS_WMS_BASE,
        "description": "Daytime land surface temperature. Red = hot, blue = cold.",
    },
    {
        "id":      "MODIS_Terra_Aerosol",
        "name":    "MODIS Terra — Aerosol Optical Depth",
        "wms_url": GIBS_WMS_BASE,
        "description": "Atmospheric aerosol concentration — smoke, dust, pollution.",
    },
    {
        "id":      "MODIS_Terra_Snow_Cover_Daily",
        "name":    "MODIS Terra — Snow Cover",
        "wms_url": GIBS_WMS_BASE,
        "description": "Daily binary snow cover classification.",
    },
    {
        "id":      "VIIRS_SNPP_DayNightBand_ENCC",
        "name":    "VIIRS — Night Lights (Day/Night Band)",
        "wms_url": GIBS_WMS_BASE,
        "description": "Nighttime city lights, gas flares, fishing vessels.",
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/satellites")
async def list_satellites(category: str = "active"):
    """Return all satellites in the given category with current lat/lon/alt."""
    from app.service.orbital_service import get_satellites
    valid = {"stations", "active", "starlink", "weather", "amateur", "debris"}
    if category not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown category. Valid: {sorted(valid)}")
    try:
        return await get_satellites(category)
    except Exception as exc:
        logger.error("[geo] list_satellites failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/satellites/{norad_id}")
async def satellite_position(norad_id: str):
    """Return current position for a single satellite by NORAD catalogue number."""
    from app.service.orbital_service import get_satellite
    result = get_satellite(norad_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Satellite {norad_id} not found in cache. Call /geo/tle/refresh first.")
    return result


@router.get("/satellites/{norad_id}/track")
async def satellite_track(norad_id: str, hours: float = 2.0):
    """
    Return a GeoJSON LineString ground track for the satellite over the next N hours.
    Samples every 2 minutes.
    """
    from app.service.orbital_service import get_ground_track
    if hours < 0.1 or hours > 24:
        raise HTTPException(status_code=400, detail="hours must be between 0.1 and 24")
    track = get_ground_track(norad_id, hours=hours)
    return {
        "type": "Feature",
        "properties": {"norad_id": norad_id, "hours": hours},
        "geometry": track,
    }


@router.get("/imagery/gibs/layers")
async def gibs_layers():
    """Return available NASA GIBS WMS layer catalogue."""
    return GIBS_LAYERS


class GeocodeRequest(BaseModel):
    q: str


@router.post("/geocode")
async def geocode(body: GeocodeRequest):
    """
    Forward geocoding via Nominatim (OpenStreetMap).
    Returns up to 5 results with lat, lon, display_name.
    No API key required. Attribution: © OpenStreetMap contributors.
    """
    q = body.q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query string is empty")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": q, "format": "json", "limit": 5},
                headers={"User-Agent": "AURA-NX-Alpha/1.0 (geospatial panel)"},
            )
            res.raise_for_status()
        return res.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Nominatim error")
    except Exception as exc:
        logger.error("[geo] geocode failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL EVENTS — GDACS + USGS (10-min cache)
# ─────────────────────────────────────────────────────────────────────────────

_events_cache: list | None = None
_events_fetched_at: float = 0.0
_EVENTS_TTL = 600  # seconds

_EVENT_TYPE_LABELS = {
    "EQ": "Earthquake",
    "TC": "Tropical Cyclone",
    "FL": "Flood",
    "VO": "Volcano",
    "DR": "Drought",
    "WF": "Wildfire",
}


async def _fetch_events() -> list[dict]:
    """Fetch and merge GDACS + USGS significant earthquakes into a flat event list."""
    features: list[dict] = []

    # ── GDACS crisis alerts ───────────────────────────────────────────────────
    try:
        gdacs_url = (
            "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
            "?alertlevel=&eventlist=EQ,TC,FL,VO,DR,WF&limit=100"
        )
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(gdacs_url, headers={"Accept": "application/json"})
            r.raise_for_status()
        data = r.json()
        for feat in data.get("features", []):
            props  = feat.get("properties", {})
            coords = feat.get("geometry", {}).get("coordinates", [])
            if len(coords) < 2:
                continue
            etype = props.get("eventtype", "")
            url_field = props.get("url", "")
            url = url_field.get("report", "") if isinstance(url_field, dict) else url_field
            features.append({
                "id":      f"gdacs-{props.get('eventid', '')}",
                "source":  "GDACS",
                "type":    _EVENT_TYPE_LABELS.get(etype, etype),
                "name":    props.get("name", "Unknown Event"),
                "country": props.get("country", ""),
                "alert":   props.get("alertlevel", "Green"),
                "date":    props.get("fromdate", ""),
                "url":     url,
                "lon":     coords[0],
                "lat":     coords[1],
            })
        logger.info("[geo/events] GDACS: %d events", sum(1 for f in features if f["source"] == "GDACS"))
    except Exception as exc:
        logger.warning("[geo/events] GDACS fetch failed: %s", exc)

    # ── USGS significant earthquakes (monthly) ────────────────────────────────
    usgs_start = len(features)
    try:
        usgs_url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson"
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(usgs_url)
            r.raise_for_status()
        data = r.json()
        for feat in data.get("features", []):
            props  = feat.get("properties", {})
            coords = feat.get("geometry", {}).get("coordinates", [])
            if len(coords) < 2:
                continue
            mag   = props.get("mag") or 0
            alert = "Red" if mag >= 7.0 else ("Orange" if mag >= 6.0 else "Green")
            features.append({
                "id":      f"usgs-{feat.get('id', '')}",
                "source":  "USGS",
                "type":    "Earthquake",
                "name":    props.get("title", f"M{mag} Earthquake"),
                "country": props.get("place", ""),
                "alert":   alert,
                "date":    "",
                "url":     props.get("url", ""),
                "lon":     coords[0],
                "lat":     coords[1],
                "mag":     round(float(mag), 1),
            })
        logger.info("[geo/events] USGS: %d events", len(features) - usgs_start)
    except Exception as exc:
        logger.warning("[geo/events] USGS fetch failed: %s", exc)

    return features


@router.get("/events")
async def geo_events():
    """
    Return merged GDACS + USGS crisis events as a flat list.
    Cached for 10 minutes. Each event: {id, source, type, name, country, alert, date, url, lon, lat}.
    """
    global _events_cache, _events_fetched_at
    now = time.time()
    if _events_cache is None or (now - _events_fetched_at) > _EVENTS_TTL:
        try:
            _events_cache = await _fetch_events()
            _events_fetched_at = now
        except Exception as exc:
            logger.error("[geo/events] fetch failed: %s", exc)
            if _events_cache is None:
                return []
    return _events_cache


@router.get("/tle/refresh")
async def tle_refresh(category: str = "active"):
    """
    Force a TLE catalog refresh from CelesTrak.
    Ignores cache TTL — always fetches fresh data.
    """
    from app.service.orbital_service import refresh_catalog
    valid = {"stations", "active", "starlink", "weather", "amateur", "debris"}
    if category not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown category. Valid: {sorted(valid)}")
    try:
        count = await refresh_catalog(category)
        return {"status": "ok", "category": category, "satellites_cached": count}
    except Exception as exc:
        logger.error("[geo] TLE refresh failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
