import os
import requests
from typing import Dict, Any, Optional
from app.core.rate_limiter import RateLimiter

class FredClient:
    """Client for the Federal Reserve Economic Data (FRED) API"""
    
    BASE_URL = "https://api.stlouisfed.org/fred/series"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("FRED_API_KEY")
        if not self.api_key:
            raise ValueError("FRED API key is required")
        
        # Limit to 120 requests per minute as per FRED API guidelines
        self.rate_limiter = RateLimiter(calls=120, period=60)
    
    def get_series(self, series_id: str) -> Dict[str, Any]:
        """
        Get data for a specific FRED series
        
        Args:
            series_id: The FRED series identifier (e.g., 'GDP', 'UNRATE')
            
        Returns:
            Dict containing the series data
        """
        self.rate_limiter.wait_if_needed("fred")
        
        params = {
            "series_id": series_id,
            "api_key": self.api_key,
            "file_type": "json",
            "observation_start": "2010-01-01",  # Last decade of data
        }
        
        # Get series information
        info_params = params.copy()
        info_params["observation_start"] = None
        response = requests.get(f"{self.BASE_URL}/observations", params=params)
        response.raise_for_status()
        
        data = response.json()
        
        # Get metadata
        meta_response = requests.get(f"{self.BASE_URL}", params=info_params)
        meta_response.raise_for_status()
        metadata = meta_response.json()
        
        # Format the response
        result = {
            "id": series_id,
            "title": metadata.get("seriess", [{}])[0].get("title", "Unknown"),
            "units": metadata.get("seriess", [{}])[0].get("units", ""),
            "frequency": metadata.get("seriess", [{}])[0].get("frequency", ""),
            "observations": data.get("observations", []),
            "last_updated": data.get("observations", [{}])[-1].get("date", "Unknown"),
            "last_value": data.get("observations", [{}])[-1].get("value", "Unknown"),
        }
        
        return result
