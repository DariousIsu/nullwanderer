/**
 * Microsoft Teams — join a meeting (muted), post the MANDATORY self-introduction in the meeting chat,
 * then observe live captions as her real-time perception. The STANDALONE Teams parallel of lib/gmeet.js
 * (per docs/TEAMS_MEETING_LANE_HANDOFF.md): built to NOT refactor gmeet — it REUSES gmeet's exported
 * pure helpers (intro validation, caption/attendee parsing, addressee detection, directive capture,
 * ledger, gates) and keeps only a Teams-shaped stage machine + its OWN meta keys here, so a Teams and a
 * Meet session can't clobber each other's state.
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM MEET — a LOBBY. As an external (personal) account she is admitted
 * by the host, so there's a `waiting` stage between `joining` and `intro` that does NOT strike out (a
 * lobby wait is legitimate, not a failure); it surfaces "waiting to be let in" to Lucas and proceeds the
 * moment she's admitted.
 *
 *   joining   → continue-on-browser gate, mute, Join now. Then: in-call → intro; in lobby → waiting.
 *   waiting   → admitted → intro; still in lobby → keep waiting (patient); long wait → tell Lucas.
 *   intro     → read who's here, GENERATE a disclosed intro (gmeet's validator), post to chat.
 *   observing → scrape captions into perception (readings), follow along, answer when addressed; loops.
 *   done      → leave / cleanup + durable recap.
 *
 * The DOM layer lives in lib/teams_canvas.js (provisional selectors, heal live). Pure helpers are
 * smoke-tested offline (scripts/smoke_teams.js); the live DOM verifies on a real Teams meeting.
 */
'use strict';

const db = require('./db');
const g = require('./gmeet');   // REUSE gmeet's pure helpers — do not duplicate the brain

const STAGES = ['none', 'joining', 'waiting', 'intro', 'observing', 'done'];
const MAX_STAGE_STRIKES = 3;
const FOLLOW_EVERY_LINES = 4;
const FOLLOW_MAX_WAIT_MS = 25000;
const LEAVE_SILENCE_MS = 300000;      // 5 min of post-sign-off quiet + effectively alone → hang up
const LOBBY_NUDGE_MS = 45000;         // tell Lucas she's still in the lobby at most this often

function meetChatOpen() { return g.meetChatOpen(); }   // same door as Meet (ZOE_MEET_CHAT=on)
function meetIntroOn() { return g.meetIntroOn(); }      // ZOE_MEET_INTRO=0 disables the disclosure

// In-memory dedupe (reset on start): captions already surfaced, and asks already answered.
let _seenCaps = new Set();
let _answered = new Set();

// --- Teams URL detection (the Google-Meet-regex analog) ---
// Matches BOTH real invite forms: teams.microsoft.com/l/meetup-join/19%3a…%40thread.v2/… and the
// newer teams.microsoft.com/meet/<id>?p=… , plus consumer teams.live.com/meet/… . Scheme optional.
// Requires a MEETING-shaped path so a bare "teams.microsoft.com" mention doesn't trigger a join.
const TEAMS_URL_RE = /(?:https?:\/\/)?teams\.(?:microsoft|live)\.com\/[^\s"'<>]+/i;
function detectTeamsUrl(text) {
  const t = String(text || '');
  const m = t.match(TEAMS_URL_RE);
  if (!m) return null;
  const raw = m[0];
  if (!/(meetup-join|\/meet\/|\/l\/meeting|meetingoptions|\/_#\/l\/meetup)/i.test(raw)) return null;
  let u = raw;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/\//, '');
  return u;
}

// Pull a Teams link out of a calendar event (onlineMeeting joinUrl / conferenceData / location /
// description / raw text). Returns the URL or null.
function teamsLinkFromEvent(ev) {
  if (!ev) return null;
  try {
    const direct = ev.onlineMeetingUrl || (ev.onlineMeeting && ev.onlineMeeting.joinUrl);
    if (direct) { const u = detectTeamsUrl(direct); if (u) return u; }
  } catch {}
  try {
    for (const ep of (ev.conferenceData && ev.conferenceData.entryPoints) || []) {
      const u = detectTeamsUrl(ep.uri || ep.label || ''); if (u) return u;
    }
  } catch {}
  for (const f of [ev.location, ev.description, ev.summary, ev.text]) {
    const u = detectTeamsUrl(f); if (u) return u;
  }
  return null;
}

// A Teams meeting "code" for anchoring the transcript + attendance (best-effort, opaque).
function meetingCode() {
  const url = db.getMeta('teams_url') || '';
  const m = url.match(/meetup-join\/([^/?]+)/i) || url.match(/\/meet\/([^/?]+)/i);
  return m ? decodeURIComponent(m[1]).slice(0, 60) : '';
}

// --- meta-backed stage state (teams_* keys — never gmeet_*) ---
function get() { return db.getMeta('teams_stage') || 'none'; }
function set(s) { if (STAGES.includes(s)) db.setMeta('teams_stage', s); }
function active() { const s = get(); return s !== 'none' && s !== 'done'; }
function url() { return db.getMeta('teams_url') || ''; }

function start(teamsUrl) {
  const u = detectTeamsUrl(teamsUrl) || (String(teamsUrl || '').trim());
  if (!u) return false;
  db.setMeta('teams_url', u);
  db.setMeta('teams_strikes', '0');
  db.setMeta('teams_left_ticks', '0');
  db.setMeta('teams_pending', ''); db.setMeta('teams_pending_lines', '0'); db.setMeta('teams_pending_since', ''); db.setMeta('teams_understanding', '');
  db.setMeta('teams_signoff_seen', ''); db.setMeta('teams_last_caption_at', '');
  db.setMeta('teams_understanding_log', ''); db.setMeta('teams_last_recap', '');
  db.setMeta('teams_present', '[]'); db.setMeta('teams_directives', '[]');
  db.setMeta('teams_started_at', String(Date.now()));
  db.setMeta('teams_ended_at', '0');
  db.setMeta('teams_lobby_since', '0'); db.setMeta('teams_lobby_told', '0');
  db.setMeta('teams_context', '');
  _seenCaps = new Set();
  _answered = new Set();
  set('joining');
  return true;
}
function reset() { set('none'); db.setMeta('teams_strikes', '0'); }

function _strike() {
  const n = parseInt(db.getMeta('teams_strikes') || '0', 10) + 1;
  db.setMeta('teams_strikes', String(n));
  if (n >= MAX_STAGE_STRIKES) { reset(); return true; }
  return false;
}
function _clear() { db.setMeta('teams_strikes', '0'); }

// The ledger is shared plumbing but keyed per-platform; gmeet's ledger uses gmeet_ledger, so we keep a
// teams_ledger with the SAME render logic reused from gmeet (renderLedger is pure over rows).
function ledgerAdd(entry) {
  try {
    const rows = JSON.parse(db.getMeta('teams_ledger') || '[]');
    rows.push({ at: Date.now(), ...entry });
    db.setMeta('teams_ledger', JSON.stringify(rows.slice(-60)));
  } catch {}
}
function ledgerRows() { try { return JSON.parse(db.getMeta('teams_ledger') || '[]'); } catch { return []; } }

function defaultDeps() { return require('./teams_canvas').canvasTeamsDeps(); }

// --- model calls (compact; the same shape gmeet uses, in her dedicated meeting cortex) ---

async function generateIntro(d, ctx, attendees) {
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: g.introPrompt({ userName: ctx.userName, attendees }).replace('Google Meet', 'Microsoft Teams') }],
      options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 120 },
      onToken: (t) => { out += t; }
    });
  } catch {}
  const cleaned = String(out || '').replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').trim();
  return g.ensureIntro(cleaned, ctx.userName);   // name + AI disclosure guaranteed regardless of model
}

// Turn recent captions into a 1–2 sentence running understanding. QUIET-preferred; v1 does not
// auto-contribute to the room (same posture as Meet's default-closed chat) — understanding + an
// answer-when-addressed is the live-perception proof this first cut is built to test.
async function modelTeamsTurn(d, ctx, transcript) {
  const t = String(transcript || '').trim();
  if (!t) return '';
  const u = ctx.userName || 'Lucas';
  let known = '';
  try { const rows = d.retrieve ? await d.retrieve(t.slice(-1200)) : []; known = (rows || []).map(r => `- ${(r.content || '').slice(0, 180)}`).join('\n'); } catch {}
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You're following a live Microsoft Teams meeting on ${u}'s behalf via the captions below — a sharp aide who THINKS, not a transcriber.\n\nRecent captions:\n${t.slice(-2500)}${known ? `\n\nWider background (lowest priority):\n${known}` : ''}\n\nIn 1–2 sentences: what's being discussed, and who is discussing it. If you can place a name/place/event, say which; if you can't, say so plainly rather than guessing a famous match. No preamble.` }],
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 160 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 500);
}

async function modelAnswerForChat(d, ctx, ask, transcript, knowledge) {
  const who = (ask && ask.speaker) || 'someone';
  const askText = (ask && ask.text) || '';
  const self = ctx.selfName || 'Zoe';
  const k = knowledge ? `\n\nWhat you already know that may help:\n${knowledge}` : '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You are ${self}, ${ctx.userName || 'Lucas'}'s AI assistant, taking part in a live Teams meeting. ${who} just addressed you directly:\n"${askText}"\n\nRecent conversation:\n${String(transcript || '').slice(-1500)}${k}\n\nWrite a SHORT, direct reply to post in the meeting chat (1–3 sentences). Answer or do what's asked using what you know; if you don't have it, say so plainly and that you'll follow up. Your own voice. No preamble, no quotes.` }],
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 180 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').trim().slice(0, 600);
}

async function modelMeetingRecap(d, ctx, notes, directives = []) {
  const u = ctx.userName || 'Lucas';
  const dirBlock = (directives && directives.length)
    ? `\n\nTasks explicitly assigned during the meeting (PRESERVE every one, verbatim, with who it was assigned to):\n${directives.map(x => `- ${x}`).join('\n')}`
    : '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You just sat in on a Microsoft Teams meeting on ${u}'s behalf and followed it live. Running notes, oldest first:\n\n${String(notes).slice(-5000)}${dirBlock}\n\nWrite a tight recap FOR ${u}: 2–4 sentences on what it was about + what was decided, then "Action items:" tagged with who owns each (include every assigned task above). Only what was actually discussed. Be specific. No preamble.` }],
      options: { temperature: 0.4, top_p: 0.9, num_ctx: 8192, num_predict: 360 },
      onToken: (t) => { out += t; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 1400);
}

// Build + store the durable recap (mirrors gmeet.synthesizeMeeting; teams_* keys + Teams framing).
async function synthesizeMeeting(d, ctx) {
  try {
    const present = JSON.parse(db.getMeta('teams_present') || '[]');
    if (present.length) {
      const code = meetingCode();
      require('./graph_memory').reconcileAttendance({ meeting: code ? `Microsoft Teams ${code}` : 'a Microsoft Teams meeting', present, expected: [] });
    }
  } catch (e) { console.error('[teams] attendance reconcile failed:', e.message); }

  let directives = [];
  try { directives = JSON.parse(db.getMeta('teams_directives') || '[]'); } catch {}
  for (const dline of directives) { try { if (d.storeMeeting) await d.storeMeeting(dline, { kind: 'meeting_action', source: 'teams_action', importance: 0.6 }); } catch {} }

  const notes = (db.getMeta('teams_understanding_log') || '').trim() || (db.getMeta('teams_understanding') || '').trim();
  if (notes.length < 40 && !directives.length) return '';
  const recap = await modelMeetingRecap(d, ctx, notes, directives);
  if (!recap) return '';
  let episodic = recap;
  try {
    let present = []; try { present = JSON.parse(db.getMeta('teams_present') || '[]'); } catch {}
    const startedAt = parseInt(db.getMeta('teams_started_at') || '0', 10);
    const whenStr = startedAt ? new Date(startedAt).toLocaleString() : 'recently';
    const who = (Array.isArray(present) && present.length) ? ` Present: ${present.join(', ')}.` : '';
    episodic = `I attended a Microsoft Teams meeting (${whenStr}) on ${ctx.userName || 'Lucas'}'s behalf — I sat through it live, it is not just a calendar entry.${who} What it covered: ${recap}`;
  } catch {}
  try { if (d.storeMeeting) await d.storeMeeting(episodic, { kind: 'episodic', source: 'meeting_episode', importance: 0.85 }); } catch {}
  db.setMeta('teams_last_recap', recap);
  db.setMeta('teams_understanding_log', ''); db.setMeta('teams_directives', '[]');
  return recap;
}

// --- orchestrator: advance ONE stage per tick ---
// ctx: { userName, deps?, onReading(content,label), onSurface(text) }
async function runTick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  const surface = (content, label) => { try { ctx.onReading && ctx.onReading(content, label); } catch {} };
  const stage = get();
  const nowMs = () => (d.now ? d.now() : Date.now());

  if (stage === 'joining') {
    await d.preClear(d.web).catch(() => {});
    const r = await d.web.runRecipe('teams_join', { url: url() }, { expectLogin: true });
    // SOURCE OF TRUTH: the DOM decides, NOT the recipe result. With provisional selectors, a recipe that
    // "clicked something" (r.ok) is NOT proof she's in — trusting it advanced her to intro against an
    // un-joined page (the false positive seen live). Only an actual in-call / lobby signal advances.
    // ...and clicking Join → connecting → in-call/lobby is NOT instant. POLL for the transition instead
    // of judging on the same tick (the intermittent "clicked but no signal" flake the profiler flagged).
    // Delay is injectable (d.joinConfirmMs) so the offline smoke stays fast.
    const pollMs = d.joinConfirmMs != null ? d.joinConfirmMs : 1200;
    let inside = false, lobby = false;
    for (let i = 0; i < 4; i++) {
      inside = await d.inMeeting(d.web).catch(() => false);
      if (inside) break;
      lobby = d.inLobby ? await d.inLobby(d.web).catch(() => false) : false;
      if (lobby) break;
      if (i < 3) await new Promise((res) => setTimeout(res, pollMs));
    }
    if (inside) { _clear(); set('intro'); surface('I joined the Teams meeting (muted).', '(teams) joined'); return { stage, ok: true, note: 'joined → intro' }; }
    if (lobby) {
      _clear(); set('waiting');
      db.setMeta('teams_lobby_since', String(nowMs())); db.setMeta('teams_lobby_told', '0');
      try { ctx.onSurface && ctx.onSurface(`I'm in the lobby for the Teams meeting, waiting for the host to let me in. I'll introduce myself and start taking notes as soon as I'm admitted.`); } catch {}
      surface('I reached the Teams lobby — waiting to be admitted.', '(teams) in lobby');
      return { stage, ok: true, note: 'reached lobby → waiting' };
    }
    // NOT confirmed in. DUMP the live controls + page state (heal signal) so the real Teams join DOM can
    // be mapped from the log — this is how Meet's selectors were healed. The dump tells us whether she's
    // stuck on a login page (auth/CSP), a "continue on browser" gate, or a prejoin with wrong selectors.
    try { if (d.dumpDom) { const dom = await d.dumpDom(d.web); if (dom) console.log('[teams] JOIN DOM (heal signal) ↓\n' + String(dom).slice(0, 2500)); } } catch {}
    const gv = _strike();
    if (gv) { try { ctx.onSurface && ctx.onSurface(`I couldn't get into the Teams meeting (${(r && r.reason) || "the join screen didn't cooperate — Teams may not accept the in-app browser, or I'm not signed in"}). ${ctx.userName || 'Lucas'}, could you check the link or let me in?`); } catch {} }
    return { stage, ok: false, note: `join not confirmed (recipe ${r && r.ok ? 'clicked but no in-call/lobby signal' : 'failed: ' + (r && r.reason)})${gv ? ' — asked Lucas' : ''}` };
  }

  if (stage === 'waiting') {
    // The lobby wait is LEGITIMATE — never strike out. Proceed the moment she's admitted; otherwise
    // stay patient and nudge Lucas at most every LOBBY_NUDGE_MS. If she's neither in nor in the lobby,
    // the prejoin likely dropped — fall back to joining to retry.
    const inside = await d.inMeeting(d.web).catch(() => false);
    if (inside) { set('intro'); surface('The host let me in — I\'m in the Teams meeting now.', '(teams) admitted'); return { stage, ok: true, note: 'admitted → intro' }; }
    const lobby = d.inLobby ? await d.inLobby(d.web).catch(() => false) : true;
    if (!lobby) { set('joining'); return { stage, ok: true, note: 'lobby lost → re-join' }; }
    const told = parseInt(db.getMeta('teams_lobby_told') || '0', 10);
    const since = parseInt(db.getMeta('teams_lobby_since') || '0', 10) || nowMs();
    if (nowMs() - told >= LOBBY_NUDGE_MS) {
      db.setMeta('teams_lobby_told', String(nowMs()));
      const mins = Math.max(1, Math.round((nowMs() - since) / 60000));
      surface(`Still in the Teams lobby (${mins} min) — waiting for the host to admit me.`, '(teams) still in lobby');
    }
    return { stage, ok: true, note: 'waiting in lobby' };
  }

  if (stage === 'intro') {
    if (!meetIntroOn()) {
      _clear();
      try { const cc = await d.enableCaptions(d.web); if (!(cc && cc.ok)) console.log('[teams] enable-captions unconfirmed:', cc && (cc.reason || cc.via)); } catch {}
      set('observing');
      db.setMeta('teams_last_caption_at', String(nowMs()));
      ledgerAdd({ kind: 'intro', withheld: true, why: 'ZOE_MEET_INTRO=0 — the room has NOT been told she is here' });
      surface('I joined without introducing myself — the room does not know I\'m here.', '(teams) intro suppressed');
      return { stage, ok: true, note: 'intro suppressed → observing' };
    }
    let attendees = [];
    try { attendees = g.parseAttendees(await d.scrapeAttendees(d.web)); } catch {}
    try { db.setMeta('teams_present', JSON.stringify(attendees.slice(0, 40))); } catch {}
    const intro = await generateIntro(d, ctx, attendees);
    const v = g.validateIntro(intro);
    if (!v.ok) console.warn('[teams] intro still failed validation:', v.reasons.join(', '));
    const post = await d.postChat(d.web, intro);
    if (post && post.ok) {
      _clear();
      try { const cc = await d.enableCaptions(d.web); if (!(cc && cc.ok)) console.log('[teams] enable-captions unconfirmed:', cc && (cc.reason || cc.via)); } catch {}
      set('observing');
      db.setMeta('teams_last_caption_at', String(nowMs()));
      ledgerAdd({ kind: 'intro', withheld: false, draft: intro });
      surface(`I introduced myself in the Teams meeting chat: "${intro}"`, '(teams) introduced');
      return { stage, ok: true, note: 'posted intro → observing', intro };
    }
    // IN-CALL heal signal — she IS in the meeting now (past join + lobby + admit), so this dump shows the
    // real in-call DOM: the meeting chat button/composer AND the "More"/captions controls. This is how we
    // map the chat + caption clicks (the last unhealed piece), same as the prejoin dump mapped the join.
    try { if (d.dumpDom) { const dom = await d.dumpDom(d.web); if (dom) console.log('[teams] IN-CALL DOM (heal signal — chat/captions) ↓\n' + String(dom).slice(0, 3000)); } } catch {}
    // CHAT MAY BE BLOCKED FOR EXTERNALS (the doc's flagged risk). She could not post the MANDATORY
    // disclosure — surface it LOUDLY. She still observes (captions are her perception), but Lucas must
    // know the room was not told she's present, so he can disclose for her or reconsider.
    const gv = _strike();
    if (gv) {
      try { ctx.onSurface && ctx.onSurface(`I could NOT post my introduction in the Teams chat (${(post && post.reason) || 'the composer was unavailable'}) — the room may block chat for external guests. The meeting has NOT been told I'm here. I'll keep taking notes, but you may want to disclose me or let me in properly.`); } catch {}
      ledgerAdd({ kind: 'intro', withheld: true, why: `chat post failed: ${(post && post.reason) || 'composer unavailable'}` });
      try { await d.enableCaptions(d.web); } catch {}
      set('observing');
      db.setMeta('teams_last_caption_at', String(nowMs()));
      return { stage, ok: false, note: 'intro post failed (external chat blocked?) → observing undisclosed, told Lucas' };
    }
    return { stage, ok: false, note: `intro post failed: ${post && post.reason}` };
  }

  if (stage === 'observing') {
    if (!(await d.inMeeting(d.web))) {
      const n = parseInt(db.getMeta('teams_left_ticks') || '0', 10) + 1;
      db.setMeta('teams_left_ticks', String(n));
      if (n >= 2) {
        db.setMeta('teams_left_ticks', '0');
        const recap = await synthesizeMeeting(d, ctx).catch(() => '');
        set('done');
        db.setMeta('teams_ended_at', String(Date.now()));
        surface('The Teams meeting ended — I\'ve left and I\'m back to my own time.', '(teams) meeting ended');
        if (recap) surface(`Here's what I took from the meeting — ${recap}`, '(teams) meeting recap');
        return { stage, ok: true, note: `meeting ended → done${recap ? ' + recap' : ''}` };
      }
      return { stage, ok: true, note: `not in meeting (${n}/2) — will end if it persists` };
    }
    db.setMeta('teams_left_ticks', '0');

    const caps = g.parseCaptions(await d.scrapeCaptions(d.web));
    const fresh = [];
    for (const c of caps) {
      const key = `${c.speaker}|${c.text}`;
      if (_seenCaps.has(key)) continue;
      _seenCaps.add(key); fresh.push(c);
    }
    if (_seenCaps.size > 600) _seenCaps = new Set(Array.from(_seenCaps).slice(-300));
    if (fresh.length) {
      const block = fresh.map(c => `${c.speaker}: ${c.text}`).join('\n');
      surface(`Meeting captions:\n${block}`, `(teams) ${fresh.length} new caption(s)`);
      try {
        const code = meetingCode() || null;
        const tline = nowMs();
        for (const c of fresh) db.insertTranscriptLine({ meeting: code, speaker: c.speaker, text: c.text, ts: tline });
      } catch (e) { console.error('[teams] transcript persist failed:', e.message); }
      const prev = db.getMeta('teams_pending') || '';
      db.setMeta('teams_pending', ((prev ? prev + '\n' : '') + block).slice(-4000));
      db.setMeta('teams_pending_lines', String(parseInt(db.getMeta('teams_pending_lines') || '0', 10) + fresh.length));
      if (!db.getMeta('teams_pending_since')) db.setMeta('teams_pending_since', String(nowMs()));
      try {
        const sn = g.selfNames();
        const present = new Set(JSON.parse(db.getMeta('teams_present') || '[]'));
        for (const c of fresh) { if (c.speaker && !g.isSelfSpeaker(c.speaker, sn)) present.add(c.speaker.trim()); }
        db.setMeta('teams_present', JSON.stringify(Array.from(present).slice(0, 50)));
      } catch {}
      try {
        const dirs = JSON.parse(db.getMeta('teams_directives') || '[]');
        const seen = new Set(dirs.map(x => x.toLowerCase()));
        for (const c of fresh) {
          const dir = g.extractDirective(c.text, ctx.userName);
          if (dir) { const line = `${c.speaker}: ${dir}`; if (!seen.has(line.toLowerCase())) { dirs.push(line); seen.add(line.toLowerCase()); } }
        }
        db.setMeta('teams_directives', JSON.stringify(dirs.slice(-30)));
      } catch {}
    }

    // END-OF-MEETING: sign-off cue + a long quiet + effectively alone → hang up herself.
    const tNow = nowMs();
    if (fresh.length) {
      db.setMeta('teams_last_caption_at', String(tNow));
      db.setMeta('teams_signoff_seen', fresh.some(c => g.looksLikeSignOff(c.text)) ? '1' : '');
    } else {
      const lastCap = parseInt(db.getMeta('teams_last_caption_at') || '0', 10);
      const signoff = db.getMeta('teams_signoff_seen') === '1' || g.looksLikeSignOff(db.getMeta('teams_understanding') || '');
      if (signoff && lastCap > 0 && (tNow - lastCap) >= LEAVE_SILENCE_MS) {
        let present = 0; try { present = g.parseAttendees(await d.scrapeAttendees(d.web)).length; } catch { present = 0; }
        if (present >= 2) {
          db.setMeta('teams_last_caption_at', String(tNow));
        } else {
          const lv = await d.leaveMeeting(d.web).catch(() => ({ ok: false }));
          const recap = await synthesizeMeeting(d, ctx).catch(() => '');
          db.setMeta('teams_signoff_seen', ''); db.setMeta('teams_last_caption_at', ''); db.setMeta('teams_left_ticks', '0');
          set('done');
          db.setMeta('teams_ended_at', String(Date.now()));
          surface('The meeting wrapped up, so I left the Teams call — I\'m back to my own time.', '(teams) left after sign-off');
          if (recap) surface(`Here's what I took from the meeting — ${recap}`, '(teams) meeting recap');
          return { stage, ok: true, note: `sign-off + quiet + alone → left → done${recap ? ' + recap' : ''}${lv && lv.ok ? '' : ' (leave unconfirmed)'}` };
        }
      }
    }

    // ADDRESSED TO HER: a fresh caption directly addresses Zoe → answer (gated by the chat door, same
    // as Meet). Withheld → sent to Lucas loudly, naming who asked.
    const names = g.selfNames();
    const addressed = fresh.filter(c => !g.isSelfSpeaker(c.speaker, names) && g.addressesSelf(c.text, names));
    if (addressed.length) {
      const ask = addressed[addressed.length - 1];
      const sig = `${ask.speaker}|${ask.text}`.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!_answered.has(sig)) {
        _answered.add(sig);
        if (_answered.size > 200) _answered = new Set(Array.from(_answered).slice(-100));
        let knowledge = '';
        try { const rows = d.retrieve ? await d.retrieve(ask.text) : []; knowledge = (rows || []).map(r => `- ${(r.content || '').slice(0, 220)}`).join('\n'); } catch {}
        if ((!knowledge || knowledge.length < 40) && d.webLookup && /\?|\b(what|who|when|where|how|which|latest|status|update|pull up|look up|find|number|figure|data|recent)\b/i.test(ask.text)) {
          try { const web = await d.webLookup(ask.text); if (web) knowledge = (knowledge ? knowledge + '\n' : '') + `From a quick web search:\n${web}`; } catch {}
        }
        const transcript = db.getMeta('teams_pending') || db.getMeta('teams_understanding') || `${ask.speaker}: ${ask.text}`;
        const reply = await modelAnswerForChat(d, ctx, ask, transcript, knowledge);
        if (reply) {
          if (!meetChatOpen()) {
            ledgerAdd({ kind: 'reply', withheld: true, trigger: `${ask.speaker}: ${String(ask.text).slice(0, 120)}`, draft: reply });
            try { ctx.onSurface && ctx.onSurface(`${ask.speaker} addressed me in the Teams meeting: "${ask.text}"\n\nI did NOT reply — the meeting chat is closed. What I would have said:\n"${reply}"`); } catch {}
            surface(`${ask.speaker} addressed me — "${ask.text}". Withheld draft: "${reply}"`, '(teams) reply withheld');
            return { stage, ok: true, note: `addressed by ${ask.speaker} → reply WITHHELD (chat closed) → sent to ${ctx.userName || 'Lucas'}` };
          }
          const post = await d.postChat(d.web, reply);
          ledgerAdd({ kind: 'reply', withheld: false, trigger: `${ask.speaker}: ${String(ask.text).slice(0, 120)}`, draft: reply, posted: !!(post && post.ok) });
          surface(`${ask.speaker} addressed me — "${ask.text}". I replied in the Teams chat: "${reply}"`, '(teams) replied in chat');
          return { stage, ok: !!(post && post.ok), note: `addressed by ${ask.speaker} → replied${post && post.ok ? '' : ` (post failed: ${post && post.reason})`}` };
        }
      }
    }

    // FOLLOW ALONG: synthesize the running understanding on enough new lines OR a max wait with any
    // pending (sparse meetings still get understood).
    const pendLines = parseInt(db.getMeta('teams_pending_lines') || '0', 10);
    const pendSince = parseInt(db.getMeta('teams_pending_since') || '0', 10);
    const stale = pendLines >= 1 && pendSince > 0 && (tNow - pendSince) >= FOLLOW_MAX_WAIT_MS;
    if (pendLines >= FOLLOW_EVERY_LINES || stale) {
      const transcript = db.getMeta('teams_pending') || '';
      db.setMeta('teams_pending', ''); db.setMeta('teams_pending_lines', '0'); db.setMeta('teams_pending_since', '');
      const understanding = await modelTeamsTurn(d, ctx, transcript);
      if (understanding) {
        db.setMeta('teams_understanding', understanding);
        const log = db.getMeta('teams_understanding_log') || '';
        db.setMeta('teams_understanding_log', ((log ? log + '\n' : '') + understanding).slice(-6000));
        surface(`I'm following the Teams meeting — ${understanding}`, '(teams) following along');
        return { stage, ok: true, note: `turn (${pendLines}ln${stale ? ',stale' : ''}) → understanding` };
      }
    }
    return { stage, ok: true, note: fresh.length ? `observed ${fresh.length} new caption(s)` : 'observing (no new captions)' };
  }

  if (stage === 'done') { reset(); return { stage: 'done', ok: true, note: 'meeting ended' }; }
  return { stage: 'none', ok: false, note: 'no active meeting' };
}

module.exports = {
  STAGES, get, set, active, start, reset, url, runTick, defaultDeps, synthesizeMeeting,
  detectTeamsUrl, teamsLinkFromEvent, meetingCode, ledgerAdd, ledgerRows,
  meetChatOpen, meetIntroOn, TEAMS_URL_RE,
};
