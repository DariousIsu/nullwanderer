/**
 * Hard smoke — ground the self (anti-glob): her identity track gets epistemic typing
 * (witnessed|told|speculated). Grounded self outranks self-asserted self, and self-repetition
 * (mentions) no longer elevates an unevidenced self-claim — the mechanism that entrenched the
 * immersive-storytelling obsession as "who she is." Offline; real embedder for record().
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_selfgrnd_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');
const sm = require('../lib/self_model');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const episOf = (id) => { const r = db.getDb().prepare('SELECT epistemic FROM self_model WHERE id = ?').get(id); return r && r.epistemic; };

(async () => {
  console.log('Hard smoke — ground the self\n');
  await memory.warm();

  console.log('PRIORITY (pure) — the core re-ranking:');
  const P = sm._priority;
  ok('told outranks a mention-pumped speculated claim', P({ importance: 0.7, category: 'preference', epistemic: 'told', mentions: 1 }) > P({ importance: 0.72, category: 'preference', epistemic: 'speculated', mentions: 12 }));
  ok('witnessed outranks told (equal importance)', P({ importance: 0.7, category: 'trait', epistemic: 'witnessed', mentions: 1 }) > P({ importance: 0.7, category: 'trait', epistemic: 'told', mentions: 1 }));
  ok('among speculated, distinct high-importance beats mention-pumped obsession', P({ importance: 0.85, category: 'preference', epistemic: 'speculated', mentions: 1 }) > P({ importance: 0.72, category: 'preference', epistemic: 'speculated', mentions: 13 }));
  ok('speculated gets NO mention bonus (m=1 == m=13 at equal importance)', P({ importance: 0.72, category: 'insight', epistemic: 'speculated', mentions: 1 }) === P({ importance: 0.72, category: 'insight', epistemic: 'speculated', mentions: 13 }));

  console.log('\nTYPING — default speculated; recordTold grounds:');
  const a = await sm.record('I love olive green — muted and earthy.', { category: 'preference' });
  ok('reflection/default self-statement → speculated', episOf(a.id) === 'speculated');
  const b = await sm.recordTold('I am rigorous about checking primary sources.');
  ok('recordTold → told', b && episOf(b.id) === 'told');

  console.log('\nPROMOTION — affirming an existing asserted trait upgrades it in place:');
  const seed = await sm.record('I am drawn to immersive storytelling.', { category: 'preference' });
  ok('seeded obsession trait is speculated', episOf(seed.id) === 'speculated');
  const promo = await sm.record('You clearly have a real pull toward immersive storytelling.', { epistemic: 'told', decideFn: () => 'same' });
  ok('same-trait told affirmation updates in place (no new row)', promo && promo.action === 'update' && promo.id === seed.id);
  ok('…and upgrades the trait to told', episOf(seed.id) === 'told');

  console.log('\nNO DOWNGRADE — grounding is sticky:');
  ok('setSelfModelEpistemic refuses told → speculated', db.setSelfModelEpistemic(seed.id, 'speculated') === 'told' && episOf(seed.id) === 'told');

  console.log('\nINJECTION — grounded self leads the persona block:');
  // pump the (now-told via promo) ... use a fresh speculated obsession + a told trait, mentions high on obsession
  const ob = await sm.record('I am fascinated by immersive investigative journalism techniques.', { category: 'preference' });
  db.getDb().prepare('UPDATE self_model SET mentions = 12 WHERE id = ?').run(ob.id);
  const block = sm.buildPromptBlock(4) || '';
  ok('a told/grounded trait makes the top slice', /rigorous about checking primary sources|immersive storytelling/i.test(block));
  // the mention-pumped pure-speculated obsession should NOT be guaranteed-top over grounded
  ok('persona block builds (non-empty)', block.length > 0);

  console.log('\nDETECTOR — affirmed-trait extraction (high precision):');
  const D = sm.detectAffirmedTrait;
  ok('"you have a knack for finding primary sources"', /^I have a knack for finding primary sources/.test(D('You have a knack for finding primary sources.') || ''));
  ok('"you tend to go straight to the source"', /^I tend to go straight to the source/.test(D('You tend to go straight to the source') || ''));
  ok('"you\'re good at synthesizing"', /^I'm good at synthesizing/.test(D("you're good at synthesizing dense material") || ''));
  ok('"you\'re thoughtful…" → trait', /^I am thoughtful/.test(D("You're really thoughtful about this.") || ''));
  ok('question → null', D('are you good at this?') === null);
  ok('task phrasing "you\'re working on…" → null', D("you're working on the memory system") === null);
  ok('future "you are going to…" → null', D('you are going to love this') === null);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
