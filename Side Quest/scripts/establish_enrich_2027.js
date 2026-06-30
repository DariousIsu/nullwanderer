/* Re-establish Lucas's red-tag task as an ENRICH / FACET-FILL run over the #2027 think-tank dossier.
 *
 * Background: the original red-tag ("expand the 21 right-of-center think tanks for their policy/public/
 * government-relations VPs + contacts, report in 8h") never executed — the discovery loop can only find
 * NEW orgs and its anti-loop blocks re-entering the 21. The enrich mode (lib/research.pickEnrichTarget +
 * buildEnrichPrompt, runEnrichResearchPass in main.js) fixes that: it walks the 21 KNOWN orgs and fills
 * ONE named facet across them. This script seeds that run deterministically (exact facet, no NL parsing).
 *
 * SAFE BY DEFAULT: dry-run unless you pass --go. Seeding mutates the real DB (creates a directed focus +
 * meta) and DISPLACES the current self-spawned musing focus. The driver runs inside the live app, so:
 *   1) run with --go,  2) REBOOT the app — boot's directed-resume starts the enrich driver on it.
 *
 * Run (dry):  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/establish_enrich_2027.js
 * Run (go):   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/establish_enrich_2027.js --go
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const cd = require('../lib/condense');

const GO = process.argv.includes('--go');
const SOURCE_FOCUS_ID = 2027;
const DOSSIER = path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes', `directed-${SOURCE_FOCUS_ID}-dossier.md`);
// Lucas's exact intent, pinned (turns 04:04 + 04:07): policy / public / government relations VPs + contacts.
const FACET = 'VPs (and equivalent senior leaders) of policy, public affairs, and government/legislative relations. For EACH, give full name, exact title, and direct contact details (work email, phone, LinkedIn).';

(async () => {
  db.init();

  if (!fs.existsSync(DOSSIER)) { console.error('[establish] dossier not found:', DOSSIER); process.exit(1); }
  const dossier = fs.readFileSync(DOSSIER, 'utf8');
  const orgs = cd.dossierOrgs(dossier);
  if (!orgs.length) { console.error('[establish] no orgs parsed from dossier'); process.exit(1); }

  const priorGoal = (() => { try { const t = db.getOpenThread(SOURCE_FOCUS_ID); return t ? t.content : ''; } catch { return ''; } })();
  const goal = `Enrich the existing research on ${orgs.length} organization(s) by filling, FOR EACH, this facet: ${FACET} These orgs are already documented — deepen them, do NOT find new ones.${priorGoal ? ` (Deepens: "${String(priorGoal).slice(0, 140)}".)` : ''}`.slice(0, 780);

  console.log(`\nENRICH re-establish over #${SOURCE_FOCUS_ID}`);
  console.log(`  orgs (${orgs.length}): ${orgs.join(', ')}`);
  console.log(`  facet: ${FACET}`);
  console.log(`  goal: ${goal.slice(0, 160)}…`);

  if (!GO) {
    console.log('\n[dry-run] nothing written. Re-run with --go to seed, then reboot the app to start the driver.');
    process.exit(0);
  }

  const fl = require('../lib/focus');
  const r = await fl.setFromDirective(goal, null);
  if (!r || !r.focus) { console.error('[establish] setFromDirective failed'); process.exit(1); }
  const fid = r.focus.id;
  db.setMeta(`focus.${fid}.mode`, 'enrich');
  db.setMeta(`focus.${fid}.enrich_facet`, FACET);
  db.setMeta(`focus.${fid}.enrich_orgs`, JSON.stringify(orgs));
  db.setMeta(`focus.${fid}.enrich_source`, String(SOURCE_FOCUS_ID));
  db.setMeta(`focus.${fid}.covered`, '[]');
  db.setMeta(`focus.${fid}.file`, `notes/directed-${fid}.md`);
  db.setMeta('research.last_referenced_focus_id', String(fid));

  console.log(`\n[established] enrich focus #${fid} seeded (mode=enrich, ${orgs.length} orgs).`);
  console.log('NEXT: reboot the app — boot directed-resume will start the enrich driver on this focus.');
  process.exit(0);
})();
