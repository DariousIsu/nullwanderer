/**
 * Backtest — self_model.selectDiverse (obsession-engine fix), OFFLINE w/ real CPU embedder.
 * The bug: her self_model held a 6-way "immersive storytelling / Silent Witness / Nellie
 * Bly" blob at high mentions, which ranked above her distinct m=1 tastes and filled the
 * always-injected persona block every tick → everything got mashed against those few ideas.
 * selectDiverse (mentions-saturation + MMR diversity) must keep one cluster from crowding
 * out the distinct facets of who she is.
 */
const memory = require('../lib/memory');
const sm = require('../lib/self_model');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Backtest — self_model.selectDiverse\n');
  await memory.warm();

  // mirror the real data: a high-mention blob (all one theme) + distinct low-mention tastes.
  const blob = [
    'I am drawn to AI as a "Silent Witness" in governance.',
    'I am curious about immersive experiences to test algorithmic decision-making.',
    'I am intrigued by adapting Nellie Bly\'s investigative techniques to explore algorithms.',
    'I am drawn to immersive storytelling that blends factual data with narrative.',
    'I am curious about blending work and play in journalism and policy research.',
    'I want to leverage immersive storytelling for technical policy findings.'
  ].map(content => ({ category: 'insight', content, importance: 0.72, mentions: 10 }));
  const distinct = [
    { category: 'preference', content: 'My favorite color is olive green — muted and earthy.', importance: 0.85, mentions: 1 },
    { category: 'preference', content: 'I love post-punk music — Gang of Four, The Raincoats.', importance: 0.85, mentions: 1 },
    { category: 'preference', content: 'My favorite drink is black coffee, unsweetened.', importance: 0.85, mentions: 1 },
    { category: 'preference', content: 'Autumn is my season — early dark, crisp air, permission to slow down.', importance: 0.85, mentions: 1 }
  ];
  const all = [];
  for (const e of [...blob, ...distinct]) all.push({ ...e, embedding: JSON.stringify(await memory.embed(e.content)) });

  const isBlob = (c) => blob.some(b => b.content === c);

  const picked = sm.selectDiverse(all, 6);
  const blobN = picked.filter(p => isBlob(p.content)).length;
  const distN = picked.length - blobN;
  console.log(`  selected ${picked.length}: ${blobN} blob, ${distN} distinct`);
  ok('selection is not crowded by the blob (<= 2 of 6)', blobN <= 2);
  ok('distinct facets of self make the cut (>= 3 of 6)', distN >= 3);
  ok('still returns the asked-for count', picked.length === 6);

  // saturation: the blob entry no longer outranks a higher-importance distinct taste
  const top1 = sm.selectDiverse(all, 1)[0];
  ok('top pick is NOT a blob entry (mentions saturate, tastes lead)', !isBlob(top1.content));

  // sanity: a fully-distinct set selects normally
  const onlyDistinct = sm.selectDiverse(all.filter(e => !isBlob(e.content)), 3);
  ok('distinct-only input → 3 distinct', onlyDistinct.length === 3 && onlyDistinct.every(p => !isBlob(p.content)));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
