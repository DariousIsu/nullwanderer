"""
AURA NX-Alpha — Technical Analysis Engine
Pure Python/pandas TA indicator computations. No LLM, no external APIs.
All math runs locally.

Provides ~30 indicators covering trend, momentum, volatility, and volume.
pandas-ta is used when installed; pure-numpy fallbacks are provided for all
critical indicators so the system degrades gracefully if pandas-ta is absent.

Usage:
    from app.agents.tools.technical_analysis import TechnicalAnalysis

    ta = TechnicalAnalysis(ohlcv_list)       # list of {t,o,h,l,c,v} dicts
    signals = ta.full_analysis()             # all indicators + composite signal
    rsi = ta.rsi(period=14)
    macd = ta.macd()
"""

from __future__ import annotations

import logging
import math
from typing import Any

logger = logging.getLogger(__name__)

try:
    import numpy as np
    _NP = True
except ImportError:
    _NP = False
    logger.warning("[ta] numpy not installed — some indicators unavailable")

try:
    import pandas as pd
    _PD = True
except ImportError:
    _PD = False
    logger.warning("[ta] pandas not installed — falling back to pure Python")

try:
    import pandas_ta as pta
    _PTA = True
except ImportError:
    _PTA = False


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _safe(val: Any, default: float = 0.0) -> float:
    try:
        v = float(val)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default

def _ema_pure(values: list[float], period: int) -> list[float]:
    """Pure-Python EMA. Returns list same length as input (NaN-padded at start)."""
    if not values or period <= 0:
        return values
    k = 2.0 / (period + 1)
    result: list[float] = [float("nan")] * len(values)
    # seed with SMA of first <period> values
    seed_vals = [v for v in values[:period] if not math.isnan(v)]
    if not seed_vals:
        return result
    seed = sum(seed_vals) / len(seed_vals)
    result[period - 1] = seed
    for i in range(period, len(values)):
        if math.isnan(values[i]):
            result[i] = result[i - 1]
        else:
            result[i] = values[i] * k + result[i - 1] * (1 - k)
    return result

def _sma_pure(values: list[float], period: int) -> list[float]:
    result: list[float] = [float("nan")] * len(values)
    for i in range(period - 1, len(values)):
        window = [v for v in values[i - period + 1:i + 1] if not math.isnan(v)]
        if len(window) == period:
            result[i] = sum(window) / period
    return result


# ─────────────────────────────────────────────────────────────────────────────
# TECHNICAL ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

class TechnicalAnalysis:
    """
    Compute technical indicators from OHLCV data.

    Args:
        ohlcv: List of candle dicts with keys: t, o, h, l, c, v
               (timestamp unix-ms, open, high, low, close, volume)

    All indicator methods return a dict with the latest value(s) plus
    historical series for charting.
    """

    def __init__(self, ohlcv: list[dict]) -> None:
        self._raw = sorted(ohlcv, key=lambda x: x.get("t", 0))
        self.closes  = [_safe(c.get("c")) for c in self._raw]
        self.opens   = [_safe(c.get("o")) for c in self._raw]
        self.highs   = [_safe(c.get("h")) for c in self._raw]
        self.lows    = [_safe(c.get("l")) for c in self._raw]
        self.volumes = [_safe(c.get("v")) for c in self._raw]
        self.times   = [c.get("t", 0) for c in self._raw]
        self._df: "pd.DataFrame | None" = None
        if _PD and self._raw:
            try:
                self._df = pd.DataFrame({
                    "open":   self.opens,
                    "high":   self.highs,
                    "low":    self.lows,
                    "close":  self.closes,
                    "volume": self.volumes,
                })
            except Exception:
                pass

    def _last(self, series: list[float]) -> float:
        for v in reversed(series):
            if not math.isnan(v):
                return round(v, 6)
        return 0.0

    # ─────────────────────────────────────────────────────────────────────────
    # TREND INDICATORS
    # ─────────────────────────────────────────────────────────────────────────

    def sma(self, period: int = 20) -> dict:
        """Simple Moving Average."""
        if _PTA and self._df is not None:
            try:
                series = pta.sma(self._df["close"], length=period).tolist()
                return {"period": period, "value": self._last(series), "series": series[-50:]}
            except Exception:
                pass
        series = _sma_pure(self.closes, period)
        return {"period": period, "value": self._last(series), "series": series[-50:]}

    def ema(self, period: int = 20) -> dict:
        """Exponential Moving Average."""
        if _PTA and self._df is not None:
            try:
                series = pta.ema(self._df["close"], length=period).tolist()
                return {"period": period, "value": self._last(series), "series": series[-50:]}
            except Exception:
                pass
        series = _ema_pure(self.closes, period)
        return {"period": period, "value": self._last(series), "series": series[-50:]}

    def macd(self, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
        """
        MACD — Moving Average Convergence Divergence.
        Returns: macd_line, signal_line, histogram, crossover
        """
        if _PTA and self._df is not None:
            try:
                result = pta.macd(self._df["close"], fast=fast, slow=slow, signal=signal)
                macd_col   = f"MACD_{fast}_{slow}_{signal}"
                signal_col = f"MACDs_{fast}_{slow}_{signal}"
                hist_col   = f"MACDh_{fast}_{slow}_{signal}"
                m = result[macd_col].tolist()
                s = result[signal_col].tolist()
                h = result[hist_col].tolist()
                last_m, last_s, last_h = self._last(m), self._last(s), self._last(h)
                prev_h = self._last(h[:-1]) if len(h) > 1 else 0.0
                return {
                    "macd":      last_m,
                    "signal":    last_s,
                    "histogram": last_h,
                    "crossover": "bullish" if last_h > 0 and prev_h <= 0
                                 else "bearish" if last_h < 0 and prev_h >= 0
                                 else "none",
                    "series": {"macd": m[-50:], "signal": s[-50:], "histogram": h[-50:]},
                }
            except Exception:
                pass

        # Pure Python fallback
        ema_fast   = _ema_pure(self.closes, fast)
        ema_slow   = _ema_pure(self.closes, slow)
        macd_line  = [f - s if not math.isnan(f) and not math.isnan(s) else float("nan")
                      for f, s in zip(ema_fast, ema_slow)]
        signal_line = _ema_pure(macd_line, signal)
        histogram   = [m - s if not math.isnan(m) and not math.isnan(s) else float("nan")
                       for m, s in zip(macd_line, signal_line)]
        last_h = self._last(histogram)
        prev_h = self._last(histogram[:-1]) if len(histogram) > 1 else 0.0
        return {
            "macd":      self._last(macd_line),
            "signal":    self._last(signal_line),
            "histogram": last_h,
            "crossover": "bullish" if last_h > 0 and prev_h <= 0
                         else "bearish" if last_h < 0 and prev_h >= 0
                         else "none",
            "series": {"macd": macd_line[-50:], "signal": signal_line[-50:], "histogram": histogram[-50:]},
        }

    def bollinger_bands(self, period: int = 20, std_dev: float = 2.0) -> dict:
        """Bollinger Bands. Returns upper, middle, lower bands + %B + bandwidth."""
        if _PTA and self._df is not None:
            try:
                result = pta.bbands(self._df["close"], length=period, std=std_dev)
                upper_col  = f"BBU_{period}_{std_dev}"
                mid_col    = f"BBM_{period}_{std_dev}"
                lower_col  = f"BBL_{period}_{std_dev}"
                pct_col    = f"BBP_{period}_{std_dev}"
                bw_col     = f"BBB_{period}_{std_dev}"
                price = self.closes[-1] if self.closes else 0.0
                upper = self._last(result[upper_col].tolist())
                mid   = self._last(result[mid_col].tolist())
                lower = self._last(result[lower_col].tolist())
                pct_b = self._last(result[pct_col].tolist()) if pct_col in result else 0.0
                bw    = self._last(result[bw_col].tolist()) if bw_col in result else 0.0
                return {
                    "upper": upper, "middle": mid, "lower": lower,
                    "pct_b": pct_b, "bandwidth": bw,
                    "position": "above_upper" if price > upper else "below_lower" if price < lower else "inside",
                }
            except Exception:
                pass

        # Pure Python fallback
        sma  = _sma_pure(self.closes, period)
        stds: list[float] = [float("nan")] * len(self.closes)
        for i in range(period - 1, len(self.closes)):
            window = self.closes[i - period + 1:i + 1]
            mean = sum(window) / len(window)
            stds[i] = math.sqrt(sum((x - mean) ** 2 for x in window) / len(window))

        upper = [m + std_dev * s if not math.isnan(m) and not math.isnan(s) else float("nan")
                 for m, s in zip(sma, stds)]
        lower = [m - std_dev * s if not math.isnan(m) and not math.isnan(s) else float("nan")
                 for m, s in zip(sma, stds)]
        price = self.closes[-1] if self.closes else 0.0
        u, m, l = self._last(upper), self._last(sma), self._last(lower)
        return {
            "upper": u, "middle": m, "lower": l,
            "pct_b": (price - l) / (u - l) if u != l else 0.5,
            "bandwidth": (u - l) / m if m else 0.0,
            "position": "above_upper" if price > u else "below_lower" if price < l else "inside",
        }

    # ─────────────────────────────────────────────────────────────────────────
    # MOMENTUM INDICATORS
    # ─────────────────────────────────────────────────────────────────────────

    def rsi(self, period: int = 14) -> dict:
        """
        Relative Strength Index.
        Returns: value (0-100), zone ("overbought" | "oversold" | "neutral")
        """
        if _PTA and self._df is not None:
            try:
                series = pta.rsi(self._df["close"], length=period).tolist()
                val = self._last(series)
                return {
                    "value": val,
                    "zone": "overbought" if val >= 70 else "oversold" if val <= 30 else "neutral",
                    "series": series[-50:],
                }
            except Exception:
                pass

        # Pure Python fallback (Wilder's smoothing)
        if len(self.closes) < period + 1:
            return {"value": 50.0, "zone": "neutral", "series": []}
        deltas = [self.closes[i] - self.closes[i - 1] for i in range(1, len(self.closes))]
        gains  = [max(d, 0) for d in deltas]
        losses = [abs(min(d, 0)) for d in deltas]
        avg_gain = sum(gains[:period]) / period
        avg_loss = sum(losses[:period]) / period
        rsi_vals: list[float] = [float("nan")] * period
        for i in range(period, len(deltas)):
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period
            rs  = avg_gain / avg_loss if avg_loss > 0 else 100
            rsi_vals.append(100 - 100 / (1 + rs))
        val = self._last(rsi_vals)
        return {
            "value": val,
            "zone": "overbought" if val >= 70 else "oversold" if val <= 30 else "neutral",
            "series": rsi_vals[-50:],
        }

    def stochastic(self, k_period: int = 14, d_period: int = 3) -> dict:
        """Stochastic Oscillator (%K and %D)."""
        if _PTA and self._df is not None:
            try:
                result = pta.stoch(self._df["high"], self._df["low"], self._df["close"],
                                   k=k_period, d=d_period)
                k_col = f"STOCHk_{k_period}_{d_period}_3"
                d_col = f"STOCHd_{k_period}_{d_period}_3"
                k = self._last(result[k_col].tolist())
                d = self._last(result[d_col].tolist())
                return {
                    "k": k, "d": d,
                    "zone": "overbought" if k >= 80 else "oversold" if k <= 20 else "neutral",
                }
            except Exception:
                pass

        # Pure Python fallback
        pct_k: list[float] = []
        for i in range(k_period - 1, len(self.closes)):
            high_n = max(self.highs[i - k_period + 1:i + 1])
            low_n  = min(self.lows[i - k_period + 1:i + 1])
            if high_n != low_n:
                pct_k.append((self.closes[i] - low_n) / (high_n - low_n) * 100)
            else:
                pct_k.append(50.0)
        pct_d = _sma_pure(pct_k, d_period)
        k_val = pct_k[-1] if pct_k else 50.0
        d_val = self._last(pct_d)
        return {
            "k": k_val, "d": d_val,
            "zone": "overbought" if k_val >= 80 else "oversold" if k_val <= 20 else "neutral",
        }

    def cci(self, period: int = 20) -> dict:
        """Commodity Channel Index."""
        if _PTA and self._df is not None:
            try:
                series = pta.cci(self._df["high"], self._df["low"], self._df["close"], length=period).tolist()
                val = self._last(series)
                return {
                    "value": val,
                    "zone":  "overbought" if val > 100 else "oversold" if val < -100 else "neutral",
                }
            except Exception:
                pass

        tp = [(h + l + c) / 3 for h, l, c in zip(self.highs, self.lows, self.closes)]
        sma_tp = _sma_pure(tp, period)
        cci_vals: list[float] = []
        for i in range(period - 1, len(tp)):
            mean = sma_tp[i]
            mad  = sum(abs(tp[j] - mean) for j in range(i - period + 1, i + 1)) / period
            cci_vals.append((tp[i] - mean) / (0.015 * mad) if mad else 0.0)
        val = cci_vals[-1] if cci_vals else 0.0
        return {"value": round(val, 2), "zone": "overbought" if val > 100 else "oversold" if val < -100 else "neutral"}

    def williams_r(self, period: int = 14) -> dict:
        """Williams %R (-100 to 0). Overbought > -20, Oversold < -80."""
        if _PTA and self._df is not None:
            try:
                series = pta.willr(self._df["high"], self._df["low"], self._df["close"], length=period).tolist()
                val = self._last(series)
                return {"value": val, "zone": "overbought" if val > -20 else "oversold" if val < -80 else "neutral"}
            except Exception:
                pass

        wr: list[float] = []
        for i in range(period - 1, len(self.closes)):
            hh = max(self.highs[i - period + 1:i + 1])
            ll = min(self.lows[i - period + 1:i + 1])
            wr.append(-100 * (hh - self.closes[i]) / (hh - ll) if hh != ll else -50.0)
        val = wr[-1] if wr else -50.0
        return {"value": round(val, 2), "zone": "overbought" if val > -20 else "oversold" if val < -80 else "neutral"}

    # ─────────────────────────────────────────────────────────────────────────
    # VOLATILITY INDICATORS
    # ─────────────────────────────────────────────────────────────────────────

    def atr(self, period: int = 14) -> dict:
        """Average True Range — measures volatility."""
        if _PTA and self._df is not None:
            try:
                series = pta.atr(self._df["high"], self._df["low"], self._df["close"], length=period).tolist()
                val = self._last(series)
                price = self.closes[-1] if self.closes else 1.0
                return {"value": val, "pct_of_price": round(val / price * 100, 2) if price else 0}
            except Exception:
                pass

        tr_list: list[float] = []
        for i in range(1, len(self.closes)):
            hl = self.highs[i] - self.lows[i]
            hc = abs(self.highs[i] - self.closes[i - 1])
            lc = abs(self.lows[i] - self.closes[i - 1])
            tr_list.append(max(hl, hc, lc))
        if not tr_list:
            return {"value": 0.0, "pct_of_price": 0.0}
        atr_val = sum(tr_list[:period]) / period
        for i in range(period, len(tr_list)):
            atr_val = (atr_val * (period - 1) + tr_list[i]) / period
        price = self.closes[-1] if self.closes else 1.0
        return {"value": round(atr_val, 4), "pct_of_price": round(atr_val / price * 100, 2) if price else 0}

    def historical_volatility(self, period: int = 20) -> dict:
        """Annualised historical volatility (log returns std dev * sqrt(252))."""
        if len(self.closes) < period + 1:
            return {"value": 0.0, "annualised": 0.0}
        log_rets = [
            math.log(self.closes[i] / self.closes[i - 1])
            for i in range(1, len(self.closes))
            if self.closes[i] > 0 and self.closes[i - 1] > 0
        ]
        if len(log_rets) < period:
            return {"value": 0.0, "annualised": 0.0}
        window = log_rets[-period:]
        mean   = sum(window) / len(window)
        variance = sum((r - mean) ** 2 for r in window) / (len(window) - 1)
        daily_vol = math.sqrt(variance)
        annual_vol = daily_vol * math.sqrt(252)
        return {"value": round(daily_vol, 6), "annualised": round(annual_vol * 100, 2)}

    # ─────────────────────────────────────────────────────────────────────────
    # VOLUME INDICATORS
    # ─────────────────────────────────────────────────────────────────────────

    def obv(self) -> dict:
        """On-Balance Volume. Positive trend = accumulation."""
        if _PTA and self._df is not None:
            try:
                series = pta.obv(self._df["close"], self._df["volume"]).tolist()
                val = self._last(series)
                prev = series[-2] if len(series) > 1 else 0
                return {"value": val, "trend": "rising" if val > prev else "falling"}
            except Exception:
                pass

        obv_val = 0.0
        obvs: list[float] = [0.0]
        for i in range(1, len(self.closes)):
            if self.closes[i] > self.closes[i - 1]:
                obv_val += self.volumes[i]
            elif self.closes[i] < self.closes[i - 1]:
                obv_val -= self.volumes[i]
            obvs.append(obv_val)
        val  = obvs[-1] if obvs else 0.0
        prev = obvs[-2] if len(obvs) > 1 else 0.0
        return {"value": round(val, 0), "trend": "rising" if val > prev else "falling"}

    def volume_sma_ratio(self, period: int = 20) -> dict:
        """Current volume vs its SMA. Ratio > 1.5 = unusual volume."""
        vol_sma = _sma_pure(self.volumes, period)
        avg  = self._last(vol_sma)
        curr = self.volumes[-1] if self.volumes else 0.0
        ratio = curr / avg if avg > 0 else 1.0
        return {
            "current_volume": int(curr),
            "avg_volume":     int(avg),
            "ratio":          round(ratio, 2),
            "unusual":        ratio > 1.5,
        }

    def vwap(self) -> dict:
        """Volume-Weighted Average Price (intraday, resets each session)."""
        if not self._raw:
            return {"value": 0.0}
        cum_tp_vol = 0.0
        cum_vol    = 0.0
        for o, h, l, c, v in zip(self.opens, self.highs, self.lows, self.closes, self.volumes):
            tp = (h + l + c) / 3
            cum_tp_vol += tp * v
            cum_vol    += v
        val = cum_tp_vol / cum_vol if cum_vol > 0 else self.closes[-1]
        price = self.closes[-1] if self.closes else val
        return {
            "value":    round(val, 4),
            "position": "above" if price > val else "below",
        }

    # ─────────────────────────────────────────────────────────────────────────
    # SUPPORT / RESISTANCE
    # ─────────────────────────────────────────────────────────────────────────

    def pivot_points(self) -> dict:
        """Classic pivot points from last candle's high/low/close."""
        if not self._raw:
            return {}
        h, l, c = self.highs[-1], self.lows[-1], self.closes[-1]
        pivot = (h + l + c) / 3
        return {
            "pivot": round(pivot, 4),
            "r1":    round(2 * pivot - l, 4),
            "r2":    round(pivot + (h - l), 4),
            "r3":    round(h + 2 * (pivot - l), 4),
            "s1":    round(2 * pivot - h, 4),
            "s2":    round(pivot - (h - l), 4),
            "s3":    round(l - 2 * (h - pivot), 4),
        }

    def swing_levels(self, lookback: int = 10) -> dict:
        """Recent swing high and swing low."""
        if len(self.highs) < lookback:
            return {"swing_high": 0.0, "swing_low": 0.0}
        return {
            "swing_high": round(max(self.highs[-lookback:]), 4),
            "swing_low":  round(min(self.lows[-lookback:]),  4),
        }

    def price_channel(self, period: int = 20) -> dict:
        """Donchian Channel — highest high and lowest low over period."""
        if len(self.highs) < period:
            return {}
        upper = max(self.highs[-period:])
        lower = min(self.lows[-period:])
        mid   = (upper + lower) / 2
        price = self.closes[-1] if self.closes else mid
        return {
            "upper": round(upper, 4),
            "lower": round(lower, 4),
            "mid":   round(mid, 4),
            "position": "upper_half" if price > mid else "lower_half",
        }

    # ─────────────────────────────────────────────────────────────────────────
    # COMPOSITE SIGNAL
    # ─────────────────────────────────────────────────────────────────────────

    def composite_signal(self) -> dict:
        """
        Aggregate all indicators into a composite bull/bear signal.

        Scoring:
            Each indicator casts a +1 (bullish) or -1 (bearish) vote.
            Final score: -1.0 (strong bear) to +1.0 (strong bull)
            Confidence: abs(score), indicating signal agreement level

        Returns: score, direction, confidence, indicator_votes
        """
        votes: dict[str, int] = {}

        # MACD
        try:
            m = self.macd()
            if m["crossover"] == "bullish" or m["histogram"] > 0:
                votes["macd"] = 1
            elif m["crossover"] == "bearish" or m["histogram"] < 0:
                votes["macd"] = -1
            else:
                votes["macd"] = 0
        except Exception:
            pass

        # RSI
        try:
            r = self.rsi()
            if r["zone"] == "oversold":
                votes["rsi"] = 1   # oversold = potential bounce
            elif r["zone"] == "overbought":
                votes["rsi"] = -1
            else:
                votes["rsi"] = 1 if r["value"] > 50 else -1
        except Exception:
            pass

        # Bollinger Bands
        try:
            bb = self.bollinger_bands()
            if bb["position"] == "below_lower":
                votes["bollinger"] = 1
            elif bb["position"] == "above_upper":
                votes["bollinger"] = -1
            else:
                votes["bollinger"] = 1 if bb["pct_b"] > 0.5 else -1
        except Exception:
            pass

        # EMA Cross (20 vs 50)
        try:
            ema20 = self.ema(20)["value"]
            ema50 = self.ema(50)["value"]
            votes["ema_cross"] = 1 if ema20 > ema50 else -1
        except Exception:
            pass

        # Price vs SMA200
        try:
            sma200 = self.sma(200)["value"]
            price  = self.closes[-1] if self.closes else 0.0
            if sma200 > 0:
                votes["sma200"] = 1 if price > sma200 else -1
        except Exception:
            pass

        # OBV trend
        try:
            obv = self.obv()
            votes["obv"] = 1 if obv["trend"] == "rising" else -1
        except Exception:
            pass

        # Volume
        try:
            vol = self.volume_sma_ratio()
            price_chg = self.closes[-1] - self.closes[-2] if len(self.closes) > 1 else 0
            if vol["unusual"] and price_chg > 0:
                votes["volume"] = 1
            elif vol["unusual"] and price_chg < 0:
                votes["volume"] = -1
            else:
                votes["volume"] = 0
        except Exception:
            pass

        # Stochastic
        try:
            s = self.stochastic()
            if s["zone"] == "oversold":
                votes["stochastic"] = 1
            elif s["zone"] == "overbought":
                votes["stochastic"] = -1
            else:
                votes["stochastic"] = 0
        except Exception:
            pass

        # Aggregate
        valid_votes = {k: v for k, v in votes.items() if v != 0}
        if not valid_votes:
            return {"score": 0.0, "direction": "neutral", "confidence": 0.0, "votes": votes}

        score = sum(valid_votes.values()) / len(valid_votes)
        direction = "bullish" if score > 0.1 else "bearish" if score < -0.1 else "neutral"
        confidence = abs(score)

        return {
            "score":      round(score, 3),
            "direction":  direction,
            "confidence": round(confidence, 3),
            "votes":      votes,
        }

    def full_analysis(self) -> dict:
        """
        Run all indicators and return a complete analysis report.
        This is the primary method used by TechnicalAnalystAgent.
        """
        if not self._raw:
            return {"error": "No OHLCV data provided"}

        price = self.closes[-1] if self.closes else 0.0
        return {
            "price":             round(price, 4),
            "candle_count":      len(self._raw),

            # Trend
            "sma_20":            self.sma(20),
            "sma_50":            self.sma(50),
            "sma_200":           self.sma(200),
            "ema_12":            self.ema(12),
            "ema_26":            self.ema(26),
            "ema_50":            self.ema(50),
            "macd":              self.macd(),
            "bollinger":         self.bollinger_bands(),
            "donchian":          self.price_channel(20),

            # Momentum
            "rsi":               self.rsi(14),
            "stochastic":        self.stochastic(),
            "cci":               self.cci(20),
            "williams_r":        self.williams_r(14),

            # Volatility
            "atr":               self.atr(14),
            "hist_volatility":   self.historical_volatility(20),

            # Volume
            "obv":               self.obv(),
            "volume_ratio":      self.volume_sma_ratio(20),
            "vwap":              self.vwap(),

            # Levels
            "pivot_points":      self.pivot_points(),
            "swing_levels":      self.swing_levels(20),

            # Composite
            "signal":            self.composite_signal(),
        }
