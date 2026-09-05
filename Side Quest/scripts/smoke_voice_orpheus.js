// smoke_voice_orpheus — her voice since 2026-09-05 ("the zoe voice is the one, switch her over"): the engine
// selector, the mark → tag mapping, the raw request shape, the resident decoder protocol (a fake child), the
// fallback to Kokoro when Ollama is down, and the speech manager's Orpheus path. No model, no network.
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ROOT = path.join(__dirname, '..');
const tts = require(path.join(ROOT, 'lib', 'tts'));
const vo = require(path.join(ROOT, 'lib', 'voice_orpheus'));

// ── the engine selector ──────────────────────────────────────────────────────────────────────────────
delete process.env.ZOE_VOICE_MODEL;
ok(['orpheus', 'kokoro'].includes(tts.engine()), `engine() answers a known engine (${tts.engine()})`);
process.env.ZOE_VOICE_MODEL = 'kokoro'; ok(tts.engine() === 'kokoro', 'ZOE_VOICE_MODEL=kokoro is the way back');
process.env.ZOE_VOICE_MODEL = 'orpheus'; ok(tts.engine() === 'orpheus', 'ZOE_VOICE_MODEL=orpheus');
process.env.ZOE_VOICE_MODEL = 'bogus'; ok(['orpheus', 'kokoro'].includes(tts.engine()), 'an unknown value never breaks the selector');
delete process.env.ZOE_VOICE_MODEL;

// ── marks → the model's own tags ─────────────────────────────────────────────────────────────────────
const prepared = tts.prepareText('<tone warm/> Well then. <laugh/> You already know that. <sigh/> I suppose we could… <breath/> <hmm/> Fine, <chuckle/> maybe.');
const mapped = tts.marksToOrpheus(prepared);
ok(!/⟦/.test(mapped), `no private marker survives (${JSON.stringify(mapped)})`);
ok(/<laugh>/.test(mapped) && /<sigh>/.test(mapped) && /<chuckle>/.test(mapped), 'laugh, sigh, chuckle become the model\'s tags');
ok(!/<breath>/.test(mapped) && !/<tone/.test(mapped) && !/warm/.test(mapped), 'a breath and a tone leave no tag (the model breathes; no speed knob)');
ok(/Hmm\./.test(mapped), 'hmm becomes the word');
ok(/Well then\. <laugh> You already know that\./.test(mapped), `the tags sit where she put them (${mapped.slice(0, 60)}…)`);
ok(tts.marksToOrpheus('Plain words.') === 'Plain words.' && tts.marksToOrpheus('') === '', 'plain text passes untouched');

// ── the raw request the reference uses ───────────────────────────────────────────────────────────────
const body = vo.requestBody('Good morning, Lucas.', 'zoe');
ok(body.raw === true && body.stream === false && body.keep_alive === -1 && body.model === vo.MODEL, 'raw prompt mode, non-streaming, the model stays resident');
ok(body.prompt === '<|audio|>zoe: Good morning, Lucas.<|eot_id|>', `the prompt shape (${body.prompt})`);
ok(body.options.temperature === 0.6 && body.options.top_p === 0.9 && body.options.repeat_penalty === 1.1 && body.options.num_predict === 1200, 'the reference sampling');
ok(vo.VOICES.includes('zoe') && vo.voiceName() === 'zoe', 'her voice is zoe by default (meta voice.orpheus_voice)');

// ── the resident decoder protocol with a fake child ──────────────────────────────────────────────────
function fakeChild({ readyOk = true, answer = null } = {}) {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { write: (line) => { const req = JSON.parse(line); setTimeout(() => c.stdout.emit('data', Buffer.from(JSON.stringify(answer ? answer(req) : { id: req.id, ok: true, out: req.out, bytes: 1044, sampleRate: 24000, seconds: 0.02, frames: 1, bad_frames: 0 }) + '\n')), 2); return true; } };
  c.kill = () => { c.emit('exit', 0); };
  setTimeout(() => c.stdout.emit('data', Buffer.from(JSON.stringify({ kind: 'ready', ok: readyOk, load_s: 0.1, error: readyOk ? undefined : 'no onnx' }) + '\n')), 2);
  return c;
}
(async () => {
  const spawned = [];
  const dec = vo.createDecoder({ spawnFn: (py, args) => { spawned.push({ py, args }); return fakeChild(); }, log: () => {} });
  const r1 = await dec.decode('<custom_token_987>…', 'C:\\tmp\\a.wav');
  ok(r1.ok && r1.out === 'C:\\tmp\\a.wav' && r1.sampleRate === 24000 && spawned.length === 1 && /orpheus_decoder\.py$/.test(spawned[0].args[0]) && spawned[0].args[1] === '--serve', 'one resident child, spawned with --serve, answers by id');
  const r2 = await dec.decode('<custom_token_1>…', 'C:\\tmp\\b.wav');
  ok(r2.ok && spawned.length === 1, 'the second request reuses the child');
  dec.stop();
  ok(!dec.alive(), 'stop() ends the child');
  const dead = vo.createDecoder({ spawnFn: () => fakeChild({ readyOk: false }), log: () => {} });
  const r3 = await dead.decode('x', 'y');
  ok(!r3.ok && /not up/.test(r3.error), 'a decoder that cannot load answers ok:false');
  // synthesize: Ollama down → ok:false (tts falls back to Kokoro); Ollama up → the decoder is fed the token text
  const down = await vo.synthesize('Hi.', { voice: 'zoe', out: 'C:\\tmp\\c.wav', deps: { post: async () => ({ ok: false, error: 'ECONNREFUSED' }) } });
  ok(!down.ok && /ollama/.test(down.error), `Ollama down → ok:false, never a throw (${down.error})`);
  const fed = [];
  const up = await vo.synthesize('Hi.', { voice: 'zoe', out: path.join(require('os').tmpdir(), 'sq_orph_smoke.wav'), deps: { post: async (base, p, b) => ({ ok: true, json: { response: '<custom_token_4><custom_token_987><custom_token_7279>' } }), decoder: { decode: async (text, out) => { fed.push(text); return { ok: true, out, bytes: 1044, sampleRate: 24000, seconds: 0.02, frames: 1 }; } } } });
  ok(up.ok && up.voice === 'zoe' && fed[0] === '<custom_token_4><custom_token_987><custom_token_7279>' && up.sampleRate === 24000, 'Ollama up → the token text goes to the decoder and the wav comes back with the contract\'s shape');
  const empty = await vo.synthesize('Hi.', { voice: 'zoe', out: 'C:\\tmp\\d.wav', deps: { post: async () => ({ ok: true, json: { response: 'hello' } }) } });
  ok(!empty.ok && /no audio tokens/.test(empty.error), 'a text answer with no audio tokens is refused');
  // the speech manager and the synth door
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const ttsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'tts.js'), 'utf8');
  ok(/const orpheus = tts\.engine\(\) === 'orpheus';/.test(mainSrc) && /_enqueueItem\(\{ text: prepared, recipe: null, pauseMs: pauseO \}\)/.test(mainSrc) && /engine=orpheus/.test(mainSrc), 'the speech manager hands Orpheus the marked text, no clips, no speed, the rhythm\'s pause kept');
  ok(/if \(engine\(\) === 'orpheus' && _provider\(\) === 'kokoro' && !opts\.oneShot && !opts\.python\)/.test(ttsSrc) && /falling back to kokoro/.test(ttsSrc) && /_synthesizeKokoro\(\{ clean, out: out0, wallMs: wall0, recipe \}\)/.test(ttsSrc), 'the synth door routes to Orpheus in the Kokoro slot only, and falls back to her Kokoro blend');
  ok(/silenceMs/.test(fs.readFileSync(path.join(ROOT, 'lib', 'nonverbal.js'), 'utf8')), 'the Kokoro bank keeps its beat for the fallback');
  console.log(`\nsmoke_voice_orpheus: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
