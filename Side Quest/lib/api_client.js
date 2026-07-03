/*
 * lib/api_client.js — the API MANAGEMENT STREAM caller.
 *
 * One call shape for every catalogued public API. It resolves the key from the keyring (lib/config → .env),
 * builds a correctly-AUTHENTICATED request per that API's convention (query param / header / bearer / POST
 * body — see lib/api_catalog), fetches, and returns a normalized { ok, status, data | error }. Auth style
 * differences are hidden here so callers (the forecasting suite, etc.) never re-learn each API's quirks.
 *
 * fetch + config are INJECTABLE so request-building is fully offline-testable (no network, no real keys).
 * The key value is never logged. Health of the keyring is exposed via keyStatus() (the "management" view).
 */
'use strict';
const catalog = require('./api_catalog');

// PURE: catalog entry + path/params → the exact { url, method, headers, body } to fetch, with auth injected.
// `path` may be an endpoint path (appended to baseUrl) or an absolute URL. `key` injected (never resolved here).
function buildRequest(api, path, { params = {}, method = null, body = null, key = null } = {}) {
  if (!api) throw new Error('buildRequest: no api');
  const p = String(path == null ? '' : path);
  const base = /^https?:\/\//i.test(p) ? p : (api.baseUrl.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, ''));
  const url = new URL(base);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));

  const auth = api.auth || {};
  const headers = Object.assign({ Accept: 'application/json' }, auth.extraHeaders || {});
  let outBody = body;
  if (key) {
    if (auth.type === 'query') url.searchParams.set(auth.param, key);
    else if (auth.type === 'header') headers[auth.param] = key;
    else if (auth.type === 'bearer') headers.Authorization = 'Bearer ' + key;
    else if (auth.type === 'body') outBody = Object.assign({}, body || {}, { [auth.param]: key });
  }
  const req = { url: url.toString(), method: (method || api.method || (auth.type === 'body' ? 'POST' : 'GET')).toUpperCase(), headers };
  if (outBody != null) {
    req.body = typeof outBody === 'string' ? outBody : JSON.stringify(outBody);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  return req;
}

// Resolve the keyring key for an api. Returns the trimmed value or null. Never logs it. `cfg` injectable.
function resolveKey(api, cfg) {
  if (!api || !api.keyEnv) return null;
  const conf = cfg || require('./config');
  const v = (conf.get(api.keyEnv) || '').trim();
  return v || null;
}

// Call a catalogued API. opts: { params, method, body, fetch, config, timeoutMs }. Returns a normalized
// { ok, status, data|error }. fetch defaults to the global; config to lib/config. Never throws.
async function call(apiId, path, { params = {}, method = null, body = null, fetch: fetchFn = null, config: cfg = null, timeoutMs = 20000 } = {}) {
  const api = catalog.get(apiId);
  if (!api) return { ok: false, error: `unknown api: ${apiId}` };
  const key = resolveKey(api, cfg);
  if (api.keyEnv && !key) return { ok: false, error: `missing key ${api.keyEnv} — add it to the keyring (.env)` };

  let req;
  try { req = buildRequest(api, path, { params, method, body, key }); }
  catch (e) { return { ok: false, error: 'build failed: ' + e.message }; }

  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, error: 'no fetch available' };

  // AbortController timeout (fetch may not honor a bare timeout option).
  let ctrl = null, timer = null;
  try { ctrl = new AbortController(); timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs); } catch {}
  try {
    const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl ? ctrl.signal : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: !!res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? `timeout after ${timeoutMs}ms` : (e && e.message) || 'fetch failed' };
  } finally { if (timer) clearTimeout(timer); }
}

// MANAGEMENT view: which catalogued APIs currently have their key present in the keyring (no values). `cfg` injectable.
function keyStatus({ config: cfg } = {}) {
  return catalog.list().map((a) => ({ id: a.id, name: a.name, category: a.category, keyEnv: a.keyEnv, hasKey: !!resolveKey(a, cfg) }));
}

module.exports = { buildRequest, resolveKey, call, keyStatus };
