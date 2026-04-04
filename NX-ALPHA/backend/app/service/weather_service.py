"""
AURA NX-Alpha — Weather Service
Provides current conditions, daily forecast, and radar tile URL via
the Open-Meteo API (no API key required) and the NWS GeoServer WMS.

SINGLETON PATTERN:
    Call init_weather_service() once at startup.
    Callers use get_weather_service() to get the instance.

CACHING:
    Results are cached in-process for 10 minutes (simple dict + timestamp).
    Cache is keyed by (lat, lon) rounded to 4 decimal places.

DEPENDENCIES:
    httpx — async HTTP client
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL IMPORTS
# ─────────────────────────────────────────────────────────────────────────────

try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    _HTTPX_AVAILABLE = False
    logger.warning("[weather_service] httpx not installed — all weather calls will return empty results")

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

_OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast"
_NWS_RADAR_BASE = (
    "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows"
    "?service=WMS&version=1.3.0&request=GetMap"
    "&layers=conus_bref_qcd"
    "&bbox={lat_min},{lon_min},{lat_max},{lon_max}"
    "&width=512&height=512&crs=EPSG:4326&format=image/png"
)

_DEFAULT_LAT = 40.7128
_DEFAULT_LON = -74.0060

_CACHE_TTL_SECONDS = 600  # 10 minutes

# WMO weather interpretation codes → human-readable text
_WMO_CODE_MAP: dict[int, str] = {
    0:  "Clear",
    1:  "Mainly clear",
    2:  "Partly cloudy",
    3:  "Overcast",
    45: "Foggy",
    48: "Icy fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Heavy freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def weather_code_to_text(code: int) -> str:
    """Convert a WMO weather interpretation code to a human-readable string.

    Args:
        code: WMO weather code integer from the Open-Meteo API.

    Returns:
        A short description string, or "Unknown" for unrecognised codes.
    """
    if code in _WMO_CODE_MAP:
        return _WMO_CODE_MAP[code]
    # Range-based fallbacks for codes not individually listed
    if 1 <= code <= 3:
        return "Partly cloudy"
    if 45 <= code <= 48:
        return "Foggy"
    if 51 <= code <= 67:
        return "Drizzle / Rain"
    if 71 <= code <= 77:
        return "Snow"
    if 80 <= code <= 82:
        return "Rain showers"
    if 85 <= code <= 86:
        return "Snow showers"
    if 96 <= code <= 99:
        return "Thunderstorm with hail"
    return "Unknown"


def _cache_key(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat, 4), round(lon, 4))


# ─────────────────────────────────────────────────────────────────────────────
# WEATHER SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class WeatherService:
    """
    Async weather service backed by Open-Meteo (no API key required).

    Usage::

        await weather_service.get_current(lat, lon)
        await weather_service.get_forecast(lat, lon, days=7)
        weather_service.get_radar_url(lat, lon)
    """

    def __init__(self) -> None:
        # Simple in-process cache: key → {"data": ..., "ts": float}
        self._cache: dict[str, dict[str, Any]] = {}
        self._client: "httpx.AsyncClient | None" = None
        if _HTTPX_AVAILABLE:
            self._client = httpx.AsyncClient(timeout=10.0)
        logger.info("[weather_service] Initialized (httpx=%s)", _HTTPX_AVAILABLE)

    # ── CACHE HELPERS ─────────────────────────────────────────────────────────

    def _get_cache(self, key: str) -> Any | None:
        entry = self._cache.get(key)
        if entry and (time.time() - entry["ts"]) < _CACHE_TTL_SECONDS:
            return entry["data"]
        return None

    def _set_cache(self, key: str, data: Any) -> None:
        self._cache[key] = {"data": data, "ts": time.time()}

    # ── PUBLIC API ────────────────────────────────────────────────────────────

    async def get_current(self, lat: float = _DEFAULT_LAT, lon: float = _DEFAULT_LON) -> dict:
        """Fetch current weather conditions from Open-Meteo.

        Args:
            lat: Latitude (default NYC).
            lon: Longitude (default NYC).

        Returns:
            Dict with keys: temperature_2m, relative_humidity_2m, wind_speed_10m,
            wind_direction_10m, weather_code, weather_text, apparent_temperature,
            precipitation, cloud_cover, latitude, longitude, timezone.
            Returns an empty dict on any failure.
        """
        ck = f"current:{_cache_key(lat, lon)}"
        cached = self._get_cache(ck)
        if cached is not None:
            return cached

        if not _HTTPX_AVAILABLE or self._client is None:
            logger.warning("[weather_service] httpx unavailable — returning empty current")
            return {}

        params = {
            "latitude":  lat,
            "longitude": lon,
            "current": (
                "temperature_2m,relative_humidity_2m,wind_speed_10m,"
                "wind_direction_10m,weather_code,apparent_temperature,"
                "precipitation,cloud_cover"
            ),
        }

        try:
            response = await self._client.get(_OPEN_METEO_BASE, params=params)
            response.raise_for_status()
            payload = response.json()
            current_raw: dict = payload.get("current", {})
            result: dict = {
                "latitude":              payload.get("latitude", lat),
                "longitude":             payload.get("longitude", lon),
                "timezone":              payload.get("timezone", "UTC"),
                "temperature_2m":        current_raw.get("temperature_2m"),
                "apparent_temperature":  current_raw.get("apparent_temperature"),
                "relative_humidity_2m":  current_raw.get("relative_humidity_2m"),
                "wind_speed_10m":        current_raw.get("wind_speed_10m"),
                "wind_direction_10m":    current_raw.get("wind_direction_10m"),
                "weather_code":          current_raw.get("weather_code"),
                "weather_text":          weather_code_to_text(
                    current_raw.get("weather_code") or 0
                ),
                "precipitation":         current_raw.get("precipitation"),
                "cloud_cover":           current_raw.get("cloud_cover"),
            }
            self._set_cache(ck, result)
            return result
        except Exception as exc:
            logger.warning("[weather_service] get_current failed (lat=%s lon=%s): %s", lat, lon, exc)
            return {}

    async def get_forecast(
        self,
        lat: float = _DEFAULT_LAT,
        lon: float = _DEFAULT_LON,
        days: int = 7,
    ) -> list[dict]:
        """Fetch daily weather forecast from Open-Meteo.

        Args:
            lat: Latitude (default NYC).
            lon: Longitude (default NYC).
            days: Number of forecast days (1–16, default 7).

        Returns:
            List of dicts, one per day, each with keys: date,
            temperature_max, temperature_min, precipitation_sum,
            weather_code, weather_text, wind_speed_max.
            Returns an empty list on any failure.
        """
        ck = f"forecast:{_cache_key(lat, lon)}:{days}"
        cached = self._get_cache(ck)
        if cached is not None:
            return cached

        if not _HTTPX_AVAILABLE or self._client is None:
            logger.warning("[weather_service] httpx unavailable — returning empty forecast")
            return []

        params = {
            "latitude":      lat,
            "longitude":     lon,
            "forecast_days": days,
            "daily": (
                "temperature_2m_max,temperature_2m_min,precipitation_sum,"
                "weather_code,wind_speed_10m_max"
            ),
        }

        try:
            response = await self._client.get(_OPEN_METEO_BASE, params=params)
            response.raise_for_status()
            payload = response.json()
            daily: dict = payload.get("daily", {})

            dates          = daily.get("time", [])
            temp_max       = daily.get("temperature_2m_max", [])
            temp_min       = daily.get("temperature_2m_min", [])
            precip         = daily.get("precipitation_sum", [])
            codes          = daily.get("weather_code", [])
            wind_max       = daily.get("wind_speed_10m_max", [])

            result = [
                {
                    "date":             dates[i] if i < len(dates) else None,
                    "temperature_max":  temp_max[i] if i < len(temp_max) else None,
                    "temperature_min":  temp_min[i] if i < len(temp_min) else None,
                    "precipitation_sum": precip[i] if i < len(precip) else None,
                    "weather_code":     codes[i] if i < len(codes) else None,
                    "weather_text":     weather_code_to_text(codes[i] if i < len(codes) else 0),
                    "wind_speed_max":   wind_max[i] if i < len(wind_max) else None,
                }
                for i in range(len(dates))
            ]
            self._set_cache(ck, result)
            return result
        except Exception as exc:
            logger.warning("[weather_service] get_forecast failed (lat=%s lon=%s): %s", lat, lon, exc)
            return []

    def get_radar_url(self, lat: float = _DEFAULT_LAT, lon: float = _DEFAULT_LON) -> str:
        """Build an NWS GeoServer WMS radar tile URL centered on the given coordinates.

        The bounding box extends ±2° in latitude and ±3° in longitude from the
        requested point, producing a reasonably local radar view.

        Args:
            lat: Latitude (default NYC).
            lon: Longitude (default NYC).

        Returns:
            A fully-formed WMS GetMap URL string (image/png, 512×512).
        """
        return _NWS_RADAR_BASE.format(
            lat_min=round(lat - 2, 4),
            lon_min=round(lon - 3, 4),
            lat_max=round(lat + 2, 4),
            lon_max=round(lon + 3, 4),
        )

    async def close(self) -> None:
        """Close the underlying httpx client. Call during app shutdown."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            logger.debug("[weather_service] httpx client closed")


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_weather_service: WeatherService | None = None


def init_weather_service() -> WeatherService:
    """Instantiate and register the global WeatherService. Call once at startup."""
    global _weather_service
    _weather_service = WeatherService()
    return _weather_service


def get_weather_service() -> WeatherService | None:
    """Return the running WeatherService instance, or None if not initialised."""
    return _weather_service
