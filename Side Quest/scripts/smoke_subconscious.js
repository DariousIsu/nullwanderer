/* Smoke: monologue.generateThought — the subconscious routes its THINKING to the cloud reasoner
 * when configured, else falls back to the local front model. Deterministic: complete/streamChat/
 * model/cloud all injected. No network/model.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_subconscious.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_subc_${Date.now()}.db`);
require('../lib/db').init();
const { generateThought } = require('../lib/monologue');
const config = require('../lib/config');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const cloud = { tier: 'cloud', base: 'https://ollama.com', token: 'KEY' };
const msgs = [{ role: 'user', content: 'think about something interesting' }];

(async () => {
  // --- config role ---
  process.env.ZOE_SUBCONSCIOUS_MODEL = 'gpt-oss:120b';
  ok(config.subconsciousModel() === 'gpt-oss:120b', 'subconsciousModel reads ZOE_SUBCONSCIOUS_MODEL');
  delete process.env.ZOE_SUBCONSCIOUS_MODEL;
  ok(config.subconsciousModel() === '', 'subconsciousModel empty when unset (→ local)');

  // --- CLOUD path: subModel + cloud present → uses cloud complete (deep), bumped num_predict ---
  let sawOpts = null, sawModel = null, localCalled = false;
  const cloudComplete = async (o) => { sawOpts = o.options; sawModel = o.model; return 'A deep, novel thought from the cloud reasoner.'; };
  const localStream = async () => { localCalled = true; };
  const r1 = await generateThought({ messages: msgs, options: { num_predict: 200 }, deps: { subModel: 'gpt-oss:120b', cloud, complete: cloudComplete, streamChat: localStream } });
  ok(/deep, novel thought/.test(r1), 'cloud path returns the cloud thought');
  ok(sawModel === 'gpt-oss:120b', 'cloud path uses the subconscious model');
  ok(sawOpts && sawOpts.num_predict >= 700, 'cloud path bumps num_predict (reasoner needs room past its thinking)');
  ok(localCalled === false, 'cloud path does NOT call the local model');

  // --- onUsage: completeDetailed-shaped {text,usage} → onUsage fires with real token counts ---
  let gotUsage = null;
  const r1b = await generateThought({ messages: msgs, options: { num_predict: 200 }, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => ({ text: 'deep cloud thought', usage: { prompt_tokens: 1200, eval_tokens: 500 } }), onUsage: (u) => { gotUsage = u; }, streamChat: async () => {} } });
  ok(/deep cloud thought/.test(r1b), 'onUsage path returns the cloud thought text (object result normalized)');
  ok(gotUsage && gotUsage.prompt_tokens === 1200 && gotUsage.eval_tokens === 500, 'onUsage receives real token usage for budget accounting');

  // --- LOCAL fallback: no subModel → local streamChat ---
  let localOut = false;
  const r2 = await generateThought({ messages: msgs, options: {}, deps: { subModel: '', streamChat: async (o) => { localOut = true; o.onToken('local thought'); } } });
  ok(localOut && /local thought/.test(r2), 'no subModel → local front model');

  // --- LOCAL fallback: cloud configured but DOWN (empty) → local ---
  let fellBack = false;
  const r3 = await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => '', streamChat: async (o) => { fellBack = true; o.onToken('fallback thought'); } } });
  ok(fellBack && /fallback thought/.test(r3), 'cloud empty → local fallback (fail-safe)');

  // --- LOCAL fallback: cloud throws (non-abort) → local ---
  let fb2 = false;
  await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => { throw new Error('cloud 500'); }, streamChat: async (o) => { fb2 = true; o.onToken('x'); } } });
  ok(fb2, 'cloud error → local fallback (no crash)');

  // --- ABORT propagates (snap-back) ---
  let threw = false;
  try { await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } } }); }
  catch (e) { threw = (e.name === 'AbortError'); }
  ok(threw, 'AbortError propagates (snap-back interrupts the thought)');

  // --- SLICE A (2026-07-30): the typed synthesis shape — dynamic, focused, routable ---
  {
    const subc = require('../lib/subconscious');
    const p = subc.buildSynthesisPrompt({ recentThoughts: [{ content: 'a thought' }], threads: [], sources: [], explored: ['the Georgia boards data-upkeep paradox'] });
    ok(/TENSION: /.test(p) && /ACTION: <none \| inquiry \| research \| experiment>/.test(p), 'the prompt demands the typed shape (no essay)');
    ok(/ALREADY EXPLORED/.test(p) && /Georgia boards/.test(p), 'explored tensions ride the prompt — no re-derivation');
    ok(/ACTION: none is the honest answer/.test(p), 'a quiet field is a first-class answer');

    const good = subc.parseSynthesis('TENSION: county data decays faster than any sweep re-validates it.\nWHY: Every roster is stale the day after capture. The map needs a decay model.\nACTION: experiment — a read-only script measuring staleness distribution across captured rosters');
    ok(good && /decays faster/.test(good.tension) && good.action.kind === 'experiment' && /staleness distribution/.test(good.action.text), 'a shaped synthesis parses: tension + why + typed action');
    const bold = subc.parseSynthesis('**TENSION**: X happens more than Y in the ledger rows.\n**WHY**: because of Z reasons entirely.\n**ACTION**: research — how X propagates through Y systems');
    ok(bold && bold.action.kind === 'research', 'markdown-bold labels still parse');
    ok(subc.parseSynthesis('a rambling essay with no shape at all, many words long') === null, 'shapeless output → null (caller keeps the raw thought)');
    const noneAct = subc.parseSynthesis('TENSION: everything here is already explored territory.\nWHY: the field is quiet today for real.\nACTION: none');
    ok(noneAct && noneAct.action.kind === 'none', 'ACTION: none parses as honest quiet');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
