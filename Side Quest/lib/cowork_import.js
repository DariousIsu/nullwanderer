'use strict';
/*
 * lib/cowork_import.js — Cowork port P1, the READ + PLAN half (2026-09-04). His 11 Claude Cowork "spaces"
 * (docs/ZOE_BUILD_PLAN §2, row P1) → a reviewable ZOE import PLAN.
 *
 * Reads the Cowork spaces.json and the per-space memory/ files — READ-ONLY on the Cowork side — and builds
 * an IDEMPOTENT plan: one project per space carrying its folder links, its instruction as a VERBATIM
 * project law (his words, per the "instructions are LAWS" rule), and its memory files as project facts
 * (the Armstrong attribution rule, the no-em-dash rule, the ND canonical facts, the datacenter framings).
 * This half only reads and plans — it writes NOTHING; the APPLY half lands the plan through ZOE's own
 * doors deliberately, after Lucas reviews the plan (importing his operator laws is consequential). Pure
 * over an injected fs so the smoke drives it over a fixture, offline. Idempotent by space id.
 */
const path = require('path');

// The Cowork account/session dir holding spaces.json (COWORK_DIR overrides; else discovered under APPDATA).
function discoverDir({ fs = require('fs'), env = process.env } = {}) {
  if (env.COWORK_DIR) return env.COWORK_DIR;
  const root = path.join(env.APPDATA || '', 'Claude', 'local-agent-mode-sessions');
  try {
    for (const acct of fs.readdirSync(root)) {
      const ap = path.join(root, acct);
      let stat; try { stat = fs.statSync(ap); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const sess of fs.readdirSync(ap)) {
        const sp = path.join(ap, sess, 'spaces.json');
        try { if (fs.statSync(sp).isFile()) return path.join(ap, sess); } catch {}
      }
    }
  } catch {}
  return null;
}

// Strip a markdown frontmatter block, returning { name, description, body }.
function _frontmatter(text) {
  const t = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t);
  if (!m) return { name: null, description: null, body: t.trim() };
  const fm = m[1];
  const name = (/^name:\s*(.+)$/m.exec(fm) || [])[1];
  const desc = (/^description:\s*(.+)$/m.exec(fm) || [])[1];
  return { name: name ? name.trim().replace(/^["']|["']$/g, '') : null, description: desc ? desc.trim().replace(/^["']|["']$/g, '') : null, body: (m[2] || '').trim() };
}

/**
 * Read the Cowork spaces + their memory files. Returns [{ id, name, folders:[path], instructions,
 * origin, memory:[{ file, name, description, body }] }]. READ-ONLY. `deps.fs` injectable.
 */
function readCoworkSpaces(dir, { deps = {} } = {}) {
  const fs = deps.fs || require('fs');
  const base = dir || discoverDir({ fs });
  if (!base) return { ok: false, why: 'no Cowork spaces.json found (set COWORK_DIR)', spaces: [] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(base, 'spaces.json'), 'utf8')); }
  catch (e) { return { ok: false, why: `spaces.json unreadable: ${e.message}`, spaces: [] }; }
  const raw = Array.isArray(doc) ? doc : (doc.spaces || []);
  const spaces = raw.map((s) => {
    const id = s.id || s.uuid || '';
    const folders = (s.folders || []).map((f) => (typeof f === 'string' ? f : (f && f.path) || '')).filter(Boolean);
    const memDir = path.join(base, 'spaces', id, 'memory');
    const memory = [];
    try {
      for (const name of fs.readdirSync(memDir)) {
        if (/^MEMORY\.md$/i.test(name)) continue;   // the index file — the fact files are the substance
        const p = path.join(memDir, name);
        try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
        const fm = _frontmatter(fs.readFileSync(p, 'utf8'));
        memory.push({ file: name, name: fm.name || name.replace(/\.md$/, ''), description: fm.description, body: fm.body });
      }
    } catch { /* no memory dir for this space */ }
    return { id, name: s.name || s.title || '(unnamed)', folders, instructions: (s.instructions || s.customInstructions || '').trim(), origin: s.origin || null, memory };
  }).filter((s) => s.id);
  return { ok: true, base, spaces };
}

/**
 * Build the idempotent import plan. `imported` is the set of space ids already ported (from meta
 * cowork.imported_spaces); a space already imported is a 'skip'. Returns { create:[...], skip:[...],
 * totals }. Each create action names the project, the folder links, the verbatim law, and the facts —
 * everything the APPLY half needs, nothing it writes here.
 */
function buildPlan(spaces, { imported = [] } = {}) {
  const done = new Set(imported);
  const create = [], skip = [];
  for (const s of (spaces || [])) {
    const action = {
      spaceId: s.id, name: s.name, folders: s.folders,
      law: s.instructions || null,             // his verbatim instruction → a project-scoped law (never paraphrased)
      facts: s.memory.map((m) => ({ name: m.name, description: m.description || null, bytes: Buffer.byteLength(m.body || '', 'utf8'), body: m.body })),
    };
    (done.has(s.id) ? skip : create).push(action);
  }
  const factCount = create.reduce((n, a) => n + a.facts.length, 0);
  const withLaw = create.filter((a) => a.law).length;
  return { create, skip, totals: { spaces: (spaces || []).length, toCreate: create.length, toSkip: skip.length, laws: withLaw, facts: factCount } };
}

/** A human dry-run summary — one block per space to be created, so Lucas reviews before any write. */
function summarize(plan) {
  const lines = [`COWORK IMPORT PLAN — ${plan.totals.toCreate} to create, ${plan.totals.toSkip} already imported; ${plan.totals.laws} laws, ${plan.totals.facts} facts`];
  for (const a of plan.create) {
    lines.push(`\n• ${a.name}  [${a.spaceId.slice(0, 8)}]`);
    if (a.folders.length) lines.push(`    folders: ${a.folders.join(' · ')}`);
    if (a.law) lines.push(`    law: "${a.law.slice(0, 140)}${a.law.length > 140 ? '…' : ''}"`);
    for (const f of a.facts) lines.push(`    fact: ${f.name} (${f.bytes}c)${f.description ? ` — ${f.description.slice(0, 60)}` : ''}`);
  }
  for (const a of plan.skip) lines.push(`\n• ${a.name} — already imported (skip)`);
  return lines.join('\n');
}

module.exports = { readCoworkSpaces, buildPlan, summarize, discoverDir, _frontmatter };
