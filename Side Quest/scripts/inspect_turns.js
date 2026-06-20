// READ-ONLY: recent user turns + recent agent_events, to see if the URL turn ran.
const db = require('../lib/db');
db.init();
const turns = db.getRecentTurns(12);
console.log('recent turns (oldest→newest):');
for (const t of turns) console.log(`  [${t.speaker}] ${(t.content || '').replace(/\s+/g, ' ').slice(0, 80)}`);
console.log('\nrecent agent_events:');
for (const e of db.getRecentAgentEvents(8)) console.log(`  [${e.source}/${e.kind}] ${(e.content || '').replace(/\s+/g, ' ').slice(0, 60)}`);
db.getDb().close();
