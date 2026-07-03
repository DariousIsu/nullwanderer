/* scripts/probe_systemic.js — is each of the two hard-battery edges an ISOLATED case or a SYSTEMIC layer bug?
 * Tests the CLASS, not the one case that failed, per the standing "stop whack-a-mole" principle.
 *   A) RESOLUTION: does recallObject pick a record WITH office edges, or a high-degree FEC finance node with
 *      none? Probe across many prominent politicians. Systemic if many resolve to an edge-less finance node.
 *   B) ESCALATION: for many "current office holder" questions, which tier answers + is it right/stale?
 *      Systemic if many stop at wiki with a stale/description answer before excavation.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_systemic.js [--a] [--b]
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(SQ, 'data', '_probe_systemic.db');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

const POLITICIANS = ['Donald Trump', 'Joe Biden', 'Kamala Harris', 'Marco Rubio', 'Ron DeSantis', 'Gavin Newsom', 'Barack Obama', 'JD Vance', 'Lee Zeldin', 'Pete Hegseth'];
const OFFICE_Q = [
  ['Secretary of Defense', 'hegseth', ['austin', 'lloyd']],
  ['Secretary of State', 'rubio', ['blinken']],
  ['Attorney General', 'bondi', ['garland']],
  ['Secretary of the Treasury', 'bessent', ['yellen']],
  ['EPA administrator', 'zeldin', ['regan']],
  ['Chair of the Federal Reserve', 'powell', []],
];

(async () => {
  require(path.join(SQ, 'lib', 'db')).init();
  try { require(path.join(SQ, 'lib', 'keystore')).hydrateFromEcho(['OLLAMA_API_KEY'], { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD }); } catch {}
  let token = null, port = 8765; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: `http://127.0.0.1:${port}/mcp/`, token }) });
  const c = await suit.connect(); L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0); es.setLiveSuit(suit);
  const d = (tag) => suit.dispatch(tag);
  const only = process.argv.slice(2);
  const doA = !only.length || only.includes('--a'); const doB = !only.length || only.includes('--b');

  // helper: count HELD_OFFICE edges (current + all) for an entity id
  async function officeEdges(id) {
    if (!id) return { held: 0, current: 0, offices: [] };
    const rel = await es.relatedEntities(id, { dispatch: d, limit: 50 });
    const held = rel.filter(r => r.relation === 'HELD_OFFICE');
    return { held: held.length, current: held.filter(h => h.current).length, offices: held.slice(0, 3).map(h => (h.name || '').replace(/\s*\[[^\]]*\]/g, '') + (h.current ? '*' : '')), total: rel.length };
  }
  // helper: top candidate records for a name, by degree
  async function candidates(name) {
    try {
      const r = await d({ kind: 'do', name: 'db_query', args: { sql: `SELECT id,name,entity_type et,entity_subtype est,degree FROM entities WHERE name LIKE '%' || ? || '%' ORDER BY degree DESC LIMIT 6`, params: [name.split(' ').pop()] } });
      const j = JSON.parse(r.text); return (j && j.rows) || [];
    } catch { return []; }
  }

  if (doA) {
    L('\n════ A) RESOLUTION — does recallObject land a record WITH office edges? ════');
    let edgeless = 0, betterPassed = 0;
    for (const name of POLITICIANS) {
      const obj = await es.recallObject(name, { preferType: 'person', maxNeighbors: 0 });
      const pick = obj ? `${obj.name} #${obj.id} deg=${obj.degree} [${obj.type}/${obj.subtype || ''}]` : '∅';
      const oe = obj ? await officeEdges(obj.id) : { held: 0, current: 0, offices: [] };
      // is there a sibling record (same surname) with MORE office edges that was passed over?
      const cands = await candidates(name); let bestOther = null;
      for (const cand of cands.slice(0, 5)) {
        if (!cand.id || cand.id === (obj && obj.id)) continue;
        const ce = await officeEdges(cand.id);
        if (ce.current > 0 && (!bestOther || ce.current > bestOther.current)) bestOther = { ...cand, ...ce };
      }
      const flagEdgeless = oe.current === 0;
      const flagPassed = flagEdgeless && bestOther;
      if (flagEdgeless) edgeless++;
      if (flagPassed) betterPassed++;
      L(`  ${name.padEnd(16)} → ${pick}`);
      L(`      office-edges: held=${oe.held} current=${oe.current} ${oe.offices.length ? '(' + oe.offices.join(', ') + ')' : ''}${flagEdgeless ? '  ⚠ EDGELESS' : ''}`);
      if (bestOther) L(`      PASSED OVER: ${bestOther.name} #${bestOther.id} deg=${bestOther.degree} current-offices=${bestOther.current} (${bestOther.offices.join(', ')})${flagPassed ? '  ⚠ better record existed' : ''}`);
    }
    L(`\n  A verdict: ${edgeless}/${POLITICIANS.length} resolved to an EDGELESS record; ${betterPassed}/${POLITICIANS.length} had a better office-bearing sibling PASSED OVER.`);
    L(`  → ${betterPassed >= 3 ? 'SYSTEMIC (degree-ranking is fooled across the political class)' : betterPassed <= 1 ? 'EDGE (isolated; degree-ranking is fine in general)' : 'MIXED — inspect'}`);
  }

  if (doB) {
    L('\n════ B) ESCALATION — which tier answers "current office" Qs, and is it right? ════');
    const cog = require(path.join(SQ, 'lib', 'cognition'));
    const ad = require(path.join(SQ, 'lib', 'answer_draft')), ar = require(path.join(SQ, 'lib', 'active_recall'));
    await require(path.join(SQ, 'lib', 'ner')).warm();
    let staleStop = 0;
    for (const [office, right, stale] of OFFICE_Q) {
      const q = `Who is the current US ${office}?`;
      let say = '', src = '—';
      try {
        const r = await ar.recall(q, { k: 3 });
        const grounding = ad.factualGrounding({ knowledgeBlock: ar._objectLines(r.object).join('\n') });
        const res = await cog.answerGrounded({ userMessage: q, grounding, object: r.object, deps: { excavate: async () => null } }); // excavate STUBBED OFF to expose what the cheaper tiers alone produce
        src = res ? (res.enriched ? res.enrichSource : (res.missed ? 'MISS' : 'grounded')) : 'null';
        say = res ? res.say : '(null)';
      } catch (e) { say = 'ERR ' + e.message; }
      const s = say.toLowerCase();
      const isRight = s.includes(right);
      const isStale = stale.some(x => s.includes(x));
      const verdict = isRight ? '✓ right' : isStale ? '✗ STALE' : s.includes("couldn't") || s.includes('pin down') ? '· honest-miss' : '? other';
      if (isStale || (verdict === '? other' && !isRight)) staleStop++;
      L(`  ${office.padEnd(28)} (${src.padEnd(8)}) ${verdict}`);
      L(`      ${say.replace(/\s+/g, ' ').slice(0, 150)}`);
    }
    L(`\n  B note: excavate STUBBED OFF here on purpose — this exposes what wiki/routed/web alone yield.`);
    L(`  ${staleStop}/${OFFICE_Q.length} produced a STALE/wrong answer from the cheaper tiers (would be caught only if excavate always runs for currency Qs).`);
    L(`  → if most are STALE without excavate, the fix is: currency Qs must not TERMINATE on a cheaper-tier answer before excavate/verify.`);
  }
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
