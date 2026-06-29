/* Read-only orientation pass over the live chat logs. NO writes. */
const path = require('path');
const Database = require(path.join('C:/Users/azrae/Desktop/Side Quest/node_modules/better-sqlite3'));
const DB = 'C:/Users/azrae/Desktop/Side Quest/data/sq.db';
const db = new Database(DB, { readonly: true, fileMustExist: true });
const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ ERR: e.message }]; } };
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return { ERR: e.message }; } };
const day = "strftime('%Y-%m-%d', ts/1000, 'unixepoch','localtime')";

console.log('=== TABLE ROW COUNTS ===');
const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
for (const t of tables) { const c = one(`SELECT COUNT(*) n FROM "${t}"`); console.log(`  ${t.padEnd(28)} ${c.n}`); }

console.log('\n=== TURNS: span + by speaker ===');
console.log(one(`SELECT COUNT(*) total, MIN(ts) min, MAX(ts) max FROM turns`));
console.table(q(`SELECT speaker, COUNT(*) n, SUM(LENGTH(content)) chars FROM turns GROUP BY speaker ORDER BY n DESC`));

console.log('\n=== TURNS per day (by speaker) ===');
console.table(q(`SELECT ${day} d, speaker, COUNT(*) n FROM turns GROUP BY d, speaker ORDER BY d, speaker`));

console.log('\n=== SESSIONS ===');
console.log(one(`SELECT COUNT(*) sessions, MIN(started_at) first, MAX(started_at) last FROM sessions`));

console.log('\n=== MONOLOGUE: by type, total ===');
console.table(q(`SELECT type, COUNT(*) n, SUM(consolidated) consolidated, AVG(LENGTH(content)) avglen FROM monologue GROUP BY type ORDER BY n DESC`));
console.log('\n=== MONOLOGUE per day ===');
console.table(q(`SELECT ${day} d, COUNT(*) n FROM monologue GROUP BY d ORDER BY d`));

console.log('\n=== KNOWLEDGE: by kind / level / source ===');
console.table(q(`SELECT kind, COUNT(*) n FROM knowledge GROUP BY kind ORDER BY n DESC`));
console.table(q(`SELECT level, COUNT(*) n FROM knowledge GROUP BY level`));
console.table(q(`SELECT source, COUNT(*) n FROM knowledge GROUP BY source ORDER BY n DESC LIMIT 15`));
console.log('embeddings present:', one(`SELECT COUNT(*) n FROM knowledge WHERE embedding IS NOT NULL`).n, '/ total', one(`SELECT COUNT(*) n FROM knowledge`).n);

console.log('\n=== OPEN THREADS by status ===');
console.table(q(`SELECT status, COUNT(*) n FROM open_threads GROUP BY status ORDER BY n DESC`));

console.log('\n=== GRAPH ===');
console.log('entities:', one(`SELECT COUNT(*) n FROM graph_entities`).n, '| relations:', one(`SELECT COUNT(*) n FROM graph_relations`).n);
console.table(q(`SELECT status, COUNT(*) n FROM graph_entity_proposals GROUP BY status`));
console.table(q(`SELECT status, COUNT(*) n FROM graph_relation_proposals GROUP BY status`));

console.log('\n=== AGENT_EVENTS by kind ===');
console.table(q(`SELECT kind, COUNT(*) n FROM agent_events GROUP BY kind ORDER BY n DESC`));

db.close();
