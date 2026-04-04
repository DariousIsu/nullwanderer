"""
AURA Agent Template — TechnicalAnalystAgent
Runs the full TA indicator suite on streaming price data, then uses the
local Ollama model to interpret the confluence and generate a signal narrative.

Registry ID: technical_analyst_v1
Category:    analysis
Inputs:      ticker (str), ohlcv (list[dict]) OR fetch_live (bool)
Outputs:     ticker, price, indicators, signal, narrative, training_sample
"""

from __future__ import annotations
from app.agents.base import BaseAgent


class TechnicalAnalystAgent(BaseAgent):
    """
    Derives buy/sell/hold signals from technical indicators, then generates
    a natural-language interpretation using the local LLM.

    The `training_sample` output is structured for ingestion into the
    local model's training dataset (label: signal direction + indicators).
    """

    AGENT_ID     = "technical_analyst_v1"
    INPUTS       = ["ticker", "ohlcv"]
    OUTPUTS      = ["ticker", "price", "indicators", "signal", "narrative", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    _SYSTEM = (
        "You are a professional quantitative technical analyst. "
        "Given a set of indicator values for a stock, produce a concise, "
        "data-driven signal narrative. Be specific about which indicators "
        "are converging, whether the signal is confirmed or divergent, "
        "and what the highest-probability short-term price scenario is. "
        "Do not use filler. No disclaimers. No advice qualifiers. "
        "Maximum 4 sentences."
    )

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "ticker")
        ticker = inputs["ticker"].upper()
        ohlcv  = inputs.get("ohlcv", [])

        # Fetch live data if no OHLCV provided
        if not ohlcv and inputs.get("fetch_live", True):
            try:
                from app.service.finance_service import get_finance_service
                svc  = get_finance_service()
                quote = await svc.get_quote(ticker)
                ohlcv = quote.get("ohlcv", [])
                price = quote.get("price", 0.0)
            except Exception as exc:
                self.logger.warning("[%s] live fetch failed for %s: %s", self.AGENT_ID, ticker, exc)
                price = 0.0
        else:
            price = ohlcv[-1].get("c", 0.0) if ohlcv else 0.0

        if not ohlcv:
            return {"ticker": ticker, "error": "No OHLCV data available"}

        # Run TA engine
        from app.agents.tools.technical_analysis import TechnicalAnalysis
        ta      = TechnicalAnalysis(ohlcv)
        analysis = ta.full_analysis()
        signal   = analysis["signal"]

        # Build LLM prompt
        prompt = self._build_prompt(ticker, price, analysis)
        narrative = await self._llm(prompt, system=self._SYSTEM, temperature=0.4)

        # Build training sample
        training_sample = {
            "ticker":    ticker,
            "price":     price,
            "rsi":       analysis.get("rsi", {}).get("value"),
            "macd_hist": analysis.get("macd", {}).get("histogram"),
            "bb_pct_b":  analysis.get("bollinger", {}).get("pct_b"),
            "ema12_vs_ema26": (
                (analysis.get("ema_12", {}).get("value", 0) /
                 analysis.get("ema_26", {}).get("value", 1)) - 1
                if analysis.get("ema_26", {}).get("value") else 0
            ),
            "vol_ratio": analysis.get("volume_ratio", {}).get("ratio"),
            "atr_pct":   analysis.get("atr", {}).get("pct_of_price"),
            "signal":    signal.get("direction"),
            "score":     signal.get("score"),
        }

        self.logger.info("[%s] %s → %s (score=%.2f confidence=%.2f)",
                         self.AGENT_ID, ticker,
                         signal.get("direction"),
                         signal.get("score", 0),
                         signal.get("confidence", 0))

        return {
            "ticker":          ticker,
            "price":           price,
            "indicators":      analysis,
            "signal":          signal,
            "narrative":       narrative,
            "training_sample": training_sample,
        }

    def _build_prompt(self, ticker: str, price: float, analysis: dict) -> str:
        rsi    = analysis.get("rsi", {})
        macd   = analysis.get("macd", {})
        bb     = analysis.get("bollinger", {})
        ema12  = analysis.get("ema_12", {}).get("value", 0)
        ema26  = analysis.get("ema_26", {}).get("value", 0)
        ema50  = analysis.get("ema_50", {}).get("value", 0)
        sma200 = analysis.get("sma_200", {}).get("value", 0)
        atr    = analysis.get("atr", {})
        vol    = analysis.get("volume_ratio", {})
        obv    = analysis.get("obv", {})
        signal = analysis.get("signal", {})
        stoch  = analysis.get("stochastic", {})

        return f"""TECHNICAL ANALYSIS — {ticker} @ ${price:.4f}

TREND:
  EMA12={ema12:.4f}  EMA26={ema26:.4f}  EMA50={ema50:.4f}  SMA200={sma200:.4f}
  MACD={macd.get('macd', 0):.4f}  Signal={macd.get('signal', 0):.4f}  Histogram={macd.get('histogram', 0):.4f}  Crossover={macd.get('crossover', 'none')}

MOMENTUM:
  RSI(14)={rsi.get('value', 50):.1f} [{rsi.get('zone', 'neutral')}]
  Stochastic %K={stoch.get('k', 50):.1f}  %D={stoch.get('d', 50):.1f}  [{stoch.get('zone', 'neutral')}]

VOLATILITY / BANDS:
  Bollinger: upper={bb.get('upper', 0):.4f}  mid={bb.get('middle', 0):.4f}  lower={bb.get('lower', 0):.4f}
  %B={bb.get('pct_b', 0.5):.3f}  Position={bb.get('position', 'inside')}
  ATR={atr.get('value', 0):.4f}  ({atr.get('pct_of_price', 0):.2f}% of price)

VOLUME:
  Current/Avg Ratio={vol.get('ratio', 1):.2f}  Unusual={vol.get('unusual', False)}
  OBV Trend={obv.get('trend', 'flat')}

COMPOSITE SIGNAL:
  Score={signal.get('score', 0):.3f}  Direction={signal.get('direction', 'neutral')}  Confidence={signal.get('confidence', 0):.3f}
  Votes={signal.get('votes', {})}

Provide your technical signal narrative:"""
