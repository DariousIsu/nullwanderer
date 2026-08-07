/* Smoke: lib/quota_scrape — the quota self-true-up parser (dashboard text → quota.mark_* values)
 * plus source asserts on main.js's scheduled scrape.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_quota_scrape.js
 */
'use strict';
const qs = require('../lib/quota_scrape');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = 1754500000000;
const HOUR = 3600000, DAY = 86400000;

// --- parseDuration ---
ok(qs.parseDuration('2 days') === 2 * DAY, '"2 days" → 2d ms');
ok(qs.parseDuration('1 hour') === HOUR, '"1 hour" → 1h ms');
ok(qs.parseDuration('1 day 3 hours') === DAY + 3 * HOUR, 'compound "1 day 3 hours" sums');
ok(qs.parseDuration('45 minutes') === 45 * 60000, '"45 minutes" → ms');
ok(qs.parseDuration('soon') === 0, 'no unit → 0 (never invented)');

// --- the labelled two-meter page (the dashboard as screenshotted) ---
const page = 'Usage\n\nSession\n36.1%\nResets in 1 hour\n\nWeekly\n67.1%\nResets in 2 days\n';
const p1 = qs.parseUsage(page, NOW);
ok(p1.ok === true && p1.pct === 0.671 && p1.label === 'weekly', 'labelled page → the WEEKLY meter is the mark (0.671)');
ok(p1.resetAt === NOW + 2 * DAY, 'reset_at = now + the weekly reset horizon');
ok(p1.session && p1.session.pct === 0.361 && p1.session.resetAt === NOW + HOUR, 'session meter carried alongside (for the log line)');

// order flipped → still the weekly
const flipped = 'Weekly\n67.1%\nResets in 2 days\n\nSession\n36.1%\nResets in 1 hour\n';
ok(qs.parseUsage(flipped, NOW).pct === 0.671, 'meter order does not matter — the label wins');

// --- no labels: the longest reset horizon is the pool ---
const bare = '36.1%\nResets in 1 hour\n\n67.1%\nResets in 2 days\n';
const p2 = qs.parseUsage(bare, NOW);
ok(p2.ok === true && p2.pct === 0.671 && p2.label === 'longest-horizon', 'unlabelled meters → longest horizon selected, and SAYS it guessed by horizon');

// --- the REAL /settings page (captured live 2026-08-07) — the layout the parser is built for ---
// The preamble "…contribute to session and weekly limits." sits right before the SESSION meter and
// used to poison its label; the session duration "3 hours." used to bleed into the weekly meter.
const REAL_PAGE = 'lucastoverby lucastoverby@gmail.com Usage Keys Billing Profile Cloud usage Pro Cloud models and capabilities such as web search contribute to session and weekly limits. Session usage 2.9% used Resets in 3 hours. Weekly usage 68% used Resets in 2 days. Models used this week mistral-large-3:675b 2 requests qwen3.5:397b 8 requests gemma4:31b 48428 requests kimi-k2.6 2920 requests kimi-k2.7-code 238 requests';
{
  const r = qs.parseUsage(REAL_PAGE, NOW);
  ok(r.ok === true && r.pct === 0.68 && r.label === 'weekly', 'REAL PAGE: the WEEKLY meter (68%) is the mark — NOT the 2.9% session meter the preamble mislabeled');
  ok(r.resetAt === NOW + 2 * DAY, 'REAL PAGE: weekly reset horizon is 2 days (session "3 hours" did not bleed in)');
  ok(r.session && r.session.pct === 0.029, 'REAL PAGE: the 2.9% session meter is carried as session, correctly labeled');
  const meters = qs.extractMeters(REAL_PAGE);
  ok(meters.length === 2 && meters.find((m) => m.label === 'session').pct === 0.029 && meters.find((m) => m.label === 'weekly').pct === 0.68, 'REAL PAGE: both meters extracted with their OWN labels bound to "<label> usage"');
}

// --- reset-horizon sanity: a meter LABELLED weekly but resetting in hours is REFUSED ---
// (the live 2026-08-07 misparse: "2.6% weekly, resets in 3h" — the session meter mislabeled.)
const mislabel = qs.parseUsage('Weekly\n2.6%\nResets in 3 hours\n', NOW);
ok(mislabel.ok === false && mislabel.signedOut === false && /too soon to be the weekly pool/.test(mislabel.reason), 'a "weekly" meter with a <24h reset is REFUSED (session-mislabeled-as-weekly guard)');
ok(qs.MIN_WEEKLY_RESET_MS === 24 * HOUR, 'the weekly-reset floor is 24h');
// a genuine weekly (days out) still passes the guard
ok(qs.parseUsage('Weekly\n67.1%\nResets in 2 days\n', NOW).ok === true, 'a real weekly (multi-day reset) still parses through the guard');

// --- single unlabelled meter: multi-day accepted, short-reset REFUSED ---
ok(qs.parseUsage('80%\nResets in 3 days', NOW).ok === true, 'a lone multi-day meter can only be the weekly pool → accepted');
const p3 = qs.parseUsage('80%\nResets in 45 minutes', NOW);
ok(p3.ok === false && p3.signedOut === false && /refusing/.test(p3.reason), 'a lone short-reset meter is the session bar → REFUSED (never poisons the weekly mark)');

// --- signed out / garbage: the mark is left untouched ---
const so = qs.parseUsage('Welcome to Ollama\nSign in to view your usage\n', NOW);
ok(so.ok === false && so.signedOut === true, 'signed-out page → signedOut verdict (throttled ask, no write)');
const empty = qs.parseUsage('', NOW);
ok(empty.ok === false && empty.signedOut === false, 'empty page → plain refusal, NOT mistaken for signed-out');
ok(qs.parseUsage('340%\nResets in 2 days', NOW).ok === false, 'a >100% match is noise, not a meter');
ok(qs.extractMeters('67.1%\nno reset anywhere').length === 0, 'a percentage with no reset horizon is not a meter');

// --- source asserts: the main.js schedule (circuit-proving) ---
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/persist:zoe-ollama/.test(m), 'the scrape runs on its own partition (cookie-ported, hidden window)');
  ok(/ZOE_QUOTA_SCRAPE\b/.test(m) && /ZOE_QUOTA_SCRAPE_MS/.test(m), 'kill switch + cadence are env-configurable');
  ok(/quota_scrape'\)\.parseUsage/.test(m), 'main.js parses through the pure lib, never inline');
  const writeIdx = m.indexOf("db.setMeta('quota.mark_pct'");
  const okIdx = m.indexOf('if (p.ok) {');
  ok(okIdx > -1 && writeIdx > okIdx && writeIdx - okIdx < 400, 'quota.mark_pct is written ONLY inside the clean-parse branch');
  ok(m.indexOf('/(^|\\.)ollama\\.com$/i.test(host)') > -1, 'cookie port filters to ollama.com hosts only');
  ok(/quota\.scrape_signin_note_at/.test(m), 'the signed-out chat ask is throttled (24h meta key)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
