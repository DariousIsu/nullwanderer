// READ-ONLY live inspection of the running app's DB (WAL concurrent read).
const db = require('../lib/db');
db.init();
const ev = db.getRecentAgentEvents(10);
console.log(`agent_events (blackboard) rows recent: ${ev.length}`);
for (const e of ev) console.log(`  [${e.source}/${e.kind}] focus=${e.focus_id || '-'}  ${(e.content || '').replace(/\s+/g, ' ').slice(0, 55)}`);
console.log('\nrecent thoughts w/ importance:');
for (const m of db.getRecentMonologueByType('thought', 5)) console.log(`  imp=${m.importance == null ? '-' : m.importance}  ${(m.content || '').replace(/\s+/g, ' ').slice(0, 60)}`);
console.log('\ncurrent_focus_id:', db.getMeta('current_focus_id') || '(none)');
console.log('reflection_importance_accum:', db.getMeta('reflection_importance_accum') || '0');
console.log('active threads:', db.getActiveOpenThreads(50).length, '| open capability gaps:', db.getOpenCapabilityGaps(20).length);
db.getDb().close();
