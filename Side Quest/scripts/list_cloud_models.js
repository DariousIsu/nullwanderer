/* scripts/list_cloud_models.js — list the cloud models Zoe's API key can reach.
 * Hydrates OLLAMA_API_KEY from Echo's keychain IN-PROCESS (never prints the key), then queries the
 * cloud Ollama endpoint via lib/models. Run: node scripts/list_cloud_models.js */
'use strict';
const path = require('path');
const keystore = require('../lib/keystore');
const models = require('../lib/models');

const ECHO_CWD = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const PY = path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');

(async () => {
  const h = keystore.hydrateFromEcho(['OLLAMA_API_KEY'], { python: PY, cwd: ECHO_CWD });
  console.log('key hydrated:', h.resolved.includes('OLLAMA_API_KEY'));   // boolean only — no value
  const cloud = models.sources().find(s => s.tier === 'cloud');
  if (!cloud) { console.log('no cloud source (no key)'); return; }
  console.log('cloud base:', cloud.base, '| token present:', !!cloud.token);
  const list = await models.listFromSource(cloud);
  console.log(`cloud models returned: ${list.length}\n`);
  for (const m of list.sort((a, b) => (b.sizeGB || 0) - (a.sizeGB || 0))) {
    console.log(`  ${m.name}\t${m.paramSize || '?'}\t${m.sizeGB ? m.sizeGB + 'GB' : ''}\t${m.family || ''}`.trimEnd());
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
