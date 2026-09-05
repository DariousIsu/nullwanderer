// voice_dataset_build.js — HER VOICE AS A DATASET (Lucas 09-05: "rent the gpu?" → the fine-tune kit). Takes N of
// her own real says from the turns table (clean prose, 20–200 chars, no tags, no code, no near-duplicates),
// renders each through her saved Kokoro blend at her baseline, and writes a training set the Orpheus fine-tune
// script consumes: data/voices/zoe_dataset/wavs/NNNN.wav (24 kHz mono 16-bit) + metadata.csv (file|text).
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/voice_dataset_build.js [--n 400]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'voices', process.env.ZOE_DATASET_DIR || 'zoe_dataset_v2');
const N = Math.max(50, parseInt((process.argv.find((a) => a.startsWith('--n=')) || '--n=400').slice(4), 10) || 400);
const SR = 24000;
function clean(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sentences(s) { return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean); }
function usable(t) {
  if (t.length < 20 || t.length > 200) return false;
  if (!/[a-z]/i.test(t) || /[{}\[\]<>|\\]/.test(t)) return false;
  if ((t.match(/\d/g) || []).length > 12) return false;
  if (/\b(ai_said|ai_thought|turn_id|sql|select |insert |json)\b/i.test(t)) return false;
  if (!/[.!?…]$/.test(t)) return false;
  return true;
}
(async () => {
  const D = require('better-sqlite3');
  const db = new D(require(path.join(ROOT, 'lib', 'db')).DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT content FROM turns WHERE speaker='ai_said' ORDER BY ts DESC LIMIT 6000").all();
  // v2 (run 4, 09-05): her replies are multi-sentence; a set of single sentences taught the model that an
  // utterance is one sentence (run 3 stopped early on three-sentence lines and ran long on some single ones).
  // Consecutive usable sentences from the SAME say are grouped 1–3 at a time up to GROUP_CHARS, so the model
  // learns her utterances at their real length, with her own pauses between sentences.
  const GROUP_CHARS = 260;
  const seen = new Set(); const lines = [];
  for (const r of rows) {
    const ss = sentences(clean(r.content)).filter((s) => usable(s));
    let i = 0;
    while (i < ss.length && lines.length < N) {
      const take = 1 + Math.floor(Math.random() * 3);   // 1, 2 or 3 sentences
      const group = [];
      for (let j = i; j < Math.min(ss.length, i + take); j++) {
        if ((group.join(' ') + ' ' + ss[j]).trim().length > GROUP_CHARS) break;
        group.push(ss[j]);
      }
      if (!group.length) { i++; continue; }
      i += group.length;
      const text = group.join(' ');
      const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key); lines.push(text);
    }
    if (lines.length >= N) break;
  }
  const multi = lines.filter((l) => sentences(l).length > 1).length;
  console.log(`grouped: ${lines.length} utterances, ${multi} with 2–3 sentences`);
  // a few lines with the model's tags so her voice learns to carry them (the tags are text to Orpheus)
  const tagged = ['<laugh> You already know that, Lucas.', '<sigh> I suppose we could try the other door.', '<chuckle> That went about as well as last time.', '<laugh> Okay, okay. I hear you.', '<sigh> It is what it is. Let me fix it.', '<chuckle> Of course it did.'];
  console.log(`her lines: ${lines.length} usable of ${rows.length} says (+${tagged.length} tagged)`);
  fs.mkdirSync(path.join(OUT, 'wavs'), { recursive: true });
  const vk = require(path.join(ROOT, 'lib', 'voice_kokoro'));
  const voices = require(path.join(ROOT, 'lib', 'voices'));
  const recipe = voices.activeRecipe();
  console.log('recipe:', JSON.stringify(recipe && { weights: recipe.weights, speed: recipe.speed, lang: recipe.lang }));
  const meta = []; let secs = 0, fail = 0; const t0 = Date.now();
  const all = [...lines, ...tagged];
  for (let i = 0; i < all.length; i++) {
    const text = all[i]; const spoken = text.replace(/<[a-z]+>\s*/g, '');   // Kokoro speaks the words; the tag stays in the transcript
    const f = `${String(i + 1).padStart(4, '0')}.wav`; const p = path.join(OUT, 'wavs', f);
    const r = await vk.synthesize(spoken, recipe, { out: p, timeoutMs: 60000 });
    if (!r || !r.ok || !fs.existsSync(p)) { fail++; continue; }
    const b = fs.readFileSync(p); const dur = (b.length - 44) / 2 / SR; secs += dur;
    if (b.readUInt32LE(24) !== SR) { fail++; fs.unlinkSync(p); continue; }
    meta.push({ file: `wavs/${f}`, text, seconds: +dur.toFixed(2) });
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${all.length} · ${(secs / 60).toFixed(1)} min of her so far`);
  }
  fs.writeFileSync(path.join(OUT, 'metadata.csv'), 'file|text\n' + meta.map((m) => `${m.file}|${m.text.replace(/\|/g, '/')}`).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'metadata.json'), JSON.stringify({ voice: 'zoe', sampleRate: SR, count: meta.length, seconds: +secs.toFixed(1), recipe: recipe && { weights: recipe.weights, speed: recipe.speed, lang: recipe.lang }, builtAt: new Date().toISOString(), items: meta }, null, 1));
  console.log(`done: ${meta.length} clips, ${(secs / 60).toFixed(1)} min of her voice, ${fail} failed, in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('dataset build failed:', e.message); process.exit(1); });
