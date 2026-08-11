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

// The headings, shared by the one-pass digest, the per-part pass and the merge, so parts compose.
const SECTIONS = '**Topics** — every distinct subject discussed, in the order it came up, with who raised it.\n'
  + '**Decisions** — what was actually settled, and by whom.\n'
  + '**Action items** — each concrete follow-up with its owner and any date given.\n'
  + '**Open questions** — anything raised and left unresolved.';
const FIDELITY = 'Be specific: real names, numbers and dates as spoken. Attribute to the person who said it. '
  + 'Invent nothing and infer nothing the transcript does not support; if a stretch is garbled or the captions dropped, '
  + 'say so rather than smoothing it over.';

// WHO WAS IN THE ROOM. `roster` = who actually spoke (ours, from the captions). `invited` = the
// calendar's list. Both matter and they differ: "Sibley" appears ZERO times in our captions, which is
// exactly why Google's notes can write "[Megan Sibley]" and ours could only write "Megan". The
// calendar is where a surname comes from — and a name list is also the cheapest guard against the
// model inventing an attributor.
function peopleBlock({ roster = '', invited = '' } = {}) {
  const out = [];
  if (roster) out.push(`People heard speaking: ${roster}`);
  if (invited) out.push(`Everyone invited (use these spellings and full names when attributing): ${invited}`);
  return out.length ? out.join('\n') + '\n' : '';
}

// The one-pass authoritative digest, from the RAW transcript. This is the record.
function buildDigestPrompt(rawTranscript, opts = {}) {
  const { title = '' } = opts;
  return `You are writing the OFFICIAL MINUTES of a meeting from its complete verbatim transcript.\n\n`
    + `${title ? `Meeting: ${title}\n` : ''}${peopleBlock(opts)}\n`
    // NO .slice() — a transcript too large for the window is CHUNKED by planChunks and built whole,
    // never trimmed. Truncating here would have re-created the exact bug this file exists to fix,
    // one layer up: a tail slice silently deletes the start of the meeting.
    + `Full transcript:\n${String(rawTranscript || '')}\n\n`
    + `Write the complete minutes, covering the WHOLE meeting from its opening to its close — not just the end. Use:\n`
    + `${SECTIONS}\n\n${FIDELITY} Output ONLY the minutes.`;
}

/**
 * ONE PART of an oversized meeting. Same headings as the whole, so parts merge cleanly.
 *
 * A part is told its position, because "the meeting opened with…" is only true of part 1 and a model
 * given a middle slice will otherwise narrate it as though it were the beginning.
 */
function buildPartPrompt(chunk, { i = 1, n = 1, title = '', ...rest } = {}) {
  return `You are minuting ONE SECTION of a long meeting — section ${i} of ${n}.\n\n`
    + `${title ? `Meeting: ${title}\n` : ''}${peopleBlock(rest)}\n`
    + `Transcript of section ${i} of ${n}${i > 1 ? ' (the meeting was already under way — do NOT describe this as the opening)' : ''}:\n${String(chunk || '')}\n\n`
    + `Minute THIS SECTION completely, under:\n${SECTIONS}\n\n`
    + `Cover everything in this section — it is the only pass anyone will make over these lines, so anything you leave out is lost for good. `
    + `${FIDELITY} Output ONLY the minutes for this section.`;
}

/**
 * MERGE the parts into one document.
 *
 * The merge is explicitly a RE-ORGANISATION, not a summarization: every item must survive. This is
 * the one step that could re-introduce the original disease (a model handed a long document and
 * asked to "combine" will happily compress it), so the instruction says so in as many words, and
 * `digestWhole` refuses to use a merge that came back suspiciously short.
 */
function buildMergePrompt(parts = [], { title = '' } = {}) {
  const body = parts.map((p, i) => `--- Section ${i + 1} of ${parts.length} ---\n${p}`).join('\n\n');
  return `These are the minutes of ONE meeting, taken section by section${title ? ` (${title})` : ''}.\n\n${body}\n\n`
    + `Combine them into a single set of minutes under:\n${SECTIONS}\n\n`
    + `This is a MERGE, not a summary. EVERY topic, decision, action item and open question above must appear in your output — `
    + `carry each one across, keeping its owner, dates and numbers exactly as written. `
    + `You may only: put them under the right heading, restore chronological order, and collapse entries that are literally the same item recorded twice. `
    + `Do NOT shorten, generalise, rank, or drop anything for being minor, and never write a placeholder like "as previously noted". `
    + `If two sections conflict, keep BOTH and note the disagreement. Output ONLY the merged minutes.`;
}

/**
 * Split a transcript into ordered chunks that each fit the budget, on LINE boundaries.
 *
 * Pure and tested. A single line longer than the budget is emitted whole rather than cut — losing a
 * caption to fit an arithmetic bound is the failure mode this whole file is about, and one oversized
 * line is a cheaper problem than a silently truncated one.
 */
function planChunks(text, budgetChars) {
  const s = String(text || '');
  const budget = Math.max(1000, Number(budgetChars) || 0);
  if (!s) return [];
  if (s.length <= budget) return [s];
  const out = [];
  let cur = '';
  for (const line of s.split('\n')) {
    if (cur && (cur.length + 1 + line.length) > budget) { out.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

/** Usable INPUT chars for one call: the real window, less the reply budget, less a safety margin. */
function inputBudgetChars(numCtx, numPredict) {
  const ctx = Number(numCtx) || 8192;
  const pred = Number(numPredict) || 2048;
  return Math.max(4000, Math.floor((ctx - pred) * 4 * 0.85));   // 4 chars/token, conservative
}

/**
 * BUILD THE WHOLE MEETING DOCUMENT — never a truncated one.
 *
 * Lucas, 2026-07-21: *"instead of eating an existing meeting if full it should build the meeting
 * document as a whole."*
 *
 * Fits in the window → one pass, as before. Doesn't fit → minute each ordered section, then merge.
 * The transcript is never sliced. The window comes from the MODEL (lib/cloud_window) rather than the
 * hard-coded 32,768 this used to assume: today's meeting was 18,190 prompt tokens against that
 * assumption, so a two-hour meeting would have overflowed and ollama drops from the FRONT — the
 * "eats the beginning" failure returning through a different door.
 */
async function digestWhole(d, raw, opts = {}) {
  const cfg = require('./config');
  const numPredict = cfg.sectionNumPredict();
  const model = opts.model || cfg.deepReasonerModel();
  let numCtx = cfg.deepNumCtx();
  try {
    const w = await require('./cloud_window').resolve({ model });
    // Trust the resolver only when it beats the configured floor — it fails safe to 8192, and
    // accepting that would CAUSE the chunking it is meant to let us avoid.
    if (w && w.num_ctx && w.num_ctx > numCtx) numCtx = w.num_ctx;
  } catch { /* keep the configured window */ }

  const budget = inputBudgetChars(numCtx, numPredict);
  const overhead = buildDigestPrompt('', opts).length;
  const chunks = planChunks(raw, Math.max(4000, budget - overhead));
  // The resolved window is PASSED to the call (audit 2026-07-22): this planned chunks against the
  // real window, logged it — and then runModel transmitted at deepNumCtx (32768), so a single-pass
  // digest planned for 131k+ was front-truncated anyway. Plan and transmission now use one number.
  const run = (p) => runModel(d, p, numPredict, model, numCtx);

  if (chunks.length <= 1) {
    console.log(`[scribe] digest: 1 pass, ${raw.length} chars, num_ctx ${numCtx} (${model})`);
    return run(buildDigestPrompt(raw, opts));
  }

  console.log(`[scribe] digest: ${raw.length} chars exceeds the window → ${chunks.length} sections, building whole (num_ctx ${numCtx})`);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const p = await run(buildPartPrompt(chunks[i], { ...opts, i: i + 1, n: chunks.length }));
    if (p) parts.push(p);
    else console.error(`[scribe] section ${i + 1}/${chunks.length} produced nothing — it will be reported as a gap`);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];

  const joined = parts.map((p, i) => `## Section ${i + 1}\n${p}`).join('\n\n');
  const merged = await run(buildMergePrompt(parts, opts));
  // THE GUARD. A merge is the one step that can silently re-compress the whole meeting, so a result
  // materially shorter than its own inputs is treated as a failed merge, and the SECTIONS ship
  // instead. Verbose and correct beats tidy and lossy — that trade is the entire point of this file.
  if (!merged || merged.length < joined.length * 0.5) {
    console.error(`[scribe] merge came back short (${merged ? merged.length : 0} vs ${joined.length} chars) — shipping the sections whole instead`);
    return `_These minutes were assembled from ${parts.length} sections; the combining pass was rejected for dropping detail, so each section is given in full._\n\n${joined}`;
  }
  return merged;
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
// running minutes stay on the fast scribe model for cadence (cloud-leverage). num_ctx defaults to the
// deep window; digestWhole passes the model's RESOLVED window so what was planned is what is sent.
// think:false keeps the record, not chain-of-thought.
async function runModel(d, prompt, numPredict, modelOverride, numCtx = null) {
  const cfg = require('./config');
  let out = '';
  try {
    await d.streamChat({
      model: modelOverride || d.MODEL,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.3, top_p: 0.9, num_ctx: numCtx || cfg.deepNumCtx(), num_predict: numPredict },
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
  // RE-ENTRANCY CLAIM (live incident 2026-08-11): the digest below is a ~20s whole-transcript pass, and
  // scribe_active was only cleared at the END (line ~361) — so while it ran, hasPending() stayed true and
  // every heartbeat tick re-entered the meeting-end block and started ANOTHER concurrent finalize: ~11
  // duplicate notes docs landed and each 20s digest stacked a main-thread stall that failed live user turns.
  // CLAIM the finalize synchronously now (single-threaded → lands before any other tick is scheduled): a
  // concurrent call hits the `!== '1'` guard above and returns '', and hasPending() (=== '1') goes false so
  // the tick can't re-enter mid-digest. Still cleared to '0' at the end; on a throw it stays out of '1', so
  // the loop STOPS rather than re-firing (strictly safer than the old stuck-at-'1' behavior).
  db.setMeta('scribe_active', 'finalizing');
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
    const raw = d.rawTranscript ? await d.rawTranscript() : await rawTranscriptForMeeting();
    if (raw && raw.text && raw.text.trim().length >= 200) {
      const opts = { title: raw.title, roster: raw.roster, invited: raw.invited };
      digest = await digestWhole(d, raw.text, opts);
      // A dead reasoner must not cost the record — retry on the proven scribe model.
      if (!digest) digest = await digestWhole(d, raw.text, { ...opts, model: d.MODEL });
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
async function rawTranscriptForMeeting() {
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
    // THE CALENDAR'S NAMES. Google's notes could attribute an action to "[Megan Sibley]"; ours could
    // only ever have said "Megan", because "Sibley" occurs ZERO times in the captions. A surname is
    // not in the transcript — it is on the invite. Same source lib/references uses for the meeting's
    // room context, so there is one roster, not two.
    let invited = '', title = '';
    try {
      const R = require('./references');
      const labels = await R.meetingLabels({}, { now: Date.now() });
      const l = labels.get(String(code).toLowerCase());
      if (l) { invited = (l.invited || []).join(', '); title = l.title || ''; }
    } catch { /* no calendar → speakers alone still carry the record */ }
    if (!title) { try { title = require('./meeting_lane').meetingTitle({ url: db.getMeta('gmeet_url') || '' }); } catch { title = ''; } }
    return {
      text: use.map((r) => `${r.speaker ? r.speaker + ': ' : ''}${r.text}`).join('\n'),
      lines: use.length,
      title,
      roster: [...new Set(use.map((r) => String(r.speaker || '').trim()).filter(Boolean))].join(', '),
      invited,
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
  cleanModelText, buildMinutesPrompt, buildSegmentPrompt, buildDigestPrompt, buildPartPrompt, buildMergePrompt,
  planChunks, inputBudgetChars, digestWhole, peopleBlock, appendSegment, rawTranscriptForMeeting,
  UPDATE_EVERY_LINES, buildRecapPrompt,
};
