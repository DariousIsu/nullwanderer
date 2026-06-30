/**
 * lib/gcal.js — Google Calendar v3 access for the Calendar surface, on Echo's OAuth.
 *
 * AUTH BRIDGE: Zoe is built ON TOP of Echo, and Echo already holds a full-scope Google OAuth grant
 * (`https://www.googleapis.com/auth/calendar`, read+write) for the operator's account. Rather than
 * stand up a second OAuth client, we reuse Echo's keychain refresh-token + OAuth client creds and mint
 * a FRESH access token ourselves via google-auth — the SAME bridge idea lib/keystore uses for the
 * cloud key. We shell to Echo's venv Python, build google.oauth2 Credentials from the refresh-token,
 * and FORCE a refresh (creds.refresh(Request())), then print `.token` + expiry to stdout into Zoe's
 * memory. The token is NEVER written to a file or logged — same handling Echo gives its secrets.
 *
 * Why force a refresh instead of Echo's get_credentials(): that helper trusts a cached `expires_at` in
 * saga.db and skips refresh when it looks valid — but a stale/incorrect cached expiry made it serve a
 * DEAD access token (Google 401). Minting fresh from the refresh-token sidesteps that cache entirely.
 * The refresh path uses google-auth (not requests_oauthlib), so it doesn't hit the oauthlib scope-drift
 * bug that affects the initial consent dance. Works whether or not the engine HTTP server is up.
 *
 * Echo's own calendar layer (echo/calendar) is read-only/pull (no write-back to Google), so for a
 * near-1:1 calendar we DON'T route through the suit — main calls the Calendar v3 REST API directly
 * with this bearer token. Read methods land first (Slice 0); event writes are operator-initiated.
 */
'use strict';
const { execFileSync } = require('child_process');

const API_BASE = 'https://www.googleapis.com/calendar/v3';

// In-memory token cache (never persisted by us — Echo owns persistence). { token, expMs }.
let _tok = null;

// Pull a fresh access token via Echo's get_credentials(). Returns { token, expMs } or null.
// Prints two lines from Python: line 1 = expiry epoch seconds (0 if unknown), line 2 = the token.
// stderr is suppressed so a keyring/refresh warning can never leak the value.
function fetchToken({ python, cwd, timeoutMs = 20000 } = {}) {
  if (!python || !cwd) return null;
  // Force a fresh access token from Echo's keychain refresh-token + OAuth client creds. expiry is a
  // naive UTC datetime from google-auth → tag it UTC before .timestamp() so the epoch is correct
  // (treating it as local would push the cached expiry hours off and re-serve a dead token).
  const code = [
    'import sys',
    'from datetime import timezone',
    'from google.oauth2.credentials import Credentials',
    'from google.auth.transport.requests import Request',
    'from echo.google_auth.oauth import _load_client_creds',
    'from echo.api_keys import get_key',
    'tok = ""; exp = 0',
    'rt = get_key("GOOGLE_OAUTH_REFRESH_TOKEN", required=False)',
    'if rt:',
    '    cid, csec = _load_client_creds()',
    '    c = Credentials(token=None, refresh_token=rt, token_uri="https://oauth2.googleapis.com/token", client_id=cid, client_secret=csec)',
    '    c.refresh(Request())',
    '    tok = c.token or ""',
    '    exp = int(c.expiry.replace(tzinfo=timezone.utc).timestamp()) if c.expiry else 0',
    'sys.stdout.write(str(exp) + "\\n" + tok)',
  ].join('\n');
  try {
    const out = execFileSync(python, ['-c', code], { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const nl = (out || '').indexOf('\n');
    if (nl < 0) return null;
    const exp = parseInt(out.slice(0, nl).trim(), 10) || 0;
    const token = out.slice(nl + 1).trim();
    if (!token) return null;
    return { token, expMs: exp ? exp * 1000 : (Date.now() + 50 * 60 * 1000) };
  } catch (e) {
    return null;
  }
}

// Cached token getter — re-shells only when missing or within 2 min of expiry (or force).
function getToken(opts = {}) {
  const { force = false } = opts;
  if (!force && _tok && _tok.token && _tok.expMs - Date.now() > 120000) return _tok.token;
  const t = fetchToken(opts);
  _tok = t;
  return t ? t.token : null;
}

// Is the operator's Google connected? (token resolvable) — cheap, used for the surface's status pill.
function isConnected(opts = {}) {
  return !!getToken(opts);
}

// Thin authed GET against Calendar v3. `path` is relative to API_BASE; `query` is an object.
// Returns parsed JSON. Throws on non-2xx with the status + Google error message.
async function apiGet(path, query, opts = {}) {
  const token = getToken(opts);
  if (!token) throw new Error('Google not connected (no access token from Echo)');
  const qs = query
    ? '?' + Object.entries(query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  const res = await fetch(`${API_BASE}${path}${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
    // On 401, drop the cached token so the next call re-shells a fresh one.
    if (res.status === 401) _tok = null;
    throw new Error(`gcal ${path}: ${msg}`);
  }
  return body;
}

// ---- read surface (Slice 0) ----

// All calendars the operator can see (owned + subscribed). { items: [...] }.
function listCalendars(opts = {}) {
  return apiGet('/users/me/calendarList', { minAccessRole: 'reader', maxResults: 250 }, opts);
}

// Events in one calendar within [timeMin, timeMax] (RFC3339). singleEvents expands recurrence for
// DISPLAY; orderBy=startTime requires singleEvents=true. Caller paginates via pageToken if needed.
function listEvents({ calendarId = 'primary', timeMin, timeMax, maxResults = 250, q, pageToken, singleEvents = true } = {}, opts = {}) {
  return apiGet(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin, timeMax, maxResults, q, pageToken,
    singleEvents, orderBy: singleEvents ? 'startTime' : undefined,
  }, opts);
}

// Color palette (calendar + event color id → {background, foreground}).
function colors(opts = {}) {
  return apiGet('/colors', null, opts);
}

// ---- write surface (Slice 3) — operator-initiated only ----

// Authed JSON send (POST/PUT/PATCH/DELETE). Returns parsed JSON (or {} for empty 2xx like DELETE).
async function apiSend(method, path, body, opts = {}) {
  const token = getToken(opts);
  if (!token) throw new Error('Google not connected (no access token from Echo)');
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return {};
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || `HTTP ${res.status}`;
    if (res.status === 401) _tok = null;
    throw new Error(`gcal ${method} ${path}: ${msg}`);
  }
  return parsed || {};
}

function createEvent(calendarId, body, opts = {}) {
  return apiSend('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body, opts);
}
function updateEvent(calendarId, eventId, body, opts = {}) {
  return apiSend('PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body, opts);
}
function deleteEvent(calendarId, eventId, opts = {}) {
  return apiSend('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, null, opts);
}

module.exports = {
  API_BASE, fetchToken, getToken, isConnected, apiGet, apiSend,
  listCalendars, listEvents, colors,
  createEvent, updateEvent, deleteEvent,
};
