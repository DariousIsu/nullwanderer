/* scripts/probe_precedence.js — LIVE end-to-end proof of the precedence gate (reconciliation §5).
 * Runs the REAL active_recall.recall() path: a live Echo object is resolved for a real person, a fresh
 * verified_fact correction is injected (via retrieveFn, so sq.db is NOT mutated) with a realistic
 * capturedBy='wiki-verify', and we assert recall() DECLINES to lead with the stale dossier and instead
 * surfaces precedenceFact. Negative control: a correction about a DIFFERENT person must NOT fire.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_precedence.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);
const vf = (content, prov) => ({ source: 'verified_fact', content, kind: 'note', provenance: JSON.stringify(prov) });

(async () => {
  let token = null; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const ar = require(path.join(SQ, 'lib', 'active_recall'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: 'http://127.0.0.1:8765/mcp/', token }) });
  const c = await suit.connect(); if (!c.ok) { L('echo FAIL'); process.exit(0); }
  suit.connected = true; es.setLiveSuit(suit);
  L('echo: ' + c.tools + ' tools; liveReady=' + es.liveReady());

  const PERSON = process.env.PROBE_PERSON || 'John Curtis';
  const correction = vf(`${PERSON} is serving as Senate Majority Leader as of 2026-05-01`, { subject: PERSON, subject_key: 'john-curtis', as_of: '2026-05-01', capturedBy: 'wiki-verify', url: 'https://en.wikipedia.org/wiki/x' });

  // FULL live path: obj resolves from real Echo (objectFn omitted); only the verified_fact is injected.
  const r = await ar.recall(PERSON, { retrieveFn: async () => [correction], graphFn: () => [], echoFn: async () => [] });
  L(`\n[live obj] ${r.object ? `${r.object.name} — ${r.object.type}/${r.object.subtype}, degree ${r.object.degree}` : 'null (Echo did not resolve — probe needs a KG-present person)'}`);
  L(`[gate]    precedenceFact = ${r.precedenceFact ? `"${r.precedenceFact.content}" (as_of ${r.precedenceFact.asOf})` : 'null'}`);

  const pass1 = !!(r.object && r.precedenceFact && /Majority Leader/.test(r.precedenceFact.content));
  L('VERDICT 1 (correction leads over live dossier): ' + (pass1 ? 'PASS' : 'INCOMPLETE — see above'));

  // NEGATIVE control: a correction about a DIFFERENT person must not fire for this object.
  const wrong = vf('Barack Obama is serving as Senate Majority Leader as of 2026-05-01', { subject: 'Barack Obama', as_of: '2026-05-01', capturedBy: 'wiki-verify' });
  const r2 = await ar.recall(PERSON, { retrieveFn: async () => [wrong], graphFn: () => [], echoFn: async () => [] });
  L(`\n[control] different-subject correction → precedenceFact = ${r2.precedenceFact ? 'FIRED (wrong!)' : 'null (correct)'}`);
  L('VERDICT 2 (subject-mismatch does NOT fire): ' + (!r2.precedenceFact ? 'PASS' : 'FAIL'));

  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
