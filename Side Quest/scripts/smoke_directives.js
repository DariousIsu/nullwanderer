/* smoke_directives.js — runtime feedback has somewhere to land, and it stays landed.
 *
 * Lucas, 2026-07-21: "Looks like putting in run time feed back like this never landed."
 *
 * Measured before building, and he was right three times over:
 *   · the only durable self-store was `self_model` — 60 rows, ALL epistemic 'speculated', every one
 *     a preference/insight/taste. Favourite film, favourite book, Ada Lovelace. No category for a
 *     correction existed at all.
 *   · main.js's "correction" path fires only when focus.getCurrent() returns an ACTIVE RESEARCH RUN
 *     and only reshapes that run's meta. Told anything outside a live dossier, nothing was written.
 *   · so there was no capture, no store, and no read-back. Three missing pieces, not one.
 *
 * ⭐ THE LOAD-BEARING DESIGN CHOICE is that a directive is NOT a self_model row. That store is a
 * personality pool: MMR-sampled for diversity, ranked to favour tastes, built to let unreinforced
 * entries fade. All three behaviours are wrong for an instruction — and this system has already
 * turned one of his scope orders into "her belief" and then outgrown it (fixed 92035fa).
 *
 * The other load-bearing property is PRECISION. Over-capture would bury the real instructions in
 * noise, so the tests below spend as much effort on what must NOT be captured as on what must.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('../lib/directives');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── captured: a standing rule about how she works ───────────────────────────────────────────────
{
  const yes = [
    'From now on always use Eastern time when you tell me what time a meeting is.',
    'Never say you have done something before the tool comes back.',
    'Stop putting research notes in the chat, put them on the canvas.',
    'Going forward you should always cite the source for a number.',
    "Don't ever guess at a name you can't place.",
    'Whenever you finish a document, tell me it is ready for packaging.',
    'By default you should build in plain markdown.',
  ];
  for (const s of yes) ok(D.detect(s), `captured: "${s.slice(0, 52)}…"`);
  ok(D.detect('Never say you have done something before the tool comes back.') === 'Never say you have done something before the tool comes back.',
    'stored in HIS words, verbatim — a paraphrased rule is a different rule');
}

// ── ⭐ NOT captured: ordinary conversation ──────────────────────────────────────────────────────
{
  const no = [
    'What time is the Rainey huddle?',                    // a question
    'Can you always use eastern time?',                   // a question, even though it implies one
    'I always drink coffee before the all hands.',        // about HIM
    'We never got the Louisiana rosters finished.',       // about the work, not about her
    'ok thanks',
    'The meeting is over.',
    'That never worked properly.',                        // no behavioural verb aimed at her
    'Josh always runs the budget cohort meeting.',        // about a third party
  ];
  for (const s of no) ok(D.detect(s) === null, `NOT captured: "${s.slice(0, 46)}…"`);
  ok(D.detect('') === null && D.detect(null) === null && D.detect('hi') === null, 'junk and trivia are ignored');
  ok(D.detect('x'.repeat(700)) === null, 'an essay is not a directive');
}

// ── the clause, not the paragraph ───────────────────────────────────────────────────────────────
{
  const r = D.detect('Thanks, that looks right. From now on always cite the source for a number. Anyway, the huddle is Tuesday.');
  ok(r === 'From now on always cite the source for a number.',
    'the INSTRUCTION clause is extracted, not the surrounding chat');
}

// ── ⭐ rendered in full, and framed as HIS, not hers ────────────────────────────────────────────
{
  const rows = [
    { id: 1, rule: 'Always use Eastern time.', created_ts: Date.parse('2026-07-21T14:00:00Z') },
    { id: 2, rule: 'Build in plain markdown and stop.', created_ts: Date.parse('2026-07-21T15:00:00Z') },
  ];
  const b = D.buildBlock({ userName: 'Lucas', rows });
  ok(/STANDING INSTRUCTIONS FROM LUCAS/.test(b), 'the block names whose instructions these are');
  ok(/Always use Eastern time\./.test(b) && /Build in plain markdown and stop\./.test(b), 'every rule is rendered — no sampling');
  ok(/they hold until he says otherwise/.test(b), 'they persist by default');
  ok(/NOT your own preferences and you do not get to outgrow them/.test(b),
    'SAFETY: explicitly not a belief she can outgrow — that is the exact 92035fa failure');
  ok(/if one now seems wrong, say so and ask, do not quietly stop following it/.test(b),
    'and the escape hatch is to ASK, not to silently drop it');
  ok(/July 21, 2026/.test(b), 'each carries its date, in Eastern');
  ok(b.indexOf('Always use Eastern') < b.indexOf('Build in plain markdown'),
    'oldest first, so the newest correction is the last thing she reads');
  ok(D.buildBlock({ rows: [] }) === null, 'no instructions → no block, not an empty header');
}

// ── the store is its own table, not a personality row ───────────────────────────────────────────
{
  const dbsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  ok(/CREATE TABLE IF NOT EXISTS directives/.test(dbsrc), 'directives have their own table');
  ok(/retired_ts/.test(dbsrc), 'and a retirement column');
  ok(/UPDATE directives SET retired_ts/.test(dbsrc) && !/DELETE FROM directives/.test(dbsrc),
    'SAFETY: retire, never DELETE — a cancelled rule is still part of what he has asked for');
  ok(/mentions = mentions \+ 1/.test(dbsrc), 'repeating an instruction reinforces it rather than duplicating');

  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'directives.js'), 'utf8');
  ok(!/self_model/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'SAFETY: directives never touch the personality store');
  // A stray non-ASCII character inside a REGEX has bitten this codebase twice — a Russian word once,
  // a Chinese character in the first draft of _PERSIST here. Em-dashes and bullets in the rendered
  // STRINGS are deliberate, so the check is scoped to the pattern literals, where it actually bites.
  const patterns = src.match(/^const _[A-Z]+ = \/.*$/gm) || [];
  ok(patterns.length >= 3, 'the detector patterns are found for inspection');
  ok(patterns.every((p) => !/[^\x00-\x7F]/.test(p)), 'no stray non-ASCII inside any regex literal');

  const ctx = fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8');
  ok(/require\('\.\/directives'\)\.buildBlock/.test(ctx), 'the block is injected into the prompt');
  ok(/systemContent = dblock \+ '\\n' \+ systemContent/.test(ctx), 'at protocol-level primacy, above awareness');

  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/require\('\.\/lib\/directives'\)\.detect\(userMessage\)/.test(m), 'and capture runs on every turn');
  ok(/\[directive\]/.test(m), 'with a log line — an unmeasured capture is assumed to work');
}

// ── LEG D: the explicit "make this a rule" verb — a correction WITHOUT a persistence marker ──────
{
  ok(D.detectExplicit('make that a rule', { prev: "Don't use em-dashes in op-eds." }) === "Don't use em-dashes in op-eds.",
    'standalone verb promotes the previous correction verbatim');
  ok(D.detect("Don't use em-dashes in op-eds.") === null,
    'and that correction was INVISIBLE to the implicit net — the gap leg D closes');
  ok(D.detectExplicit('New rule: cite every number.') === 'cite every number.',
    'inline "new rule: X" promotes X');
  ok(D.detectExplicit('make it a rule to always verify a quote before you use it') === 'always verify a quote before you use it',
    'inline "make it a rule to X" strips the connective and promotes X');
  ok(D.detectExplicit('add a rule: keep op-eds under 700 words') === 'keep op-eds under 700 words',
    'inline "add a rule: X" promotes X — no behavioural verb required (explicit intent)');
  ok(D.detectExplicit('what time is the huddle?') === null, 'no verb → nothing promoted');
  ok(D.detectExplicit('make that a rule', { prev: null }) === null, 'standalone with no previous message promotes nothing');
  ok(D.detectExplicit('make this a rule?', { prev: null }) === null, 'a bare question is never promoted');
  ok(D.detectExplicit('make it a rule', { prev: 'make it a rule' }) === null, 'the previous message being the verb itself promotes nothing');
  ok(!/[^\x00-\x7F]/.test(String(D._EXPLICIT)), 'the explicit-verb regex is ASCII-only');

  const m2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/detectExplicit\(userMessage, \{ prev:/.test(m2), 'the chat door tries the explicit verb when the implicit net misses');
  ok(/getSessionUserTurns\(sessionId/.test(m2), 'and fetches the previous user turn to promote it');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
