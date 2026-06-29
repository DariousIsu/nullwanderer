/* Read-only deep audit — failure signatures. NO writes. */
const path = require('path');
const Database = require(path.join('C:/Users/azrae/Desktop/Side Quest/node_modules/better-sqlite3'));
const db = new Database('C:/Users/azrae/Desktop/Side Quest/data/sq.db', { readonly: true, fileMustExist: true });
const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ ERR: e.message }]; } };
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return { ERR: e.message }; } };

console.log('=== 1. SPIRAL SIGNAL: consecutive identical signatures in agent_events (thought/utterance) ===');
const ev = q(`SELECT id, kind, signature FROM agent_events WHERE kind IN ('thought','utterance') AND signature IS NOT NULL ORDER BY id`);
let maxRun = 0, runs3 = 0, runs5 = 0, cur = 1;
for (let i = 1; i < ev.length; i++) {
  if (ev[i].signature === ev[i-1].signature) { cur++; if (cur === 3) runs3++; if (cur === 5) runs5++; if (cur > maxRun) maxRun = cur; }
  else cur = 1;
}
console.log(`  events scanned: ${ev.length} | longest identical run: ${maxRun} | runs hitting >=3: ${runs3} | >=5: ${runs5}`);

console.log('\n=== 2. MOST-REPEATED THOUGHT SIGNATURES (what she loops on) ===');
console.table(q(`SELECT COUNT(*) n, substr(MIN(content),1,90) sample FROM agent_events WHERE kind='thought' AND signature IS NOT NULL GROUP BY signature ORDER BY n DESC LIMIT 12`));

console.log('\n=== 3. MONOLOGUE near-dup: thoughts sharing first 80 chars ===');
console.table(q(`SELECT n, substr(head,1,80) head FROM (SELECT substr(content,1,80) head, COUNT(*) n FROM monologue WHERE type='thought' GROUP BY head HAVING n > 2) ORDER BY n DESC LIMIT 12`));

console.log('\n=== 4. SELF-EVOLUTION churn (the "my view evolved" rows) ===');
console.log(one(`SELECT COUNT(*) total, COUNT(DISTINCT substr(content,1,40)) distinct_heads FROM knowledge WHERE source='self_evolution'`));
console.table(q(`SELECT COUNT(*) n, substr(content,1,100) sample FROM knowledge WHERE source='self_evolution' GROUP BY substr(content,1,50) ORDER BY n DESC LIMIT 6`));

console.log('\n=== 5. KNOWLEDGE accretion per day + quarantine share ===');
console.table(q(`SELECT strftime('%Y-%m-%d', created_ts/1000,'unixepoch','localtime') d, COUNT(*) n FROM knowledge GROUP BY d ORDER BY d`));
const total = one(`SELECT COUNT(*) n FROM knowledge`).n;
const quar = one(`SELECT COUNT(*) n FROM knowledge WHERE source IN ('focus_tombstone','reflection_speculation')`).n;
console.log(`  quarantined (scanned every retrieve, never surfaced): ${quar}/${total} = ${(100*quar/total).toFixed(1)}%`);

console.log('\n=== 6. END-OF-DAY signature: thought:said ratio + avg thought len by session-start hour ===');
console.table(q(`
  SELECT start_hour, COUNT(*) sessions, SUM(thoughts) thoughts, SUM(saids) saids,
         ROUND(1.0*SUM(thoughts)/NULLIF(SUM(saids),0),2) thought_per_said,
         ROUND(AVG(avg_thought_len)) avg_thought_len
  FROM (
    SELECT s.id,
      CAST(strftime('%H', s.started_at/1000,'unixepoch','localtime') AS INT) start_hour,
      SUM(CASE WHEN t.speaker='ai_thought' THEN 1 ELSE 0 END) thoughts,
      SUM(CASE WHEN t.speaker='ai_said' THEN 1 ELSE 0 END) saids,
      AVG(CASE WHEN t.speaker='ai_thought' THEN LENGTH(t.content) END) avg_thought_len
    FROM sessions s JOIN turns t ON t.session_id = s.id GROUP BY s.id
  ) GROUP BY start_hour ORDER BY start_hour`));

console.log('\n=== 7. GRAPH cap + entity growth per day ===');
console.log('  entities:', one(`SELECT COUNT(*) n FROM graph_entities`).n, '(topFacts hard-caps ranking at 500)');
console.table(q(`SELECT strftime('%Y-%m-%d', created_at/1000,'unixepoch','localtime') d, COUNT(*) n FROM graph_entities GROUP BY d ORDER BY d`));
console.log('  pending entity proposals (never adjudicated):', one(`SELECT COUNT(*) n FROM graph_entity_proposals WHERE status='pending'`).n);

console.log('\n=== 8. LONGEST sessions by turn count (where context pressure peaks) ===');
console.table(q(`SELECT s.id, strftime('%m-%d %H:%M', s.started_at/1000,'unixepoch','localtime') started,
  COUNT(t.id) turns, SUM(CASE WHEN t.speaker='user' THEN 1 ELSE 0 END) user_turns
  FROM sessions s JOIN turns t ON t.session_id=s.id GROUP BY s.id ORDER BY turns DESC LIMIT 8`));

db.close();
