/**
 * Backtest — recorder.js, OFFLINE (mock elements, no browser, no model).
 * Validates the record-by-demonstration core: in-page descriptor computation, the
 * primary/fallback build + ordering, event→step mapping, credential redaction, the
 * dedupe/collapse rules, recipe assembly (runner-shaped + verified:false), slugify,
 * and no-clobber save. The same descriptor logic runs in-page during live capture.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const rec = require('../lib/recorder');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Minimal DOM-ish element mock. Supports the surface computeDescriptor touches:
// nodeType, tagName, getAttribute, textContent, isContentEditable, className,
// ownerDocument.querySelector (for label[for]), closest, and parent/sibling for xpath.
function el({ tag = 'div', attrs = {}, text = '', contentEditable = false, labelFor = null, className = '' } = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    textContent: text,
    isContentEditable: contentEditable,
    className,
    getAttribute: (a) => (a in attrs ? attrs[a] : (a === 'class' ? className : null)),
    closest: () => null,
    previousSibling: null,
    parentNode: null,
    ownerDocument: { querySelector: (sel) => (labelFor && sel.includes(`for="${attrs.id}"`)) ? { textContent: labelFor } : null }
  };
  return node;
}

(async () => {
  console.log('Backtest — recorder.js (offline)\n');

  console.log('computeDescriptor (durable, accessibility-first):');
  const btn = rec.computeDescriptor(el({ tag: 'button', text: 'Publish now' }));
  ok('button → role button, name from text', btn.role === 'button' && btn.name === 'Publish now');
  const link = rec.computeDescriptor(el({ tag: 'a', attrs: { href: '/x' }, text: 'Continue' }));
  ok('a[href] → role link', link.role === 'link' && link.name === 'Continue');
  const input = rec.computeDescriptor(el({ tag: 'input', attrs: { type: 'text', placeholder: 'Title' } }));
  ok('input → role textbox + placeholder', input.role === 'textbox' && input.placeholder === 'Title');
  const aria = rec.computeDescriptor(el({ tag: 'button', attrs: { 'aria-label': 'Close dialog' }, text: 'x' }));
  ok('aria-label wins over text for name', aria.name === 'Close dialog');
  const labeled = rec.computeDescriptor(el({ tag: 'input', attrs: { id: 'email', type: 'email' }, labelFor: 'Email address' }));
  ok('label[for] supplies the accessible name', labeled.name === 'Email address');
  const pw = rec.computeDescriptor(el({ tag: 'input', attrs: { type: 'password', placeholder: 'Password' } }));
  ok('password input flagged isPassword', pw.isPassword === true);
  const tid = rec.computeDescriptor(el({ tag: 'button', attrs: { 'data-testid': 'submit-btn' }, text: 'Go' }));
  ok('data-testid captured', tid.testid === 'submit-btn');
  ok('non-element → null', rec.computeDescriptor({ nodeType: 3 }) === null);

  console.log('\nbuildDescriptor (primary preference + fallback ordering):');
  const d1 = rec.buildDescriptor({ role: 'button', name: 'Publish now', testid: 'pub', css: 'button.pub', text: 'Publish now' });
  ok('role+name is primary', d1.primary.method === 'getByRole' && d1.primary.name === 'Publish now');
  ok('fallbacks carry testid + css (heal order)', d1.fallbacks.some(f => f.method === 'getByTestId') && d1.fallbacks.some(f => f.css));
  ok('primary not duplicated into fallbacks', !d1.fallbacks.some(f => f.method === 'getByRole' && f.name === 'Publish now'));
  const d2 = rec.buildDescriptor({ role: 'textbox', name: '', placeholder: 'Title', css: 'input#t' });
  ok('no role+name → placeholder is primary', d2.primary.method === 'getByPlaceholder' && d2.primary.placeholder === 'Title');
  const d3 = rec.buildDescriptor({ role: '', name: '', css: 'div.card', text: 'Pick me' });
  ok('only css/text → css primary, text fallback', d3.primary.css === 'div.card' && d3.fallbacks.some(f => f.text === 'Pick me'));
  ok('nothing usable → null', rec.buildDescriptor({}) === null);

  console.log('\nisSecret (no credentials in recipes):');
  ok('password field is secret', rec.isSecret({ isPassword: true }));
  ok('name "Password" is secret', rec.isSecret({ name: 'Password' }));
  ok('plain title field is not secret', rec.isSecret({ name: 'Title', placeholder: 'Title' }) === false);

  console.log('\neventToStep:');
  const navStep = rec.eventToStep({ kind: 'navigate', url: 'https://substack.com/publish/post' });
  ok('navigate → navigate step', navStep.action === 'navigate' && navStep.url === 'https://substack.com/publish/post');
  const clickStep = rec.eventToStep({ kind: 'click', info: { role: 'button', name: 'Continue', css: 'button.c' } });
  ok('click → click step w/ locator', clickStep.action === 'click' && clickStep.locator.name === 'Continue');
  const fillStep = rec.eventToStep({ kind: 'fill', info: { role: 'textbox', placeholder: 'Title' }, value: 'My Post' });
  ok('fill → fill step carries value', fillStep.action === 'fill' && fillStep.value === 'My Post');
  const secretStep = rec.eventToStep({ kind: 'fill', info: { isPassword: true, placeholder: 'Password' }, value: 'hunter2' });
  ok('fill on password → value scrubbed + needsHuman', secretStep.value === '' && secretStep.needsHuman === true);
  ok('unusable element event → null', rec.eventToStep({ kind: 'click', info: {} }) === null);

  console.log('\ndedupeSteps (collapse + click-induced nav fold):');
  const collapsed = rec.dedupeSteps([
    { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: 'Hel' },
    { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: 'Hello' }
  ]);
  ok('consecutive fills on same target collapse to last value', collapsed.length === 1 && collapsed[0].value === 'Hello');
  const folded = rec.dedupeSteps([
    { action: 'navigate', url: 'https://s/publish' },
    { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: 'x' },
    { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Publish' } },
    { action: 'navigate', url: 'https://s/published' }
  ]);
  ok('leading navigate kept as the open', folded[0].action === 'navigate' && folded[0].url === 'https://s/publish');
  ok('post-click navigate folds into mayNavigate (not its own step)', !folded.some(s => s.url === 'https://s/published') && folded[folded.length - 1].mayNavigate === true);

  console.log('\nassembleRecipe (runner-shaped, provisional):');
  const recipe = rec.assembleRecipe({
    site: 'substack.com', task: 'publish_post', source: 'demonstration', firstUrl: 'https://substack.com/publish/post',
    steps: [
      { action: 'navigate', url: 'https://substack.com/publish/post' },
      { action: 'fill', locator: { method: 'getByPlaceholder', placeholder: 'Title' }, value: 'T' },
      { action: 'click', locator: { method: 'getByRole', role: 'button', name: 'Publish' } }
    ]
  });
  ok('verified:false (provisional)', recipe.verified === false);
  ok('source recorded', recipe.source === 'demonstration');
  ok('fingerprint from first url host', recipe.fingerprint && recipe.fingerprint.url_pattern === 'substack.com');
  // structurally valid for flow_runner
  const VALID = new Set(['navigate', 'fill', 'click', 'scroll', 'waitFor', 'read']);
  const shaped = recipe.steps.every(s => VALID.has(s.action) && (s.action !== 'navigate' || s.url) && (!['fill', 'click', 'waitFor'].includes(s.action) || s.locator));
  ok('every step is runner-shaped', shaped);

  console.log('\nslugify:');
  ok('strips scheme/tld/punct', rec.slugify('substack.com', 'publish_post') === 'substack_publish_post');
  ok('handles bare host + spaces', rec.slugify('https://www.notion.so', 'New Page') === 'notion_new_page');

  console.log('\nactionStepCount (passive auto-save gate):');
  const single = rec.newSession({ site: 's', task: 't', source: 'passive' });
  rec.pushNavigate(single, 'https://s/', 1);
  rec.pushElement(single, { role: 'button', name: 'X' }, 'click', undefined, 2);
  ok('a single click is below the multi-step bar', rec.actionStepCount(single) === 1);

  console.log('\nfinalize (session → recipe via core):');
  const sess = rec.newSession({ site: 'notion.so', task: 'new_doc', source: 'passive' });
  rec.pushNavigate(sess, 'https://notion.so/', 10);
  rec.pushElement(sess, { role: 'button', name: 'New page' }, 'click', undefined, 20);
  rec.pushElement(sess, { role: 'textbox', placeholder: 'Untitled' }, 'fill', 'Hello', 30);
  const fin = rec.finalize(sess);
  ok('finalize yields a provisional recipe with the captured steps', fin.verified === false && fin.steps.length === 3 && fin.steps[1].locator.name === 'New page');
  ok('session marked inactive after finalize', sess.active === false);

  console.log('\nsave (no-clobber of a VERIFIED recipe):');
  const tmp = path.join(os.tmpdir(), `sq_rec_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const r1 = rec.save(fin, { stem: 'notion_new_doc', dir: tmp });
  ok('writes the recipe json', r1.ok && fs.existsSync(r1.file));
  // now plant a VERIFIED recipe at the same stem → next save must shadow, not overwrite.
  fs.writeFileSync(path.join(tmp, 'notion_new_doc.json'), JSON.stringify({ site: 'notion.so', task: 'new_doc', verified: true, steps: [{ action: 'navigate', url: 'https://notion.so' }] }), 'utf8');
  const r2 = rec.save(fin, { stem: 'notion_new_doc', dir: tmp });
  ok('verified recipe is shadowed, not clobbered', r2.ok && r2.shadowed === true && /\.recorded\.json$/.test(r2.file));
  const stillVerified = JSON.parse(fs.readFileSync(path.join(tmp, 'notion_new_doc.json'), 'utf8'));
  ok('original verified recipe untouched', stillVerified.verified === true);
  ok('empty recipe refused', rec.save({ site: 's', task: 't', steps: [] }, { dir: tmp }).ok === false);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log('\nbuildInitScript (injectable, self-contained):');
  const script = rec.buildInitScript();
  ok('inlines computeDescriptor + binding name', script.includes('computeDescriptor') && script.includes(rec.BINDING));
  ok('guards against double-install', script.includes('__sqRecInstalled'));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
