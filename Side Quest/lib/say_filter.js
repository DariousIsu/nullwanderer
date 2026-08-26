'use strict';
/**
 * lib/say_filter.js — the ONE-VOICE say filter (run-2 D-batch, 2026-08-20).
 *
 * Three leaks, one seam — internal or structural text surviving into the user-facing say:
 *
 * F15 (the italic-eater): the stage-direction stripper /(?<![*\w])\*(?!\*)[^*\n]{1,200}\*(?!\*)/g
 *   deleted every single-asterisk span WITH ITS WORDS. It was written for RP narration (*nods*),
 *   but the model uses the same markup for EMPHASIS — live: "Chinese holdings are , fast" (the word
 *   *plummeting* eaten), "a response to a one" (*perceived* eaten). It ate the emphasis-bearing
 *   words in her best writing on three separate say paths. Cure: only a span that LOOKS like a
 *   gesture (short, lowercase, first word a known gesture verb) is removed; every other span is
 *   UNWRAPPED — asterisks dropped, words kept (matching what the renderer does at display time).
 *   Losing markup is cosmetic; losing words is corruption.
 *
 * F5b (steering-vocab leak): internal steering language surfaced verbatim in says — "facet
 *   corrected to …", "depth is now deep, two-lane research", agent run-IDs (bare UUIDs), and a
 *   leaked "Need: …" planning fragment (run-2b B3). These are plumbing, never voice.
 *
 * F23 (tool-JSON leak): the operator's raw JSON tool-call rode into the say as visible text while
 *   the tool ALSO executed (run-2b long-job drill). A balanced-brace scan finds JSON blocks whose
 *   keys look like a tool call and drops them; prose braces and code the user asked for survive
 *   (a tool call names a tool AND carries args — an ordinary snippet rarely does both).
 *
 * Pure, deterministic, no requires — smoke: scripts/smoke_say_filter.js + smoke_stage_direction.js.
 */

// ── F15: stage directions go, emphasis words stay ─────────────────────────────────────────────
const _STAR_SPAN_RE = /(?<![*\w])\*(?!\*)([^*\n]{1,200})\*(?!\*)/g;

// Gesture-verb stems (first word of an RP stage direction), after stripping -ing/-ed/-s and a
// doubled final consonant: *shrugged*→shrug, *smiles softly*→smile, *taps the desk*→tap.
const _GESTURE_STEMS = new Set([
  'nod', 'smile', 'smil', 'laugh', 'chuckle', 'chuckl', 'grin', 'sigh', 'shrug', 'wink',
  'pause', 'paus', 'lean', 'tilt', 'wave', 'wav', 'blink', 'frown', 'smirk', 'glance', 'glanc',
  'stare', 'star', 'tap', 'sip', 'gesture', 'gestur', 'stretch', 'yawn', 'adjust', 'straighten',
  'raise', 'rais', 'shake', 'shak', 'roll', 'squint', 'beam', 'gasp', 'giggle', 'giggl',
  'hum', 'snort', 'whisper', 'point', 'settle', 'settl', 'perk', 'ponder', 'scratch', 'rub',
  'fidget', 'twirl', 'exhale', 'exhal', 'inhale', 'inhal', 'groan', 'wince', 'winc',
  'cringe', 'cring', 'clear', 'chew', 'purse', 'purs', 'tuck', 'fold', 'cross', 'drum',
  'bite', 'bit', 'lick', 'clutch', 'grip', 'flex', 'take', 'tak', 'give', 'giv', 'crack',
]);

function _isStageDirection(inner) {
  const s = String(inner || '').trim();
  if (!s || s.length > 60) return false;
  if (/[.!?;:"“”0-9(){}\[\]]/.test(s)) return false;   // punctuation/digits → prose, not a gesture
  if (s !== s.toLowerCase()) return false;             // a capital → a name/term being emphasized
  const words = s.split(/\s+/);
  if (words.length > 4) return false;
  let w = words[0].replace(/(?:ing|ed|s)$/, '');
  w = w.replace(/([b-df-hj-np-tv-z])\1$/, '$1');       // shrugg→shrug, tapp→tap, grinn→grin
  return _GESTURE_STEMS.has(w);
}

// Remove gesture stage directions; UNWRAP every other single-* span (drop the markup, keep the
// words). **bold** is untouched (same lookarounds as the old pattern).
function cleanStars(text) {
  return String(text || '').replace(_STAR_SPAN_RE, (m, inner) => (_isStageDirection(inner) ? '' : String(inner)));
}

// ── F5b: internal steering vocabulary is plumbing, never voice ────────────────────────────────
const _STEERING_RES = [
  /\bfacet\s+(?:corrected|updated|set|switched)\s+to\b[^.!?\n]*[.!?]?/gi,   // "facet corrected to …"
  /\bdepth\s+is\s+now\b[^.!?\n]*[.!?]?/gi,                                  // "depth is now deep, two-lane research"
  /\brun[-_\s]?id[:= ]?\s*[a-z0-9][a-z0-9-]{5,}\b/gi,                       // "run id b241b4aa…"
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,     // a bare UUID
  /^[ \t]*Need:\s[^\n]*$/gm,                                                // leaked planning fragment (run-2b B3)
];

function stripSteeringVocab(text) {
  let s = String(text || '');
  for (const re of _STEERING_RES) s = s.replace(re, '');
  return s;
}

// ── F23: a raw tool-call JSON block is an instruction to a machine, not a sentence ───────────
const _KEY_TOOL_RE = /"(?:tool|tool_name|tool_call|function|method|action)"\s*:/;
const _KEY_NAME_RE = /"name"\s*:/;
const _KEY_ARGS_RE = /"(?:args|arguments|params|parameters|input|payload|query)"\s*:/;

function stripToolJson(text) {
  const s = String(text || '');
  if (!s.includes('{')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '{') { out += c; i++; continue; }
    // balanced scan, string-aware, bounded — an unbalanced or huge block is left alone
    let depth = 0, j = i, inStr = false, esc = false, closed = false;
    for (; j < s.length && j - i < 2000; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { closed = true; break; } }
    }
    if (!closed) { out += c; i++; continue; }
    const block = s.slice(i, j + 1);
    const isToolCall = _KEY_TOOL_RE.test(block) || (_KEY_NAME_RE.test(block) && _KEY_ARGS_RE.test(block));
    if (isToolCall) { i = j + 1; continue; }   // drop the block
    out += c; i++;
  }
  return out;
}

// ── R5: "let me get that going" is deflection filler — banned in every directive; a say-layer
// backstop strips it if a model emits it anyway, so the real ack and the substance survive while the
// empty phrase does not (live #13812: "On it — let me get that going." → "On it.").
const _DEFLECTION_RES = [
  // led by a connector: strip the phrase, KEEP the sentence's trailing punctuation ("On it." survives)
  /\s*[—–:;,-]\s*\blet me get (?:that|this|it) going\b(?=[.!?]|\s|$)/gi,
  // a standalone deflection sentence (at the start, or after a sentence end): strip it and its punctuation
  /(?:^|(?<=[.!?])\s+)\blet me get (?:that|this|it) going\b[.!?]*\s*/gi,
];

// ── C1 (08-26): the count-authority uptake backstop — the turn carried EXACT dataset counts and
// the say answered with a different store's total ("We hold 274,224 … contacts" beside an injected
// 802). A stated TOTAL claim contradicting the injected total gains a correction; a say already
// carrying the true total is untouched, and breakdown numbers ("Lafourche has 37") never trigger —
// only total-shaped claims ("we hold N", "total of N", "N … in the dataset") are checked.
const _COUNT_TOTAL_CLAIM_RES = [
  /\b(?:we (?:hold|have)|total(?:s)?(?:\s*(?:of|is|:))?|in total|altogether|overall)\s+(?:about |around |roughly |~)?([\d][\d,]{2,})\b/gi,
  /\b([\d][\d,]{2,})\s+(?:\w+\s+){0,2}(?:contacts?|rows?|bills?|records?|entries)\s+in the dataset\b/gi,
];
function _fmtThousands(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function _countAuthorityCheck(s, ca) {
  if (!ca || !ca.total || !s) return s;
  const tot = String(ca.total), totFmt = _fmtThousands(ca.total);
  if (s.includes(tot) || s.includes(totFmt)) return s;
  let wrong = null;
  for (const src of _COUNT_TOTAL_CLAIM_RES) {
    const re = new RegExp(src.source, 'gi');
    let m;
    while ((m = re.exec(s))) { if (m[1].replace(/,/g, '') !== tot) { wrong = m[1]; break; } }
    if (wrong) break;
  }
  if (!wrong) return s;
  return `${s.replace(/\s+$/, '')}\n\nCorrection — the governing dataset count for "${ca.slug}" is ${totFmt}; the ${wrong} figure describes a different store's scope, not this dataset.`;
}

// ── the composite: what every user-facing say path runs ───────────────────────────────────────
function filterSay(text, ctx = {}) {
  let s = cleanStars(text);
  s = stripToolJson(s);
  s = stripSteeringVocab(s);
  for (const re of _DEFLECTION_RES) s = s.replace(re, '');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').replace(/\s+—\s*$/gm, '').trim();
  return _countAuthorityCheck(s, ctx && ctx.countAuthority);
}

module.exports = { cleanStars, stripSteeringVocab, stripToolJson, filterSay, _isStageDirection, _countAuthorityCheck };
