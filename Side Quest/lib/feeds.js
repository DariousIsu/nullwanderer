/**
 * lib/feeds.js — the operator's news-feed subscription list for the canvas Monitors widget.
 * Persisted to data/feeds.json ([{url,title}]). Seeded with a few stable defaults on first run.
 * Pure store (CRUD); fetching is done in main via the engine's fetch_feeds_batch tool.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'feeds.json');

// Curated + live-validated (2026-06-30, re-validated + widened 2026-07-01) — a 20-source wall
// spanning US politics, world, business, and tech, weighted toward HIGH-VELOCITY feeds (Google
// News aggregator, Al Jazeera, TechCrunch, The Hill, Fox Politics, DW) so a 2-min poll almost
// always surfaces something new. The operator edits this freely from the Monitors widget; this
// is just the first-run seed.
const DEFAULTS = [
  { url: 'https://news.google.com/rss', title: 'Google News' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'NYT Top Stories' },
  { url: 'http://feeds.foxnews.com/foxnews/latest', title: 'Fox News' },
  { url: 'https://moxie.foxnews.com/google-publisher/politics.xml', title: 'Fox Politics' },
  { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR News' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC World' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', title: 'BBC Tech' },
  { url: 'https://feeds.washingtonpost.com/rss/world', title: 'WaPo World' },
  { url: 'http://rss.cnn.com/rss/edition.rss', title: 'CNN' },
  { url: 'https://www.theguardian.com/world/rss', title: 'Guardian World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera' },
  { url: 'https://rss.dw.com/rdf/rss-en-all', title: 'Deutsche Welle' },
  { url: 'https://abcnews.go.com/abcnews/topstories', title: 'ABC News' },
  { url: 'https://thehill.com/homenews/feed/', title: 'The Hill' },
  { url: 'https://rss.politico.com/playbook.xml', title: 'Politico Playbook' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', title: 'CNBC Business' },
  { url: 'https://techcrunch.com/feed/', title: 'TechCrunch' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica' },
  { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge' },
  { url: 'https://www.reddit.com/r/worldnews/.rss', title: 'Reddit WorldNews' },
];

function read() { try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : null; } catch { return null; } }
function write(list) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch (e) { /* non-fatal */ } }

function list() { let l = read(); if (l === null) { l = DEFAULTS.slice(); write(l); } return l; }
function add(url, title) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
  const l = list();
  if (!l.some(f => f.url === url)) { l.push({ url, title: String(title || '').trim() }); write(l); }
  return { ok: true, list: l };
}
function remove(url) { const l = list().filter(f => f.url !== url); write(l); return { ok: true, list: l }; }

// --- video monitors (embedded YouTube players in the Monitors widget) ---
const VFILE = path.join(__dirname, '..', 'data', 'monitor_videos.json');
const DEFAULT_VIDEOS = [
  { url: 'https://www.youtube.com/watch?v=gCNeDWCI0vo', title: '' },
  { url: 'https://www.youtube.com/watch?v=iipR5yUp36o', title: 'ABC News' },
  { url: 'https://www.youtube.com/watch?v=GotlA1KKWoo', title: 'CNN' },
  { url: 'https://www.youtube.com/watch?v=f39oHo6vFLg', title: 'Bloomberg' },
];
function vread() { try { const a = JSON.parse(fs.readFileSync(VFILE, 'utf8')); return Array.isArray(a) ? a : null; } catch { return null; } }
function vwrite(l) { try { fs.mkdirSync(path.dirname(VFILE), { recursive: true }); fs.writeFileSync(VFILE, JSON.stringify(l, null, 2)); } catch (e) { /* non-fatal */ } }
function videoList() { let l = vread(); if (l === null) { l = DEFAULT_VIDEOS.slice(); vwrite(l); } return l; }
function videoAdd(url, title) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
  const l = videoList();
  if (!l.some(v => v.url === url)) { l.push({ url, title: String(title || '').trim() }); vwrite(l); }
  return { ok: true, list: l };
}
function videoRemove(url) { const l = videoList().filter(v => v.url !== url); vwrite(l); return { ok: true, list: l }; }

module.exports = { list, add, remove, videoList, videoAdd, videoRemove, FILE, VFILE, DEFAULTS, DEFAULT_VIDEOS };
