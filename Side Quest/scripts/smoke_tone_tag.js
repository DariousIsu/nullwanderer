/* smoke_tone_tag.js — the wants project, cut 9 (her wish zero: "modulate my voice") + the non-verbal bank.
 *
 * Pins: applyTone is a BOUNDED delta on her recipe (speed within ±0.15 of her baseline, a blend lean of at
 * most 20 points, weights renormalized), pure and idempotent; the state baseline is bounded and OFF by
 * default; her tags survive prepareText as private markers and extractVoiceMarks splits them into what is
 * spoken and how; the tags and markers never reach a bubble; the non-verbal bank synthesizes a breath and
 * a sigh deterministically, speaks a laugh through HER recipe at a tone, caches by recipe hash, and a clip
 * that cannot be made never blocks the words; the speech manager and the renderer carry the wiring.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const voices = require('../lib/voices');
const tts = require('../lib/tts');
const NV = require('../lib/nonverbal');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const near = (a, b, eps = 0.002) => Math.abs(a - b) <= eps;
const sum = (w) => Object.values(w).reduce((s, v) => s + v, 0);

// ── applyTone ─────────────────────────────────────────────────────────────────────────────────────
const zoe = { weights: { af_bella: 0.318, af_nicole: 0.273, bf_isabella: 0.409 }, lang: 'b', speed: 1.13 };
const warm = voices.applyTone(zoe, 'warm');
ok(near(warm.recipe.speed, 1.10) && near(warm.recipe.weights.af_bella, 0.468, 0.01) && warm.recipe.weights.af_nicole < zoe.weights.af_nicole && near(sum(warm.recipe.weights), 1) && warm.recipe.lang === 'b', `warm: speed −0.03, a 15-point lean toward the ANIMATED voice (af_bella), never the whisper — weights renormalized (${JSON.stringify(warm.recipe.weights)} @ ${warm.recipe.speed})`);
ok(voices.applyTone(zoe, 'low').recipe.weights.af_nicole > zoe.weights.af_nicole && voices.applyTone(zoe, 'quick').recipe.weights.af_bella > zoe.weights.af_bella, 'low is the one place the whisper belongs; quick leans animated too');
ok(warm.recipe.weights.af_nicole < zoe.weights.af_nicole && warm.recipe.weights.bf_isabella < zoe.weights.bf_isabella && near((zoe.weights.af_nicole - warm.recipe.weights.af_nicole) / (zoe.weights.bf_isabella - warm.recipe.weights.bf_isabella), zoe.weights.af_nicole / zoe.weights.bf_isabella, 0.05), 'the lean is taken proportionally from the other voices');
ok(near(voices.applyTone(zoe, 'quick').recipe.speed, 1.23) && near(voices.applyTone(zoe, 'low').recipe.speed, 1.03) && near(voices.applyTone(zoe, 'dry').recipe.speed, 1.16), 'quick +0.10, low −0.10, dry +0.03 on her baseline');
ok(voices.applyTone(zoe, 'dry').recipe.weights.af_nicole === zoe.weights.af_nicole, 'dry leaves the blend alone');
const p = voices.applyTone(zoe, 'pause');
ok(p.pauseMs === 400 && p.recipe.speed === zoe.speed && p.tone === 'pause', 'pause = 400 ms of silence, the recipe untouched');
const unknown = voices.applyTone(zoe, 'operatic');
ok(unknown.recipe === zoe && unknown.tone === null && unknown.pauseMs === 0, 'an unknown tone changes nothing');
ok(voices.applyTone(zoe, 'warm').recipe.speed === warm.recipe.speed, 'pure: the same input gives the same delta');
const twice = voices.applyTone(warm.recipe, 'warm');
ok(twice.recipe.speed === warm.recipe.speed && twice.recipe.weights.af_bella === warm.recipe.weights.af_bella, 'idempotent: a recipe already carrying the tone is not compounded');
const fast = voices.applyTone({ ...zoe, speed: 1.45 }, 'quick');
ok(fast.recipe.speed <= 1.5, 'the hard speed ceiling holds (1.5)');
const quickThenLow = voices.applyTone(voices.applyTone(zoe, 'quick').recipe, 'low');
ok(near(quickThenLow.recipe.speed, 1.03), 'a second tone is a delta on HER baseline, not on the previous tone (baseline carried)');
ok(voices.toneNames().join() === 'warm,dry,quick,low,pause', 'the five tones of the design, no more');

// ── the state baseline (measured never scripted; ON unless meta voice.state_baseline='0') ──────────
ok(voices.baselineFromState(zoe, { energy: 1 }, { enabled: false }).speed === zoe.speed, 'the baseline shift can be switched off');
ok(voices.baselineFromState(zoe, { energy: 1 }).speed === zoe.speed && near(voices.baselineFromState(zoe, { energy: 0 }).speed, 1.10), 'energy alone: rested never speeds her past his tuned recipe (his ear 15:00: "dropping a few words"); exhausted slows by up to 0.03');
const live = { mv: 4, drives: { energy: 0.81, curiosity: 0.7 }, vad: { v: 0.76, a: 0.75, d: 0.66 } };   // the LIVE vector on 09-05 08:40 (lib/internal_state's shape)
const bl = voices.baselineFromState(zoe, live);
ok(bl.speed === zoe.speed && bl._baseline.dSpeed === 0 && /af_bella\+10/.test(bl._baseline.lean) && near(sum(bl.weights), 1) && bl.weights.af_bella > zoe.weights.af_bella && bl.weights.af_nicole < zoe.weights.af_nicole, `the live shape: rested + keyed-up → speed stays his 1.13 (never past his ear), warm valence → the ANIMATED voice +10 pts (${JSON.stringify(bl._baseline)})`);
// RHYTHM — a tempo and a pause per sentence (his ear: "still sounded really flat"); pure, deterministic, bounded
const P = (text, o) => tts.prosody({ text, ...(o || {}) });
ok(P('Did you get the file?').dSpeed <= 0 && P('Did you get the file?').pauseAfterMs === 240 && /question/.test(P('Did you get the file?').why), 'a question slows a touch and waits');
ok(P('That went through!').dSpeed >= 0.03 && P('That went through!').pauseAfterMs === 160, 'an exclamation quickens');
ok(P('I suppose we could…').pauseAfterMs === 480 && P('I suppose we could…').dSpeed <= -0.01 && P('Or not...').pauseAfterMs === 480, 'a trailing thought slows and leaves a long gap (… and ...)');
ok(P('Fine.', { index: 3, prevLen: 120 }).dSpeed >= 0.01 && P('Fine.', { index: 3, prevLen: 120 }).pauseAfterMs >= 260 && /beat/.test(P('Fine.', { index: 3, prevLen: 120 }).why), 'a short line after a long one comes as a quick beat');
ok(P('Fine.', { index: 0, prevLen: 0 }).why !== 'beat' && P('First, the ledger,').pauseAfterMs === 90, 'no beat on the first line; a clause ending barely pauses');
const longS = 'The ledger shows the three runs you asked about landed before nine, the fourth one stalled on the same lock we saw last night, and the fifth is still queued behind it waiting on the backup.';
ok(P(longS).pauseAfterMs === 280 && /long/.test(P(longS).why), 'a long sentence runs a little and rests after');
const tempos = new Set(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.', 'Eight.', 'Nine.', 'Ten.', 'Eleven.', 'Twelve.'].map((s) => P(s).dSpeed));
ok(tempos.size >= 7 && [...tempos].every((d) => Math.abs(d) <= 0.08), `a deterministic drift: no two plain sentences share a tempo (${tempos.size} of 12 distinct), all within ±0.08`);
ok(P('Did you get the file?').dSpeed === P('Did you get the file?').dSpeed && Math.abs(P('Yes!!!', { index: 2, prevLen: 200 }).dSpeed) <= 0.08, 'pure and clamped');
const mainSrcR = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/tts\.prosody\(\{ text: clean, index: _breath\.index, prevLen: _breath\.prevLen \}\)/.test(mainSrcR) && /pauseMs: pauseAfter/.test(mainSrcR) && /voice\.prosody'\) !== '0'/.test(mainSrcR) && /rhythm=/.test(mainSrcR), 'the speech manager gives every sentence its tempo and its pause (off: meta voice.prosody=0) and the log names it');
ok(/_breath\.lastAt = nowMs; _breath\.index\+\+; _breath\.prevLen = clean\.length;/.test(mainSrcR) && !/} else if \(clips\.length\) \{ _breath\.since = 0/.test(mainSrcR), 'the sentence memory is tracked on every sentence, not only when the breath rule is on');
const top = voices.baselineFromState(zoe, { drives: { energy: 1 }, vad: { v: 0.5, a: 1 } });
ok(top.speed === zoe.speed && top._baseline.dSpeed === 0 && top._baseline.lean === null, 'the ceiling is his recipe: full energy and arousal add nothing to speed; neutral valence leans nothing');
const low = voices.baselineFromState(zoe, { drives: { energy: 0 }, vad: { v: 0.2, a: 0 } });
ok(near(low.speed, 1.08) && /bf_isabella\+10/.test(low._baseline.lean), 'the floor: exhausted, flat, low valence → −0.05 and the crisper voice +10 (clamped)');
ok(voices.baselineFromState(zoe, { drives: { energy: 0.5 }, vad: { v: 0.5, a: 0.5 } }).speed === zoe.speed && voices.baselineFromState(zoe, { drives: { energy: 0.5 }, vad: { v: 0.5, a: 0.5 } })._baseline.lean === null, 'a neutral vector changes nothing');
ok(voices.baselineFromState(zoe, {}).speed === zoe.speed && !voices.baselineFromState(zoe, {})._baseline && voices.baselineFromState(zoe, null).speed === zoe.speed, 'no reading → no shift (fail-absent)');
ok(near(voices.applyTone(bl, 'quick').recipe.speed, 1.23), 'a tone is a delta on HER baseline, not on the state-shifted speed (the baseline carries _baseSpeed)');

// ── respiration: a breath where a person would take one (a rule, not a feeling) ──────────────────────
ok(tts.autoNonverbal({ index: 0, prevLen: 300, sinceBreath: 5 }) === null, 'never on the first sentence of a reply');
ok(tts.autoNonverbal({ index: 1, prevLen: 130, sinceBreath: 2 }) === 'breath', 'after a long sentence (≥110 chars) → a breath');
ok(tts.autoNonverbal({ index: 2, prevLen: 40, sinceBreath: 2 }) === null && tts.autoNonverbal({ index: 3, prevLen: 40, sinceBreath: 3 }) === 'breath', 'short sentences: a breath after three without one');
ok(tts.autoNonverbal({ index: 1, prevLen: 300, sinceBreath: 1 }) === null, 'at most one breath per few sentences (never two in a row)');
const mainSrcEarly = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/autoNonverbal\(\{ index: _breath\.index/.test(mainSrcEarly) && /if \(auto\) _enqueueItem\(\{ clip: auto \}\)/.test(mainSrcEarly) && /!marks\.before\.length && !marks\.after\.length/.test(mainSrcEarly), 'the speech manager applies it only when she wrote no mark of her own');
ok(/db\.getMeta\('voice\.auto_breath'\) === '1'/.test(mainSrcEarly) && /nv && autoOn && !marks/.test(mainSrcEarly), 'the automatic breath is OFF unless meta voice.auto_breath=1 (his verdict on the first clip)');
// THE BREATH v2 — measured, since his ear said v1 was "someone blowing into a mic" (hiss + a plateau)
{
  const nvb = require(path.join(__dirname, '..', 'lib', 'nonverbal'));
  const x = nvb.synthBreath(); const n = x.length, sr = nvb.SR;
  let rms = 0, pk = 0, zc = 0; for (let i = 0; i < n; i++) { rms += x[i] * x[i]; pk = Math.max(pk, Math.abs(x[i])); if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++; }
  rms = Math.sqrt(rms / n); const zcr = zc / (n / sr);
  const a = Math.exp(-2 * Math.PI * 150 / sr); let y = 0, lf = 0, tot = 0; for (let i = 0; i < n; i++) { y = a * y + (1 - a) * x[i]; lf += y * y; tot += x[i] * x[i]; }
  const dB = (v) => 20 * Math.log10(v || 1e-9);
  let pkHead = 0, pkTail = 0; for (let i = 0; i < n * 0.12; i++) pkHead = Math.max(pkHead, Math.abs(x[i])); for (let i = Math.floor(n * 0.92); i < n; i++) pkTail = Math.max(pkTail, Math.abs(x[i]));
  ok(Math.abs(n / sr - 0.34) < 0.01, `a catch-breath is a third of a second (${(n / sr).toFixed(2)}s), not half`);
  ok(zcr > 1400 && zcr < 3200, `its centre sits near 1 kHz, not in the hiss (zcr ${Math.round(zcr)}/s; v1 was ~7300)`);
  ok(dB(rms) > -41 && dB(rms) < -35 && dB(pk) <= -22, `its level is a decision: rms ${dB(rms).toFixed(1)} dBFS, peak ${dB(pk).toFixed(1)} (≈18 dB under speech)`);
  ok(lf / tot < 0.03, `no rumble below 150 Hz (${(100 * lf / tot).toFixed(1)}%)`);
  ok(pkHead < 0.4 * pk && pkTail < 0.3 * pk, `it rises and falls — no plateau, no blow (head ${(pkHead / pk).toFixed(2)}, tail ${(pkTail / pk).toFixed(2)} of peak)`);
  // his ear on v2 ("the breathing is worse"): the mark is a beat of silence until the voice model breathes itself
  ok(nvb.KINDS.breath.silenceMs === 260 && !nvb.KINDS.breath.dsp && nvb.clipPath('breath', null) === null, 'the bank: <breath/> is a 260 ms beat, no clip, no file');
  const mainSrcB = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/res\.ok && res\.silenceMs && gen === myGen\) \{ await new Promise\(\(r\) => setTimeout\(r, Math\.min\(2000, res\.silenceMs\)\)\); \}/.test(mainSrcB), 'the speech manager plays a beat as silence, never as a wav');
  const sg = nvb.synthSigh(); let sgHead = 0, sgPk = 0; for (let i = 0; i < sg.length; i++) sgPk = Math.max(sgPk, Math.abs(sg[i])); for (let i = 0; i < sg.length * 0.2; i++) sgHead = Math.max(sgHead, Math.abs(sg[i]));
  ok(sg.length === Math.round(sr * 0.95) && sgHead > 0.5 * sgPk, 'a sigh is an exhale: it starts near full and falls');
}
ok(/baselineFromState\(base, st, \{ enabled: db\.getMeta\('voice\.state_baseline'\) !== '0' \}\)/.test(mainSrcEarly) && /baseline=/.test(mainSrcEarly), 'every sentence rides the state baseline (on unless meta voice.state_baseline=0) and the log names it');

// ── the marks survive prepareText; extractVoiceMarks splits them ───────────────────────────────────
const prepared = tts.prepareText('<think>private</think><say>Well. <tone warm/> Take your time. <laugh/> <tone pause/></say>', { maxChars: 1000 });
ok(/⟦t:warm⟧/.test(prepared) && /⟦nv:laugh⟧/.test(prepared) && /⟦t:pause⟧/.test(prepared) && !/<tone|<laugh|private/.test(prepared), `prepareText keeps her marks as private markers and drops the tags + the think ("${prepared}")`);
ok(tts.prepareText(prepared, { maxChars: 1000 }) === prepared, 'prepareText is idempotent over the markers (the streaming path runs it twice)');
const m1 = tts.extractVoiceMarks('⟦nv:laugh⟧ ⟦t:warm⟧ Well then. ⟦t:pause⟧');
ok(m1.text === 'Well then.' && m1.tone === 'warm' && m1.pauseMs === 400 && m1.before.join() === 'laugh' && m1.after.length === 0, `extract: a laugh before the words, warm, a pause after (${JSON.stringify(m1)})`);
const m2 = tts.extractVoiceMarks('Okay. ⟦nv:sigh⟧ ⟦nv:breath⟧');
ok(m2.text === 'Okay.' && m2.after.join() === 'sigh,breath' && m2.tone === null, 'clips after the words stay after, in order');
ok(tts.extractVoiceMarks('⟦t:dry⟧ ⟦t:warm⟧ One.').tone === 'dry', 'two tones: the first wins');
ok(tts.extractVoiceMarks('Plain sentence.').text === 'Plain sentence.', 'no marks: the text is the text');
ok(tts.extractVoiceMarks('⟦nv:laugh⟧').text === '' && tts.extractVoiceMarks('⟦nv:laugh⟧').before.join() === 'laugh', 'a lone laugh is a clip with no words');
ok(!/pause/.test(m1.before.join() + m1.after.join()), 'pause is never a clip');

// ── never shown ───────────────────────────────────────────────────────────────────────────────────
const shown = tts.stripVoiceTags('Well. <tone warm/> Take <laugh/> your time. ⟦t:pause⟧ ⟦nv:sigh⟧ and <tone qui');
ok(!/<tone|<laugh|⟦|<tone qui/.test(shown) && /Well\. Take your time\./.test(shown.replace(/\s+/g, ' ')), `stripVoiceTags removes tags, markers and an unfinished tag mid-stream ("${shown}")`);
const rend = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
ok(/cleanLiveSay[\s\S]{0,900}<tone\\s\+\[a-z\]\+/.test(rend) && /breath\|sigh\|laugh\|chuckle\|hmm\|pause/.test(rend), 'the renderer strips her voice marks from the live bubble');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/stripVoiceTags\(sayStripped\)/.test(mainSrc), 'the final say strip chain strips them too');
const ttsSrcDoor = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tts.js'), 'utf8');
ok(/const prepared = prepareText\(text, \{ maxChars: opts\.maxChars \}\);\s*const marks = extractVoiceMarks\(prepared\);/.test(ttsSrcDoor) && /marksToOrpheus\(prepared\)/.test(ttsSrcDoor), 'synthesize() extracts the marks at the ONE synth door (and maps them for Orpheus there) — no path can speak a marker');

// ── the prompt block: names what exists, never tells her to feel ───────────────────────────────────
const block = tts.buildVoicePromptBlock();
ok(/<tone warm\/>/.test(block) && /<tone pause\/>/.test(block) && /<laugh\/>/.test(block) && /<sigh\/>/.test(block) && /<breath\/>/.test(block) && /<hmm\/>/.test(block), 'the block names the five tones and the five non-verbals');
ok(!/\bfeel\b|emotional|sound alive|be funny|\bact\b|\bperform\b/i.test(block) && /not as decoration/.test(block), 'anti-performance: no instruction to feel or perform');
ok(/Punctuation is prosody/.test(block), 'tier B: punctuation as prosody, one paragraph');
ok(/voiceBlock/.test(mainSrc) && /ttsConfig\(\)\.enabled\) voiceBlock = require\('\.\/lib\/tts'\)\.buildVoicePromptBlock/.test(mainSrc), 'the block rides the tag blocks only when she has a voice');
// 25 voiced lines on boot_p304 used no mark: the vocabulary sat only in the tag blocks. It is now named where she
// writes a say (the FORMAT rules), with one example of the SHAPE — still no instruction to feel.
const ctxSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8');
const fmtAt = ctxSrc.indexOf('FORMAT — EVERY response');
const fmtNear = ctxSrc.slice(fmtAt, fmtAt + 1400);
const insideAt = fmtNear.indexOf('Inside <say>');
ok(fmtAt > -1 && insideAt > -1 && /<tone warm\/>/.test(fmtNear) && /<laugh\/>/.test(fmtNear) && /<tone dry\/> Sure\. <chuckle\/>/.test(fmtNear) && !/\bfeel\b|emotional/i.test(fmtNear.slice(insideAt, insideAt + 420)), 'the marks are named beside the <say> format rules with one shape example, no instruction to feel');

// ── the speech manager ────────────────────────────────────────────────────────────────────────────
ok(/function _enqueueItem\(item\)/.test(mainSrc) && /item\.clip\) return require\('\.\/lib\/nonverbal'\)\.ensureClip/.test(mainSrc) && /recipe: item\.recipe/.test(mainSrc) && /item\.pauseMs > 0/.test(mainSrc), 'enqueue: items — a clip or a toned sentence with a pause — on the same serial chains');
ok(/ZOE_NONVERBAL !== '0'/.test(mainSrc) && /ZOE_TONE_TAG !== '0'/.test(mainSrc), 'both kill switches are honored at the door');
ok(/for \(const k of marks\.before\) _enqueueItem\(\{ clip: k \}\)/.test(mainSrc) && /for \(const k of marks\.after\) _enqueueItem\(\{ clip: k \}\)/.test(mainSrc), 'clips before the words play before, after play after');

// ── the non-verbal bank ───────────────────────────────────────────────────────────────────────────
const b1 = NV.synthBreath(), b2 = NV.synthBreath();
ok(b1.length === Math.round(NV.SR * 0.34) && NV.peak(b1) <= 0.06 && NV.peak(b1) > 0.02, `a breath: 340 ms at ${NV.SR} Hz, soft (peak ${NV.peak(b1).toFixed(3)})`);
ok(b1.every((v, i) => v === b2[i]), 'deterministic (seeded)');
const s1 = NV.synthSigh();
ok(s1.length === Math.round(NV.SR * 0.95) && NV.peak(s1) <= 0.35 && NV.peak(s1) > NV.peak(b1) * 0.8, `a sigh: 950 ms, a voiced fall under the breath (peak ${NV.peak(s1).toFixed(3)})`);
const wav = NV.wavBytes(b1);
ok(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' && NV.wavInfo(wav).sampleRate === NV.SR && wav.length === 44 + b1.length * 2, 'a valid 16-bit mono WAV');
ok(NV.kinds().join() === 'breath,sigh,laugh,chuckle,hmm' && tts.NONVERBAL_KINDS.join() === NV.kinds().join(), 'the bank and the tag vocabulary agree');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_nv_'));
  const beat = await NV.ensureClip('breath', { deps: { dir, recipe: null, fs: { existsSync: () => { throw new Error('never touches disk'); } } } });
  ok(beat.ok && beat.silenceMs === 260 && !beat.out, `ensureClip(breath) answers a beat of silence without touching disk (${JSON.stringify(beat)})`);
  const c1 = await NV.ensureClip('sigh', { deps: { dir, recipe: null } });
  ok(c1.ok && fs.existsSync(c1.out) && c1.cached === false && c1.sampleRate === NV.SR && c1.bytes > 44, 'ensureClip(sigh): synthesized to the bank');
  const c2 = await NV.ensureClip('sigh', { deps: { dir, recipe: null } });
  ok(c2.ok && c2.cached === true && c2.out === c1.out, 'the second ask is served from the cache');
  const calls = [];
  const fakeSynth = async (text, recipe, o) => { calls.push({ text, recipe }); fs.writeFileSync(o.out, NV.wavBytes(NV.synthBreath({ ms: 100 }))); return { ok: true, out: o.out }; };
  const laugh = await NV.ensureClip('laugh', { deps: { dir, recipe: zoe, synth: fakeSynth } });
  ok(laugh.ok && calls.length === 1 && calls[0].text === 'Ha ha ha!' && near(calls[0].recipe.speed, 1.23) && laugh.sampleRate === NV.SR, `a laugh is HER recipe at the quick tone ("${calls[0].text}" @ ${calls[0].recipe.speed})`);
  const hmm = await NV.ensureClip('hmm', { deps: { dir, recipe: zoe, synth: fakeSynth } });
  ok(hmm.ok && calls[1].text === 'Hmm.' && near(calls[1].recipe.speed, 1.03), 'an hmm is her recipe at the low tone');
  ok(NV.clipPath('laugh', zoe, { dir }) !== NV.clipPath('laugh', { ...zoe, speed: 1.0 }, { dir }) && NV.clipPath('sigh', zoe, { dir }) === NV.clipPath('sigh', null, { dir }), 'spoken clips are keyed by her recipe (a new voice regenerates them); DSP clips are not');
  const dead = await NV.ensureClip('chuckle', { deps: { dir, recipe: zoe, synth: async () => ({ ok: false, error: 'tuner down' }) } });
  ok(!dead.ok && /tuner down/.test(dead.error), 'a clip that cannot be made answers ok:false — the words still play');
  ok(!(await NV.ensureClip('sneeze', { deps: { dir } })).ok, 'an unknown kind is refused');
  process.env.ZOE_NONVERBAL = '0';
  ok(!(await NV.ensureClip('breath', { deps: { dir, recipe: null } })).ok, 'ZOE_NONVERBAL=0 makes no clip');
  delete process.env.ZOE_NONVERBAL;
  ok(!(await NV.ensureClip('laugh', { deps: { dir, recipe: null, synth: fakeSynth } })).ok, 'a spoken clip with no recipe is refused (never a stranger\'s voice)');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_tone_tag: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
