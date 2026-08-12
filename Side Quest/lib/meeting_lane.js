/**
 * meeting_lane — INTEGRATE + GATE the meeting/scribe data channel into the memory pipeline.
 *
 * Lucas's frame: the meeting notes are a BUILDING-PROJECT DOCUMENT — the scribe's running minutes grow
 * live as the meeting runs (the canvas live-grow), and at the end the COMPLETED notes get a COMPANION
 * TRANSCRIPT. This module lands that pair into the short-term documents store (lib/doc_store / the
 * `documents` table) at meeting end, so it flows through the same land→answer→promote pipeline as every
 * other new material: the NOTES are the primary document (source='meeting'), the full diarized TRANSCRIPT
 * is the linked companion (source='meeting_transcript', parent_id → the notes). Nightly promotion files
 * them into Echo long-term (notes = vault doc + KG; transcript = the companion source).
 *
 * Gating: the meeting stays a governed LANE — its artifact lands as a document (not an identity-feeding
 * reflection), and the heartbeat sees a POINTER (pointer()), never the raw transcript. The PURE builders
 * are smoke-tested; land() is the thin DB wrapper. Fail-safe: never throws.
 */
'use strict';
const db = require('./db');

const str = (v) => (v == null ? '' : String(v));

// Diarized transcript rows ([{speaker,text,ts}]) → "Speaker: text" lines.
function formatTranscript(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => `${r && r.speaker ? r.speaker + ': ' : ''}${str(r && r.text).trim()}`)
    .filter(l => l.length > 1)
    .join('\n');
}

// A clean title from the Meet URL + an optional date string.
function meetingTitle({ url = '', dateStr = '' } = {}) {
  const code = (str(url).match(/meet\.google\.com\/([a-z0-9-]+)/i) || [])[1] || '';
  return `Meeting notes${code ? ` — ${code}` : ''}${dateStr ? ` (${dateStr})` : ''}`.trim() || 'Meeting notes';
}

// Build the artifact pair from what the scribe produced. NOTES = the completed building-project document
// (final recap + the running minutes detail); TRANSCRIPT = the companion (only when there's real content).
function buildArtifacts({ title = 'Meeting notes', minutes = '', recap = '', transcriptText = '' } = {}) {
  const r = str(recap).trim();
  const m = str(minutes).trim();
  const notesBody = [r, m ? `## Running minutes\n${m}` : ''].filter(Boolean).join('\n\n').trim();
  const notes = notesBody ? { title, body: notesBody, source: 'meeting', understanding: (r || m).slice(0, 600) } : null;
  const tx = str(transcriptText).trim();
  const transcript = (tx.length >= 40)
    ? { title: `Transcript — ${title.replace(/^Meeting notes\s*—?\s*/i, '').trim() || title}`, body: tx, source: 'meeting_transcript' }
    : null;
  return { notes, transcript };
}

// The heartbeat POINTER (lane isolation — she never gets the raw stream in her inner life).
function pointer({ title = 'a meeting', lines = 0 } = {}) {
  return `scribing ${title}${lines ? ` — ${lines} transcript lines captured` : ''}`;
}

// I/O: land the completed notes + companion transcript into the short-term documents store. Returns
// { landed, notesId, transcriptId, hasTranscript }. Idempotent-ish via the meeting-anchored ref.
function land({ minutes = '', recap = '', audioTranscript = '', dateStr = '', deps = {} } = {}) {
  const _db = deps.db || db;
  try {
    const url = _db.getMeta('gmeet_url') || '';
    const startedAt = parseInt(_db.getMeta('gmeet_started_at') || '0', 10) || 0;
    // Companion transcript = the high-quality Echo AUDIO transcript when available (Lucas's virtual-cable
    // path), else the caption-driven transcript Meet gave us. Audio is authoritative + fully diarized.
    const rows = startedAt ? (_db.getTranscriptSince(startedAt, 5000) || []) : [];
    const transcriptText = (String(audioTranscript || '').trim().length >= 40) ? String(audioTranscript).trim() : formatTranscript(rows);
    const { notes, transcript } = buildArtifacts({ title: meetingTitle({ url, dateStr }), minutes, recap, transcriptText });
    if (!notes) return { landed: false };
    // THROUGH THE LAND DOOR (2026-08-12 review H6, CONFIRMED): raw insertDocument left every meeting
    // doc with importance=null and ZERO reflection pressure — the flagship above-ordinary source C2
    // names ('meeting' base 8, 'meeting_transcript' 7) was invisible to C3. doc_store.land stamps
    // importance, bumps the accumulator, and adds content-dedup for free.
    const ds = require('./doc_store');
    const n = ds.land({ title: notes.title, body: notes.body, source: notes.source, ref: `meeting:${startedAt}`, understanding: notes.understanding, deps: { db: _db } });
    let transcriptId = null;
    if (transcript && n && n.id) {
      const t = ds.land({ title: transcript.title, body: transcript.body, source: transcript.source, ref: `meeting-transcript:${startedAt}`, parentId: n.id, deps: { db: _db } });
      transcriptId = t && t.id;
    }
    return { landed: !!(n && n.id), notesId: n && n.id, transcriptId, hasTranscript: !!transcript };
  } catch (e) { console.error('[meeting_lane] land failed:', e.message); return { landed: false }; }
}

module.exports = { formatTranscript, meetingTitle, buildArtifacts, pointer, land };
