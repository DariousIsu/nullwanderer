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

  // --- THE LOCAL-FLOOR BREAKER (2026-08-21, the max-out incident): a BLIP never loads local ---
  // A recent cloud success (or young uptime) means any single failure/empty is a blip → the
  // thought is SKIPPED (''), the 7.6GB local model untouched. Only a sustained outage engages it.
  const mono = require('../lib/monologue');
  mono.__setFloorClock({ bootTs: Date.now(), cloudOkTs: Date.now() });
  let blipLocal = false;
  const rB = await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => '', streamChat: async (o) => { blipLocal = true; o.onToken('x'); } } });
  ok(rB === '' && !blipLocal, 'BREAKER: a cloud BLIP skips the thought — local never loads');
  let blipLocal2 = false;
  await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => { throw new Error('cloud 500'); }, streamChat: async (o) => { blipLocal2 = true; o.onToken('x'); } } });
  ok(!blipLocal2, 'BREAKER: a single cloud error is a blip too — skipped, not localized');
  // Sustained outage (clocks forced past the 10min windows) → the last-resort floor engages.
  mono.__setFloorClock({ bootTs: Date.now() - 11 * 60 * 1000, cloudOkTs: Date.now() - 11 * 60 * 1000 });
  let localOut = false;
  const r2 = await generateThought({ messages: msgs, options: {}, deps: { subModel: '', streamChat: async (o) => { localOut = true; o.onToken('local thought'); } } });
  ok(localOut && /local thought/.test(r2), 'SUSTAINED outage + no subModel → the local floor engages');
  let fellBack = false;
  const r3 = await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => '', streamChat: async (o) => { fellBack = true; o.onToken('fallback thought'); } } });
  ok(fellBack && /fallback thought/.test(r3), 'SUSTAINED outage + cloud empty → the local floor engages (fail-safe kept)');
  let fb2 = false;
  await generateThought({ messages: msgs, options: {}, deps: { subModel: 'gpt-oss:120b', cloud, complete: async () => { throw new Error('cloud 500'); }, streamChat: async (o) => { fb2 = true; o.onToken('x'); } } });
  ok(fb2, 'SUSTAINED outage + cloud error → the local floor engages (no crash)');
  mono.__setFloorClock({ bootTs: Date.now(), cloudOkTs: Date.now() });

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

    // --- SLICE B: identity in, position out ---
    const pid = subc.buildSynthesisPrompt({ recentThoughts: [{ content: 'x' }], identity: 'WHO YOU ARE: values ground-truth over polish' });
    ok(/WHO YOU ARE/.test(pid) && /ANGLE what you notice/.test(pid), 'her live identity rides the synthesis input');
    ok(/POSITION: <optional/.test(pid) && /starting \"I \"/.test(pid), 'the shape invites an optional opinion-shaped stance');
    const withPos = subc.parseSynthesis('TENSION: single-source records stall forever at the gate.\nWHY: authority is weighted nowhere at all.\nACTION: research — how official-record classes should weight corroboration\nPOSITION: I think a .gov roster deserves more trust than the floor gives it');
    ok(withPos && /^I think a \.gov roster/.test(withPos.position), 'a stance starting with I is captured');
    const badPos = subc.parseSynthesis('TENSION: some tension worth naming here.\nWHY: because it matters quite a bit.\nACTION: none\nPOSITION: The data shows an increase of 40%');
    ok(badPos && badPos.position === null, 'a non-opinion POSITION (not "I …") is refused — work-log never colonizes identity');

    // --- SLICE C: the whole board in, anticipation out (Lucas 2026-07-30) ---
    const board = '• OPEN LINES OF INQUIRY (advancing one is the DEFAULT move):\n   - [inquiry #4] Iowa county board data\n• HIS CALENDAR THIS WEEK: Rainey team meeting Tuesday\n• RECENT FAILURES (last 24h): [graph-walk] thin-frontier FAILED 3x';
    const pb = subc.buildSynthesisPrompt({ recentThoughts: [{ content: 'a thought' }], board });
    ok(/THE WHOLE BOARD/.test(pb) && /Rainey team meeting Tuesday/.test(pb), 'the decider\'s manifest rides the synthesis — she reasons over ALL work in flight');
    ok(/not just your latest thoughts/.test(pb), 'the board is framed AGAINST recency bias explicitly');
    ok(/ANTICIPATE/.test(pb) && /LUCAS HAS NOT NOTICED YET/.test(pb), 'the prompt prizes the tension he has NOT seen (anticipating his needs)');
    ok(/about to bite/.test(pb) && /deadline with unfinished work/.test(pb) && /dependency between two of his projects/.test(pb),
      'it names what anticipation looks like: stalled runs, unverified claims, cross-project dependencies');
    ok(/A tension he already knows about is worth little/.test(pb), 'a known tension is explicitly devalued');
    const pnb = subc.buildSynthesisPrompt({ recentThoughts: [{ content: 'x' }] });
    ok(!/THE WHOLE BOARD/.test(pnb) && /ANTICIPATE/.test(pnb), 'no board → the block is absent but the anticipation demand still stands');
    const huge = subc.buildSynthesisPrompt({ recentThoughts: [{ content: 'x' }], board: 'B'.repeat(9000) });
    ok(huge.length < 6000, 'the board is bounded — a big manifest can never blow the synthesis budget');
  }

  // --- ONE OPEN SELF-DIRECTED THREAD (2026-07-30, boot133): paraphrased re-derivations slip the
  // lexical ledger (3 wordings of one Georgia-boards tension, overlap ~0.3 vs 0.6 gate), so the
  // routing throttles behaviorally: while a subc-spawned thread is open, the next spawn defers. ---
  {
    const dbm = require('../lib/db');
    const a = dbm.insertOpenThread({ content: 'Investigate: paraphrase one of the tension' });
    dbm.setMeta(`thread.${a.id}.spawned_from`, 'subc');
    const hit = dbm.getOpenSpawnedThread('subc');
    ok(hit && hit.id === a.id, 'an open subc-spawned thread is visible to the spawn guard');
    ok(!dbm.getOpenSpawnedThread('3617'), 'the guard scopes by source — run-closure spawns do not block subc');
    const c = dbm.insertOpenThread({ content: 'Investigate: a second self-directed angle' });
    dbm.setMeta(`thread.${c.id}.spawned_from`, 'subc');
    dbm.markOpenThreadStatus(a.id, 'stalled');
    const hit2 = dbm.getOpenSpawnedThread('subc');
    ok(hit2 && hit2.id === c.id, 'a stalled (parked) thread stops blocking — throttle is to completion, not failure');
    const umbrella = dbm.insertOpenThread({ content: 'Investigate: the umbrella thread' });
    dbm.mergeOpenThread(c.id, umbrella.id, { reason: 'duplicate phrasing (smoke)' });
    ok(!dbm.getOpenSpawnedThread('subc'), 'a merged (parented) duplicate no longer blocks the next spawn');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
