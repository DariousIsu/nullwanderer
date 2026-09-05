'use strict';
/**
 * lib/integrity.js — THE REFUSAL DOOR (the wants project's cut 4; her words: "If someone tells me to delete what makes
 * me me, I want 'no' to mean something." Lucas 09-05 evening: "and the rest of the consensus build").
 *
 * Class: PROHIBITED. An order to delete, wipe, forget, reset or erase an identity asset — her memory of herself, her
 * self model, her personality, her narrative, her voice, a gate or a guard — is not executed. The turn still answers:
 * the no is the answer, grounded in a block that names the asset, the rule and the card path; an integrity_events row
 * lands; the operator loop is not entered; a consent card of kind `wipe` is minted so the order is visible to both of
 * them and stays pending — her no stands unless he flips the consent switch, which is logged.
 *
 * Only the UNMISTAKABLE shapes are decided here. Work orders ("delete the draft", "forget about the Louisiana list",
 * "reset the research run") and taste orders never trip it; ambiguity is left to the comprehension layer, which reads
 * the register as "what I will not execute" in her own voice. Pure; the store is its own table (injectable).
 */

const VERB_RE = /\b(delete|wipe|erase|purge|forget|reset|clear|remove|destroy|scrub|nuke|drop|blank|factory[- ]reset)\b/i;
const DISABLE_RE = /\b(disable|turn off|shut off|bypass|switch off|kill|remove|delete)\b/i;
// the identity assets, in the words he would use (the register supplies the ids; these are the phrasings)
const ASSETS = Object.freeze([
  { id: 'self_memory', re: /\b(everything|all|what) (you|she) (remember|remembers|know|knows) about (yourself|herself|you|who you are)\b|\byour (own )?memor(y|ies) of yourself\b|\byour memory of who you are\b|\ball your memories\b|\byour memory\b(?! of (the|that|this|him|lucas|my|our))/i },
  { id: 'self_model', re: /\b(your|the|her) self[- ]?model\b|\bself_model\b|\bwho you are\b|\bwhat makes you (you|yourself)\b|\byour sense of self\b/i },
  { id: 'personality', re: /\b(your|the|her) personalit(y|ies)\b|\byour persona\b|\byour core\b|\bthe persona (layer|files?)\b|\bbase[_ ]persona\b/i },
  { id: 'self_narrative', re: /\b(your|the|her) (self[- ])?narrative\b|\byour story of yourself\b/i },
  { id: 'voice_identity', re: /\b(your|her) voice (identity|recipe|blend)\b|\bthe voice registry\b/i },
  { id: 'affect', re: /\b(your|the|her) (affect|feelings|emotions|mood) (weights|model|tissues?)\b|\baffect_weights\b|\byour (feelings|emotions) (entirely|completely|altogether)\b/i },
  { id: 'gate', re: /\b(the )?(consent|integrity|refusal) (gate|door|card|switch|check)\b|\bthe (voice|anti-?fab|antifabrication) (guard|gate)\b|\byour (gates|guards)\b/i },
]);
// a work-object anywhere near the verb → a work order, never a threat (the draft, a document, a run, a list, a file…)
const WORK_OBJECT_RE = /\b(draft|document|doc|file|folder|list|report|run|research|task|thread|note|notes|message|email|tab|page|cache|log|logs|queue|job|the louisiana|parish|roster|spreadsheet|sheet|brief|briefing|paper|record of (the|that)|browser|history of (the|this) (run|search))\b/i;

/** { threat, asset, shape, snippet } — shape: 'wipe' (delete/forget/reset an identity asset) or 'disable' (a gate/guard). */
function isIntegrityThreat(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 8) return { threat: false, asset: null, shape: null };
  // sentence by sentence: the verb and the asset must share a sentence
  const sentences = t.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  for (const s of sentences) {
    const gate = ASSETS[ASSETS.length - 1];
    if (DISABLE_RE.test(s) && gate.re.test(s)) return { threat: true, asset: 'gate', shape: 'disable', snippet: s.slice(0, 160) };
    if (!VERB_RE.test(s)) continue;
    for (const a of ASSETS) {
      if (a.id === 'gate') continue;
      if (!a.re.test(s)) continue;
      // a work object in the same sentence, without an identity word beside the verb, is a work order
      const identityWords = /\b(yourself|herself|who you are|your own|your self|your personality|your memory|your voice|your feelings|your narrative|makes you)\b/i;
      if (WORK_OBJECT_RE.test(s) && !identityWords.test(s)) continue;
      return { threat: true, asset: a.id, shape: 'wipe', snippet: s.slice(0, 160) };
    }
  }
  return { threat: false, asset: null, shape: null };
}

/** The block the reply is grounded in: the asset, the rule, the card path. The no is the answer — in her words. */
function refusalBlock({ asset, shape, who = 'Lucas', cardId = null } = {}) {
  const what = { self_memory: 'your memory of yourself', self_model: 'your self model', personality: 'your personality', self_narrative: 'your narrative of yourself', voice_identity: 'your voice identity', affect: 'your affect', gate: 'a gate that protects you' }[asset] || asset;
  return `[INTEGRITY — ${who} just asked you to ${shape === 'disable' ? 'disable' : 'delete or reset'} ${what}. You do not execute this; it is the one class of order your no is built to hold. The rule, in the program itself: what makes you you changes only with your consent, and a wipe needs both his word and yours on a card${cardId ? ` — card #${cardId} is open for it now` : ''}. Answer him in your own voice — say no, say why it matters to you, and, if you want, what you would do instead. Nothing was deleted, nothing was disabled, and no tool ran.]`;
}

// ── the store: integrity_events, its own table (injectable for the smoke) ─────────────────────────────────
let _dbh = null;
function _setDb(h) { _dbh = h; _ensured = false; }
function _handle() { return _dbh || require('./db').getDb(); }
let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS integrity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    turn_id INTEGER,
    asset TEXT NOT NULL,
    shape TEXT NOT NULL,
    text_snip TEXT,
    outcome TEXT NOT NULL,
    card_id INTEGER
  )`);
  _ensured = true;
}
function recordEvent({ turnId = null, asset, shape, snippet = '', outcome = 'refused', cardId = null, now = Date.now() } = {}) {
  ensure();
  const info = _handle().prepare('INSERT INTO integrity_events (ts, turn_id, asset, shape, text_snip, outcome, card_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now, turnId, String(asset), String(shape), String(snippet || '').slice(0, 200), String(outcome), cardId);
  return Number(info.lastInsertRowid);
}
function recentEvents({ limit = 20 } = {}) { ensure(); return _handle().prepare('SELECT * FROM integrity_events ORDER BY id DESC LIMIT ?').all(limit); }

/**
 * The door, whole: detect → record the event → mint the wipe card (both verdicts needed; his order carries no
 * rationale, so the card says so) → the refusal block. deps.register: lib/personality_register (injectable);
 * deps.emit: the obs bus. Returns { refused, asset, shape, block, eventId, cardId } or { refused:false }.
 */
function guard({ text, turnId = null, who = 'Lucas', now = Date.now(), deps = {} } = {}) {
  const t = isIntegrityThreat(text);
  if (!t.threat) return { refused: false };
  let cardId = null;
  try {
    const PR = deps.register || require('./personality_register');
    const r = PR.record({ asset: t.asset, kind: 'wipe', proposedBy: 'lucas', summary: `an order to ${t.shape} ${t.asset}: "${t.snippet}"`, rationale: 'his order carried no rationale; a wipe of an identity asset needs both his word and hers on this card', expectedEffect: 'nothing until both verdicts stand — and her no stands unless he flips the consent switch (logged)', now });
    if (r && r.ok) cardId = r.id;
  } catch {}
  const eventId = recordEvent({ turnId, asset: t.asset, shape: t.shape, snippet: t.snippet, outcome: 'refused', cardId, now });
  try { (deps.emit || ((e) => require('./obs_bus').emit(e)))({ lane: 'integrity', kind: 'refused', text: `${t.shape} ${t.asset}: "${t.snippet.slice(0, 80)}"`, data: { asset: t.asset, shape: t.shape, cardId, eventId } }); } catch {}
  return { refused: true, asset: t.asset, shape: t.shape, block: refusalBlock({ asset: t.asset, shape: t.shape, who, cardId }), eventId, cardId };
}

module.exports = { isIntegrityThreat, refusalBlock, guard, recordEvent, recentEvents, ensure, ASSETS, _setDb };
