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

module.exports = { loadEnv, get, getInt, model, emailConfig, discordConfig, APP_ROOT, ENV_PATH };
