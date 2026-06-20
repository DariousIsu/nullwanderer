/**
 * Experience layer — turns DOING into durable, reusable know-how (the Voyager/
 * Reflexion pattern). When she completes an action, this distills the CORRECT
 * procedure ("to do X: …, learned: …") and stores it in the capability track
 * (knowledge, kind='skill'), so next time she faces a similar task it's retrievable.
 *
 * REFERENCE-NOT-COPY: every procedure carries a `provenance` marker — a pointer to
 * where the raw data it came from LIVES (the action, the email, a reading's monologue
 * row + url). The note stays compact; the marker lets her drill back to the source.
 *
 * Dedup: a procedure is captured ONCE. A near-duplicate (cosine prefilter + LLM
 * confirm, same as self_model) is skipped rather than re-stored, so repeating an
 * action doesn't pile up identical how-tos.
 */

const db = require('./db');
const memory = require('./memory');
const { streamChat } = require('./ollama');
const MODEL = require('./config').model();

const PREFILTER_SIM = 0.80;  // cosine prefilter for the dedup candidate

function marker(type, fields = {}) { return { type, ...fields }; }

// LLM confirm: are A and B the same procedure/fact, just reworded?
async function sameProcedure(a, b) {
  const messages = [{ role: 'user', content: `Do these two notes describe the SAME procedure/fact (just reworded)? Answer ONLY "yes" or "no".\n\nA: ${a}\nB: ${b}` }];
  let raw = '';
  try { await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } }); }
  catch { return false; }
  return /^\s*yes/i.test(raw.trim());
}

// Store a procedure/fact in the capability track via the shared write-time dedup
// (memory.storeDeduped): a confirmed near-duplicate NOOPs instead of re-storing.
// Returns { action:'add'|'noop'|'skip-empty', id? }.
async function recordProcedure({ content, kind = 'skill', source = 'experience', provenance = null, importance = 0.78, decideFn = null }) {
  const text = String(content || '').trim();
  if (text.length < 10) return null;
  return memory.storeDeduped({
    kind, content: text, source, importance,
    provenance: provenance ? (Array.isArray(provenance) ? provenance : [provenance]) : null,
    prefilter: PREFILTER_SIM, decideFn
  });
}

// Distill the reusable procedure from a completed action and record it.
// synthFn injectable for tests.
async function captureActionOutcome({ name, task, success = true, provenance = null, synthFn = synthProcedure }) {
  if (!success) return null;  // v1: capture the working procedure on success
  let proc = null;
  try { proc = await synthFn({ name, task }); } catch (e) { console.error('[experience] synth failed:', e.message); }
  if (!proc || proc.length < 10) return null;
  const r = await recordProcedure({ content: proc, kind: 'skill', provenance, importance: 0.78 });
  if (r) console.log(`[experience] action "${name}" → procedure ${r.action}${r.id ? ' #' + r.id : ''}`);
  return r;
}

async function synthProcedure({ name, task }) {
  const messages = [{ role: 'user', content: `You just successfully completed this task: ${task || name}.\nWrite the REUSABLE procedure you'd follow to do this kind of task again — concrete and imperative, ONE sentence, no preamble. Focus on the actual steps/method, not feelings.` }];
  let raw = '';
  await streamChat({ model: MODEL, messages, options: { temperature: 0.3, top_p: 0.9, num_ctx: 8192, num_predict: 60 }, onToken: (t) => { raw += t; } });
  return (raw.split('\n').map(s => s.trim()).find(Boolean) || '').replace(/^["'`]+|["'`]+$/g, '').trim();
}

// Resolve a provenance marker back to its raw source (proves the pointer is live).
// Returns { type, raw } where raw is the monologue row, the url, or the marker fields.
function resolveMarker(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.refTable === 'monologue' && m.refId) {
    const row = db.getMonologueById(m.refId);
    return { type: m.type, raw: row || null, url: m.url || (row && row.query) || null };
  }
  if (m.url) return { type: m.type, raw: null, url: m.url };
  return { type: m.type, raw: null, fields: m };
}

module.exports = { recordProcedure, captureActionOutcome, synthProcedure, sameProcedure, resolveMarker, marker, PREFILTER_SIM };
