"""
AURA Agent Template — EconomicScheduler
Fetches and caches economic indicator data on a schedule.
Monitors FRED release calendar and pulls fresh data when releases drop.

Registry ID: economic_scheduler_v1
Category:    data
Inputs:      series_ids (list[str], optional), force_refresh (bool)
Outputs:     indicators (dict), release_calendar (list), snapshot_ts (float)
"""

from __future__ import annotations
import time
from app.agents.base import BaseAgent

# Default indicator set — the 15 most market-moving series
DEFAULT_SERIES = [
    ("GDP",       "q",  "Gross Domestic Product"),
    ("CPIAUCSL",  "m",  "CPI All Urban Consumers"),
    ("FEDFUNDS",  "m",  "Federal Funds Rate"),
    ("UNRATE",    "m",  "Unemployment Rate"),
    ("DGS10",     "d",  "10-Year Treasury Yield"),
    ("T10Y2Y",    "d",  "10Y-2Y Yield Spread"),
    ("VIXCLS",    "d",  "VIX Volatility Index"),
    ("M2SL",      "m",  "M2 Money Supply"),
    ("HOUST",     "m",  "Housing Starts"),
    ("RSAFS",     "m",  "Retail Sales"),
    ("INDPRO",    "m",  "Industrial Production"),
    ("PCE",       "m",  "Personal Consumption Expenditures"),
    ("UMCSENT",   "m",  "Univ. of Michigan Consumer Sentiment"),
    ("BAMLH0A0HYM2", "d", "High Yield Credit Spread"),
    ("DTWEXBGS",  "d",  "US Dollar Index (Broad)"),
]


class EconomicScheduler(BaseAgent):
    """
    Pulls economic indicator data from FRED (and BLS for labour stats).
    Results are cached in-process; force_refresh=True bypasses the cache.

    Also fetches upcoming release dates so the Planner can schedule
    re-runs at the right times rather than polling continuously.
    """

    AGENT_ID     = "economic_scheduler_v1"
    INPUTS       = ["series_ids", "force_refresh"]
    OUTPUTS      = ["indicators", "release_calendar", "snapshot_ts"]
    REQUIRES_LLM = False
    REAL_TIME    = False
    FREE_TIER    = True

    # In-process cache: series_id → (timestamp, data)
    _cache: dict[str, tuple[float, dict]] = {}
    _CACHE_TTL = 3600  # 1 hour

    async def run(self, inputs: dict) -> dict:
        series_input   = inputs.get("series_ids")
        force_refresh  = bool(inputs.get("force_refresh", False))

        # Build the series list
        if series_input:
            series_list = [(sid, "m", sid) for sid in series_input]
        else:
            series_list = DEFAULT_SERIES

        from app.agents.tools.free_sources import get_free_sources
        fs = get_free_sources()

        indicators: dict[str, dict] = {}
        now = time.monotonic()

        for series_id, freq, label in series_list:
            # Cache check
            if not force_refresh and series_id in self._cache:
                ts, cached_data = self._cache[series_id]
                if (now - ts) < self._CACHE_TTL:
                    indicators[series_id] = cached_data
                    continue

            data = await fs.fred_series(series_id, frequency=freq, limit=24)
            obs  = data.get("observations", [])

            # Latest value + trend (compare last 2 readings)
            latest_val = obs[0]["value"] if obs else None
            prev_val   = obs[1]["value"] if len(obs) > 1 else None
            trend      = None
            if latest_val is not None and prev_val is not None:
                diff = latest_val - prev_val
                trend = "rising" if diff > 0 else "falling" if diff < 0 else "flat"

            entry = {
                "series_id":  series_id,
                "label":      label,
                "latest":     latest_val,
                "latest_date": obs[0]["date"] if obs else None,
                "prev":       prev_val,
                "trend":      trend,
                "history":    obs[:12],  # last 12 readings for training
            }
            indicators[series_id] = entry
            self._cache[series_id] = (now, entry)

        # BLS supplement — labour stats
        try:
            bls_data = await fs.bls_series(
                series_ids=["CES0000000001", "LNS14000000"],  # payrolls + unemployment
                start_year="2022",
            )
            for sid, rows in bls_data.items():
                if rows:
                    latest = rows[0]
                    indicators[f"BLS_{sid}"] = {
                        "series_id":   sid,
                        "label":       "Nonfarm Payrolls" if "CES" in sid else "BLS Unemployment",
                        "latest":      latest.get("value"),
                        "latest_date": f"{latest.get('year')}-{latest.get('period')}",
                        "history":     rows[:12],
                    }
        except Exception as exc:
            self.logger.warning("[%s] BLS fetch failed: %s", self.AGENT_ID, exc)

        # Release calendar
        release_calendar = await fs.fred_release_dates(limit=15)

        self.logger.info("[%s] loaded %d indicators, %d upcoming releases",
                         self.AGENT_ID, len(indicators), len(release_calendar))

        return {
            "indicators":       indicators,
            "release_calendar": release_calendar,
            "snapshot_ts":      time.time(),
        }
