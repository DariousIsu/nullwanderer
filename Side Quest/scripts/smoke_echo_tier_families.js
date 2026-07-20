/* smoke_echo_tier_families.js — the research lane can read public data sources again.
 *
 * Live 2026-07-20, repeatedly:
 *   [echo] routeNeed tier-gate BLOCKED legistar_list_persons (write, autonomous=true)
 *
 * A list-only call against a public legislative portal, blocked from the autonomous research lane.
 * READ_RE is prefix-anchored on generic verbs plus a hand-picked set of source families; whole
 * families (legistar_, uk_, openparliament_, nhtsa_, epa_, fema_, treasury_, uspto_ …) were never
 * added, so they fell to the safe default of 'write'. Measured on a 119-tool slice: 116 'write',
 * 1 'read'. The lane Lucas wants to be smartest was cut off from ~100 civic data sources, silently —
 * a blocked tool logs and moves on.
 *
 * ⭐ The family prefix alone is NOT enough, and the first version of this fix got it wrong: WRITE_RE
 * is prefix-anchored, so `uk_delete_thing` matched the family, missed WRITE_RE, and was admitted as
 * a read. A family says "this source is external", not "this call cannot mutate". Both halves are
 * asserted here, because the widening direction is the one that can do damage.
 */
'use strict';
const tier = require('../lib/echo_tier');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the live failure, and the families that were shut out ───────────────────────────────────────
{
  const reads = [
    'legistar_list_persons',      // the exact blocked call
    'legistar_search_matters', 'legistar_event_items',
    'openparliament_votes', 'abgeordnetenwatch_politicians', 'br_camara_deputies',
    'uk_search_bills', 'uk_police_street_crime',
    'epa_echo_facilities', 'fema_search_disasters', 'nhtsa_decode_vin', 'uspto_search_patents',
    'treasury_query', 'rxnorm_find_drugs', 'pubchem_search_compound', 'openaq_measurements',
    'openlibrary_search_books', 'hackernews_top', 'nager_date_holidays', 'shodan_host_lookup',
  ];
  for (const n of reads) ok(tier.classifyTool(n) === 'read', `${n} is a READ`);
  for (const n of reads) ok(tier.allowedOnAuto(n) === true, `${n} is usable unattended`);
}

// ── ⭐ SAFETY: a mutating verb inside a read family must still block ─────────────────────────────
// These do not exist today. They are the shape of a tool Echo could add tomorrow, and the reason
// this is an allowlist plus a verb check rather than a prefix match.
{
  const hypothetical = ['uk_delete_thing', 'epa_save_record', 'uk_submit_form',
    'legistar_create_matter', 'fema_upload_doc', 'shodan_run_scan', 'treasury_post_entry',
    'rxnorm_update_drug', 'openaq_send_report'];
  for (const n of hypothetical) {
    ok(tier.classifyTool(n) !== 'read', `LEAK: ${n} must not be admitted as a read`);
    ok(tier.allowedOnAuto(n) === false, `${n} stays blocked unattended`);
  }
}

// ── the existing gate is untouched ──────────────────────────────────────────────────────────────
{
  ok(tier.classifyTool('merge_entities') === 'write', 'Echo-internal merge still WRITE');
  ok(tier.classifyTool('delete_relation') === 'write', 'delete still WRITE');
  ok(tier.classifyTool('save_document') === 'write', 'save still WRITE');
  ok(tier.classifyTool('ingest_file') === 'write', 'ingest still WRITE');
  ok(tier.classifyTool('os_click') === 'write', 'desktop control still WRITE');
  ok(tier.classifyTool('browser_click') === 'write', 'browser session writes still WRITE');
  ok(tier.classifyTool('spawn_agent') === 'heavy', 'agent spawning still HEAVY');
  ok(tier.classifyTool('send_email') === 'locked', 'email send still LOCKED');
  ok(tier.classifyTool('generate_image') === 'locked', 'image gen still LOCKED');
  ok(tier.classifyTool('propose_entity') === 'propose', 'propose_* still its own tier');
  ok(tier.classifyTool('') === 'locked', 'empty name is locked, not read');
  ok(tier.classifyTool('some_unknown_thing_v3') === 'write',
    'REGRESSION: the safe default survives — unknown is still treated as mutating');
}

// ── ordering: an Echo-internal mutation always wins over a family match ──────────────────────────
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echo_tier.js'), 'utf8');
  const w = src.indexOf('if (WRITE_RE.test(n)) return \'write\'');
  const f = src.indexOf('READ_FAMILY_RE.test(n)');
  ok(w > 0 && f > w, 'WRITE_RE is evaluated BEFORE the family allowlist');
  ok(/READ_FAMILY_RE\.test\(n\) && !MUTATING_VERB_RE\.test\(n\)/.test(src),
    'the family match is conjoined with the mutating-verb check, not standalone');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
