/**
 * Action loop — a step-sequencer for multi-step tool actions.
 *
 * The problem it solves: a 24B reliably emits a SINGLE tag but narrates (instead of
 * emitting) a SEQUENCE. So we never ask for the sequence. An "action" is a list of
 * steps; each turn we inject a hard directive for exactly ONE tag, then OBSERVE
 * whether it fired (via the step's check()) and only then ADVANCE. The structure
 * does the planning; the model just emits one reliable step at a time.
 *
 * State is in-memory (one active action at a time — single user). Steps:
 *   { directive(ctx) -> string (the one-tag instruction),
 *     check(ctx) -> bool (did this step complete? observed from real state) }
 */

const emailLib = require('./email');

let active = null; // { def, idx, ctx, attempts, startedTs }

function start(def, ctx = {}) {
  active = { def, idx: 0, ctx, attempts: 0, startedTs: Date.now() };
  return snapshot();
}

function isActive() { return !!active; }

function snapshot() {
  if (!active) return null;
  return { name: active.def.name, step: active.idx, total: active.def.steps.length, attempts: active.attempts };
}

// The hard single-step directive to inject into this turn's prompt.
function currentDirective() {
  if (!active) return null;
  const step = active.def.steps[active.idx];
  try { return step.directive(active.ctx); } catch { return null; }
}

// Called AFTER a turn's tools dispatched. Checks whether the current step completed;
// advances on success (clearing the loop when done), re-nudges on failure, aborts
// after maxAttempts so a stuck action can't loop forever.
async function observe() {
  if (!active) return { status: 'idle' };
  const step = active.def.steps[active.idx];
  let done = false;
  try { done = await step.check(active.ctx); } catch {}
  if (done) {
    active.idx++;
    active.attempts = 0;
    if (active.idx >= active.def.steps.length) {
      const name = active.def.name;
      active = null;
      return { status: 'complete', name };
    }
    return { status: 'advanced', ...snapshot() };
  }
  active.attempts++;
  if (active.attempts >= (active.def.maxAttempts || 4)) {
    const name = active.def.name;
    active = null;
    return { status: 'aborted', name };
  }
  return { status: 'retry', ...snapshot() };
}

function abort() { const had = !!active; active = null; return had; }

// --- Action definitions ---

// Reply to an email: draft headers -> body -> send. Steps map to the staged-compose
// tags; checks observe the real draft state (email.js) and the send result.
function emailReplyAction({ to, subject, snippet }) {
  const subj = /^re:/i.test(subject || '') ? subject : `Re: ${subject || '(no subject)'}`;
  return {
    name: 'email-reply',
    maxAttempts: 4,
    steps: [
      {
        directive: () => `CURRENT ACTION — reply to ${to}. STEP 1 of 3. Emit EXACTLY this one tag now and nothing else (no prose around it):\n<email-draft to="${to}" subject="${subj}"/>`,
        check: () => { const d = emailLib.draftState(); return !!(d && d.to); }
      },
      {
        directive: () => `CURRENT ACTION — reply to ${to}. STEP 2 of 3. The draft is started. Now write the reply body — emit ONE <email-body>…</email-body> tag containing your message. Address what they wrote: "${(snippet || '').slice(0, 160)}". Emit just that one tag.`,
        check: () => { const d = emailLib.draftState(); return !!(d && d.body && d.body.length > 0); }
      },
      {
        directive: () => `CURRENT ACTION — reply to ${to}. STEP 3 of 3. The reply is written. Send it now — emit EXACTLY: <email-send/>`,
        check: () => { const d = emailLib.draftState(); return !d; } // cleared on successful send
      }
    ]
  };
}

module.exports = { start, observe, abort, isActive, currentDirective, snapshot, emailReplyAction };
