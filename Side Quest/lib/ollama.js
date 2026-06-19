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
 */
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
        const thinkIdx = this.buf.indexOf('<think>');
        const sayIdx = this.buf.indexOf('<say>');
        if (thinkIdx !== -1 && (sayIdx === -1 || thinkIdx < sayIdx)) {
          this.buf = this.buf.slice(thinkIdx + '<think>'.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
          // Model skipped <think> and emitted <say> directly. Go straight to say.
          this.buf = this.buf.slice(sayIdx + '<say>'.length);
          this.mode = 'say';
          progress = true;
        }
      } else if (this.mode === 'think') {
        const idx = this.buf.indexOf('</think>');
        if (idx !== -1) {
          this.thought += this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + '</think>'.length);
          this.mode = 'between';
          progress = true;
        } else if (this.buf.length > 8) {
          // Flush safe portion (keep last 8 chars in case </think> straddles boundary)
          this.thought += this.buf.slice(0, this.buf.length - 8);
          this.buf = this.buf.slice(-8);
        }
      } else if (this.mode === 'between') {
        const idx = this.buf.indexOf('<say>');
        if (idx !== -1) {
          this.buf = this.buf.slice(idx + '<say>'.length);
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
      // Never saw <think> — treat entire buffer as say
      if (this.buf) {
        this.say = this.buf;
        this.onSayToken(this.buf);
      }
    } else if (this.mode === 'think') {
      // Unclosed <think>
      if (this.buf) this.thought += this.buf;
    } else if (this.mode === 'between') {
      // Saw <think>...</think> but no <say>; remaining buf as say
      if (this.buf) {
        this.say = this.buf;
        this.onSayToken(this.buf);
      }
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
