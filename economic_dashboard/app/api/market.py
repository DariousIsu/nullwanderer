import os
import requests
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
from app.core.rate_limiter import RateLimiter

class MarketClient:
    """Client for the Polygon.io Market Data API"""
    
    BASE_URL = "https://api.polygon.io"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("POLYGON_API_KEY")
        if not self.api_key:
            raise ValueError("Polygon API key is required")
        
        # Limit to 5 requests per minute for the free plan
        self.rate_limiter = RateLimiter(calls=5, period=60)
    
    def get_market_indices(self) -> Dict[str, Any]:
        """
        Get market indices data
        
        Returns:
            Dict containing market indices data
        """
        # List of major indices to track
        indices = ["SPY", "QQQ", "DIA", "IWM"]
        
        result = {}
        
        for symbol in indices:
            self.rate_limiter.wait_if_needed("polygon")
            
            # Get today's date and yesterday's date
            today = datetime.now()
            yesterday = today - timedelta(days=1)
            
            # Format dates as YYYY-MM-DD
            today_str = today.strftime("%Y-%m-%d")
            yesterday_str = yesterday.strftime("%Y-%m-%d")
            
            # Get previous close data
            params = {
                "apiKey": self.api_key,
                "adjusted": "true",
            }
            
            endpoint = f"/v2/aggs/ticker/{symbol}/range/1/day/{yesterday_str}/{today_str}"
            response = requests.get(f"{self.BASE_URL}{endpoint}", params=params)
            response.raise_for_status()
            
            data = response.json()
            
            # Extract the data
            if data.get("results"):
                latest = data["results"][-1]
                previous = data["results"][0] if len(data["results"]) > 1 else None
                
                # Calculate change
                change = 0
                change_percent = 0
                if previous:
                    change = latest["c"] - previous["c"]
                    change_percent = (change / previous["c"]) * 100
                
                result[symbol] = {
                    "symbol": symbol,
                    "name": self._get_index_name(symbol),
                    "price": latest["c"],
                    "change": change,
                    "change_percent": change_percent,
                    "volume": latest["v"],
                    "timestamp": latest["t"],
                }
        
        return result
    
    def _get_index_name(self, symbol: str) -> str:
        """Get the full name of an index from its symbol"""
        names = {
            "SPY": "S&P 500 ETF",
            "QQQ": "Nasdaq 100 ETF",
            "DIA": "Dow Jones Industrial Average ETF",
            "IWM": "Russell 2000 ETF",
        }
        return names.get(symbol, symbol)
