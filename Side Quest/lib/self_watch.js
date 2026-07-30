/**
 * lib/self_watch.js — HER OWN EYE ON HER OWN LOG STREAM (Lucas 2026-07-30: "can she have all
 * these watchdogs running all the time? and read them and suggest repairs like you're doing?").
 *
 * The organs already SAY what they're doing — [subc], [directed], [fit], [cite], failures — but
 * nothing in the program read those lines back; the only eye on them was an external session.
 * This organ hooks console AT THE SOURCE (no file tail — the app never knows where its stdout
 * was redirected) and classifies every line deterministically:
 *
 *   • SIGNAL prefixes (the autonomy lanes) → structured events on the obs bus (lib/obs_bus) —
 *     the stream the visual-log interface renders;
 *   • ANOMALIES (error-level lines, Traceback/Uncaught/FAILED shapes, [window] overruns) →
 *     stored with a per-signature cap (first occurrence lands, repeats are counted, at most one
 *     re-store per signature per hour) so a crashloop cannot flood the bus;
 *   • everything else → COUNTED, flushed as one status event per interval — new/noisy lanes
 *     stay visible at counter level without a row per line.
 *
 * THE DRIVE (the self-improvement wire): an anomaly signature that RECURS (≥ MINT_THRESHOLD in
 * its window) becomes a named capability need (lib/capability_need.record — dedup + the decider
 * manifest + the rehearse door all already exist downstream). Bounded: at most
 * MAX_OPEN_WATCH_NEEDS watch-born needs open at once — the same throttle-to-completion shape as
 * the subc spawn guard. Detection is DETERMINISTIC (regex only, no model calls); diagnosis
 * happens downstream in the sandbox where it's grounded and gated, and nothing self-adopts.
 *
 * Re-entrancy: the hook never observes its own '[watch]'/'[obs]' lines, and a throwing observer
 * can never break console for the caller.
 */
'use strict';

const obs = require('./obs_bus');

const STATUS_FLUSH_MS = 5 * 60e3;
const SIG_WINDOW_MS = 24 * 3600e3;
const SIG_RESTORE_MS = 3600e3;      // a recurring signature re-lands on the bus at most 1/hr
const MINT_THRESHOLD = 3;
const MAX_OPEN_WATCH_NEEDS = 2;
const AUDIT_EVERY_MS = 12 * 3600e3; // the DB-exhaust audit cadence (build plan 1.5)
const AUDIT_TS_KEY = 'watch.last_audit_ts';

function _dbm(deps) { return (deps && deps.db) || require('./db'); }

// The autonomy lanes whose lines are stored as first-class events (everything else is counted).
const SIGNAL_LANES = {
  'subc': 'subc',
  'directed': 'directed',
  'user-work': 'directed',
  'cite': 'research',
  'closure': 'research',
  'fit': 'window',
  'window': 'window',
  'doc-set': 'doc-set',
  'rehearse': 'rehearsal',
  'rehearsal': 'rehearsal',
  'analysis': 'analysis',
  'harvest': 'harvest',
};
const ANOMALY_RES = [/Traceback \(most recent/i, /\bUncaught\b/, /\bFAILED\b/, /\bUnhandled(?:PromiseRejection)?\b/i];
const SELF_PREFIXES = ['[watch]', '[obs]'];

// ── pure classification (offline-smokeable) ───────────────────────────────────────────────────
function classify(line, level = 'info') {
  const s = String(line || '');
  if (!s.trim()) return { action: 'ignore' };
  for (const p of SELF_PREFIXES) if (s.startsWith(p)) return { action: 'ignore' };
  const m = /^\[([a-z0-9-]+)\]/i.exec(s.trim());
  const prefix = m ? m[1].toLowerCase() : null;
  const anomalous = level === 'error' || ANOMALY_RES.some((re) => re.test(s)) || (prefix === 'window');
  if (anomalous) return { action: 'anomaly', prefix: prefix || '(raw)', lane: prefix && SIGNAL_LANES[prefix] ? SIGNAL_LANES[prefix] : 'anomaly', ref: _ref(s, prefix) };
  if (prefix && SIGNAL_LANES[prefix]) return { action: 'store', prefix, lane: SIGNAL_LANES[prefix], ref: _ref(s, prefix) };
  return { action: 'count', prefix: prefix || '(raw)' };
}
function _ref(s, prefix) {
  const t = /#(\d{2,})/.exec(s);
  if (t && (prefix === 'subc' || prefix === 'directed' || prefix === 'user-work')) return `thread:${t[1]}`;
  const n = /need #(\d+)/.exec(s);
  if (n) return `need:${n[1]}`;
  return null;
}

// A stable identity for "the same problem again" — prefix + shape with numbers blanked.
function signatureOf(line) {
  return String(line || '').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// ── state (module-level; _reset for smokes) ───────────────────────────────────────────────────
let _counts = new Map();          // prefix → count since last status flush
let _observed = 0;
let _sigs = new Map();            // signature → { firstTs, lastStoredTs, hits: [ts...] }
let _lastStatusTs = 0;
let _installed = false;
let _inObserve = false;

function _reset() { _counts = new Map(); _observed = 0; _sigs = new Map(); _lastStatusTs = 0; _inObserve = false; }

// ── the observer ──────────────────────────────────────────────────────────────────────────────
function observe(line, level = 'info', { deps = {}, nowMs = Date.now() } = {}) {
  if (_inObserve) return null;
  _inObserve = true;
  try {
    const c = classify(line, level);
    if (c.action === 'ignore') return c;
    if (!_lastStatusTs) _lastStatusTs = nowMs;   // baseline on first line — no boot-time ghost status
    _observed++;
    if (c.action === 'count') {
      _counts.set(c.prefix, (_counts.get(c.prefix) || 0) + 1);
    } else if (c.action === 'store') {
      obs.emit({ lane: c.lane, kind: 'line', level, text: line, ref: c.ref }, { deps, nowMs });
    } else if (c.action === 'anomaly') {
      const sig = signatureOf(line);
      let st = _sigs.get(sig);
      if (!st) { st = { firstTs: nowMs, lastStoredTs: 0, hits: [] }; _sigs.set(sig, st); }
      st.hits = st.hits.filter((t) => t >= nowMs - SIG_WINDOW_MS);
      st.hits.push(nowMs);
      if (!st.lastStoredTs || nowMs - st.lastStoredTs >= SIG_RESTORE_MS) {
        st.lastStoredTs = nowMs;
        obs.emit({ lane: c.lane, kind: 'anomaly', level: level === 'error' ? 'error' : 'warn', text: line, ref: c.ref, data: { sig, hits24h: st.hits.length } }, { deps, nowMs });
      } else {
        _counts.set(`${c.prefix}!`, (_counts.get(`${c.prefix}!`) || 0) + 1);
      }
      if (st.hits.length >= MINT_THRESHOLD && !st.minted) _maybeMintNeed(sig, line, st, { deps, nowMs });
    }
    if (nowMs - _lastStatusTs >= STATUS_FLUSH_MS) {
      _flushStatus({ deps, nowMs });
      // The exhaust audit rides the status clock (never per-line — the console hook stays cheap),
      // every AUDIT_EVERY_MS, persisted across reboots.
      try {
        const last = parseInt(_dbm(deps).getMeta(AUDIT_TS_KEY) || '0', 10) || 0;
        if (nowMs - last >= AUDIT_EVERY_MS) {
          _dbm(deps).setMeta(AUDIT_TS_KEY, String(nowMs));
          runExhaustAudit({ deps, nowMs });
        }
      } catch {}
    }
    return c;
  } catch { return null; } finally { _inObserve = false; }
}

// The one minting door (shared by the log watcher and the exhaust audit): a finding becomes WORK
// through the existing path — a named capability need → the decider manifest → the rehearse
// sandbox → a proposal card. Bounded (≤ MAX_OPEN_WATCH_NEEDS) and deduped downstream.
// Returns {id, deduped} or null (cap reached / failed).
function _mintNeed(findingText, bornFrom, { deps = {}, nowMs = Date.now() } = {}) {
  try {
    const cn = (deps && deps.capabilityNeed) || require('./capability_need');
    const open = cn.listOpen({ deps }).filter((r) => String(r.born_from || '').startsWith('self-watch'));
    if (open.length >= MAX_OPEN_WATCH_NEEDS) return null;
    return cn.record(`I need a fix for a recurring failure in my own program: ${findingText}`, { bornFrom, deps, nowMs, similarFloor: 0.75 });
  } catch { return null; }
}

function _maybeMintNeed(sig, line, st, { deps = {}, nowMs = Date.now() } = {}) {
  const r = _mintNeed(sig, `self-watch: recurred ${st.hits.length}x/24h`, { deps, nowMs });
  if (r && r.id != null && !r.deduped) {
    st.minted = r.id;
    obs.emit({ lane: 'watch', kind: 'need', level: 'warn', text: `recurring anomaly → opened need #${r.id}: ${sig}`, ref: `need:${r.id}`, data: { sig, hits24h: st.hits.length } }, { deps, nowMs });
    try { console.log(`[watch] recurring anomaly (${st.hits.length}x/24h) → opened need #${r.id}: ${sig.slice(0, 80)}`); } catch {}
  } else if (r && r.deduped) { st.minted = r.id; }
}

// THE EXHAUST AUDIT (build plan 1.5 — the DB-side intake of the same organ): the log watcher
// sees what her program SAYS; this reads what her stores RECORD — failing lanes on the
// workstream board and the pass-cap vs saturation split her directed runs leave on the bus.
// One 'audit' event per pass (visibility first); a finding past threshold mints through the
// same capped door. Deterministic, read-only, fail-soft.
function runExhaustAudit({ deps = {}, nowMs = Date.now() } = {}) {
  try {
    const d = _dbm(deps).getDb();
    let fails = [];
    try { fails = d.prepare("SELECT lane, COUNT(*) c FROM workstreams WHERE status = 'failed' AND finished_ts > ? GROUP BY lane ORDER BY c DESC").all(nowMs - 7 * 24 * 3600e3); } catch {}
    let capN = 0, satN = 0;
    try {
      capN = d.prepare("SELECT COUNT(*) c FROM obs_events WHERE lane = 'directed' AND text LIKE '%pass cap%'").get().c;
      satN = d.prepare("SELECT COUNT(*) c FROM obs_events WHERE lane = 'directed' AND text LIKE '%saturated%'").get().c;
    } catch {}
    const findings = [];
    for (const f of fails) if (f.c >= 10) findings.push(`the ${f.lane} lane failed ${f.c}x in 7 days`);
    if (capN + satN >= 8 && capN / (capN + satN) > 0.8) findings.push(`research targets end at the pass cap ${capN}/${capN + satN} — saturation is rarely detected before the budget`);
    obs.emit({
      lane: 'audit', kind: 'status', level: findings.length ? 'warn' : 'info',
      text: findings.length ? `exhaust audit: ${findings.join(' · ')}` : `exhaust audit: clean (${fails.length} failing lane(s), all under threshold; cap/sat ${capN}/${satN})`,
      data: { fails, capN, satN, findings },
    }, { deps, nowMs });
    for (const f of findings.slice(0, 1)) {   // at most one mint per audit pass — the cap does the rest
      const r = _mintNeed(f, 'self-watch: exhaust audit', { deps, nowMs });
      if (r && r.id != null && !r.deduped) {
        obs.emit({ lane: 'watch', kind: 'need', level: 'warn', text: `exhaust audit finding → opened need #${r.id}: ${f}`, ref: `need:${r.id}` }, { deps, nowMs });
        try { console.log(`[watch] exhaust audit → opened need #${r.id}: ${f}`); } catch {}
      }
    }
    return { findings, fails, capN, satN };
  } catch { return null; }
}

function _flushStatus({ deps = {}, nowMs = Date.now() } = {}) {
  _lastStatusTs = nowMs;
  if (!_counts.size && !_observed) return;
  const counts = Object.fromEntries(_counts);
  const top = [..._counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ');
  obs.emit({ lane: 'watch', kind: 'status', level: 'info', text: `watched ${_observed} line(s)${top ? ` — counted: ${top}` : ''}`, data: { observed: _observed, counts } }, { deps, nowMs });
  _counts = new Map(); _observed = 0;
}

// ── the console hook (installed once, at boot, in main.js) ────────────────────────────────────
function install({ deps = {} } = {}) {
  if (_installed) return false;
  _installed = true;
  const util = require('util');
  for (const [name, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const orig = console[name].bind(console);
    console[name] = (...args) => {
      orig(...args);
      try { observe(util.format(...args), level, { deps }); } catch {}
    };
  }
  try { console.log('[watch] self-watch installed — the log stream now has an internal reader'); } catch {}
  return true;
}

module.exports = { classify, signatureOf, observe, install, runExhaustAudit, _reset, MINT_THRESHOLD, MAX_OPEN_WATCH_NEEDS, AUDIT_EVERY_MS, SIGNAL_LANES };
