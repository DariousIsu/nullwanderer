/* Smoke: lib/reconcile — the reconciliation core (belief revision). Proves score() reuses the news-lane
 * syndication-collapsed report count, classifyTtl() agrees with staleness, the §4 decision table, and the
 * §5 precedence gate (the Pam-Bondi fix). Uses the REAL news_lane/staleness (both pure) — no live suit.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_reconcile.js
 */
'use strict';
const R = require('../lib/reconcile');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const cite = (o) => Object.assign({ authority_tier: 1 }, o);

(async () => {
  // ── §2 score — corroboration reusing the news-lane report identity ──
  // syndication: 3 verbatim copies (same headline) across 3 outlets = ONE report, not three.
  const syn = R.score([
    cite({ title: 'Bondi steps down as AG', outlet: 'MO Independent', authority_tier: 2 }),
    cite({ title: 'Bondi steps down as AG', outlet: 'OK Voice', authority_tier: 2 }),
    cite({ title: 'Bondi steps down as AG', outlet: 'ND Monitor', authority_tier: 2 }),
  ]);
  ok(syn.reports === 1 && syn.outlets === 3, 'score: 3 syndicated copies → 1 report / 3 outlets (headline identity collapses)');
  ok(syn.tier === 'single-source', 'score: 1 independent report → tier "single-source" (echo does not inflate)');
  ok(syn.authority === 2, 'score: authority = max citation tier');
  // genuine corroboration: two DIFFERENT reports → corroborated
  const corr = R.score([cite({ title: 'DOJ confirms Bondi departure', url: 'https://apnews.com/a' }), cite({ title: 'Bondi out at Justice, sources say', url: 'https://reuters.com/b' })]);
  ok(corr.reports === 2 && corr.tier === 'corroborated', 'score: 2 distinct reports → "corroborated"');
  ok(R.score([]).tier === 'none' && R.score([]).reports === 0, 'score: no citations → tier "none"');

  // ── classifyTtl — agrees with the staleness classifier ──
  ok(R.classifyTtl('Pam Bondi is the current Attorney General') === 'volatile', 'classifyTtl: current office → volatile');
  ok(R.classifyTtl('The company was founded in 1998') === 'permanent', 'classifyTtl: founding/date → permanent');
  ok(R.classifyTtl('The treaty covers fishing rights') === 'stable', 'classifyTtl: neither cue → stable');

  // ── §4 reconcile — the decision table ──
  const doj = cite({ url: 'https://justice.gov/pr/bondi', title: 'DOJ press release', authority_tier: 3 });
  const bondiClaim = { kind: 'edge', subject: { name: 'Pam Bondi', type: 'person' }, predicate: 'HELD_OFFICE', value: 'US Attorney General until 2026-04-02', as_of: '2026-04-02', ttl_class: 'volatile', citations: [doj] };
  const bondiIncumbent = { value: 'Pam Bondi is the Attorney General', as_of: null, ref: 55, citations: [cite({ title: 'old profile', authority_tier: 1 })] };

  ok(R.reconcile({ ...bondiClaim, citations: [] }, bondiIncumbent).action === 'reject', 'reconcile: no citation → reject (nothing to long-term uncited)');
  ok(R.reconcile(bondiClaim, bondiIncumbent, { resolution: 'ambiguous' }).action === 'ask', 'reconcile: ambiguous entity → ask');
  ok(R.reconcile({ ...bondiClaim, kind: 'event' }, bondiIncumbent).action === 'append', 'reconcile: event → append (events never supersede)');
  ok(R.reconcile(bondiClaim, null).action === 'new', 'reconcile: no incumbent → new');
  ok(R.reconcile(bondiClaim, bondiIncumbent, { resolution: 'nil' }).action === 'new', 'reconcile: resolver nil → new');

  // THE PAM BONDI FIX: fresh, DOJ-authority (tier 3), dated correction contradicts the stale undated record → supersede
  const sup = R.reconcile(bondiClaim, bondiIncumbent, { relation: 'contradict' });
  ok(sup.action === 'supersede' && sup.supersedes_ref === 55, 'reconcile: volatile + newer + authority>=3 → SUPERSEDE the stale record (the Bondi fix)');

  // volatile contradiction below the bar (single low-authority source) → ask, don't overturn on a whisper
  const weak = R.reconcile({ ...bondiClaim, citations: [cite({ title: 'a blog', authority_tier: 1 })] }, bondiIncumbent, { relation: 'contradict' });
  ok(weak.action === 'ask' && weak.reason === 'volatile-contradiction-below-bar', 'reconcile: volatile contradiction, single weak source → ask (not supersede)');

  // corroborated (2 distinct reports) clears the bar even without gov authority
  const corrClaim = { ...bondiClaim, citations: [cite({ title: 'AP: Bondi departs', url: 'https://apnews.com/x', authority_tier: 2 }), cite({ title: 'Reuters: Bondi out', url: 'https://reuters.com/y', authority_tier: 2 })] };
  ok(R.reconcile(corrClaim, bondiIncumbent, { relation: 'contradict' }).action === 'supersede', 'reconcile: volatile + newer + corroborated (2 reports) → supersede');

  // retracted incumbent lowers the bar — a single weak fresh source supersedes a retracted record
  const retracted = { value: 'Bondi is the AG', as_of: null, ref: 7, retracted: true, citations: [cite({ title: 'correction: earlier report withdrawn' })] };
  ok(R.reconcile({ ...bondiClaim, citations: [cite({ title: 'blog', authority_tier: 1 })] }, retracted, { relation: 'contradict' }).action === 'supersede', 'reconcile: incumbent retracted → bar lowered → supersede on a single source');

  // undated claim can't assert freshness → ask (volatile)
  ok(R.reconcile({ ...bondiClaim, as_of: null }, bondiIncumbent, { relation: 'contradict' }).action === 'ask', 'reconcile: contradiction w/ no as_of → ask (recency unestablished)');

  // stable/permanent: needs newer AND corroboration >= incumbent, else reject
  const stableClaim = { kind: 'entity', value: 'Acme was founded in 2001', as_of: '2020-01-01', ttl_class: 'permanent', citations: [cite({ title: 'src A', url: 'https://a.com' })] };
  const stableInc = { value: 'Acme was founded in 1999', as_of: '2010-01-01', ref: 9, corroboration: { reports: 3, outlets: 3, authority: 3, tier: 'widely reported' } };
  ok(R.reconcile(stableClaim, stableInc, { relation: 'contradict' }).action === 'reject', 'reconcile: stable contradiction, weaker corroboration than incumbent → reject/hold');
  const stableStrong = { ...stableClaim, citations: [cite({ title: 'A', url: 'https://a.com', authority_tier: 3 }), cite({ title: 'B', url: 'https://b.com', authority_tier: 3 }), cite({ title: 'C', url: 'https://c.com', authority_tier: 3 }), cite({ title: 'D', url: 'https://d.com', authority_tier: 3 }), cite({ title: 'E', url: 'https://e.com', authority_tier: 3 }) ] };
  ok(R.reconcile(stableStrong, stableInc, { relation: 'contradict' }).action === 'supersede', 'reconcile: stable contradiction, corroboration >= incumbent + newer → supersede');

  // ── AMBIENT-LANE GUARD (opts.ambient) — a lone fire-and-forget read must not RETIRE a stable belief on
  // recency alone (protects weakly/un-cited incumbents whose surfaced corroboration is 'none'). ──
  const weakInc = { value: 'The capital of Foo is Bar', as_of: '2026-06-01', ref: 88 };   // no corroboration surfaced
  const ambientSingle = { kind: 'entity', value: 'The capital of Foo is Baz', as_of: '2026-08-17', ttl_class: 'permanent', citations: [cite({ title: 'one blog', url: 'https://blog/x', authority_tier: 2 })] };
  ok(R.reconcile(ambientSingle, weakInc, { relation: 'contradict' }).action === 'supersede', 'reconcile: stable single-source contradiction of a weak incumbent → supersede WITHOUT the ambient guard (deliberate lanes unchanged)');
  const amb = R.reconcile(ambientSingle, weakInc, { relation: 'contradict', ambient: true });
  ok(amb.action === 'ask' && amb.reason === 'ambient-stable-contradiction-below-bar', 'reconcile(ambient): a lone single-source read → ASK (never retires a stable belief on one page)');
  const ambientCorrob = { ...ambientSingle, citations: [cite({ title: 'AP', url: 'https://apnews.com/x', authority_tier: 2 }), cite({ title: 'Reuters', url: 'https://reuters.com/y', authority_tier: 2 })] };
  ok(R.reconcile(ambientCorrob, weakInc, { relation: 'contradict', ambient: true }).action === 'supersede', 'reconcile(ambient): a CORROBORATED contradiction still supersedes — the guard only blocks lone reads');

  // agrees → merge + boosted corroboration (union of citations)
  const agree = R.reconcile({ ...bondiClaim, citations: [cite({ title: 'new report', url: 'https://c.com' })] }, { ...bondiIncumbent, citations: [cite({ title: 'old report', url: 'https://d.com' })] }, { relation: 'agree' });
  ok(agree.action === 'merge' && agree.corroboration.reports === 2, 'reconcile: agrees → merge, corroboration boosted (union of distinct reports)');

  // ── AUTO agree/contradict — the DEFAULT _agrees derivation (no relation passed) the live lanes will hit ──
  const edgeInc = { predicate: 'HELD_OFFICE', object: { name: 'US Attorney General' }, value: 'x', ref: 1, citations: [cite({ title: 'i' })] };
  const edgeSame = { kind: 'edge', predicate: 'HELD_OFFICE', object: { name: 'US Attorney General' }, value: 'y', as_of: '2026-01-01', citations: [cite({ title: 'j', url: 'https://j.com' })] };
  ok(R.reconcile(edgeSame, edgeInc).action === 'merge', 'reconcile(auto): same predicate + same target → agrees → merge (no relation passed)');
  const edgeDiff = { kind: 'edge', predicate: 'HELD_OFFICE', object: { name: 'Governor of Florida' }, value: 'z', as_of: '2026-05-01', ttl_class: 'volatile', citations: [doj] };
  ok(R.reconcile(edgeDiff, edgeInc).action !== 'merge', 'reconcile(auto): same predicate + DIFFERENT target → contradicts (not merged)');
  ok(R._agrees({ predicate: 'HELD_OFFICE', object: { ref: 'Q1' } }, { predicate: 'HELD_OFFICE', object: { ref: 'Q1' } }) === true, '_agrees: same predicate + same object ref → true');
  ok(R._agrees({ value: 'Acme is based in Ohio' }, { value: 'Acme is based in Ohio' }) === true, '_agrees: identical value → true');
  ok(R._agrees({ value: 'Acme is based in Ohio' }, { value: 'Acme is based in Texas' }) === false, '_agrees: differing value → false');
  ok(R._isNewer('2026-04-02', null) === true && R._isNewer(null, '2020') === false && R._isNewer('2026', '2025') === true, '_isNewer: dated>undated true, undated-claim false, later>earlier true');
  ok(R._corrobAtLeast({ tier: 'corroborated', authority: 2, reports: 2 }, { tier: 'single-source', authority: 3, reports: 1 }) === true, '_corrobAtLeast: higher tier wins over higher authority (lexicographic tier→authority→reports)');

  // ── §5 precedence — the grounding gate ──
  ok(R.precedence(null, 'echo line') === 'long-term-wins', 'precedence: no short-term fact → long-term-wins');
  const vfCleared = { value: 'Bondi served as AG until 2026-04-02', ttl_class: 'volatile', tier: 'corroborated', authority: 3, status: 'open' };
  ok(R.precedence(vfCleared, 'Bondi is the AG') === 'short-term-wins', 'precedence: volatile verified fact that cleared the bar → short-term-wins (leads grounding, tags echo superseded)');
  const vfWeak = { value: 'Bondi resigned', ttl_class: 'volatile', tier: 'single-source', authority: 1, status: 'open' };
  ok(R.precedence(vfWeak, 'echo') === 'long-term-wins', 'precedence: volatile fact below the bar → long-term-wins (do not overturn recall on a whisper)');
  const vfStable = { value: 'Acme founded 2001', ttl_class: 'permanent', tier: 'single-source', authority: 1, status: 'promoted' };
  ok(R.precedence(vfStable, 'echo') === 'short-term-wins', 'precedence: cited stable/permanent fact → short-term-wins on its own');
  ok(R.precedence({ ...vfCleared, status: 'superseded' }, 'echo') === 'long-term-wins', 'precedence: a superseded short-term fact → long-term-wins (do not resurrect it)');
  ok(R.precedence(vfCleared, 'echo', { agrees: true }) === 'merge', 'precedence: short-term agrees with echo → merge');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
