/* Smoke: lib/contact_cascade (runContactCascade) — ordered finder cascade + Puller escalation.
 * Pure/deterministic (finders are injected fakes). Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contact_cascade.js
 */
const { runContactCascade } = require('../lib/contact_cascade');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const person = { name: 'Greg Upton', surname: 'Upton', org: 'LSU Center for Energy Studies', domain: 'lsu.edu' };
const F = (name, val) => ({ name, run: async () => (val ? { value: val, source: name } : null) });
const THROW = (name) => ({ name, run: async () => { throw new Error('boom'); } });

(async () => {
  // FIRST hit wins, in order — puller-db bridge beats web.
  let r = await runContactCascade(person, { finders: [F('pullerdb', 'g.upton@lsu.edu'), F('web', 'other@x.com')] });
  ok(r && r.value === 'g.upton@lsu.edu' && r.via === 'pullerdb', 'first grounded finder wins (puller-db bridge before web)');

  // Order matters: a nulling earlier finder falls through to a later hit.
  r = await runContactCascade(person, { finders: [F('pullerdb', null), F('pattern', null), F('web', 'greg.upton@lsu.edu')] });
  ok(r && r.value === 'greg.upton@lsu.edu' && r.via === 'web', 'falls through nulls to the web finder');
  ok(r && r.tried.join(',') === 'pullerdb,pattern,web', 'tried list records the order attempted');

  // A finder that THROWS is skipped, not fatal — the cascade continues.
  r = await runContactCascade(person, { finders: [THROW('pattern'), F('web', 'upton@lsu.edu')] });
  ok(r && r.value === 'upton@lsu.edu', 'a throwing finder is caught + skipped (one bad tool never sinks the row)');

  // TOTAL MISS → escalate called with the person, returns null (cell stays blank, never fabricated).
  let escalatedWith = null;
  r = await runContactCascade(person, { finders: [F('pullerdb', null), F('web', null)], escalate: async (p) => { escalatedWith = p; } });
  ok(r === null, 'total miss → returns null (leave the cell blank — no fabrication)');
  ok(escalatedWith && escalatedWith.name === 'Greg Upton', 'total miss → escalated the person to the Puller');

  // Escalation failure is non-fatal and still returns null (never a fabricated value).
  r = await runContactCascade(person, { finders: [F('web', null)], escalate: async () => { throw new Error('puller down'); } });
  ok(r === null, 'escalate throwing is swallowed → still null, never a fake');

  // A hit does NOT escalate (no wasted Puller seed when we already found it).
  let seeded = false;
  r = await runContactCascade(person, { finders: [F('web', 'a@b.com')], escalate: async () => { seeded = true; } });
  ok(r && r.value === 'a@b.com' && seeded === false, 'a hit short-circuits — no needless Puller escalation');

  // TRANSIENT tool error (finder throws {transient:true}) + no hit → {retry:true}, and does NOT escalate
  // (a blip must not blank OR mis-escalate a findable contact).
  const TX = { name: 'hunter', run: async () => { throw Object.assign(new Error('echo unreachable'), { transient: true }); } };
  let esc2 = false;
  r = await runContactCascade(person, { finders: [F('pullerdb', null), TX, F('web', null)], escalate: async () => { esc2 = true; } });
  ok(r && r.retry === true, 'transient tool error + no hit → { retry: true } (defer, do not blank)');
  ok(esc2 === false, 'transient → NOT escalated (retry later instead of a Puller seed)');

  // A transient that is nonetheless followed by a real hit still returns the hit (retry only on total miss).
  r = await runContactCascade(person, { finders: [TX, F('web', 'x@y.com')] });
  ok(r && r.value === 'x@y.com', 'a hit after a transient finder still wins (retry only when nothing found)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
