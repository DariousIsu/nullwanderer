"""
AURA Agent Template — FundamentalAnalystAgent
Pulls SEC EDGAR filings and Polygon ticker details to build a fundamental
picture of a company, then generates an investment thesis using the local LLM.

Registry ID: fundamental_analyst_v1
Category:    analysis
Inputs:      ticker (str), depth ("quick" | "full")
Outputs:     ticker, cik, fundamentals, ratios, thesis, training_sample
"""

from __future__ import annotations
from app.agents.base import BaseAgent


class FundamentalAnalystAgent(BaseAgent):
    """
    Derives key financial ratios from SEC EDGAR XBRL data and Polygon
    reference data. Produces a structured fundamental profile and a
    local-LLM investment thesis for training and planner consumption.
    """

    AGENT_ID     = "fundamental_analyst_v1"
    INPUTS       = ["ticker", "depth"]
    OUTPUTS      = ["ticker", "cik", "fundamentals", "ratios", "thesis", "training_sample"]
    REQUIRES_LLM = True
    REAL_TIME    = False
    FREE_TIER    = True

    _SYSTEM = (
        "You are a CFA-level fundamental equity analyst. "
        "Given structured financial data for a company, produce a concise "
        "investment thesis covering: (1) business quality, (2) financial health, "
        "(3) valuation signal, (4) key risks, (5) analyst verdict (buy/hold/avoid). "
        "Be data-driven. No disclaimers. Max 6 sentences."
    )

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "ticker")
        ticker = inputs["ticker"].upper()
        depth  = inputs.get("depth", "quick")   # "quick" = Polygon only, "full" = + EDGAR

        from app.agents.tools.free_sources import get_free_sources
        fs = get_free_sources()

        # ── Step 1: Polygon ticker details (always) ────────────────────────────
        details = await fs.polygon_ticker_details(ticker)

        # ── Step 2: Current price + market data ───────────────────────────────
        try:
            from app.service.finance_service import get_finance_service
            svc   = get_finance_service()
            quote = await svc.get_quote(ticker)
        except Exception:
            quote = {}

        # ── Step 3: EDGAR XBRL data (full depth only) ─────────────────────────
        cik         = None
        revenue_data: list[dict] = []
        income_data:  list[dict] = []
        assets_data:  list[dict] = []
        equity_data:  list[dict] = []
        eps_data:     list[dict] = []

        if depth == "full":
            try:
                cik = await fs.edgar_cik_lookup(ticker)
                if cik:
                    rev   = await fs.edgar_company_concept(cik, "us-gaap", "Revenues")
                    ni    = await fs.edgar_company_concept(cik, "us-gaap", "NetIncomeLoss")
                    assets = await fs.edgar_company_concept(cik, "us-gaap", "Assets")
                    equity = await fs.edgar_company_concept(cik, "us-gaap", "StockholdersEquity")
                    eps   = await fs.edgar_company_concept(cik, "us-gaap", "EarningsPerShareBasic")

                    revenue_data = rev.get("data", [])[-8:]   # last 8 quarters
                    income_data  = ni.get("data", [])[-8:]
                    assets_data  = assets.get("data", [])[-8:]
                    equity_data  = equity.get("data", [])[-8:]
                    eps_data     = eps.get("data", [])[-8:]
            except Exception as exc:
                self.logger.warning("[%s] EDGAR fetch failed for %s: %s", self.AGENT_ID, ticker, exc)

        # ── Step 4: Compute ratios ─────────────────────────────────────────────
        ratios = self._compute_ratios(quote, details, revenue_data, income_data, assets_data, equity_data)

        # ── Step 5: Assemble fundamentals dict ────────────────────────────────
        fundamentals = {
            "ticker":         ticker,
            "name":           details.get("name") or quote.get("name"),
            "description":    details.get("description", ""),
            "sector":         details.get("sic_description", ""),
            "employees":      details.get("employees"),
            "exchange":       details.get("exchange"),
            "market_cap":     details.get("market_cap") or quote.get("market_cap"),
            "price":          quote.get("price"),
            "revenue_trend":  revenue_data[:4],
            "net_income_trend": income_data[:4],
            "eps_trend":      eps_data[:4],
        }

        # ── Step 6: LLM thesis ────────────────────────────────────────────────
        prompt  = self._build_prompt(ticker, fundamentals, ratios)
        thesis  = await self._llm(prompt, system=self._SYSTEM, temperature=0.4)

        # ── Training sample ───────────────────────────────────────────────────
        training_sample = {
            "ticker":       ticker,
            "market_cap":   fundamentals["market_cap"],
            "sector":       fundamentals["sector"],
            "pe_ratio":     ratios.get("pe_ratio"),
            "pb_ratio":     ratios.get("pb_ratio"),
            "profit_margin": ratios.get("profit_margin"),
            "revenue_growth": ratios.get("revenue_growth"),
            "roe":          ratios.get("roe"),
        }

        self.logger.info("[%s] fundamental analysis complete for %s (depth=%s)", self.AGENT_ID, ticker, depth)

        return {
            "ticker":          ticker,
            "cik":             cik,
            "fundamentals":    fundamentals,
            "ratios":          ratios,
            "thesis":          thesis,
            "training_sample": training_sample,
        }

    def _compute_ratios(
        self,
        quote:        dict,
        details:      dict,
        revenue_data: list,
        income_data:  list,
        assets_data:  list,
        equity_data:  list,
    ) -> dict:
        price      = quote.get("price", 0.0) or 0.0
        market_cap = details.get("market_cap") or quote.get("market_cap") or 0.0
        ratios:    dict = {}

        # Revenue growth (most recent QoQ)
        if len(revenue_data) >= 2:
            r_curr = revenue_data[0].get("val", 0) or 0
            r_prev = revenue_data[1].get("val", 0) or 0
            ratios["revenue_growth"] = round((r_curr - r_prev) / r_prev * 100, 2) if r_prev else None

        # Profit margin (net income / revenue)
        if revenue_data and income_data:
            rev = revenue_data[0].get("val", 0) or 0
            ni  = income_data[0].get("val", 0) or 0
            ratios["profit_margin"] = round(ni / rev * 100, 2) if rev else None

        # Return on equity
        if income_data and equity_data:
            ni  = income_data[0].get("val", 0) or 0
            eq  = equity_data[0].get("val", 0) or 0
            ratios["roe"] = round(ni / eq * 100, 2) if eq else None

        # P/E (naive: market cap / latest net income)
        if income_data and market_cap:
            annual_ni = sum(d.get("val", 0) or 0 for d in income_data[:4])  # last 4 quarters
            ratios["pe_ratio"] = round(market_cap / annual_ni, 2) if annual_ni > 0 else None

        # P/B (market cap / book value)
        if equity_data and market_cap:
            book = equity_data[0].get("val", 0) or 0
            ratios["pb_ratio"] = round(market_cap / book, 2) if book > 0 else None

        ratios["market_cap_b"] = round(market_cap / 1e9, 2) if market_cap else None

        return ratios

    def _build_prompt(self, ticker: str, fundamentals: dict, ratios: dict) -> str:
        return f"""FUNDAMENTAL ANALYSIS — {ticker}

Company: {fundamentals.get('name', ticker)}
Sector: {fundamentals.get('sector', 'Unknown')}
Exchange: {fundamentals.get('exchange', '?')}
Employees: {fundamentals.get('employees', 'N/A')}
Market Cap: ${ratios.get('market_cap_b', 'N/A')}B

Description: {fundamentals.get('description', '')[:300]}

KEY RATIOS:
  P/E Ratio:       {ratios.get('pe_ratio', 'N/A')}
  P/B Ratio:       {ratios.get('pb_ratio', 'N/A')}
  Profit Margin:   {ratios.get('profit_margin', 'N/A')}%
  Revenue Growth:  {ratios.get('revenue_growth', 'N/A')}% (QoQ)
  ROE:             {ratios.get('roe', 'N/A')}%

RECENT FINANCIALS (latest quarters, USD):
  Revenue:    {[d.get('val') for d in fundamentals.get('revenue_trend', [])]}
  Net Income: {[d.get('val') for d in fundamentals.get('net_income_trend', [])]}
  EPS:        {[d.get('val') for d in fundamentals.get('eps_trend', [])]}

Generate investment thesis:"""
