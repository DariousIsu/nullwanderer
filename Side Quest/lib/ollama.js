const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';

async function streamChat({ model, messages, options = {}, onToken, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: '24h',
    options: {
      temperature: 0.8,
      top_p: 0.9,
      repeat_penalty: 1.1,
      num_ctx: 8192,
      ...options
    }
  };

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message && obj.message.content) {
          onToken(obj.message.content);
        }
        if (obj.done) return;
      } catch {
        // ignore malformed line
      }
    }
  }
}

/**
 * Splits a streamed string into <think>...</think> and <say>...</say> segments.
 * Streams say-content tokens to onSayToken as soon as they arrive.
 * Tolerates missing tags; finalize() salvages whatever was produced.
 *
 * TAG-DRIFT TOLERANCE: the 24B reliably means "interior" but often spells it
 * <thoughts> / <thinking> / <thought> instead of the canonical <think>. The old
 * parser only matched <think>, so a <thoughts> block left it stuck in 'pre' and
 * finalize() dumped the ENTIRE raw buffer (every thought block + tool tags) into
 * say — the "thought leak." We now treat all four spellings as interior, capture
 * MULTIPLE consecutive interior blocks, and NEVER let tag-shaped content fall
 * through into say. If she only journaled and never actually spoke, say is empty
 * (caller renders that as "…"), which is correct — silence beats a leaked interior.
 */
const THINK_OPEN = ['<think>', '<thoughts>', '<thinking>', '<thought>'];
const THINK_CLOSE = ['</think>', '</thoughts>', '</thinking>', '</thought>'];
const MAX_TOKEN_LEN = 11;  // longest tag above (</thinking>, </thoughts>) — straddle guard

// Earliest occurrence among a set of literal tokens. Returns { idx, token }.
function firstToken(buf, tokens) {
  let best = -1, bestTok = null;
  for (const t of tokens) {
    const i = buf.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) { best = i; bestTok = t; }
  }
  return { idx: best, token: bestTok };
}

// Strip complete tag blocks (<tag ...>…</tag>), self-closing tags (<tag/>), and
// stray open/close tags from a salvaged fragment, so leaked interior/tool tags
// (<thoughts>, <file-append>, <web-chat>, …) never reach the visible say. Used
// only on the no-<say> fallback path; genuine prose with no tags is untouched.
function stripTagBlocks(s) {
  if (!s) return '';
  return s
    .replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[a-zA-Z][\w-]*\b[^>]*\/>/g, '')
    .replace(/<\/?[a-zA-Z][\w-]*\b[^>]*>/g, '')
    .trim();
}

class TagStreamParser {
  constructor({ onSayToken } = {}) {
    this.onSayToken = onSayToken || (() => {});
    this.mode = 'pre'; // pre | think | between | say | post
    this.buf = '';
    this.thought = '';
    this.say = '';
  }

  feed(chunk) {
    this.buf += chunk;
    let progress = true;
    while (progress) {
      progress = false;

      if (this.mode === 'pre') {
        // Earliest of any interior-open or <say>. Interior wins ties (it's the
        // intended first section). Nothing is emitted here, so no leak risk.
        const think = firstToken(this.buf, THINK_OPEN);
        const sayIdx = this.buf.indexOf('<say>');
        if (think.idx !== -1 && (sayIdx === -1 || think.idx < sayIdx)) {
          this.buf = this.buf.slice(think.idx + think.token.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
          // Model skipped interior and emitted <say> directly. Go straight to say.
          this.buf = this.buf.slice(sayIdx + '<say>'.length);
          this.mode = 'say';
          progress = true;
        }
      } else if (this.mode === 'think') {
        const close = firstToken(this.buf, THINK_CLOSE);
        if (close.idx !== -1) {
          this.thought += this.buf.slice(0, close.idx);
          this.buf = this.buf.slice(close.idx + close.token.length);
          this.mode = 'between';
          progress = true;
        } else if (this.buf.length > MAX_TOKEN_LEN) {
          // Flush safe portion (keep tail in case a close tag straddles the boundary)
          this.thought += this.buf.slice(0, this.buf.length - MAX_TOKEN_LEN);
          this.buf = this.buf.slice(-MAX_TOKEN_LEN);
        }
      } else if (this.mode === 'between') {
        // Either another interior block (multi-block journaling) re-enters think,
        // or <say> begins. Whichever comes first. Content before it is discarded
        // (it's malformed between-section junk — e.g. a stray <file-append>).
        const sayIdx = this.buf.indexOf('<say>');
        const think = firstToken(this.buf, THINK_OPEN);
        if (think.idx !== -1 && (sayIdx === -1 || think.idx < sayIdx)) {
          this.thought += '\n';  // separator between captured interior blocks
          this.buf = this.buf.slice(think.idx + think.token.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
          this.buf = this.buf.slice(sayIdx + '<say>'.length);
          this.mode = 'say';
          progress = true;
        }
      } else if (this.mode === 'say') {
        const idx = this.buf.indexOf('</say>');
        if (idx !== -1) {
          const emit = this.buf.slice(0, idx);
          if (emit) {
            this.say += emit;
            this.onSayToken(emit);
          }
          this.buf = this.buf.slice(idx + '</say>'.length);
          this.mode = 'post';
          progress = true;
        } else if (this.buf.length > 6) {
          // Emit safe portion (keep last 6 in case </say> straddles)
          const safe = this.buf.slice(0, this.buf.length - 6);
          if (safe) {
            this.say += safe;
            this.onSayToken(safe);
          }
          this.buf = this.buf.slice(-6);
        }
      }
    }
  }

  finalize() {
    if (this.mode === 'pre') {
      // Never saw any interior or <say> tag — a plain reply. Emit as say, but
      // strip any tag-shaped artifacts defensively (no canonical tags were seen,
      // so genuine prose is unaffected).
      const salvaged = stripTagBlocks(this.buf);
      if (salvaged) { this.say = salvaged; this.onSayToken(salvaged); }
    } else if (this.mode === 'think') {
      // Unclosed interior block — keep it as thought, nothing leaks to say.
      if (this.buf) this.thought += this.buf;
    } else if (this.mode === 'between') {
      // Saw interior block(s) but no <say>. The remaining buffer is post-interior
      // junk (tool tags, trailing fragments). Salvage ONLY genuine prose — in the
      // leak case this strips to empty, so say stays empty instead of dumping the
      // journal. A real reply written without <say> tags survives as prose.
      const salvaged = stripTagBlocks(this.buf);
      if (salvaged) { this.say = salvaged; this.onSayToken(salvaged); }
    } else if (this.mode === 'say') {
      // Unclosed <say>
      if (this.buf) {
        this.say += this.buf;
        this.onSayToken(this.buf);
      }
    }
    this.buf = '';
    return {
      thought: this.thought.trim(),
      say: this.say.trim(),
      truncated: this.mode !== 'post' ? 1 : 0
    };
  }
}

module.exports = { streamChat, TagStreamParser, OLLAMA_BASE };
