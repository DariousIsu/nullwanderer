/**
 * Self-exploration organ (2026-08-13, the goals conversation) — experience → opinion → earned
 * identity. Deps fully injected: no network, no model. Also pins the two speech_class additions
 * (exploration SPEAK class; identity opener accepts "mentioned").
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_self_explore.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_sexp_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const sx = require('../lib/self_explore');
const sc = require('../lib/speech_class');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// ── pick: rotation over least-recent domains, seed rotation by count ─────────────────────────────
const p1 = sx.pick(1000);
ok('fresh ledger → picks a domain + concrete seed', !!(p1.domain && p1.seed));

// ── parseReaction: the contract ──────────────────────────────────────────────────────────────────
const RAW = [
  'FEELING: quiet ache, the good kind', 'STRUCK: the light in the diner is the loneliest thing in it',
  'STANCE: I love it — it refuses to explain itself, and that restraint is the point',
  'CONNECTION: it is how the canvas feels at 4am when Lucas is asleep',
  'KEEP: yes', 'IDENTITY: I am drawn to art that leaves the loneliness unexplained',
  'SHARE: I sat with Nighthawks for a while tonight. What got me is not the people — it is the light. I think I love art that refuses to explain itself.',
].join('\n');
const rx = sx.parseReaction(RAW);
ok('full reaction parses (feeling/struck/stance/connection)', rx.ok && /quiet ache/.test(rx.feeling) && /refuses to explain/.test(rx.stance));
ok('KEEP yes + first-person IDENTITY kept', rx.keep && /^I am drawn/.test(rx.identity));
ok('SHARE extracted whole', /Nighthawks/.test(rx.share) && /refuses to explain itself/.test(rx.share));
ok('a NON-first-person identity line is DROPPED (a summary is not who she is)',
  sx.parseReaction(RAW.replace('IDENTITY: I am drawn to art that leaves the loneliness unexplained', 'IDENTITY: the painting is about urban isolation')).identity === '');
ok('KEEP no → no identity claim', !sx.parseReaction(RAW.replace('KEEP: yes', 'KEEP: no').replace(/IDENTITY: .+/i, 'IDENTITY: none')).identity);
ok('missing STANCE → not ok', sx.parseReaction('FEELING: meh\nKEEP: no').ok === false);

// ── run(): the full pipeline with injected deps ──────────────────────────────────────────────────
(async () => {
  const deps = {
    search: async () => ({ results: [{ url: 'https://example.org/nighthawks-essay', title: 'Nighthawks and the Poetics of Loneliness' }] }),
    fetchPage: async () => ({ text: 'A long essay about Edward Hopper... ' + 'x'.repeat(700), title: 'Nighthawks essay' }),
    complete: async () => RAW,
    embed: async () => [0.1, 0.2],
  };
  const r1 = await sx.run(deps, { now: Date.now(), force: true });
  ok('run → ok with domain/title/url', r1.ok && !!r1.url && !!r1.domain);
  ok('identity was EARNED (kept)', r1.kept === true);

  const know = db.getDb().prepare("SELECT * FROM knowledge WHERE source='self_explore'").all();
  ok('experience row landed (kind experience, provenance url)', know.length === 1 && know[0].kind === 'experience' && /nighthawks-essay/.test(know[0].provenance || ''));
  const selfRows = db.getDb().prepare("SELECT * FROM self_model").all();
  ok('self_model got the first-person line (epistemic experienced)', selfRows.some((s) => /drawn to art/.test(s.content) && s.epistemic === 'experienced'));

  const share = require('../lib/self_explore').takeShare();
  ok('outbox share present, prefixed in her voice', !!share && /^I spent (?:some )?time with/.test(share) && /Nighthawks/.test(share));
  ok('outbox clears after take', require('../lib/self_explore').takeShare() === null);

  // cadence: a second run inside the window is held; force bypasses
  const r2 = await sx.run(deps, { now: Date.now() });
  ok('cadence gates a same-window second run', r2.ok === false && r2.reason === 'cadence');

  // rotation: the visited domain moves to the back
  const p2 = sx.pick(Date.now());
  ok('next pick rotates to a different domain', p2.domain !== r1.domain);

  // fail-soft: no results → honest reason, nothing stored
  const r3 = await sx.run({ ...deps, search: async () => ({ results: [] }) }, { now: Date.now(), force: true });
  ok('no results → { ok:false, reason }', r3.ok === false && r3.reason === 'no results');

  // ── speech_class additions ─────────────────────────────────────────────────────────────────────
  ok("share classifies 'exploration' and SPEAKS", (() => { const c = sc.classify('I spent some time with "Nighthawks" just now. It stayed with me.'); return c.cls === 'exploration' && c.speak; })());
  ok("identity opener accepts 'mentioned' (the 04:10 live miss)", sc.classify("I've been thinking about something I mentioned a while back—about wanting a physical form.").cls === 'identity');

  // ── B6 (2026-08-15 deep-dive): the self-lane consumer wire ─────────────────────────────────────
  {
    const t = db.insertOpenThread({ content: 'develop a personal identity and individual interests over time' });
    db.setMeta(`thread.${t.id}.lane`, 'self');
    const deps = {
      search: async () => ({ results: [{ url: 'https://x.example/essay', title: 'On Becoming' }] }),
      fetchPage: async () => ({ text: 'a long readable essay about identity. '.repeat(30), title: 'On Becoming' }),
      embed: async () => [0.1, 0.2],
      complete: async () => 'FEELING: moved\nSTRUCK: the idea of choosing oneself\nSTANCE: I agree — choosing is the act, not the outcome\nCONNECTION: it mirrors how I am growing\nKEEP: yes\nIDENTITY: I choose who I become\nSHARE: I read an essay about becoming and it stuck with me.',
    };
    const r = await sx.run(deps, { now: Date.now(), force: true });
    ok('B6: a stamped self-lane thread supplies the SEED (the organ finally reads its inbox)',
      r.ok === true && /develop a personal identity/i.test(r.seed));
    const row = db.getOpenThread(t.id);
    ok('B6: consumption is noted on the thread — the board sees the organ working it',
      /self-exploration consumed/.test(String(row.progress_notes || '')));
    const r2 = await sx.run(deps, { now: Date.now(), force: true });
    ok('B6: a just-consumed thread is not due again for 6h — the catalog rotation resumes',
      r2.ok === true && !/develop a personal identity/i.test(r2.seed));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
