/* Smoke: lib/canvas_ingest — the drop→ingest brain. Proves we recognize a DROPPED document (vs Zoe's
 * own emitted tab), dedup against the ingested set, pull text out of the canvas blocks, clean the title,
 * and cage the understanding prompt. Pure: no model/file/db/http. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_canvas_ingest.js
 */
'use strict';
const ci = require('../lib/canvas_ingest');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- isIngestableTab: only "drop-" tabs, never her own "directed-" emits ---
ok(ci.isIngestableTab({ tab_key: 'drop-rainey-huddle-abc' }) === true, '"drop-" tab is ingestable');
ok(ci.isIngestableTab({ tab_key: 'directed-2609' }) === false, 'her own "directed-" emit is NOT ingestable');
ok(ci.isIngestableTab({ key: 'drop-x' }) === true, 'accepts .key as well as .tab_key');
ok(ci.isIngestableTab({}) === false && ci.isIngestableTab(null) === false, 'no key → not ingestable (no throw)');

// --- newDropTabs: new dropped tabs minus the seen set ---
const snap = {
  tabs: [
    { tab_key: 'drop-rainey-huddle-abc', title: '**📝 Notes**', opened_at: 1782841456 },
    { tab_key: 'directed-2609', title: 'think tanks' },               // her own → skip
    { tab_key: 'drop-budget-xls-def', title: 'Q3 Budget' },
  ],
  blocks_by_tab: {
    'drop-rainey-huddle-abc': [{ type: 'paragraph', data: { markdown: '# Notes\n\nRainey Weekly Huddle — invited Clark Powers.' } }],
  },
};
const fresh1 = ci.newDropTabs(snap, []);
ok(fresh1.length === 2 && fresh1.every(t => t.tabKey.indexOf('drop-') === 0), 'newDropTabs returns only the dropped tabs (skips directed-)');
ok(fresh1[0].title === '**📝 Notes**', 'descriptor carries the raw title');
const fresh2 = ci.newDropTabs(snap, ['drop-rainey-huddle-abc']);
ok(fresh2.length === 1 && fresh2[0].tabKey === 'drop-budget-xls-def', 'already-ingested tab is deduped out');
ok(ci.newDropTabs(snap, ['drop-rainey-huddle-abc', 'drop-budget-xls-def']).length === 0, 'all seen → nothing new');
ok(ci.newDropTabs({}, []).length === 0 && ci.newDropTabs(null, []).length === 0, 'bad snapshot → [] (no throw)');

// --- blockText / extractMarkdown: pull text from varied block shapes ---
ok(ci.blockText({ data: { markdown: 'hello' } }) === 'hello', 'blockText reads data.markdown');
ok(ci.blockText({ data: { text: 'plain' } }) === 'plain', 'blockText falls back to data.text');
ok(ci.blockText({ content: 'raw' }) === 'raw', 'blockText falls back to content');
ok(ci.blockText(null) === '', 'blockText null → "" (no throw)');
const md = ci.extractMarkdown([{ data: { markdown: 'A' } }, { data: { text: 'B' } }, { data: {} }]);
ok(md === 'A\n\nB', 'extractMarkdown joins non-empty blocks, drops empties');
ok(ci.extractMarkdown([]) === '' && ci.extractMarkdown(null) === '', 'extractMarkdown empty → "" (no throw)');

// --- cleanTitle: strip markdown + emoji noise ---
ok(ci.cleanTitle('**📝 Notes**') === 'Notes', 'cleanTitle strips bold + emoji');
ok(ci.cleanTitle('## Rainey Huddle') === 'Rainey Huddle', 'cleanTitle strips heading marks');
ok(ci.cleanTitle('') === 'Untitled document', 'empty title → "Untitled document"');

// --- buildUnderstandingPrompt: caged + grounded ---
const up = ci.buildUnderstandingPrompt({ title: 'Rainey Huddle', markdown: 'Invited Clark Powers.' });
ok(Array.isArray(up) && up.length === 2, 'understanding prompt is a system+user pair');
ok(/Ground ONLY in the document|never invent/i.test(up[0].content), 'understanding prompt is grounded (no invention)');
ok(/people\/organizations\/dates|action items|decisions/i.test(up[0].content), 'understanding prompt asks for people/dates/actions');
ok(/Rainey Huddle/.test(up[1].content) && /Clark Powers/.test(up[1].content), 'understanding prompt carries the title + content');

// --- ingestNote: readable memory content ---
const note = ci.ingestNote({ title: '**📝 Notes**', understanding: 'Weekly huddle notes naming Clark Powers.', markdown: 'raw...' });
ok(/dropped on my canvas — "Notes"/.test(note) && /Clark Powers/.test(note), 'ingestNote names the doc + carries the understanding');
ok(/raw\.\.\./.test(ci.ingestNote({ title: 'X', understanding: '', markdown: 'raw...' })), 'ingestNote falls back to the source when no understanding');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
