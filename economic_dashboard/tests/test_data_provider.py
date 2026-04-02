import pytest
from unittest.mock import MagicMock, patch
from app.core.data_provider import DataProvider

@pytest.fixture
def mock_clients():
    fred_client = MagicMock()
    bls_client = MagicMock()
    news_client = MagicMock()
    market_client = MagicMock()
    
    # Mock FRED client responses
    fred_client.get_series.side_effect = lambda series_id: {
        'GDP': {
            'id': 'GDP',
            'title': 'Gross Domestic Product',
            'last_value': '23000.0',
            'last_updated': '2021-01-01',
            'observations': [{'date': '2020-10-01', 'value': '22000.0'}, {'date': '2021-01-01', 'value': '23000.0'}]
        },
        'UNRATE': {
            'id': 'UNRATE',
            'title': 'Unemployment Rate',
            'last_value': '5.8',
            'last_updated': '2021-02-01',
            'observations': [{'date': '2021-01-01', 'value': '6.0'}, {'date': '2021-02-01', 'value': '5.8'}]
        },
        'CPIAUCSL': {
            'id': 'CPIAUCSL',
            'title': 'Consumer Price Index',
            'last_
# Continue creating tests/test_data_provider.py
@"
import pytest
from unittest.mock import MagicMock, patch
from app.core.data_provider import DataProvider

@pytest.fixture
def mock_clients():
    fred_client = MagicMock()
    bls_client = MagicMock()
    news_client = MagicMock()
    market_client = MagicMock()
    
    # Mock FRED client responses
    fred_client.get_series.side_effect = lambda series_id: {
        'GDP': {
            'id': 'GDP',
            'title': 'Gross Domestic Product',
            'last_value': '23000.0',
            'last_updated': '2021-01-01',
            'observations': [{'date': '2020-10-01', 'value': '22000.0'}, {'date': '2021-01-01', 'value': '23000.0'}]
        },
        'UNRATE': {
            'id': 'UNRATE',
            'title': 'Unemployment Rate',
            'last_value': '5.8',
            'last_updated': '2021-02-01',
            'observations': [{'date': '2021-01-01', 'value': '6.0'}, {'date': '2021-02-01', 'value': '5.8'}]
        },
        'CPIAUCSL': {
            'id': 'CPIAUCSL',
            'title': 'Consumer Price Index',
            'last_value': '264.5',
            'last_updated': '2021-02-01',
            'observations': [{'date': '2021-01-01', 'value': '262.2'}, {'date': '2021-02-01', 'value': '264.5'}]
        }
    }.get(series_id, {})
    
    # Mock BLS client response
    bls_client.get_employment_data.return_value = {
        'nonfarm_employment': {
            'title': 'Total Nonfarm Employment',
            'last_value': '150000',
            'last_updated': '2021-02',
            'data': [{'year': '2021', 'period': 'M01', 'value': '149000'}, {'year': '2021', 'period': 'M02', 'value': '150000'}]
        },
        'unemployment_rate': {
            'title': 'Unemployment Rate',
            'last_value': '6.2',
            'last_updated': '2021-02',
            'data': [{'year': '2021', 'period': 'M01', 'value': '6.3'}, {'year': '2021', 'period': 'M02', 'value': '6.2'}]
        }
    }
    
    # Mock News client response
    news_client.get_economic_news.return_value = {
        'articles': [
            {
                'title': 'Economic Growth Surges',
                'source': {'name': 'Financial Times'},
                'url': 'https://example.com/news/1',
                'publishedAt': '2021-02-15T12:00:00Z',
                'description': 'The economy is growing faster than expected.'
            },
            {
                'title': 'Inflation Concerns Rise',
                'source': {'name': 'Wall Street Journal'},
                'url': 'https://example.com/news/2',
                'publishedAt': '2021-02-14T14:30:00Z',
                'description': 'Inflation is becoming a concern for policymakers.'
            }
        ],
        'total_results': 2
    }
    
    # Mock Market client response
    market_client.get_market_indices.return_value = {
        'SPY': {
            'symbol': 'SPY',
            'name': 'S&P 500 ETF',
            'price': 420.0,
            'change': 2.5,
            'change_percent': 0.6,
            'volume': 75000000,
            'timestamp': 1613574000000
        },
        'QQQ': {
            'symbol': 'QQQ',
            'name': 'Nasdaq 100 ETF',
            'price': 330.0,
            'change': -1.2,
            'change_percent': -0.4,
            'volume': 45000000,
            'timestamp': 1613574000000
        }
    }
    
    return fred_client, bls_client, news_client, market_client

def test_get_dashboard_data(mock_clients):
    """Test getting complete dashboard data"""
    fred_client, bls_client, news_client, market_client = mock_clients
    
    data_provider = DataProvider(
        fred_client=fred_client,
        bls_client=bls_client,
        news_client=news_client,
        market_client=market_client
    )
    
    result = data_provider.get_dashboard_data()
    
    # Check that all sections are present
    assert 'economic_indicators' in result
    assert 'market_data' in result
    assert 'news' in result
    
    # Check economic indicators
    indicators = result['economic_indicators']
    assert 'gdp' in indicators
    assert 'unemployment' in indicators
    assert 'inflation' in indicators
    assert 'employment' in indicators
    
    # Check market data
    market_data = result['market_data']
    assert 'SPY' in market_data
    assert 'QQQ' in market_data
    
    # Check news
    news = result['news']
    assert 'articles' in news
    assert len(news['articles']) == 2

def test_caching(mock_clients):
    """Test that data is cached properly"""
    fred_client, bls_client, news_client, market_client = mock_clients
    
    data_provider = DataProvider(
        fred_client=fred_client,
        bls_client=bls_client,
        news_client=news_client,
        market_client=market_client
    )
    
    # First call should hit the APIs
    data_provider.get_economic_indicators()
    
    # Reset mock call counts
    fred_client.get_series.reset_mock()
    bls_client.get_employment_data.reset_mock()
    
    # Second call should use cache
    data_provider.get_economic_indicators()
    
    # Verify that the API clients weren't called again
    fred_client.get_series.assert_not_called()
    bls_client.get_employment_data.assert_not_called()
