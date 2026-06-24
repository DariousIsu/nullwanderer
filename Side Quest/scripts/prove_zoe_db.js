/**
 * prove_zoe_db.js — connection proof: Zoe's REAL brain (her 24B) + REAL suit
 * (lib/echo_suit + lib/echo) driving the engine SHE owns, doing a real read in
 * the database, grounded in actual rows.
 *
 * Deliberately READ-ONLY and NON-PERSISTING: it does NOT open sq.db, so it can
 * run alongside the live Electron Zoe with zero lock contention. This is the
 * same code path a chat turn uses (persona prompt → ollama streamChat → parse
 * echo tags → suit.dispatch → tool-followup), just triggered headless so the
 * round-trip is observable.
 *
 * Run: node scripts/prove_zoe_db.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { streamChat } = require('../lib/ollama');
const echo = require('../lib/echo');
const echoSuitLib = require('../lib/echo_suit');

// Read Echo's HTTP endpoint + admin token from config.toml (same as main.js).
function readEchoConfig(dir) {
  let token = process.env.NX_ECHO_ADMIN_TOKEN || null;
  let port = 8765;
  try {
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    if (!token) { const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1]; }
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10);
  } catch (e) { console.error('config.toml read failed:', e.message); }
  return { url: `http://127.0.0.1:${port}/mcp/`, token };
}

const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const TASK = process.argv[2] ||
  'Quick one — use the suit (our records, not the web): search our knowledge base for "US–Israel economic partnership" and tell me what we actually have on it.';

async function runTurn(model, messages) {
  let raw = '';
  await streamChat({ model, messages, options: { temperature: 0.6, num_ctx: 8192 }, onToken: (t) => { raw += t; } });
  return raw;
}

(async () => {
  config.loadEnv();
  const MODEL = config.model();
  const cfg = readEchoConfig(ECHO_CWD);
  console.log(`\n=== ZOE ↔ DATABASE CONNECTION PROOF ===`);
  console.log(`model: ${MODEL}  |  engine: ${cfg.url}  |  token: ${cfg.token ? 'present' : 'MISSING'}\n`);

  // 1) Build + connect her real suit against the engine she owns.
  const suit = echoSuitLib.createSuit({ client: echo.fromEnv({ url: cfg.url, token: cfg.token }) });
  const conn = await suit.connect();
  if (!conn.ok) { console.error('SUIT CONNECT FAILED:', conn.error); process.exit(1); }
  console.log(`[1] suit connected: ${conn.tools} tools, ${conn.bootMs}ms\n`);

  const system = [
    'You are Zoe Lane. Lucas is asking you to look something up in OUR records using the Echo suit.',
    'Think briefly in <think>…</think>, then emit exactly ONE echo tag to do the lookup, then stop.',
    'Use the suit — OUR data — NEVER the web for this.',
    '',
    suit.suitContextBlock() || ''
  ].join('\n');

  // 2) Turn 1 — she decides which tool/recipe and emits the tag.
  let messages = [{ role: 'system', content: system }, { role: 'user', content: TASK }];
  let raw1 = '';
  let tags = [];
  for (let attempt = 1; attempt <= 2 && tags.length === 0; attempt++) {
    raw1 = await runTurn(MODEL, messages);
    tags = echoSuitLib.parseEchoTags(raw1);
    if (tags.length === 0 && attempt === 1) {
      messages.push({ role: 'assistant', content: raw1 });
      messages.push({ role: 'user', content: 'You did not emit an echo tag. Emit ONE now — e.g. <echo-recipe name="..." arg="..."/> or <echo-do name="search_knowledge">{"query":"US Israel economic partnership"}</echo-do> — and nothing else.' });
    }
  }
  console.log(`[2] Zoe's turn (raw):\n${raw1.trim()}\n`);
  if (tags.length === 0) { console.error('Zoe emitted no echo tag after 2 tries — connection plumbing fine, but model did not drive it.'); process.exit(2); }

  // 3) Dispatch her tag(s) — the REAL DB hit.
  const dispatched = [];
  for (const tag of tags.slice(0, 2)) {
    const label = tag.kind === 'do' ? `echo-do ${tag.name}` : tag.kind === 'recipe' ? `echo-recipe ${tag.name}` : `echo-${tag.kind}`;
    const r = await suit.dispatch(tag);
    dispatched.push({ label, r });
    console.log(`[3] dispatched ${label} → ${r.ok ? 'OK' : 'ERR'}\n----- tool result (capped) -----\n${(r.text || '').slice(0, 1400)}\n--------------------------------\n`);
  }

  // 4) Tool-followup with ONE chain hop (mirrors fireToolFollowup) — if her first
  //    tool was wrong / empty she may emit a corrected tag; we dispatch that too.
  let resultBlob = dispatched.map(d => `(${d.label})\n${(d.r.text || '').slice(0, 2500)}`).join('\n\n');
  const followMsgs = [
    { role: 'system', content: 'You are Zoe Lane. The Echo tool result is below. If it did NOT answer Lucas (e.g. 0 rows, or it tells you a better tool/recipe to use), emit ONE corrected echo tag now and nothing else. Otherwise answer Lucas grounded ONLY in the result, naming what is actually in our records.' },
    { role: 'user', content: TASK },
    { role: 'assistant', content: raw1.trim() },
    { role: 'user', content: `[Echo tool result:]\n\n${resultBlob}` }
  ];
  const raw2 = await runTurn(MODEL, followMsgs);
  const chainTags = echoSuitLib.parseEchoTags(raw2);
  if (chainTags.length > 0) {
    const tag = chainTags[0];
    const label = tag.kind === 'do' ? `echo-do ${tag.name}` : tag.kind === 'recipe' ? `echo-recipe ${tag.name}` : `echo-${tag.kind}`;
    console.log(`[4] Zoe self-corrected → ${label}\n${echoSuitLib.stripEchoTags(raw2).replace(/<\/?(think|thoughts|thinking|thought)>/gi,'').trim()}\n`);
    const r = await suit.dispatch(tag);
    console.log(`[5] dispatched ${label} → ${r.ok ? 'OK' : 'ERR'}\n----- tool result (capped) -----\n${(r.text || '').slice(0, 1600)}\n--------------------------------\n`);
    const final = await runTurn(MODEL, [
      { role: 'system', content: 'You are Zoe Lane. Answer Lucas in your own voice, grounded ONLY in the Echo tool result below. Be concrete — name what is actually in our records.' },
      { role: 'user', content: TASK },
      { role: 'user', content: `[Echo tool result — answer from THIS, our records:]\n\n${(r.text || '').slice(0, 2800)}` }
    ]);
    const say = echoSuitLib.stripEchoTags(final).replace(/<\/?(think|thoughts|thinking|thought)>/gi, '').trim();
    console.log(`[6] Zoe's grounded answer:\n${say || final.trim()}\n`);
  } else {
    const say = echoSuitLib.stripEchoTags(raw2).replace(/<\/?(think|thoughts|thinking|thought)>/gi, '').trim();
    console.log(`[4] Zoe's grounded answer (no chain):\n${say || raw2.trim()}\n`);
  }

  await suit.close();
  console.log('=== PROOF COMPLETE ===');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
