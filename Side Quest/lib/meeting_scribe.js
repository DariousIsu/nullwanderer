/**
 * lib/meeting_scribe.js — the MEETING SCRIBE: a SEPARATE recorder that documents + analyzes the
 * meeting on its own dedicated cloud model (config.scribeModel — minimax-m3:cloud by default).
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

// ── WHY THIS IS APPEND-ONLY ─────────────────────────────────────────────────────────────────────
//
// Lucas, 2026-07-21: "it also looks like we are eating our meeting notes."
//
// He was right, and it was structural. The scribe used to hand the model the ENTIRE minutes so far
// plus the new lines and ask for "the UPDATED minutes" — a full rewrite every ~6 caption lines. Three
// things then compounded:
//
//   1. Each rewrite is a lossy re-encode of a summary of a summary, and it OVERWRITES its own source,
//      so every pass loses detail permanently.
//   2. "do not repeat points" reads to a model as "don't restate earlier topics" — caught live in the
//      Rainey Weekly Huddle, where an hour of minutes had collapsed to 749 chars beginning:
//      "Topics — All previous topics remain in effect." Six words in place of the whole first hour.
//   3. .slice(-12000) keeps the TAIL, so any growth eats the START of the meeting.
//
// The rolling rewrite existed to fit a small context. That assumption is dead: the largest meeting
// this system has ever recorded is 47,352 chars (~12k tokens) against a 131,072-token window. The
// whole raw transcript fits in 9% of it.
//
// So the live pass now summarizes ONLY ITS OWN WINDOW and APPENDS. Nothing already written can be
// touched by a later call — losing an earlier segment is no longer expressible. finalize() then reads
// the FULL RAW TRANSCRIPT (not the segments, not a summary) and writes the authoritative record in a
// single pass on the big model. The segments are the live view; the raw transcript is the truth.
function buildSegmentPrompt(newText, { at = '' } = {}) {
  return `You are the MEETING SCRIBE — documenting a live meeting, not participating.\n\n`
    + `Here is the NEXT STRETCH of transcript${at ? ` (from ${at})` : ''}:\n${String(newText || '').slice(-8000)}\n\n`
    + `Summarize ONLY this stretch — concise bullets under Topics, Decisions, Action items (each action tagged with its owner). `
    + `Do NOT summarize or restate anything outside this stretch, and never write a placeholder like "previous topics still apply" — `
    + `earlier minutes are kept separately and are not yours to edit. If a heading has nothing in this stretch, omit it entirely. `
    + `Invent nothing. Output ONLY the bullets, no preamble.`;
}

// The one-pass authoritative digest, from the RAW transcript. This is the record.
function buildDigestPrompt(rawTranscript, { title = '', roster = '' } = {}) {
  return `You are writing the OFFICIAL MINUTES of a meeting from its complete verbatim transcript.\n\n`
    + `${title ? `Meeting: ${title}\n` : ''}${roster ? `People present: ${roster}\n` : ''}\n`
    + `Full transcript:\n${String(rawTranscript || '').slice(-400000)}\n\n`
    + `Write the complete minutes, covering the WHOLE meeting from its opening to its close — not just the end. Use:\n`
    + `**Topics** — every distinct subject discussed, in the order it came up, with who raised it.\n`
    + `**Decisions** — what was actually settled, and by whom.\n`
    + `**Action items** — each concrete follow-up with its owner and any date given.\n`
    + `**Open questions** — anything raised and left unresolved.\n\n`
    + `Be specific: real names, numbers and dates as spoken. Attribute to the person who said it. `
    + `Invent nothing and infer nothing the transcript does not support; if a stretch is garbled or the captions dropped, say so rather than smoothing it over. `
    + `Output ONLY the minutes.`;
}

// Kept for the finalize fallback path when no raw transcript is reachable.
function buildMinutesPrompt(priorMinutes, newText) {
  const prior = (priorMinutes || '').trim() || '(no minutes yet)';
  return `You are the MEETING SCRIBE — keep a running, factual record of a live meeting (you are documenting, not participating).\n\nMinutes so far:\n${prior}\n\nNew transcript since the last update:\n${String(newText || '').slice(-8000)}\n\nReturn the UPDATED minutes: concise bullets under three headings — Topics, Decisions, Action items (each action tagged with its owner). Merge the new transcript into the existing minutes; do not repeat points or invent anything. Output ONLY the updated minutes, no preamble.`;
}
function buildRecapPrompt(minutes) {
  return `From these running meeting minutes, write the FINAL record for Lucas:\n- 2–4 sentences on what the meeting was about and what was decided.\n- Then "Action items:" — each concrete follow-up with its owner (Lucas / a named person / Zoe).\nBe specific (names, dates, numbers); only what the minutes support; no preamble.\n\nMinutes:\n${String(minutes || '').slice(-7000)}`;
}

function defaultDeps() {
  return {
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').scribeModel(),
    getTranscriptSince: (ts, lim) => db.getTranscriptSince(ts, lim),
    rawTranscript: () => rawTranscriptForMeeting(),
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'meeting', content, source: opts.source || 'scribe', importance: opts.importance == null ? 0.8 : opts.importance }); } catch { return null; } },
    now: () => Date.now(),
  };
}

// modelOverride lets finalize route the one-time RECAP to the deep reasoner (gpt-oss:120b) while the
// running minutes stay on the fast scribe model for cadence (cloud-leverage). num_ctx uses the deep window
// so the scribe can read a fat transcript slice; think:false keeps the record, not chain-of-thought.
async function runModel(d, prompt, numPredict, modelOverride) {
  const cfg = require('./config');
  let out = '';
  try {
    await d.streamChat({
      model: modelOverride || d.MODEL,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.3, top_p: 0.9, num_ctx: cfg.deepNumCtx(), num_predict: numPredict },
      think: false,   // scribe wants the record, not chain-of-thought — full budget to the output
      onToken: (t) => { out += t; },
    });
  } catch { return ''; }
  return cleanModelText(out);
}

// True when a scribe session is underway (so the loop knows to finalize after the meeting ends).
function hasPending() { return db.getMeta('scribe_active') === '1'; }
function lastRecap() { return db.getMeta('scribe_last_recap') || ''; }
// The LIVE view = every segment in order. This is what the notes panel renders mid-meeting; the
// authoritative record is written by finalize() from the raw transcript.
function minutes() {
  let rows = [];
  try { rows = JSON.parse(db.getMeta('scribe_segments') || '[]'); } catch { rows = []; }
  if (rows.length) return rows.map((r) => (r.at ? `**${r.at}**\n${r.text}` : r.text)).join('\n\n');
  return db.getMeta('scribe_minutes') || '';   // pre-segment meetings still render
}
function segments() { try { return JSON.parse(db.getMeta('scribe_segments') || '[]'); } catch { return []; } }

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
    db.setMeta('scribe_buffer', ((db.getMeta('scribe_buffer') || '') + (db.getMeta('scribe_buffer') ? '\n' : '') + block).slice(-10000));
    db.setMeta('scribe_cursor', String(rows[rows.length - 1].ts + 1));
    db.setMeta('scribe_pending', String(parseInt(db.getMeta('scribe_pending') || '0', 10) + rows.length));
  }
  if (parseInt(db.getMeta('scribe_pending') || '0', 10) >= UPDATE_EVERY_LINES) {
    const window = db.getMeta('scribe_buffer') || '';
    const at = (() => { try { return new Date(d.now()).toISOString().slice(11, 16); } catch { return ''; } })();
    const seg = await runModel(d, buildSegmentPrompt(window, { at }), require('./config').sectionNumPredict());
    // APPEND, never rewrite. A later call cannot reach an earlier segment, so "all previous topics
    // remain in effect" is not a thing this can produce any more.
    if (seg) appendSegment({ at, text: seg });
    db.setMeta('scribe_pending', '0'); db.setMeta('scribe_buffer', '');
    return { updated: !!seg, lines: rows.length };
  }
  return { updated: false, lines: rows.length };
}

/** Append one time-stamped segment. Bounded by COUNT, so the OLDEST survive a runaway meeting. */
function appendSegment(seg) {
  let rows = [];
  try { rows = JSON.parse(db.getMeta('scribe_segments') || '[]'); } catch { rows = []; }
  rows.push(seg);
  // If a meeting somehow produces more than this, drop from the MIDDLE and say so — the opening and
  // the close are the parts anyone reads, and silently trimming either is the bug being fixed.
  if (rows.length > 80) {
    const dropped = rows.length - 80;
    rows = [...rows.slice(0, 40), { at: '', text: `_[${dropped} intermediate segment(s) omitted — the full record is in the transcript]_` }, ...rows.slice(-39)];
  }
  db.setMeta('scribe_segments', JSON.stringify(rows));
}

// End of meeting: flush any remaining buffer into the minutes, write the final recap as durable
// memory, and clear state. Returns the recap text ('' if nothing substantive was captured).
async function finalize(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  if (db.getMeta('scribe_active') !== '1') return '';
  const cfg = require('./config');
  // Flush the tail window into a final segment so the close of the meeting is never the part lost.
  const buffer = db.getMeta('scribe_buffer') || '';
  if (buffer.trim()) {
    const at = (() => { try { return new Date(d.now()).toISOString().slice(11, 16); } catch { return ''; } })();
    const seg = await runModel(d, buildSegmentPrompt(buffer, { at }), cfg.sectionNumPredict());
    if (seg) appendSegment({ at, text: seg });
  }

  // ── THE DIGEST — one pass over the WHOLE RAW TRANSCRIPT on the big model ──────────────────────
  // Not from the segments and not from a summary: from what was actually said. The largest meeting
  // on record is 47,352 chars against a 131,072-token window, so "read the entire meeting" is simply
  // affordable, and every layer of summarization we skip is a layer that cannot lose anything.
  let digest = '';
  try {
    const raw = d.rawTranscript ? d.rawTranscript() : rawTranscriptForMeeting();
    if (raw && raw.text && raw.text.trim().length >= 200) {
      const reasoner = (cfg.get('ZOE_DEEP_REASONER_MODEL') || '').trim() || cfg.deepReasonerModel();
      digest = await runModel(d, buildDigestPrompt(raw.text, { title: raw.title, roster: raw.roster }), cfg.sectionNumPredict(), reasoner || undefined);
      // A dead override must not cost the record — fall back to the proven scribe model.
      if (!digest) digest = await runModel(d, buildDigestPrompt(raw.text, { title: raw.title, roster: raw.roster }), cfg.sectionNumPredict());
      if (digest) console.log(`[scribe] digest: ${raw.lines} raw line(s) / ${raw.text.length} chars → ${digest.length} chars of minutes`);
    }
  } catch (e) { console.error('[scribe] digest failed:', e.message); }

  // The digest is the record when we have one; the appended segments are the honest fallback.
  let mins = digest || minutes() || db.getMeta('scribe_minutes') || '';
  let recap = '';
  if (mins.trim().length >= 30) {
    // RECAP — one-time, high-value durable record, on the fat budget (sectionNumPredict). Optionally routed
    // to a DEEP REASONER when one is actually reachable: deepReasonerModel's bare default (gpt-oss:120b)
    // 404s here (needs a -cloud suffix), so only override when ZOE_DEEP_REASONER_MODEL names a real cloud
    // model; else stay on the proven fast scribe model. Fail-safe: an empty override falls back.
    const reasoner = (require('./config').get('ZOE_DEEP_REASONER_MODEL') || '').trim();
    recap = await runModel(d, buildRecapPrompt(mins), cfg.sectionNumPredict(), reasoner || undefined);
    if (!recap && reasoner) recap = await runModel(d, buildRecapPrompt(mins), cfg.sectionNumPredict());
  }
  if (recap && d.storeMeeting) { try { await d.storeMeeting(`Meeting record (scribe): ${recap}`, { kind: 'meeting', source: 'scribe', importance: 0.8 }); } catch {} }
  // Hand the FULL minutes back to the caller before clearing, so the record that lands on canvas is
  // the digest — not the recap alone, which is the "notes ate themselves" failure in another form.
  db.setMeta('scribe_last_minutes', mins || '');
  db.setMeta('scribe_active', '0'); db.setMeta('scribe_minutes', ''); db.setMeta('scribe_buffer', ''); db.setMeta('scribe_pending', '0');
  db.setMeta('scribe_segments', '[]');
  db.setMeta('scribe_last_recap', recap || '');
  return recap;
}

/** The verbatim record of the meeting she is in, straight from meeting_transcript. */
function rawTranscriptForMeeting() {
  try {
    const code = db.getMeta('gmeet_code') || (db.getMeta('gmeet_url') || '').split('/').pop() || null;
    if (!code) return null;
    const rows = db.getTranscriptForMeeting(code) || [];
    if (!rows.length) return null;
    const started = parseInt(db.getMeta('gmeet_started_at') || '0', 10) || 0;
    // THIS session only — a recurring series reuses its Meet code, so without this the digest would
    // silently fold last week's meeting into this week's minutes.
    const mine = started ? rows.filter((r) => r.ts >= started) : rows;
    const use = mine.length ? mine : rows;
    return {
      text: use.map((r) => `${r.speaker ? r.speaker + ': ' : ''}${r.text}`).join('\n'),
      lines: use.length,
      title: (() => { try { return require('./meeting_lane').meetingTitle({ url: db.getMeta('gmeet_url') || '' }); } catch { return ''; } })(),
      roster: [...new Set(use.map((r) => String(r.speaker || '').trim()).filter(Boolean))].join(', '),
    };
  } catch { return null; }
}
function lastMinutes() { return db.getMeta('scribe_last_minutes') || ''; }

function reset() {
  for (const k of ['scribe_active', 'scribe_cursor', 'scribe_minutes', 'scribe_buffer', 'scribe_pending']) db.setMeta(k, k === 'scribe_active' ? '0' : (k === 'scribe_pending' || k === 'scribe_cursor' ? '0' : ''));
  db.setMeta('scribe_segments', '[]');
}

module.exports = {
  tick, finalize, hasPending, lastRecap, lastMinutes, minutes, segments, reset, defaultDeps,
  cleanModelText, buildMinutesPrompt, buildSegmentPrompt, buildDigestPrompt, appendSegment, rawTranscriptForMeeting,
  UPDATE_EVERY_LINES, buildRecapPrompt,
};
