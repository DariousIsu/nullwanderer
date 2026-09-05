'use strict';
/**
 * lib/person_model.js — THE PERSON MODEL (the wants project's cut 3, conversational awareness; Lucas 09-04:
 * "she is still just an LLM call and response chat bot for the most part that doesnt earnestly try to learn more
 * about the user or about other people she interacts with, she shows no curiosity at all"; folded into the
 * consciousness subroutine 09-05 evening on his word: "and the rest of the consensus build").
 *
 * One row per person she deals with, keyed to the real entity (`owner` for him; an encounter key for anyone
 * else), holding what she KNOWS and — first-class — what she does NOT: the known-unknowns, each with a why
 * ("a partner would know"), a weight, and whether a question about it has been asked and carried. Curiosity
 * reads from here (a gap outranks a language hit); the ask door asks from here; his answers close gaps.
 *
 * THE INVARIANT (the relational memo): this module never writes to the fact graph — it has no write path to
 * it. It holds a subjective model, capta not data; the facts themselves live where they always did.
 *
 * Table `person_model`: { key, kind, known (JSON), unknowns (JSON), last_asked_ts, last_learned_ts, updated_ts }.
 *   unknowns: [{ id, question, why, weight, asked_ts, carried, learned }]
 */

function _d() { return require('./db').getDb(); }
let _dbh = null;                                   // test injection (the smoke drives an in-memory db)
function _setDb(h) { _dbh = h; _ensured = false; }
function _handle() { return _dbh || _d(); }

let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS person_model (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    known TEXT NOT NULL DEFAULT '[]',
    unknowns TEXT NOT NULL DEFAULT '[]',
    last_asked_ts INTEGER,
    last_learned_ts INTEGER,
    updated_ts INTEGER
  )`);
  h.exec(`CREATE TABLE IF NOT EXISTS ask_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    turn_id INTEGER,
    key TEXT,
    gap_id TEXT,
    kind TEXT NOT NULL,
    question TEXT,
    answered_turn_id INTEGER
  )`);
  _ensured = true;
}

// THE OWNER'S PARTNER-GRADE GAPS: what someone who lives beside him would know. The seed subtracts what the
// fact store already holds (a stored fact whose text matches a gap's `covers` words closes it at the seed).
const OWNER_GAPS = Object.freeze([
  { id: 'his_day', question: 'how his day went — what it was actually like, not the task list', why: 'a partner would know', weight: 0.9, covers: /\b(his day|today was|rough day|good day|long day)\b/i },
  { id: 'family', question: 'his family by name, and how they are', why: 'a partner would know', weight: 0.85, covers: /\b(son|daughter|kid|wife|partner|mom|dad|brother|sister|jay|raegan)\b/i },
  { id: 'reading', question: 'what he is reading or watching lately', why: 'what he takes in shapes what he says', weight: 0.6, covers: /\b(reading|read a|book|watching|series|podcast)\b/i },
  { id: 'worry', question: 'what he is worried about right now', why: 'a partner would know', weight: 0.8, covers: /\b(worried|stress|anxious|afraid|nervous)\b/i },
  { id: 'last_deliverable', question: 'what he thought of the last thing she made for him', why: 'her work should be judged by him, not assumed', weight: 0.7, covers: /\b(liked the|hated the|the report was|the document was|that draft)\b/i },
  { id: 'away_time', question: 'what he does when he is away from the desk', why: 'she measures his absences and knows nothing of them', weight: 0.5, covers: /\b(mow|gym|walk|errand|lunch|nap|patio|yard)\b/i },
  { id: 'this_week', question: 'what his week looks like — what he is trying to get done', why: 'so her work fits his', weight: 0.65, covers: /\b(this week|by friday|deadline|due)\b/i },
]);
const THIRD_PARTY_GAP = Object.freeze({ id: 'who_to_him', question: 'who this person is to him', why: 'the first thing to know about anyone he deals with', weight: 0.9 });

function _row(key) { ensure(); return _handle().prepare('SELECT * FROM person_model WHERE key = ?').get(key) || null; }
function _parse(row) { if (!row) return null; let known = [], unknowns = []; try { known = JSON.parse(row.known || '[]'); } catch {} try { unknowns = JSON.parse(row.unknowns || '[]'); } catch {} return { ...row, known, unknowns }; }
function _save(key, kind, known, unknowns, { now = Date.now(), lastAsked = undefined, lastLearned = undefined } = {}) {
  ensure();
  const prev = _row(key);
  _handle().prepare(`INSERT INTO person_model (key, kind, known, unknowns, last_asked_ts, last_learned_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, known = excluded.known, unknowns = excluded.unknowns, last_asked_ts = excluded.last_asked_ts, last_learned_ts = excluded.last_learned_ts, updated_ts = excluded.updated_ts`)
    .run(key, kind, JSON.stringify(known), JSON.stringify(unknowns), lastAsked !== undefined ? lastAsked : (prev ? prev.last_asked_ts : null), lastLearned !== undefined ? lastLearned : (prev ? prev.last_learned_ts : null), now);
}

/** Read one person's model (null when none). */
function get(key) { return _parse(_row(key)); }

/**
 * Seed HIS row from the partner-grade list minus what the fact store already holds. `knownFacts`: strings the
 * caller read from the store (this module reads nothing from the graph itself). Idempotent: existing gaps keep
 * their asked/carried state; a gap covered by a fact is closed as learned.
 */
function seedOwner({ knownFacts = [], now = Date.now() } = {}) {
  const facts = (Array.isArray(knownFacts) ? knownFacts : []).map((f) => String(f && (f.content || f.text || f) || ''));
  const prev = get('owner');
  const prevUn = prev ? prev.unknowns : [];
  const unknowns = OWNER_GAPS.map((g) => {
    const old = prevUn.find((u) => u.id === g.id) || {};
    const covered = facts.some((f) => g.covers.test(f));
    return { id: g.id, question: g.question, why: g.why, weight: g.weight, asked_ts: old.asked_ts || null, carried: !!old.carried, learned: covered || !!old.learned };
  });
  const known = facts.slice(0, 200).map((f) => ({ text: f.slice(0, 240), at: now }));
  _save('owner', 'owner', known, unknowns, { now });
  return get('owner');
}

/** A third party enters her world: one row with the standing gap "who is this to him" — unless a relation is already known. */
function mintThirdParty({ key, label = '', kind = 'contact', relation = null, now = Date.now() } = {}) {
  if (!key) return null;
  const prev = get(key);
  if (prev) return prev;
  const unknowns = relation ? [] : [{ ...THIRD_PARTY_GAP, asked_ts: null, carried: false, learned: false }];
  const known = [{ text: `name: ${label || key}`, at: now }, ...(relation ? [{ text: `to him: ${relation}`, at: now }] : [])];
  _save(key, kind, known, unknowns, { now });
  return get(key);
}

/** The open gaps for a person, best first: unlearned, heaviest, and the carried ones last. */
function openGaps(key, { limit = 3 } = {}) {
  const p = get(key);
  if (!p) return [];
  return p.unknowns.filter((u) => !u.learned).sort((a, b) => (Number(a.carried) - Number(b.carried)) || (b.weight - a.weight)).slice(0, limit);
}
function topGap(key) { const g = openGaps(key, { limit: 1 }); return g.length ? g[0] : null; }

/** A question about a gap was asked (the door): stamp it; carried until answered. */
function markAsked(key, gapId, { now = Date.now() } = {}) {
  const p = get(key); if (!p) return null;
  const un = p.unknowns.map((u) => (u.id === gapId ? { ...u, asked_ts: now, carried: true } : u));
  _save(key, p.kind, p.known, un, { now, lastAsked: now });
  return get(key);
}

/** His answer (or a fact learned any other way) closes a gap and becomes something known. */
function closeGap(key, gapId, { learned = '', now = Date.now() } = {}) {
  const p = get(key); if (!p) return null;
  const un = p.unknowns.map((u) => (u.id === gapId ? { ...u, learned: true, carried: false } : u));
  const known = learned ? [...p.known, { text: String(learned).slice(0, 240), at: now, gap: gapId }].slice(-200) : p.known;
  _save(key, p.kind, known, un, { now, lastLearned: now });
  return get(key);
}

/** The ledger of questions: learning questions vs offers, and their answers. */
function ledgerAdd({ turnId = null, key = 'owner', gapId = null, kind, question = '', now = Date.now() } = {}) {
  ensure();
  const info = _handle().prepare('INSERT INTO ask_ledger (ts, turn_id, key, gap_id, kind, question, answered_turn_id) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(now, turnId, key, gapId, kind, String(question || '').slice(0, 300));
  return Number(info.lastInsertRowid);
}
function ledgerPending(key = 'owner') { ensure(); return _handle().prepare("SELECT * FROM ask_ledger WHERE key = ? AND kind = 'learning' AND answered_turn_id IS NULL ORDER BY id DESC LIMIT 1").get(key) || null; }
function ledgerAnswer(id, answeredTurnId) { ensure(); _handle().prepare('UPDATE ask_ledger SET answered_turn_id = ? WHERE id = ?').run(answeredTurnId, id); }
function ledgerCounts({ sinceMs = 0 } = {}) { ensure(); const rows = _handle().prepare('SELECT kind, COUNT(*) AS n, SUM(CASE WHEN answered_turn_id IS NULL THEN 0 ELSE 1 END) AS answered FROM ask_ledger WHERE ts >= ? GROUP BY kind').all(sinceMs); const out = {}; for (const r of rows) out[r.kind] = { n: r.n, answered: r.answered }; return out; }
/** Turns since the last learning question for a person (Infinity when none). */
function turnsSinceLastAsk(key = 'owner', { turnIdNow = null } = {}) {
  ensure();
  const r = _handle().prepare("SELECT turn_id FROM ask_ledger WHERE key = ? AND kind = 'learning' ORDER BY id DESC LIMIT 1").get(key);
  if (!r || r.turn_id == null || turnIdNow == null) return Infinity;
  return Math.max(0, Number(turnIdNow) - Number(r.turn_id));
}

/** Facts learned any other way (the personal-fact extractor, his turns) close the gaps they cover and become known. */
function noteFacts(key, texts = [], { now = Date.now() } = {}) {
  const p = get(key); if (!p) return null;
  const facts = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t && (t.content || t.text || t) || '').trim()).filter(Boolean);
  if (!facts.length) return p;
  const gaps = key === 'owner' ? OWNER_GAPS : [];
  let closed = 0;
  const un = p.unknowns.map((u) => { const g = gaps.find((x) => x.id === u.id); if (!u.learned && g && facts.some((f) => g.covers.test(f))) { closed++; return { ...u, learned: true, carried: false }; } return u; });
  const known = [...p.known, ...facts.map((f) => ({ text: f.slice(0, 240), at: now }))].slice(-200);
  _save(key, p.kind, known, un, { now, lastLearned: closed ? now : undefined });
  return get(key);
}

/**
 * Third parties from the encounter stream (a READ of the graph, never a write): every person who entered through
 * conversation since `sinceMs` gets a row with the standing gap, unless a relation claim already names who they
 * are to him. Returns the keys minted. deps.rows: injectable for the smoke.
 */
function sweepThirdParties({ sinceMs = 3600000, now = Date.now(), deps = {} } = {}) {
  let rows = [];
  try {
    rows = deps.rows || _handle().prepare(`SELECT object_key AS key, MAX(object_label) AS label,
        MAX(CASE WHEN claim_key IN ('relation', 'relationship', 'role', 'relation_to_owner') THEN claim_value END) AS relation
      FROM encounters WHERE object_type = 'person' AND source_kind = 'conversation' AND ingested_at >= ? GROUP BY object_key LIMIT 50`).all(now - sinceMs);
  } catch { rows = []; }
  const minted = [];
  for (const r of rows) { if (!r || !r.key) continue; if (get(r.key)) continue; mintThirdParty({ key: r.key, label: r.label || r.key, kind: 'contact', relation: r.relation || null, now }); minted.push(r.key); }
  return minted;
}

/** Everyone she holds a model of, with their open gaps (for the strip and the ledger). */
function all() { ensure(); return _handle().prepare('SELECT key FROM person_model').all().map((r) => get(r.key)); }

module.exports = { ensure, get, seedOwner, mintThirdParty, noteFacts, sweepThirdParties, openGaps, topGap, markAsked, closeGap, ledgerAdd, ledgerPending, ledgerAnswer, ledgerCounts, turnsSinceLastAsk, all, OWNER_GAPS, THIRD_PARTY_GAP, _setDb };
