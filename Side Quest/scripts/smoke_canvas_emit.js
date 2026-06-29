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

console.log(`\nsmoke_canvas_emit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
