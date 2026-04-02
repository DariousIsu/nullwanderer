from dataclasses import dataclass
from typing import List, Dict, Any, Optional
from datetime import datetime

@dataclass
class EconomicIndicator:
    """Base class for economic indicators"""
    id: str
    title: str
    last_value: str
    last_updated: str
    trend: Optional[str] = None  # "up", "down", or "stable"
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "last_value": self.last_value,
            "last_updated": self.last_updated,
            "trend": self.trend,
        }

@dataclass
class GDPIndicator(EconomicIndicator):
    """Gross Domestic Product indicator"""
    growth_rate: Optional[float] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = super().to_dict()
        result["growth_rate"] = self.growth_rate
        return result

@dataclass
class InflationIndicator(EconomicIndicator):
    """Inflation indicator"""
    annual_rate: Optional[float] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = super().to_dict()
        result["annual_rate"] = self.annual_rate
        return result

@dataclass
class UnemploymentIndicator(EconomicIndicator):
    """Unemployment indicator"""
    previous_value: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = super().to_dict()
        result["previous_value"] = self.previous_value
        return result

@dataclass
class MarketIndex:
    """Market index data"""
    symbol: str
    name: str
    price: float
    change: float
    change_percent: float
    volume: int
    timestamp: int
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "price": self.price,
            "change": self.change,
            "change_percent": self.change_percent,
            "volume": self.volume,
            "timestamp": self.timestamp,
        }

@dataclass
class NewsArticle:
    """News article data"""
    title: str
    source: str
    url: str
    published_at: str
    description: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "title": self.title,
            "source": self.source,
            "url": self.url,
            "published_at": self.published_at,
            "description": self.description,
        }

@dataclass
class DashboardData:
    """Complete dashboard data"""
    economic_indicators: List[EconomicIndicator]
    market_indices: List[MarketIndex]
    news_articles: List[NewsArticle]
    last_updated: str
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "economic_indicators": [indicator.to_dict() for indicator in self.economic_indicators],
            "market_indices": [index.to_dict() for index in self.market_indices],
            "news_articles": [article.to_dict() for article in self.news_articles],
            "last_updated": self.last_updated,
        }
