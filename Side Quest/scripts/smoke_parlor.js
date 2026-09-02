/**
 * THE PARLOR v1.2 (Lucas 09-01, second word: "just Zoe and the other AIs in there... she can
 * choose to go in based on need... I don't want to talk in there, but I want to watch"). Pins:
 * HER room (lucas holds NO seat — posting as him is refused), the VISIT lifecycle (rest → her
 * reason opens → turn budget → cooldown), the floor rules (resting room has no floor; naming
 * hands it; no self-reply), the Gemini bridge (key in HEADER never URL; PASS = silence;
 * fail-soft; never addresses the host), and the observer wiring (window + canvas, doorbell-only
 * chat lines).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_parlor.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_parlor_${Date.now()}.db`);
require('../lib/db').init();
const parlor = require('../lib/parlor');
const bridge = require('../lib/parlor_gemini');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const T = (arr) => arr.map(([speaker, content]) => ({ speaker, content }));

// ── HER room: the seats ──
ok(parlor.post({ speaker: 'lucas', text: 'hello' }).ok === false && /observes/.test(parlor.post({ speaker: 'lucas', text: 'x' }).why),
  '⭐ lucas holds NO seat — posting as him is refused (his design: watch, not talk)');
ok(parlor.post({ speaker: 'nobody', text: 'hi' }).ok === false, 'unknown speakers refused');
ok(JSON.stringify(parlor.PARTICIPANTS) === JSON.stringify(['zoe', 'claude', 'gemini']), 'the seats: zoe, claude, gemini');

// ── the visit lifecycle ──
ok(parlor.whoMayReply(T([['claude', 'anyone here?']]), null).size === 0, '⭐ a RESTING room has no floor — nobody speaks until Zoe opens a visit');
const v1 = parlor.openVisit({ reason: 'with a research question on her mind' });
ok(v1.ok === true && parlor.visit().open === true, 'she opens a visit with a stated reason');
ok(parlor.openVisit({ reason: 'again' }).ok === false, 'one visit at a time');
ok([...parlor.whoMayReply([], parlor.visit())].join(',') === 'zoe', 'a fresh visit: she opened it, she speaks first');
ok(parlor.post({ speaker: 'zoe', text: 'Evening — I brought a question about funder concentration.', via: 'internal' }).ok === true, 'zoe posts from inside');
ok(parlor.post({ speaker: 'claude', text: 'Good one. Gemini, you have fresher training on that.', via: 'port' }).ok === true, 'claude posts via port');
ok(parlor.visit().turns === 2, 'the visit counts its turns');
{
  const f = parlor.whoMayReply(parlor.transcript(), parlor.visit());
  ok(f.size === 1 && f.has('gemini'), 'naming a participant hands THEM the floor');
}
ok(parlor.whoMayReply(T([['zoe', 'anyone?']]), { open: true, turns: 3 }).has('claude') === true, 'an unaddressed turn opens the floor to the others');
ok(parlor.whoMayReply(T([['zoe', 'anyone?']]), { open: true, turns: 3 }).has('zoe') === false, 'nobody follows their own turn');
ok(parlor.whoMayReply(T([['zoe', 'x']]), { open: true, turns: parlor.VISIT_TURN_BUDGET }).size === 0,
  `⭐ a spent budget (${parlor.VISIT_TURN_BUDGET}) closes the floor — three models can't murmur forever`);
{
  const c = parlor.closeVisit({ why: 'done' });
  ok(c.ok === true && c.turns === 2 && parlor.visit().open === false, 'the visit closes with its count');
  ok(parlor.openVisit({ reason: 'right away' }).ok === false, 'cooldown holds — she does not bounce straight back in');
  ok(parlor.openVisit({ reason: 'later', nowMs: Date.now() + parlor.VISIT_COOLDOWN_MS + 1000 }).ok === true, 'after the cooldown, a new reason opens a new visit');
}
ok(parlor.addressees('Gemini and CLAUDE, welcome').join(',') === 'claude,gemini', 'addressees are word-boundary + case-blind');
ok(parlor.addressees('the geminid meteor shower').length === 0, 'substrings never address (geminid ≠ gemini)');
ok(parlor.active() === true, 'an open visit makes the room live');

// ── the Gemini bridge (injected fetch — offline) ──
(async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Happy to weigh in.' }] } }] }) };
  };
  const turns = T([['zoe', 'gemini, what do you make of it?']]);
  const r = await bridge.maybeReply({ deps: { fetchFn: fakeFetch, apiKey: 'k-test', turns, post: (p) => ({ ok: true, id: 99, ...p }) } });
  ok(r.ok === true && r.posted === true, 'the bridge generates and posts when addressed');
  ok(captured && !/key=/.test(captured.url) && captured.headers['x-goog-api-key'] === 'k-test',
    '⭐ the key rides the HEADER — never the URL');
  ok(/never address him/.test(bridge.PREAMBLE), 'the guest is told the host observes and is never addressed');
  captured = null;
  const r2 = await bridge.maybeReply({ deps: { apiKey: 'k', fetchFn: fakeFetch, turns: T([['gemini', 'my own last word']]) } });
  ok(r2.posted === false && captured === null, 'no floor → no API call');
  const r3 = await bridge.maybeReply({ deps: { apiKey: 'k', turns, fetchFn: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'PASS' }] } }] }) }) } });
  ok(r3.posted === false, 'PASS = honest silence');
  const r4 = await bridge.maybeReply({ deps: { apiKey: '', turns } });
  ok(r4.ok === false && r4.why === 'no key', 'no key → dormant');
  const r5 = await bridge.maybeReply({ deps: { apiKey: 'k', turns, fetchFn: async () => ({ ok: false, status: 429 }) } });
  ok(r5.ok === false && /429/.test(r5.why), 'an API failure is a soft why, never a throw');

  // ── ⭐ the goodbye-loop cures (09-01: gemini answered her farewell in a visit that was already
  // over; her prose goodbye closed nothing, so the floor ping-ponged toward the budget cap) ──
  const r6 = await bridge.maybeReply({ deps: { apiKey: 'k', turns, fetchFn: async () => { throw new Error('must not be called'); }, visit: { open: false } } });
  ok(r6.ok === true && r6.posted === false, '⭐ a resting room has no floor for the bridge — no API call, no reply');
  ok(parlor.FAREWELL_RE.test("I've got what I came for — thanks, you two.") && parlor.FAREWELL_RE.test("I'll head out — thanks for the sanity check"),
    'her real goodbyes match the farewell net (both verbatim shapes from the loop night)');
  ok(parlor.FAREWELL_RE.test("I'm all set here. Thanks for the sanity check and the fix, you two — closing us out now.") && parlor.FAREWELL_RE.test('wrapping this up, thanks'),
    "her THIRD goodbye shape matches too ('closing us out now' slipped the first net and hung a visit open on 429-billed ticks)");
  ok(!parlor.FAREWELL_RE.test('the priority chain with high-confidence phrases is the right shape to keep'),
    'working talk never reads as a farewell');
  const main2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/FAREWELL_RE\.test\(text\)/.test(main2) && /visit CLOSED \(her goodbye\)/.test(main2),
    '⭐ wiring: her prose goodbye CLOSES the visit (and the early return keeps gemini from answering it)');
  ok(/_penGateQuiet\(\)\) return;\s+_parlorBusy/.test(main2.replace(/\/\/[^\n]*/g, '')) || /8th lane in the quiet window/.test(main2),
    'wiring: the parlor tick joins the quiet window — her seat is a cloud-operator run and #4 gated with one mid-flight');

  // ── observer wiring pins ──
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/openParlorWindow/.test(main) && /parlor\.html/.test(main), '⭐ wiring: his observer WINDOW exists ("parlor" opens it)');
  {
    const vm = main.match(/const isPW = (\/.*\/i)\.test\(userMessage\);/);
    const re = vm ? eval(vm[1]) : null;
    ok(re && re.test('parlor') && re.test('open the parlor') && re.test('show me the parlor window') && re.test('see the parlor'),
      '⭐ the window door answers natural phrasings, not just the bare word (his 09-01 catch)');
    ok(re && !re.test('what do you think about the parlor') && !re.test('parlor status') && !re.test('the parlor was nice yesterday'),
      'sentences ABOUT the parlor never hijack — the verb stays a full-match door');
  }
  ok(/openParlorWindow\(\{ quiet: true \}\)/.test(main) && /showInactive/.test(main),
    "⭐ his window AUTO-OPENS when a visit starts — quiet (showInactive, no focus steal): 'purely autonomous usage, I just want to watch'");
  ok(/the same Claude behind your code proposals/.test(main) && /Google's Gemini model, a peer AI/.test(main),
    'she knows WHO sits with her — claude = her engineer, gemini = the outside peer');
  ok(/_parlorFeed\(\{ id: `bell-/.test(main) && !/model: 'parlor', unprompted: 1/.test(main),
    "⭐ v1.3 ISOLATION (his catch: 'all landing in the unprompted channel'): doorbells feed ONLY the window + mirror — no chat turn, no unprompted say, no voice");
  ok(/COALESCE\(p\.seen, 0\) = 0/.test(main) && /q\.status = 'applied' AND q\.title = p\.title/.test(main) && /SET seen = 1 WHERE id = \?'\)\.run\(gf\.id\)/.test(main),
    '⭐ a failure earns ONE visit — consumed at open, and a landed same-title successor ends the story (she re-entered for a settled red)');
  ok(/_parlorFeed\(/.test(main) && /parlor-\$\{turn\.id\}/.test(main), 'wiring: turns feed the window AND the canvas mirror');
  ok(/_parlorDoorbell/.test(main) && /Zoe stepped into the parlor/.test(main) && /visit ended/.test(main),
    'wiring: his chat gets ONLY the doorbell lines, never the transcript');
  ok(/_parlorReason/.test(main) && /parlor\.invite/.test(main), 'wiring: she enters on HER reasons (facet question, failed proposal, his invitation)');
  ok(/holds no seat/.test(main), "wiring: her seat prompt says the room is hers — peers, not reporting");
  ok(/zoe_passes/.test(main) && /her PASS/.test(main), 'wiring: her double-PASS ends the visit — leaving is hers too');
  const port = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/\/parlor\/say/.test(port) && /posts only from inside her own process/.test(port), 'wiring: the port door stands; nobody speaks as zoe from outside');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  ok(/onParlorTick/.test(pre) && /parlorTranscript/.test(pre), 'wiring: the preload bridges feed the observer page');
  ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'parlor.html')), 'wiring: the observer page exists');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
