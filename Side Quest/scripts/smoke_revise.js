/* Smoke: lib/revise — the shared belief-revision pipeline. Proves a Claim routes through reconcile() and,
 * on a writing decision, produces a verified_fact record shaped like learning.js's (so the LIVE precedence
 * gate + retrieval consume it), carrying capturedBy (→ precedence authority), corroboration, and a
 * supersedes_ref (→ promote.js §6). reject/ask write NOTHING. Uses the REAL reconcile (pure). Injected I/O.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_revise.js
 */
'use strict';
const V = require('../lib/revise');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
// a chat/operator citation that counts as one authoritative report
const chatCite = { source_id: 'chat', title: 'operator correction', authority_tier: 3 };
const webCite = (u, t = 2) => ({ url: u, title: u, authority_tier: t });

(async () => {
  // capture what writeFact receives
  const sink = () => { const s = { records: [], decisions: [] }; s.fn = async (rec, dec) => { s.records.push(rec); s.decisions.push(dec); }; return s; };

  // ── NEW — no incumbent → write, correct record shape ──
  const claimNew = { kind: 'edge', subject: { name: 'Pam Bondi' }, predicate: 'HELD_OFFICE', value: 'Pam Bondi served as US Attorney General until 2026-04-02', as_of: '2026-04-02', citations: [chatCite], provenance: 'told', lane: 'chat' };
  let s = sink();
  const rNew = await V.reviseBelief(claimNew, { lookupIncumbent: async () => null, writeFact: s.fn, capturedBy: 'chat-correction' });
  ok(rNew.action === 'new' && rNew.wrote === true, 'reviseBelief: no incumbent → new → writes');
  const rec = s.records[0];
  ok(rec && rec.source === 'verified_fact' && rec.content === claimNew.value && rec.level === 'fact', 'record: verified_fact / content=value / fact level (learning.js shape)');
  ok(rec.provenance.capturedBy === 'chat-correction' && rec.provenance.as_of === '2026-04-02' && rec.provenance.dated === true, 'record: provenance carries capturedBy (→ precedence authority) + as_of + dated');
  ok(rec.provenance.subject_key === 'pam-bondi' && rec.provenance.subject === 'Pam Bondi', 'record: subject + subject_key (the supersede slot)');
  ok(Array.isArray(rec.provenance.citations) && rec.provenance.citations[0].authority_tier === 3, 'record: citations compacted with authority tier');

  // ── SUPERSEDE — incumbent contradicts; a dated, authoritative correction wins; supersedes_ref carried ──
  const incumbent = { value: 'Pam Bondi is the Attorney General', as_of: null, ref: 42, citations: [{ title: 'old profile', authority_tier: 1 }] };
  s = sink();
  const rSup = await V.reviseBelief(claimNew, { lookupIncumbent: async () => incumbent, writeFact: s.fn, capturedBy: 'chat-correction' });
  ok(rSup.action === 'supersede', 'reviseBelief: dated authoritative correction vs stale incumbent → supersede');
  ok(rSup.supersedes === 42 && s.records[0].provenance.supersedes === 42, 'reviseBelief: supersedes_ref = incumbent.ref carried into the record (→ promote.js SUPERSEDES edge)');

  // onSupersede fires on a supersede decision (retire the stale incumbent); NOT on new/merge
  let retiredRef = null;
  const rRetire = await V.reviseBelief(claimNew, { lookupIncumbent: async () => incumbent, writeFact: async () => {}, onSupersede: async (ref) => { retiredRef = ref; }, capturedBy: 'chat-correction' });
  ok(rRetire.action === 'supersede' && rRetire.retired === true && retiredRef === 42, 'reviseBelief: supersede → onSupersede(incumbent.ref) fires (the stale fact is retired — the correction sticks)');
  let calledOnNew = false;
  await V.reviseBelief(claimNew, { lookupIncumbent: async () => null, writeFact: async () => {}, onSupersede: async () => { calledOnNew = true; } });
  ok(!calledOnNew, 'reviseBelief: onSupersede NOT called on a new (non-supersede) decision');

  // lookupIncumbent is called with the subject key
  let sawKey = null;
  await V.reviseBelief(claimNew, { lookupIncumbent: async (k) => { sawKey = k; return null; }, capturedBy: 'x' });
  ok(sawKey === 'pam-bondi', 'reviseBelief: lookupIncumbent invoked with the subject key');

  // ── MERGE — agreeing corroboration boosts (union citations) ──
  const claimAgree = { kind: 'edge', subject: { name: 'Acme' }, predicate: 'BASED_IN', object: { name: 'Ohio' }, value: 'Acme is based in Ohio', as_of: '2026-01-01', citations: [webCite('https://b.com')], provenance: 'read', lane: 'research' };
  const incAgree = { predicate: 'BASED_IN', object: { name: 'Ohio' }, value: 'Acme is based in Ohio', ref: 7, citations: [webCite('https://a.com')] };
  s = sink();
  const rMerge = await V.reviseBelief(claimAgree, { lookupIncumbent: async () => incAgree, writeFact: s.fn, capturedBy: 'directed-research' });
  ok(rMerge.action === 'merge' && rMerge.wrote, 'reviseBelief: agreeing claim → merge → writes');
  ok(s.records[0].provenance.corroboration && s.records[0].provenance.corroboration.reports === 2, 'reviseBelief: merge boosts corroboration (union of distinct reports) into the record');

  // ── REJECT — no citation → write NOTHING ──
  s = sink();
  const rRej = await V.reviseBelief({ ...claimNew, citations: [] }, { lookupIncumbent: async () => null, writeFact: s.fn, capturedBy: 'chat-correction' });
  ok(rRej.action === 'reject' && rRej.wrote === false && s.records.length === 0, 'reviseBelief: no citation → reject → nothing written (the hard invariant)');

  // ── ASK — ambiguous entity → write NOTHING (bias-to-clarify) ──
  s = sink();
  const rAsk = await V.reviseBelief({ ...claimNew, subject: { name: 'Pam Bondi', resolution: 'ambiguous' } }, { lookupIncumbent: async () => null, writeFact: s.fn });
  ok(rAsk.action === 'ask' && rAsk.wrote === false && s.records.length === 0, 'reviseBelief: ambiguous entity → ask → nothing written');

  // ── APPEND — an event claim → write (events cluster, never supersede) ──
  s = sink();
  const rApp = await V.reviseBelief({ kind: 'event', subject: { name: 'DOJ leadership change' }, value: 'AG transition announced', citations: [webCite('https://apnews.com/x')], provenance: 'read', lane: 'news' }, { writeFact: s.fn, capturedBy: 'news' });
  ok(rApp.action === 'append' && rApp.wrote, 'reviseBelief: event → append → writes');

  // ── injection edges: no writeFact → dry-run (record produced, wrote=false); writeFact throws → error ──
  const rDry = await V.reviseBelief(claimNew, { lookupIncumbent: async () => null });
  ok(rDry.action === 'new' && rDry.wrote === false && rDry.record, 'reviseBelief: no writeFact → dry-run (record produced, not written)');
  const rErr = await V.reviseBelief(claimNew, { lookupIncumbent: async () => null, writeFact: async () => { throw new Error('db locked'); } });
  ok(rErr.wrote === false && /db locked/.test(rErr.error || ''), 'reviseBelief: writeFact throws → wrote=false + error surfaced (fail-soft)');

  // ── subjectKeyOf + toVerifiedRecord units ──
  ok(V.subjectKeyOf({ subject: { name: 'Pam Bondi' } }) === 'pam-bondi', 'subjectKeyOf: from subject.name');
  ok(V.subjectKeyOf({ subject: { key: 'custom-slot' } }) === 'custom-slot', 'subjectKeyOf: explicit subject.key wins');
  ok(V.subjectKeyOf({ value: 'Some Bare Value' }) === 'some-bare-value', 'subjectKeyOf: falls back to value');
  const told = V.toVerifiedRecord({ value: 'X', provenance: 'told', citations: [], subject: { name: 'X' } }, { action: 'new' }, { subjectKey: 'x', capturedBy: 'chat-correction' });
  ok(told.provenance.url === 'chat (Lucas)', 'toVerifiedRecord: a "told" claim with no url → url="chat (Lucas)"');
  ok(V.toVerifiedRecord({ value: 'Y', citations: [], subject: {} }, { action: 'new' }, { subjectKey: 'y' }).provenance.dated === false, 'toVerifiedRecord: undated claim → dated=false');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
