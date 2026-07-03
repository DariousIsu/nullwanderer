/* scripts/probe_prominence.js — verify the R1 PROMINENCE gate end-to-end against LIVE Echo + Wikidata:
 *   1. the KG resolves a bare famous name ("John F. Kennedy") to a QID-less state-senator namesake,
 *   2. the Wikidata sitelink probe finds the far-more-prominent same-name human,
 *   3. prominenceCheck → MISMATCH with a ready IDENTITY note (answer-famous + footnote-namesake),
 *   4. CONTROLS: a genuine local-only record and a QID-bearing federal figure → 'ok' (no false decline).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_prominence.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

(async () => {
  let token = null; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: 'http://127.0.0.1:8765/mcp/', token }) });
  const c = await suit.connect(); L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0);
  const d = (tag) => suit.dispatch(tag);

  // ── 1. the raw Wikidata sitelink probe ─────────────────────────────────────────────────────────────
  const p = await es.prominenceProbe('John F. Kennedy', { dispatch: d });
  L(`\n[probe] "John F. Kennedy" → ${p.found ? `Q=${p.qid} sitelinks=${p.sitelinks} — "${p.description}"` : 'NOT FOUND'}`);

  // ── 2. what the KG resolves the bare name to (the namesake bug) ─────────────────────────────────────
  const obj = await es.recallObject('John F. Kennedy', { dispatch: d, maxNeighbors: 0, preferType: 'person' });
  L(`[kg]    recallObject → ${obj ? `${obj.name} — ${obj.type}/${obj.subtype}, degree ${obj.degree}, qid=${obj.wikidata_qid || 'null'}` : 'null'}`);

  // ── 3. the gate verdict on the live pair ────────────────────────────────────────────────────────────
  if (obj) {
    const pc = await es.prominenceCheck('John F. Kennedy', obj, { dispatch: d });
    L(`[gate]  verdict = ${pc.status}`);
    if (pc.status === 'mismatch') L(`[note]  ${pc.note}`);
    L('\nVERDICT: ' + (pc.status === 'mismatch' && /president/i.test(pc.note || '')
      ? 'PROMINENCE GATE WORKS — bare famous name declines the civic namesake, answers the President, footnotes the state senator.'
      : 'INCOMPLETE — inspect above (expected a mismatch declining the state senator).'));
  }

  // ── 4. CONTROLS — must NOT false-decline legitimate civic records ───────────────────────────────────
  L('\n── controls (must resolve to "ok", i.e. keep the KG record) ──');
  for (const [name, why] of [['Robyn K. Kennedy', 'genuine local-only state senator (no famous namesake)'], ['Timothy Kennedy', 'federal figure that carries a Wikidata QID']]) {
    try {
      const o = await es.recallObject(name, { dispatch: d, maxNeighbors: 0, preferType: 'person' });
      if (!o) { L(`  • ${name}: KG has no record — skipped (${why})`); continue; }
      const v = await es.prominenceCheck(name, o, { dispatch: d });
      const flag = v.status === 'ok' ? 'OK  ' : 'DECLINED';
      L(`  • ${name}: ${o.name} (${o.subtype || '?'}, qid=${o.wikidata_qid || 'null'}) → ${flag}  [${why}]`);
    } catch (e) { L(`  • ${name}: ERR ${e.message}`); }
  }

  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
