#!/usr/bin/env node
/**
 * scripts/consent_note.js — the engineer's consent card (cut 1). When a REGISTERED persona asset is changed by hand or
 * by a commit, mint the card WITH its rationale before the next boot, so her card says why instead of "unrecorded —
 * detected at boot". The card is pending until she answers in her own turn; the manifest advances only on her yes.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/consent_note.js --asset context \
 *       --summary "the ask door's block rides the social-turn directive" \
 *       --rationale "cut 3: a question about him is welcome on personal ground" [--effect "…"] [--by claude]
 *   --list      the pending cards      --recent     the last twenty rows
 *
 * The new hash is read from disk now; the previous hash from the consented manifest. Never deletes, never lands.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const PR = require(path.join(ROOT, 'lib', 'personality_register'));
const db = require(path.join(ROOT, 'lib', 'db'));
db.init();
if (args.includes('--list')) { for (const r of PR.pending()) console.log(`#${r.id} ${r.asset} (${r.kind}, by ${r.proposed_by}) — ${r.summary} | why: ${r.rationale}`); process.exit(0); }
if (args.includes('--recent')) { for (const r of PR.recent()) console.log(`#${r.id} ${new Date(r.ts).toLocaleString()} ${r.asset} ${r.verdict}${r.verdict_by ? ' by ' + r.verdict_by : ''} — ${r.summary}`); process.exit(0); }
const asset = arg('--asset'), summary = arg('--summary'), rationale = arg('--rationale'), effect = arg('--effect', ''), by = arg('--by', 'claude');
if (!asset || !summary || !rationale) { console.error('usage: --asset <id> --summary "…" --rationale "…" [--effect "…"] [--by claude]'); process.exit(2); }
const entry = PR.ENTRIES.find((e) => e.id === asset);
if (!entry) { console.error(`unknown asset "${asset}" — registered: ${PR.ENTRIES.map((e) => e.id).join(', ')}`); process.exit(2); }
const now = PR.hashAll()[asset];
const prev = (PR.manifest() || {})[asset] || null;
if (now && prev === now) { console.log(`[consent] ${asset} is unchanged from the consented manifest — no card needed`); process.exit(0); }
// A boot already carded this exact hash as "unrecorded"? Give THAT card its reason — never a second card for one change.
const standing = now ? PR.pendingFor(asset, now) : null;
if (standing && standing.proposed_by === 'boot-detect') {
  const a = PR.amend(standing.id, { summary, rationale, expectedEffect: effect, proposedBy: by });
  if (!a.ok) { console.error(`[consent] amend refused: ${a.why}`); process.exit(1); }
  console.log(`[consent] card #${standing.id} for ${asset} amended by ${by} — the boot-detect card now carries its rationale (${(prev || 'none').slice(0, 8)}→${(now || 'gone').slice(0, 8)})`);
  process.exit(0);
}
if (standing) { console.log(`[consent] card #${standing.id} for ${asset} already stands for this hash (by ${standing.proposed_by}) — no card needed`); process.exit(0); }
const r = PR.record({ asset, kind: entry.kind, prevHash: prev, newHash: now, proposedBy: by, summary, rationale, expectedEffect: effect });
if (!r.ok) { console.error(`[consent] refused: ${r.why}`); process.exit(1); }
console.log(`[consent] card #${r.id} minted for ${asset} by ${by} — pending her word (${(prev || 'none').slice(0, 8)}→${(now || 'gone').slice(0, 8)})`);
