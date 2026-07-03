/*
 * lib/api_catalog.js — the API MANAGEMENT STREAM registry (hard-coded to start).
 *
 * A single source of truth for the free public-data APIs Zoe can call: base URL, category, the KEYRING env
 * var that holds the key (resolved via lib/config → .env / OS keychain), and each API's AUTH CONVENTION
 * (they all differ — query param vs header vs bearer vs POST body). lib/api_client consumes this to build a
 * correctly-authenticated request for ANY of them from one call shape. Pure data + tiny selectors; no I/O.
 *
 * Adding an API later = one entry here (the "hard-coded" phase). A DB-backed registry / usage + rate-limit
 * tracking / scheduled pulls are later slices of the stream.
 */
'use strict';

// auth.type: 'query' (key as a querystring param) | 'header' (key as a header value) | 'bearer'
//            (Authorization: Bearer <key>) | 'body' (key merged into the POST JSON body).
// auth.param: the param/header name that carries the key. auth.extraHeaders: always-sent headers (e.g. Notion-Version).
const APIS = [
  { id: 'fred', name: 'FRED (Federal Reserve Economic Data)', category: 'economics',
    baseUrl: 'https://api.stlouisfed.org/fred', keyEnv: 'FRED_API_KEY',
    auth: { type: 'query', param: 'api_key' }, docs: 'https://fred.stlouisfed.org/docs/api/fred/',
    note: 'Add &file_type=json. e.g. GET /series/observations?series_id=GDP' },

  { id: 'fec', name: 'OpenFEC (Federal Election Commission)', category: 'elections',
    baseUrl: 'https://api.open.fec.gov/v1', keyEnv: 'FEC_API_KEY',
    auth: { type: 'query', param: 'api_key' }, docs: 'https://api.open.fec.gov/developers/',
    note: 'e.g. GET /candidates/?q=... 1000/hr free tier' },

  { id: 'bls', name: 'BLS (Bureau of Labor Statistics) v2', category: 'economics',
    baseUrl: 'https://api.bls.gov/publicAPI/v2', keyEnv: 'BLS_API_KEY',
    auth: { type: 'body', param: 'registrationkey' }, method: 'POST', docs: 'https://www.bls.gov/developers/',
    note: 'POST /timeseries/data/ with {seriesid:[...], startyear, endyear}. 500 queries/day w/ key' },

  { id: 'bea', name: 'BEA (Bureau of Economic Analysis)', category: 'economics',
    baseUrl: 'https://apps.bea.gov/api', keyEnv: 'BEA_API_KEY',
    auth: { type: 'query', param: 'UserID' }, docs: 'https://apps.bea.gov/api/signup/',
    note: 'GET /data?method=GetData&datasetname=...&ResultFormat=JSON' },

  { id: 'census', name: 'US Census Bureau', category: 'demographics',
    baseUrl: 'https://api.census.gov/data', keyEnv: 'CENSUS_API_KEY',
    auth: { type: 'query', param: 'key' }, docs: 'https://www.census.gov/data/developers/data-sets.html',
    note: 'e.g. GET /2021/acs/acs1?get=NAME,B01001_001E&for=state:*' },

  { id: 'newsapi', name: 'NewsAPI.org', category: 'news',
    baseUrl: 'https://newsapi.org/v2', keyEnv: 'NEWS_API_KEY',
    auth: { type: 'header', param: 'X-Api-Key' }, docs: 'https://newsapi.org/docs',
    note: 'GET /everything?q=... or /top-headlines. 100 req/day free' },

  { id: 'polygon', name: 'Polygon.io (markets)', category: 'markets',
    baseUrl: 'https://api.polygon.io', keyEnv: 'POLYGON_API_KEY',
    auth: { type: 'query', param: 'apiKey' }, docs: 'https://polygon.io/docs',
    note: 'GET /v2/aggs/ticker/AAPL/... 5 req/min free' },

  { id: 'alphavantage', name: 'Alpha Vantage (markets)', category: 'markets',
    baseUrl: 'https://www.alphavantage.co', keyEnv: 'ALPHA_VANTAGE_API_KEY',
    auth: { type: 'query', param: 'apikey' }, docs: 'https://www.alphavantage.co/documentation/',
    note: 'GET /query?function=TIME_SERIES_DAILY&symbol=IBM. 25 req/day free' },

  { id: 'fmp', name: 'Financial Modeling Prep', category: 'markets',
    baseUrl: 'https://financialmodelingprep.com/api/v3', keyEnv: 'FMP_API_KEY',
    auth: { type: 'query', param: 'apikey' }, docs: 'https://site.financialmodelingprep.com/developer/docs',
    note: 'GET /quote/AAPL, /income-statement/AAPL. 250 req/day free' },

  { id: 'openweather', name: 'OpenWeatherMap', category: 'weather',
    baseUrl: 'https://api.openweathermap.org/data/2.5', keyEnv: 'OPENWEATHER_API_KEY',
    auth: { type: 'query', param: 'appid' }, docs: 'https://openweathermap.org/api',
    note: 'GET /weather?q=London or ?lat=&lon=. 60 req/min free' },

  { id: 'notion', name: 'Notion API', category: 'productivity',
    baseUrl: 'https://api.notion.com/v1', keyEnv: 'NOTION_API_KEY',
    auth: { type: 'bearer', param: 'Authorization', extraHeaders: { 'Notion-Version': '2022-06-28' } },
    docs: 'https://developers.notion.com/reference', note: 'GET /users/me to verify the token' },
];

const BY_ID = Object.fromEntries(APIS.map((a) => [a.id, a]));

function list() { return APIS.slice(); }
function get(id) { return BY_ID[String(id || '').toLowerCase()] || null; }
function ids() { return APIS.map((a) => a.id); }
function byCategory(cat) { const c = String(cat || '').toLowerCase(); return APIS.filter((a) => a.category === c); }
function categories() { return [...new Set(APIS.map((a) => a.category))].sort(); }

module.exports = { APIS, list, get, ids, byCategory, categories };
