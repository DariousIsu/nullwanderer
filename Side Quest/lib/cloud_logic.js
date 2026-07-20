/**
 * lib/cloud_logic.js — the ONE DOOR for cloud-assisted reasoning.
 *
 * Strategy (Lucas): a stock 24B can't reach the full vision; the cloud fills the gap NOW, as a
 * TUTOR that ranks / verifies / synthesizes — and every call is recorded as TRAINING DATA for a
 * future custom model. So the cost-control + the data-capture both live here, in the packaging.
 *
 * The contract every cloud task obeys:
 *   1. MINIMAL, ID-referenced request — the caller packs the smallest sufficient input; we hard-cap
 *      its size. Small payloads = cheap calls. (cost lever)
 *   2. STRICT response + deterministic validation — parse/validate; ONE repair retry on malformed;
 *      then FAIL-SAFE (return null → caller falls back to local or skips). Cloud PROPOSES, the
 *      validator DISPOSES — a bad generation can never corrupt state. (quality/safety lever)
 *   3. CACHE — identical (task,v,input,want) returns the prior accepted result, no call. (cost lever)
 *   4. BUDGET — a daily call cap; over budget → skip → local. It cannot run away. (cost lever)
 *   5. TRACE — every call (input/raw/parsed/accepted) is logged to cloud_traces: the cache, the
 *      audit, and THE TRAINING CORPUS. (data lever)
 *
 * Built on the existing cloud creds path (models.sources cloud tier + the curator model, key
 * hydrated from the OS keychain at app boot). Cloud absent → ask() returns null, never throws.
 * deps.* are injectable so the whole broker is offline-testable with no network.
 */
'use strict';
const crypto = require('crypto');
const db = require('./db');

// Internal per-day call cap. This is a RUNAWAY-LOOP BACKSTOP, not a cost throttle — the cloud
// PROVIDER enforces the real session/weekly limits (observed: ~0.3% weekly used), so a low daily
// number here just needlessly starved distill/tool-route/curator/drafts late in the day. Keep it
// high; override via env ZOE_CLOUD_DAILY_CAP or db meta `cloud.dailyCap` if ever needed.
const DEFAULT_DAILY_CAP = 5000;
const DEFAULT_MAX_INPUT_CHARS = 6000 * 4;   // ~6k tokens of packaged input (cloud headroom is large)

function dailyCap() {
  try {
    const env = parseInt((process.env.ZOE_CLOUD_DAILY_CAP || '').trim(), 10);
    if (Number.isFinite(env) && env > 0) return env;
    const meta = parseInt(db.getMeta('cloud.dailyCap') || '', 10);
    if (Number.isFinite(meta) && meta > 0) return meta;
  } catch {}
  return DEFAULT_DAILY_CAP;
}

// ---- the cloud primitive (resolve cloud tier + curator model → ollama.complete) ----
// Returns { text, model } or null when no cloud tier/model is configured (fail-safe).
let _modelCache = null;
async function _resolveModel(models, cloud) {
  if (_modelCache) return _modelCache;
  let m = models.getModelFor('curator', null) || models.getModelFor('editor', null)
    || (process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || '').trim() || null;
  if (!m && cloud) { try { const list = await models.listFromSource(cloud); if (list && list.length) m = list[0].name; } catch {} }
  if (m) _modelCache = m;
  return m;
}
async function _complete(messages, { temperature = 0.2, num_predict = 400, model: modelOverride = null } = {}) {
  let models, ollama;
  try { models = require('./models'); ollama = require('./ollama'); } catch { return null; }
  const cloud = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!cloud) return null;
  const model = modelOverride || await _resolveModel(models, cloud);
  if (!model) return null;
  try {
    const text = await ollama.complete({
      model, messages, base: cloud.base,
      headers: cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {},
      options: { temperature, top_p: 0.9, num_ctx: 8192, num_predict }
    });
    return { text: text || '', model };
  } catch (e) { console.error('[cloud_logic] cloud call failed:', e.message); return null; }
}

// STREAMING counterpart to _complete — same endpoint/token resolution, tokens delivered as they
// arrive instead of one blocking block.
//
// Why this exists: once the cloud writes the user-facing reply rather than handing content to the
// local model to re-voice, a long generation with NO token flow is indistinguishable from a hang.
// `onToken` also makes progress measurable (elapsed + token count), and it is what resets
// streamChat's stall watchdog — a blocking call can only time out, it cannot tell "slow" from "dead".
//
// Deliberately NOT routed through ask(): that path is cache + budget + validate + repair, which is
// right for structured classification and wrong for a user-facing answer (a cached reply would
// re-serve stale words, and there is no JSON to validate). Returns { text, model } or null so callers
// keep the same fail-safe shape as _complete — cloud down → null → caller's local path.
async function streamCloud(messages, { temperature = 0.6, num_predict = 900, model: modelOverride = null,
  onToken = null, signal = null, inactivityMs = 90000, deps = {} } = {}) {
  let models, ollama;
  try { models = require('./models'); ollama = require('./ollama'); } catch { return null; }
  const stream = deps.streamChat || ollama.streamChat;
  // deps.cloudSource lets the smoke run with no keychain/token — the module contract is that every
  // external edge is injectable, and resolving the live cloud tier is one of them.
  const cloud = deps.cloudSource || (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!cloud) return null;
  const model = modelOverride || await _resolveModel(models, cloud);
  if (!model) return null;
  let text = '';
  let tokens = 0;
  const startedAt = Date.now();
  try {
    await stream({
      model, messages, base: cloud.base,
      headers: cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {},
      options: { temperature, top_p: 0.9, num_ctx: 8192, num_predict },
      signal, inactivityMs,
      onToken: (t) => {
        text += t; tokens += 1;
        if (onToken) { try { onToken(t, { tokens, elapsedMs: Date.now() - startedAt }); } catch { /* a UI hiccup must not kill the stream */ } }
      },
    });
    return { text, model, tokens, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    console.error('[cloud_logic] cloud stream failed:', e.message);
    // Partial text is still worth returning — an answer cut off at 400 tokens beats discarding it
    // and falling back to nothing. The caller decides whether a partial is usable.
    return text ? { text, model, tokens, elapsedMs: Date.now() - startedAt, partial: true } : null;
  }
}

// ---- packaging helpers ----
function _hash(obj) { return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex'); }

function _packInput(input, maxChars) {
  let s = JSON.stringify(input);
  if (s.length > maxChars) s = s.slice(0, maxChars);   // deterministic truncation (cost guard)
  return s;
}

function _buildMessages({ task, v, want, inputStr }) {
  return [{
    role: 'user',
    content: `TASK: ${task} (v${v})

${want}

Respond with ONLY the specified output — no preamble, no commentary, nothing outside the format.

INPUT (JSON):
${inputStr}`
  }];
}

// Run the caller's validator (raw → {valid, value, error}); default = first JSON value in the text.
function _runValidate(validate, raw) {
  try {
    if (typeof validate === 'function') {
      const r = validate(raw);
      return (r && typeof r.valid === 'boolean') ? r : { valid: false, error: 'validator returned malformed result' };
    }
    const m = String(raw || '').match(/[[{][\s\S]*[\]}]/);
    if (!m) return { valid: false, error: 'no JSON found in response' };
    return { valid: true, value: JSON.parse(m[0]) };
  } catch (e) { return { valid: false, error: e.message }; }
}

// ---- budget (daily call cap, resets on date change) ----
function _todayKey(now) { return new Date(now).toISOString().slice(0, 10); }
function _budgetState(now) {
  const day = _todayKey(now);
  const storedDay = db.getMeta('cloud_logic_day');
  let calls = parseInt(db.getMeta('cloud_logic_calls') || '0', 10);
  if (storedDay !== day) { calls = 0; db.setMeta('cloud_logic_day', day); db.setMeta('cloud_logic_calls', '0'); }
  return { day, calls };
}
function _budgetInc() {
  const c = parseInt(db.getMeta('cloud_logic_calls') || '0', 10) + 1;
  db.setMeta('cloud_logic_calls', String(c));
}

/**
 * ask — run ONE cloud-assisted task through the full contract. Returns the validated result, or
 * null (fail-safe) when: no cloud configured, over budget, or the response failed validation even
 * after one repair. NEVER throws into the caller.
 *
 *   task     short id (e.g. 'rank_interests') — also the trace tag / training label
 *   v        schema version (bump when you change input/output shape)
 *   input    compact, ID-referenced object — keep it SMALL
 *   want     the format spec the model must obey (the response contract, in words)
 *   validate (raw)=>{valid,value,error}; omit for default-JSON parsing
 *   deps     { complete, now, dailyCap, maxInputChars, noCache, skipBudget } — test seams
 */
async function ask({ task, v = 1, input = {}, want = '', validate = null, model = null, numPredict = null, deps = {} } = {}) {
  if (!task) return null;
  const now = deps.now || Date.now();
  const complete = deps.complete || _complete;
  // Per-task model / token overrides (e.g. intake → the fast non-reasoning model + more headroom, so a
  // reasoning model can't burn the budget on hidden "thinking" and return empty). Default = curator/400.
  const cOpts = {};
  if (model) cOpts.model = model;
  if (numPredict) cOpts.num_predict = numPredict;
  const cap = deps.dailyCap || dailyCap();
  const maxChars = deps.maxInputChars || DEFAULT_MAX_INPUT_CHARS;
  const inputStr = _packInput(input, maxChars);
  const inputHash = _hash({ task, v, inputStr, want });

  // 1. CACHE — an identical accepted call returns its parsed result, no cloud hit.
  if (!deps.noCache) {
    try {
      const cached = db.getCachedCloudTrace(inputHash);
      if (cached && cached.parsed_json) {
        try { return JSON.parse(cached.parsed_json); } catch {}
      }
    } catch {}
  }

  // 2. BUDGET — over the daily cap → skip (fail-safe to caller's local path).
  if (!deps.skipBudget) {
    const b = _budgetState(now);
    if (b.calls >= cap) { console.warn(`[cloud_logic] budget exhausted (${b.calls}/${cap}) — skipping ${task}`); return null; }
  }

  const messages = _buildMessages({ task, v, want, inputStr });
  let res = await complete(messages, cOpts);
  if (!deps.skipBudget) _budgetInc();
  let raw = (res && res.text) || '';
  const usedModel = (res && res.model) || model || 'cloud';

  let parsed = null, valid = false, repaired = 0;
  const v1 = _runValidate(validate, raw);
  if (v1.valid) { parsed = v1.value; valid = true; }
  else if (res) {
    // 2b. ONE repair retry — show the model its own bad output + the error, demand the format.
    const repairMsgs = messages.concat([
      { role: 'assistant', content: raw },
      { role: 'user', content: `That response was INVALID: ${v1.error}. Re-emit ONLY the correct format — nothing else.` }
    ]);
    const res2 = await complete(repairMsgs, cOpts);
    if (!deps.skipBudget) _budgetInc();
    repaired = 1;
    const raw2 = (res2 && res2.text) || '';
    const v2 = _runValidate(validate, raw2);
    if (v2.valid) { parsed = v2.value; valid = true; raw = raw2; }
    else if (raw2) { raw = raw2; }
  }

  // 5. TRACE — always log (cache + audit + training corpus). Best-effort; never blocks the result.
  try {
    db.insertCloudTrace({
      ts: now, task, v, model: usedModel, inputHash, inputJson: inputStr,
      raw, parsedJson: valid ? JSON.stringify(parsed) : null,
      valid, accepted: valid, repaired, cached: 0
    });
  } catch (e) { console.error('[cloud_logic] trace insert failed:', e.message); }

  return valid ? parsed : null;   // FAIL-SAFE: null on invalid → caller uses local / skips
}

// Daily budget snapshot (for status surfaces).
function budgetStatus(now = Date.now(), cap = dailyCap()) {
  const b = _budgetState(now);
  return { day: b.day, calls: b.calls, cap, remaining: Math.max(0, cap - b.calls) };
}

module.exports = {
  ask, budgetStatus, _complete, streamCloud,
  // exported for the offline smoke
  _hash, _packInput, _buildMessages, _runValidate, _budgetState,
  DEFAULT_DAILY_CAP, DEFAULT_MAX_INPUT_CHARS
};
