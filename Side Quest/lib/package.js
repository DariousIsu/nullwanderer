/**
 * package — the local model's job: turn a turn into a ROADMAP for the cloud.
 *
 * Not "assemble a prompt". The cloud gets a fresh context every call, so whatever is not in the
 * package does not exist for that turn. What it needs is not more prose — it is a plan it can
 * execute: what is being asked, what is already known, what is reachable and how to reach it, how
 * deep to go, and how to check its own work before answering.
 *
 * SEVEN SECTIONS, in survival order. When the budget binds, the LAST section loses bytes first, so
 * the ordering is a statement about what matters: who she is and what was asked outrank any amount
 * of retrieved text.
 *
 *   1 identity   — persona, voice, mood                     (never trimmed)
 *   2 request    — the actual message + read of intent      (never trimmed)
 *   3 plan       — hard commands, back-check, search depth   (never trimmed)
 *   4 manifest   — WHAT EXISTS + how to ask for it           (small by construction)
 *   5 tools      — recipes + the tag contract
 *   6 memory     — threads, commitments, conversation state
 *   7 grounding  — retrieved knowledge, readings             (trimmed first)
 *
 * ⭐ THE MANIFEST IS THE POINT. It carries COUNTS AND KEYS, never rows: "puller.targets 238,475 —
 * ask with <echo-recipe name=…>". A manifest costs tens of tokens where the data costs thousands,
 * it keeps package size roughly constant no matter how much she knows, and it is the only way the
 * cloud can ask for something — a model cannot request what it does not know exists. This is also
 * where the token saving comes from: the work happens inside our own mapped database instead of
 * being pre-dumped into the prompt on the chance it's relevant.
 *
 * ⭐ EVERY BUILD RETURNS A REPORT. Per-section chars, budget, and whether it was trimmed. Both
 * failure modes here are silent — an overflowing package drops its tail, an underfilled one wastes
 * a frontier model — and the recurring lesson in this codebase is that anything unmeasured is
 * assumed fine. `report` is what makes either visible.
 *
 * Pure: every input is passed in, nothing is fetched. Offline-testable by construction.
 */
'use strict';

const CHARS_PER_TOKEN = 4;          // rough, deliberately conservative

// Share of the INPUT budget each section may claim. Untrimmable sections are small and bounded by
// what they are; the weights govern the rest. They intentionally sum to less than 1 — headroom for
// the tool results the cloud will pull, which is the whole reason it has a window.
const WEIGHTS = { manifest: 0.08, tools: 0.14, memory: 0.18, grounding: 0.40 };
const UNTRIMMABLE = new Set(['identity', 'request', 'plan']);
const ORDER = ['identity', 'request', 'plan', 'manifest', 'tools', 'memory', 'grounding'];

// FLOORS — a section that exists is never cut below something USABLE.
//
// Live failure the first time this ran: an oversized untrimmable `identity` consumed the entire
// budget, every weighted section got a budget of 0, and _trim returned just its own trim-marker —
// `manifest:37↓ tools:37↓`. The cloud was handed 37 characters where the tool menu should have been
// and answered with no tools at all. Nothing errored.
//
// The manifest and the tool menu are the CHEAPEST and highest-leverage bytes in the package (a
// manifest is tens of tokens and is the only way the cloud can ask for anything), so they are the
// last things that should ever be squeezed. Below its floor a section is dropped ENTIRELY rather
// than delivered as a stub: a truncated tool menu invites calls to tools that aren't listed, which
// is worse than none.
const FLOORS = { manifest: 400, tools: 1200, memory: 300, grounding: 300 };

/** Usable INPUT chars: the window, less the reply budget, less a safety margin. */
function inputBudgetChars({ num_ctx = 8192, num_predict = 2048, margin = 0.9 } = {}) {
  return Math.max(2000, Math.floor((num_ctx - num_predict) * CHARS_PER_TOKEN * margin));
}

/** Trim on a paragraph boundary where possible, then a word boundary — never mid-word. */
function _trim(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const para = cut.lastIndexOf('\n\n');
  if (para > max * 0.6) return cut.slice(0, para) + '\n\n[…trimmed to fit the package budget]';
  const word = cut.lastIndexOf(' ');
  return cut.slice(0, word > 0 ? word : max) + ' […trimmed to fit the package budget]';
}

/**
 * THE MANIFEST — what she can reach, as counts and keys.
 *
 * `stores` is [{ key, label, count, how }]. A store with an unknown count is still listed: "we hold
 * some" is actionable, and omitting it means the cloud can never ask. A store with count 0 is
 * omitted — offering an empty shelf invites a wasted hop.
 */
function buildManifest(stores = []) {
  const rows = (stores || [])
    .filter((s) => s && s.key && s.count !== 0)
    .map((s) => {
      const n = Number.isFinite(s.count) ? s.count.toLocaleString() : 'some';
      return `• ${s.key} — ${n}${s.label ? ' ' + s.label : ''}${s.how ? ` → ${s.how}` : ''}`;
    });
  if (!rows.length) return '';
  return 'WHAT YOU CAN REACH THIS TURN (counts, not contents — pull what you actually need):\n'
    + rows.join('\n')
    + '\nThese live in OUR database. Reaching for them costs one call and is always cheaper, fresher '
    + 'and more citable than reasoning from memory or searching the open web.';
}

/**
 * THE PLAN — hard commands, back-check, and depth. The part that makes this a roadmap.
 *
 * `depth` is a real budget the cloud is told about rather than left to guess: an unbounded agent
 * wanders and a silently-bounded one looks lazy.
 */
function buildPlan({ intent = null, depth = {}, mustCite = false, unresolved = [] } = {}) {
  const maxHops = Number.isFinite(depth.maxHops) ? depth.maxHops : 3;
  const lines = [];
  lines.push('HOW TO WORK THIS TURN:');
  if (intent) lines.push(`• What is actually being asked: ${intent}`);
  lines.push(`• You may make up to ${maxHops} tool call${maxHops === 1 ? '' : 's'} before answering. `
    + 'Prefer ONE well-chosen recipe over several broad searches. Our own database first, the open web last.');
  if (unresolved && unresolved.length) {
    lines.push(`• Known gaps going in — resolve these if you can, say so plainly if you can't: ${unresolved.slice(0, 5).join('; ')}.`);
  }
  lines.push('• BACK-CHECK before you answer: every specific claim — a name, number, date, quantity — '
    + 'must trace to something in this package or to a tool result you just pulled. If it traces to '
    + 'neither, either go get it or say you don\'t have it.');
  lines.push('• "I don\'t have that" and "I didn\'t look" are DIFFERENT sentences. Never say you '
    + 'checked, searched, or looked something up unless you actually called a tool this turn.');
  if (mustCite) lines.push('• Cite the source for factual claims — the recipe, document, or URL it came from.');
  lines.push('• Answer the question that was asked. If you also need to raise something else, answer first.');
  return lines.join('\n');
}

/**
 * Assemble the package.
 *
 * Returns { messages, report }. `report.sections` carries { name, chars, budget, trimmed } per
 * section and `report.fit` is the fraction of the input budget used — under ~0.2 means we are
 * paying for a window we aren't filling, over 1.0 is impossible by construction (we trim first).
 */
function build({ sections = {}, window: win = {}, budgetChars = null } = {}) {
  const total = budgetChars || inputBudgetChars(win);

  const fixed = ORDER.filter((n) => UNTRIMMABLE.has(n))
    .reduce((sum, n) => sum + String(sections[n] || '').length, 0);
  const forWeighted = Math.max(0, total - fixed);

  const report = { sections: [], total: 0, budget: total, fit: 0, trimmedAny: false, droppedAny: false };
  const parts = [];

  for (const name of ORDER) {
    const raw = String(sections[name] || '').trim();
    if (!raw) continue;
    let budget = Infinity;
    if (!UNTRIMMABLE.has(name)) {
      // The weighted share, but never below the section's floor — an oversized untrimmable section
      // must not be able to silently delete the tool menu (see FLOORS).
      budget = Math.max(Math.floor(forWeighted * (WEIGHTS[name] || 0)), FLOORS[name] || 0);
      // If even the floor can't be honoured by the raw content, keep whatever is there; if the
      // content is LONGER than the floor but the floor is all we can give, that's the trim.
    }
    let text = budget === Infinity ? raw : _trim(raw, budget);
    // A stub is worse than an absence: a truncated tool menu invites calls to tools it no longer
    // lists. Below the floor, drop the section and SAY SO in the report.
    let dropped = false;
    if (budget !== Infinity && text.length < (FLOORS[name] || 0) && raw.length >= (FLOORS[name] || 0)) {
      text = ''; dropped = true;
    }
    const trimmed = text.length < raw.length;
    if (trimmed) report.trimmedAny = true;
    if (dropped) report.droppedAny = true;
    report.sections.push({ name, chars: text.length, raw: raw.length, budget: budget === Infinity ? null : budget, trimmed, dropped });
    if (!text) continue;
    report.total += text.length;
    parts.push(text);
  }
  report.fit = total > 0 ? +(report.total / total).toFixed(3) : 0;

  return { messages: [{ role: 'system', content: parts.join('\n\n') }], report };
}

/** One-line summary for the log — so package size is observable per turn, not inferred. */
function describe(report) {
  if (!report) return '(no report)';
  const secs = report.sections.map((s) => `${s.name}:${s.dropped ? 'DROPPED' : s.chars + (s.trimmed ? '↓' : '')}`).join(' ');
  return `${report.total}/${report.budget}c (fit ${Math.round(report.fit * 100)}%) — ${secs}`;
}

module.exports = { build, buildManifest, buildPlan, inputBudgetChars, describe, _trim, WEIGHTS, ORDER, UNTRIMMABLE, CHARS_PER_TOKEN };
