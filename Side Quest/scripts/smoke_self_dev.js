/* Smoke: lib/self_dev — developmental self-knowledge (self-awareness Layer 2).
 * Deterministic: store + ledger lookup injected, no model/DB. Guards: dev-question detection,
 * dated changelog storage under source 'self_dev', recency recall, and the "don't invent beyond
 * this" context block.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_dev.js
 */
const sd = require('../lib/self_dev');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- detectDevQuestion: positives ---
  ok(sd.detectDevQuestion('what have you been working on?'), 'what have you been working on → fires');
  ok(sd.detectDevQuestion("what's new with you"), "what's new with you → fires");
  ok(sd.detectDevQuestion('how have you changed lately'), 'how have you changed → fires');
  ok(sd.detectDevQuestion('what can you do now'), 'what can you do now → fires');
  ok(sd.detectDevQuestion('what has been done to your program'), 'what has been done to your program → fires');
  ok(sd.detectDevQuestion('have your capabilities improved'), 'capabilities improved → fires');

  // --- detectDevQuestion: negatives (no self-ref or no dev term) ---
  ok(!sd.detectDevQuestion('what are you reading'), 'what are you reading → does NOT fire');
  ok(!sd.detectDevQuestion('what is the price of oil'), 'live-info → does NOT fire');
  ok(!sd.detectDevQuestion('what changed in the bill'), 'change about a BILL (not her) → does NOT fire');
  ok(!sd.detectDevQuestion('how are you feeling'), 'social → does NOT fire');

  // --- record: dated changelog under source 'self_dev' ---
  const calls = [];
  const storeFn = async (rec) => { calls.push(rec); return { action: 'add', id: calls.length }; };
  await sd.record('I can now answer live web questions in the same reply', { date: '2026-06-28', storeFn });
  ok(calls.length === 1 && calls[0].source === 'self_dev', "stored under source 'self_dev'");
  ok(/^2026-06-28 — I can now answer/.test(calls[0].content), 'content is dated (changelog form)');
  ok(calls[0].kind === 'reference' && calls[0].importance >= 0.8, 'stored as high-importance reference');
  const tooShort = await sd.record('x', { storeFn });
  ok(tooShort === null && calls.length === 1, 'too-short summary stores nothing');

  // --- recentEntries: newest-first, injectable lookup ---
  const ledger = [
    { content: '2026-06-28 — calibrated honesty', created_ts: 3 },
    { content: '2026-06-28 — personal-fact memory', created_ts: 2 },
    { content: '2026-06-27 — verified facts', created_ts: 1 }
  ];
  const getFn = (src) => (src === 'self_dev' ? ledger : []);
  const recent = sd.recentEntries(2, { getFn });
  ok(recent.length === 2 && /calibrated honesty/.test(recent[0].content), 'recentEntries returns newest-first, limited');

  // --- buildBlock: real-history framing + anti-invention rail; null on empty ---
  const block = sd.buildBlock(ledger, 'Lucas');
  ok(/WHAT HAS RECENTLY BEEN BUILT INTO YOU/.test(block), 'block headers real development history');
  ok(/Do NOT invent capabilities or changes beyond/i.test(block), 'block forbids inventing beyond the list');
  ok(/calibrated honesty/.test(block) && /verified facts/.test(block), 'block lists the actual entries');
  ok(sd.buildBlock([], 'Lucas') === null, 'empty ledger → null block');

  // --- syncFromGit: the M2.5.3 feeder (all deps injected — no git, no db) ---
  const gitLines = [
    'cccc333\t2026-08-06\tfeat(self-ops): M2.5.2 exhaust access',
    'bbbb222\t2026-08-06\tfix(turn+identity): the bond-yield morning',
    'aaaa111\t2026-08-05\tdocs(plan): tidy the milestone notes',
  ].join('\n');
  const meta = {};
  const recd = [], cladd = [];
  const deps = {
    getMetaFn: (k) => meta[k], setMetaFn: (k, v) => { meta[k] = v; },
    recordFn: async (s, o) => { recd.push(`${(o && o.date) || ''} ${s}`); },
    changelogAddFn: (s) => { cladd.push(s); return true; },
  };
  let seenArgs = null;
  // first run: no last-seen → bounded backfill, ledger only, newest hash stamped
  let r = await sd.syncFromGit({ ...deps, execFileFn: async (args) => { seenArgs = args; return gitLines; } });
  ok(r.filed === 3 && meta['selfdev.git_last_seen'] === 'cccc333', 'first run files the backfill and stamps the newest hash');
  ok(seenArgs.includes('-n') && !seenArgs.some((a) => /\.\.HEAD$/.test(a)), 'first run uses a bounded window, not a range');
  ok(recd[0].startsWith('2026-08-05') && recd[2].startsWith('2026-08-06'), 'entries file oldest-first (a chronological ledger)');
  ok(cladd.length === 0, 'a backfill never floods the capability log');
  // second run: range from the stamp; feat/fix reach the capability log, docs does not
  recd.length = 0;
  r = await sd.syncFromGit({ ...deps, execFileFn: async (args) => { seenArgs = args; return gitLines; } });
  ok(seenArgs.some((a) => a === 'cccc333..HEAD'), 'second run ranges from the stamped hash');
  ok(cladd.length === 2 && cladd.every((s) => /^(feat|fix)/.test(s)), 'only feat/fix subjects reach the capability log');
  // a broken stamp (git rejects the range) falls back to the bounded window instead of filing nothing forever
  cladd.length = 0; recd.length = 0;
  let gitCalls = 0;
  r = await sd.syncFromGit({ ...deps, execFileFn: async (args) => { gitCalls++; if (args.some((a) => /\.\.HEAD$/.test(a))) throw new Error('bad revision'); return gitLines; } });
  ok(gitCalls === 2 && r.filed === 3 && cladd.length === 0, 'an unresolvable stamp falls back to backfill (ledger only)');
  // total git failure files nothing and stamps nothing
  const meta2 = {};
  r = await sd.syncFromGit({ ...deps, getMetaFn: (k) => meta2[k], setMetaFn: (k, v) => { meta2[k] = v; }, execFileFn: async () => { throw new Error('git gone'); } });
  ok(r.filed === 0 && !meta2['selfdev.git_last_seen'], 'git failure → nothing filed, nothing stamped');
  // empty range (no new commits) files nothing
  r = await sd.syncFromGit({ ...deps, execFileFn: async () => '' });
  ok(r.filed === 0, 'no new commits → nothing filed');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
