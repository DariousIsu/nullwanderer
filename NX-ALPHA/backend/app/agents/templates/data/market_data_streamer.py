"""
AURA Agent Template — MarketDataStreamer
Acquires and normalises real-time price data for a watchlist of tickers.

Registry ID: market_data_streamer_v1
Category:    data
Inputs:      tickers (list[str]), poll_seconds (float, optional)
Outputs:     snapshot (dict of ticker → latest quote), stream_id (str)
"""

from __future__ import annotations
from app.agents.base import BaseAgent


class MarketDataStreamer(BaseAgent):
    """
    Spins up (or connects to an existing) MarketDataStream for a ticker list
    and returns the current snapshot from yfinance.

    run() is a one-shot snapshot call. For continuous streaming, callers
    access the shared stream via get_stream_manager().get("market_data").
    """

    AGENT_ID      = "market_data_streamer_v1"
    INPUTS        = ["tickers"]
    OUTPUTS       = ["snapshot", "stream_id"]
    REQUIRES_LLM  = False
    REAL_TIME     = True
    FREE_TIER     = True

    async def run(self, inputs: dict) -> dict:
        self._require(inputs, "tickers")
        tickers = [t.upper() for t in inputs["tickers"]]
        poll    = float(inputs.get("poll_seconds", 2.0))

        # Ensure the market stream is running
        from app.agents.tools.streaming import get_stream_manager, MarketDataStream
        mgr = get_stream_manager()
        stream = mgr.get("market_data")

        if stream is None:
            stream = MarketDataStream(tickers=tickers, poll_seconds=poll)
            mgr.register(stream)
            await stream.start()
        else:
            # Add any new tickers to the existing stream
            for t in tickers:
                stream.add_ticker(t)  # type: ignore[attr-defined]

        # Fetch current snapshot directly from finance service
        from app.service.finance_service import get_finance_service
        svc = get_finance_service()
        quotes = await svc.get_quotes(tickers)

        snapshot = {q["symbol"]: q for q in quotes}
        self.logger.info("[%s] snapshot fetched for %d tickers", self.AGENT_ID, len(snapshot))

        return {
            "snapshot":  snapshot,
            "stream_id": "market_data",
            "tickers":   tickers,
        }
