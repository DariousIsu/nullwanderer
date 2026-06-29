/**
 * Audio listening via Echo transcription. She can't hear raw audio on her own, but Echo's
 * transcription engine can: capture mic or system/loopback audio → transcribe → diarized segments.
 *
 * Contract (Echo, verified via describe_tool):
 *   transcription_capture_start({name, source_type:'mic'|'loopback', model_size, diarize}) → {ok, session_id, recording}
 *   transcription_capture_stop({session_id})            — finishes + KICKS transcription (async)
 *   transcription_segments({session_id}) → {ok, segments:[{idx,start_ms,end_ms,speaker,text}]}
 * So the flow is RECORD → STOP → (transcribe) → READ — not live streaming. "listen" starts a
 * capture; "stop listening" stops it, waits for the transcript, and surfaces it so she responds to
 * what was actually said (never invents it).
 *
 * Echo calls go through an injected dispatch (echoSuit.dispatch) so this is offline smoke-testable.
 * Fail-safe: Echo down / no transcript → honest note, never fabrication. Gated to Echo (read+propose).
 */
'use strict';
const db = require('./db');

const START_RE = /\b(listen to me|start listening|listen in\b|listen up\b|transcribe (?:this|that|the|my|our)|take notes on (?:this|the|our)|record (?:this|the|my|our))\b/i;
const STOP_RE = /\b(stop listening|stop recording|stop transcrib\w*|done listening|you can stop (?:listening|recording)|that'?s it,? (?:stop|you can stop))\b/i;
// loopback = capture what's PLAYING (a call/video/them); mic = capture Lucas speaking (default).
const LOOPBACK_RE = /\b(call|video|meeting|audio|system|playing|them|they|conversation|youtube|stream|podcast|show|movie|it back)\b/i;

function detectStart(msg) {
  const s = String(msg || '');
  if (!START_RE.test(s)) return null;
  return { source: LOOPBACK_RE.test(s) ? 'loopback' : 'mic' };
}
function detectStop(msg) { return STOP_RE.test(String(msg || '')); }

function active() { try { return db.getMeta('listen_active') === '1'; } catch { return false; } }
function sessionId() { try { const v = parseInt(db.getMeta('listen_session_id') || '', 10); return Number.isFinite(v) ? v : null; } catch { return null; } }

async function start({ source = 'mic', name = null, deps = {} } = {}) {
  const dispatch = deps.dispatch;
  if (typeof dispatch !== 'function') return { ok: false, reason: 'no-echo' };
  let r;
  try { r = await dispatch({ kind: 'do', name: 'transcription_capture_start', args: { name: name || `zoe-listen-${source}`, source_type: source, model_size: 'base', diarize: true } }); }
  catch (e) { return { ok: false, reason: e.message }; }
  const sid = _sessionFromResult(r);
  if (!sid) return { ok: false, reason: (r && r.text) ? String(r.text).slice(0, 160) : 'no session_id' };
  try {
    db.setMeta('listen_active', '1'); db.setMeta('listen_session_id', String(sid));
    db.setMeta('listen_source', source); db.setMeta('listen_started_at', String(deps.now ? deps.now() : Date.now()));
  } catch {}
  return { ok: true, sessionId: sid, source };
}

async function stop({ deps = {} } = {}) {
  const dispatch = deps.dispatch;
  const sid = sessionId();
  try { db.setMeta('listen_active', '0'); } catch {}
  if (!sid || typeof dispatch !== 'function') return { ok: false, reason: 'not-listening' };
  try { await dispatch({ kind: 'do', name: 'transcription_capture_stop', args: { session_id: sid } }); }
  catch (e) { return { ok: false, reason: e.message }; }
  // Transcription is kicked on stop → poll segments until ready (bounded; transcription is async).
  const delay = deps.delay || ((ms) => new Promise(res => setTimeout(res, ms)));
  const maxPolls = deps.maxPolls || 6;
  let segs = [];
  for (let i = 0; i < maxPolls; i++) {
    let r;
    try { r = await dispatch({ kind: 'do', name: 'transcription_segments', args: { session_id: sid } }); } catch {}
    segs = _segmentsFromResult(r);
    if (segs.length) break;
    if (i < maxPolls - 1) await delay(deps.pollMs || 1500);
  }
  return { ok: true, sessionId: sid, segments: segs, transcript: formatTranscript(segs), ready: segs.length > 0 };
}

function formatTranscript(segments) {
  return (segments || [])
    .map(s => `${s && s.speaker ? s.speaker + ': ' : ''}${String((s && s.text) || '').trim()}`)
    .filter(l => l.length > 1)
    .join('\n')
    .slice(0, 4000);
}

// Echo results arrive via normalizeToolResult as { text } (JSON string) — or a parsed object in tests.
function _obj(r) {
  if (!r) return null;
  if (r.session_id !== undefined || r.segments !== undefined) return r;
  const t = (r.text !== undefined) ? r.text : r;
  if (typeof t === 'string') { try { const m = t.match(/[[{][\s\S]*[\]}]/); return JSON.parse(m ? m[0] : t); } catch { return null; } }
  return (t && typeof t === 'object') ? t : null;
}
function _sessionFromResult(r) { const o = _obj(r); const v = o && (o.session_id != null ? o.session_id : o.sessionId); const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function _segmentsFromResult(r) { const o = _obj(r); return (o && Array.isArray(o.segments)) ? o.segments : []; }

module.exports = { detectStart, detectStop, active, sessionId, start, stop, formatTranscript, _obj, _sessionFromResult, _segmentsFromResult, START_RE, STOP_RE };
