/**
 * lib/procedures.js — PROCEDURAL MEMORY: crystallize → match → inject (conductor slice 2c, 2026-07-22).
 *
 * The harness thesis (Lucas: "could the how-to-do-things be put into DB memory so the models she
 * uses feel strong just because they are interacting with this harness?"), made mechanical. What
 * model weights contribute decomposes three ways: PROCEDURAL knowledge transfers fully to rows;
 * RECOGNITION transfers partially (each verified episode becomes a row); FLUID COMPOSITION does not
 * transfer — so the harness shrinks what's left for the model to supply. A mid-size model executing
 * step 3 of a proven recipe with the facts inline IS strong at that step.
 *
 * Two write paths, both from her own expect-verified runs (lib/autonomy verifyExpect):
 *   - expect MET   → one cheap structured call drafts the reusable procedure (trigger/steps/check/
 *     applies). Let-it-in philosophy: active immediately, its TRACK RECORD rides with it — the
 *     reader sees "met 4/5" and judges. A draft that strongly overlaps an existing trigger FOLDS
 *     into it (provenance + met++) instead of minting a near-duplicate.
 *   - expect NOT met → a deterministic CONSTRAINT row (no cloud call): what was tried, why it
 *     failed. Constraints outlive the 12-entry history window; `unmet` counts re-confirmations.
 *
 * Read path: match(move+target) → briefBlock() rides the operator brief. Retirement is mechanical:
 * a procedure that keeps failing (unmet ≥ 3 and > met) is worse than no guidance and retires.
 *
 * Two honest limits, by design: rows generalize worse than weights (every procedure carries
 * `applies`, and no-match briefs say nothing — the model works from principles), and RETRIEVAL IS
 * THE BOTTLENECK (matching is plain token overlap now; embeddings can layer on without schema
 * change). Pure logic + deps-injected db/ask → offline-smokeable.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const STOP = new Set('the a an of for from and or with this that these those about into onto over under our your their his her its on in to at by as is are was be been do does did not no'.split(/\s+/));

function _tokens(s) {
  return [...new Set(str(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}
function _db(deps) { return (deps && deps.db) || require('./db'); }
function _metRate(r) { const t = (r.met || 0) + (r.unmet || 0); return t ? (r.met || 0) / t : 0; }

// Match active rows against a run's shape. Overlap threshold: ≥2 shared content tokens, or full
// cover of a short (≤2-token) trigger — a one-token graze must not summon a procedure.
function match({ move = '', target = '', deps = {}, maxConstraints = 2 } = {}) {
  const want = _tokens(`${move} ${target}`);
  const out = { procedure: null, constraints: [] };
  if (!want.length) return out;
  let rows = [];
  try { rows = _db(deps).getDb().prepare("SELECT * FROM procedures WHERE status = 'active'").all(); }
  catch (e) { console.error('[procedures] match read failed:', e.message); return out; }
  const scored = [];
  for (const r of rows) {
    const trig = _tokens(`${r.trigger_text} ${r.name}`);
    if (!trig.length) continue;
    const shared = trig.filter((t) => want.includes(t)).length;
    if (shared >= 2 || (shared >= 1 && trig.length <= 2)) scored.push({ r, shared });
  }
  scored.sort((a, b) => (b.shared - a.shared) || (_metRate(b.r) - _metRate(a.r)) || ((b.r.last_used_ts || 0) - (a.r.last_used_ts || 0)));
  out.procedure = (scored.find((s) => s.r.kind === 'procedure') || {}).r || null;
  out.constraints = scored.filter((s) => s.r.kind === 'constraint').slice(0, maxConstraints).map((s) => s.r);
  return out;
}

// Render a match for the operator brief ('' when nothing matched — silence beats filler).
function briefBlock({ procedure = null, constraints = [] } = {}) {
  const parts = [];
  if (procedure) {
    const t = (procedure.met || 0) + (procedure.unmet || 0);
    const record = t ? ` (met its expectation ${procedure.met}/${t} time${t === 1 ? '' : 's'})` : ' (unproven)';
    let block = `PROVEN PROCEDURE — "${str(procedure.name).slice(0, 80)}"${record}. Follow it unless the evidence says otherwise:\n${str(procedure.steps).slice(0, 1200)}`;
    if (procedure.check_text) block += `\nCheck: ${str(procedure.check_text).slice(0, 200)}`;
    if (procedure.applicability) block += `\nApplies when: ${str(procedure.applicability).slice(0, 200)}`;
    parts.push(block);
  }
  if (constraints.length) {
    parts.push('LEARNED CONSTRAINTS (approaches that did NOT meet their expectation — do not repeat them unchanged):\n'
      + constraints.map((c) => `- ${str(c.name).slice(0, 90)}: ${str(c.applicability || c.trigger_text).slice(0, 180)}${c.unmet > 1 ? ` (confirmed ${c.unmet}×)` : ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

// Track record + mechanical retirement (repeatedly failing guidance is worse than none).
function recordUse(id, { met = false, deps = {}, nowMs = Date.now() } = {}) {
  if (!id) return;
  try {
    const d = _db(deps).getDb();
    d.prepare(`UPDATE procedures SET ${met ? 'met = met + 1' : 'unmet = unmet + 1'}, last_used_ts = ? WHERE id = ?`).run(nowMs, id);
    d.prepare(`UPDATE procedures SET status = 'retired' WHERE id = ? AND unmet >= 3 AND unmet > met`).run(id);
  } catch (e) { console.error('[procedures] recordUse failed:', e.message); }
}

function _appendProvenance(row, episode, deps) {
  try {
    let p = []; try { p = JSON.parse(row.provenance || '[]') || []; } catch {}
    p.push(episode);
    _db(deps).getDb().prepare('UPDATE procedures SET provenance = ? WHERE id = ?').run(JSON.stringify(p.slice(-5)), row.id);
  } catch (e) { console.error('[procedures] provenance append failed:', e.message); }
}

const DRAFT_WANT = `From this completed autonomous run, extract the REUSABLE procedure — the how, generalized beyond this one target, honest about scope. Reply ONLY strict JSON:
{"name":"<3-6 word imperative name>",
 "trigger":"<the task shape this applies to, one line>",
 "steps":["<plain imperative step>", "..."],
 "check":"<how to verify it worked, one line>",
 "applies":"<where this holds and where it would NOT, one line>"}
Ground every step in what ACTUALLY happened (the tools used, the order that worked) — never invent steps that were not taken. At most 6 steps. If the run was too target-specific to ever reuse, reply {"skip": true}.`;

function _validateDraft(raw) {
  try {
    const m = str(raw).match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (o.skip === true) return { valid: true, value: { skip: true } };
    const out = {
      name: str(o.name).replace(/\s+/g, ' ').trim().slice(0, 80),
      trigger: str(o.trigger).replace(/\s+/g, ' ').trim().slice(0, 200),
      steps: (Array.isArray(o.steps) ? o.steps : []).slice(0, 6).map((s) => str(s).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean),
      check: str(o.check).replace(/\s+/g, ' ').trim().slice(0, 200),
      applies: str(o.applies).replace(/\s+/g, ' ').trim().slice(0, 200),
    };
    if (!out.name || !out.trigger || !out.steps.length || !out.check) return { valid: false, error: 'name/trigger/steps/check required' };
    return { valid: true, value: out };
  } catch (e) { return { valid: false, error: e.message }; }
}

/**
 * The write path, called after verifyExpect. Returns what happened (for the tick's honest log):
 *   {constraint:{id}} | {created:{id,name}} | {folded:{id,name}} | {skipped:reason} | null (no verdict).
 */
async function crystallize({ decision, opRes, verdict, deps = {}, nowMs = Date.now() } = {}) {
  const d = decision || {};
  if (!verdict || typeof verdict.met !== 'boolean' || !d.move) return null;
  const db = _db(deps);

  if (verdict.met === false) {
    // Deterministic constraint — no cloud call; the failure IS the content. A repeat confirmation
    // bumps `unmet` on the existing row instead of minting a twin.
    try {
      const name = `${d.move}: ${str(d.target).slice(0, 70)}`;
      const existing = db.getDb().prepare("SELECT * FROM procedures WHERE kind = 'constraint' AND name = ?").get(name);
      if (existing) {
        recordUse(existing.id, { met: false, deps, nowMs });
        _appendProvenance(existing, { ts: nowMs, target: d.target, outcome: `unmet: ${str(verdict.why).slice(0, 120)}` }, deps);
        return { constraint: { id: existing.id, name }, confirmed: true };
      }
      const info = db.getDb().prepare(`INSERT INTO procedures (kind, name, trigger_text, applicability, provenance, unmet, created_ts, last_used_ts)
        VALUES ('constraint', ?, ?, ?, ?, 1, ?, ?)`)
        .run(name, `${d.move} ${str(d.target)}`.slice(0, 200), str(verdict.why || 'did not meet its expectation').slice(0, 200),
          JSON.stringify([{ ts: nowMs, target: d.target, outcome: `unmet: ${str(verdict.why).slice(0, 120)}` }]), nowMs, nowMs);
      return { constraint: { id: info.lastInsertRowid, name } };
    } catch (e) { console.error('[procedures] constraint write failed:', e.message); return { skipped: e.message }; }
  }

  // MET → draft the reusable procedure on the cloud (fail-soft: no cloud, no draft — never a fake row).
  if (!opRes || !opRes.answer) return { skipped: 'no run output to crystallize' };
  const ask = deps.ask || require('./cloud_logic').ask;
  let draft = null;
  try {
    const stepsTaken = (opRes.steps || []).map((s) => `${s.tool}${s.args ? ` ${str(JSON.stringify(s.args)).slice(0, 80)}` : ''} → ${/^ERROR/i.test(str(s.result)) ? 'ERROR' : 'ok'}`).join('\n');
    draft = await ask({
      task: 'procedure_draft', v: 1,
      input: { move: d.move, target: d.target, why: d.why, expect: d.expect, steps: stepsTaken, answer: str(opRes.answer).slice(0, 2500) },
      want: DRAFT_WANT, validate: _validateDraft, numPredict: 700, think: false,
    });
  } catch (e) { console.error('[procedures] draft failed:', e.message); return { skipped: e.message }; }
  if (!draft) return { skipped: 'cloud unavailable' };
  if (draft.skip) return { skipped: 'too target-specific to reuse' };

  try {
    // Fold into a strongly-overlapping existing procedure rather than minting a near-duplicate.
    const near = match({ move: draft.trigger, target: draft.name, deps });
    if (near.procedure) {
      const shared = _tokens(`${near.procedure.trigger_text} ${near.procedure.name}`).filter((t) => _tokens(`${draft.trigger} ${draft.name}`).includes(t)).length;
      if (shared >= 3) {
        recordUse(near.procedure.id, { met: true, deps, nowMs });
        _appendProvenance(near.procedure, { ts: nowMs, target: d.target, outcome: 'met' }, deps);
        return { folded: { id: near.procedure.id, name: near.procedure.name } };
      }
    }
    const info = db.getDb().prepare(`INSERT INTO procedures (kind, name, trigger_text, steps, check_text, applicability, provenance, met, created_ts, last_used_ts)
      VALUES ('procedure', ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(draft.name, draft.trigger, draft.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), draft.check, draft.applies || null,
        JSON.stringify([{ ts: nowMs, target: d.target, outcome: 'met' }]), nowMs, nowMs);
    return { created: { id: info.lastInsertRowid, name: draft.name } };
  } catch (e) { console.error('[procedures] insert failed:', e.message); return { skipped: e.message }; }
}

module.exports = { match, briefBlock, recordUse, crystallize, _validateDraft, _tokens, DRAFT_WANT };
