/* Smoke: ENRICH / FACET-FILL mode — the pure logic that makes "expand the 21 think tanks FOR THEIR
 * policy/gov-relations VPs + contacts" actually re-enter the known orgs and fill that facet, instead of
 * the discovery loop drifting into NEW orgs (the live #2027 failure). Pure: no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_enrich.js
 */
'use strict';
const rs = require('../lib/research');
const cd = require('../lib/condense');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- pickEnrichTarget: walk the source list, skip already-enriched (case-insensitive), stop when done ---
const orgs = ['Heritage Foundation', 'Cato Institute', 'R Street Institute', 'AEI'];
ok(rs.pickEnrichTarget({ sourceOrgs: orgs, enriched: [] }) === 'Heritage Foundation', 'first pass picks the first source org');
ok(rs.pickEnrichTarget({ sourceOrgs: orgs, enriched: ['Heritage Foundation'] }) === 'Cato Institute', 'skips the one already enriched');
ok(rs.pickEnrichTarget({ sourceOrgs: orgs, enriched: ['heritage foundation', 'CATO INSTITUTE'] }) === 'R Street Institute', 'skip match is case-insensitive');
ok(rs.pickEnrichTarget({ sourceOrgs: orgs, enriched: orgs }) === null, 'all enriched → null (run terminates)');
ok(rs.pickEnrichTarget({ sourceOrgs: [], enriched: [] }) === null, 'empty work-list → null (fail-safe)');
ok(rs.pickEnrichTarget({}) === null, 'no args → null (fail-safe)');

// --- facetLabel: short, clean header field name ---
ok(rs.facetLabel('VPs of policy and government relations') === 'VPs of policy and government relations', 'short facet → used as-is');
ok(/…$/.test(rs.facetLabel('vice presidents of policy, public affairs, and government relations, plus their direct work emails and phone numbers')), 'long facet → truncated with ellipsis');
ok(rs.facetLabel('') === 'Findings', 'empty facet → "Findings" default');

// --- buildEnrichPrompt: org is FIXED, single facet, no discovery, grounding + no-placeholder rules ---
const ep = rs.buildEnrichPrompt({ goal: 'enrich the think tanks', org: 'Cato Institute', facet: 'policy VPs + contacts', guidance: '' });
ok(/Cato Institute/.test(ep) && /policy VPs \+ contacts/.test(ep), 'enrich prompt names the org AND the facet');
ok(/NOT looking for new organizations/i.test(ep), 'enrich prompt forbids discovering new orgs');
ok(/never invent/i.test(ep) && /not found/i.test(ep) && /NEVER use initials/i.test(ep), 'enrich prompt keeps grounding + no-placeholder discipline');

// --- buildOrganizeEnrichPrompt: clean facet-scoped section, exact org heading ---
const op = rs.buildOrganizeEnrichPrompt({ org: 'Heritage Foundation', facet: 'policy VPs', raw: 'Roger Severino — VP of domestic policy, rseverino@heritage.org' });
ok(Array.isArray(op) && op.length === 2 && /## Heritage Foundation/.test(op[0].content), 'organize prompt emits the exact "## Org" heading');
ok(/Roger Severino/.test(op[1].content), 'organize prompt carries the raw findings');
ok(/never add a name/i.test(op[0].content) && /not found/i.test(op[0].content), 'organize prompt stays grounded');

// --- detectEnrichFacet: an attribute-for-each clause => enrich; a bare deepen => not ---
ok(cd.detectEnrichFacet('expand the think tank research for their policy VPs and contacts') !== '', '"for their policy VPs" → facet detected');
ok(/government relations|VP/i.test(cd.detectEnrichFacet('get the government relations VPs for each of them')), '"government relations VPs for each" → facet text captured');
ok(cd.detectEnrichFacet('find the press contacts at all of them') !== '', '"press contacts at all of them" → facet detected');
ok(cd.detectEnrichFacet('anything having to do with policy or public or government relations, any VPs') !== '', "Lucas's actual phrasing → facet detected");
ok(cd.detectEnrichFacet('expand that research') === '', 'bare "expand that research" → NO facet (stays discovery)');
ok(cd.detectEnrichFacet('go deeper on the think tanks') === '', 'bare "go deeper" → NO facet (stays discovery)');

// --- detectExpandOrder carries the facet through ---
const ex1 = cd.detectExpandOrder('expand the think tank research for their policy and government relations VPs');
ok(ex1.isExpand === true && ex1.enrichFacet !== '', 'expand order WITH facet → isExpand + enrichFacet set (→ ENRICH path)');
const ex2 = cd.detectExpandOrder('expand that research');
ok(ex2.isExpand === true && ex2.enrichFacet === '', 'expand order WITHOUT facet → isExpand, no facet (→ discovery path)');
ok(cd.detectExpandOrder('what restaurants are nearby').isExpand === false, 'non-expand → isExpand false');

// --- dossierOrgs: the "## Org" headings become the work-list, header sections skipped ---
const dossier = `# Directed research deliverable\n\n## Summary\nblah\n\n## Heritage Foundation\n- Focus: x\n\n## Cato Institute\n- Focus: y\n\n## Gaps\n- missing contacts`;
const dorgs = cd.dossierOrgs(dossier);
ok(dorgs.length === 2 && dorgs[0] === 'Heritage Foundation' && dorgs[1] === 'Cato Institute', 'dossierOrgs pulls real orgs, skips Summary/Gaps');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
