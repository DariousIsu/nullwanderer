/**
 * Backtest — flow_runner.js, OFFLINE (mock page, no browser, no model).
 * Validates the deterministic engine: locator building, {{var}} substitution,
 * fallback traversal, role-only re-derive, model-last heal, blocker pause, and
 * that the real recipes/*.json files are runner-shaped.
 */
const runner = require('../lib/flow_runner');
const store = require('../lib/recipe_store');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// A mock Playwright page. `present` is the set of locator KEYS that "match" (count 1).
// Keys mirror buildLocator: role:<role>:<name>, ph:<x>, text:<x>, testid:<x>, css:<sel>.
function mockPage({ present = new Set(), detect = null } = {}) {
  const calls = [];
  let url = 'about:blank';
  const loc = (key) => ({
    _key: key,
    count: async () => present.has(key) ? 1 : 0,
    first() { return this; },
    scrollIntoViewIfNeeded: async () => {},
    isVisible: async () => present.has(key),
    fill: async (v) => { calls.push(['fill', key, v]); },
    click: async () => { calls.push(['click', key]); }
  });
  return {
    calls, _detect: detect,
    url: () => url,
    title: async () => 'Mock',
    goto: async (u) => { url = u; calls.push(['goto', u]); return { status: () => 200, headers: () => ({}) }; },
    evaluate: async () => null,
    innerText: async () => 'the body text',
    getByRole: (role, opts) => loc(`role:${role}:${opts && opts.name != null ? opts.name : ''}`),
    getByText: (t) => loc(`text:${t}`),
    getByLabel: (t) => loc(`label:${t}`),
    getByPlaceholder: (t) => loc(`ph:${t}`),
    getByTestId: (t) => loc(`testid:${t}`),
    locator: (sel) => loc(sel.startsWith('xpath=') ? sel : `css:${sel}`)
  };
}

(async () => {
  console.log('Backtest — flow_runner.js (offline)\n');

  console.log('subst ({{var}}):');
  ok('substitutes known var', runner.subst('Hello {{name}}', { name: 'Zoe' }) === 'Hello Zoe');
  ok('unknown var → empty', runner.subst('x{{missing}}y', {}) === 'xy');
  ok('non-string passes through', runner.subst(42, {}) === 42);

  console.log('\nbuildLocator (descriptor → locator key):');
  const p = mockPage();
  ok('getByRole role+name', runner.buildLocator(p, { method: 'getByRole', role: 'button', name: 'Publish' })._key === 'role:button:Publish');
  ok('getByPlaceholder', runner.buildLocator(p, { method: 'getByPlaceholder', placeholder: 'Title' })._key === 'ph:Title');
  ok('css fallback', runner.buildLocator(p, { css: 'div.x' })._key === 'css:div.x');
  ok('text fallback', runner.buildLocator(p, { text: 'Continue' })._key === 'text:Continue');

  console.log('\nrunStep — navigate / fill / scroll / read:');
  const nav = await runner.runStep(mockPage(), { action: 'navigate', url: 'https://x.com/{{slug}}' }, { slug: 'post' });
  ok('navigate ok + var-substituted URL', nav.ok && nav.url === 'https://x.com/post');
  const pf = mockPage({ present: new Set(['ph:Title']) });
  const fr = await runner.runStep(pf, { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: '{{t}}' }, { t: 'My Post' });
  ok('fill resolves primary + writes substituted value', fr.ok && !fr.healed && pf.calls.some(c => c[0] === 'fill' && c[2] === 'My Post'));
  ok('scroll ok', (await runner.runStep(mockPage(), { action: 'scroll' })).ok);
  ok('read returns text', (await runner.runStep(mockPage(), { action: 'read' })).text === 'the body text');

  console.log('\nheal ladder:');
  // primary absent, 2nd fallback present → healed via fallback
  const pf2 = mockPage({ present: new Set(['css:textarea#t']) });
  const h1 = await runner.runStep(pf2, { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, fallbacks: [{ text: 'nope' }, { css: 'textarea#t' }], value: 'v' }, {});
  ok('falls back to a working selector (healed)', h1.ok && h1.healed === true);
  // primary getByRole name absent, role-only present → tier-3 re-derive
  const pf3 = mockPage({ present: new Set(['role:button:']) });
  const h2 = await runner.runStep(pf3, { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Publish now' } }, {});
  ok('role-only re-derive heals a drifted name', h2.ok && h2.healed === true);
  // nothing resolves, no modelHeal → fail
  const h3 = await runner.runStep(mockPage(), { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Ghost' } }, {});
  ok('unresolvable target → ok:false', h3.ok === false && /could not locate/.test(h3.reason));
  // modelHeal hook supplies a working descriptor (the model-last tier)
  const pf4 = mockPage({ present: new Set(['css:#healed']) });
  const h4 = await runner.runStep(pf4, { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Ghost' } }, {}, { modelHeal: async () => ({ css: '#healed' }) });
  ok('modelHeal (model-last) resolves + flags byModel', h4.ok && h4.byModel === true);

  console.log('\nblocker pause:');
  const blkPage = mockPage();
  const blkRecipe = { site: 's', task: 't', steps: [{ action: 'navigate', url: 'https://s/login' }, { action: 'click', locator: { css: '#x' } }] };
  const blkRes = await runner.runRecipe(blkPage, blkRecipe, {}, { detect: async () => ({ type: 'login', needsHuman: true, reason: 'IdP' }) });
  ok('needsHuman blocker stops the recipe', blkRes.ok === false && blkRes.blocker.type === 'login' && blkRes.atStep === 0);
  ok('blocker stops BEFORE later steps run', blkPage.calls.every(c => c[0] !== 'click'));

  console.log('\nrunRecipe — full success path:');
  const okPage = mockPage({ present: new Set(['ph:Title', 'role:button:Publish']) });
  const okRecipe = { site: 's', task: 't', steps: [
    { action: 'navigate', url: 'https://s' },
    { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: '{{title}}' },
    { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Publish' }, mayNavigate: true }
  ] };
  const okRes = await runner.runRecipe(okPage, okRecipe, { title: 'Hello' }, { detect: async () => null });
  ok('recipe completes ok', okRes.ok && okRes.ran === 3);
  ok('title was substituted into the fill', okPage.calls.some(c => c[0] === 'fill' && c[2] === 'Hello'));

  console.log('\nreal recipes/*.json are runner-shaped:');
  const list = store.list();
  ok('recipe_store loads the core recipes', list.length >= 3);
  ok('finds substack publish_post', !!store.find('substack', 'publish_post'));
  const VALID_ACTIONS = new Set(['navigate', 'fill', 'click', 'scroll', 'waitFor', 'read']);
  let structOk = true;
  for (const r of store.all()) {
    if (!Array.isArray(r.steps) || !r.steps.length) structOk = false;
    for (const s of r.steps) {
      if (!VALID_ACTIONS.has(s.action)) structOk = false;
      if (s.action === 'navigate' && !s.url) structOk = false;
      if (['fill', 'click', 'waitFor'].includes(s.action) && !s.locator) structOk = false;
    }
  }
  ok('every step has a valid action + required fields', structOk);
  ok('all first-draft recipes flagged verified:false', store.all().every(r => r.verified === false));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
