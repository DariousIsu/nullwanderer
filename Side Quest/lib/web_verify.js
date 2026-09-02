/**
 * Verified web action (Vision→Action Phase 1) — spec: docs/PHASE1_VERIFIED_ACTION_SPEC.md.
 *
 * Today she can ACT in her own browser (<web-click>/<web-type>/…) but those tags surface NOTHING
 * back — she acts blind. This makes every state-changing action self-perceiving + self-verifying:
 * act → fresh a11y read (always) → gated VISION verify (did the expected thing happen?) → a recovery
 * directive if not, all fed back in one followup. Telemetry logged so we can study her behavior.
 *
 * This module is the PURE brain: the gate, the verdict parse, the prompt + followup text. The IO
 * (web.read / web.screenshot / vision.describe / fireToolFollowup) lives in main.js so this stays
 * deterministic + smoke-testable with no browser/model. Her OWN browser only (shared/os_* are gated).
 */
'use strict';
const db = require('./db');

const STATE_CHANGING = new Set(['web-click', 'web-type', 'web-scroll', 'web-back']);
function isStateChanging(tag) { return STATE_CHANGING.has(String(tag || '').toLowerCase()); }

// Config (db meta, no migration). Default verify=always during the STUDY phase (richest data);
// flip to auto once her behavior is learned.
function verifyMode() { try { return (db.getMeta('web.verify') || 'always').trim(); } catch { return 'always'; } }
function maxVisionPerTurn() { try { return parseInt(db.getMeta('web.verify.maxVisionPerTurn') || '', 10) || 3; } catch { return 3; } }
function minReadChars() { try { return parseInt(db.getMeta('web.verify.minReadChars') || '', 10) || 120; } catch { return 120; } }

// Count interactable handles ([L0]/[B0]/[I0]/[C0]) in a fresh read — a thin count ≈ canvas/visual
// page the a11y read can't capture, so vision should look.
function countHandles(text) { return (String(text || '').match(/\[[LBIC]\d+\]/g) || []).length; }

// §4.3 gate. mode/threshold passed for testability.
function shouldVisionVerify({ mode = 'always', readText = '', newHandleCount = null, expect = null, navigated = false, errored = false, minChars = 120 } = {}) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode !== 'auto') return false;
  const handles = newHandleCount == null ? countHandles(readText) : newHandleCount;
  const thin = String(readText || '').length < minChars || handles < 2;   // likely canvas/visual
  return !!(thin || expect || navigated || errored);
}

const VERDICTS = ['confirmed', 'unclear', 'failed'];
function parseVerdict(text) {
  const m = String(text || '').trim().toLowerCase().match(/^\W*(confirmed|unclear|failed)\b/);
  return m ? m[1] : 'unclear';   // unparseable → unclear (never silently "confirmed")
}

function buildVerifyPrompt({ action, expect } = {}) {
  return `This screenshot is the page AFTER this action: «${action}» (expected: «${expect || 'none stated'}»). `
    + `In 1-2 sentences: did the expected result happen? Call out any error message, popup/dialog, or that nothing changed. `
    + `Begin with one word: CONFIRMED, UNCLEAR, or FAILED.`;
}

// Strip the leading verdict keyword from the vision text → the short human note.
function noteFrom(text) {
  return String(text || '').replace(/^\W*(confirmed|unclear|failed)\b[\s:.,—–-]*/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// The single followup carrying outcome + fresh state + verdict + recovery directive.
function buildFollowupText({ action, expect = null, readText = '', verdict = null, note = '', userName = 'Lucas' } = {}) {
  const head = `[You just did: ${action}${expect ? ` (you expected: ${expect})` : ''}.`;
  const v = verdict ? ` Visual check: ${verdict.toUpperCase()}${note ? ` — ${note}` : ''}.` : '';
  let dir;
  if (verdict === 'confirmed') dir = ` It worked — continue the task or tell ${userName} the result, in your own voice.`;
  else if (verdict === 'failed' || verdict === 'unclear') dir = ` It may NOT have worked. Look at the fresh page state below, then recover: pick a different handle, scroll, re-read, or ask ${userName}. Do NOT re-click the same thing blindly, and never claim a success you can't actually see.`;
  else dir = ` Use the fresh page state below to decide your next step — don't claim an outcome you can't see.`;
  // truncateFramed, never a raw slice (audit S21): the read is content-firewall-framed and can
  // exceed the cap — a bare slice cuts inside the box and orphans the ⟦/EXTERNAL⟧ closer, so
  // everything after reads as untrusted-but-unterminated to the model.
  const _fw = (() => { try { return require('./content_firewall'); } catch { return null; } })();
  const _framed = _fw ? _fw.truncateFramed(String(readText), 2500) : String(readText).slice(0, 2500);
  const state = readText ? `\n\nThe page now (fresh read + handles):\n${_framed}` : '\n\n(No readable page text came back — say so and consider re-reading.)';
  return head + v + dir + state + ']';
}

module.exports = {
  STATE_CHANGING, isStateChanging, verifyMode, maxVisionPerTurn, minReadChars,
  countHandles, shouldVisionVerify, parseVerdict, buildVerifyPrompt, noteFrom, buildFollowupText, VERDICTS
};
