/**
 * Central credential + config loader for Side Quest's autonomy tools.
 *
 * Loads a gitignored `.env` at the app root (email password, Discord token)
 * exactly once, then exposes typed getters. Anything blank → the corresponding
 * tool reports "not configured" and no-ops gracefully rather than crashing.
 *
 * dotenv is the loader; if it isn't installed yet (e.g. first run before
 * `npm install`), we fall back to a tiny hand parser so requiring this module
 * never throws.
 */

const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(APP_ROOT, '.env');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    // Preferred path: dotenv populates process.env.
    require('dotenv').config({ path: ENV_PATH });
  } catch {
    // Fallback: minimal KEY=VALUE parser so we work pre-install.
    try {
      if (fs.existsSync(ENV_PATH)) {
        const txt = fs.readFileSync(ENV_PATH, 'utf8');
        for (const rawLine of txt.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const key = line.slice(0, eq).trim();
          let val = line.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) process.env[key] = val;
        }
      }
    } catch (e) {
      console.error('[config] .env fallback parse failed:', e.message);
    }
  }
}

function get(key, fallback = '') {
  loadEnv();
  const v = process.env[key];
  return (v === undefined || v === null) ? fallback : v;
}

function getInt(key, fallback) {
  const v = parseInt(get(key, ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

// --- Model ---
// Single source of truth for the local model name. Override via ZOE_MODEL in
// .env so swapping models is one line, never a code edit (per no-hardcode rule).
function model() {
  return get('ZOE_MODEL').trim() || 'mistral-small3.2:24b';
}

// The FRONT (voice) model — her conversational, persona-bearing local model. Distinct from
// model() so COGNITION/extraction can stay on a different local model (or move to cloud) while
// her VOICE uses this. Override via ZOE_FRONT_MODEL in .env; unset → model() (no behavior change).
// Resolved from env (not db) so it's available at module-load before db.init().
function frontModel() {
  return get('ZOE_FRONT_MODEL').trim() || model();
}

// The SUBCONSCIOUS model — her between-turn monologue/thinking. This is private cognition, not her
// spoken voice, so it should be a DEEP model (a cloud reasoner) for richer material. Set a cloud
// model name in ZOE_SUBCONSCIOUS_MODEL to route the monologue's thinking to the cloud; empty/unset
// → local front model (current behavior). The monologue falls back to local if the cloud is down.
function subconsciousModel() {
  return get('ZOE_SUBCONSCIOUS_MODEL').trim();
}

// The EXTRACTION / COGNITION model — the structured background work: dedup/merge decisions,
// importance scoring, fact/preference/relation/thread extraction, summaries, classifications.
// Routed to a CLOUD utility model by default so it uses ZERO local VRAM. This is what stops her
// front voice (Dans-24b) and a SECOND local 24B (mistral) from evicting each other on the GPU —
// the load/unload thrash that showed up as 20–40s hangs. The local Ollama daemon transparently
// proxies '-cloud' model names to ollama.com, so no token/base plumbing is needed at the callsite.
// Override via ZOE_EXTRACT_MODEL (set a LOCAL model name to keep extraction on-device). Resolved
// from env (not db) so it's available at module-load before db.init(), like the other model slots.
function extractionModel() {
  return get('ZOE_EXTRACT_MODEL').trim() || 'gemma4:31b-cloud';
}

// The MEETING-CORTEX model — a DEDICATED channel for real-time meeting processing (live
// understanding, addressed-detection answers, recap) when she's in a Meet hosted in the Canvas.
// Separate role so it doesn't contend with extraction; point it at ANY Ollama model via
// ZOE_MEETING_MODEL (local or '-cloud'). Defaults to the fast cloud utility model for low-latency
// turn-by-turn following; the existing web-search plumbing is just invoked from this channel.
function meetingModel() {
  return get('ZOE_MEETING_MODEL').trim() || extractionModel();
}

// The MEETING-SCRIBE model — a SEPARATE, dedicated channel that records/documents/analyzes the
// meeting (running minutes + end-of-meeting recap/action-items) from the transcript she captures.
// Distinct from her ACTOR (participation) model and from extraction — its own cloud model so it
// doesn't contend. Default gemini-3-flash-preview:cloud (fast, frontier, multimodal — a path to
// ingesting meeting AUDIO directly later). Override via ZOE_MEETING_SCRIBE_MODEL (any Ollama model).
function scribeModel() {
  return get('ZOE_MEETING_SCRIBE_MODEL').trim() || 'gemini-3-flash-preview:cloud';
}

// MEETING AUDIO → Echo transcription fusion (the authoritative diarized companion transcript). OFF by
// default — captions feed the live scribe; this adds high-quality audio transcription once the operator
// routes the Meet pane's audio to a VIRTUAL OUTPUT DEVICE (e.g. VB-CABLE) and points Echo's loopback at
// it (physical speakers stay silent → no echo). Enable: ZOE_MEETING_AUDIO=1. Source: ZOE_MEETING_AUDIO_SOURCE
// (loopback|mic, default loopback). Device: ZOE_MEETING_AUDIO_DEVICE_INDEX (the virtual cable's index).
function meetingAudioConfig() {
  const enabled = /^(1|true|yes|on)$/i.test(get('ZOE_MEETING_AUDIO', '').trim());
  const source = get('ZOE_MEETING_AUDIO_SOURCE').trim() || 'loopback';
  const di = parseInt(get('ZOE_MEETING_AUDIO_DEVICE_INDEX', '').trim(), 10);
  const deviceIndex = Number.isFinite(di) ? di : null;
  // Target the cable by NAME (indices shift across reboots, names don't) — resolved → a current index at
  // capture time. DEFAULT = "CABLE Input" (VB-CABLE: a standalone driver-level virtual cable, no app to run,
  // unlike Voicemeeter's buses). This is also the SAFE default — a dedicated cable, never the default output
  // mix, so a parallel meeting's audio can't bleed in. Override via ZOE_MEETING_AUDIO_DEVICE.
  const deviceName = get('ZOE_MEETING_AUDIO_DEVICE').trim() || 'CABLE Input';
  return { enabled, source, deviceIndex, deviceName };
}

// --- Tiered subconscious (local volume + cloud depth; see docs/SUBCONSCIOUS_TIERED_SPEC.md) ---
// All env-resolved (safe at module-load), all reversible/fail-safe to local.
//   mode: hybrid (default) | triage | local (never cloud, $0) | all (legacy every-tick-cloud)
function subcTierMode() { return get('ZOE_SUBC_TIER_MODE').trim() || 'hybrid'; }
function subcMeritThreshold() { const n = parseInt(get('ZOE_SUBC_MERIT_THRESHOLD', '').trim(), 10); return Number.isFinite(n) ? n : 3; }
function subcSynthIntervalMin() { const n = parseInt(get('ZOE_SUBC_SYNTH_MIN', '').trim(), 10); return Number.isFinite(n) ? n : 20; }
function subcBudgetTokensPerHour() { const n = parseInt(get('ZOE_SUBC_BUDGET_TOKPH', '').trim(), 10); return Number.isFinite(n) ? n : 120000; }
// Idle graph-builder gets its OWN rolling token ceiling, isolated from the shared subconscious pool the
// news/curation/forecast lanes fill — so knowledge-expansion can't be starved to zero by background noise.
// Ceiling raised (cloud-leverage, 2026-07-06): the fatter deep calls (below) spend ~3× per move, so a 60k
// cap would throttle knowledge-expansion to a trickle — lift it so the depth actually lands.
function graphwalkBudgetTokensPerHour() { const n = parseInt(get('ZOE_GRAPHWALK_BUDGET_TOKPH', '').trim(), 10); return Number.isFinite(n) ? n : 300000; }
// The PULLER lane (autonomous contact enrichment) gets its OWN rolling ceiling too — pattern-fills are
// free (no model), so this only bounds the web-discovery search+extract moves. Lower than graph-walk.
function pullerBudgetTokensPerHour() { const n = parseInt(get('ZOE_PULLER_BUDGET_TOKPH', '').trim(), 10); return Number.isFinite(n) ? n : 150000; }

// --- DEEP CALL BUDGETS (cloud-leverage, 2026-07-06) — we were feeding frontier models a 1/16th window
// (num_ctx 8192) and asking for a paragraph (num_predict 200-1000). These knobs, applied at the DEPTH
// call sites (extraction, dossier-building, subconscious thinking, research-section synthesis), let the
// 120B/675B actually work: a big context IN + room to write a rich answer OUT. Env-overridable; the
// micro-calls (intent classifiers, keyword picks) are deliberately left small. Bold defaults.
function deepNumCtx() { const n = parseInt(get('ZOE_DEEP_NUM_CTX', '').trim(), 10); return Number.isFinite(n) ? n : 32768; }
function deepNumPredict() { const n = parseInt(get('ZOE_DEEP_NUM_PREDICT', '').trim(), 10); return Number.isFinite(n) ? n : 3000; }
// Research SECTION synthesis (organize/merge a whole org's passes into prose) — the biggest single outputs.
function sectionNumPredict() { const n = parseInt(get('ZOE_SECTION_NUM_PREDICT', '').trim(), 10); return Number.isFinite(n) ? n : 6000; }

// --- DENSER SUBCONSCIOUS (cloud-leverage Slice 4) — the idle lanes ran ONE move each, SEQUENTIALLY, per
// tick, so between-turn cognition barely touched the (now 2M/hr) budget. Run the lanes CONCURRENTLY and let
// the knowledge-building graph-walk BURST several moves per tick (each still budget-gated, so it self-limits).
function subcMovesPerTick() { const n = parseInt(get('ZOE_SUBC_MOVES_PER_TICK', '').trim(), 10); return Number.isFinite(n) && n >= 1 ? n : 3; }
function subcConcurrentLanes() { return !/^(0|false|no|off)$/i.test(get('ZOE_SUBC_CONCURRENT', '').trim()); }   // default ON

// --- DEEP REASONER (cloud-leverage Slice 5) — the big model to use on LOW-VOLUME, HIGH-VALUE blueprint/
// synthesis calls (the research plan that shapes a whole project). The fast/deep split is intentional, so
// this is NOT for high-volume tool-calling or utility extraction — only the calls where depth clearly wins.
function deepReasonerModel() { return get('ZOE_DEEP_REASONER_MODEL').trim() || subconsciousModel() || 'gpt-oss:120b'; }

// --- Email ---
function emailConfig() {
  const user = get('ZOE_EMAIL_USER').trim();
  const pass = get('ZOE_EMAIL_PASS').trim();
  const from = get('ZOE_EMAIL_FROM').trim() || user;
  const dailyCap = getInt('ZOE_EMAIL_DAILY_CAP', 20);
  return { user, pass, from, dailyCap, configured: !!(user && pass) };
}

// --- Discord ---
function discordConfig() {
  const token = get('DISCORD_BOT_TOKEN').trim();
  const ownerId = get('DISCORD_OWNER_ID').trim();
  return { token, ownerId, configured: !!(token && ownerId) };
}

module.exports = { loadEnv, get, getInt, model, frontModel, subconsciousModel, extractionModel, meetingModel, scribeModel, meetingAudioConfig, subcTierMode, subcMeritThreshold, subcSynthIntervalMin, subcBudgetTokensPerHour, graphwalkBudgetTokensPerHour, pullerBudgetTokensPerHour, deepNumCtx, deepNumPredict, sectionNumPredict, subcMovesPerTick, subcConcurrentLanes, deepReasonerModel, emailConfig, discordConfig, APP_ROOT, ENV_PATH };
