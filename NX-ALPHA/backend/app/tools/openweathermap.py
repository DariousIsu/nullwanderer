"""
OpenWeatherMap — MCP tool wrapper.

Structured weather data: temperature, feels-like, wind, humidity, pressure,
precipitation, cloud cover. Replaces basic weather tool with richer data.
Free tier: 60 calls/min, 1M calls/month.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "weather",
    "description": (
        "Get current weather conditions for any location. Returns structured data: "
        "temperature, feels-like, humidity, wind speed/direction, pressure, "
        "precipitation, cloud cover, and weather description."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "City name (e.g. 'London,GB', 'New York,US') or lat,lon"},
            "units":    {"type": "string", "enum": ["metric", "imperial", "standard"], "description": "Temperature units (default metric)", "default": "imperial"},
        },
        "required": ["location"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    location = inputs.get("location", "")
    units    = inputs.get("units", "imperial")
    if not location:
        return _error("location is required")

    api_key = _get_setting("openweathermap_api_key")
    if not api_key:
        return _error("openweathermap_api_key not configured in settings")

    try:
        params = {"q": location, "appid": api_key, "units": units}

        # Check if location is lat,lon
        if "," in location:
            parts = location.split(",")
            try:
                lat, lon = float(parts[0].strip()), float(parts[1].strip())
                params = {"lat": lat, "lon": lon, "appid": api_key, "units": units}
            except ValueError:
                pass  # Not lat/lon, use as city name

        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get("https://api.openweathermap.org/data/2.5/weather", params=params)
            r.raise_for_status()
            data = r.json()

        weather = data.get("weather", [{}])[0]
        main = data.get("main", {})
        wind = data.get("wind", {})
        rain = data.get("rain", {})
        clouds = data.get("clouds", {})

        unit_label = "°F" if units == "imperial" else "°C" if units == "metric" else "K"
        speed_label = "mph" if units == "imperial" else "m/s"

        return {
            "location":     data.get("name", location),
            "country":      data.get("sys", {}).get("country", ""),
            "description":  weather.get("description", ""),
            "icon":         weather.get("icon", ""),
            "temperature":  main.get("temp"),
            "feels_like":   main.get("feels_like"),
            "temp_high":    main.get("temp_max"),
            "temp_low":     main.get("temp_min"),
            "humidity":     main.get("humidity"),
            "pressure":     main.get("pressure"),
            "wind_speed":   wind.get("speed"),
            "wind_deg":     wind.get("deg"),
            "wind_gust":    wind.get("gust"),
            "clouds_pct":   clouds.get("all"),
            "rain_1h_mm":   rain.get("1h", 0),
            "visibility_m": data.get("visibility"),
            "units":        {"temp": unit_label, "speed": speed_label},
        }

    except Exception as exc:
        logger.error("[openweathermap] %s", exc)
        return _error(str(exc))
