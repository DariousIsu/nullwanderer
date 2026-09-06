/**
 * lib/work_board.js — LIVE WORK GRAPHICS (Lucas 09-01: "this turn is a perfect example of where
 * live charts and graphics would be useful"). Long-running work used to report in prose and log
 * lines; the board DRAWS it — one lane per live run, refreshed while the run breathes, settling
 * into its terminal frame when the run ends.
 *
 * ⭐THE LAW HOLDS (the same law as report_graphics): A MODEL NEVER DRAWS A BAR. snapshot()
 * SELECTs real state — code_proposals, the pen queue, the parlor visit, the quiet window, the
 * outside cycler's lock — and renderSVG() lays it out deterministically: same snapshot, same
 * bytes, every text node escaped. No model authors a number anywhere on this surface.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// stage → progress, derived from the row's own status and stage note (data, never vibes)
function _penProgress(status, note) {
  const s = String(status || '');
  if (s === 'applied' || s === 'gate-failed' || s === 'apply-failed' || s === 'rejected' || s === 'stale') return 1;
  if (s === 'applying') return /FULL gate running/.test(String(note || '')) ? 0.65 : 0.35;
  if (s === 'approved') return 0.2;
  return 0.1;
}

/** Real state → lanes. Every number is SELECTed; nowMs is injectable for determinism. */
function snapshot({ nowMs = Date.now() } = {}) {
  const lanes = [];
  try {
    const pen = require('./code_pen');
    const rows = db.getDb().prepare(`SELECT id, title, status, gate_note, updated_ts FROM code_proposals
      WHERE status IN ('approved','applying') OR (status IN ('applied','gate-failed','apply-failed','stale') AND updated_ts > ?)
      ORDER BY updated_ts DESC LIMIT 6`).all(nowMs - pen.RUN_WINDOW_MS);
    for (const r of rows) {
      lanes.push({ kind: 'pen', id: `pen-${r.id}`, label: `PEN #${r.id} — ${String(r.title || '').slice(0, 60)}`,
        status: r.status, note: String(r.gate_note || '').split('\n')[0], progress: _penProgress(r.status, r.gate_note) });
    }
    const q = pen.workQueue ? pen.workQueue() : [];
    if (q.length) lanes.push({ kind: 'queue', id: 'pen-queue', label: 'Pen work queue', status: 'active', note: `${q.length} thread(s) queued`, progress: null });
  } catch {}
  try {
    const parlor = require('./parlor');
    const v = parlor.visit();
    if (v && v.open) {
      lanes.push({ kind: 'parlor', id: 'parlor', label: 'Parlor visit', status: 'open',
        note: `${v.turns || 0}/${parlor.VISIT_TURN_BUDGET} turns — ${String(v.reason || '').slice(0, 70)}`,
        progress: Math.min(1, (v.turns || 0) / parlor.VISIT_TURN_BUDGET) });
    }
  } catch {}
  try {
    const gu = Number(db.getMeta('pen.gate_until') || 0);
    if (gu > nowMs) lanes.push({ kind: 'quiet', id: 'quiet', label: 'Quiet window', status: 'active', note: `gate running — background lanes hold (~${Math.ceil((gu - nowMs) / 60000)}min left)`, progress: null });
  } catch {}
  try {
    if (fs.existsSync(path.join(__dirname, '..', 'boot_cycle.lock'))) {
      lanes.push({ kind: 'cycle', id: 'cycle', label: 'Boot cycle (the outside hand)', status: 'active', note: 'the cycler holds the lock', progress: null });
    }
  } catch {}
  return { at: nowMs, lanes };
}

const LANE_COLORS = {
  applied: '#3fb26f', 'gate-failed': '#e05b5b', 'apply-failed': '#e05b5b', rejected: '#9a9aa6', stale: '#b08a3c',
  applying: '#d9a03c', approved: '#d9a03c', open: '#a78bfa', active: '#4c9df8',
};

/** Deterministic SVG board: same snapshot in, same bytes out. Eastern clock (the display law). */
function renderSVG(snap) {
  const lanes = (snap && snap.lanes) || [];
  const W = 720, rowH = 58, headH = 46;
  const H = headH + Math.max(1, lanes.length) * rowH + 14;
  const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(snap && snap.at ? snap.at : 0);
  const rows = lanes.map((l, i) => {
    const y = headH + i * rowH;
    const color = LANE_COLORS[l.status] || '#9a9aa6';
    const barW = 680;
    const prog = (l.progress == null) ? null : Math.max(0, Math.min(1, l.progress));
    const bar = `<rect x="20" y="${y + 36}" width="${barW}" height="8" rx="4" fill="#2c2c34"/>` + (prog == null
      ? `<rect x="20" y="${y + 36}" width="${barW}" height="8" rx="4" fill="${color}" opacity="0.22"/>`
      : `<rect x="20" y="${y + 36}" width="${Math.max(4, Math.round(barW * prog))}" height="8" rx="4" fill="${color}"/>`);
    return `<g><text x="20" y="${y + 16}" font-size="13" font-weight="600" fill="#e8e8ee">${esc(String(l.label).slice(0, 78))}</text>`
      + `<text x="${W - 20}" y="${y + 16}" font-size="11" text-anchor="end" fill="${color}">${esc(l.status)}</text>`
      + `<text x="20" y="${y + 30}" font-size="11" fill="#9a9aa6">${esc(String(l.note || '').slice(0, 100))}</text>${bar}</g>`;
  }).join('');
  const empty = lanes.length ? '' : `<text x="20" y="${headH + 26}" font-size="12" font-style="italic" fill="#9a9aa6">Nothing running. Lanes appear the moment work starts.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="live work board">`
    + `<rect width="${W}" height="${H}" fill="#17171c"/>`
    + `<text x="20" y="28" font-size="14" font-weight="700" letter-spacing="1" fill="#e8e8ee">WORK BOARD</text>`
    + `<text x="${W - 20}" y="28" font-size="11" text-anchor="end" fill="#9a9aa6">${esc(stamp)} ET</text>`
    + rows + empty + '</svg>';
}

module.exports = { snapshot, renderSVG, _penProgress };
