import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'you-will-never-guess'
    FRED_API_KEY = os.environ.get('FRED_API_KEY')
    BLS_API_KEY = os.environ.get('BLS_API_KEY')
    NEWS_API_KEY = os.environ.get('NEWS_API_KEY')
    POLYGON_API_KEY = os.environ.get('POLYGON_API_KEY')
