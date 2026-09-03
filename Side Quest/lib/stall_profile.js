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
// A script URL as V8 reports it → a filesystem path. The main process reports `file:///C:/Users/…/
// Side%20Quest/lib/x.js` — PERCENT-ENCODED. Cut 16 found that every repo frame had failed the repo-root
// test since cut 10 tightened it (the `%20` never matched the real directory), so `via` silently
// vanished and labels fell back to bare basenames. Decode first; a bad escape keeps the raw string.
function _filePath(u) {
  let f = String(u || '').replace(/^file:\/\/\/?/, '');
  try { f = decodeURIComponent(f); } catch {}
  return f;
}
function _frameLabel(cf) {
  if (!cf) return '(unknown)';
  const fn = cf.functionName || '(anonymous)';
  let file = String(cf.url || '');
  if (!file) return fn;                                   // native / (program) / (garbage collector)
  file = _filePath(file);
  try { const rel = path.relative(ROOT, file); if (rel && !rel.startsWith('..')) file = rel.replace(/\\/g, '/'); else file = path.basename(file); } catch { file = path.basename(file); }
  return `${fn} (${file}:${(cf.lineNumber | 0) + 1})`;
}
function _isRepoFrame(cf) {
  const u = String((cf && cf.url) || '');
  if (!u) return false;
  // only a real file path can be a repo frame — `node:internal/…` relative-looking URLs resolved
  // against the cwd and passed as "repo" on p262 (the first live `via` named a Node internal)
  if (!/^(file:|[a-zA-Z]:[\\/]|\/)/.test(u)) return false;
  const f = _filePath(u);
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
  // WHO PAID (freeze cut 16): self-time names the LEAF; three of a day's blocks read `30% get · 24%
  // Statement · 11% all` with no repo frame anywhere in the top five — a storm of small calls whose
  // caller never held the thread long enough to be sampled as a leaf. Two inclusive views name it:
  // `paid by` = the NEAREST repo frame above each sample (the function whose body made the calls),
  // `under` = the OUTERMOST repo frame on the stack (the lane that ran it — a tick, a tool, a pass).
  const paidNear = new Map();                             // nearest repo frame label → ms
  const paidRoot = new Map();                             // outermost repo frame label → ms
  let sampledMs = 0;
  for (const { profile, wall0 } of _profiles) {
    if (!profile || !Array.isArray(profile.samples)) continue;
    const byId = new Map(); const parent = new Map();
    for (const n of profile.nodes) {
      byId.set(n.id, n);
      for (const c of (n.children || [])) parent.set(c, n.id);
      if (n.parent != null && !parent.has(n.id)) parent.set(n.id, n.parent);   // a profile that carries parent ids instead of children
    }
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
      const leafIsRepo = _isRepoFrame(cf);
      // the ancestry: `via` = the nearest repo frame above a native/library leaf (failing that, the nearest
      // frame with ANY location, marked *); nearest/outermost repo frames feed `paid by` / `under`
      let via = null, viaAny = null, nearest = leafIsRepo ? label : null, outermost = leafIsRepo ? label : null;
      let p = parent.get(node.id), hops = 0;
      while (p != null && hops++ < 512) {
        const pn = byId.get(p); const pcf = pn && pn.callFrame;
        if (pcf) {
          if (_isRepoFrame(pcf)) { const l = _frameLabel(pcf); if (!nearest) nearest = l; outermost = l; if (!via && !leafIsRepo) via = l; }
          else if (!viaAny && !leafIsRepo && pcf.url) viaAny = _frameLabel(pcf) + '*';
        }
        p = parent.get(p);
      }
      const e = self.get(label) || { ms: 0, via: new Map() };
      e.ms += ms;
      const v = via || viaAny;
      if (v) e.via.set(v, (e.via.get(v) || 0) + ms);
      self.set(label, e);
      if (nearest) paidNear.set(nearest, (paidNear.get(nearest) || 0) + ms);
      if (outermost) paidRoot.set(outermost, (paidRoot.get(outermost) || 0) + ms);
    }
  }
  if (!sampledMs) return null;
  const rows = [...self.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([label, e]) => {
    const via = [...e.via.entries()].sort((a, b) => b[1] - a[1])[0];
    return { label, ms: Math.round(e.ms), pct: Math.round((e.ms / sampledMs) * 100), via: via ? via[0] : null };
  });
  const rank = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, ms]) => ({ label, ms: Math.round(ms), pct: Math.round((ms / sampledMs) * 100) }));
  const paidBy = rank(paidNear, 3), under = rank(paidRoot, 2);
  const fmt = (list) => list.map((r) => `${r.pct}% ${r.label}`).join(' · ');
  const line = `${Math.round(sampledMs)}ms sampled in the ${Math.round(driftMs)}ms block: ` + rows.map((r) => `${r.pct}% ${r.label}${r.via ? ` via ${r.via}` : ''}`).join(' · ')
    + (paidBy.length ? ` — paid by: ${fmt(paidBy)} — under: ${fmt(under)}` : ' — paid by: no repo frame on any sampled stack');
  return { totalMs: driftMs, sampledMs: Math.round(sampledMs), top: rows, paidBy, under, line };
}

module.exports = { arm, disarm, armed, attribute, _rotate, _windows: () => _profiles, WINDOW_MS, SAMPLE_US, KEEP };
