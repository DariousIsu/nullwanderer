/* scripts/probe_promote.js — verify the AUTO-PROMOTE pathway end-to-end against live Echo:
 * propose_entity(event) -> promote_proposal -> it's now a PUBLIC civic_graph event -> LINKED_TO edge attaches.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_promote.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);
const j = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

(async () => {
  let token = null; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: 'http://127.0.0.1:8765/mcp/', token }) });
  const c = await suit.connect(); L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0);
  const d = (name, args) => suit.dispatch({ kind: 'do', name, args });

  // tool registered?
  L('promote_proposal tool present: ' + /promote_proposal/.test(JSON.stringify(await d('get_tool_map', { grouping: 'flat' }).then(r => r.text).catch(() => ''))));

  // a real worthy story from the bucket (read-only)
  const D = require('better-sqlite3');
  const bucket = new D(path.join(SQ, 'data', 'news_bucket.db'), { readonly: true });
  const story = bucket.prepare("SELECT id,title,summary,source_count FROM news_stories WHERE source_count>=8 AND (status='open' OR status='closed') ORDER BY source_count DESC, last_ts DESC LIMIT 1").get();
  bucket.close();
  L(`\nSTORY #${story.id} src=${story.source_count}: "${String(story.title).slice(0, 80)}"`);

  // 1) propose the event
  const pe = j(await d('propose_entity', { name: story.title, entity_type: 'event', summary: story.summary || '' }));
  L('1) propose_entity → ' + JSON.stringify(pe));
  const proposalId = pe && pe.entity_id;

  // 2) PROMOTE (the new tool) — a fresh 'proposed' OR an existing 'already_proposed' both carry a proposal id.
  let promotedId = null;
  if (pe && (pe.action === 'proposed' || pe.action === 'already_proposed') && proposalId != null) {
    const pr = j(await d('promote_proposal', { proposal_id: proposalId }));
    L('2) promote_proposal → ' + JSON.stringify(pr));
    promotedId = pr && (pr.promoted_id || pr.merged_into);
  } else if (pe && pe.action === 'already_exists') { promotedId = pe.entity_id; L('2) (already a public entity)'); }

  // 3) is it now a PUBLIC event object?
  const se = j(await d('search_entities', { query: story.title, entity_type: 'event', top_k: 3 }));
  const rows = (se && (se.result || se)) || [];
  const found = rows.find(e => String(e.name) === String(story.title));
  L('3) search_entities(event) → ' + (found ? `PUBLIC event id=${found.id} type=${found.entity_type}` : 'NOT FOUND as public event'));

  // 4) edge it to a principal (proper noun from title). Attaches iff the principal is also public.
  const princ = (String(`${story.title}. ${story.summary || ''}`).match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [])[0];
  if (princ) {
    const rel = j(await d('propose_relation', { source_name: story.title, target_name: princ, relation_type: 'LINKED_TO' }));
    L(`4) propose_relation(event → "${princ}", LINKED_TO) → ` + JSON.stringify(rel));
  } else L('4) no proper-noun principal in title to edge');

  L('\nVERDICT: ' + (found ? 'PROMOTE PATHWAY WORKS — proposal became a public event object.' : 'promote pathway INCOMPLETE — inspect above.'));
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
