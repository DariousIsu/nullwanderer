/**
 * lib/affect_tissues.js — the PYTHON TISSUE DRIVER (affect substrate B2/B3 wiring, 2026-08-31).
 *
 * Runs the deterministic affect passes (tissues/tissue_appraisal.py, tissues/tissue_impression.py)
 * as short-lived child processes on a paced, idle-gated cadence. DARK BY DESIGN (the Slice-0
 * pattern): the tissues write JSON manifests under data/affect/ and NOTHING reads them yet —
 * consumers wire in only after the manifests prove honest by hand.
 *
 * RUNTIME LAYERING (the don't-kill-the-computer contract, in order):
 *   • zero model calls — the tissues are float arithmetic + indexed SQLite lookups (ms of CPU);
 *   • short-lived processes, never daemons — spawn → compute → write → exit;
 *   • sequential, never concurrent — one tissue at a time (the curator-drain pattern);
 *   • paced (30 min default, ZOE_TISSUE_PACE_S) + idle-gated (never during his conversation);
 *   • BELOW_NORMAL priority via os.setPriority — a tissue loses every scheduling fight;
 *   • hard timeout (60s) + killed on breach; output capped;
 *   • tissues open every DB mode=ro — a write is rejected by SQLite itself (analysis_lane's rail).
 *
 * Kill switch: meta swarm.tissues = 'off'. Fail-soft everywhere: a missing weights DB, a missing
 * interpreter, or a dead spawn logs once and no-ops — the app never notices.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.ZOE_DATA_DIR || path.join(APP_ROOT, 'data');
const STATE_DIR = path.join(DATA_DIR, 'affect');
const WEIGHTS = path.join(DATA_DIR, 'affect_weights.db');
const PACE_MS = (parseFloat(process.env.ZOE_TISSUE_PACE_S) || 1800) * 1000;
const IDLE_FLOOR_MS = 5 * 60 * 1000;      // never within 5 min of his last turn
const RUN_TIMEOUT_MS = 60 * 1000;
const LAST_KEY = 'affect_tissues.last_run';
const KILL_KEY = 'swarm.tissues';

const TISSUES = [
  { name: 'appraisal', script: path.join(APP_ROOT, 'tissues', 'tissue_appraisal.py') },
  { name: 'impression', script: path.join(APP_ROOT, 'tissues', 'tissue_impression.py') },
];

let _warned = null;   // one-time missing-precondition log per boot
let _running = false;

function _pyInterp() {
  try { const p = require('./rehearsal').pyInterp(); if (p) return p; } catch {}
  return process.env.ECHO_PYTHON || 'python';
}

function _runOne(py, t, dbPath, { nowMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '', done = false;
    const child = spawn(py, [t.script, '--db', dbPath, '--weights', WEIGHTS, '--state-dir', STATE_DIR, '--now', String(nowMs)],
      { cwd: APP_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // A tissue must lose every scheduling fight with the app, the models, and the engine.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const timer = setTimeout(() => {
      if (!done) { try { child.kill(); } catch {} console.error(`[tissue] ${t.name} TIMEOUT after ${RUN_TIMEOUT_MS / 1000}s — killed`); }
    }, RUN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { if (out.length < 4000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { done = true; clearTimeout(timer); console.error(`[tissue] ${t.name} spawn failed: ${e.message}`); resolve(false); });
    child.on('close', (code) => {
      done = true; clearTimeout(timer);
      if (code === 0) { console.log(`[tissue] ${t.name} ok (${Date.now() - t0}ms) — ${out.trim().slice(0, 160)}`); resolve(true); }
      else { console.error(`[tissue] ${t.name} exit ${code} — ${(err || out).trim().slice(0, 200)}`); resolve(false); }
    });
  });
}

/** Called from the 10-min tick. Due-gate + idle-gate inside; sequential; fail-soft. */
async function maybeRun({ deps = {}, nowMs = Date.now() } = {}) {
  const db = (deps && deps.db) || require('./db');
  try {
    if (_running) return { ran: false, why: 'in-flight' };
    if (db.getMeta(KILL_KEY) === 'off') return { ran: false, why: 'kill-switch' };
    const last = parseInt(db.getMeta(LAST_KEY) || '0', 10) || 0;
    if (nowMs - last < PACE_MS) return { ran: false, why: 'paced' };
    const idleMs = nowMs - (deps.lastUserTurnTs || 0);
    if (deps.lastUserTurnTs && idleMs < IDLE_FLOOR_MS) return { ran: false, why: 'not-idle' };
    if (!fs.existsSync(WEIGHTS)) {
      if (_warned !== 'weights') { _warned = 'weights'; console.log('[tissue] weights db absent (data/affect_weights.db) — tissues idle until built'); }
      return { ran: false, why: 'no-weights' };
    }
    const dbPath = process.env.SQ_DB_PATH || path.join(DATA_DIR, 'sq.db');
    const py = _pyInterp();
    _running = true;
    db.setMeta(LAST_KEY, String(nowMs));
    let okCount = 0;
    for (const t of TISSUES) {
      // sequential by contract — one tissue at a time, ever
      // eslint-disable-next-line no-await-in-loop
      if (await _runOne(py, t, dbPath, { nowMs })) okCount++;
    }
    _running = false;
    return { ran: true, ok: okCount, of: TISSUES.length };
  } catch (e) {
    _running = false;
    try { console.error('[tissue] driver failed soft:', e.message); } catch {}
    return { ran: false, why: 'error' };
  }
}

// ── B4: the manifests render into the mood prompt (the ONE consumer, measurement-shaped) ────────
// One compact line of the tissues' current readings for mood.compose's MEASURED STATE block —
// values + trimmed reasons, never an instruction to feel (the anti-performance rule). FAIL-ABSENT:
// manifest missing, stale (> MANIFEST_FRESH_MS), or torn → null → the mood prompt is byte-identical.
const MANIFEST_FRESH_MS = 45 * 60 * 1000;   // tissues pace at 30 min; older than 45 is not "now"

function _readManifest(name, { stateDir = STATE_DIR } = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); } catch { return null; }
}

function manifestLine({ nowMs = Date.now(), stateDir = STATE_DIR } = {}) {
  try {
    const parts = [];
    const ap = _readManifest('manifest_appraisal.json', { stateDir });
    if (ap && ap.at && nowMs - ap.at <= MANIFEST_FRESH_MS) {
      const emos = (ap.emotions || []).slice(0, 3)
        .map((e) => `${e.name} ${e.intensity} (${String(e.reason || '').slice(0, 90)})`);
      if (emos.length) parts.push(`felt now: ${emos.join('; ')}`);
      if (ap.mood && ap.mood.band) parts.push(`undertone ${ap.mood.band}`);
    }
    const im = _readManifest('manifest_impressions.json', { stateDir });
    if (im && im.at && nowMs - im.at <= MANIFEST_FRESH_MS && Array.isArray(im.subjects) && im.subjects.length) {
      const s = im.subjects[0];
      parts.push(`closest subject: ${s.name} (attachment ${s.attachment}, valence ${s.valence}, ${s.encounters} encounter${s.encounters === 1 ? '' : 's'})`);
    }
    if (!parts.length) return null;
    const at = ap && ap.at ? ap.at : (im ? im.at : nowMs);
    return `${parts.join(' · ')} — computed ${Math.max(0, Math.round((nowMs - at) / 60000))}m ago by the affect tissues`;
  } catch { return null; }
}

module.exports = { maybeRun, manifestLine, TISSUES, PACE_MS, IDLE_FLOOR_MS, RUN_TIMEOUT_MS, MANIFEST_FRESH_MS, WEIGHTS, STATE_DIR, LAST_KEY, KILL_KEY, _pyInterp };
