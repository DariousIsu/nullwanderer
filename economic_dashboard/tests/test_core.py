import pytest
from app.core.cache import Cache
from datetime import datetime, timedelta
import time

def test_cache_set_get():
    """Test basic cache set and get operations"""
    cache = Cache(max_size=10)
    cache.set("test_key", "test_value")
    
    assert cache.get("test_key") == "test_value"
    assert cache.get("nonexistent_key") is None

def test_cache_expiration():
    """Test cache item expiration"""
    cache = Cache(max_size=10)
    cache.set("test_key", "test_value", ttl_seconds=1)
    
    assert cache.get("test_key") == "test_value"
    
    # Wait for expiration
    time.sleep(1.1)
    
    assert cache.get("test_key") is None

def test_cache_max_size():
    """Test cache respects max size limit"""
    cache = Cache(max_size=2)
    
    cache.set("key1", "value1")
    cache.set("key2", "value2")
    
    assert len(cache.cache) == 2
    
    # Add a third item, should evict the first one (LRU)
    cache.set("key3", "value3")
    
    assert len(cache.cache) == 2
    assert cache.get("key1") is None
    assert cache.get("key2") == "value2"
    assert cache.get("key3") == "value3"

def test_cache_lru_behavior():
    """Test cache follows LRU (Least Recently Used) behavior"""
    cache = Cache(max_size=2)
    
    cache.set("key1", "value1")
    cache.set("key2", "value2")
    
    # Access key1 to make it the most recently used
    cache.get("key1")
    
    # Add a third item, should evict key2 (least recently used)
    cache.set("key3", "value3")
    
    assert cache.get("key1") == "value1"
    assert cache.get("key2") is None
    assert cache.get("key3") == "value3"
