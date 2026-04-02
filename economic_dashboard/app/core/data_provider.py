from typing import Dict, Any, Optional
from app.core.cache import Cache
from app.api.fred import FredClient
from app.api.bls import BLSClient
from app.api.news import NewsClient
from app.api.market import MarketClient

class DataProvider:
    def __init__(self, fred_client: FredClient, bls_client: BLSClient, 
                 news_client: NewsClient, market_client: MarketClient):
        self.fred_client = fred_client
        self.bls_client = bls_client
        self.news_client = news_client
        self.market_client = market_client
        self.cache = Cache(max_size=200)
    
    def get_dashboard_data(self) -> Dict[str, Any]:
        """Get all data needed for the dashboard"""
        return {
            "economic_indicators": self.get_economic_indicators(),
            "market_data": self.get_market_data(),
            "news": self.get_economic_news()
        }
    
    def get_economic_indicators(self) -> Dict[str, Any]:
        """Get economic indicators from FRED and BLS"""
        cache_key = "economic_indicators"
        cached_data = self.cache.get(cache_key)
        
        if cached_data:
            return cached_data
        
        # Get data from FRED
        gdp = self.fred_client.get_series("GDP")
        unemployment = self.fred_client.get_series("UNRATE")
        inflation = self.fred_client.get_series("CPIAUCSL")
        
        # Get data from BLS
        employment = self.bls_client.get_employment_data()
        
        data = {
            "gdp": gdp,
            "unemployment": unemployment,
            "inflation": inflation,
            "employment": employment
        }
        
        self.cache.set(cache_key, data, ttl_seconds=3600)  # Cache for 1 hour
        return data
    
    def get_market_data(self) -> Dict[str, Any]:
        """Get market data"""
        cache_key = "market_data"
        cached_data = self.cache.get(cache_key)
        
        if cached_data:
            return cached_data
        
        data = self.market_client.get_market_indices()
        self.cache.set(cache_key, data, ttl_seconds=300)  # Cache for 5 minutes
        return data
    
    def get_economic_news(self) -> Dict[str, Any]:
        """Get economic news"""
        cache_key = "economic_news"
        cached_data = self.cache.get(cache_key)
        
        if cached_data:
            return cached_data
        
        data = self.news_client.get_economic_news()
        self.cache.set(cache_key, data, ttl_seconds=1800)  # Cache for 30 minutes
        return data
