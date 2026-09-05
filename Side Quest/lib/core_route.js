'use strict';
/**
 * lib/core_route.js — THE CORE UNDER THE IDLE LANE (docs/ZOE_CORE_SML_DESIGN_2026-09-05.md §15–§17; Lucas 09-05
 * 13:40 "make the custom model the core of her subconscious and leave it running all the time" · 14:10 "alright,
 * lets build it").
 *
 * A resident local model serves her idle mind when the cloud will not: the quota gate has closed the lane (5 h of
 * 09-05, measured), a cloud blip, an outage, a retired model — or first, for a lane he has moved to the core by his
 * card. The reply stays on the cloud (§14). Off by default: with `core.on` unset, lib/ollama.streamCognition is
 * byte-for-byte the path of record.
 *
 * The three conditions of §15 are code here:
 *   1. the model is small (a 4B-class tag) and RESIDENT (keep_alive -1) so a beat costs the new percept, not a load;
 *   2. a VRAM read before it loads — the GPU tenancy law of 09-05 (the machine hard-reset under a GPU job): the
 *      dedicated-memory counter is read and the core refuses to start when used + needed would pass the bar;
 *   3. the cloud is the escalation on a failed check, and lanes move one at a time (`core.first_lanes`).
 *
 * The shadow: while the cloud still answers a lane, the core answers the SAME messages off the hot path (sampled by
 * `core.shadow_rate`) and both texts are logged to data/core/shadow/<day>.jsonl — the agreement that decides when a
 * lane moves, and the corpus that decides whether a trainer is ever worth building (§16). Served calls are logged to
 * data/core/served/<day>.jsonl: the evidence that the lane did not switch off.
 *
 * Config (meta wins, env fills, ZOE_CORE=0 kills):
 *   core.on (0|1) · core.model (an Ollama tag already pulled) · core.num_ctx (8192) · core.keep_alive (-1)
 *   core.first_lanes (csv of lanes served core-first; default none) · core.shadow_rate (0..1; default 0)
 *   core.vram_bar_gb (the dedicated-VRAM ceiling the core may not push the card past; default 19)
 *
 * Pure decision (`decide`) and injectable I/O (`ready`, `serve`, `shadow`, `warm` take deps) so the smoke drives every
 * branch without a daemon. This module never requires lib/ollama at load (ollama requires it); it asks for it inside
 * the functions that need it.
 */

const fs = require('fs');
const path = require('path');

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
const KV_BYTES_PER_TOKEN = 147456;            // a 4B-class model, 16-bit K+V (§17: 36 layers × 8 kv heads × 128 × 2 × 2)
const LOAD_HEADROOM_GB = 0.5;                 // activations + the runner's own buffers
const READY_TTL_MS = 60 * 1000;
const VRAM_TTL_MS = 20 * 1000;
const SHADOW_BUDGET_MS = 60 * 1000;
const CORE_DIR = path.join(__dirname, '..', 'data', 'core');

function _getMeta(key) { try { return require('./db').getMeta(key); } catch { return null; } }

/** The configuration, meta over env; ZOE_CORE=0 is the kill. Never throws. */
function config({ getMeta = _getMeta, env = process.env } = {}) {
  const meta = (k) => { try { const v = getMeta(k); return v == null ? '' : String(v).trim(); } catch { return ''; } };
  const envKill = /^(0|false|off|no)$/i.test(String(env.ZOE_CORE || '').trim());
  const envOn = /^(1|true|on|yes)$/i.test(String(env.ZOE_CORE || '').trim());
  const on = !envKill && (envOn || /^(1|true|on|yes)$/i.test(meta('core.on')));
  const model = meta('core.model') || String(env.ZOE_CORE_MODEL || '').trim();
  const numCtx = Math.max(2048, parseInt(meta('core.num_ctx') || env.ZOE_CORE_NUM_CTX || '8192', 10) || 8192);
  const keepAliveRaw = meta('core.keep_alive') || String(env.ZOE_CORE_KEEP_ALIVE || '-1');
  const keepAlive = /^-?\d+$/.test(keepAliveRaw) ? parseInt(keepAliveRaw, 10) : keepAliveRaw;
  const firstLanes = new Set((meta('core.first_lanes') || String(env.ZOE_CORE_FIRST_LANES || '')).split(',').map((s) => s.trim()).filter(Boolean));
  const shadowRate = Math.min(1, Math.max(0, parseFloat(meta('core.shadow_rate') || env.ZOE_CORE_SHADOW_RATE || '0') || 0));
  const vramBarGb = parseFloat(meta('core.vram_bar_gb') || env.ZOE_CORE_VRAM_BAR_GB || '19') || 19;
  return { on, model, numCtx, keepAlive, firstLanes, shadowRate, vramBarGb, killed: envKill };
}

/**
 * Where an idle-cognition call goes. Pure.
 *   legacy          — the core is off, has no model, or is not ready: the path of record, untouched
 *   core            — a lane he moved to the core first (the cloud is the escalation), or no cloud source at all
 *   cloud_then_core — the cloud first; the core when the gate defers it, a blip, or an error
 */
function decide({ cfg, lane = 'idle', cloud = false, ready = false } = {}) {
  if (!cfg || !cfg.on) return { route: 'legacy', why: cfg && cfg.killed ? 'killed' : 'off' };
  if (!cfg.model) return { route: 'legacy', why: 'no_model' };
  if (!ready) return { route: 'legacy', why: 'not_ready' };
  if (cfg.firstLanes.has(String(lane))) return { route: 'core', why: 'first' };
  if (cloud) return { route: 'cloud_then_core', why: 'cloud_first' };
  return { route: 'core', why: 'no_cloud' };
}

/** GB the core needs on the card: weights + the cache for its window + headroom. */
function neededGb(sizeBytes, numCtx) { return (Number(sizeBytes) || 0) / 1e9 + (numCtx * KV_BYTES_PER_TOKEN) / 1e9 + LOAD_HEADROOM_GB; }

// ── the VRAM read (the tenancy law's bar) ────────────────────────────────────────────────────────

let _vramCache = { at: 0, gb: null };
/** Dedicated VRAM in use across the card, GB; null when the counter cannot be read (then the bar cannot bind). */
async function vramUsedGb({ execFile = require('child_process').execFile, now = Date.now() } = {}) {
  if (now - _vramCache.at < VRAM_TTL_MS) return _vramCache.gb;
  if (process.platform !== 'win32') { _vramCache = { at: now, gb: null }; return null; }
  const gb = await new Promise((resolve) => {
    try {
      const cmd = "(((Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | Measure-Object CookedValue -Sum).Sum)";
      const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const n = parseFloat(String(stdout || '').trim().replace(/,/g, ''));
        resolve(Number.isFinite(n) && n >= 0 ? n / 1e9 : null);
      });
      if (!child) resolve(null);
    } catch { resolve(null); }
  });
  _vramCache = { at: now, gb };
  return gb;
}

// ── readiness ───────────────────────────────────────────────────────────────────────────────────

let _readyCache = { key: '', at: 0, value: false, reason: '' };
let _lastRefusalLog = 0;

/**
 * Is the core ready to serve? The tag is present locally and the card can take it under the bar. Cached 60 s.
 * deps: fetchJson(url) → tags json · vram() → GB used or null · now.
 */
async function ready(cfg, { fetchJson = _fetchJson, vram = vramUsedGb, now = Date.now(), log = console.log } = {}) {
  const key = `${cfg.model}|${cfg.numCtx}|${cfg.vramBarGb}`;
  if (_readyCache.key === key && now - _readyCache.at < READY_TTL_MS) return _readyCache.value;
  let value = false, reason = '';
  try {
    const tags = await fetchJson(`${OLLAMA_BASE}/api/tags`);
    const list = (tags && Array.isArray(tags.models)) ? tags.models : [];
    const hit = list.find((m) => m && (m.name === cfg.model || m.model === cfg.model || String(m.name || '').replace(/:latest$/, '') === cfg.model.replace(/:latest$/, '')));
    if (!hit) reason = `model ${cfg.model} is not pulled`;
    else {
      const need = neededGb(hit.size, cfg.numCtx);
      const used = await vram();
      const loaded = await _isLoaded(cfg.model, fetchJson);
      if (used != null && !loaded && used + need > cfg.vramBarGb) reason = `VRAM ${used.toFixed(1)} GB used + ${need.toFixed(1)} GB needed > bar ${cfg.vramBarGb} GB`;
      else value = true;
    }
  } catch (e) { reason = `tags unreadable: ${String(e && e.message || e).slice(0, 80)}`; }
  _readyCache = { key, at: now, value, reason };
  if (!value && (!_lastRefusalLog || now - _lastRefusalLog > 5 * 60 * 1000)) { _lastRefusalLog = now; try { log(`[core] not ready — ${reason}`); } catch {} }
  return value;
}

async function _isLoaded(model, fetchJson) {
  try {
    const ps = await fetchJson(`${OLLAMA_BASE}/api/ps`);
    return !!((ps && Array.isArray(ps.models)) ? ps.models : []).find((m) => m && (m.name === model || m.model === model));
  } catch { return false; }
}

async function _fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); } finally { clearTimeout(t); }
}

function resetCaches() { _readyCache = { key: '', at: 0, value: false, reason: '' }; _vramCache = { at: 0, gb: null }; _lastRefusalLog = 0; }

// ── the record ──────────────────────────────────────────────────────────────────────────────────

function _appendLine(sub, obj, dir = CORE_DIR) {
  try {
    const d = path.join(dir, sub);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, `${new Date(obj.ts || Date.now()).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(obj) + '\n');
  } catch { /* the record never blocks the mind */ }
}

// ── serving ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Serve one idle-cognition call on the core. Refits the messages to the core's window (a heartbeat packed for the
 * cloud's 262k must not be sent to an 8k model: the daemon would drop the front silently), streams through the same
 * contract as the cloud path, records the call, and never throws: an empty answer or an error is '' — or, for a
 * core-first lane with a cloud behind it, the escalation's answer.
 */
async function serve({ cfg, lane = 'idle', why = '', messages, options = {}, onToken, onThinking, signal, inactivityMs, maxMs, think, escalate = null } = {},
  { streamChat = null, fitToWindow = null, appendLine = _appendLine, log = console.log, now = Date.now } = {}) {
  const t0 = now();
  let fitted = messages, refit = null;
  try {
    const fit = (fitToWindow || require('./context').fitToWindow)(messages, { numCtx: cfg.numCtx, numPredict: Math.max(64, Number(options.num_predict) || 400) });
    fitted = fit.messages; refit = fit.report || null;
  } catch { /* send as given */ }
  let text = '', error = null;
  try {
    const sc = streamChat || require('./ollama').streamChat;
    text = String(await sc({ model: cfg.model, messages: fitted, options: { ...options, num_ctx: cfg.numCtx }, onToken, onThinking, signal, inactivityMs, maxMs, think, base: OLLAMA_BASE, keepAlive: cfg.keepAlive, lane }) || '');
  } catch (e) { error = String(e && e.message || e).slice(0, 160); }
  const ms = now() - t0;
  appendLine('served', { ts: t0, lane, why, model: cfg.model, ms, chars: text.length, refit: refit ? { dropped: refit.droppedTurns, before: refit.before, after: refit.after } : null, error });
  try { log(`[core] ${error ? 'FAILED' : text ? 'served' : 'empty'} ${lane} (${why}) on ${cfg.model} in ${ms} ms${refit ? ` · refit ${refit.before}→${refit.after}ch` : ''}${error ? ` · ${error}` : ''}`); } catch {}
  if (!text && escalate) { try { return await escalate(); } catch { return ''; } }
  return text;
}

let _shadowBusy = false;
/**
 * The shadow: the core answers the same messages the cloud just answered, off the hot path, sampled. Both texts to
 * data/core/shadow/<day>.jsonl. One at a time; never awaited by the caller; never delivered anywhere.
 */
function shadow({ cfg, lane = 'idle', messages, options = {}, think, cloudText = '' } = {},
  { streamChat = null, fitToWindow = null, appendLine = _appendLine, rng = Math.random, schedule = setImmediate, now = Date.now, log = console.log } = {}) {
  if (!cfg || !cfg.on || !cfg.model || cfg.shadowRate <= 0) return false;
  if (rng() >= cfg.shadowRate) return false;
  if (_shadowBusy) return false;
  _shadowBusy = true;
  schedule(async () => {
    const t0 = now();
    let text = '', error = null;
    try {
      let fitted = messages;
      try { fitted = (fitToWindow || require('./context').fitToWindow)(messages, { numCtx: cfg.numCtx, numPredict: Math.max(64, Number(options.num_predict) || 400) }).messages; } catch {}
      const sc = streamChat || require('./ollama').streamChat;
      text = String(await sc({ model: cfg.model, messages: fitted, options: { ...options, num_ctx: cfg.numCtx }, maxMs: SHADOW_BUDGET_MS, inactivityMs: 30000, think, base: OLLAMA_BASE, keepAlive: cfg.keepAlive, lane: `${lane}_shadow` }) || '');
    } catch (e) { error = String(e && e.message || e).slice(0, 160); }
    finally { _shadowBusy = false; }
    const ms = now() - t0;
    appendLine('shadow', { ts: t0, lane, model: cfg.model, ms, cloud_chars: String(cloudText || '').length, core_chars: text.length, cloud_head: String(cloudText || '').slice(0, 400), core_head: text.slice(0, 400), error });
    try { log(`[core] shadow ${lane}: cloud ${String(cloudText || '').length}ch · core ${text.length}ch in ${ms} ms${error ? ` · ${error}` : ''}`); } catch {}
  });
  return true;
}

/** Load the core at boot so the first beat does not pay the load. Fire-and-forget; never throws. */
async function warm(cfg, { streamChat = null, readyFn = ready, log = console.log } = {}) {
  try {
    if (!cfg || !cfg.on || !cfg.model) return false;
    if (!(await readyFn(cfg))) return false;
    const sc = streamChat || require('./ollama').streamChat;
    const t0 = Date.now();
    await sc({ model: cfg.model, messages: [{ role: 'user', content: 'Say ok.' }], options: { num_ctx: cfg.numCtx, num_predict: 2, temperature: 0 }, base: OLLAMA_BASE, keepAlive: cfg.keepAlive, lane: 'core_warm', inactivityMs: 120000 });
    try { log(`[core] warm: ${cfg.model} resident (num_ctx ${cfg.numCtx}, keep_alive ${cfg.keepAlive}) in ${Date.now() - t0} ms`); } catch {}
    return true;
  } catch (e) { try { log(`[core] warm failed — ${String(e && e.message || e).slice(0, 120)}`); } catch {} return false; }
}

module.exports = { config, decide, neededGb, ready, serve, shadow, warm, vramUsedGb, resetCaches, KV_BYTES_PER_TOKEN, OLLAMA_BASE, CORE_DIR, _appendLine };
