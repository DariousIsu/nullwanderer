/**
 * meeting_audio — Echo transcription of the MEETING AUDIO, fused as the authoritative companion transcript.
 *
 * Lucas's path: route the Meet pane's audio to a VIRTUAL OUTPUT DEVICE (e.g. VB-CABLE), keep the physical
 * speakers silent (no echo), and have Echo loopback-capture that device → a full diarized transcript of the
 * remote participants (better than Meet's captions). OFF by default (config.meetingAudioConfig().enabled);
 * captions still feed the LIVE scribe. When enabled + the device is configured, capture runs for the whole
 * meeting and at the end its diarized transcript becomes the companion (preferred over the caption text).
 *
 * Reuses lib/listen's Echo transcription contract (capture_start → capture_stop → segments). dispatch =
 * echoSuit.dispatch (injected, offline-testable). Meeting-scoped meta so it never collides with the user
 * "listen to me" feature. Fail-safe: not enabled / no device / Echo down → {ok:false}, captions stand in.
 */
'use strict';
const db = require('./db');
const cfg = require('./config');
const { _sessionFromResult, _segmentsFromResult, formatTranscript } = require('./listen');

function active() { try { return db.getMeta('meeting_audio_active') === '1'; } catch { return false; } }
function sessionId() { try { const v = parseInt(db.getMeta('meeting_audio_session') || '', 10); return Number.isFinite(v) ? v : null; } catch { return null; } }

// Start capturing the meeting audio on the configured device. Gated by config (OFF by default). Returns
// { ok, sessionId, source, deviceIndex } or { ok:false, reason }.
async function start({ dispatch, name = 'zoe-meeting', deps = {} } = {}) {
  const c = (deps.config || cfg).meetingAudioConfig();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (typeof dispatch !== 'function') return { ok: false, reason: 'no-echo' };
  const args = { name, source_type: c.source, model_size: 'base', diarize: true };
  if (c.deviceIndex != null) args.device_index = c.deviceIndex;
  let r;
  try { r = await dispatch({ kind: 'do', name: 'transcription_capture_start', args }); }
  catch (e) { return { ok: false, reason: e.message }; }
  const sid = _sessionFromResult(r);
  if (!sid) return { ok: false, reason: (r && r.text) ? String(r.text).slice(0, 160) : 'no session_id' };
  try { db.setMeta('meeting_audio_active', '1'); db.setMeta('meeting_audio_session', String(sid)); } catch {}
  return { ok: true, sessionId: sid, source: c.source, deviceIndex: c.deviceIndex };
}

// Stop the capture + poll for the diarized transcript. Returns { ok, transcript, segments, ready }.
async function stop({ dispatch, deps = {} } = {}) {
  const sid = sessionId();
  try { db.setMeta('meeting_audio_active', '0'); } catch {}
  if (!sid || typeof dispatch !== 'function') return { ok: false, reason: 'not-capturing', transcript: '', segments: [] };
  try { await dispatch({ kind: 'do', name: 'transcription_capture_stop', args: { session_id: sid } }); }
  catch (e) { return { ok: false, reason: e.message, transcript: '', segments: [] }; }
  const delay = deps.delay || ((ms) => new Promise(res => setTimeout(res, ms)));
  const maxPolls = deps.maxPolls || 8;
  let segs = [];
  for (let i = 0; i < maxPolls; i++) {
    let r; try { r = await dispatch({ kind: 'do', name: 'transcription_segments', args: { session_id: sid } }); } catch {}
    segs = _segmentsFromResult(r);
    if (segs.length) break;
    if (i < maxPolls - 1) await delay(deps.pollMs || 2000);
  }
  try { db.setMeta('meeting_audio_session', ''); } catch {}
  return { ok: true, sessionId: sid, segments: segs, transcript: formatTranscript(segs), ready: segs.length > 0 };
}

module.exports = { active, sessionId, start, stop };
