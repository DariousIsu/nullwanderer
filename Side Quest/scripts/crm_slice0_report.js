/* crm_slice0_report.js — CRM Unification, SLICE 0: measure + gate. STRICTLY READ-ONLY.
 *
 * Spec: docs/CRM_UNIFICATION_DESIGN.md §8. This slice writes NOTHING to any store. It answers the
 * questions the drain's safety depends on, BEFORE Slice 1 touches Echo's schema:
 *
 *   A. REAL-PERSON GATE   — of the 328,665 Puller targets, how many are actually organizations
 *                           (PACs, committees, campaigns) that must NOT be forced into the person CRM?
 *                           Resolves design-doc open question #2 (the 35,273 ALL-CAPS rows).
 *   B. DEDUP COLLISION    — how many Puller targets already exist in the CRM's 110,319, and — the
 *                           safety number — how many match AMBIGUOUSLY (one name → several contacts).
 *                           That population is where a name-only merge would fuse two real people.
 *   C. ENRICHMENT VALUE   — what the 495,012 beliefs would actually fill in the CRM's empty columns.
 *   D. LA PARISH SUBSET   — the Slice 2 payoff input, measured on its own.
 *
 * Both databases are opened READ-ONLY and Puller is STREAMED via .iterate() — never a full-population
 * SELECT * (the e71afdf freeze lesson). No ATTACH: the join is done in JS so neither file can be
 * written by this process under any code path.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/crm_slice0_report.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PULLER_DB = process.env.PULLER_DB_PATH || path.join(__dirname, '..', 'data', 'puller.db');
const CRM_DB = process.env.CRM_DB_PATH || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/electoral.db';
const OUT = process.argv[2] || null;

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const num = (n) => Number(n).toLocaleString('en-US');

// ---------- name normalization (the dedup key) ----------
const SUFFIX = /\b(jr|sr|ii|iii|iv|v|phd|md|esq|dds|jd)\b/g;
function normName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')          // strip "[3041fb9b]" dedup tags seen live in the CRM
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// last + first-initial: the standard blocking key. Deliberately NOT a full-name equality test —
// we want to COUNT how coarse keys collide, which is exactly the risk the rails must cover.
function blockKey(first, last) {
  const f = normName(first), l = normName(last);
  if (!l) return null;
  return `${l}|${f.charAt(0) || ''}`;
}

// ---------- A. the real-person classifier (pure, testable) ----------
const ORG_STRONG = /\b(pac|committee|campaign|victory fund|for congress|for senate|for governor|for president|for america|friends of|inc|llc|l\.l\.c|corp|corporation|foundation|association|institute|society|council|coalition|alliance|partners|partnership|group|holdings|trust|fund|llp|ltd|company|co|university|college|department|agency|bureau|commission|authority|district|board)\b/i;
const ORG_HINT = /\b(the|of|for|and)\b.*\b(of|for)\b/i;   // "Association of X for Y" phrasing
function classifyTarget(name, company) {
  const n = String(name || '').trim();
  if (!n) return 'empty';
  if (ORG_STRONG.test(n)) return 'organization';
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return 'single-token';           // ambiguous: a mononym or a fragment
  if (tokens.length > 5) return 'likely-organization';      // people rarely have 6+ name tokens
  const isCaps = n === n.toUpperCase() && n.length > 4;
  if (isCaps && ORG_HINT.test(n)) return 'likely-organization';
  if (isCaps) return 'caps-person';                          // ALL-CAPS but person-shaped
  return 'person';
}

function main() {
  for (const [label, p] of [['puller', PULLER_DB], ['crm', CRM_DB]]) {
    if (!fs.existsSync(p)) { console.error(`FATAL: ${label} db not found at ${p}`); process.exit(2); }
  }
  const pdb = new Database(PULLER_DB, { readonly: true, fileMustExist: true });
  const cdb = new Database(CRM_DB, { readonly: true, fileMustExist: true });

  say('='.repeat(78));
  say('CRM UNIFICATION — SLICE 0 REPORT (read-only)');
  say(`generated: ${new Date().toISOString()}`);
  say(`puller: ${PULLER_DB}`);
  say(`crm:    ${CRM_DB}`);
  say('='.repeat(78));

  // ---------- CRM index (built once, streamed) ----------
  say('\n── building CRM index ──');
  const crmLive = cdb.prepare("SELECT COUNT(*) n FROM contact WHERE deleted=0 AND merged_into IS NULL").get().n;
  const byBlock = new Map();        // blockKey → [{id, state, kind}]
  let crmIndexed = 0;
  for (const r of cdb.prepare("SELECT id, FirstName, LastName, MailingState, State_Represented, Contact_Kind__c FROM contact WHERE deleted=0 AND merged_into IS NULL").iterate()) {
    const k = blockKey(r.FirstName, r.LastName);
    if (!k) continue;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push({ id: r.id, state: r.MailingState || r.State_Represented || null, kind: r.Contact_Kind__c || null });
    crmIndexed++;
  }
  say(`CRM live contacts: ${num(crmLive)} · indexed on last+first-initial: ${num(crmIndexed)} · distinct keys: ${num(byBlock.size)}`);
  const collidingKeys = [...byBlock.values()].filter((v) => v.length > 1).length;
  say(`⚠ CRM keys that ALREADY hold >1 contact: ${num(collidingKeys)} (${pct(collidingKeys, byBlock.size)}) — a name-only merge is unsafe on these`);

  // ---------- A. real-person gate ----------
  say('\n── A. REAL-PERSON GATE (Puller, streamed) ──');
  const cls = new Map();
  const samples = new Map();
  const capsSamples = [];
  let pullerLive = 0;
  for (const t of pdb.prepare("SELECT name, company FROM targets WHERE merged_into IS NULL").iterate()) {
    pullerLive++;
    const c = classifyTarget(t.name, t.company);
    cls.set(c, (cls.get(c) || 0) + 1);
    if (!samples.has(c)) samples.set(c, []);
    const s = samples.get(c);
    if (s.length < 6) s.push(`${t.name}${t.company ? ` — ${t.company}` : ''}`);
    if (c === 'caps-person' && capsSamples.length < 12) capsSamples.push(`${t.name}${t.company ? ` — ${t.company}` : ''}`);
  }
  say(`Puller live targets: ${num(pullerLive)}`);
  for (const [k, v] of [...cls.entries()].sort((a, b) => b[1] - a[1])) {
    say(`  ${k.padEnd(20)} ${String(num(v)).padStart(9)}  ${pct(v, pullerLive).padStart(6)}`);
    for (const s of (samples.get(k) || []).slice(0, 3)) say(`      · ${s.slice(0, 84)}`);
  }
  const notPeople = (cls.get('organization') || 0) + (cls.get('likely-organization') || 0);
  say(`\n⭐ GATE VERDICT: ${num(notPeople)} (${pct(notPeople, pullerLive)}) route to ORG, not the person CRM.`);
  say(`   'caps-person' = ${num(cls.get('caps-person') || 0)} — ALL-CAPS but person-shaped (design-doc open question #2):`);
  for (const s of capsSamples) say(`      · ${s.slice(0, 84)}`);

  // ---------- B. dedup collision ----------
  say('\n── B. DEDUP COLLISION vs the CRM ──');
  let noKey = 0, fresh = 0, one = 0, many = 0, oneStateOk = 0, oneStateConflict = 0;
  const ambiguous = [];
  for (const t of pdb.prepare("SELECT name, company FROM targets WHERE merged_into IS NULL").iterate()) {
    const n = normName(t.name);
    const parts = n.split(' ').filter(Boolean);
    if (parts.length < 2) { noKey++; continue; }
    const k = `${parts[parts.length - 1]}|${parts[0].charAt(0)}`;
    const hit = byBlock.get(k);
    if (!hit) { fresh++; continue; }
    if (hit.length === 1) {
      one++;
      const st = hit[0].state;
      if (st && t.company && String(t.company).toUpperCase().includes(st)) oneStateOk++;
      else oneStateConflict++;
    } else {
      many++;
      if (ambiguous.length < 10) ambiguous.push(`${t.name} → ${hit.length} CRM contacts share key "${k}"`);
    }
  }
  const considered = pullerLive - noKey;
  say(`unusable name (no 2-token key): ${num(noKey)}`);
  say(`NEW to the CRM (no key match):  ${num(fresh)}  (${pct(fresh, considered)} of usable) → these MINT`);
  say(`matched exactly ONE contact:     ${num(one)}  (${pct(one, considered)}) → candidate merges`);
  say(`  …of those, state corroborates: ${num(oneStateOk)} · unverified by state: ${num(oneStateConflict)}`);
  say(`⚠ matched MANY contacts:         ${num(many)}  (${pct(many, considered)}) → MUST be held, never auto-merged`);
  for (const a of ambiguous) say(`      · ${a.slice(0, 90)}`);
  say(`\n⭐ SAFETY: ${num(many + oneStateConflict)} of ${num(considered)} (${pct(many + oneStateConflict, considered)}) cannot be safely`);
  say(`   auto-merged on name alone. This is why Slice 1's crosswalk (strong ids) comes FIRST.`);

  // ---------- C. enrichment value ----------
  say('\n── C. ENRICHMENT VALUE (Puller beliefs → empty CRM columns) ──');
  const beliefTotal = pdb.prepare("SELECT COUNT(*) n FROM beliefs").get().n;
  say(`beliefs: ${num(beliefTotal)}  (status vocabulary is a single value, 'active' — confidence is the quality signal)`);
  // ⭐ OBSERVED vs INFERRED is the promotion-critical split. A `pattern:`/`doc:pattern:` derivation means
  // the value was GUESSED from a company's email shape (first.last@domain), not read off a source. Landing
  // those in the CRM as real values would launder inference into fact across the ultimate store — and this
  // is a store we send mail from. They must arrive as CANDIDATES (Email_Quality_Score__c), never as Email.
  const INFERRED = "(derivation LIKE '%pattern%')";   // 'pattern:first.last' AND 'doc:pattern' (no trailing colon)
  say('by type — observed vs pattern-inferred:');
  for (const r of pdb.prepare(`SELECT type, COUNT(*) n, SUM(CASE WHEN ${INFERRED} THEN 1 ELSE 0 END) inferred, SUM(CASE WHEN confidence>=0.7 THEN 1 ELSE 0 END) conf7 FROM beliefs GROUP BY type ORDER BY n DESC LIMIT 12`).iterate()) {
    const obs = r.n - (r.inferred || 0);
    say(`  ${String(r.type || '(null)').padEnd(10)} total ${String(num(r.n)).padStart(9)} │ OBSERVED ${String(num(obs)).padStart(9)} │ inferred ${String(num(r.inferred || 0)).padStart(8)} (${pct(r.inferred || 0, r.n)}) │ conf≥0.7 ${num(r.conf7 || 0)}`);
  }
  say('  top derivations:');
  for (const r of pdb.prepare("SELECT type, derivation, COUNT(*) n FROM beliefs GROUP BY type, derivation ORDER BY n DESC LIMIT 8").iterate()) {
    say(`    ${String(r.type).padEnd(9)} ${String(r.derivation || '(none)').slice(0, 28).padEnd(30)} ${num(r.n)}`);
  }
  const crmGaps = cdb.prepare("SELECT SUM(CASE WHEN Email IS NULL OR Email='' THEN 1 ELSE 0 END) noEmail, SUM(CASE WHEN Phone IS NULL OR Phone='' THEN 1 ELSE 0 END) noPhone, SUM(CASE WHEN AccountId IS NULL THEN 1 ELSE 0 END) noOrg FROM contact WHERE deleted=0 AND merged_into IS NULL").get();
  say(`\nCRM gaps the beliefs target: no Email ${num(crmGaps.noEmail)} · no Phone ${num(crmGaps.noPhone)} · no Org ${num(crmGaps.noOrg)}`);

  // ---------- D. LA parish subset (the Slice 2 payoff) ----------
  say('\n── D. LA PARISH SUBSET (Slice 2 payoff input) ──');
  const pWhere = "(name LIKE '%parish%' OR company LIKE '%parish%' OR notes LIKE '%parish%' OR company LIKE '%police jury%') AND merged_into IS NULL";
  const parishN = pdb.prepare(`SELECT COUNT(*) n FROM targets WHERE ${pWhere}`).get().n;
  say(`Puller parish-related targets: ${num(parishN)}`);
  const pcls = new Map();
  let withTitle = 0;
  for (const t of pdb.prepare(`SELECT name, company, notes FROM targets WHERE ${pWhere}`).iterate()) {
    const c = classifyTarget(t.name, t.company);
    pcls.set(c, (pcls.get(c) || 0) + 1);
    if (t.notes && String(t.notes).trim()) withTitle++;
  }
  for (const [k, v] of [...pcls.entries()].sort((a, b) => b[1] - a[1])) say(`  ${k.padEnd(20)} ${String(num(v)).padStart(6)}`);
  say(`  with a title/role in notes: ${num(withTitle)} (${pct(withTitle, parishN)}) — name+title+parish is the sheet Lucas asked for`);
  const parishInCrm = cdb.prepare("SELECT COUNT(*) n FROM contact WHERE deleted=0 AND merged_into IS NULL AND (Title LIKE '%Parish%' OR Chamber__c LIKE '%Parish%' OR Notes_Public__c LIKE '%Police Jury%')").get().n;
  say(`  …same people currently in the CRM: ${num(parishInCrm)}`);

  say('\n' + '='.repeat(78));
  say('SLICE 0 COMPLETE — nothing was written to any store.');
  say('='.repeat(78));

  pdb.close(); cdb.close();
  if (OUT) { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); console.log(`\n[report written → ${OUT}]`); }
}

main();
