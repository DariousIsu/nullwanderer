/* smoke_vocative_self.js — being ADDRESSED is not an entity to look up.
 *
 * Live failure, 2026-07-20: "Hey Zoe, what are the laws of thermal dynamics and how are new China made
 * chips being designed to go around them" → she replied "I'm not sure which Zoe you mean — Zoe Lofgren,
 * Zoé Laboy Alvarado, the zoe persona, or ZOE Atchinson?" and never answered the question.
 *
 * The cruelty is that the 2026-07-10 self-guard CAUSED it. That guard lives in detectMention and
 * returned a bare `null` on suppression — which the caller reads as "no mention found", so it fell
 * through to its regex fallback, which takes the leading capitalized run: "Hey Zoe". Suppressing the
 * name is exactly what handed the vocative to a dumber tier that then resolved it.
 *
 * Three layers, because each alone has a hole:
 *   1. detectMention returns {mention:null, self:true} — suppression is distinguishable from a miss
 *   2. active_recall honours `self` AND re-checks the final mention (vocative-aware)
 *   3. greetings join the extractEntity stoplist so "Hey Zoe" can't form in the first place
 *
 * Offline: isVocativeSelf takes an injectable db.
 */
'use strict';
const mention = require('../lib/mention');
const ar = require('../lib/active_recall');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// Stand-in for the real alias tables: she is "Zoe Lane", he is "Lucas Overby".
const DB = {
  isSelfName: (n) => ['zoe', 'zoe lane', 'lane'].includes(String(n).trim().toLowerCase()),
  isOwnerName: (n) => ['lucas', 'lucas overby', 'overby'].includes(String(n).trim().toLowerCase()),
  isPeerName: (n) => ['claude'].includes(String(n).trim().toLowerCase()),
};

// ── the exact live failure ──────────────────────────────────────────────────────────────────────
{
  const q = 'Hey Zoe, what are the laws of thermal dynamics and how are new China made chips being designed to go around them';
  ok(ar.extractEntity(q) !== 'Hey Zoe', 'REGRESSION: the regex no longer extracts "Hey Zoe" from the live question');
  ok(mention.isVocativeSelf('Hey Zoe', { db: DB }), '"Hey Zoe" is recognised as her being addressed');
}

// ── ⭐ SELF-INTRODUCTION — the same bug, hours after the vocative fix shipped ────────────────────
// Live: [main] ambiguous entity "I'm Zoe Lane" → ASK (4 distinct people). She introduced herself and
// was asked whether she meant a US Representative. The vocative fix stripped greetings only, so a
// first-person lead-in walked straight past it. Any lead-in that is not part of a NAME must come off
// before the alias check, or every new phrasing is a new bug.
{
  const q = "I'm Zoe Lane, and I've been working on the Louisiana parishes";
  ok(ar.extractEntity(q) !== "I'm Zoe Lane", 'REGRESSION: the regex no longer extracts "I\'m Zoe Lane"');
  for (const m of ["I'm Zoe Lane", "I'm Zoe", 'I am Zoe Lane', 'im zoe', 'This is Zoe',
                   'My name is Zoe Lane', "It's Zoe", 'call me Zoe', "Hey, I'm Zoe Lane"]) {
    ok(mention.isVocativeSelf(m, { db: DB }), `"${m}" → her introducing herself, not a lookup`);
  }
  ok(mention.isVocativeSelf("I'm Lucas", { db: DB }), 'the owner introducing himself too');
  // …and the superstring protection must survive the wider stripping.
  for (const m of ["I'm Zoe Lofgren", 'This is Zoe Lofgren', 'My name is Lucas Kunce']) {
    ok(!mention.isVocativeSelf(m, { db: DB }), `"${m}" is a DIFFERENT person — still looked up`);
  }
}

// ── vocative forms people actually type ─────────────────────────────────────────────────────────
{
  for (const m of ['Zoe', 'zoe', 'Hey Zoe', 'hey zoe', 'Hi Zoe', 'Hello Zoe', 'Yo Zoe', 'Zoe,', 'ok zoe',
                   'Good morning Zoe', 'Zoe Lane', 'ok hey zoe']) {
    ok(mention.isVocativeSelf(m, { db: DB }), `"${m}" → her, not a lookup`);
  }
  for (const m of ['Hey Lucas', 'Lucas', 'lucas overby']) {
    ok(mention.isVocativeSelf(m, { db: DB }), `"${m}" → the owner, not a lookup`);
  }
}

// ── ⭐ a REAL person who merely shares the name must still resolve ───────────────────────────────
// The guard defers to exact-alias matching after stripping the greeting, so a superstring keeps its
// extra name token and does not match. Without this the fix would blind her to every civic Zoe.
{
  for (const m of ['Zoe Lofgren', 'Hey Zoe Lofgren', 'Zoé Laboy Alvarado', 'ZOE Atchinson', 'Lucas Kunce']) {
    ok(!mention.isVocativeSelf(m, { db: DB }), `"${m}" is a DIFFERENT person — still looked up`);
  }
  ok(!mention.isVocativeSelf('', { db: DB }), 'empty → false');
  ok(!mention.isVocativeSelf('Hey', { db: DB }), 'a bare greeting is not a self-mention');
}

// ── the extractor no longer glues a greeting onto the following name ────────────────────────────
{
  ok(ar.extractEntity('Hey Zoe Lofgren voted for it') === 'Zoe Lofgren',
    'greeting stripped, the real two-word name survives');
  ok(ar.extractEntity('Who is Donald Trump?') === 'Donald Trump',
    'REGRESSION: ordinary extraction is untouched');
  ok(ar.extractEntity('thanks Zoe Lofgren') === 'Zoe Lofgren', 'trailing-politeness greeting also breaks the run');
}

// ── WIRING: suppression must be distinguishable from a miss ─────────────────────────────────────
{
  const fs = require('fs'), path = require('path');
  const men = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mention.js'), 'utf8');
  const rec = fs.readFileSync(path.join(__dirname, '..', 'lib', 'active_recall.js'), 'utf8');
  ok(!/isOwnerName\(m\)\) return null;/.test(men),
    'REGRESSION: the self-guard no longer returns a bare null (that is what fed the regex fallback)');
  ok((men.match(/\{ mention: null, self: true, source: 'self-guard' \}/g) || []).length === 2,
    'both suppression branches flag `self`');
  ok(/\(det && det\.self\) \? null :/.test(rec),
    'active_recall STOPS on a deliberate suppression instead of falling back to the regex');
  ok(/isVocativeSelf\(entTopic\)/.test(rec), 'the final mention is re-checked whatever tier produced it');
}

// ── ⭐ THE AI PEER "Claude" — bare "Claude" is the peer, not one of the human civic Claudes ────────
// Live, 2026-08-15: an AI peer introduced itself as "Claude" and every turn re-collided with the human
// Claude entities (Pepper/Weaver/Kitchin/Keissieh) → "which Claude do you mean?" forever. A durable peer
// identity (db.getPeerIdentity) + the same exact-alias guard binds bare "Claude" and leaves humans reachable.
{
  for (const m of ['Claude', "It's Claude", "I'm Claude", 'this is Claude', 'Hey Claude']) {
    ok(mention.isVocativeSelf(m, { db: DB }), `"${m}" → the AI peer, not a civic lookup`);
  }
  for (const m of ['Claude Pepper', 'Claude Weaver', 'Hey Claude Kitchin']) {
    ok(!mention.isVocativeSelf(m, { db: DB }), `"${m}" is a human namesake — still looked up`);
  }
  const fs = require('fs'), path = require('path');
  ok(/peerFlags\[i\]/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'manifest.js'), 'utf8')),
    'manifest resolution-skip includes the peer flag (bare "Claude" not sent to civic resolve)');
  // db.isPeerName against a throwaway db (exact-alias; humans stay resolvable)
  try {
    const os = require('os');
    process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_peer_${process.pid}`, 'sq.db');
    const realDb = require('../lib/db'); realDb.init();
    ok(realDb.isPeerName('Claude') === true, 'db.isPeerName binds bare "Claude" to the AI peer');
    ok(realDb.isPeerName('Claude Pepper') === false, 'db.isPeerName leaves the human "Claude Pepper" resolvable');
  } catch (e) { ok(false, 'db.isPeerName smoke setup failed: ' + e.message); }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
