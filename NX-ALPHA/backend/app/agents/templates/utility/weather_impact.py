"""
AURA Agent Template — WeatherImpactAgent
Maps current and forecast weather conditions to commodity, energy, and
agricultural market impacts. Uses local LLM to generate impact analysis.

Registry ID: weather_impact_v1
Category:    utility
Inputs:      locations (list[dict], optional), weather_data (dict, optional)
Outputs:     impact_map, affected_markets, alert_level, narrative, training_sample
"""

from __future__ import annotations
from app.agents.base import BaseAgent


# Known weather → market impact correlations
# Structure: { "condition": { "market": "description" } }
WEATHER_MARKET_MAP = {
    "severe": {
        "Natural Gas":   "Demand spike — heating/cooling load surge",
        "Crude Oil":     "Refinery disruption risk, transport delays",
        "Corn":          "Crop damage risk in agricultural regions",
        "Soybeans":      "Harvest disruption possible",
        "Wheat":         "Supply shock risk if affecting grain belt",
        "Power Grid":    "Peak demand + infrastructure stress",
        "Insurance":     "CAT event pricing, reinsurance repricing",
        "Lumber":        "Wind damage → rebuilding demand spike",
    },
    "watch": {
        "Natural Gas":   "Elevated heating/cooling demand possible",
        "Agriculture":   "Monitor crop stress indicators",
        "Shipping":      "Port delays, route modifications possible",
    },
    "winter_storm": {
        "Natural Gas":   "Strong demand spike — heating",
        "Crude Oil":     "Demand up for heating oil, transport disruption",
        "Wheat":         "Winter wheat damage possible",
        "Retail":        "Consumer spending disruption (foot traffic)",
        "Airlines":      "Flight cancellations, revenue impact",
        "Road Freight":  "Delivery delays, logistics cost spike",
    },
    "drought": {
        "Corn":          "Yield reduction — supply shock",
        "Soybeans":      "Acreage stress — price upside risk",
        "Wheat":         "Winter crop stress",
        "Cotton":        "Yield reduction",
        "Natural Gas":   "Hydropower shortage → gas demand increase",
        "Utilities":     "Water availability for cooling towers",
    },
    "heat_wave": {
        "Natural Gas":   "Cooling demand — power sector gas burn",
        "Electricity":   "Record demand peaks, grid stress",
        "Agriculture":   "Livestock heat stress, crop transpiration",
        "Retail":        "Consumer traffic boost (AC-intensive venues)",
    },
    "hurricane": {
        "Crude Oil":     "Gulf of Mexico production shut-ins",
        "Natural Gas":   "LNG export terminal disruption",
        "Refining":      "Refinery shutdowns (Gulf Coast focus)",
        "Insurance":     "Catastrophe loss exposure",
        "Construction":  "Rebuilding demand post-event",
        "Timber/Lumber": "Storm damage rebuilding surge",
    },
    "flood": {
        "Agriculture":   "Crop field flooding, harvest delays",
        "Shipping":      "River transport disruption",
        "Coal":          "Mine flooding potential",
        "Insurance":     "Flood claims spike",
    },
}

# Commodity futures tickers for cross-referencing
COMMODITY_TICKERS = {
    "Natural Gas": "NG=F",
    "Crude Oil":   "CL=F",
    "Corn":        "ZC=F",
    "Soybeans":    "ZS=F",
    "Wheat":       "ZW=F",
    "Cotton":      "CT=F",
    "Gold":        "GC=F",
    "Silver":      "SI=F",
}


class WeatherImpactAgent(BaseAgent):
    """
    Fetches weather data for key financial/agricultural hubs, identifies
    market-moving weather conditions, and produces an impact analysis.

    Training value: builds weather → market correlation patterns for the
    local model's understanding of macro-level commodity drivers.
    """

    AGENT_ID     = "weather_impact_v1"
    INPUTS       = ["locations", "weather_data"]
    OUTPUTS      = ["impact_map", "affected_markets", "alert_level", "narrative", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    _SYSTEM = (
        "You are a commodity market analyst specialising in weather-driven market impacts. "
        "Given current weather conditions and their classifications, describe the likely "
        "market impacts: which commodities are affected, in which direction, and how "
        "urgently traders should monitor the situation. "
        "Be specific with commodity names and price direction. Max 5 sentences."
    )

    async def run(self, inputs: dict) -> dict:
        locations    = inputs.get("locations")
        weather_data = inputs.get("weather_data")

        # Fetch weather if not provided
        if not weather_data:
            weather_data = await self._fetch_weather(locations)

        if not weather_data:
            return {
                "impact_map":      {},
                "affected_markets": [],
                "alert_level":     "normal",
                "narrative":       "Weather data unavailable.",
                "training_sample": {},
            }

        # Classify conditions and map to markets
        impact_map      = {}
        affected_markets: list[dict] = []
        max_alert       = "normal"

        for location_data in weather_data if isinstance(weather_data, list) else [weather_data]:
            loc_name = location_data.get("location", {}).get("name", "Unknown")
            current  = location_data.get("current", {})
            forecast = location_data.get("forecast", [])
            impact   = location_data.get("impact", "normal")

            # Classify specific weather type
            weather_type = self._classify_weather_type(current, forecast)
            alert_level  = impact  # "severe", "watch", or "normal"

            if self._alert_rank(alert_level) > self._alert_rank(max_alert):
                max_alert = alert_level

            # Map weather type to market impacts
            market_impacts = {}
            for wtype in [weather_type, alert_level]:
                if wtype in WEATHER_MARKET_MAP:
                    for market, desc in WEATHER_MARKET_MAP[wtype].items():
                        market_impacts[market] = {
                            "description": desc,
                            "ticker":      COMMODITY_TICKERS.get(market),
                            "urgency":     alert_level,
                        }
                        if not any(a["market"] == market for a in affected_markets):
                            affected_markets.append({
                                "market":    market,
                                "ticker":    COMMODITY_TICKERS.get(market),
                                "impact":    desc,
                                "location":  loc_name,
                                "urgency":   alert_level,
                                "direction": self._infer_direction(market, weather_type),
                            })

            impact_map[loc_name] = {
                "alert":        alert_level,
                "weather_type": weather_type,
                "temp":         current.get("temperature_2m"),
                "wind":         current.get("wind_speed_10m"),
                "condition":    current.get("weather_text"),
                "markets":      market_impacts,
                "forecast_3day": forecast[:3],
            }

        # Build LLM prompt
        prompt    = self._build_prompt(impact_map, affected_markets, max_alert)
        narrative = await self._llm(prompt, system=self._SYSTEM, temperature=0.4)

        # Training sample
        training_sample = {
            "alert_level":      max_alert,
            "locations_checked": len(impact_map),
            "markets_affected": len(affected_markets),
            "affected_tickers": [a["ticker"] for a in affected_markets if a.get("ticker")],
            "weather_types":    list({d.get("weather_type") for d in impact_map.values()}),
        }

        self.logger.info("[%s] alert=%s affecting %d markets across %d locations",
                         self.AGENT_ID, max_alert, len(affected_markets), len(impact_map))

        return {
            "impact_map":      impact_map,
            "affected_markets": affected_markets,
            "alert_level":     max_alert,
            "narrative":       narrative,
            "training_sample": training_sample,
        }

    async def _fetch_weather(self, locations: list[dict] | None) -> list[dict]:
        try:
            from app.agents.tools.streaming import get_stream_manager
            mgr    = get_stream_manager()
            stream = mgr.get("weather")
            if stream:
                # Trigger a single fetch directly
                return await stream._fetch()  # type: ignore[attr-defined]

            # Fallback: fetch directly from weather service
            from app.service.weather_service import get_weather_service
            svc = get_weather_service()
            if svc is None:
                return []

            default_locs = locations or [
                {"lat": 40.7128, "lon": -74.0060, "name": "New York"},
                {"lat": 41.8781, "lon": -87.6298, "name": "Chicago"},
                {"lat": 29.7604, "lon": -95.3698, "name": "Houston"},
                {"lat": 41.6611, "lon": -91.5302, "name": "Iowa City"},
            ]
            results = []
            for loc in default_locs:
                lat, lon, name = loc["lat"], loc["lon"], loc.get("name", "")
                current  = await svc.get_current(lat, lon)
                forecast = await svc.get_forecast(lat, lon, days=7)
                if current:
                    results.append({
                        "location": {"lat": lat, "lon": lon, "name": name},
                        "current":  current,
                        "forecast": forecast,
                        "impact":   "normal",
                    })
            return results
        except Exception as exc:
            self.logger.warning("[%s] weather fetch failed: %s", self.AGENT_ID, exc)
            return []

    def _classify_weather_type(self, current: dict, forecast: list[dict]) -> str:
        code = current.get("weather_code", 0) or 0
        wind = current.get("wind_speed_10m", 0) or 0
        temp = current.get("temperature_2m", 20) or 20

        if code >= 95:                  return "hurricane" if wind > 60 else "severe"
        if code in (71, 73, 75, 77):   return "winter_storm"
        if temp > 35:                   return "heat_wave"
        if code in (61, 63, 65, 80, 81, 82): return "flood" if code >= 80 else "normal"
        if wind > 60:                   return "hurricane"

        # Check forecast
        for day in forecast[:3]:
            if (day.get("precipitation_sum") or 0) > 50:
                return "flood"

        return "normal"

    def _alert_rank(self, level: str) -> int:
        return {"normal": 0, "watch": 1, "severe": 2}.get(level, 0)

    def _infer_direction(self, market: str, weather_type: str) -> str:
        bullish_conditions = {
            ("Natural Gas", "winter_storm"), ("Natural Gas", "heat_wave"),
            ("Natural Gas", "severe"), ("Crude Oil", "hurricane"),
            ("Insurance", "severe"), ("Insurance", "hurricane"),
            ("Lumber", "hurricane"), ("Construction", "hurricane"),
        }
        bearish_conditions = {
            ("Agriculture", "drought"), ("Corn", "drought"),
            ("Corn", "flood"), ("Airlines", "winter_storm"),
            ("Retail", "winter_storm"),
        }
        key = (market, weather_type)
        if key in bullish_conditions: return "bullish"
        if key in bearish_conditions: return "bearish"
        return "watch"

    def _build_prompt(self, impact_map: dict, affected_markets: list[dict], alert: str) -> str:
        lines = [
            f"WEATHER-MARKET IMPACT ANALYSIS",
            f"Alert Level: {alert.upper()}",
            "",
            "Location Summaries:",
        ]
        for loc, data in impact_map.items():
            lines.append(
                f"  {loc}: {data.get('condition')} | temp={data.get('temp')}°C | "
                f"wind={data.get('wind')}km/h | type={data.get('weather_type')} | alert={data.get('alert')}"
            )
        lines.append("\nAffected Markets:")
        for m in affected_markets[:10]:
            lines.append(
                f"  {m['market']} ({m.get('ticker','N/A')}): {m['impact']} "
                f"[{m.get('direction','?')}] — from {m.get('location')}"
            )
        lines.append("\nGenerate market impact analysis:")
        return "\n".join(lines)
