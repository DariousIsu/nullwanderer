'use strict';
/* smoke_salience.js — the carried salience frame (lib/salience.js), spec docs/CARRIED_SALIENCE_MANIFEST.md.
 * The load-bearing case is the LIVE failure verbatim: "who is the mayor of Shreveport?" → "Tom Arceneaux"
 * → "have we found HIS contact info?" — "his" must DEREFERENCE the Arceneaux coordinate, never mint anew.
 * Pure, injectable store — no db, no cloud. Run: node scripts/smoke_salience.js */
const sal = require('../lib/salience');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', t); } };

// fresh, isolated store per assertion group so sessions never bleed
const S = () => new Map();

// ── the live case: a resolved person becomes the antecedent "his" binds to ──────────────────────────
{
  const store = S();
  sal.fold('sess', [{ coord: 'person:civic/9001', type: 'person', status: 'held', surface: 'Tom Arceneaux', salient: true }], { turn: 1, store });
  const hit = sal.dereference('sess', { type: 'person', store });
  ok(hit && hit.coord === 'person:civic/9001', '"his" (person ref) dereferences the resolved Arceneaux coordinate');
  ok(hit && /Arceneaux/.test(hit.surface), 'the deref carries the real surface, not a placeholder');
}

// ── a reference's own mint + ambiguous + self are NOT antecedents ───────────────────────────────────
{
  const store = S();
  sal.fold('sess', [
    { coord: 'person:short/his', type: 'person', status: 'minted-new', surface: 'his', ref: true },   // a reference's OWN miss
    { coord: 'person:graph/amb', type: 'person', status: 'ambiguous', surface: 'John' },               // no clean referent
    { coord: 'self:zoe/core', type: 'self', status: 'self', surface: 'you' },                          // Zoe is not a "his"/"that"
  ], { turn: 1, store });
  ok(sal.dereference('sess', { type: 'person', store }) === null, 'a reference-miss + ambiguous + self do NOT enter the frame → no false antecedent');
  ok(sal.peek('sess', { store }).length === 0, 'frame stays empty when nothing bindable resolved');
}

// ── a NAMED-but-thin minted entity (named in her reply, not yet in the graph) IS a valid antecedent ──
{
  const store = S();
  sal.fold('sess', [{ coord: 'person:short/tom-arceneaux', type: 'person', status: 'minted-new', surface: 'Tom Arceneaux' }], { turn: 1, store });
  const hit = sal.dereference('sess', { type: 'person', store });
  ok(hit && hit.coord === 'person:short/tom-arceneaux', 'a NAMED minted person (thin coord, real surface) binds "his" — the web-answer case');
}

// ── supersession: a newer person of the same type wins ──────────────────────────────────────────────
{
  const store = S();
  sal.fold('sess', [{ coord: 'person:civic/1', type: 'person', status: 'held', surface: 'Arceneaux' }], { turn: 1, store });
  sal.fold('sess', [{ coord: 'person:civic/2', type: 'person', status: 'held', surface: 'Landry' }], { turn: 2, store });
  const hit = sal.dereference('sess', { type: 'person', store });
  ok(hit && hit.coord === 'person:civic/2', 'most-recent person supersedes the older one (recency)');
}

// ── type compatibility: a person ref does NOT bind a document; artifact ref binds the document ──────
{
  const store = S();
  sal.fold('sess', [{ coord: 'document:graph/44', type: 'document', status: 'held', surface: 'the parish list' }], { turn: 1, store });
  ok(sal.dereference('sess', { type: 'person', store }) === null, 'person ref finds no person → null (honest gap, not the document)');
  const doc = sal.dereference('sess', { type: 'document', store });
  ok(doc && doc.coord === 'document:graph/44', 'artifact ref ("pull that up") binds the salient document coordinate');
}

// ── untyped reference ("it"/"that") takes the most-recent thing on the table ─────────────────────────
{
  const store = S();
  sal.fold('sess', [{ coord: 'org:graph/7', type: 'org', status: 'held', surface: 'Cleco' }], { turn: 1, store });
  const any = sal.dereference('sess', { type: null, store });
  ok(any && any.coord === 'org:graph/7', 'untyped ref binds the most-recent resolved thing regardless of type');
}

// ── recency cap: only the last CAP coordinates survive ──────────────────────────────────────────────
{
  const store = S();
  for (let i = 0; i < sal.CAP + 4; i++) sal.fold('sess', [{ coord: `person:civic/${i}`, type: 'person', status: 'held', surface: `P${i}` }], { turn: i, store });
  const frame = sal.peek('sess', { store });
  ok(frame.length === sal.CAP, `frame evicts beyond the cap (${sal.CAP})`);
  ok(frame[0].coord === `person:civic/${sal.CAP + 3}`, 'the newest is at the front');
  ok(!frame.some((e) => e.coord === 'person:civic/0'), 'the oldest beyond the cap is evicted');
}

// ── repeat coordinate moves to front and bumps hits (a re-mentioned entity stays salient) ───────────
{
  const store = S();
  sal.fold('sess', [{ coord: 'person:civic/1', type: 'person', status: 'held', surface: 'A' }], { turn: 1, store });
  sal.fold('sess', [{ coord: 'person:civic/2', type: 'person', status: 'held', surface: 'B' }], { turn: 2, store });
  sal.fold('sess', [{ coord: 'person:civic/1', type: 'person', status: 'held', surface: 'A' }], { turn: 3, store });   // re-mention A
  const frame = sal.peek('sess', { store });
  ok(frame[0].coord === 'person:civic/1' && frame[0].hits === 2, 're-mentioned entity moves to front + hits increments');
  ok(frame.length === 2, 'a re-mention does not duplicate the coordinate');
}

// ── GRADED ATTENTION (AST, W5 standalone 2026-08-20): activation, not membership ────────────────────
// The old law was two cliffs (30m whole-frame death; recency-only eviction). Now: a one-off mention
// stops binding at roughly the old horizon; a heavily-discussed antecedent SURVIVES past it; the
// whole frame clears only after a 2h discourse reset. Yesterday's "him" still never resolves today.
{
  const store = S();
  const t0 = 1_000_000;
  sal.fold('sess', [{ coord: 'person:civic/1', type: 'person', status: 'held', surface: 'A' }], { turn: 1, now: t0, store });
  const at30m = t0 + sal.MAX_IDLE_MS + 1;
  ok(sal.dereference('sess', { type: 'person', now: at30m, store }) === null, 'a ONE-OFF mention stops binding by ~30m (activation < floor — the old horizon holds for trivia)');
  ok(sal.dereference('sess', { type: 'person', now: t0 + 20 * 60e3, store }) !== null, '…but still binds at 20m (no cliff at the old wall)');

  // a heavily-hit antecedent SURVIVES past the old 30m death line
  const store2 = S();
  for (let i = 0; i < 3; i++) sal.fold('s2', [{ coord: 'person:civic/9', type: 'person', status: 'held', surface: 'Arceneaux', salient: true }], { turn: i, now: t0 + i * 60e3, store: store2 });
  const hot = sal.dereference('s2', { type: 'person', now: t0 + 2 * 60e3 + sal.MAX_IDLE_MS + 5 * 60e3, store: store2 });
  ok(hot && hot.coord === 'person:civic/9', 'a 3-hit salient antecedent STILL binds past the old 30m cliff (graded survival)');

  // the 2h discourse reset is the only whole-frame death now
  const store3 = S();
  sal.fold('s3', [{ coord: 'person:civic/5', type: 'person', status: 'held', surface: 'C' }], { turn: 1, now: t0, store: store3 });
  const afterReset = t0 + sal.HARD_RESET_MS + 1;
  ok(sal.dereference('s3', { type: 'person', now: afterReset, store: store3 }) === null, 'past the 2h discourse reset nothing binds');
  sal.fold('s3', [{ coord: 'person:civic/6', type: 'person', status: 'held', surface: 'D' }], { turn: 2, now: afterReset, store: store3 });
  const frame3 = sal.peek('s3', { store: store3 });
  ok(frame3.length === 1 && frame3[0].coord === 'person:civic/6', 'a fold after the discourse reset clears the stale frame first');

  // eviction beyond the cap drops the LOWEST activation, not the merely-oldest
  const store4 = S();
  for (let i = 0; i < 4; i++) sal.fold('s4', [{ coord: 'person:civic/hot', type: 'person', status: 'held', surface: 'Hot', salient: true }], { turn: i, now: t0 + i * 1000, store: store4 });
  for (let i = 0; i < sal.CAP; i++) sal.fold('s4', [{ coord: `thing:one-off/${i}`, type: 'thing', status: 'held', surface: `T${i}` }], { turn: 10 + i, now: t0 + 60e3 + i * 1000, store: store4 });
  const frame4 = sal.peek('s4', { store: store4 });
  ok(frame4.some((e) => e.coord === 'person:civic/hot'), 'a 4-hit salient antecedent SURVIVES a burst of one-off mentions (activation eviction, not recency)');
  ok(frame4.length === sal.CAP, '…and the cap still holds');

  // activation() itself is monotone in what matters
  const now = t0;
  const fresh1 = { lastTouch: now, hits: 1 };
  const old1 = { lastTouch: now - 25 * 60e3, hits: 1 };
  const old3 = { lastTouch: now - 25 * 60e3, hits: 3 };
  ok(sal.activation(fresh1, now) > sal.activation(old1, now), 'activation: fresher beats staler at equal hits');
  ok(sal.activation(old3, now) > sal.activation(old1, now), 'activation: more hits beat fewer at equal age');
  ok(sal.activation(old1, now) < sal.ACT_FLOOR, 'a 25m-old one-off sits below the binding floor (stale-trivial drops sooner)');
}

// ── session isolation: one session's antecedents never leak into another ────────────────────────────
{
  const store = S();
  sal.fold('a', [{ coord: 'person:civic/1', type: 'person', status: 'held', surface: 'A' }], { turn: 1, store });
  ok(sal.dereference('b', { type: 'person', store }) === null, 'session B cannot dereference session A\'s antecedents');
}

// ── shouldFoldReply: the last assistant reply folds at most once ────────────────────────────────────
{
  const store = S();
  ok(sal.shouldFoldReply('sess', 'reply#1', { store }) === true, 'a new reply key folds once (true)');
  ok(sal.shouldFoldReply('sess', 'reply#1', { store }) === false, 'the same reply key does not re-fold (false)');
  ok(sal.shouldFoldReply('sess', 'reply#2', { store }) === true, 'the next reply key folds again (true)');
  ok(sal.shouldFoldReply('sess', '', { store }) === false, 'an empty key never folds');
}

console.log(`smoke_salience: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
