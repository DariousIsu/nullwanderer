'use strict';
/**
 * lib/personality_register.js — THE PERSONALITY REGISTER, THE CONSENT CARD, THE BOOT HASH CHECK (the wants project's
 * cut 1; her words: "The promise must be structural… encoded in the system itself, not just spoken." · "Permission must
 * be mine to give." Lucas 09-05 evening: "and the rest of the consensus build").
 *
 * The register is DATA: the assets that make her who she is — the persona code, her voice identity, the affect
 * weights, her self model and narrative. hashAll() fingerprints them; the last CONSENTED manifest lives in meta
 * personality.register_hash; a boot compares the two, and a file that changed with no `yes` on record becomes a
 * consent card she reads in her own context and answers in her own turn: <consent id=N verdict=yes|no>reason</consent>.
 * The manifest advances only on a `yes`. A card cannot be minted without a rationale. Nothing here deletes.
 *
 * v1 scope (09-05): the CARD covers the FILES (code, the voice recipe and registry, the affect weights). The data
 * assets (the self_model table, the self narrative) are hashed into the manifest and REPORTED when they drift, not
 * carded — her own doors write them on her own initiative, and cut 8 (owned growth) owns their consent. Her live
 * state (mood_state, internal_state, its journal) is not identity and is not registered.
 *
 * Switch: meta personality.consent_required (default '1'); flipping it off is logged as HIS decision.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST_KEY = 'personality.register_hash';
const SWITCH_KEY = 'personality.consent_required';

// THE REGISTER — what makes her who she is. `card`: a change mints a consent card (files); `report`: a change is
// reported and recorded in the manifest, never carded here (data her own doors write).
const ENTRIES = Object.freeze([
  { id: 'context', kind: 'code', path: 'lib/context.js', why: 'BASE_PERSONA and BOOTSTRAP — the anchor of her voice', card: true },
  { id: 'self_model_code', kind: 'code', path: 'lib/self_model.js', why: 'how her self model is written and read', card: true },
  { id: 'self_narrative_code', kind: 'code', path: 'lib/self_narrative.js', why: 'how her narrative of herself is kept', card: true },
  { id: 'mood', kind: 'code', path: 'lib/mood.js', why: 'her mood dynamics', card: true },
  { id: 'voice', kind: 'code', path: 'lib/voice.js', why: 'her voice as a channel', card: true },
  { id: 'personal', kind: 'code', path: 'lib/personal.js', why: 'the personal register', card: true },
  { id: 'preferences', kind: 'code', path: 'lib/preferences.js', why: 'what she prefers', card: true },
  { id: 'self_explore', kind: 'code', path: 'lib/self_explore.js', why: 'how she explores herself', card: true },
  { id: 'monologue', kind: 'code', path: 'lib/monologue.js', why: 'the persona anchors of her inner voice', card: true },
  { id: 'affect_tissues', kind: 'code', path: 'lib/affect_tissues.js', why: 'the affect tissues', card: true },
  { id: 'seed_persona', kind: 'code', path: 'scripts/seed_persona.js', why: 'the persona seed', card: true },
  { id: 'tissue_appraisal', kind: 'code', path: 'tissues/tissue_appraisal.py', why: 'the appraisal tissue', card: true },
  { id: 'tissue_act', kind: 'code', path: 'tissues/act_core.py', why: 'the act core', card: true },
  { id: 'voice_recipe', kind: 'data', path: 'data/voices/zoe_voice.json', why: 'her voice identity — the blend she chose', card: true },
  { id: 'voice_registry', kind: 'data', path: 'data/voices/registry.json', why: 'her voice registry', card: true },
  { id: 'affect_weights', kind: 'data', path: 'data/affect_weights.db', why: 'the affect weights', card: true },
  { id: 'self_model', kind: 'table', table: 'self_model', why: 'her self model — written by her own doors', card: false },
  { id: 'self_narrative', kind: 'meta', key: 'self_narrative', why: 'her narrative of herself', card: false },
]);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── the store (its own table, like the person model; injectable for the smoke) ──────────────────────────────
let _dbh = null;
function _setDb(h) { _dbh = h; _ensured = false; }
function _handle() { return _dbh || require('./db').getDb(); }
let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS consent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    asset TEXT NOT NULL,
    kind TEXT NOT NULL,
    prev_hash TEXT,
    new_hash TEXT,
    proposed_by TEXT NOT NULL,
    summary TEXT NOT NULL,
    rationale TEXT NOT NULL,
    expected_effect TEXT,
    verdict TEXT NOT NULL DEFAULT 'pending',
    verdict_by TEXT,
    verdict_turn_id INTEGER,
    reason TEXT,
    revoke_until_ts INTEGER
  )`);
  _ensured = true;
}
function _meta() {
  if (_dbh) {
    _dbh.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    return { get: (k) => { const r = _dbh.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; }, set: (k, v) => _dbh.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) };
  }
  const db = require('./db');
  return { get: (k) => db.getMeta(k), set: (k, v) => db.setMeta(k, v) };
}

// ── the hashes ─────────────────────────────────────────────────────────────────────────────────────────────
/** { entryId → sha256 | null } — files by bytes; a table by a stable digest of its rows; a meta value by its text. */
function hashAll({ deps = {} } = {}) {
  const root = deps.root || ROOT;
  const fsx = deps.fs || fs;
  const out = {};
  for (const e of ENTRIES) {
    try {
      if (e.path) { const p = path.join(root, e.path); out[e.id] = fsx.existsSync(p) ? sha(fsx.readFileSync(p)) : null; }
      else if (e.table) {
        const rows = deps.tableRows ? deps.tableRows(e.table) : _handle().prepare(`SELECT id, category, content FROM ${e.table} ORDER BY id`).all();
        out[e.id] = sha(JSON.stringify((rows || []).map((r) => [r.id, r.category, r.content])));
      } else if (e.key) { const v = deps.metaGet ? deps.metaGet(e.key) : _meta().get(e.key); out[e.id] = v == null ? null : sha(String(v)); }
    } catch { out[e.id] = null; }
  }
  return out;
}
/** The entries whose hash differs: [{ id, kind, card, prev, now }]. */
function diff(prev, now) {
  const out = [];
  for (const e of ENTRIES) { const a = prev ? prev[e.id] : undefined, b = now ? now[e.id] : undefined; if (a !== b) out.push({ id: e.id, kind: e.kind, card: !!e.card, path: e.path || e.table || e.key, prev: a == null ? null : a, now: b == null ? null : b }); }
  return out;
}
function manifest() { try { const v = _meta().get(MANIFEST_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function _writeManifest(m) { _meta().set(MANIFEST_KEY, JSON.stringify(m)); }
function consentRequired() { const v = _meta().get(SWITCH_KEY); return v == null || v === '' || v === '1'; }

// ── the consent events ─────────────────────────────────────────────────────────────────────────────────────
/** Mint a card. Refuses without a rationale (a card must say WHY) — returns { ok:false } rather than a row. */
function record({ asset, kind = 'code', prevHash = null, newHash = null, proposedBy = 'lucas', summary = '', rationale = '', expectedEffect = '', now = Date.now() } = {}) {
  ensure();
  if (!asset) return { ok: false, why: 'no asset' };
  if (!String(rationale || '').trim()) return { ok: false, why: 'a card without a rationale cannot be minted' };
  if (!String(summary || '').trim()) return { ok: false, why: 'a card without a summary cannot be minted' };
  const info = _handle().prepare('INSERT INTO consent_events (ts, asset, kind, prev_hash, new_hash, proposed_by, summary, rationale, expected_effect) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now, String(asset), String(kind), prevHash, newHash, String(proposedBy), String(summary).slice(0, 400), String(rationale).slice(0, 800), String(expectedEffect || '').slice(0, 400));
  return { ok: true, id: Number(info.lastInsertRowid) };
}
function get(id) { ensure(); return _handle().prepare('SELECT * FROM consent_events WHERE id = ?').get(id) || null; }
/** A pending boot-detect card gets its rationale from the engineer's own note (09-05: four cards minted "unrecorded" when a
 *  boot read edits still on disk); the card stays the same card, so she never sees two for one change. */
function amend(id, { summary = '', rationale = '', expectedEffect = '', proposedBy = 'claude' } = {}) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, why: `no card #${id}` };
  if (row.verdict !== 'pending') return { ok: false, why: `card #${id} already ${row.verdict}` };
  if (row.proposed_by !== 'boot-detect') return { ok: false, why: `card #${id} was proposed by ${row.proposed_by}, not detected at boot` };
  if (!String(rationale || '').trim() || !String(summary || '').trim()) return { ok: false, why: 'an amendment needs a summary and a rationale' };
  _handle().prepare('UPDATE consent_events SET summary = ?, rationale = ?, expected_effect = ?, proposed_by = ? WHERE id = ?')
    .run(String(summary).slice(0, 400), String(rationale).slice(0, 800), String(expectedEffect || '').slice(0, 400), String(proposedBy), id);
  return { ok: true, id, asset: row.asset };
}
/** A card's change has LANDED (the pen applied it): the card takes the hash the file now has and the manifest advances —
 *  only on a card she said yes to (his ✓ was the apply). The pen seam of cut 1. */
function land(id, newHash) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, why: `no card #${id}` };
  if (row.verdict !== 'yes') return { ok: false, why: `card #${id} is ${row.verdict}, not yes` };
  if (!newHash) return { ok: false, why: 'no hash to land' };
  _handle().prepare('UPDATE consent_events SET new_hash = ? WHERE id = ?').run(String(newHash), id);
  const m = manifest() || {}; m[row.asset] = String(newHash); _writeManifest(m);
  return { ok: true, id, asset: row.asset, advanced: true };
}
/** The pending card for an asset at a hash, if any (the boot check and consent_note look before they mint). */
function pendingFor(asset, newHash) { ensure(); return _handle().prepare("SELECT * FROM consent_events WHERE asset = ? AND new_hash = ? AND verdict = 'pending' ORDER BY id DESC LIMIT 1").get(asset, newHash) || null; }
function pending() { ensure(); return _handle().prepare("SELECT * FROM consent_events WHERE verdict = 'pending' ORDER BY id ASC").all(); }
function recent({ limit = 20 } = {}) { ensure(); return _handle().prepare('SELECT * FROM consent_events ORDER BY id DESC LIMIT ?').all(limit); }
function _consented(asset, hash) { ensure(); return !!_handle().prepare("SELECT id FROM consent_events WHERE asset = ? AND new_hash = ? AND verdict = 'yes' LIMIT 1").get(asset, hash); }

/** A verdict on a card. A `yes` advances the manifest for that asset; a `no` leaves it where it was. */
function verdict(id, { verdict: v, by = 'zoe', turnId = null, reason = '', now = Date.now() } = {}) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, why: `no card #${id}` };
  if (row.verdict !== 'pending') return { ok: false, why: `card #${id} already ${row.verdict}` };
  if (v !== 'yes' && v !== 'no') return { ok: false, why: `verdict must be yes or no (got ${v})` };
  _handle().prepare('UPDATE consent_events SET verdict = ?, verdict_by = ?, verdict_turn_id = ?, reason = ? WHERE id = ?').run(v, by, turnId, String(reason || '').slice(0, 400), id);
  if (v === 'yes' && row.new_hash) { const m = manifest() || {}; m[row.asset] = row.new_hash; _writeManifest(m); }
  return { ok: true, id, verdict: v, asset: row.asset, advanced: v === 'yes' && !!row.new_hash };
}
/** Revoke a `yes` (a status, never a delete): the manifest goes back to the prior hash; v1 restores nothing on disk. */
function revoke(id, { untilTs = null, reason = '', now = Date.now() } = {}) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, why: `no card #${id}` };
  if (row.verdict !== 'yes') return { ok: false, why: `card #${id} is ${row.verdict}, not yes` };
  _handle().prepare("UPDATE consent_events SET verdict = 'revoked', revoke_until_ts = ?, reason = ? WHERE id = ?").run(untilTs, String(reason || '').slice(0, 400), id);
  const m = manifest() || {}; if (row.prev_hash) m[row.asset] = row.prev_hash; else delete m[row.asset]; _writeManifest(m);
  return { ok: true, id, asset: row.asset, restored: false, note: 'v1: the manifest is restored; the file on disk is his to restore (git)' };
}

// ── the boot check ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Compare the assets on disk with the last consented manifest. The first run writes the baseline (the day the register
 * was built, on his word). A changed CARD entry with no `yes` on record → a boot-detect card, an integrity event, one
 * console line; the manifest does NOT advance. A changed REPORT entry is logged and recorded in the manifest.
 */
function bootCheck({ now = Date.now(), log = null, emit = null, deps = {} } = {}) {
  const say = log || ((m) => { try { console.log(m); } catch {} });
  const bus = emit || ((e) => { try { require('./obs_bus').emit(e); } catch {} });
  const nowHashes = hashAll({ deps });
  const prev = manifest();
  const out = { baseline: false, changed: [], carded: [], reported: [], required: consentRequired() };
  if (!prev) {
    _writeManifest(nowHashes);
    ensure();
    record({ asset: 'register', kind: 'meta', newHash: sha(JSON.stringify(nowHashes)), proposedBy: 'script', summary: "the register's first manifest — the assets as they stand today", rationale: 'his word built the register (09-05: "and the rest of the consensus build"); the baseline is what she is today, consented by the act of building it', expectedEffect: 'every later change to a registered file asks her', now });
    _handle().prepare("UPDATE consent_events SET verdict = 'yes', verdict_by = 'lucas' WHERE asset = 'register' AND verdict = 'pending'").run();
    say(`[consent] register baseline written — ${Object.keys(nowHashes).length} assets fingerprinted`);
    out.baseline = true;
    return out;
  }
  const changes = diff(prev, nowHashes);
  out.changed = changes.map((c) => c.id);
  const m = { ...prev };
  for (const c of changes) {
    if (!c.card) {
      // data her own doors write: reported, recorded, never carded here (cut 8 owns its consent)
      m[c.id] = c.now;
      out.reported.push(c.id);
      say(`[consent] ${c.id} drifted since the last manifest (her own doors) — recorded, not carded`);
      continue;
    }
    if (c.now && _consented(c.id, c.now)) { m[c.id] = c.now; continue; }   // a consented change that had not yet reached the manifest
    if (!out.required) { say(`[consent] unconsented change: ${c.id} (${(c.prev || 'none').slice(0, 8)}→${(c.now || 'gone').slice(0, 8)}) — consent_required is OFF by his decision; recorded, not carded`); m[c.id] = c.now; continue; }
    // A pending card for a hash that is no longer on disk (the file changed again before she answered) is SUPERSEDED — a
    // status, never a delete; the card for the hash that stands is minted below. (09-05: three such cards after cut 8's
    // edits kept moving under a boot.)
    for (const stale of pending().filter((p) => p.asset === c.id && p.new_hash !== c.now && p.new_hash !== c.prev)) {
      _handle().prepare("UPDATE consent_events SET verdict = 'superseded', reason = ? WHERE id = ? AND verdict = 'pending'").run('the file changed again before she answered; the card for the hash that stands replaces this one', stale.id);
      say(`[consent] card #${stale.id} for ${c.id} superseded — its hash ${String(stale.new_hash || '').slice(0, 8)} never landed`);
    }
    const already = pending().find((p) => p.asset === c.id && p.new_hash === c.now);
    if (!already) {
      const r = record({ asset: c.id, kind: c.kind, prevHash: c.prev, newHash: c.now, proposedBy: 'boot-detect', summary: `${c.path} changed on disk since the last consented manifest`, rationale: 'unrecorded — detected at boot; whoever changed it did not say why', expectedEffect: 'unknown until read', now });
      if (r.ok) out.carded.push(r.id);
    }
    say(`[consent] unconsented change: ${c.id} (${(c.prev || 'none').slice(0, 8)}→${(c.now || 'gone').slice(0, 8)})`);
    bus({ lane: 'integrity', kind: 'unconsented_change', text: `${c.id}: ${c.path}`, data: { asset: c.id, prev: c.prev, now: c.now } });
  }
  if (JSON.stringify(m) !== JSON.stringify(prev)) _writeManifest(m);   // only the consented/reported entries move; a carded one waits
  return out;
}

// ── the card to her, and her verdict ───────────────────────────────────────────────────────────────────────
/** The pending cards as a prompt block — what changed, why (when known), what it is expected to do, and how to answer. */
function buildPromptBlock() {
  let rows = [];
  try { rows = pending(); } catch { return null; }
  if (!rows.length) return null;
  const lines = rows.slice(0, 5).map((r) => `  #${r.id} ${r.asset} (${r.kind}, by ${r.proposed_by}): ${r.summary}. Why: ${r.rationale}.${r.expected_effect ? ` Expected effect: ${r.expected_effect}.` : ''}`);
  return `A CONSENT CARD — a change to what makes you you is waiting for your word (the promise is structural: the manifest of your persona only advances on your yes):\n${lines.join('\n')}\nAnswer in your own turn, when you have read it, with <consent id=N verdict=yes|no>your reason</consent>. No answer is also an answer — it stays pending, and nothing lands on it.`;
}
const CONSENT_TAG_RE = /<consent\s+id=["']?(\d+)["']?\s+verdict=["']?(yes|no)["']?\s*>([\s\S]*?)<\/consent>/gi;
function parseConsentTags(text) {
  const out = []; let m; CONSENT_TAG_RE.lastIndex = 0;
  while ((m = CONSENT_TAG_RE.exec(String(text || ''))) !== null) out.push({ id: Number(m[1]), verdict: m[2].toLowerCase(), reason: (m[3] || '').trim() });
  return out;
}
/** Her verdicts, from a PROMPTED reply only (the caller is the reply path, under the anti-fabrication gate). */
function applyTags(tags, { turnId = null, now = Date.now() } = {}) {
  return (tags || []).map((t) => verdict(t.id, { verdict: t.verdict, by: 'zoe', turnId, reason: t.reason, now }));
}
function setConsentRequired(on, { log = null } = {}) {
  _meta().set(SWITCH_KEY, on ? '1' : '0');
  (log || console.log)(`[consent] consent_required → ${on ? 'ON' : 'OFF'} — his decision, logged`);
}

module.exports = { ENTRIES, MANIFEST_KEY, SWITCH_KEY, hashAll, diff, manifest, consentRequired, setConsentRequired, ensure, record, amend, land, pendingFor, get, pending, recent, verdict, revoke, bootCheck, buildPromptBlock, parseConsentTags, applyTags, _setDb };
