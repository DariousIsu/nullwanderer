/**
 * HEAVY backtest — recipes + flow_runner. For EVERY recipe in recipes/*.json this
 * exercises: structural validity, a full successful replay, fallback healing, role-only
 * re-derive, total-failure localization, mid-recipe blocker pause, and {{var}}
 * substitution into navigations and fills. Plus adversarial buildLocator/subst inputs
 * and a determinism stress loop. No browser, no model — a mock page stands in.
 */
const flow = require('../lib/flow_runner');
const store = require('../lib/recipe_store');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ${c ? '✓' : '✗'} ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Canonical locator KEY for a descriptor — mirrors flow_runner.buildLocator + the mock,
// so a test can pre-load exactly which descriptors "resolve".
function keyOf(desc) {
  if (!desc) return null;
  switch (desc.method) {
    case 'getByRole': return `role:${desc.role}:${desc.name != null ? desc.name : ''}`;
    case 'getByText': return `text:${desc.text}`;
    case 'getByLabel': return `label:${desc.name || desc.label}`;
    case 'getByPlaceholder': return `ph:${desc.placeholder || desc.name}`;
    case 'getByTestId': return `testid:${desc.testid || desc.name}`;
  }
  if (desc.css) return `css:${desc.css}`;
  if (desc.xpath) return `xpath=${desc.xpath}`;
  if (desc.testid) return `testid:${desc.testid}`;
  if (desc.text) return `text:${desc.text}`;
  return null;
}

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
    innerText: async () => 'body text',
    getByRole: (role, opts) => loc(`role:${role}:${opts && opts.name != null ? opts.name : ''}`),
    getByText: (t) => loc(`text:${t}`),
    getByLabel: (t) => loc(`label:${t}`),
    getByPlaceholder: (t) => loc(`ph:${t}`),
    getByTestId: (t) => loc(`testid:${t}`),
    locator: (sel) => loc(sel.startsWith('xpath=') ? sel : `css:${sel}`)
  };
}

const TARGET_ACTIONS = new Set(['fill', 'click', 'waitFor']);
const VALID_ACTIONS = new Set(['navigate', 'fill', 'click', 'scroll', 'waitFor', 'read']);
const VARS = { title: 'My Title', body: 'My Body Text', query: 'my query' };

(async () => {
  console.log('HEAVY backtest — recipes + flow_runner\n');

  const recipes = store.all();
  ok('recipe_store loaded ≥3 recipes', recipes.length >= 3);

  for (const recipe of recipes) {
    const tag = `${recipe.site}/${recipe.task}`;
    console.log(`\n── ${tag} (${recipe.steps.length} steps) ──`);

    // 1) STRUCTURE
    let structOk = Array.isArray(recipe.steps) && recipe.steps.length > 0;
    for (const s of (recipe.steps || [])) {
      if (!VALID_ACTIONS.has(s.action)) structOk = false;
      if (s.action === 'navigate' && !s.url) structOk = false;
      if (TARGET_ACTIONS.has(s.action) && !s.locator) structOk = false;
      if (s.locator && !keyOf(s.locator)) structOk = false;          // primary descriptor must be well-formed
      for (const fb of (s.fallbacks || [])) { if (!keyOf(fb)) structOk = false; }   // every fallback well-formed
    }
    ok(`${tag}: structurally valid`, structOk);

    const targeted = recipe.steps.map((s, i) => ({ s, i })).filter(x => TARGET_ACTIONS.has(x.s.action));

    // 2) FULL SUCCESS — every primary locator resolves
    {
      const present = new Set(targeted.map(x => keyOf(x.s.locator)).filter(Boolean));
      const p = mockPage({ present });
      const res = await flow.runRecipe(p, recipe, VARS, { detect: async () => null });
      ok(`${tag}: full success run (ran=${res.ran}/${recipe.steps.length}, healed=${res.healed})`, res.ok && res.ran === recipe.steps.length && res.healed === 0);
    }

    // 3) VAR SUBSTITUTION — navigations + fills carry the substituted values
    {
      const present = new Set(targeted.map(x => keyOf(x.s.locator)).filter(Boolean));
      const p = mockPage({ present });
      await flow.runRecipe(p, recipe, VARS, { detect: async () => null });
      // any navigate URL with {{...}} must be substituted (no leftover braces)
      const navOk = p.calls.filter(c => c[0] === 'goto').every(c => !/\{\{/.test(c[1]));
      ok(`${tag}: no unsubstituted {{vars}} in navigations`, navOk);
      // any fill whose recipe value referenced a var carries a non-empty value
      const fillSteps = recipe.steps.filter(s => s.action === 'fill' && /\{\{\w+\}\}/.test(s.value || ''));
      const fillsOk = fillSteps.length === 0 || p.calls.some(c => c[0] === 'fill' && c[2] && c[2].length > 0 && !/\{\{/.test(c[2]));
      ok(`${tag}: fills receive substituted values`, fillsOk);
    }

    // 4) HEAL — primary absent, first fallback (or role-only) present
    if (targeted.length) {
      const present = new Set();
      let canHeal = false;
      for (const x of targeted) {
        const fb = (x.s.fallbacks || [])[0];
        if (fb) { present.add(keyOf(fb)); canHeal = true; }
        else if (x.s.locator && x.s.locator.method === 'getByRole') { present.add(`role:${x.s.locator.role}:`); canHeal = true; }
      }
      if (canHeal) {
        const p = mockPage({ present });
        const res = await flow.runRecipe(p, recipe, VARS, { detect: async () => null });
        ok(`${tag}: heals via fallback / role-only re-derive (healed=${res.healed})`, res.ok && res.healed > 0);
      } else {
        ok(`${tag}: (no healable steps — skipped)`, true);
      }
    }

    // 5) TOTAL FAILURE — nothing resolves → fail localized at the first targeted step
    if (targeted.length) {
      const p = mockPage({ present: new Set() });
      const res = await flow.runRecipe(p, recipe, VARS, { detect: async () => null });
      ok(`${tag}: unresolvable → fails at first targeted step (${res.atStep})`, res.ok === false && res.atStep === targeted[0].i && /could not locate/.test(res.reason || ''));
    }

    // 6) BLOCKER — a needsHuman blocker on the first navigation pauses the recipe
    {
      const present = new Set(targeted.map(x => keyOf(x.s.locator)).filter(Boolean));
      const p = mockPage({ present });
      const res = await flow.runRecipe(p, recipe, VARS, { detect: async () => ({ type: 'login', needsHuman: true }) });
      const firstNav = recipe.steps.findIndex(s => s.action === 'navigate');
      const expectPause = firstNav !== -1;
      ok(`${tag}: blocker pauses${expectPause ? ` at nav step ${firstNav}` : ' (n/a — no nav)'}`,
        expectPause ? (res.ok === false && res.blocker && res.atStep === firstNav) : true);
    }
  }

  console.log('\n── adversarial buildLocator (no throws) ──');
  const mp = mockPage();
  ok('null descriptor → null', flow.buildLocator(mp, null) === null);
  ok('empty {} → null', flow.buildLocator(mp, {}) === null);
  ok('unknown method → null', flow.buildLocator(mp, { method: 'getByVibes' }) === null);
  ok('getByRole w/o role → no throw', (() => { try { flow.buildLocator(mp, { method: 'getByRole' }); return true; } catch { return false; } })());

  console.log('\n── subst edge cases ──');
  ok('multiple distinct vars', flow.subst('{{a}}-{{b}}', { a: '1', b: '2' }) === '1-2');
  ok('repeated var', flow.subst('{{x}}{{x}}', { x: 'z' }) === 'zz');
  ok('missing → empty', flow.subst('a{{m}}b', {}) === 'ab');
  ok('no vars passes through', flow.subst('plain text', {}) === 'plain text');
  ok('non-string returns input', flow.subst(null, {}) === null);

  console.log('\n── determinism stress (50× each recipe success path) ──');
  let stressOk = true;
  for (const recipe of recipes) {
    const targeted = recipe.steps.filter(s => TARGET_ACTIONS.has(s.action));
    const present = new Set(targeted.map(s => keyOf(s.locator)).filter(Boolean));
    for (let n = 0; n < 50; n++) {
      const res = await flow.runRecipe(mockPage({ present }), recipe, VARS, { detect: async () => null });
      if (!res.ok || res.ran !== recipe.steps.length) { stressOk = false; break; }
    }
  }
  ok(`50× per recipe all deterministic-OK`, stressOk);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
