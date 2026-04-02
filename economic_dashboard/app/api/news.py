import os
import requests
from typing import Dict, Any, Optional, List
from app.core.rate_limiter import RateLimiter

class NewsClient:
    """Client for the News API"""
    
    BASE_URL = "https://newsapi.org/v2"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("NEWS_API_KEY")
        if not self.api_key:
            raise ValueError("News API key is required")
        
        # Limit to 100 requests per day for the free plan
        self.rate_limiter = RateLimiter(calls=100, period=86400)  # 24 hours
    
    def get_economic_news(self, max_articles: int = 10) -> Dict[str, Any]:
        """
        Get economic news articles
        
        Args:
            max_articles: Maximum number of articles to return
            
        Returns:
            Dict containing news articles
        """
        self.rate_limiter.wait_if_needed("news")
        
        params = {
            "apiKey": self.api_key,
            "q": "economy OR economic OR finance OR financial",
            "language": "en",
            "sortBy": "publishedAt",
            "pageSize": max_articles,
        }
        
        response = requests.get(f"{self.BASE_URL}/top-headlines", params=params)
        response.raise_for_status()
        
        data = response.json()
        
        # Format the response
        result = {
            "articles": data.get("articles", []),
            "total_results": data.get("totalResults", 0),
        }
        
        return result
