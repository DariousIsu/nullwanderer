/* SPIKE: maigret enrichment leaf — DRY RUN.
 * Pulls a small sample of real held contacts, derives candidate usernames, runs the maigret sidecar, and
 * writes the discovered public accounts to a SCRATCH file. Writes NOTHING to the Puller or CRM — this only
 * demonstrates the enrichment signal + shows what a real integration WOULD stage as low-grade observations.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/spike_maigret.js [sampleN]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const em = require('../lib/enrich_maigret');

const SAMPLE_N = parseInt(process.argv[2], 10) || 3;
const OUT = process.env.SPIKE_OUT || path.join(require('os').tmpdir(), 'maigret_spike_result.json');

// A few real held contacts (emailed → we can derive a username from the localpart) + a known-good control
// (soxoj, guaranteed to resolve) so the run always shows at least one positive hit end-to-end.
function sampleContacts() {
  const picked = [];
  try {
    const pdb = require('../lib/puller_db'); pdb.init();
    for (const t of pdb.listTargets({ limit: 100000 })) {
      const bl = pdb.listBeliefs(t.id) || [];
      const email = (bl.find((x) => x.type === 'email') || {}).value || null;
      if (email && email.includes('@')) picked.push({ name: t.name, email, company: t.company });
      if (picked.length >= SAMPLE_N) break;
    }
  } catch (e) { console.error('[spike] puller sample failed:', e.message); }
  return picked;
}

(async () => {
  const contacts = sampleContacts();
  const control = { name: 'soxoj (control)', email: 'soxoj@example.com', company: 'n/a' };
  const roster = [...contacts, control];

  console.log(`[spike] maigret DRY RUN — ${roster.length} contacts (${contacts.length} real + 1 control). NO Puller/CRM writes.\n`);

  const staged = [];   // what a real integration WOULD stage (as low-grade, verify-before-promote observations)
  for (const c of roster) {
    const usernames = c.name === 'soxoj (control)' ? ['soxoj'] : em.candidateUsernames(c).slice(0, 1);   // 1 candidate/contact to bound requests
    if (!usernames.length) { console.log(`- ${c.name}: no derivable username, skip`); continue; }
    process.stdout.write(`- ${c.name}  <${c.email}>  → try @${usernames.join(', @')} ... `);
    const res = await em.enrichUsernames(usernames, { topSites: 50, timeout: 8 });
    if (!res.ok) { console.log(`FAILED (${res.error})`); continue; }
    const accounts = (res.results || []).flatMap((r) => r.accounts.map((a) => ({ ...a, username: r.username })));
    console.log(`${accounts.length} account(s): ${accounts.map((a) => a.site).join(', ') || '—'}`);
    for (const a of accounts) staged.push({ contact: c.name, company: c.company, username: a.username, site: a.site, url: a.url, tags: a.tags, ids: a.ids, would_grade: 'E (unverified username match — verify before promote)' });
  }

  fs.writeFileSync(OUT, JSON.stringify({ ran_at: new Date().toISOString(), sample: roster.length, staged }, null, 2), 'utf8');
  console.log(`\n[spike] ${staged.length} discovered account(s) written to:\n  ${OUT}`);
  console.log('[spike] These are NOT persisted — a real leaf would stage each as a grade-E observation for verification.');
  process.exit(0);
})();
