/**
 * lib/skills.js — O1 THE SKILL SHELF (catalog slice 5, 2026-07-23).
 *
 * The harness's own trick, transplanted: a skill's TRIGGER SURFACE (name + one line, ≤140 chars)
 * is cheap and always present; the BODY loads only on pull. Retrieval is the bottleneck
 * (harness-fills-the-gap): a procedure that doesn't surface at the right moment doesn't exist —
 * the shelf makes surfacing permanent while keeping content dereferenced. This is the [dN] law
 * applied to know-how.
 *
 * A REGISTRY over the three procedure systems that already exist — never a fourth system:
 *   kind 'flow'      → recipes/<file>.json   (Playwright replay flows, lib/flow_runner)
 *   kind 'procedure' → procedures.id          (crystallized, met/unmet track record)
 *   kind 'guide'     → an instruction pack    (body_ref holds the text or a known guide key)
 *   kind 'shape'     → a document shape key   (body text stored in body_ref)
 * Births: syncFlows() registers the recipe files idempotently at boot; a crystallized procedure
 * crossing met≥3 promotes itself (procedures.recordUse calls promoteFromProcedures — competence
 * that PROVED OUT earns a permanent trigger line).
 *
 * The pull is one tag — <skill name="…"/> — returning the body as a tool-result THAT turn:
 * the <echo-guide> mechanic, generalized. Pure + deps-injected → offline-smokeable.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const KINDS = new Set(['flow', 'procedure', 'shape', 'guide']);
const TRIGGER_MAX = 140;   // the shelf's contract, not an artificial cap: one cheap permanent line
const MATCH_MIN_OVERLAP = 2;

function _db(deps) { return (deps && deps.db) || require('./db'); }
const _slug = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// Same tokenizer discipline as procedures.match — the two shelves must agree on what "matches".
// procedures._tokens returns an ARRAY; normalize to a Set here (this module tests .size/.has —
// the smoke caught the falsy-undefined early-return the raw array caused).
function _tokens(text) {
  try { return new Set(require('./procedures')._tokens(text)); }
  catch { return new Set(str(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3)); }
}

// Upsert by slug. A re-register refreshes the trigger line + body_ref, keeps the use record.
function register({ name, triggerDesc, kind, bodyRef, applies = null, provenance = null, deps = {}, nowMs = Date.now() } = {}) {
  const slug = _slug(name);
  const trig = str(triggerDesc).replace(/\s+/g, ' ').trim().slice(0, TRIGGER_MAX);
  if (!slug || !trig || !KINDS.has(kind)) return { ok: false, reason: 'a skill needs a name, a one-line trigger, and a known kind' };
  try {
    _db(deps).getDb().prepare(`INSERT INTO skills (name, trigger_desc, kind, body_ref, applies, provenance, uses, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(name) DO UPDATE SET trigger_desc = excluded.trigger_desc, kind = excluded.kind,
        body_ref = excluded.body_ref, applies = COALESCE(excluded.applies, skills.applies)`)
      .run(slug, trig, kind, str(bodyRef).slice(0, 300) || null, applies ? str(applies).slice(0, 200) : null, provenance ? str(provenance).slice(0, 120) : null, nowMs);
    return { ok: true, name: slug };
  } catch (e) { console.error('[skills] register failed:', e.message); return { ok: false, reason: e.message }; }
}

function get(name, { deps = {} } = {}) {
  try { return _db(deps).getDb().prepare('SELECT * FROM skills WHERE name = ?').get(_slug(name)) || null; } catch { return null; }
}

// Token-overlap match of a turn/brief against the trigger surface. ≥MATCH_MIN_OVERLAP shared
// meaningful tokens (name counts toward the surface). Deterministic; strongest first.
function match({ text, limit = 3, deps = {} } = {}) {
  const qt = _tokens(text);
  if (!qt.size) return [];
  let rows = [];
  try { rows = _db(deps).getDb().prepare('SELECT * FROM skills ORDER BY last_used_ts DESC NULLS LAST').all(); } catch { return []; }
  const scored = [];
  for (const r of rows) {
    const st = _tokens(`${r.name.replace(/-/g, ' ')} ${r.trigger_desc}`);
    let overlap = 0;
    for (const t of qt) if (st.has(t)) overlap++;
    if (overlap >= MATCH_MIN_OVERLAP) scored.push({ row: r, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, Math.max(1, limit)).map((s) => s.row);
}

// Brief-ready trigger lines for matched skills — descriptions ride, bodies never do.
function matchLines({ text, limit = 2, deps = {} } = {}) {
  const rows = match({ text, limit, deps });
  if (!rows.length) return '';
  return 'SKILLS ON THE SHELF matching this work (pull a body only if you will follow it):\n'
    + rows.map((r) => `- [${r.name}] ${r.trigger_desc} — pull with the skill_pull tool: {"name":"${r.name}"}`).join('\n');
}

// The autonomy manifest's HER SKILLS section: top-K by use recency + the honest total.
function manifestLines({ limit = 5, deps = {} } = {}) {
  try {
    const d = _db(deps).getDb();
    const total = d.prepare('SELECT COUNT(*) n FROM skills').get().n;
    if (!total) return [];
    const rows = d.prepare('SELECT name, trigger_desc, kind, uses FROM skills ORDER BY (last_used_ts IS NULL), last_used_ts DESC, uses DESC LIMIT ?').all(Math.max(1, limit));
    const lines = rows.map((r) => `   - [skill ${r.name}] (${r.kind}${r.uses ? `, used ${r.uses}×` : ''}) ${r.trigger_desc}`);
    if (total > rows.length) lines.push(`   - (${total - rows.length} more on the shelf — a matching turn surfaces them)`);
    return lines;
  } catch { return []; }
}

// Dereference the body — the pull. Loads by KIND from the system that owns it; readers are
// injectable (readFile/procRow/guide) so the resolve is offline-testable. Records the use.
function resolveBody(name, { deps = {}, nowMs = Date.now() } = {}) {
  const row = get(name, { deps });
  if (!row) return { ok: false, text: `No skill named "${_slug(name)}" on the shelf.` };
  let text = '';
  try {
    if (row.kind === 'flow') {
      const read = deps.readFile || ((p) => require('fs').readFileSync(p, 'utf8'));
      const path = require('path');
      const fp = path.join(__dirname, '..', 'recipes', String(row.body_ref || `${row.name}.json`));
      let flow = null; try { flow = JSON.parse(read(fp)); } catch {}
      text = flow
        ? `FLOW RECIPE "${row.name}" — ${row.trigger_desc}\nSteps (${(flow.steps || []).length}):\n` +
          (flow.steps || []).map((s, i) => `${i + 1}. ${str(s.action || s.type || 'step')}${s.url ? ` → ${s.url}` : ''}${s.selector ? ` [${str(s.selector).slice(0, 60)}]` : ''}${s.note ? ` — ${str(s.note).slice(0, 80)}` : ''}`).join('\n')
        : `Flow recipe file unreadable (${row.body_ref}) — the trigger line is all the shelf holds: ${row.trigger_desc}`;
    } else if (row.kind === 'procedure') {
      const procRow = deps.procRow || ((id) => { try { return _db(deps).getDb().prepare('SELECT * FROM procedures WHERE id = ?').get(Number(id)); } catch { return null; } });
      const p = procRow(row.body_ref);
      text = p
        ? `PROVEN PROCEDURE "${p.name}" (met ${p.met}/${p.met + p.unmet})\nWHEN: ${str(p.trigger_text)}\nSTEPS: ${str(p.steps)}\nCHECK: ${str(p.check_text)}${p.applicability ? `\nAPPLIES: ${p.applicability}` : ''}`
        : `The procedure behind this skill (#${row.body_ref}) is gone — retire the shelf row if this repeats.`;
    } else if (row.kind === 'guide') {
      const guide = deps.guide || (() => null);
      text = str(guide(row.body_ref)) || str(row.body_ref);
    } else {
      text = str(row.body_ref);   // 'shape' — the body text lives on the row
    }
  } catch (e) { return { ok: false, text: `Skill "${row.name}" failed to load: ${e.message}` }; }
  try { _db(deps).getDb().prepare('UPDATE skills SET uses = uses + 1, last_used_ts = ? WHERE name = ?').run(nowMs, row.name); } catch {}
  return { ok: true, text: text.slice(0, 6000), kind: row.kind };
}

// A crystallized procedure that PROVED OUT (met ≥ 3) earns a permanent trigger line. Idempotent.
function promoteFromProcedures(proc, { deps = {}, nowMs = Date.now() } = {}) {
  if (!proc || (Number(proc.met) || 0) < 3) return { ok: false, reason: 'not proven yet' };
  return register({
    name: proc.name, triggerDesc: str(proc.trigger_text || proc.name),
    kind: 'procedure', bodyRef: String(proc.id), provenance: 'crystallized met≥3',
    deps, nowMs,
  });
}

// Boot-time idempotent registration of the flow recipes that already exist on disk.
function syncFlows({ dir = null, deps = {}, nowMs = Date.now() } = {}) {
  const fs = require('fs'); const path = require('path');
  const d = dir || path.join(__dirname, '..', 'recipes');
  let n = 0;
  try {
    for (const f of fs.readdirSync(d)) {
      if (!/\.json$/i.test(f)) continue;
      let j = null; try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch {}
      const r = register({
        name: f.replace(/\.json$/i, ''),
        triggerDesc: str(j && (j.description || j.name)) || `replay the ${f.replace(/\.json$/i, '').replace(/_/g, ' ')} flow`,
        kind: 'flow', bodyRef: f, provenance: 'recipes/', deps, nowMs,
      });
      if (r.ok) n++;
    }
  } catch (e) { console.error('[skills] syncFlows failed:', e.message); }
  return n;
}

// --- the pull tag: <skill name="…"/> (complete, self-closing only — narration never dispatches) ---
const SKILL_TAG_RE = /<skill\s+name="([a-z0-9_-]{2,60})"\s*\/>/gi;
function parseSkillTags(text) {
  const out = []; let m;
  SKILL_TAG_RE.lastIndex = 0;
  while ((m = SKILL_TAG_RE.exec(str(text))) !== null) out.push({ name: m[1].toLowerCase() });
  return out;
}
function stripSkillTags(text) { return str(text).replace(SKILL_TAG_RE, ''); }

module.exports = {
  TRIGGER_MAX, register, get, match, matchLines, manifestLines, resolveBody,
  promoteFromProcedures, syncFlows, parseSkillTags, stripSkillTags,
};
