/* scripts/backfill_civic.js — one-off: the rosters ALREADY researched into prose deliverables,
 * lifted into civic_bodies/civic_memberships (docs/CIVIC_BODY_SCHEMA_DESIGN.md slice 3).
 *
 * DRY RUN BY DEFAULT. Writes nothing until run with --apply, per Lucas's gate.
 *
 * ── WHY THIS IS DETERMINISTIC AND NOT A MODEL PASS ────────────────────────────────────────────
 * The fabrication risk IS the whole risk: asking a model to read prose and emit rosters invents
 * plausible people. Measured before writing this — her deliverables already carry the rosters as
 * markdown TABLES (| Name | Title/Role | Party | Email |) followed by a bound *(source: URL)*.
 * So nothing needs inferring: we read the table she already wrote and the citation she already
 * bound to it. Every name still passes civic_capture.looksLikeName (the page-furniture screen),
 * and rows land as source_kind='backfill_prose' — visibly weaker than researched rows, and by the
 * store's own rule they can never supersede one.
 *
 * Run (review):  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_civic.js
 * Run (write):   …/electron scripts/backfill_civic.js --apply
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const NOTES = path.join(ROOT, 'data', 'zoe_workspace', 'notes');
const REVIEW = path.join(ROOT, 'data', 'backfill-civic-review.md');

require('../lib/db').init();
const civic = require('../lib/civic_store');
const ccap = require('../lib/civic_capture');

const URL_RE = /https?:\/\/[^\s)|<>"']+/;
const clean = (s) => String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

// A roster table: any markdown table that actually CONTAINS people. Header vocabulary is not the
// test — the dry run caught "| District | Representative | Role | Email |", which names no "name"
// column, so a header-keyed reader took column 0 and imported the district NUMBERS. The person
// column is found by DATA instead: whichever column holds the most cells that pass the name screen.
// Deterministic, and it cannot be defeated by a header word nobody thought of.
function tablesIn(section) {
  const out = [];
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const header = lines[i].split('|').map(clean).filter(Boolean).map((h) => h.toLowerCase());
    if (!header.length) continue;
    if (!/^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) continue;      // must be a real md table
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = lines[j].split('|').map(clean);
      if (cells.length > 2) rows.push(cells.filter((c, k) => k > 0 && k < cells.length - 1 ? true : c !== ''));
    }
    // the citation bound to this table: the nearest URL in the 4 lines after it, else in the header block
    let src = null;
    for (let k = j; k < Math.min(j + 4, lines.length); k++) { const m = (lines[k] || '').match(URL_RE); if (m) { src = m[0]; break; } }
    if (!src) { const m = section.slice(0, section.indexOf(lines[i])).match(new RegExp(URL_RE.source + '(?![\\s\\S]*' + '\\bhttps?' + ')')); if (m) src = m[0]; }
    // WHICH column holds the people — decided by the data, not the header.
    let iName = -1, best = 0;
    const width = Math.max(...rows.map((r) => r.length), 0);
    for (let c = 0; c < width; c++) {
      const hits = rows.filter((r) => ccap.looksLikeName(r[c])).length;
      if (hits > best) { best = hits; iName = c; }
    }
    if (iName < 0 || best < 1) { i = j; continue; }                       // no people in it → not a roster
    out.push({ header, rows, src, iName });
    i = j;
  }
  return out;
}

function colIndex(header, re, dflt = -1) { const i = header.findIndex((h) => re.test(h)); return i >= 0 ? i : dflt; }

const findings = [];   // { file, body, level, function, members[], skipped[] }
let files = [];
try { files = fs.readdirSync(NOTES).filter((f) => /^directed-\d+\.md$/.test(f) || /dossier\.md$/.test(f)); } catch {}

for (const f of files) {
  let md = '';
  try { md = fs.readFileSync(path.join(NOTES, f), 'utf8'); } catch { continue; }
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const body = clean(part.split('\n')[0]);
    if (body.length < 6) continue;
    const members = []; const skipped = [];
    for (const t of tablesIn(part)) {
      const iName = t.iName;
      const iRole = colIndex(t.header, /title|role|position/);
      const iParty = colIndex(t.header, /part(y|ies)/);
      const iMail = colIndex(t.header, /e-?mail/);
      for (const cells of t.rows) {
        const name = clean(cells[iName]);
        if (!name || /^[-–—]+$/.test(name)) continue;
        if (!ccap.looksLikeName(name)) { skipped.push({ name, why: 'not a person name (page furniture)' }); continue; }
        const email = iMail >= 0 ? clean(cells[iMail]).replace(/^[-–—]$/, '') : '';
        members.push({
          personName: name,
          role: iRole >= 0 ? (clean(cells[iRole]).replace(/^[-–—]$/, '') || 'Member') : 'Member',
          party: iParty >= 0 ? (clean(cells[iParty]).replace(/^[-–—]$/, '') || null) : null,
          email: /@/.test(email) ? email : null,
          sourceUrl: t.src || null,
          sourceKind: 'backfill_prose',
          // A row whose table carries a real citation is worth more than one that does not.
          confidence: t.src ? 0.6 : 0.3,
        });
      }
    }
    if (members.length || skipped.length) {
      const low = body.toLowerCase();
      const level = /\bcounty|parish\b/.test(low) ? 'county'
        : /\bcity|town|municipal|village|borough\b/.test(low) ? 'municipal'
        : /\btownship\b/.test(low) ? 'township'
        : /\bschool|education\b/.test(low) ? 'school_district'
        : /\bhouse|senate|assembly|legislature\b/.test(low) ? 'state'
        : 'other';
      // CIVIC ONLY. The dry run caught this before anything was written: 5 of the 14 bodies with
      // roster tables were AI-safety orgs and companies (CAIS, FLI, MIRI, ARC, Anthropic) from an
      // old dossier — Anthropic's exec team would have landed in the table as a GOVERNING BODY.
      // A recognizable civic level is the entry requirement; an unclassifiable org is reported in
      // the review as skipped-non-civic and never stored. This table is for governing bodies.
      if (level === 'other') { findings.push({ file: f, body, members: [], skipped: [], nonCivic: members.length }); continue; }
      findings.push({
        file: f, body, members, skipped, level,
        function: /election|registration/.test(low) ? 'elections' : /school|education/.test(low) ? 'school' : /court|judicial/.test(low) ? 'judicial' : /planning|zoning/.test(low) ? 'planning' : 'governing',
      });
    }
  }
}

const totalM = findings.reduce((a, f) => a + f.members.length, 0);
const totalS = findings.reduce((a, f) => a + f.skipped.length, 0);
const cited = findings.reduce((a, f) => a + f.members.filter((m) => m.sourceUrl).length, 0);

// ── the review file (written every run, apply or not) ────────────────────────────────────────
const lines = [`# Civic backfill — ${APPLY ? 'APPLIED' : 'DRY RUN (nothing written)'}`, '',
  `Scanned ${files.length} deliverable file(s) · ${findings.length} bodies with a roster table`,
  `**${totalM} member rows** (${cited} carry a bound source URL, ${totalM - cited} do not) · ${totalS} line(s) refused by the name screen`,
  '', 'Extraction is DETERMINISTIC — markdown tables she already wrote, with the citation she already bound.',
  'No model read this prose, so nothing here is invented. Rows land as `backfill_prose` and can never',
  'supersede a researched row.', ''];
const nonCivic = findings.filter((f) => f.nonCivic);
if (nonCivic.length) {
  lines.push(`## Skipped — NOT civic bodies (${nonCivic.length})`, '',
    'These had roster tables but no recognizable civic level. They are organizations, not governing',
    'bodies; storing them here would be exactly the data confusion this table exists to prevent.', '');
  for (const f of nonCivic) lines.push(`- ${f.body} — ${f.nonCivic} row(s) not stored (${f.file})`);
  lines.push('');
}
for (const f of findings.filter((x) => !x.nonCivic)) {
  lines.push(`## ${f.body}`, `_${f.file} · level=${f.level} · function=${f.function}_`, '');
  for (const m of f.members) lines.push(`- **${m.personName}** — ${m.role}${m.party ? ` (${m.party})` : ''}${m.email ? ` · ${m.email}` : ''} · ${m.sourceUrl ? `conf 0.6 · ${m.sourceUrl.slice(0, 90)}` : '**no source URL** · conf 0.3'}`);
  for (const s of f.skipped) lines.push(`- ~~${s.name}~~ — REFUSED: ${s.why}`);
  lines.push('');
}
try { fs.writeFileSync(REVIEW, lines.join('\n'), 'utf8'); } catch (e) { console.error('review write failed:', e.message); }

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${findings.length} bodies · ${totalM} members (${cited} cited) · ${totalS} refused`);
console.log(`review → ${path.relative(ROOT, REVIEW)}`);

if (!APPLY) {
  console.log('\nNothing written. Read the review, then re-run with --apply.');
  process.exit(0);
}

let bodies = 0, stored = 0, skippedRes = 0;
for (const f of findings) {
  if (!f.members.length) continue;
  const ub = civic.upsertBody({ title: f.body, level: f.level, function: f.function });
  if (!ub.ok) { console.error(`  body failed: ${f.body} — ${ub.reason}`); continue; }
  bodies++;
  for (const m of f.members) {
    const r = civic.recordMembership({ bodyKey: ub.bodyKey, ...m });
    if (r.ok && r.skipped) skippedRes++;
    else if (r.ok) stored++;
  }
}
console.log(`\nAPPLIED — ${bodies} bodies, ${stored} member rows stored, ${skippedRes} deferred to researched rows.`);
try { require('../lib/db').getDb().close(); } catch {}
