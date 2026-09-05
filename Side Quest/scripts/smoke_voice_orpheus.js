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
ok(/return 'kokoro';\n\}/.test(fs.readFileSync(path.join(ROOT, 'lib', 'tts.js'), 'utf8').split('function engine()')[1].split('const ORPHEUS_TAGS')[0]), 'her Kokoro blend is the default voice (his word: "if we cannot have Zoe\'s custom voice it\'s not the right answer"); Orpheus is an opt-in');
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
ok(body.options.temperature === 0.4 && body.options.top_p === 0.9 && body.options.repeat_penalty === 1.1 && body.options.num_predict === 2400, 'the sampling: the reference\'s top_p and repeat penalty, a lower temperature that holds one voice, room for a paragraph');
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
  ok(/const orpheus = tts\.engine\(\) === 'orpheus';/.test(mainSrc) && /_group\.parts\.push\(prepared\); _group\.chars \+= clean\.length; _group\.pauseMs = pauseO;/.test(mainSrc) && /_enqueueItem\(\{ text, recipe: null, pauseMs \}\)/.test(mainSrc) && /engine=orpheus/.test(mainSrc), 'the speech manager hands Orpheus the marked text (grouped), no clips, no speed, the rhythm\'s pause kept');
  ok(/if \(engine\(\) === 'orpheus' && _provider\(\) === 'kokoro' && !opts\.oneShot && !opts\.python\)/.test(ttsSrc) && /falling back to kokoro/.test(ttsSrc) && /_synthesizeKokoro\(\{ clean, out: out0, wallMs: wall0, recipe \}\)/.test(ttsSrc), 'the synth door routes to Orpheus in the Kokoro slot only, and falls back to her Kokoro blend');
  ok(/silenceMs/.test(fs.readFileSync(path.join(ROOT, 'lib', 'nonverbal.js'), 'utf8')), 'the Kokoro bank keeps its beat for the fallback');

  // ── STREAMING (his word: "streaming") — the decoder's stream protocol with a fake child, and the wiring ──
  delete process.env.ZOE_ORPHEUS_TEMP;
  ok(vo.requestBody('x', 'zoe').options.temperature === 0.4 && vo.requestBody('x', 'zoe').options.num_predict === 2400, 'sampling holds one voice (0.4) and a request may carry a paragraph (2400 tokens)');
  process.env.ZOE_ORPHEUS_TEMP = '0.7'; ok(vo.requestBody('x', 'zoe').options.temperature === 0.7, 'ZOE_ORPHEUS_TEMP overrides'); delete process.env.ZOE_ORPHEUS_TEMP;
  function streamingChild() {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.lines = [];
    c.stdin = { write: (line) => {
      const req = JSON.parse(line); c.lines.push(req);
      if (req.stream && req.append) { const n = (req.append.match(/<custom_token_\d+>/g) || []).length; for (let i = 0; i < n; i++) setTimeout(() => c.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, seq: c.lines.filter((l) => l.append).length * 10 + i, pcm: Buffer.alloc(4096).toString('base64'), samples: 2048 }) + '\n')), 1); }
      if (req.stream && req.done) setTimeout(() => c.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, done: true, frames: 7, samples: 7 * 2048 }) + '\n')), 3);
      return true;
    } };
    c.kill = () => c.emit('exit', 0);
    setTimeout(() => c.stdout.emit('data', Buffer.from(JSON.stringify({ kind: 'ready', ok: true, load_s: 0.1 }) + '\n')), 1);
    return c;
  }
  const sChild = streamingChild();
  const sdec = vo.createDecoder({ spawnFn: () => sChild, log: () => {} });
  const got = []; let doneMsg = null;
  const s = await sdec.openStream({ onChunk: (c) => got.push(c), onDone: (m) => { doneMsg = m; } });
  s.append('<custom_token_4><custom_token_987><custom_token_7279>'); s.append('<custom_token_10793><custom_token_1'); s.append('2455>'); s.done();
  await new Promise((r) => setTimeout(r, 30));
  ok(got.length === 4 && got.every((c) => c.pcm.length === 4096 && c.samples === 2048) && doneMsg && doneMsg.frames === 7, `a stream's waiter stays for EVERY frame until done (${got.length} frames, done ${JSON.stringify(doneMsg)}) — the whole-line waiter bug that stalled the first stream`);
  ok(sChild.lines.filter((l) => l.stream && l.append).length === 3 && sChild.lines.some((l) => l.stream && l.done), 'appends and the done reach the decoder as stream messages');
  const s2 = await sdec.openStream({ onChunk: () => {}, onDone: () => {} }); s2.abort();
  ok(sChild.lines.some((l) => l.stream && l.abort && l.id === s2.id), 'abort() tells the decoder to drop the stream (a barge-in)');
  sdec.stop();
  // synthesizeStream: Ollama down → ok:false; a text answer with no audio tokens → ok:false
  const fakeHttpDown = { request: (opts, cb) => { const e = new EventEmitter(); e.on = e.on.bind(e); e.setTimeout = () => {}; e.destroy = () => {}; e.end = () => setTimeout(() => e.emit('error', new Error('ECONNREFUSED')), 1); return e; } };
  const fakeDec = { openStream: async ({ onChunk, onDone }) => ({ id: 1, append: () => {}, done: () => setTimeout(() => onDone({ done: true, frames: 0, samples: 0 }), 1), abort: () => {} }) };
  const downS = await vo.synthesizeStream('Hi.', { voice: 'zoe', onChunk: () => {}, deps: { http: fakeHttpDown, decoder: fakeDec } });
  ok(!downS.ok && /ollama/.test(downS.error), `stream with Ollama down → ok:false (${downS.error})`);
  // the wiring: main streams frames to the renderer, groups sentences, aborts on barge; the renderer schedules on one clock
  const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const chatS = fs.readFileSync(path.join(ROOT, 'renderer', 'chat.js'), 'utf8');
  const preS = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  ok(/function _playStream\(prepared/.test(mainS) && /mainWindow\.webContents\.send\('voice:pcm', \{ id, seq, pcm, sampleRate: 24000 \}\)/.test(mainS) && /voice:pcm-end/.test(mainS) && /ipcMain\.on\('voice:pcm-done'/.test(mainS), 'main streams frames to the chat renderer and waits for its ack');
  ok(/function flush\(\) \{ gen\+\+; _stopStream\(\); \}/.test(mainS) && /voice:pcm-stop/.test(mainS), 'a barge-in aborts the stream on both ends');
  ok(/const streaming = !!\(item\.text && !item\.clip && _streamOn\(\)/.test(mainS) && /if \(res && res\.streamed\)/.test(mainS) && /voice\.stream'\) === '0'/.test(mainS), 'the speech manager streams an Orpheus item and keeps the file path as the fallback (off: meta voice.stream=0)');
  ok(/ORPHEUS_GROUP_CHARS = 240, ORPHEUS_GROUP_QUIET_MS = 450/.test(mainS) && /function _flushGroup\(\)/.test(mainS) && /_group\.parts\.push\(prepared\)/.test(mainS), 'her sentences are grouped into one request so the voice holds across a reply');
  ok(/onVoicePcm\(\(\{ id, seq, pcm, sampleRate \}\)/.test(chatS) && /ctx\.createBufferSource\(\)/.test(chatS) && /src\.start\(at\); pcmNext = at \+ n \/ sr;/.test(chatS) && /window\.sq\.voicePcmDone\(id, true\)/.test(chatS) && /onVoicePcmStop\(\(\) => pcmStopAll\(false\)\)/.test(chatS), 'the renderer schedules every frame on one WebAudio clock and acks the last');
  ok(/onVoicePcm:/.test(preS) && /onVoicePcmEnd:/.test(preS) && /onVoicePcmStop:/.test(preS) && /voicePcmDone:/.test(preS), 'the preload bridge carries the four stream messages');
  console.log(`\nsmoke_voice_orpheus: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
