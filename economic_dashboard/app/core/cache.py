from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Tuple

@dataclass
class CacheItem:
    value: Any
    expiry: datetime

class Cache:
    def __init__(self, max_size: int = 100):
        self.max_size = max_size
        self.cache: OrderedDict[str, CacheItem] = OrderedDict()
    
    def get(self, key: str) -> Optional[Any]:
        if key not in self.cache:
            return None
        
        item = self.cache[key]
        if item.expiry < datetime.now():
            del self.cache[key]
            return None
        
        # Move to end to mark as recently used
        self.cache.move_to_end(key)
        return item.value
    
    def set(self, key: str, value: Any, ttl_seconds: int = 3600) -> None:
        if key in self.cache:
            del self.cache[key]
        
        # If cache is full, remove least recently used item
        if len(self.cache) >= self.max_size:
            self.cache.popitem(last=False)
        
        expiry = datetime.now() + timedelta(seconds=ttl_seconds)
        self.cache[key] = CacheItem(value=value, expiry=expiry)
