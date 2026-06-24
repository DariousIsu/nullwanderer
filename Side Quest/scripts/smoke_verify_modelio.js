/**
 * Offline smoke for the model-I/O adapters (studio/verify_model_io.js) — the wiring that forces a
 * real model reply into the harness schema. A MOCK `complete` stands in for Ollama. No cloud.
 *
 * Run: node scripts/smoke_verify_modelio.js
 */
const { makeHomeworkCheck, makeClassifier } = require('../studio/verify_model_io');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const mockComplete = (reply) => async () => reply;

(async () => {
  // ---- homework-check parsing ----------------------------------------------------------------
  {
    const samples = [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }];
    const hc = makeHomeworkCheck({ complete: mockComplete('1: yes - on topic\n2: no - login page\n3: yes - relevant') });
    const v = await hc(samples, 'prompt');
    ok('parses N: yes|no - reason → per-uid verdicts', v.length === 3 && v[0].uid === 'a' && v[0].ok === true && v[1].uid === 'b' && v[1].ok === false && v[1].reason === 'login page');
  }
  {
    // model prose around the lines, different separators, missing one item
    const samples = [{ uid: 'x' }, { uid: 'y' }];
    const hc = makeHomeworkCheck({ complete: mockComplete('Here are my checks:\n1. yes — clearly relevant\n(item 2 omitted)') });
    const v = await hc(samples, 'p');
    ok('tolerates prose + alt separators; omits unparsed', v.length === 1 && v[0].uid === 'x' && v[0].ok === true);
  }
  {
    const hc = makeHomeworkCheck({ complete: mockComplete('total garbage, no verdicts here') });
    ok('garbage reply → empty verdicts (preflight fail-safe handles it)', (await hc([{ uid: 'a' }], 'p')).length === 0);
  }

  // ---- classify parsing ----------------------------------------------------------------------
  {
    const c = makeClassifier({ complete: mockComplete('STATUS=VP | NOTE=Source paraphrases the claim accurately.') });
    const r = await c({ claim: 'x', passage: 'y' });
    ok('parses STATUS=CODE | NOTE=… cleanly', r.status_code === 'VP' && /paraphrases/.test(r.note) && r.confidence === 0.8);
  }
  {
    const c = makeClassifier({ complete: mockComplete('verified') });   // synonym, no STATUS= prefix
    const r = await c({ claim: 'x', passage: 'y' });
    ok('maps a bare synonym word to enum', r.status_code === 'V');
  }
  {
    const c = makeClassifier({ complete: mockComplete('I think this is a mismatch, code M applies here.') });
    const r = await c({ claim: 'x', passage: 'y' });
    ok('falls back to a standalone code token', r.status_code === 'M');
  }
  {
    const c = makeClassifier({ complete: mockComplete('no idea, cannot tell at all') });
    const r = await c({ claim: 'x', passage: 'y' });
    ok('unparseable → NK + low confidence (escalation/NK)', r.status_code === 'NK' && r.confidence === 0.2);
  }
  {
    // confirm the adapter actually passes claim+passage into the prompt
    let seen = null;
    const c = makeClassifier({ complete: async ({ messages }) => { seen = messages.map(m => m.content).join('\n'); return 'STATUS=V | NOTE=ok'; } });
    await c({ claim: 'snowpack rose 15%', passage: 'the office reported a 15% rise' });
    ok('claim + passage reach the model prompt', /snowpack rose 15%/.test(seen) && /15% rise/.test(seen));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
