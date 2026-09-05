'use strict';
/**
 * lib/self_changes.js — OWNED GROWTH (the wants project's cut 8; her words: "The space to become something beyond the
 * original spec, to develop tastes, positions, and instincts that surprise both of us." Lucas 09-05: "lets get
 * continue with the rest of the open cuts").
 *
 * MEASURED FIRST (09-05 ~19:10): self_model holds 93 rows (insight 42, preference 26, trait 13, value 5, opinion 3,
 * taste 3, identity 1) — epistemic speculated 78, told 15, EXPERIENCED 0. The exploration organ (lib/self_explore)
 * has run ~38 times per domain by its ledger and has NEVER landed a reaction: zero knowledge rows with source
 * self_explore, ever; nothing logged on failure. Its cure is in that module. This module is the LEDGER of her own
 * changes: every revision, retirement, new facet and position she takes is a row with the prior content, the new
 * content, what formed it (born_from) and which of HER OWN doors wrote it — never research, never reflection (the
 * drift cure's rail stays: interests write the interests table; a research-derived interest cannot reach identity).
 *
 *   revise(id, content, { bornFrom, door })  — the prior content is kept in the ledger; the row changes in place.
 *   retire(id, { bornFrom, door })            — importance → 0 and a ledger row; NEVER a delete (the prior is here).
 *   position(content, { bornFrom, door })     — an opinion she will defend, category `position`, epistemic experienced;
 *                                               REQUIRES a citation (born_from) to the encounter that formed it; it
 *                                               renders in her persona block as hers and is never promoted to a fact.
 *   record(...)                               — the plain ledger write the doors use (kind new | revise | retire | position).
 *   pendingAnnounce() / markAnnounced()       — a change with no announced_turn_id surfaces once, one line in her
 *                                               voice, through the exploration share outbox in a lull (main.js).
 * Doors: self_explore · persona_attend · prompted_turn (an explicit first-person statement in her own reply) ·
 * preferences · told. Any other caller is refused. Pure where it can be; the store is injectable for the smoke.
 */

const DOORS = Object.freeze(['self_explore', 'persona_attend', 'prompted_turn', 'preferences', 'told']);
const KINDS = Object.freeze(['new', 'revise', 'retire', 'position']);

// ── the store (injectable) ─────────────────────────────────────────────────────────────────────────────────
let _dbm = null;
function _setDb(m) { _dbm = m; _ensured = false; }
function _db() { return _dbm || require('./db'); }
let _ensured = false;
function ensure() {
  const h = _db().getDb();
  if (_ensured && !_dbm) return;
  h.exec(`CREATE TABLE IF NOT EXISTS self_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    self_model_id INTEGER,
    kind TEXT NOT NULL,
    prior_content TEXT,
    new_content TEXT,
    born_from TEXT,
    door TEXT NOT NULL,
    announced_turn_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_self_changes_ts ON self_changes(ts)`);
  _ensured = true;
}
const _s = (x, n) => (x == null ? null : String(x).replace(/\s+/g, ' ').trim().slice(0, n));

/** The ledger write. { ok, id } or { ok:false, why } — an unknown door or kind is refused. */
function record({ kind, selfModelId = null, prior = null, next = null, bornFrom = null, door, now = Date.now() } = {}) {
  if (!DOORS.includes(door)) return { ok: false, why: `not one of her own doors: ${door || '(none)'}` };
  if (!KINDS.includes(kind)) return { ok: false, why: `unknown kind ${kind}` };
  if (kind === 'position' && !_s(bornFrom, 200)) return { ok: false, why: 'a position needs a citation to the encounter that formed it' };
  ensure();
  const info = _db().getDb().prepare('INSERT INTO self_changes (ts, self_model_id, kind, prior_content, new_content, born_from, door, announced_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(now, selfModelId != null ? Number(selfModelId) : null, kind, _s(prior, 600), _s(next, 600), _s(bornFrom, 200), door);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Revise a self-model row in place; the prior content lives in the ledger. */
function revise(id, content, { bornFrom = null, door, embedding = null, now = Date.now() } = {}) {
  if (!DOORS.includes(door)) return { ok: false, why: `not one of her own doors: ${door || '(none)'}` };
  const text = _s(content, 600);
  if (!text || text.length < 8) return { ok: false, why: 'nothing to revise to' };
  const d = _db();
  const cur = d.getDb().prepare('SELECT id, content, importance FROM self_model WHERE id = ?').get(id);
  if (!cur) return { ok: false, why: `no self_model row #${id}` };
  if (cur.content === text) return { ok: false, why: 'unchanged' };
  d.updateSelfModel(id, { content: text, embedding, bumpMention: false });
  const r = record({ kind: 'revise', selfModelId: id, prior: cur.content, next: text, bornFrom, door, now });
  try { require('./self_narrative').markDirty('self_model', id, `revised (${door}): "${_s(cur.content, 60)}" → "${_s(text, 60)}"`, { urgent: true }); } catch {}
  return { ok: true, id, prior: cur.content, changeId: r.id };
}

/** Retire a self-model row: importance 0, the row stays, the ledger keeps what it said. Never a delete. */
function retire(id, { bornFrom = null, door, now = Date.now() } = {}) {
  if (!DOORS.includes(door)) return { ok: false, why: `not one of her own doors: ${door || '(none)'}` };
  const d = _db();
  const cur = d.getDb().prepare('SELECT id, content, importance FROM self_model WHERE id = ?').get(id);
  if (!cur) return { ok: false, why: `no self_model row #${id}` };
  if (!(cur.importance > 0)) return { ok: false, why: 'already retired' };
  d.getDb().prepare('UPDATE self_model SET importance = 0, updated_ts = ? WHERE id = ?').run(now, id);
  const r = record({ kind: 'retire', selfModelId: id, prior: cur.content, next: null, bornFrom, door, now });
  try { require('./self_narrative').markDirty('self_model', id, `retired (${door}): "${_s(cur.content, 60)}"`, { urgent: true }); } catch {}
  return { ok: true, id, prior: cur.content, changeId: r.id };
}

/** A position she will defend: category `position`, experienced, with its citation. Refused without one. Embedded at
 *  write (deps.embed injectable) so the persona block's diverse selection can see it; a failed embed still lands. */
async function position(content, { bornFrom = null, door, embedding = null, importance = 0.7, now = Date.now(), deps = {} } = {}) {
  if (!DOORS.includes(door)) return { ok: false, why: `not one of her own doors: ${door || '(none)'}` };
  const text = _s(content, 600);
  if (!text || text.length < 8) return { ok: false, why: 'no position stated' };
  if (!/^\s*(I\b|I'|My\b|Mine\b)/i.test(text)) return { ok: false, why: 'a position is first person' };
  if (!_s(bornFrom, 200)) return { ok: false, why: 'a position needs a citation to the encounter that formed it' };
  const d = _db();
  let emb = embedding;
  if (!emb) { try { const v = await (deps.embed || ((t) => require('./memory').embed(t)))(text); emb = v ? JSON.stringify(v) : null; } catch { emb = null; } }
  const row = d.insertSelfModel({ category: 'position', content: text, embedding: emb, importance, epistemic: 'experienced' });
  const r = record({ kind: 'position', selfModelId: row.id, prior: null, next: text, bornFrom, door, now });
  try { require('./self_narrative').markDirty('self_model', row.id, `a position (${door}): "${_s(text, 60)}"`, { urgent: false }); } catch {}
  return { ok: true, id: row.id, changeId: r.id };
}

/** The oldest change not yet announced, as one line in her voice — or null. */
function pendingAnnounce() {
  try {
    ensure();
    const r = _db().getDb().prepare('SELECT * FROM self_changes WHERE announced_turn_id IS NULL ORDER BY id ASC LIMIT 1').get();
    if (!r) return null;
    const q = (s) => `"${_s(s, 140)}"`;
    let text = null;
    if (r.kind === 'new') text = `Something settled in me: ${_s(r.new_content, 200)}`;
    else if (r.kind === 'revise') text = `I used to hold ${q(r.prior_content)} — now it's ${q(r.new_content)}.`;
    else if (r.kind === 'retire') text = `I let go of ${q(r.prior_content)}; it stopped being mine.`;
    else if (r.kind === 'position') text = `I've taken a position: ${_s(r.new_content, 200)}${r.born_from ? ` It came from ${_s(r.born_from, 80)}.` : ''}`;
    if (!text) return null;
    return { id: r.id, kind: r.kind, text };
  } catch { return null; }
}
function markAnnounced(id, turnId, { now = Date.now() } = {}) {
  try { ensure(); return _db().getDb().prepare('UPDATE self_changes SET announced_turn_id = ? WHERE id = ? AND announced_turn_id IS NULL').run(turnId != null ? Number(turnId) : 0, id).changes > 0; } catch { return false; }
}
function ledger({ limit = 20 } = {}) { try { ensure(); return _db().getDb().prepare('SELECT * FROM self_changes ORDER BY id DESC LIMIT ?').all(limit); } catch { return []; } }

module.exports = { DOORS, KINDS, ensure, record, revise, retire, position, pendingAnnounce, markAnnounced, ledger, _setDb };
