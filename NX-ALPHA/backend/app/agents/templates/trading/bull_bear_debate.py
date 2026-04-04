"""
AURA Agent Template — BullBearDebateAgent
Two separate Ollama calls simulate a structured analyst debate:
Bull analyst argues the long case, Bear analyst argues the short case.
A referee LLM call synthesizes the debate into a final verdict.

Derived from TradingAgents multi-agent debate architecture.

Registry ID: bull_bear_debate_v1
Category:    trading
Inputs:      ticker (str), context (dict) — includes TA, sentiment, fundamental, forecast data
Outputs:     bull_case, bear_case, verdict, confidence, training_sample
"""

from __future__ import annotations
from app.agents.base import BaseAgent


class BullBearDebateAgent(BaseAgent):
    """
    Structured bull-vs-bear analyst debate.

    Pipeline:
        1. Build shared context from all available agent outputs
        2. Bull analyst: makes the strongest possible bull case
        3. Bear analyst: makes the strongest possible bear case
        4. Referee: weighs both sides and produces a verdict

    All three calls use the local Ollama model. Sequential by design —
    each call informs the next.
    """

    AGENT_ID     = "bull_bear_debate_v1"
    INPUTS       = ["ticker", "context"]
    OUTPUTS      = ["bull_case", "bear_case", "verdict", "confidence", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    _BULL_SYSTEM = (
        "You are a bullish equity analyst making the strongest possible case "
        "for buying this asset. Use the provided data to argue why the risk/reward "
        "favours a long position. Be specific, data-driven, and persuasive. "
        "No hedging. No disclaimers. 4-5 sentences maximum."
    )
    _BEAR_SYSTEM = (
        "You are a bearish equity analyst making the strongest possible case "
        "for selling or avoiding this asset. Use the provided data to argue why "
        "downside risk outweighs upside potential. Be specific, data-driven, and direct. "
        "No hedging. No disclaimers. 4-5 sentences maximum."
    )
    _REF_SYSTEM = (
        "You are a neutral chief investment officer who has heard both the bull "
        "and bear cases for a trade. Weigh the arguments objectively and deliver "
        "a final verdict: BUY, SELL, or HOLD. State which argument was more compelling "
        "and why, then assign a confidence score (0.0-1.0) for your verdict. "
        "Format: VERDICT: [BUY|SELL|HOLD] | CONFIDENCE: [0.0-1.0] | REASONING: [...]"
    )

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "ticker")
        ticker  = inputs["ticker"].upper()
        context = inputs.get("context", {})

        context_str = self._format_context(ticker, context)

        # ── Bull case ─────────────────────────────────────────────────────────
        bull_prompt = f"ASSET: {ticker}\n\n{context_str}\n\nMake the bull case:"
        bull_case   = await self._llm(bull_prompt, system=self._BULL_SYSTEM, temperature=0.7)

        # ── Bear case ─────────────────────────────────────────────────────────
        bear_prompt = f"ASSET: {ticker}\n\n{context_str}\n\nMake the bear case:"
        bear_case   = await self._llm(bear_prompt, system=self._BEAR_SYSTEM, temperature=0.7)

        # ── Referee verdict ───────────────────────────────────────────────────
        ref_prompt = f"""ASSET: {ticker}

BULL ANALYST:
{bull_case}

BEAR ANALYST:
{bear_case}

DATA SUMMARY:
{context_str[:1000]}

Deliver your verdict:"""
        verdict_raw = await self._llm(ref_prompt, system=self._REF_SYSTEM, temperature=0.3)

        # Parse verdict
        verdict, confidence = self._parse_verdict(verdict_raw)

        training_sample = {
            "ticker":     ticker,
            "verdict":    verdict,
            "confidence": confidence,
            "bull_len":   len(bull_case),
            "bear_len":   len(bear_case),
            "ta_signal":  context.get("ta_signal", {}).get("direction"),
            "sentiment":  context.get("market_mood", {}).get("label"),
            "forecast_dir": context.get("forecast_direction"),
        }

        self.logger.info("[%s] %s → %s (conf=%.2f)", self.AGENT_ID, ticker, verdict, confidence)

        return {
            "bull_case":       bull_case,
            "bear_case":       bear_case,
            "verdict_raw":     verdict_raw,
            "verdict":         verdict,
            "confidence":      confidence,
            "training_sample": training_sample,
        }

    def _format_context(self, ticker: str, context: dict) -> str:
        lines = [f"=== MARKET DATA FOR {ticker} ==="]

        # Technical
        ta = context.get("indicators", {})
        if ta:
            sig = ta.get("signal", {})
            lines.append(f"\nTECHNICAL: signal={sig.get('direction')} score={sig.get('score')} "
                         f"rsi={ta.get('rsi', {}).get('value')} "
                         f"macd_hist={ta.get('macd', {}).get('histogram')}")
            bb = ta.get("bollinger", {})
            lines.append(f"  Bollinger: %B={bb.get('pct_b')} position={bb.get('position')}")

        # Sentiment
        mood = context.get("market_mood", {})
        ticker_sent = context.get("ticker_sentiment", {}).get(ticker, {})
        if mood or ticker_sent:
            lines.append(f"\nSENTIMENT: market={mood.get('label')} ({mood.get('score', 0):.2f})")
            if ticker_sent:
                lines.append(f"  {ticker} specific: {ticker_sent.get('label')} ({ticker_sent.get('score', 0):.2f})")

        # Fundamental
        ratios = context.get("ratios", {})
        if ratios:
            lines.append(f"\nFUNDAMENTAL: P/E={ratios.get('pe_ratio')} P/B={ratios.get('pb_ratio')} "
                         f"margin={ratios.get('profit_margin')}% revenue_growth={ratios.get('revenue_growth')}%")

        # Forecast
        fcast = context.get("forecast", [])
        if fcast:
            price = context.get("price", 0)
            fcast_end = fcast[-1] if fcast else price
            pct = (fcast_end - price) / price * 100 if price else 0
            lines.append(f"\nFORECAST: model={context.get('model_used')} "
                         f"horizon={len(fcast)} bars  {pct:+.2f}% expected")
            lines.append(f"  Path: {[round(v, 2) for v in fcast[:5]]}")

        # Economic context
        econ = context.get("economic_snapshot", {})
        if econ:
            vix = econ.get("vix", {}).get("latest")
            spread = econ.get("yield_spread", {}).get("latest")
            lines.append(f"\nECONOMIC: VIX={vix} yield_spread={spread}")

        # Weather impact
        weather_impact = context.get("weather_impact")
        if weather_impact:
            lines.append(f"\nWEATHER IMPACT: {weather_impact}")

        return "\n".join(lines)

    def _parse_verdict(self, raw: str) -> tuple[str, float]:
        """Extract VERDICT and CONFIDENCE from referee output."""
        import re
        verdict    = "HOLD"
        confidence = 0.5

        upper = raw.upper()
        if "VERDICT: BUY"  in upper: verdict = "BUY"
        elif "VERDICT: SELL" in upper: verdict = "SELL"
        elif "VERDICT: HOLD" in upper: verdict = "HOLD"

        match = re.search(r"CONFIDENCE:\s*([\d.]+)", raw, re.IGNORECASE)
        if match:
            try:
                confidence = max(0.0, min(1.0, float(match.group(1))))
            except ValueError:
                pass

        return verdict, confidence
