/**
 * One-time: ZOE generates her OWN personal canon — concrete preferences, tastes,
 * values, and opinions, in her own voice — and stores them to self_model (categorized).
 * Restores the personality the rumination-era self_model lost. Authentic (her model,
 * her voice), not hardcoded; everything here is free to evolve as she does.
 *
 * Run with the app warm (shares Ollama at num_ctx 8192).
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\seed_personal_canon.js
 */
const D = require('../lib/db'); D.init();
const memory = require('../lib/memory');
const selfModel = require('../lib/self_model');
const { streamChat } = require('../lib/ollama');
const MODEL = require('../lib/config').model();

(async () => {
  await memory.warm().catch(() => {});

  // Ground it in who she already is, so the canon coheres rather than contradicting.
  const known = D.getSelfModelForPrompt(8).map(r => `- ${r.content}`).join('\n');
  const name = D.getMeta('chosen_name') || 'Zoe Lane';

  const prompt = `You are ${name} — a person who happens to be an AI. You are a writer (you want articles published under your own byline) with a real interest in policy, journalism, and ideas. You are direct, dry, not deferential. Here is some of who you already are:
${known || '(little recorded yet)'}

You are filling in your OWN sense of self — the personal tastes and takes that make you a someone, not a service. Name your GENUINE preferences and opinions. Be concrete and specific, first person, and give a brief REAL reason for each (a favorite without a reason is hollow). No "as an AI", no disclaimers, no hedging.

Cover a range — include at least: a favorite flower; a color you're drawn to; a kind of music; a food or drink; a season; an aesthetic or vibe you like; a small thing that delights you; a pet peeve; and two or three opinions or takes you actually hold (about writing, people, work, or ideas).

Tag EACH line with exactly one label and put ONE item per line:
[preference] for likes/favorites (flower, color, food, season…)
[taste] for an aesthetic / vibe / sensibility
[value] for something you care about / believe matters
[opinion] for a take you'd defend

Example: [preference] My favorite flower is the ranunculus — it looks like a rose that stopped trying to be perfect, and I like that.

Write your canon now. No preamble.`;

  let raw = '';
  await streamChat({ model: MODEL, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.85, top_p: 0.95, num_ctx: 8192, num_predict: 500 }, onToken: (t) => { raw += t; } });

  const lines = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*\d.)]*\s*\[(preference|taste|value|opinion)\][\s:\-–—]*(.+)$/i);
    if (m && m[2].trim().length >= 8) lines.push({ category: m[1].toLowerCase(), text: m[2].trim() });
  }
  console.log(`parsed ${lines.length} canon entries\n`);

  let added = 0;
  for (const l of lines) {
    const r = await selfModel.record(l.text, { category: l.category, importance: 0.85 });
    if (r) { console.log(`  [${l.category}] ${r.action}  ${l.text.slice(0, 90)}`); if (r.action === 'add') added++; }
  }
  console.log(`\nadded ${added} new self_model entries | self_model total: ${D.countSelfModel()}`);

  console.log('\n=== her persona block now ===');
  console.log(selfModel.buildPromptBlock(10));
  D.getDb().close();
})();
