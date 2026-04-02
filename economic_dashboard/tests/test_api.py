import pytest
import responses
import json
from app.api.fred import FredClient
from app.api.bls import BLSClient
from app.api.news import NewsClient
from app.api.market import MarketClient

@pytest.fixture
def mock_fred_api():
    with responses.RequestsMock() as rsps:
        # Mock series observations endpoint
        rsps.add(
            responses.GET,
            'https://api.stlouisfed.org/fred/series/observations',
            json={
                'observations': [
                    {'date': '2020-01-01', 'value': '100'},
                    {'date': '2020-04-01', 'value': '90'},
                    {'date': '2020-07-01', 'value': '95'},
                    {'date': '2020-10-01', 'value': '105'},
                    {'date': '2021-01-01', 'value': '110'}
                ]
            },
            status=200
        )
        
        # Mock series metadata endpoint
        rsps.add(
            responses.GET,
            'https://api.stlouisfed.org/fred/series',
            json={
                'seriess': [
                    {
                        'id': 'GDP',
                        'title': 'Gross Domestic Product',
                        'units': 'Billions of Dollars',
                        'frequency': 'Quarterly'
                    }
                ]
            },
            status=200
        )
        
        yield rsps

def test_fred_client(mock_fred_api):
    """Test FRED API client"""
    client = FredClient(api_key='test_key')
    result = client.get_series('GDP')
    
    assert result['id'] == 'GDP'
    assert result['title'] == 'Gross Domestic Product'
    assert result['units'] == 'Billions of Dollars'
    assert result['frequency'] == 'Quarterly'
    assert len(result['observations']) == 5
    assert result['last_value'] == '110'
    assert result['last_updated'] == '2021-01-01'

@pytest.fixture
def mock_bls_api():
    with responses.RequestsMock() as rsps:
        rsps.add(
            responses.POST,
            'https://api.bls.gov/publicAPI/v2/timeseries/data/',
            json={
                'status': 'REQUEST_SUCCEEDED',
                'Results': {
                    'series': [
                        {
                            'seriesID': 'CES0000000001',
                            'data': [
                                {'year': '2021', 'period': 'M01', 'value': '150000'},
                                {'year': '2021', 'period': 'M02', 'value': '151000'}
                            ]
                        },
                        {
                            'seriesID': 'LNS14000000',
                            'data': [
                                {'year': '2021', 'period': 'M01', 'value': '6.3'},
                                {'year': '2021', 'period': 'M02', 'value': '6.2'}
                            ]
                        }
                    ]
                }
            },
            status=200
        )
        
        yield rsps

def test_bls_client(mock_bls_api):
    """Test BLS API client"""
    client = BLSClient(api_key='test_key')
    result = client.get_employment_data()
    
    assert 'nonfarm_employment' in result
    assert 'unemployment_rate' in result
    assert result['nonfarm_employment']['title'] == 'Total Nonfarm Employment'
    assert result['nonfarm_employment']['last_value'] == '150000'
    assert result['unemployment_rate']['title'] == 'Unemployment Rate'
    assert result['unemployment_rate']['last_value'] == '6.3'
