'use strict';
/**
 * lib/stall_profile.js — WHO held the main thread, when no lane marked itself and no statement was slow.
 *
 * THE TAIL (freeze cut 8, 2026-09-03): after cuts 1–7 every block ≥3s is gone and what remains is a
 * 1.5–2s tail under `active: "idle"` with no [slow-sync] line — unmarked JavaScript or many small
 * statements. The attributor names lanes that MARK themselves; the slow-sync probe names STATEMENTS ≥1s;
 * neither names a 1.7s stretch of ordinary code. Guessing at it from the tee's line order is what hid
 * the rehearsal diff for three generations.
 *
 * V8's sampling profiler runs on ITS OWN THREAD: it keeps taking stack samples while the main thread is
 * wedged in synchronous work, and a native call (a better-sqlite3 step, a sync fs read) shows as the JS
 * frame that made it. So: an in-process inspector session profiles the main isolate in rolling windows;
 * when the stall probe reports a block it asks for the frames whose self-time fell INSIDE the blocked
 * window — and the block names its own function, file and line. Fail-soft: no inspector → not armed,
 * said once. Kill switch: ZOE_STALL_PROFILE=0 (read by the caller).
 *
 * Reading the line: a hot callee TurboFan has INLINED shows up under its caller's frame (still a repo
 * file:line — where the time went, not which inlined body); a native leaf (a sqlite step, a sync fs
 * read) is named with `via` = the nearest repo frame that paid for it.
 */
const path = require('path');

const WINDOW_MS = 60000;      // rolling profile windows
const SAMPLE_US = 2000;       // 2ms samples — ~1% overhead, 500 samples per blocked second
const KEEP = 2;               // windows retained (a block that straddles a rotation is still covered)
const TOP = 5;

let _session = null, _armed = false, _timer = null;
let _profiles = [];           // [{ profile, wall0 }] newest last; wall0 = Date.now() at Profiler.start
let _cur = null;              // { wall0 } for the running window

function _post(method, params) {
  return new Promise((resolve, reject) => {
    try { _session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))); }
    catch (e) { reject(e); }
  });
}
async function _startWindow() {
  _cur = { wall0: Date.now() };
  await _post('Profiler.start');
}
async function _rotate() {
  if (!_session || !_cur) return null;
  const wall0 = _cur.wall0;
  let res = null;
  try { res = await _post('Profiler.stop'); } catch { res = null; }
  try { await _startWindow(); } catch { /* the next rotate retries */ }
  if (res && res.profile) {
    _profiles.push({ profile: res.profile, wall0 });
    while (_profiles.length > KEEP) _profiles.shift();
  }
  return res && res.profile;
}

/** Arm the profiler. Returns { armed, why? }. Idempotent. */
async function arm({ windowMs = WINDOW_MS, sampleUs = SAMPLE_US } = {}) {
  if (_armed) return { armed: true };
  try {
    const inspector = require('inspector');
    _session = new inspector.Session();
    _session.connect();
    await _post('Profiler.enable');
    await _post('Profiler.setSamplingInterval', { interval: sampleUs });
    await _startWindow();
    _timer = setInterval(() => { _rotate().catch(() => {}); }, windowMs);
    if (_timer.unref) _timer.unref();
    _armed = true;
    return { armed: true };
  } catch (e) {
    try { if (_session) _session.disconnect(); } catch {}
    _session = null; _cur = null;
    return { armed: false, why: (e && e.message) || String(e) };
  }
}
async function disarm() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_session) { try { await _post('Profiler.stop'); } catch {} try { _session.disconnect(); } catch {} }
  _session = null; _cur = null; _profiles = []; _armed = false;
}
function armed() { return _armed; }

// The repo root, to print frames as repo-relative paths.
const ROOT = path.resolve(__dirname, '..');
function _frameLabel(cf) {
  if (!cf) return '(unknown)';
  const fn = cf.functionName || '(anonymous)';
  let file = String(cf.url || '');
  if (!file) return fn;                                   // native / (program) / (garbage collector)
  file = file.replace(/^file:\/\/\/?/, '');
  try { const rel = path.relative(ROOT, file); if (rel && !rel.startsWith('..')) file = rel.replace(/\\/g, '/'); else file = path.basename(file); } catch { file = path.basename(file); }
  return `${fn} (${file}:${(cf.lineNumber | 0) + 1})`;
}
function _isRepoFrame(cf) {
  const u = String((cf && cf.url) || '');
  if (!u) return false;
  // only a real file path can be a repo frame — `node:internal/…` relative-looking URLs resolved
  // against the cwd and passed as "repo" on p262 (the first live `via` named a Node internal)
  if (!/^(file:|[a-zA-Z]:[\\/]|\/)/.test(u)) return false;
  const f = u.replace(/^file:\/\/\/?/, '');
  try { const rel = path.relative(ROOT, f); return !!rel && !rel.startsWith('..') && !/node_modules/.test(rel); } catch { return false; }
}

/**
 * Attribute the blocked window [endMs - driftMs - slackMs, endMs] to the frames that held the thread.
 * Returns { totalMs, sampledMs, top: [{ label, ms, pct, via }], line } or null when nothing was sampled.
 * `via` = the nearest REPO frame up the stack when the leaf is native/library code (the caller that paid).
 */
async function attribute({ endMs, driftMs, slackMs = 1000, top = TOP } = {}) {
  if (!_armed) return null;
  await _rotate();                                        // close the running window so its samples are readable
  const from = endMs - driftMs - slackMs, to = endMs;
  const self = new Map();                                 // label → { ms, via: Map<label, ms> }
  let sampledMs = 0;
  for (const { profile, wall0 } of _profiles) {
    if (!profile || !Array.isArray(profile.samples)) continue;
    const byId = new Map(); const parent = new Map();
    for (const n of profile.nodes) { byId.set(n.id, n); for (const c of (n.children || [])) parent.set(c, n.id); }
    let t = profile.startTime;                            // µs on V8's clock; wall = wall0 + (t - startTime)/1000
    for (let i = 0; i < profile.samples.length; i++) {
      t += profile.timeDeltas[i] || 0;
      const wall = wall0 + (t - profile.startTime) / 1000;
      if (wall < from || wall > to) continue;
      const ms = (profile.timeDeltas[i] || 0) / 1000;
      const node = byId.get(profile.samples[i]);
      if (!node) continue;
      const cf = node.callFrame;
      if (cf && (cf.functionName === '(idle)' || cf.functionName === '(root)')) continue;   // the loop was free
      sampledMs += ms;
      const label = _frameLabel(cf);
      let via = null;
      if (!_isRepoFrame(cf)) {                            // native/library leaf → the repo frame that called it
        let p = parent.get(node.id);
        while (p != null) { const pn = byId.get(p); if (pn && _isRepoFrame(pn.callFrame)) { via = _frameLabel(pn.callFrame); break; } p = parent.get(p); }
      }
      const e = self.get(label) || { ms: 0, via: new Map() };
      e.ms += ms;
      if (via) e.via.set(via, (e.via.get(via) || 0) + ms);
      self.set(label, e);
    }
  }
  if (!sampledMs) return null;
  const rows = [...self.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([label, e]) => {
    const via = [...e.via.entries()].sort((a, b) => b[1] - a[1])[0];
    return { label, ms: Math.round(e.ms), pct: Math.round((e.ms / sampledMs) * 100), via: via ? via[0] : null };
  });
  const line = `${Math.round(sampledMs)}ms sampled in the ${Math.round(driftMs)}ms block: ` + rows.map((r) => `${r.pct}% ${r.label}${r.via ? ` via ${r.via}` : ''}`).join(' · ');
  return { totalMs: driftMs, sampledMs: Math.round(sampledMs), top: rows, line };
}

module.exports = { arm, disarm, armed, attribute, _rotate, WINDOW_MS, SAMPLE_US, KEEP };
