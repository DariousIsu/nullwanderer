'use strict';
/**
 * lib/speech_class.js — WHICH UNPROMPTED UTTERANCES DESERVE THE VOICE? (2026-08-12 truth audit)
 *
 * Lucas: unprompted utterances will carry the same voice-speak weight once the two-way voice build
 * completes — the spoken ones must be USEFUL and ENGAGING. The audit of a full day's unprompted
 * output (25 utterances) found two clean bands:
 *
 *   SPEAK — excellent aloud: delivery announcements ("It's done — dossier's on your Canvas… the
 *   single most striking thing:"), honesty disclosures (the #11638 refusal), promise-keeping nudges
 *   ("Earlier I said I'd…"), genuine offers. These are her voice at its best.
 *
 *   RAIL — template-prefixed status machinery that reads as robotic speech: the "I re-read the
 *   document I'm continuing…" QA narration (6 of 25 that day — SHE self-flagged it as a stale
 *   habit, turn #11645), "Tactics update on the … (plan rev N)" diff dumps, "Steering note on the
 *   research:" question streams (4 in 50 minutes). Real work, wrong surface: they belong on the
 *   ambient rail / log, or need a voice-rewrite before ever being spoken.
 *
 * PURE classifier, no I/O. The class is stamped on the turns row at insert (db.insertTurn) so the
 * voice layer reads a durable tag instead of re-classifying; `speaks()` here stays the single
 * source of truth for which classes get the voice. Fail-open: anything unrecognized is 'general'
 * and SPEAKABLE — the templates are code-generated and enumerable; genuine free speech is not.
 */

const str = (v) => (v == null ? '' : String(v));

// Order matters: first match wins. Anchored to the code-generated template OPENERS (stable strings
// in main.js/lib emitters), never to topic words — a genuine musing that MENTIONS a dossier must
// not get railed.
const CLASSES = [
  { cls: 'qa-reread',  speak: false, re: /^\s*I re-read the document I'm continuing/i },
  { cls: 'tactics',    speak: false, re: /^\s*Tactics update on the \w+ \(plan rev \d+\)/i },
  { cls: 'steering',   speak: false, re: /^\s*Steering note on the research:/i },
  { cls: 'promise',    speak: true,  re: /^\s*Earlier I said I'd/i },
  { cls: 'delivery',   speak: true,  re: /^\s*(?:It'?s done —|Your dossier(?:'s| is)? (?:done|saved|live)|The dossier'?s done)/i },
  { cls: 'honesty',    speak: true,  re: /I need to be straight with you|I did NOT reply|Withheld draft:/i },
  // 'mentioned' added 2026-08-13: the 04:10 live resurfacing reworded "said" → "mentioned" and
  // fell to 'general' — same thought, same class, the opener anchor just needed the variant.
  { cls: 'identity',   speak: true,  re: /^\s*I'?ve been thinking about something I (?:said|committed|mentioned)/i },
  // Self-exploration share (lib/self_explore, 2026-08-13): "I spent some time with X … here's what
  // I actually thought" — her voice at its best; exactly what Lucas asked to hear as she goes.
  { cls: 'exploration', speak: true, re: /^\s*I spent (?:some )?time with/i },
  // REPLAY (2026-08-13 live audit): a turn that near-verbatim repeats a recent ai_said turn. Not
  // pattern-anchored — stamped CONTEXTUALLY by insertTurn via isReplay() below (the regex here can
  // never match; the entry exists so speaks('replay') is authoritative). Measured 2026-08-13
  // 02:59-03:29: the reply writer emitted the qa-reread rail text, a tactics template, and an
  // identity musing VERBATIM as replies — a personality database of replays trains a parrot.
  { cls: 'replay',     speak: false, re: /(?!)/ },
];

/** classify(content) → { cls, speak } — the durable tag + whether the voice reads it aloud. */
function classify(content) {
  const t = str(content);
  if (!t.trim()) return { cls: 'general', speak: true };
  for (const c of CLASSES) if (c.re.test(t)) return { cls: c.cls, speak: c.speak };
  return { cls: 'general', speak: true };
}

/** speaks(cls) → should the voice read this class aloud? Single source of truth for the voice layer. */
function speaks(cls) {
  const c = CLASSES.find((x) => x.cls === cls);
  return c ? c.speak : true;   // unknown/general → speakable (fail-open for genuine free speech)
}

// ── REPLAY DETECTION (deterministic, no embeddings) ──────────────────────────────────────────────
// A turn is a REPLAY when it near-verbatim repeats a recent ai_said turn. Word-trigram overlap
// against the SMALLER turn (a long reply that swallows a short old ack whole is not a replay of
// it — the short side must be substantial too). Thresholds from the live 08-13 incidents: the
// three observed replays are ≥0.95 overlap; honest short acks ("On it.") are under MIN_CHARS.
const REPLAY_MIN_CHARS = 60;
const REPLAY_OVERLAP = 0.85;

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function _trigrams(s) {
  const w = _norm(s).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** isReplay(content, priorContents[]) → true when content near-verbatim repeats any prior. Pure. */
function isReplay(content, priors) {
  const cn = _norm(content);
  if (cn.length < REPLAY_MIN_CHARS) return false;
  const ct = _trigrams(content);
  if (!ct.size) return false;
  for (const p of Array.isArray(priors) ? priors : []) {
    const pn = _norm(p);
    if (pn.length < REPLAY_MIN_CHARS) continue;
    if (pn === cn) return true;
    const pt = _trigrams(p);
    if (!pt.size) continue;
    let shared = 0;
    const [small, big] = ct.size <= pt.size ? [ct, pt] : [pt, ct];
    for (const g of small) if (big.has(g)) shared++;
    if (shared / small.size >= REPLAY_OVERLAP) return true;
  }
  return false;
}

module.exports = { classify, speaks, isReplay, CLASSES };
