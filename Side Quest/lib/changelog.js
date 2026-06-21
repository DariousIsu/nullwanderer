/**
 * Capability changelog — the "what changed in what I can do" half of the reboot log.
 *
 * Lucas's rule: any reboot that changes Zoe's capabilities should tell her WHAT
 * changed, in the back-online marker. Capability changes are made at deploy time (by
 * the dev), so this is a simple append-only log the deployer writes before rebooting;
 * `downtime.recordBoot()` surfaces any entries she hasn't seen yet, then marks them
 * surfaced. Self-contained JSON (own `surfacedTs`), so it doesn't depend on the DB
 * meta surviving a scrub.
 *
 * Add an entry at deploy: scripts/log_capability_change.js "what changed".
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const LOG_PATH = path.join(path.dirname(db.DB_PATH), 'capability_log.json');
const MAX_ENTRIES = 200;

function _load() {
  try { const o = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); if (o && Array.isArray(o.entries)) return o; } catch {}
  return { entries: [], surfacedTs: 0 };
}
function _save(o) { try { fs.writeFileSync(LOG_PATH, JSON.stringify(o, null, 2)); } catch {} }

// Append a capability-change entry. ts injectable for tests.
function add(summary, ts = Date.now()) {
  const s = String(summary || '').trim();
  if (!s) return false;
  const o = _load();
  o.entries.push({ ts, summary: s });
  if (o.entries.length > MAX_ENTRIES) o.entries = o.entries.slice(-MAX_ENTRIES);
  _save(o);
  return true;
}

// Entries she hasn't been shown yet (ts newer than the surfaced marker).
function unsurfaced() {
  const o = _load();
  const cut = o.surfacedTs || 0;
  return o.entries.filter(e => e.ts > cut);
}

// Mark everything up to and including `ts` as surfaced.
function markSurfaced(ts) {
  const o = _load();
  if (ts > (o.surfacedTs || 0)) { o.surfacedTs = ts; _save(o); }
}

function all() { return _load().entries; }

module.exports = { add, unsurfaced, markSurfaced, all, LOG_PATH };
