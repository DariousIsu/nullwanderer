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
  if (typeof step.directive !== 'function') return null;
  try { return step.directive(active.ctx); } catch { return null; }
}

// If the current generative step only wants a specific tag, return it (else null);
// the driver dispatches only that tag so the model can't fire other tools mid-action.
function currentExpect() {
  if (!active) return null;
  return active.def.steps[active.idx].expect || null;
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

// If the current step is DETERMINISTIC (has an auto() — e.g. start-draft, send),
// run it directly instead of asking the model to emit a tag. Returns true if it
// ran an auto step (caller then skips model generation), false if the step needs
// the model. This is the core reliability move: only genuinely generative steps
// (writing the reply body) go to the 24B; the mechanical tags the loop fires itself.
async function runCurrentAuto() {
  if (!active) return false;
  const step = active.def.steps[active.idx];
  if (typeof step.auto !== 'function') return false;
  try { await step.auto(active.ctx); } catch (e) { console.log('[action] auto step threw:', e && e.message); }
  return true;
}

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
        // Start the draft — deterministic (to/subject are already known). The loop
        // fires the tag itself rather than hoping the 24B emits it correctly.
        auto: () => emailLib.dispatch({ tag: 'email-draft', attrs: { to, subject: subj } }, { source: 'action' }),
        check: () => { const d = emailLib.draftState(); return !!(d && d.to); }
      },
      {
        // The ONLY step that needs the model: write the actual reply text.
        // `expect` restricts dispatch to email-body so a stray <email>/<email-draft>
        // from the model can't clobber the draft headers or fire an uncontrolled send.
        expect: 'email-body',
        directive: () => `You are writing a reply email to ${to}. Their message was: "${(snippet || '').slice(0, 220)}".\nWrite your reply now and emit it inside ONE tag, exactly like this:\n<email-body>your reply text here</email-body>\nEmit only that single tag with your message inside it. Do NOT include To: or Subject: lines — just the body of your reply.`,
        check: () => { const d = emailLib.draftState(); return !!(d && d.body && d.body.length > 0); }
      },
      {
        // Send — deterministic. Pass the known to/subject explicitly so the send is
        // correct even if the body turn clobbered the draft headers.
        auto: async () => {
          const r = await emailLib.dispatch({ tag: 'email-send', attrs: { to, subject: subj } }, { source: 'action' });
          if (!(r && r.ok)) console.log('[action] email-send failed:', (r && r.reason) || 'unknown');
          else console.log('[action] email-send ok →', r.to);
          return r;
        },
        check: () => { const d = emailLib.draftState(); return !d; } // cleared on successful send
      }
    ]
  };
}

module.exports = { start, observe, abort, isActive, currentDirective, currentExpect, runCurrentAuto, snapshot, emailReplyAction };
