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

// ---- coverage detection (Slice 2: todo fills in as portions complete) ----
const deliverable = '## Emergence Water\nThe leadership team and board includes CEO Jane Doe. Contact: emails and phones listed on the site.';
const cov = E.coveredFacets(deliverable, plan.facets);
ok('coveredFacets marks a facet the deliverable discusses', cov.includes('Leadership team and board') && cov.includes('Comprehensive contact information (emails, phones)'));
ok('coveredFacets does NOT mark an unmentioned facet', !cov.includes('Financial health and funding'));
ok('coveredFacets on empty text → []', E.coveredFacets('', plan.facets).length === 0);
ok('facetKeywords drops stopwords/short words', !E.facetKeywords('Leadership team and board of directors').includes('and') && E.facetKeywords('Leadership team and board of directors').includes('leadership'));
// the todo reflects coverage end-to-end
const liveMd = E.facetTodoMarkdown(plan, E.coveredFacets(deliverable, plan.facets));
ok('todo checks off exactly the covered facets', /- \[x\] Leadership team and board/.test(liveMd) && /- \[ \] Financial health and funding/.test(liveMd));

// ---- Puller contact sub-task checkoff (finish: the full tree fills in from deliverable content) ----
const contactsText = 'CEO Jane Doe, jane.doe@acme.com, (415) 555-0132. CFO John Roe.';
const subs = E.coveredSubtasks(contactsText);
ok('coveredSubtasks: a title → roster + title/role sub-tasks', subs.includes(E.PULLER_SUBTASKS[0]) && subs.includes(E.PULLER_SUBTASKS[3]));
ok('coveredSubtasks: a real email → email sub-task', subs.includes(E.PULLER_SUBTASKS[1]));
ok('coveredSubtasks: a phone number → phone sub-task', subs.includes(E.PULLER_SUBTASKS[2]));
ok('coveredSubtasks: confidence-grade is NOT auto-checked (Puller\'s job)', !subs.includes(E.PULLER_SUBTASKS[4]));
ok('coveredSubtasks: bare prose (no contacts) → none', E.coveredSubtasks('Acme makes water systems.').length === 0);
// end-to-end: the contacts sub-tree ticks in the rendered todo
const subMd = E.facetTodoMarkdown(plan, E.coveredFacets(contactsText, plan.facets).concat(E.coveredSubtasks(contactsText)));
ok('rendered sub-tree checks email+phone but leaves confidence-grade pending', /- \[x\] Per exec — email/.test(subMd) && /- \[x\] Per exec — phone/.test(subMd) && /- \[ \] Confidence-grade each/.test(subMd));

console.log(`\nsmoke_canvas_emit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
