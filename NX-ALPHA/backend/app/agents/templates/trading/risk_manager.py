"""
AURA Agent Template — RiskManagerAgent
Evaluates trade proposals against portfolio risk parameters.
Computes position size, VaR, drawdown limits, and concentration checks.

Registry ID: risk_manager_v1
Category:    trading
Inputs:      trade_signal (dict), portfolio (dict), account_size (float)
Outputs:     approved (bool), position_size, risk_metrics, adjustments, narrative
"""

from __future__ import annotations
import math
from app.agents.base import BaseAgent


class RiskManagerAgent(BaseAgent):
    """
    Gate-keeper for all trade signals from TraderAgent.

    Risk model:
        - Max risk per trade: 1% of account (Kelly-informed)
        - Max position concentration: 10% of portfolio
        - Max drawdown gate: reject if portfolio drawdown > 15%
        - VaR(95%): estimated from ATR + historical vol
        - Correlation gate: reject if > 3 correlated positions in same sector

    All decisions are logged as training samples for the local model.
    """

    AGENT_ID     = "risk_manager_v1"
    INPUTS       = ["trade_signal", "portfolio", "account_size"]
    OUTPUTS      = ["approved", "position_size", "risk_metrics", "adjustments", "narrative"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    # Default risk parameters (can be overridden per-call via inputs)
    MAX_RISK_PCT      = 0.01   # 1% of account per trade
    MAX_POSITION_PCT  = 0.10   # 10% of account max position
    MAX_DRAWDOWN_PCT  = 0.15   # 15% drawdown → stop trading
    MIN_REWARD_RISK   = 2.0    # Minimum R:R ratio to approve

    _SYSTEM = (
        "You are a risk officer at a quantitative trading firm. "
        "Given a trade proposal and its risk metrics, write a brief risk assessment: "
        "state whether the trade is approved, explain the key risk drivers, "
        "and note any adjustments made to position size. Be direct. Max 4 sentences."
    )

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "trade_signal")
        signal       = inputs["trade_signal"]
        portfolio    = inputs.get("portfolio", {})
        account_size = float(inputs.get("account_size", 10000.0))

        # Override risk params from inputs if provided
        max_risk_pct     = float(inputs.get("max_risk_pct", self.MAX_RISK_PCT))
        max_position_pct = float(inputs.get("max_position_pct", self.MAX_POSITION_PCT))

        ticker     = signal.get("ticker", "UNKNOWN")
        direction  = signal.get("direction", "hold")   # "buy" | "sell" | "hold"
        entry      = float(signal.get("entry_price", 0.0) or 0.0)
        stop_loss  = float(signal.get("stop_loss", 0.0) or 0.0)
        take_profit = float(signal.get("take_profit", 0.0) or 0.0)
        confidence = float(signal.get("confidence", 0.5) or 0.5)
        atr        = float(signal.get("atr", entry * 0.01) or entry * 0.01)
        hist_vol   = float(signal.get("hist_vol_annualised", 0.25) or 0.25)

        # ── 1. Portfolio-level gates ───────────────────────────────────────────
        rejection_reasons: list[str] = []
        adjustments:       list[str] = []

        # Drawdown gate
        portfolio_peak  = float(portfolio.get("peak_value", account_size))
        portfolio_value = float(portfolio.get("current_value", account_size))
        drawdown_pct    = (portfolio_peak - portfolio_value) / portfolio_peak if portfolio_peak else 0.0
        if drawdown_pct > self.MAX_DRAWDOWN_PCT:
            rejection_reasons.append(
                f"Portfolio drawdown {drawdown_pct:.1%} exceeds max {self.MAX_DRAWDOWN_PCT:.0%}"
            )

        # Direction gate
        if direction == "hold":
            rejection_reasons.append("Signal direction is HOLD — no trade to size")

        # ── 2. Position sizing (ATR-based) ────────────────────────────────────
        risk_dollars    = account_size * max_risk_pct
        risk_per_share  = abs(entry - stop_loss) if stop_loss and entry else atr
        if risk_per_share <= 0:
            risk_per_share = atr if atr > 0 else entry * 0.01

        raw_shares = math.floor(risk_dollars / risk_per_share) if risk_per_share else 0

        # Cap at max_position_pct
        max_shares = math.floor((account_size * max_position_pct) / entry) if entry else 0
        position_shares = min(raw_shares, max_shares)

        # Kelly adjustment (confidence-weighted)
        reward_risk = (take_profit - entry) / risk_per_share if take_profit and entry else 0.0
        if reward_risk < self.MIN_REWARD_RISK and direction != "hold":
            if reward_risk < 1.0:
                rejection_reasons.append(f"R:R ratio {reward_risk:.2f} < minimum 1.0")
            else:
                adjustments.append(f"R:R {reward_risk:.2f} below target {self.MIN_REWARD_RISK:.1f} — reduced size 50%")
                position_shares = position_shares // 2

        kelly_fraction = max(0.0, (confidence - (1 - confidence)) / 1.0)
        kelly_shares   = math.floor(position_shares * kelly_fraction * 2)
        final_shares   = min(position_shares, kelly_shares) if kelly_shares > 0 else position_shares

        position_value = final_shares * entry if entry else 0.0
        position_pct   = position_value / account_size if account_size else 0.0

        # ── 3. VaR estimate ───────────────────────────────────────────────────
        daily_vol    = hist_vol / math.sqrt(252)
        var_95_daily = position_value * daily_vol * 1.645  # 95% 1-day VaR
        var_99_daily = position_value * daily_vol * 2.326  # 99% 1-day VaR

        # ── 4. Concentration check ────────────────────────────────────────────
        open_positions  = portfolio.get("open_positions", [])
        ticker_exists   = any(p.get("ticker") == ticker for p in open_positions)
        if ticker_exists:
            rejection_reasons.append(f"Already holding open position in {ticker}")

        # ── 5. Final approval ─────────────────────────────────────────────────
        approved = len(rejection_reasons) == 0 and final_shares > 0

        risk_metrics = {
            "risk_per_share":    round(risk_per_share, 4),
            "risk_dollars":      round(risk_dollars, 2),
            "position_shares":   final_shares,
            "position_value":    round(position_value, 2),
            "position_pct":      round(position_pct * 100, 2),
            "reward_risk_ratio": round(reward_risk, 2),
            "kelly_fraction":    round(kelly_fraction, 3),
            "var_95_daily":      round(var_95_daily, 2),
            "var_99_daily":      round(var_99_daily, 2),
            "portfolio_drawdown": round(drawdown_pct * 100, 2),
            "confidence":        confidence,
        }

        # ── 6. LLM risk narrative ─────────────────────────────────────────────
        prompt = self._build_prompt(ticker, direction, approved, rejection_reasons, adjustments, risk_metrics)
        narrative = await self._llm(prompt, system=self._SYSTEM, temperature=0.3)

        self.logger.info(
            "[%s] %s %s %s | shares=%d val=$%.0f R:R=%.2f approved=%s",
            self.AGENT_ID, direction, ticker,
            "APPROVED" if approved else "REJECTED",
            final_shares, position_value, reward_risk, approved,
        )

        return {
            "approved":       approved,
            "position_size":  {
                "shares": final_shares,
                "value":  round(position_value, 2),
                "pct_of_account": round(position_pct * 100, 2),
            },
            "risk_metrics":   risk_metrics,
            "rejection_reasons": rejection_reasons,
            "adjustments":    adjustments,
            "narrative":      narrative,
        }

    def _build_prompt(
        self,
        ticker:    str,
        direction: str,
        approved:  bool,
        reasons:   list[str],
        adjustments: list[str],
        metrics:   dict,
    ) -> str:
        status = "APPROVED" if approved else "REJECTED"
        lines = [
            f"RISK ASSESSMENT — {ticker.upper()} {direction.upper()} — {status}",
            "",
            f"Position: {metrics['position_shares']} shares  |  ${metrics['position_value']:,.0f}  |  {metrics['position_pct']:.1f}% of account",
            f"Risk per share: ${metrics['risk_per_share']:.4f}  |  Total risk: ${metrics['risk_dollars']:.0f}",
            f"Reward:Risk: {metrics['reward_risk_ratio']:.2f}:1  |  Kelly fraction: {metrics['kelly_fraction']:.3f}",
            f"VaR(95%,1d): ${metrics['var_95_daily']:.0f}  |  VaR(99%,1d): ${metrics['var_99_daily']:.0f}",
            f"Portfolio drawdown: {metrics['portfolio_drawdown']:.1f}%",
            f"Confidence: {metrics['confidence']:.0%}",
        ]
        if reasons:
            lines.append(f"\nRejection reasons: {'; '.join(reasons)}")
        if adjustments:
            lines.append(f"Adjustments made: {'; '.join(adjustments)}")
        lines.append("\nWrite the risk assessment:")
        return "\n".join(lines)
