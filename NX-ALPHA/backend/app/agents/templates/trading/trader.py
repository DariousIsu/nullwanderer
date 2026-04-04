"""
AURA Agent Template — TraderAgent
Consumes outputs from TechnicalAnalyst, SentimentAgent, ForecastingAgent,
and BullBearDebateAgent to generate a final trade signal with entry/exit levels.

Registry ID: trader_v1
Category:    trading
Inputs:      ticker (str), ta_output (dict), sentiment_output (dict),
             forecast_output (dict), debate_output (dict), portfolio (dict)
Outputs:     trade_signal, entry_price, stop_loss, take_profit, position_type,
             confidence, rationale, training_sample
"""

from __future__ import annotations
from app.agents.base import BaseAgent


class TraderAgent(BaseAgent):
    """
    Synthesises all upstream analyst outputs into a final executable trade signal.

    Signal types:
        BUY       — open long position
        SELL      — open short position (or close existing long)
        HOLD      — no new position
        SCALE_IN  — add to existing position
        SCALE_OUT — reduce existing position

    The output trade_signal dict is structured to feed directly into RiskManagerAgent.
    """

    AGENT_ID     = "trader_v1"
    INPUTS       = ["ticker", "ta_output", "sentiment_output", "forecast_output",
                    "debate_output", "portfolio"]
    OUTPUTS      = ["trade_signal", "entry_price", "stop_loss", "take_profit",
                    "position_type", "confidence", "rationale", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    _SYSTEM = (
        "You are a systematic quantitative trader. Given the combined analysis from "
        "technical, sentiment, fundamental, and debate agents, generate a precise trade "
        "rationale. State: what the dominant signal is, why you are taking this side, "
        "and what would invalidate the trade. Be concise. 3-4 sentences."
    )

    # Signal weight table — how much each source contributes to final score
    WEIGHTS = {
        "ta":        0.35,   # technical analysis composite
        "sentiment": 0.20,   # news/social sentiment
        "forecast":  0.25,   # statistical price forecast
        "debate":    0.20,   # bull/bear debate verdict
    }

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "ticker")
        ticker    = inputs["ticker"].upper()
        ta_out    = inputs.get("ta_output", {})
        sent_out  = inputs.get("sentiment_output", {})
        fcast_out = inputs.get("forecast_output", {})
        deb_out   = inputs.get("debate_output", {})
        portfolio = inputs.get("portfolio", {})

        # ── Score aggregation ─────────────────────────────────────────────────
        scores: dict[str, float] = {}

        # Technical score
        ta_signal = ta_out.get("signal", {})
        ta_score  = ta_signal.get("score", 0.0) or 0.0
        scores["ta"] = float(ta_score)

        # Sentiment score
        ticker_sent = (sent_out.get("sentiment_scores") or {}).get(ticker, {})
        sent_score  = ticker_sent.get("score") or (sent_out.get("market_mood") or {}).get("score") or 0.0
        scores["sentiment"] = float(sent_score)

        # Forecast score — directional from price delta
        fcast_series = fcast_out.get("forecast", [])
        fcast_current = ta_out.get("price") or (fcast_out.get("training_sample") or {}).get("forecast_1")
        if fcast_series and fcast_current:
            fcast_end = fcast_series[-1]
            pct_change = (fcast_end - fcast_current) / fcast_current if fcast_current else 0
            fcast_score = max(-1.0, min(1.0, pct_change * 10))  # normalise: 10% move = score 1.0
        else:
            fcast_score = 0.0
        scores["forecast"] = fcast_score

        # Debate score
        debate_verdict = deb_out.get("verdict", "HOLD")
        debate_conf    = float(deb_out.get("confidence", 0.5) or 0.5)
        if debate_verdict == "BUY":
            debate_score = debate_conf
        elif debate_verdict == "SELL":
            debate_score = -debate_conf
        else:
            debate_score = 0.0
        scores["debate"] = debate_score

        # Weighted composite
        composite = sum(scores[k] * self.WEIGHTS[k] for k in scores)
        composite = max(-1.0, min(1.0, composite))
        confidence = abs(composite)

        # ── Signal classification ─────────────────────────────────────────────
        if composite >= 0.25:
            position_type = "BUY"
        elif composite <= -0.25:
            position_type = "SELL"
        elif composite >= 0.10:
            position_type = "SCALE_IN"
        elif composite <= -0.10:
            position_type = "SCALE_OUT"
        else:
            position_type = "HOLD"

        # ── Entry / Stop / Target calculation ─────────────────────────────────
        price = ta_out.get("price") or 0.0
        atr   = ta_out.get("indicators", {}).get("atr", {}).get("value", price * 0.01) or price * 0.01
        hist_vol = ta_out.get("indicators", {}).get("hist_volatility", {}).get("annualised", 0.25) or 0.25

        entry_price = price
        if position_type in ("BUY", "SCALE_IN"):
            stop_loss   = round(entry_price - 1.5 * atr, 4)
            take_profit = round(entry_price + 3.0 * atr, 4)  # 2:1 R:R minimum
        elif position_type in ("SELL", "SCALE_OUT"):
            stop_loss   = round(entry_price + 1.5 * atr, 4)
            take_profit = round(entry_price - 3.0 * atr, 4)
        else:
            stop_loss   = 0.0
            take_profit = 0.0

        # ── Structured trade signal for RiskManager ───────────────────────────
        trade_signal = {
            "ticker":        ticker,
            "direction":     position_type.lower() if position_type != "HOLD" else "hold",
            "entry_price":   entry_price,
            "stop_loss":     stop_loss,
            "take_profit":   take_profit,
            "confidence":    round(confidence, 3),
            "atr":           atr,
            "hist_vol":      hist_vol,
            "composite_score": round(composite, 3),
            "source_scores": scores,
        }

        # ── LLM rationale ─────────────────────────────────────────────────────
        prompt   = self._build_prompt(ticker, position_type, composite, scores, price, atr, ta_out, deb_out, fcast_out)
        rationale = await self._llm(prompt, system=self._SYSTEM, temperature=0.4)

        # ── Training sample ───────────────────────────────────────────────────
        training_sample = {
            "ticker":        ticker,
            "composite":     round(composite, 3),
            "position_type": position_type,
            "confidence":    round(confidence, 3),
            "ta_score":      scores["ta"],
            "sentiment_score": scores["sentiment"],
            "forecast_score": scores["forecast"],
            "debate_score":  scores["debate"],
            "entry":         entry_price,
            "stop_loss":     stop_loss,
            "take_profit":   take_profit,
        }

        self.logger.info(
            "[%s] %s → %s (composite=%.3f conf=%.2f ta=%.2f sent=%.2f fcast=%.2f debate=%.2f)",
            self.AGENT_ID, ticker, position_type, composite, confidence,
            scores["ta"], scores["sentiment"], scores["forecast"], scores["debate"],
        )

        return {
            "trade_signal":    trade_signal,
            "entry_price":     entry_price,
            "stop_loss":       stop_loss,
            "take_profit":     take_profit,
            "position_type":   position_type,
            "confidence":      round(confidence, 3),
            "rationale":       rationale,
            "training_sample": training_sample,
        }

    def _build_prompt(self, ticker, position_type, composite, scores, price, atr, ta_out, deb_out, fcast_out) -> str:
        ta_signal = ta_out.get("signal", {})
        fcast = fcast_out.get("forecast", [])
        fcast_end = fcast[-1] if fcast else price
        return f"""TRADE SYNTHESIS — {ticker}

Final Signal: {position_type}  |  Composite Score: {composite:+.3f}  |  Confidence: {abs(composite):.0%}

Source Scores:
  Technical Analysis:  {scores['ta']:+.3f}   (TA direction={ta_signal.get('direction')} votes={ta_signal.get('votes')})
  News Sentiment:      {scores['sentiment']:+.3f}
  Statistical Forecast:{scores['forecast']:+.3f}   (model={fcast_out.get('model_used')} target={fcast_end:.4f})
  Bull/Bear Debate:    {scores['debate']:+.3f}   (verdict={deb_out.get('verdict')} conf={deb_out.get('confidence')})

Execution:
  Entry: {price:.4f}  |  ATR: {atr:.4f}

Write the trade rationale:"""
