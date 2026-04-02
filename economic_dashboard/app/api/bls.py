import os
import requests
import json
from typing import Dict, Any, Optional, List
from app.core.rate_limiter import RateLimiter

class BLSClient:
    """Client for the Bureau of Labor Statistics (BLS) API"""
    
    BASE_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("BLS_API_KEY")
        # BLS allows anonymous access with rate limits
        # With API key, limit is 500 requests per day
        # Without API key, limit is 50 requests per day
        self.rate_limiter = RateLimiter(calls=50 if not self.api_key else 500, period=86400)  # 24 hours
    
    def get_employment_data(self) -> Dict[str, Any]:
        """
        Get employment data from BLS
        
        Returns:
            Dict containing employment data
        """
        self.rate_limiter.wait_if_needed("bls")
        
        # Series IDs for employment data
        # CES0000000001 - Total nonfarm employment
        # LNS14000000 - Unemployment Rate
        series_ids = ["CES0000000001", "LNS14000000"]
        
        headers = {"Content-Type": "application/json"}
        data = {
            "seriesid": series_ids,
            "startyear": "2020",
            "endyear": "2025",
        }
        
        if self.api_key:
            data["registrationkey"] = self.api_key
        
        response = requests.post(
            self.BASE_URL,
            headers=headers,
            data=json.dumps(data)
        )
        response.raise_for_status()
        
        result = response.json()
        
        # Format the response
        formatted_data = {}
        if result.get("status") == "REQUEST_SUCCEEDED":
            for series in result.get("Results", {}).get("series", []):
                series_id = series.get("seriesID")
                if series_id == "CES0000000001":
                    formatted_data["nonfarm_employment"] = {
                        "title": "Total Nonfarm Employment",
                        "data": series.get("data", []),
                        "last_value": series.get("data", [{}])[0].get("value", "Unknown"),
                        "last_updated": f"{series.get('data', [{}])[0].get('year')}-{series.get('data', [{}])[0].get('period').replace('M', '')}",
                    }
                elif series_id == "LNS14000000":
                    formatted_data["unemployment_rate"] = {
                        "title": "Unemployment Rate",
                        "data": series.get("data", []),
                        "last_value": series.get("data", [{}])[0].get("value", "Unknown"),
                        "last_updated": f"{series.get('data', [{}])[0].get('year')}-{series.get('data', [{}])[0].get('period').replace('M', '')}",
                    }
        
        return formatted_data
