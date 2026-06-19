/**
 * Discord bridge for Zoe — a new I/O surface onto the SAME Zoe (same model,
 * same DB, same chat pipeline), so Lucas can talk to her from his phone and she
 * can reach out proactively when he's away from the machine.
 *
 * Hard locked to DMs with ONE user (DISCORD_OWNER_ID): never a server channel,
 * never anyone else. Inbound DMs from the owner are routed through the normal
 * chat turn (via an onOwnerMessage callback wired in main.js) and her reply is
 * DM'd back. She can also reach out first with the <discord-dm> tag.
 *
 * Privacy note: DMs transit Discord's cloud — a conscious tradeoff for mobile reach.
 *
 * Requires the "Message Content Intent" enabled on the bot in the Discord
 * developer portal, plus a bot token + owner id in .env (see config.js).
 *
 * Tag (parsed from <think>/<say>):
 *   <discord-dm>message to send Lucas on Discord</discord-dm>
 */

const config = require('./config');

let DiscordLib = null;
try { DiscordLib = require('discord.js'); } catch { /* not installed yet */ }

let client = null;
let ready = false;
let ownerUser = null;
let handlers = { onOwnerMessage: null, getWindow: () => null };

function setHandlers(h) { handlers = { ...handlers, ...h }; }

function isReady() { return ready; }
function isConfigured() { return config.discordConfig().configured; }

async function start() {
  const cfg = config.discordConfig();
  if (!cfg.configured) return { ok: false, reason: 'discord not configured (set DISCORD_BOT_TOKEN/OWNER_ID in .env)' };
  if (!DiscordLib) return { ok: false, reason: 'discord.js not installed' };
  if (client) return { ok: true, already: true };

  const { Client, GatewayIntentBits, Partials } = DiscordLib;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.on('ready', () => {
    ready = true;
    console.log(`[discord] logged in as ${client.user?.tag}`);
  });

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author?.bot) return;                       // ignore bots (incl. self)
      if (msg.guild) return;                             // DMs only, never servers
      if (msg.author?.id !== cfg.ownerId) return;        // owner only
      const text = (msg.content || '').trim();
      if (!text) return;
      console.log(`[discord] DM from owner: ${text.slice(0, 80)}`);
      if (typeof handlers.onOwnerMessage === 'function') {
        // Route through the real chat pipeline; reply is DM'd back.
        let reply = null;
        try { reply = await handlers.onOwnerMessage(text); } catch (err) {
          console.error('[discord] onOwnerMessage failed:', err.message);
        }
        if (reply && reply.trim()) {
          await msg.channel.send(reply.slice(0, 1900)).catch(e =>
            console.error('[discord] reply send failed:', e.message));
        }
      }
    } catch (err) {
      console.error('[discord] messageCreate error:', err.message);
    }
  });

  client.on('error', (e) => console.error('[discord] client error:', e.message));

  try {
    await client.login(cfg.token);
    return { ok: true };
  } catch (err) {
    console.error('[discord] login failed:', err.message);
    client = null;
    return { ok: false, reason: err.message };
  }
}

async function stop() {
  try { if (client) await client.destroy(); } catch {}
  client = null; ready = false; ownerUser = null;
}

async function resolveOwner() {
  const cfg = config.discordConfig();
  if (!cfg.configured || !client) return null;
  if (ownerUser) return ownerUser;
  try { ownerUser = await client.users.fetch(cfg.ownerId); } catch (err) {
    console.error('[discord] could not fetch owner:', err.message);
    return null;
  }
  return ownerUser;
}

// Proactively DM Lucas. Used by the <discord-dm> tag and can be called from
// the scheduler/heartbeat for proactive outreach.
async function sendDM(text) {
  if (!isConfigured()) return { ok: false, reason: 'discord not configured' };
  if (!ready) return { ok: false, reason: 'discord not connected yet' };
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, reason: 'empty message' };
  const owner = await resolveOwner();
  if (!owner) return { ok: false, reason: 'could not resolve owner user' };
  try {
    await owner.send(t.slice(0, 1900));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// --- tag parsing (mirrors files.js style) ---

const DM_TAG_RE = /<discord-dm\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/discord-dm>)/gi;

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; DM_TAG_RE.lastIndex = 0;
  while ((m = DM_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: 'discord-dm', body: (m[2] || '').trim() });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(DM_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ body }) {
  return sendDM(body);
}

function buildPromptBlock() {
  if (!isConfigured()) return null;  // hide when no creds
  return `DISCORD — Lucas can reach you over Discord DMs (e.g. from his phone), and you can reach him first. When he's away from the machine, this is how you stay in touch.
  <discord-dm>what you want to tell Lucas</discord-dm>   — send him a Discord DM right now
Messages he sends you on Discord come to you as normal turns and your reply goes back to him there. Reach out when you have something worth saying — a thought that came due, progress on a goal — not idle pings.`;
}

module.exports = {
  start, stop, sendDM, setHandlers, isReady, isConfigured,
  parseTags, stripTags, dispatch, buildPromptBlock
};
