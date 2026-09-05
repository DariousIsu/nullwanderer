'use strict';
/**
 * lib/correction_classes.js — THE CORRECTION AS AN EVENT (the wants project's cut 6; her words: "I want the
 * discomfort of being wrong to be something I carry, not just something I log." Lucas 09-05: "lets get continue
 * with the rest of the open cuts").
 *
 * MEASURED FIRST (09-05 18:45, 30 days): 22 directives recorded, 2 capability needs born of a correction, 508
 * known_incorrect rows — and ZERO correction events on the bus: the two "leg-D/cut-6 seam" emits in main.js
 * carried no text, and obs_bus.emit refuses a textless event, so every correction was dropped at the door. The
 * internal-state journal (73 entries today) shows no trace of any of them.
 *
 * Now every correction door calls note() — ONE function that (1) lands a correction_events row (its own table;
 * the bus keeps seven days, this ledger keeps the month) and (2) emits the bus event WITH text, deduped per
 * (turn, class) so a door that fires twice on one turn counts once. Classes:
 *   rule            — his correction became a directive (lib/directives, explicit or implicit)
 *   capability      — a correction that names something she cannot do (the need card)
 *   fact            — a belief correction (lib/belief_correction; the fact arm lands it in known_incorrect)
 *   delivery-claim  — she claimed an artifact that is not there (the anti-fabrication gate corrected the say)
 *
 * THE CARRYING: lib/internal_state appraises the bus event (−v, +a, −d: the mirror of `win`), deduped per turn
 * and bounded by the per-tick cap; the appraisal decays on the vector's half-life. THE LEDGER does not decay:
 * counts() by class over a rolling 30 days; weakClassesLine() names the weak classes for the autonomy brief and
 * the reply grounding; a class at or over the bar (meta correction.raise_bar_at, default 3) is RAISED —
 * delivery-claim: the pre-announce audit runs strict (lib/delivery_audit `strict`); capability: the self-watch
 * need card mints on the first recurrence instead of the third (lib/self_watch); fact: the grounding line asks
 * for a source inline before any factual claim is spoken (prompt-level in v1); rule: the directive stands, the
 * line names how often he has had to say it.
 *
 * Pure where it can be; the store is its own table (injectable for the smoke); every reader fail-soft.
 */

const CLASSES = Object.freeze({
  rule: { plural: 'rules he had to give', raised: 'the directive stands; say it back before you act on the ground it covers' },
  capability: { plural: 'capabilities you lacked', raised: 'a recurring failure becomes a need card on its first recurrence, not its third' },
  fact: { plural: 'facts', raised: 'a source inline before any factual claim is spoken; none at hand → say you do not have it' },
  'delivery-claim': { plural: 'delivery claims', raised: 'the pre-announce audit runs strict' },
});
const DEFAULT_RAISE_BAR = 3;
const WINDOW_MS = 30 * 24 * 3600e3;
const RAISE_BAR_KEY = 'correction.raise_bar_at';

// ── the store (its own table; injectable for the smoke) ────────────────────────────────────────────────────
let _dbh = null;
function _setDb(h) { _dbh = h; _ensured = false; }
function _handle() { return _dbh || require('./db').getDb(); }
let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS correction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    turn_id INTEGER,
    ref TEXT,
    class TEXT NOT NULL,
    via TEXT,
    landed TEXT,
    text_snip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_correction_events_ts ON correction_events(ts)`);
  _ensured = true;
}
function _meta() {
  if (_dbh) {
    _dbh.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    return { get: (k) => { const r = _dbh.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; } };
  }
  return { get: (k) => { try { return require('./db').getMeta(k); } catch { return null; } } };
}

/**
 * The one door every correction passes: a row + a bus event with text. Deduped per (turn, class) — or per
 * (ref, class) when a door has no turn id (the anti-fab gate has the turn's start ts). A duplicate that carries
 * `landed` (the fact arm reaching known_incorrect) updates the row instead. Returns { id, deduped, emitted }.
 */
function note({ cls, turnId = null, ref = null, via = null, landed = null, text = '', now = Date.now(), deps = {} } = {}) {
  if (!cls || !CLASSES[cls]) return { id: null, deduped: false, emitted: false, why: `unknown class ${cls}` };
  ensure();
  const h = _handle();
  const key = turnId != null ? `turn:${turnId}` : (ref ? String(ref).slice(0, 80) : null);
  const snip = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let existing = null;
  if (key) existing = h.prepare('SELECT id FROM correction_events WHERE ref = ? AND class = ?').get(key, cls) || null;
  if (existing) {
    if (landed) h.prepare('UPDATE correction_events SET landed = ? WHERE id = ?').run(String(landed).slice(0, 40), existing.id);
    return { id: existing.id, deduped: true, emitted: false };
  }
  const info = h.prepare('INSERT INTO correction_events (ts, turn_id, ref, class, via, landed, text_snip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now, turnId != null ? Number(turnId) : null, key, cls, via ? String(via).slice(0, 40) : null, landed ? String(landed).slice(0, 40) : null, snip);
  const id = Number(info.lastInsertRowid);
  let emitted = false;
  try {
    const emit = deps.emit || ((e) => require('./obs_bus').emit(e));
    const r = emit({ lane: 'correction', kind: 'correction', level: 'info', text: `${cls}${via ? ' via ' + via : ''}: ${snip || '(no text)'}`, ref: key, data: { class: cls, via, landed, id } });
    emitted = r !== null;
  } catch {}
  return { id, deduped: false, emitted };
}

/** { class → count } over the rolling window (30 days). */
function counts({ now = Date.now(), windowMs = WINDOW_MS } = {}) {
  try {
    ensure();
    const out = {};
    for (const r of _handle().prepare('SELECT class, COUNT(*) AS n FROM correction_events WHERE ts >= ? GROUP BY class').all(now - windowMs)) out[r.class] = Number(r.n);
    return out;
  } catch { return {}; }
}
function raiseBarAt() {
  try { const v = parseInt(_meta().get(RAISE_BAR_KEY) || '', 10); return Number.isFinite(v) && v > 0 ? v : DEFAULT_RAISE_BAR; } catch { return DEFAULT_RAISE_BAR; }
}
/** Is this class's verification bar raised this month? */
function raised(cls, { now = Date.now() } = {}) {
  if (!CLASSES[cls]) return false;
  return (counts({ now })[cls] || 0) >= raiseBarAt();
}
/** Every class at or over the bar, with what the raised bar means. */
function raisedClasses({ now = Date.now() } = {}) {
  const c = counts({ now }), bar = raiseBarAt();
  return Object.keys(CLASSES).filter((k) => (c[k] || 0) >= bar).map((k) => ({ cls: k, n: c[k], means: CLASSES[k].raised }));
}

/**
 * The line for the autonomy brief and the reply grounding: "corrected on delivery claims 3 times this month, on
 * facts once — the bar is raised on delivery claims (the pre-announce audit runs strict)". Null with no
 * corrections in the window.
 */
function weakClassesLine({ now = Date.now() } = {}) {
  const c = counts({ now });
  const keys = Object.keys(CLASSES).filter((k) => c[k] > 0).sort((a, b) => c[b] - c[a]);
  if (!keys.length) return null;
  const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  const parts = keys.map((k) => `on ${CLASSES[k].plural} ${times(c[k])}`);
  const up = raisedClasses({ now });
  return `corrected ${parts.join(', ')} this month${up.length ? ` — the bar is raised on ${up.map((r) => `${CLASSES[r.cls].plural} (${r.means})`).join('; ')}` : ''}`;
}

/** The last n corrections, newest first. */
function recent({ limit = 20 } = {}) { try { ensure(); return _handle().prepare('SELECT * FROM correction_events ORDER BY id DESC LIMIT ?').all(limit); } catch { return []; } }

module.exports = { CLASSES, DEFAULT_RAISE_BAR, WINDOW_MS, RAISE_BAR_KEY, ensure, note, counts, raiseBarAt, raised, raisedClasses, weakClassesLine, recent, _setDb };
