const fs = require('fs');
const src = fs.readFileSync('renderer/kg3d.js', 'utf8');
// brace-match from a declaration so line endings / nesting can't break the lift
function lift(startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  const open = src.indexOf('{', i);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + startMarker);
}
const code = lift('const ANIM_CLIPS =') + ';\n' + lift('function animSample(') +
             '\nreturn {ANIM_CLIPS, animSample};';
const { ANIM_CLIPS, animSample } = new Function(code)();

let fail = 0;
const names = Object.keys(ANIM_CLIPS);
console.log('clips lifted:', names.join(', '));
for (const n of names) {
  const c = ANIM_CLIPS[n];
  if (!c.dur || c.dur <= 0) { console.log('FAIL', n, 'bad dur'); fail++; continue; }
  for (const bone of Object.keys(c.tracks)) {
    for (let t = 0; t <= c.dur + 1e-9; t += c.dur / 40) {
      const v = animSample(c, bone, t);
      if (!v || v.some(x => !Number.isFinite(x))) { console.log('FAIL', n, bone, 'non-finite @' + t.toFixed(2)); fail++; break; }
    }
    if (c.loop) {
      const a = animSample(c, bone, 0), b = animSample(c, bone, c.dur);
      const d = Math.max(...a.map((x, i) => Math.abs(x - b[i])));
      if (d > 1e-6) { console.log('FAIL', n, bone, 'loop pop of', d.toFixed(5), 'rad'); fail++; }
    }
    let peak = 0;
    for (let t = 0; t <= c.dur; t += c.dur / 60) peak = Math.max(peak, ...animSample(c, bone, t).map(Math.abs));
    if (peak > 0.35) { console.log('FAIL', n, bone, 'amplitude', peak.toFixed(3), '> 0.35 rad'); fail++; }
    if (peak === 0) { console.log('WARN', n, bone, 'track never moves'); }
  }
}
console.log(fail ? `\n${fail} FAILURES` : '\nPASS — all clips finite, loop-continuous, and subtle (<20 deg)');
process.exit(fail ? 1 : 0);
