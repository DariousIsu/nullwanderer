/* scripts/smoke_canvas_emit.js — offline checks for the Zoe Canvas DRIVE payload builders (pure node). */
'use strict';
const E = require('../studio/canvas_emit');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- tab key + title ----
ok('tabKeyForFocus deterministic', E.tabKeyForFocus(2027) === 'directed-2027' && E.tabKeyForFocus('x') === 'directed-x');
ok('tabTitleForGoal clips long goal', E.tabTitleForGoal('x'.repeat(200)).length <= 60 && E.tabTitleForGoal('x'.repeat(200)).endsWith('…'));
ok('tabTitleForGoal collapses whitespace', E.tabTitleForGoal('  hello   world \n there ') === 'hello world there');
ok('tabTitleForGoal empty fallback', E.tabTitleForGoal('') === 'Directed research' && E.tabTitleForGoal(null) === 'Directed research');

// ---- mode normalization ----
ok('mode passthrough', E.mode('RESEARCH') === 'RESEARCH' && E.mode('doc') === 'DOC');
ok('mode bad → DOC', E.mode('nonsense') === 'DOC' && E.mode(null) === 'DOC');

// ---- block payloads (shape must match saga add_block contract: {blockType, data}) ----
const org = E.orgSectionBlock('## Heritage Foundation\n- **Focus:** policy\n');
ok('orgSectionBlock is paragraph w/ trimmed markdown', org.blockType === 'paragraph' && /^## Heritage/.test(org.data.markdown) && !/\n$/.test(org.data.markdown));
const dos = E.dossierBlock('  # Dossier\n\nbody  ');
ok('dossierBlock is paragraph w/ trimmed markdown', dos.blockType === 'paragraph' && dos.data.markdown === '# Dossier\n\nbody');

// ---- count heading (heading renders today; metric_card would fall back) ----
const h = E.countHeading(18);
ok('countHeading is level-2 heading', h.blockType === 'heading' && h.data.level === 2 && h.data.text === '18 organizations researched');
ok('countHeading custom label', E.countHeading(3, 'people').data.text === '3 people researched');
ok('countHeading clamps junk to 0', E.countHeading(undefined).data.text === '0 organizations researched' && E.countHeading(-5).data.text === '0 organizations researched');

// ---- CONTRACT + TODO (Slice 1: contract starts the document) ----
ok('block ids stable', E.contractBlockId(3361) === 'contract-3361' && E.todoBlockId(3361) === 'todo-3361');

const plan = {
  objective: 'Deep brief + contacts for Emergence Water.',
  approach: 'Depth-first, KG then web + structured DBs.',
  estimate: '4-6 hours',
  databases: ['Echo KG', 'IRS 990', 'FEC'],
  targets: ['Emergence Water'],
  facets: ['Organizational mission', 'Leadership team and board', 'Comprehensive contact information (emails, phones)', 'Financial health and funding'],
};
const cb = E.contractBlock(plan, 'deep brief on Emergence Water');
ok('contractBlock is paragraph w/ objective+approach+estimate+sources', cb.blockType === 'paragraph'
  && /Objective:/.test(cb.data.markdown) && /Approach:/.test(cb.data.markdown) && /4-6 hours/.test(cb.data.markdown) && /Echo KG · IRS 990 · FEC/.test(cb.data.markdown));

ok('portionsFromPlan prefers facets', JSON.stringify(E.portionsFromPlan(plan)) === JSON.stringify(plan.facets));
ok('portionsFromPlan falls back to targets', JSON.stringify(E.portionsFromPlan({ targets: ['A', 'B'] })) === JSON.stringify(['A', 'B']));
ok('portionsFromPlan empty → []', E.portionsFromPlan({}).length === 0);

const md = E.facetTodoMarkdown(plan, []);
ok('todo has a Progress heading', /^## Progress/m.test(md));
ok('todo lists every facet as an unchecked box', plan.facets.every(f => md.includes(`- [ ] ${f}`)));
ok('contacts facet nests the Puller sub-tree (indented)', /\n {2}- \[ \] Per exec — email \(domain pattern → Hunter\/Apollo verify\)/.test(md));
ok('non-contact facet does NOT nest sub-tasks', !new RegExp(`- \\[ \\] Leadership team and board\\n {2}- \\[`).test(md));

const mdDone = E.facetTodoMarkdown(plan, ['Organizational mission']);
ok('todo checks off a completed portion', mdDone.includes('- [x] Organizational mission') && mdDone.includes('- [ ] Leadership team and board'));
ok('todo with no portions → pending placeholder', /\(plan pending\)/.test(E.facetTodoMarkdown({}, [])));

console.log(`\nsmoke_canvas_emit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
