/**
 * lib/meeting_scribe.js — the MEETING SCRIBE: a SEPARATE recorder that documents + analyzes the
 * meeting on its own dedicated cloud model (config.scribeModel — gemini-3-flash by default).
 *
 * This is NOT her actor. Her participation (listening / researching / answering) stays entirely in
 * lib/gmeet, untouched. The scribe runs in parallel: it reads the transcript she's ALREADY capturing
 * (db.meeting_transcript, written by gmeet's observe stage), keeps a running set of minutes (topics /
 * decisions / action items) updated every few lines, and at meeting end writes the final record as a
 * durable memory. One model tick per update, throttled by line count; advanced from the idle loop
 * AFTER gmeet's tick (orchestration layer), so gmeet's code is never modified.
 *
 * State (db meta): scribe_active, scribe_cursor (ts), scribe_minutes, scribe_buffer, scribe_pending.
 */
'use strict';
const db = require('./db');

const UPDATE_EVERY_LINES = 6;     // refresh the running minutes after this many new transcript lines

// --- pure helpers (unit-tested) ---
// Strip any leaked reasoning blocks (thinking models), then stray tags + wrapping quotes.
function cleanModelText(s) {
  return String(s == null ? '' : s)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function buildMinutesPrompt(priorMinutes, newText) {
  const prior = (priorMinutes || '').trim() || '(no minutes yet)';
  return `You are the MEETING SCRIBE — keep a running, factual record of a live meeting (you are documenting, not participating).\n\nMinutes so far:\n${prior}\n\nNew transcript since the last update:\n${String(newText || '').slice(-4000)}\n\nReturn the UPDATED minutes: concise bullets under three headings — Topics, Decisions, Action items (each action tagged with its owner). Merge the new transcript into the existing minutes; do not repeat points or invent anything. Output ONLY the updated minutes, no preamble.`;
}
function buildRecapPrompt(minutes) {
  return `From these running meeting minutes, write the FINAL record for Lucas:\n- 2–4 sentences on what the meeting was about and what was decided.\n- Then "Action items:" — each concrete follow-up with its owner (Lucas / a named person / Zoe).\nBe specific (names, dates, numbers); only what the minutes support; no preamble.\n\nMinutes:\n${String(minutes || '').slice(-7000)}`;
}

function defaultDeps() {
  return {
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').scribeModel(),
    getTranscriptSince: (ts, lim) => db.getTranscriptSince(ts, lim),
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'meeting', content, source: opts.source || 'scribe', importance: opts.importance == null ? 0.8 : opts.importance }); } catch { return null; } },
    now: () => Date.now(),
  };
}

async function runModel(d, prompt, numPredict) {
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.3, top_p: 0.9, num_ctx: 16384, num_predict: numPredict },
      think: false,   // scribe wants the record, not chain-of-thought — full budget to the output
      onToken: (t) => { out += t; },
    });
  } catch { return ''; }
  return cleanModelText(out);
}

// True when a scribe session is underway (so the loop knows to finalize after the meeting ends).
function hasPending() { return db.getMeta('scribe_active') === '1'; }
function lastRecap() { return db.getMeta('scribe_last_recap') || ''; }
function minutes() { return db.getMeta('scribe_minutes') || ''; }

// One scribe step: pull new transcript lines, accumulate, and refresh the minutes every N lines.
// Auto-initializes a session on first call while a meeting is live. Returns { updated, lines }.
async function tick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  if (db.getMeta('scribe_active') !== '1') {
    const startTs = parseInt(db.getMeta('gmeet_started_at') || '0', 10) || d.now();
    db.setMeta('scribe_active', '1'); db.setMeta('scribe_cursor', String(startTs));
    db.setMeta('scribe_minutes', ''); db.setMeta('scribe_buffer', ''); db.setMeta('scribe_pending', '0');
  }
  const cursor = parseInt(db.getMeta('scribe_cursor') || '0', 10);
  const rows = d.getTranscriptSince(cursor, 800) || [];
  if (rows.length) {
    const block = rows.map(r => `${r.speaker ? r.speaker + ': ' : ''}${r.text}`).join('\n');
    db.setMeta('scribe_buffer', ((db.getMeta('scribe_buffer') || '') + (db.getMeta('scribe_buffer') ? '\n' : '') + block).slice(-6000));
    db.setMeta('scribe_cursor', String(rows[rows.length - 1].ts + 1));
    db.setMeta('scribe_pending', String(parseInt(db.getMeta('scribe_pending') || '0', 10) + rows.length));
  }
  if (parseInt(db.getMeta('scribe_pending') || '0', 10) >= UPDATE_EVERY_LINES) {
    const updated = await runModel(d, buildMinutesPrompt(db.getMeta('scribe_minutes') || '', db.getMeta('scribe_buffer') || ''), 1200);
    if (updated) db.setMeta('scribe_minutes', updated.slice(-8000));
    db.setMeta('scribe_pending', '0'); db.setMeta('scribe_buffer', '');
    return { updated: !!updated, lines: rows.length };
  }
  return { updated: false, lines: rows.length };
}

// End of meeting: flush any remaining buffer into the minutes, write the final recap as durable
// memory, and clear state. Returns the recap text ('' if nothing substantive was captured).
async function finalize(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  if (db.getMeta('scribe_active') !== '1') return '';
  let mins = db.getMeta('scribe_minutes') || '';
  const buffer = db.getMeta('scribe_buffer') || '';
  if (buffer.trim()) { const u = await runModel(d, buildMinutesPrompt(mins, buffer), 1200); if (u) mins = u; }
  let recap = '';
  if (mins.trim().length >= 30) recap = await runModel(d, buildRecapPrompt(mins), 1200);
  if (recap && d.storeMeeting) { try { await d.storeMeeting(`Meeting record (scribe): ${recap}`, { kind: 'meeting', source: 'scribe', importance: 0.8 }); } catch {} }
  db.setMeta('scribe_active', '0'); db.setMeta('scribe_minutes', ''); db.setMeta('scribe_buffer', ''); db.setMeta('scribe_pending', '0');
  db.setMeta('scribe_last_recap', recap || '');
  return recap;
}

function reset() { for (const k of ['scribe_active', 'scribe_cursor', 'scribe_minutes', 'scribe_buffer', 'scribe_pending']) db.setMeta(k, k === 'scribe_active' ? '0' : (k === 'scribe_pending' || k === 'scribe_cursor' ? '0' : '')); }

module.exports = { tick, finalize, hasPending, lastRecap, minutes, reset, defaultDeps, cleanModelText, buildMinutesPrompt, buildRecapPrompt, UPDATE_EVERY_LINES };
