"""
AURA Agent Template — ForecastingAgent
Time-series forecasting using statsmodels (ARIMA), scikit-learn (RandomForest),
and statistical decomposition. All computation is local — no external model APIs.

Registry ID: forecasting_v1
Category:    forecasting
Inputs:      ticker (str), series (list[float], optional), horizon (int), method (str)
Outputs:     ticker, forecast, confidence_interval, model_used, accuracy_metrics,
             narrative, training_sample
"""

from __future__ import annotations
import math
import time
from app.agents.base import BaseAgent


class ForecastingAgent(BaseAgent):
    """
    Generates price/indicator forecasts using multiple local statistical methods.

    Methods (auto-selected or user-specified):
        "arima"   — ARIMA(p,d,q) via statsmodels (best for economic series)
        "rf"      — Random Forest regression via scikit-learn (best for noisy data)
        "naive"   — Naïve seasonal / exponential smoothing (fast fallback)
        "auto"    — Tries all, picks best by AIC/RMSE

    Horizon: number of future periods to forecast (e.g., 5 = 5 bars ahead)
    """

    AGENT_ID     = "forecasting_v1"
    INPUTS       = ["ticker", "series", "horizon", "method"]
    OUTPUTS      = ["ticker", "forecast", "confidence_interval", "model_used",
                    "accuracy_metrics", "narrative", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = False
    FREE_TIER    = True

    _SYSTEM = (
        "You are a quantitative analyst specialising in time-series forecasting. "
        "Given a model's price forecast and its statistical metrics, write a concise "
        "probabilistic narrative: state the central forecast, describe the confidence "
        "range, note the key assumption, and rate forecast reliability. 3-4 sentences. No disclaimers."
    )

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "ticker")
        ticker  = inputs["ticker"].upper()
        horizon = int(inputs.get("horizon", 5))
        method  = inputs.get("method", "auto")

        # Obtain price series
        series = inputs.get("series", [])
        if not series:
            series = await self._fetch_series(ticker)
        if not series or len(series) < 20:
            return {"ticker": ticker, "error": "Insufficient data for forecasting (need ≥20 points)"}

        # Clean series
        series = [float(v) for v in series if v is not None and math.isfinite(float(v))]

        # Run forecast
        result = await self._forecast(series, horizon, method)
        forecast     = result["forecast"]
        ci           = result["confidence_interval"]
        model_used   = result["model"]
        metrics      = result["metrics"]

        # LLM narrative
        prompt    = self._build_prompt(ticker, series, forecast, ci, metrics, model_used, horizon)
        narrative = await self._llm(prompt, system=self._SYSTEM, temperature=0.4)

        # Training sample
        training_sample = {
            "ticker":      ticker,
            "series_len":  len(series),
            "horizon":     horizon,
            "model":       model_used,
            "forecast_1":  forecast[0] if forecast else None,
            "forecast_end": forecast[-1] if forecast else None,
            "rmse":        metrics.get("rmse"),
            "direction":   "up" if forecast and forecast[-1] > series[-1] else "down",
        }

        self.logger.info("[%s] %s → %s | horizon=%d model=%s rmse=%.4f",
                         self.AGENT_ID, ticker,
                         training_sample["direction"], horizon, model_used,
                         metrics.get("rmse", 0))

        return {
            "ticker":            ticker,
            "forecast":          forecast,
            "confidence_interval": ci,
            "model_used":        model_used,
            "accuracy_metrics":  metrics,
            "narrative":         narrative,
            "training_sample":   training_sample,
        }

    # ── DATA FETCH ────────────────────────────────────────────────────────────

    async def _fetch_series(self, ticker: str) -> list[float]:
        try:
            from app.service.finance_service import get_finance_service
            svc   = get_finance_service()
            quote = await svc.get_quote(ticker)
            ohlcv = quote.get("ohlcv", [])
            return [c["c"] for c in ohlcv if c.get("c")]
        except Exception as exc:
            self.logger.warning("[%s] series fetch failed: %s", self.AGENT_ID, exc)
            return []

    # ── FORECASTING ───────────────────────────────────────────────────────────

    async def _forecast(self, series: list[float], horizon: int, method: str) -> dict:
        """Dispatch to the appropriate forecasting method."""
        import asyncio

        if method == "arima":
            return await asyncio.to_thread(self._arima_forecast, series, horizon)
        if method == "rf":
            return await asyncio.to_thread(self._rf_forecast, series, horizon)
        if method == "naive":
            return self._naive_forecast(series, horizon)

        # Auto: try ARIMA → RF → naive, pick best RMSE
        results = []
        for m_name, m_fn in [
            ("arima", lambda: self._arima_forecast(series, horizon)),
            ("rf",    lambda: self._rf_forecast(series, horizon)),
        ]:
            try:
                r = await asyncio.to_thread(m_fn)
                r["model"] = m_name
                results.append(r)
            except Exception as exc:
                self.logger.debug("[%s] %s failed: %s", self.AGENT_ID, m_name, exc)

        if results:
            # Pick lowest RMSE (in-sample)
            results.sort(key=lambda x: x["metrics"].get("rmse", 1e9))
            return results[0]

        # Final fallback
        return self._naive_forecast(series, horizon)

    def _arima_forecast(self, series: list[float], horizon: int) -> dict:
        """ARIMA(2,1,2) via statsmodels. Returns forecast + 95% CI."""
        try:
            from statsmodels.tsa.arima.model import ARIMA
            import numpy as np
        except ImportError:
            return self._naive_forecast(series, horizon)

        arr = np.array(series)
        try:
            model  = ARIMA(arr, order=(2, 1, 2))
            fitted = model.fit()
            fcast  = fitted.get_forecast(steps=horizon)
            mean   = fcast.predicted_mean.tolist()
            ci_df  = fcast.conf_int(alpha=0.05)
            ci_lower = ci_df.iloc[:, 0].tolist()
            ci_upper = ci_df.iloc[:, 1].tolist()

            # In-sample RMSE on last 20% of data
            split    = max(5, int(len(arr) * 0.8))
            in_model = ARIMA(arr[:split], order=(2, 1, 2)).fit()
            preds    = in_model.predict(start=split, end=len(arr) - 1)
            actuals  = arr[split:]
            rmse     = float(np.sqrt(np.mean((preds - actuals) ** 2))) if len(preds) else 0.0

            return {
                "forecast": [round(v, 4) for v in mean],
                "confidence_interval": {
                    "lower": [round(v, 4) for v in ci_lower],
                    "upper": [round(v, 4) for v in ci_upper],
                },
                "model":   "arima_2_1_2",
                "metrics": {
                    "rmse": round(rmse, 4),
                    "aic":  round(fitted.aic, 2),
                    "bic":  round(fitted.bic, 2),
                },
            }
        except Exception as exc:
            self.logger.warning("[%s] ARIMA failed: %s — trying naive", self.AGENT_ID, exc)
            return self._naive_forecast(series, horizon)

    def _rf_forecast(self, series: list[float], horizon: int) -> dict:
        """Random Forest regression with lag features."""
        try:
            from sklearn.ensemble import RandomForestRegressor
            import numpy as np
        except ImportError:
            return self._naive_forecast(series, horizon)

        arr = np.array(series)
        lags = min(10, len(arr) // 3)
        if lags < 2:
            return self._naive_forecast(series, horizon)

        # Build lag feature matrix
        X, y = [], []
        for i in range(lags, len(arr)):
            X.append(arr[i - lags:i].tolist())
            y.append(arr[i])
        X, y = np.array(X), np.array(y)

        split  = max(5, int(len(X) * 0.8))
        rf     = RandomForestRegressor(n_estimators=50, random_state=42, n_jobs=1)
        rf.fit(X[:split], y[:split])

        # RMSE on validation split
        if split < len(X):
            preds = rf.predict(X[split:])
            rmse  = float(np.sqrt(np.mean((preds - y[split:]) ** 2)))
        else:
            rmse = 0.0

        # Rolling multi-step forecast
        window   = arr[-lags:].tolist()
        forecast = []
        for _ in range(horizon):
            pred = float(rf.predict([window])[0])
            forecast.append(round(pred, 4))
            window = window[1:] + [pred]

        # 95% CI approximation: ±1.96 * RMSE
        margin  = 1.96 * rmse
        ci_lower = [round(v - margin, 4) for v in forecast]
        ci_upper = [round(v + margin, 4) for v in forecast]

        return {
            "forecast": forecast,
            "confidence_interval": {"lower": ci_lower, "upper": ci_upper},
            "model":   f"random_forest_lags{lags}",
            "metrics": {"rmse": round(rmse, 4), "lags": lags},
        }

    def _naive_forecast(self, series: list[float], horizon: int) -> dict:
        """
        Naïve seasonal exponential smoothing fallback.
        Uses the last value + average drift over last 5 bars.
        """
        last  = series[-1]
        drift = (series[-1] - series[-min(6, len(series))]) / 5 if len(series) >= 6 else 0.0
        forecast = [round(last + drift * (i + 1), 4) for i in range(horizon)]

        # Std dev of last 20 bars as CI proxy
        window  = series[-20:]
        mean_w  = sum(window) / len(window)
        std_dev = math.sqrt(sum((v - mean_w) ** 2 for v in window) / len(window)) if len(window) > 1 else 0.0
        margin  = 1.96 * std_dev
        ci_lower = [round(v - margin, 4) for v in forecast]
        ci_upper = [round(v + margin, 4) for v in forecast]

        return {
            "forecast": forecast,
            "confidence_interval": {"lower": ci_lower, "upper": ci_upper},
            "model":   "naive_drift",
            "metrics": {"rmse": round(std_dev, 4)},
        }

    # ── PROMPT ────────────────────────────────────────────────────────────────

    def _build_prompt(
        self,
        ticker: str,
        series: list[float],
        forecast: list[float],
        ci:      dict,
        metrics: dict,
        model:   str,
        horizon: int,
    ) -> str:
        last   = series[-1] if series else 0.0
        fcast1 = forecast[0] if forecast else last
        fcast_end = forecast[-1] if forecast else last
        pct_chg = (fcast_end - last) / last * 100 if last else 0

        return f"""TIME-SERIES FORECAST — {ticker}

Current Price: {last:.4f}
Forecast Horizon: {horizon} bars
Model: {model}

Forecast Path: {[round(v, 2) for v in forecast]}
Next Bar: {fcast1:.4f}  |  End of Horizon: {fcast_end:.4f}  ({pct_chg:+.2f}%)

95% Confidence Interval:
  Lower: {ci.get('lower', [])}
  Upper: {ci.get('upper', [])}

Model Accuracy (in-sample):
  RMSE: {metrics.get('rmse', 'N/A')}
  AIC:  {metrics.get('aic', 'N/A')}

Recent series (last 10): {[round(v, 2) for v in series[-10:]]}

Write a probabilistic forecast narrative:"""
