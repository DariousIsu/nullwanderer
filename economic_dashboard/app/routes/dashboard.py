from flask import Blueprint, render_template, jsonify, current_app
from datetime import datetime
from app.api.fred import FredClient
from app.api.bls import BLSClient
from app.api.news import NewsClient
from app.api.market import MarketClient
from app.core.data_provider import DataProvider
from app.models.indicators import (
    EconomicIndicator, GDPIndicator, InflationIndicator, 
    UnemploymentIndicator, MarketIndex, NewsArticle, DashboardData
)

bp = Blueprint('dashboard', __name__)

@bp.route('/')
def index():
    """Render the dashboard page"""
    return render_template('dashboard.html')

@bp.route('/api/dashboard-data')
def dashboard_data():
    """API endpoint to get dashboard data"""
    try:
        # Initialize API clients
        fred_client = FredClient(current_app.config['FRED_API_KEY'])
        bls_client = BLSClient(current_app.config['BLS_API_KEY'])
        news_client = NewsClient(current_app.config['NEWS_API_KEY'])
        market_client = MarketClient(current_app.config['POLYGON_API_KEY'])
        
        # Initialize data provider
        data_provider = DataProvider(
            fred_client=fred_client,
            bls_client=bls_client,
            news_client=news_client,
            market_client=market_client
        )
        
        # Get dashboard data
        data = data_provider.get_dashboard_data()
        
        # Process economic indicators
        economic_indicators = []
        
        # GDP
        if 'gdp' in data['economic_indicators']:
            gdp_data = data['economic_indicators']['gdp']
            gdp = GDPIndicator(
                id="gdp",
                title=gdp_data['title'],
                last_value=gdp_data['last_value'],
                last_updated=gdp_data['last_updated'],
                growth_rate=calculate_growth_rate(gdp_data['observations'])
            )
            economic_indicators.append(gdp)
        
        # Inflation
        if 'inflation' in data['economic_indicators']:
            inflation_data = data['economic_indicators']['inflation']
            inflation = InflationIndicator(
                id="inflation",
                title=inflation_data['title'],
                last_value=inflation_data['last_value'],
                last_updated=inflation_data['last_updated'],
                annual_rate=calculate_annual_rate(inflation_data['observations'])
            )
            economic_indicators.append(inflation)
        
        # Unemployment
        if 'unemployment' in data['economic_indicators']:
            unemployment_data = data['economic_indicators']['unemployment']
            unemployment = UnemploymentIndicator(
                id="unemployment",
                title=unemployment_data['title'],
                last_value=unemployment_data['last_value'],
                last_updated=unemployment_data['last_updated'],
                previous_value=get_previous_value(unemployment_data['observations'])
            )
            economic_indicators.append(unemployment)
        
        # Process market data
        market_indices = []
        for symbol, index_data in data['market_data'].items():
            market_index = MarketIndex(
                symbol=symbol,
                name=index_data['name'],
                price=index_data['price'],
                change=index_data['change'],
                change_percent=index_data['change_percent'],
                volume=index_data['volume'],
                timestamp=index_data['timestamp']
            )
            market_indices.append(market_index)
        
        # Process news articles
        news_articles = []
        for article in data['news'].get('articles', [])[:5]:  # Limit to 5 articles
            news_article = NewsArticle(
                title=article['title'],
                source=article['source']['name'],
                url=article['url'],
                published_at=article['publishedAt'],
                description=article.get('description')
            )
            news_articles.append(news_article)
        
        # Create dashboard data
        dashboard_data = DashboardData(
            economic_indicators=economic_indicators,
            market_indices=market_indices,
            news_articles=news_articles,
            last_updated=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        )
        
        return jsonify(dashboard_data.to_dict())
    
    except Exception as e:
        current_app.logger.error(f"Error getting dashboard data: {str(e)}")
        return jsonify({"error": "Failed to load dashboard data"}), 500

def calculate_growth_rate(observations):
    """Calculate GDP growth rate from observations"""
    if len(observations) < 2:
        return None
    
    latest = float(observations[-1]['value'])
    previous = float(observations[-2]['value'])
    
    if previous == 0:
        return None
    
    return ((latest - previous) / previous) * 100

def calculate_annual_rate(observations):
    """Calculate annual inflation rate"""
    if len(observations) < 13:  # Need at least a year of data
        return None
    
    latest = float(observations[-1]['value'])
    year_ago = float(observations[-13]['value'])  # 12 months ago
    
    if year_ago == 0:
        return None
    
    return ((latest - year_ago) / year_ago) * 100

def get_previous_value(observations):
    """Get the previous value from observations"""
    if len(observations) < 2:
        return None
    
    return observations[-2]['value']
