import time
import threading
from typing import Dict, Tuple

class RateLimiter:
    def __init__(self, calls: int, period: int):
        """
        Initialize rate limiter
        
        Args:
            calls: Number of calls allowed in the period
            period: Time period in seconds
        """
        self.calls = calls
        self.period = period
        self.timestamps: Dict[str, list] = {}
        self.lock = threading.Lock()
    
    def can_request(self, key: str) -> bool:
        """
        Check if a request can be made for the given key
        
        Args:
            key: Identifier for the rate limit (e.g., API name)
            
        Returns:
            bool: True if request is allowed, False otherwise
        """
        with self.lock:
            now = time.time()
            
            if key not in self.timestamps:
                self.timestamps[key] = []
            
            # Remove timestamps older than the period
            self.timestamps[key] = [t for t in self.timestamps[key] if now - t <= self.period]
            
            # Check if we've reached the limit
            if len(self.timestamps[key]) >= self.calls:
                return False
            
            # Add current timestamp and allow request
            self.timestamps[key].append(now)
            return True
    
    def wait_if_needed(self, key: str) -> None:
        """
        Wait until a request can be made
        
        Args:
            key: Identifier for the rate limit
        """
        while not self.can_request(key):
            time.sleep(1)
