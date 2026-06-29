/**
 * leakguard — keep injected control DIRECTIVES from reaching Lucas, in BOTH the final text and the
 * LIVE token stream.
 *
 * The injected instruction blocks ([ANSWER TO GIVE…], [DELIVER THIS…], [Lucas asked for the list…],
 * [YOU HAVE ACCEPTED…]) are meant FOR her, not him — but the 24B sometimes echoes them verbatim. The
 * final-text strip caught them, yet they still showed because the reply STREAMS token-by-token to the
 * UI before the final strip runs (confirmed live 2026-06-29). So we need two things from one source of
 * truth: a final-text strip AND a stateful stream filter that holds a "[" open until it closes and
 * drops it if it reads as a directive.
 *
 * PURE: regex + a tiny state machine. No I/O. Fully offline-testable.
 */
'use strict';

// A bracket block is a leaked directive if it carries a directive SIGNATURE, or (for model-hallucinated
// meta brackets with no fixed signature) it's a long block talking about the task/Lucas in directive terms.
const _DIRSIG = /(ANSWER TO GIVE|THAT'?S YOUR TASK|DELIVER THIS|Calibration:|ACTION HONESTY|REMEMBER IT ACROSS|Say THIS in your own voice|STATUS UPDATE|ADDITIONAL GUIDANCE|standing (?:task|focus)|ACCEPTED this as|do NOT (?:invent|fabricate|summarize|contract|drift|recite)|in your own voice|grounded answer|present the FULL|REAL FACTS|ACCESSIBLE VIA|asked (?:for the|what you|about)|on your Canvas|put (?:it|this) on the Canvas|complete result of the task)/i;
const _METASIG = /\b(Lucas|going forward|i will|do not|deliver|present|dossier|clarif|criteria|scope|the task|my research|remember|REMEMBER|going to (?:expand|include|focus)|search criteria|Canvas)\b/i;

function isLeakyDirective(bracket) {
  const m = String(bracket || '');
  return _DIRSIG.test(m) || (m.length > 60 && _METASIG.test(m));
}

// FINAL-TEXT strip: remove leaked directive brackets — closed, trailing-unterminated, or stacked/
// unterminated mid-text (each '[' + signature run up to its ']' OR the next '[' OR end-of-string).
function stripLeakedDirectives(text) {
  let s = String(text || '');
  s = s.replace(/\[[^\]]*\]/g, (m) => (isLeakyDirective(m) ? '' : m));   // closed blocks (incl. multi-line)
  s = s.replace(/\[[^\]]*$/g, (m) => (isLeakyDirective(m) ? '' : m));     // trailing unterminated
  s = s.replace(/\[[^\[]*?(?:DELIVER THIS|ANSWER TO GIVE|THAT'?S YOUR TASK|ACCEPTED (?:this|THIS) as|standing (?:task|focus)|Calibration:|do NOT (?:invent|fabricate|summarize|recite)|present the FULL|keep EVERY item|REAL FACTS|complete result of the task|asked (?:for the|what you)|on your Canvas)[^\[]*?(?:\]|(?=\[)|$)/gi, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// STREAM filter: wrap an emit(chunk) sink so directive brackets never reach the UI live. Holds an open
// '[' (buffering, not emitting) until it closes or grows past MAXBUF; on close, drops it if it's a
// directive, else emits it verbatim. Non-bracket text streams through unchanged. Call flush() at the end.
function makeStreamFilter(emit) {
  const MAXBUF = 800;
  let buf = '';
  let inBracket = false;
  const send = (s) => { if (s) { try { emit(s); } catch {} } };
  return {
    feed(token) {
      let out = '';
      for (const ch of String(token || '')) {
        if (!inBracket) {
          if (ch === '[') { if (out) { send(out); out = ''; } inBracket = true; buf = '['; }
          else out += ch;
        } else {
          buf += ch;
          if (ch === ']') {
            if (!isLeakyDirective(buf)) out += buf;   // legit bracket (e.g. a markdown link) → keep
            inBracket = false; buf = '';
          } else if (buf.length >= MAXBUF) {
            if (!isLeakyDirective(buf)) out += buf;    // long non-directive bracket → flush it through
            inBracket = false; buf = '';
          }
        }
      }
      if (out) send(out);
    },
    flush() {
      if (inBracket && buf && !isLeakyDirective(buf)) send(buf);   // unterminated non-directive → emit
      inBracket = false; buf = '';
    }
  };
}

module.exports = { isLeakyDirective, stripLeakedDirectives, makeStreamFilter, _DIRSIG, _METASIG };
