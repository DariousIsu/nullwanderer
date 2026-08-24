'use strict';
/* smoke_contract_agent.js — CONTRACT AGENT slice 1 (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §5-§6).
 * The wave loop under a SCRIPTED driver: decompose, citation discipline (uncited fill → FLAGGED),
 * chain guard (exact-repeat refused, replan note reaches the next prompt), question expiry → the
 * assumption flag, done-gating (open slots refuse the done-claim), budget stand-down (one blocked
 * surfacing, never a hammer), and parse-failure resilience. */
const path = require('path'), os = require('os'), fs = require('fs');

const dbDir = path.join(os.tmpdir(), `sq_cagent_${process.pid}`);
fs.mkdirSync(dbDir, { recursive: true });
process.env.CONTRACTS_DB_PATH = path.join(dbDir, 'contracts.db');
const store = require('../lib/contract_store');
const ca = require('../lib/contract_agent');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const prompts = [];           // every messages[] the driver saw
const replies = [];           // queue of scripted driver replies
const deps = {
  store,
  complete: async (messages) => { prompts.push(messages); return replies.length ? replies.shift() : '{"plan_summary":"idle","actions":[]}'; },
  internalSearch: async (q) => (/delta forge|community benefits/i.test(q)
    ? '[HELD-SOURCE CONTEXT: - canvas "Community Benefits: Meta & Applied Digital in Louisiana" (tab community_benefits_la — a doc on YOUR canvas): Meta Hyperion 7,500 construction jobs…]'
    : null),
  webSearch: async (q) => (/cleco/i.test(q) ? [{ title: 'KALB — Cleco filing', url: 'https://kalb.example/x', snippet: '756 MW turbine' }] : []),
  quotaCheck: () => ({ allow: true, reason: 'test' }),
  now: () => Date.now(),
};

(async () => {
  // ── parseDriverReply tolerance ────────────────────────────────────────────────────────────────
  ok(ca.parseDriverReply('Sure, here is my plan:\n{"plan_summary":"x","actions":[]}\nthanks').plan_summary === 'x', 'parse survives model preamble/postamble');
  ok(ca.parseDriverReply('{"a":"he said \\"done\\" {ok}"}').a.includes('{ok}'), 'parse survives braces inside strings');
  ok(ca.parseDriverReply('no json at all') === null, 'no JSON → null, no throw');

  // ── contract A: the full arc ──────────────────────────────────────────────────────────────────
  const A = store.openContract({ title: 'LA data-center benefits — 3 cells', askVerbatim: 'fill the three cells with sourced content', topicTokens: ['meta', 'applied', 'digital'] });
  store.postInbox({ contractId: A.contractId, kind: 'steering', text: 'include ratepayer impacts' });

  // wave 1: decompose + first search + a finding
  replies.push(JSON.stringify({ plan_summary: 'decompose and sweep held stores', actions: [
    { action: 'define_slots', slots: [{ slotId: 'richland-jobs', description: 'Richland jobs' }, { slotId: 'rapides-project', description: 'Rapides project' }, { slotId: 'water', description: 'water commitments' }] },
    { action: 'internal_search', query: 'delta forge community benefits' },
    { action: 'surface', kind: 'finding', text: 'the canvas already holds the compilation' },
  ] }));
  let r = await ca.runWave(A.contractId, deps);
  ok(r.ok && r.waveN === 1 && !r.done, 'wave 1 runs');
  ok(prompts[0][0].role === 'system' && /NEVER invent a figure/.test(prompts[0][0].content), 'the charter rides the system message');
  ok(/NONE YET/.test(prompts[0][1].content), 'the empty slot set is named in the prompt');
  ok(/include ratepayer impacts/.test(prompts[0][1].content), 'unapplied steering rides the prompt');
  ok(store.slots(A.contractId).length === 3, 'decompose defined 3 slots');
  ok(store.readInbox(A.contractId).length === 0, 'steering consumed by the wave');
  {
    const w = store.waveLog(A.contractId)[0];
    ok(w.endedTs > 0 && w.actions.some((a) => /internal_search .*YOUR canvas/.test(a)), 'the wave committed with the search observation');
    ok(store.unvoiced().some((o) => o.kind === 'finding'), 'the finding queued for the voicer');
  }

  // wave 2: repeat refused; cited fill lands; uncited fill FLAGS; question blocks its slot
  replies.push(JSON.stringify({ plan_summary: 'fill from held material', actions: [
    { action: 'internal_search', query: 'delta forge community benefits' },
    { action: 'fill_slot', slotId: 'richland-jobs', content: '~7,500 construction jobs at peak', citations: [{ src: 'canvas community_benefits_la', date: 'held' }] },
    { action: 'fill_slot', slotId: 'rapides-project', content: 'a number I remember from training' },
    { action: 'open_question', slotId: 'water', text: 'is the company waterless-cooling claim enough for the water cell?', assumption: 'use it, labeled as a company claim', windowMs: 50 },
  ] }));
  r = await ca.runWave(A.contractId, deps);
  ok(r.ok && r.waveN === 2, 'wave 2 runs');
  {
    const w = store.waveLog(A.contractId)[1];
    ok(w.actions.some((a) => /REFUSED \(exact repeat\)/.test(a)), '⭐ CHAIN GUARD: the exact-repeat search is refused');
    const s = store.slots(A.contractId);
    ok(s.find((x) => x.slotId === 'richland-jobs').status === 'filled', 'the cited fill lands');
    const rp = s.find((x) => x.slotId === 'rapides-project');
    ok(rp.status === 'flagged' && rp.flags.some((f) => f.kind === 'uncited'), '⭐ CITE-OR-FLAG: the uncited fill is FLAGGED, never silently filled');
    ok(s.find((x) => x.slotId === 'water').status === 'blocked_on_question', 'the question blocks its slot');
    ok(store.unvoiced().some((o) => o.kind === 'question'), 'the question surfaced to the voicer');
  }

  // wave 3: done is REFUSED while a slot is blocked; the replan note (from the repeat) rides in
  replies.push(JSON.stringify({ plan_summary: 'try to close', actions: [{ action: 'done' }] }));
  await new Promise((res2) => setTimeout(res2, 60));   // let the question window lapse
  r = await ca.runWave(A.contractId, deps);
  ok(/ANALYZE & REPLAN/.test(prompts[2][1].content), '⭐ the replan note reaches the next wave\'s prompt');
  {
    // expiry ran at wave START, so the blocked slot became flagged-with-assumption BEFORE the plan
    const w3 = store.waveLog(A.contractId)[2];
    ok(w3.actions.some((a) => /expired questions folded/.test(a)), 'the overdue question folded to its assumption at wave start');
    const water = store.slots(A.contractId).find((x) => x.slotId === 'water');
    ok(water.status === 'flagged' && water.flags.some((f) => f.kind === 'assumption'), 'the assumption flag survives on the slot');
    ok(r.done === true && store.getContract(A.contractId).status === 'closing', 'done accepted once every slot is filled/flagged → closing');
    ok(store.unvoiced().some((o) => o.kind === 'milestone' && /honest holes/.test(o.text)), 'the milestone names the honest holes');
  }
  ok((await ca.runWave(A.contractId, deps)).ok === false, 'a closing contract runs no more waves');

  // ── contract B: parse failure is a no-progress wave, not a crash ──────────────────────────────
  const B = store.openContract({ title: 'B', askVerbatim: 'do b' });
  replies.push('I believe the best approach would be to think about it.');
  r = await ca.runWave(B.contractId, deps);
  ok(r.ok && /unparsed/.test(r.outcome), 'an unparseable driver reply commits as an honest no-progress wave');
  replies.push('{"plan_summary":"recover","actions":[]}');
  r = await ca.runWave(B.contractId, deps);
  ok(/ANALYZE & REPLAN/.test(prompts[prompts.length - 1][1].content), 'the parse failure feeds the replan note');

  // ── contract C: budget stand-down, surfaced ONCE ──────────────────────────────────────────────
  const C = store.openContract({ title: 'C', askVerbatim: 'do c', budget: { maxWaves: 1 } });
  replies.push('{"plan_summary":"only wave","actions":[{"action":"define_slots","slots":[{"slotId":"s1","description":"one"}]}]}');
  r = await ca.runWave(C.contractId, deps);
  ok(r.ok && r.waveN === 1, 'contract C spends its one wave');
  r = await ca.runWave(C.contractId, deps);
  ok(!r.ok && /budget exhausted/.test(r.reason), 'the budget cap stands the loop down');
  await ca.runWave(C.contractId, deps);
  const blocked = store.unvoiced().filter((o) => o.contractId === C.contractId && o.kind === 'blocked');
  ok(blocked.length === 1 && /keep going/.test(blocked[0].text), 'the stand-down surfaces ONCE, with the extend offer');

  // ── unknown action + web_search observation shape ─────────────────────────────────────────────
  const D = store.openContract({ title: 'D', askVerbatim: 'do d' });
  replies.push(JSON.stringify({ plan_summary: 'mixed', actions: [
    { action: 'web_search', query: 'cleco turbine' },
    { action: 'launch_missiles' },
  ] }));
  r = await ca.runWave(D.contractId, deps);
  {
    const w = store.waveLog(D.contractId)[0];
    ok(w.actions.some((a) => /web_search .*kalb\.example/.test(a)), 'web results ride the observations');
    ok(w.actions.some((a) => /unknown action/.test(a)), 'an unknown action observes, never crashes');
  }

  // ── contract E: read_held (the boot_p115 snippet limiter, cured live) ─────────────────────────
  const E = store.openContract({ title: 'E', askVerbatim: 'read the held file' });
  deps.readHeld = async (ref) => (ref === 'notes/final.md' ? ('FULL TEXT: $3.6B investment, 200 permanent jobs, mid-2027 opening, waterless cooling. ').repeat(30) : null);
  replies.push(JSON.stringify({ plan_summary: 'read the named deliverable', actions: [
    { action: 'read_held', ref: 'notes/final.md' },
    { action: 'read_held', ref: 'notes/final.md' },
    { action: 'read_held', ref: 'notes/missing.md' },
  ] }));
  r = await ca.runWave(E.contractId, deps);
  {
    const w = store.waveLog(E.contractId)[0];
    ok(w.actions.some((a) => /read_held .*FULL TEXT.*\$3\.6B/.test(a)), '⭐ read_held streams the full document into the observations');
    ok(w.actions.some((a) => /already read/.test(a)), 'a re-read of the same ref is refused (chain-guarded)');
    ok(w.actions.some((a) => /EMPTY \(no such held item\)/.test(a)), 'a missing ref observes EMPTY honestly');
    ok(w.actions.find((a) => /FULL TEXT/.test(a)).length > 900, 'the read observation gets the BIG cap — the snippet limiter is gone');
    // and the big read survives into the NEXT prompt un-shrunk (the second half of the limiter)
    replies.push('{"plan_summary":"idle","actions":[]}');
    await ca.runWave(E.contractId, deps);
    const p2 = prompts[prompts.length - 1][1].content;
    ok(/\$3\.6B/.test(p2) && p2.match(/FULL TEXT[\s\S]{800,}/), 'the read rides into the next wave\'s prompt at the big cap, not the 300-char trim');
  }

  // ── contract F: the off-instance fill guard (boot_p118 wave 4, live catch) ────────────────────
  const F = store.openContract({ title: 'Good Neighbor community punch list', askVerbatim: 'Louisiana facilities community benefits', topicTokens: ['louisiana', 'community'] });
  store.upsertSlot({ contractId: F.contractId, slotId: 'regional', description: 'regional benefits, cited' });
  deps.stateCodes = { louisiana: 'LA', 'north dakota': 'ND', texas: 'TX' };
  replies.push(JSON.stringify({ plan_summary: 'fill from held', actions: [
    { action: 'fill_slot', slotId: 'regional', content: 'Applied Digital funds workforce programs in Ellendale, North Dakota, plus Jamestown infrastructure.', citations: [{ src: 'notes/applied_digital_FINAL.md', date: 'held' }] },
  ] }));
  r = await ca.runWave(F.contractId, deps);
  {
    const s = store.slots(F.contractId).find((x) => x.slotId === 'regional');
    ok(s.status === 'flagged' && s.flags.some((f) => f.kind === 'off-instance' && /north dakota/.test(f.text)), '⭐ OFF-INSTANCE GUARD: a cited NORTH DAKOTA fill on a LOUISIANA contract lands FLAGGED, never filled');
    ok(store.waveLog(F.contractId)[0].actions.some((a2) => /REFUSED off-instance/.test(a2)), 'the refusal is observed for the next wave');
  }
  replies.push(JSON.stringify({ plan_summary: 'fill louisiana', actions: [
    { action: 'fill_slot', slotId: 'regional', content: 'In Louisiana: Delta Community College workforce programs and parish road/water improvements.', citations: [{ src: 'canvas:community_benefits_la', date: 'held' }] },
  ] }));
  r = await ca.runWave(F.contractId, deps);
  ok(store.slots(F.contractId).find((x) => x.slotId === 'regional').status === 'filled', 'the RIGHT-state fill lands normally');
  delete deps.stateCodes;

  // ── contract R: THE LA REMATCH CURES (08-24 live: 16 waves, zero fills, zero surfacings) ──────
  const R = store.openContract({ title: 'Rematch cures', askVerbatim: 'fill the cell', topicTokens: ['richland'], budget: { maxWaves: 20 } });
  store.upsertSlot({ contractId: R.contractId, slotId: 'cell', description: 'the cell' });
  const JUNK = [
    { title: 'About Meta | Social Technology', url: 'https://www.meta.com/about/', snippet: 'Learn more about Meta and social technology' },
    { title: 'Applied | Homepage', url: 'https://www.applied.com/', snippet: 'At Applied we are proud of our rich heritage' },
  ];
  const depsR = { ...deps, webSearch: async () => JUNK, internalSearch: async () => null, readHeld: async (ref) => (/^doc#7$/.test(ref) ? 'Meta Richland compilation\n7500 construction jobs, $43M sales-tax surge' : null) };
  // R3a: junk results are EMPTY for the guard and labeled JUNK for the driver
  replies.push(JSON.stringify({ plan_summary: 'search 1', actions: [{ action: 'web_search', query: 'Meta Richland Parish Louisiana community benefits' }] }));
  r = await ca.runWave(R.contractId, depsR);
  {
    const w = store.waveLog(R.contractId).slice(-1)[0];
    ok(w.actions.some((a2) => /JUNK \(brand-nav: 2 results, none carry 2\+ query terms/.test(a2)), '⭐ R3a: brand-nav junk is DETECTED and labeled — never read as progress');
  }
  // R3b: a repeat read serves the cached prior text instead of refusing
  replies.push(JSON.stringify({ plan_summary: 'read', actions: [{ action: 'read_held', ref: 'doc#7' }] }));
  await ca.runWave(R.contractId, depsR);
  replies.push(JSON.stringify({ plan_summary: 'read again', actions: [{ action: 'read_held', ref: 'doc#7' }] }));
  await ca.runWave(R.contractId, depsR);
  {
    const w = store.waveLog(R.contractId).slice(-1)[0];
    ok(w.actions.some((a2) => /\[cached — this item was read in wave \d+/.test(a2) && /7500 construction jobs/.test(a2)), '⭐ R3b: an already-read item SERVES its cached text — held material never looks unavailable');
  }
  // R3c: three no-progress hops surface ONE blocked post (the read reset the streak; junk it back up)
  replies.push(JSON.stringify({ plan_summary: 'search 2', actions: [{ action: 'web_search', query: 'Richland Parish Louisiana teacher bonuses meta' }] }));
  await ca.runWave(R.contractId, depsR);
  replies.push(JSON.stringify({ plan_summary: 'search 3', actions: [{ action: 'web_search', query: 'Rapides Parish Louisiana applied digital campus' }] }));
  await ca.runWave(R.contractId, depsR);
  replies.push(JSON.stringify({ plan_summary: 'search 4', actions: [{ action: 'web_search', query: 'Louisiana parish cleco entergy ratepayer meta' }] }));
  await ca.runWave(R.contractId, depsR);
  {
    const blocked = store.unvoiced().filter((o) => o.contractId === R.contractId && o.kind === 'blocked');
    ok(blocked.length === 1 && /no slot has moved/.test(blocked[0].text), '⭐ R3c: the stall watchdog surfaces ONE blocked post — a starving contract is never silent');
    replies.push(JSON.stringify({ plan_summary: 'fill it', actions: [{ action: 'fill_slot', slotId: 'cell', content: 'Richland: 7500 construction jobs', citations: [{ src: 'doc#7', date: 'held' }] }] }));
    await ca.runWave(R.contractId, depsR);
    ok(store.getContract(R.contractId).agent.stallBlockedPosted === false, 'slot progress clears the stall episode');
  }
  // R4: the promised extension door — post-exhaustion steering extends the budget
  const X = store.openContract({ title: 'Budget door', askVerbatim: 'one cell', topicTokens: ['door'], budget: { maxWaves: 1 } });
  store.upsertSlot({ contractId: X.contractId, slotId: 'c1', description: 'c1' });
  replies.push(JSON.stringify({ plan_summary: 'spend the budget', actions: [] }));
  await ca.runWave(X.contractId, deps);
  r = await ca.runWave(X.contractId, deps);
  ok(!r.ok && /budget exhausted/.test(r.reason) && store.unvoiced().some((o) => o.contractId === X.contractId && o.kind === 'blocked' && /keep going/.test(o.text)), 'budget spent → ONE blocked post, stand down');
  store.postInbox({ contractId: X.contractId, kind: 'steering', text: 'keep going' });
  replies.push(JSON.stringify({ plan_summary: 'extended wave', actions: [] }));
  r = await ca.runWave(X.contractId, deps);
  ok(r.ok && r.waveN === 2, '⭐ R4: post-exhaustion steering EXTENDS the budget — the promised door is real');
  ok(store.getContract(X.contractId).budget.maxWaves === 7 && store.unvoiced().some((o) => o.contractId === X.contractId && /budget extended to 7/.test(o.text)), 'the extension is stored and surfaced');

  // ── R7: the fuel verbs (news_search + web_read — the organs that carried the existence proof) ──
  ok(/news_search for dated coverage/.test(ca.CHARTER) && /"action":"news_search"/.test(ca.CHARTER) && /"action":"web_read"/.test(ca.CHARTER), 'R7: the charter teaches the junk→news_search→web_read strategy');
  const N = store.openContract({ title: 'Fuel verbs', askVerbatim: 'fill it', topicTokens: ['richland'], budget: { maxWaves: 20 } });
  store.upsertSlot({ contractId: N.contractId, slotId: 'cell', description: 'the cell' });
  const depsN = { ...deps,
    newsSearch: async (q) => (/richland/i.test(q) ? '[{"title":"Meta breaks ground in Richland Parish","url":"https://kalb.example/meta","date":"2026-07-24"}]' : '[]'),
    webRead: async (url) => (/kalb\.example/.test(url) ? 'KALB — Meta will fund 10 power plants; $43M sales-tax surge across NE Louisiana.' : null),
  };
  replies.push(JSON.stringify({ plan_summary: 'news then read', actions: [
    { action: 'news_search', query: 'Meta Richland Parish' },
    { action: 'web_read', url: 'https://kalb.example/meta' },
  ] }));
  await ca.runWave(N.contractId, depsN);
  {
    const w = store.waveLog(N.contractId).slice(-1)[0];
    ok(w.actions.some((a2) => /news_search "Meta Richland Parish" → .*breaks ground/.test(a2)), '⭐ R7a: news_search rides the wave (the tool that carried the existence proof)');
    ok(w.actions.some((a2) => /web_read https:\/\/kalb\.example\/meta → KALB — Meta will fund/.test(a2)), '⭐ R7b: web_read fetches the named page text');
  }
  replies.push(JSON.stringify({ plan_summary: 'empty news', actions: [{ action: 'news_search', query: 'nothing here' }] }));
  await ca.runWave(N.contractId, depsN);
  ok(store.waveLog(N.contractId).slice(-1)[0].actions.some((a2) => /news_search .*EMPTY \(try a simpler/.test(a2)), 'an empty news result is honestly EMPTY, with guidance');

  // ── R8: the slot-motion watchdog (waves 17-22 live: successful reads, zero motion, silence) ────
  const M = store.openContract({ title: 'Motion watchdog', askVerbatim: 'fill it', topicTokens: ['motion'], budget: { maxWaves: 20 } });
  store.upsertSlot({ contractId: M.contractId, slotId: 'cell', description: 'the cell' });
  const depsM = { ...deps, internalSearch: async () => 'HELD: some kin material (non-empty every time)' };
  for (let i = 1; i <= 4; i++) {
    replies.push(JSON.stringify({ plan_summary: `browse ${i}`, actions: [{ action: 'internal_search', query: `kin material angle ${i}` }] }));
    await ca.runWave(M.contractId, depsM);
  }
  {
    const blocked = store.unvoiced().filter((o) => o.contractId === M.contractId && o.kind === 'blocked');
    ok(blocked.length === 1, '⭐ R8: 4 motionless waves surface blocked EVEN when every retrieval succeeds (motion is the signal, not emptiness)');
  }

  try { store.close(); fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_contract_agent: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('SMOKE CRASHED:', e); process.exitCode = 1; });
