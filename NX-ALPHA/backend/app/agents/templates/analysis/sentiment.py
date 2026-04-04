"""
AURA Agent Template — SentimentAgent
Aggregates news headlines and RSS articles, scores sentiment per ticker/topic,
and produces a market sentiment report using the local LLM.

Registry ID: sentiment_v1
Category:    analysis
Inputs:      tickers (list[str]), topics (list[str], optional), lookback_hours (int)
Outputs:     sentiment_scores, top_articles, market_mood, narrative, training_samples
"""

from __future__ import annotations
import time
from app.agents.base import BaseAgent


class SentimentAgent(BaseAgent):
    """
    Gathers news from RSS feeds and NewsAPI, classifies each article's
    sentiment (bullish/bearish/neutral) toward each ticker using keyword
    heuristics and LLM scoring, then aggregates into a market mood score.

    Sentiment is scored -1.0 (maximally bearish) to +1.0 (maximally bullish).
    """

    AGENT_ID     = "sentiment_v1"
    INPUTS       = ["tickers", "topics", "lookback_hours"]
    OUTPUTS      = ["sentiment_scores", "top_articles", "market_mood", "narrative", "training_samples"]
    REQUIRES_LLM = True
    REAL_TIME    = True
    FREE_TIER    = True

    # Bullish and bearish keyword dictionaries for fast heuristic scoring
    _BULLISH_KW = {
        "beat", "surge", "rally", "bullish", "outperform", "upgrade",
        "record high", "growth", "soar", "gain", "profit", "strong",
        "breakout", "optimism", "boom", "expansion", "recovery", "buy",
        "raised", "exceeded", "positive", "upside", "accelerate",
    }
    _BEARISH_KW = {
        "miss", "plunge", "crash", "bearish", "downgrade", "underperform",
        "record low", "decline", "drop", "loss", "weak", "breakdown",
        "pessimism", "recession", "contraction", "sell", "cut", "missed",
        "negative", "downside", "slowdown", "layoff", "default", "debt",
    }

    _SYSTEM = (
        "You are a quantitative market sentiment analyst. "
        "Given a set of recent news headlines and their heuristic sentiment scores, "
        "synthesize the overall market mood into a concise, data-driven paragraph. "
        "Identify the dominant narrative, note any conflicting signals, and state "
        "the net sentiment direction with supporting evidence. No disclaimers. 3-5 sentences."
    )

    async def run(self, inputs: dict) -> dict:
        tickers       = [t.upper() for t in inputs.get("tickers", [])]
        topics        = inputs.get("topics", ["market", "economy", "fed", "inflation"])
        lookback_h    = int(inputs.get("lookback_hours", 24))

        # Gather articles
        articles = await self._gather_articles(tickers, topics)
        if not articles:
            return {
                "sentiment_scores": {},
                "top_articles":     [],
                "market_mood":      {"score": 0.0, "label": "neutral"},
                "narrative":        "Insufficient news data to generate sentiment analysis.",
                "training_samples": [],
            }

        # Score each article
        scored = [self._score_article(a) for a in articles]

        # Aggregate per ticker
        sentiment_scores: dict[str, dict] = {}
        for ticker in tickers:
            ticker_articles = [s for s in scored if ticker in s.get("tickers", [])]
            if ticker_articles:
                avg_score = sum(s["score"] for s in ticker_articles) / len(ticker_articles)
                sentiment_scores[ticker] = {
                    "score":      round(avg_score, 3),
                    "label":      self._label(avg_score),
                    "article_count": len(ticker_articles),
                    "top":        sorted(ticker_articles, key=lambda x: abs(x["score"]), reverse=True)[:3],
                }

        # Overall market mood
        all_scores = [s["score"] for s in scored]
        market_score = sum(all_scores) / len(all_scores) if all_scores else 0.0
        market_mood  = {"score": round(market_score, 3), "label": self._label(market_score)}

        # Top articles for the report
        top_articles = sorted(scored, key=lambda x: abs(x["score"]), reverse=True)[:10]

        # LLM narrative
        prompt = self._build_prompt(tickers, sentiment_scores, market_mood, top_articles)
        narrative = await self._llm(prompt, system=self._SYSTEM, temperature=0.45)

        # Training samples
        training_samples = [
            {
                "headline":  a["title"],
                "tickers":   a.get("tickers", []),
                "score":     a["score"],
                "label":     self._label(a["score"]),
                "category":  a.get("category", "finance"),
            }
            for a in scored[:50]
        ]

        self.logger.info("[%s] scored %d articles | mood=%s (%.2f)",
                         self.AGENT_ID, len(scored),
                         market_mood["label"], market_mood["score"])

        return {
            "sentiment_scores": sentiment_scores,
            "top_articles":     top_articles,
            "market_mood":      market_mood,
            "narrative":        narrative,
            "training_samples": training_samples,
        }

    # ── GATHERING ─────────────────────────────────────────────────────────────

    async def _gather_articles(self, tickers: list[str], topics: list[str]) -> list[dict]:
        articles: list[dict] = []

        try:
            from app.service.news_service import get_news_service
            svc = get_news_service()
            if svc:
                all_rss = await svc.fetch_all(limit_per_feed=30)
                articles.extend(all_rss)
        except Exception as exc:
            self.logger.warning("[%s] RSS gather failed: %s", self.AGENT_ID, exc)

        # NewsAPI for finance-specific articles
        try:
            from app.agents.tools.free_sources import get_free_sources
            fs = get_free_sources()
            for topic in topics[:2]:  # limit to 2 to respect free tier
                news = await fs.news_headlines(q=topic, category="business", page_size=20)
                articles.extend(news)
        except Exception as exc:
            self.logger.warning("[%s] NewsAPI gather failed: %s", self.AGENT_ID, exc)

        # Deduplicate by URL/title
        seen: set[str] = set()
        deduped: list[dict] = []
        for a in articles:
            key = a.get("url") or a.get("link") or a.get("title", "")
            if key and key not in seen:
                seen.add(key)
                deduped.append(a)

        return deduped

    # ── SCORING ───────────────────────────────────────────────────────────────

    def _score_article(self, article: dict) -> dict:
        """Heuristic keyword sentiment score. Range -1 to +1."""
        text = (
            f"{article.get('title', '')} "
            f"{article.get('summary', '')} "
            f"{article.get('description', '')}"
        ).lower()

        bull_count = sum(1 for kw in self._BULLISH_KW if kw in text)
        bear_count = sum(1 for kw in self._BEARISH_KW if kw in text)

        total = bull_count + bear_count
        if total == 0:
            score = 0.0
        else:
            score = (bull_count - bear_count) / total

        # Detect tickers mentioned
        from app.agents.tools.streaming import NewsStream
        tickers = []
        text_upper = text.upper()
        for ticker in NewsStream.WATCHLIST_TICKERS:
            if ticker in text_upper:
                tickers.append(ticker)

        return {
            **article,
            "score":   round(score, 3),
            "tickers": tickers,
            "bull_kw": bull_count,
            "bear_kw": bear_count,
        }

    def _label(self, score: float) -> str:
        if score >= 0.3:   return "bullish"
        if score >= 0.1:   return "slightly_bullish"
        if score <= -0.3:  return "bearish"
        if score <= -0.1:  return "slightly_bearish"
        return "neutral"

    # ── PROMPT ────────────────────────────────────────────────────────────────

    def _build_prompt(
        self,
        tickers: list[str],
        scores:  dict,
        mood:    dict,
        top_articles: list[dict],
    ) -> str:
        lines = [
            f"MARKET SENTIMENT ANALYSIS",
            f"Overall Market Mood: {mood['label']} (score={mood['score']:.3f})",
            "",
        ]
        if tickers and scores:
            lines.append("Per-Ticker Sentiment:")
            for ticker in tickers:
                if ticker in scores:
                    s = scores[ticker]
                    lines.append(f"  {ticker}: {s['label']} ({s['score']:.3f}, n={s['article_count']})")
            lines.append("")

        lines.append("Top Headlines by Sentiment Impact:")
        for a in top_articles[:8]:
            sign = "+" if a["score"] > 0 else ""
            lines.append(f"  [{sign}{a['score']:.2f}] {a.get('title', '')[:100]}")

        lines.append("\nSynthesize the overall market sentiment:")
        return "\n".join(lines)
