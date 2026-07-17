/* Smoke: news_lane transcript capture — isSpeechStory classifier, fetchTranscript (search+rank+extract),
 * findRecentSpeech (query-time lookup), and captureTranscriptsPass (hourly ingest capture). Isolated news DB.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_transcript.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_newstranscript_${process.pid}.db`);
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.NEWS_DB_PATH = tmp;

const news = require('../lib/news_lane');
const newsdb = require('../lib/news_db');
news.ensureSchema();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const NOW = 1_700_000_000_000;
const insertStory = (title, summary, { outlets = 3, reports = 3, ts = NOW } = {}) =>
  newsdb.get().prepare(
    `INSERT INTO news_stories (title, summary, outlet_count, report_count, source_count, first_ts, last_ts, status, created_at)
     VALUES (?,?,?,?,?,?,?, 'open', ?)`
  ).run(title, summary, outlets, reports, outlets, ts, ts, ts).lastInsertRowid;

(async () => {
// ---- 1) isSpeechStory (pure) ----
ok(news.isSpeechStory({ title: 'President Trump delivers primetime address to the nation', summary: '' }), 'speech: "delivers … address" → true');
ok(news.isSpeechStory({ title: 'Read the full transcript of Trump\'s speech', summary: '' }), 'speech: "full transcript … speech" → true');
ok(news.isSpeechStory({ title: 'Zelensky addressed the nation on the war', summary: '' }), 'speech: "addressed the nation" → true');
ok(!news.isSpeechStory({ title: 'Trump signs infrastructure bill into law', summary: 'The president signed …' }), 'non-speech: "signs bill" → false');
ok(!news.isSpeechStory({ title: 'Markets rally on jobs report', summary: '' }), 'non-speech: markets → false');

// ---- 2) fetchTranscript: ranks a transcript URL first, extracts the body ----
const BODY = 'My fellow Americans, tonight I address you on the state of our union. '.repeat(12);
const mkDispatch = (byUrl) => async ({ name, args }) => {
  if (name === 'web_extract') { const b = byUrl[args.url]; return b ? { ok: true, text: JSON.stringify({ text_preview: b }) } : { ok: false }; }
  return { ok: false };
};
{
  const search = async () => ({ results: [
    { url: 'https://randomblog.com/opinion/trump', title: 'Opinion: what Trump got wrong' },
    { url: 'https://www.whitehouse.gov/briefing-room/2026/07/16/remarks-transcript', title: 'Remarks by the President — full transcript' },
  ] });
  const dispatch = mkDispatch({ 'https://www.whitehouse.gov/briefing-room/2026/07/16/remarks-transcript': BODY });
  const tr = await news.fetchTranscript({ dispatch, search, story: { title: 'Trump primetime address' } });
  ok(tr && /whitehouse\.gov/.test(tr.url), 'fetchTranscript: authoritative transcript URL ranked + fetched first');
  ok(tr && tr.text.length >= 400, 'fetchTranscript: real transcript body returned');
}
// PRECISION GATE (2026-07-17 live fix): a search that returns only a Wikipedia BIO + a DICTIONARY page must
// yield NO transcript (→ abstain), never store those as "the words". These were being stored live on reboot.
{
  const junk = { 'https://en.m.wikipedia.org/wiki/Donald_Trump': 'Donald John Trump is an American politician…'.repeat(20),
                 'https://dictionary.cambridge.org/dictionary/english/some': 'some — determiner — an amount…'.repeat(20) };
  const search = async () => ({ results: [
    { url: 'https://en.m.wikipedia.org/wiki/Donald_Trump', title: 'Donald Trump - Wikipedia' },
    { url: 'https://dictionary.cambridge.org/dictionary/english/some', title: 'SOME | meaning' },
  ] });
  const tr = await news.fetchTranscript({ dispatch: mkDispatch(junk), search, story: { title: 'Trump primetime speech' } });
  ok(tr === null, 'fetchTranscript: deny-host (wikipedia/dictionary) results → null (abstain, no garbage stored)');
}
// A score-0 news RECAP (real news host, but not a transcript) is also rejected — better to abstain than pass a recap off as the words.
{
  const recap = { 'https://cnn.com/2026/07/16/politics/trump-speech-takeaways': 'Here are the takeaways from the speech…'.repeat(20) };
  const search = async () => ({ results: [{ url: 'https://cnn.com/2026/07/16/politics/trump-speech-takeaways', title: 'Takeaways from Trump\'s speech' }] });
  const tr = await news.fetchTranscript({ dispatch: mkDispatch(recap), search, story: { title: 'Trump speech' } });
  ok(tr === null, 'fetchTranscript: a score-0 news recap (no transcript signal) → null (abstain)');
}

// ---- 3) findRecentSpeech: needs a stored transcript + speaker/recency match ----
const sid = insertStory('President Trump delivers primetime address to the nation', 'Trump spoke on election integrity.');
insertStory('Trump signs infrastructure bill into law', 'Signed today.');   // non-speech decoy
ok(!news.findRecentSpeech({ speaker: 'Trump', now: NOW }), 'findRecentSpeech: no transcript stored yet → null');
news.setTranscript(sid, 'https://whitehouse.gov/x', BODY);
ok(news.findRecentSpeech({ speaker: 'Trump', now: NOW }) && news.findRecentSpeech({ speaker: 'Trump', now: NOW }).id === sid, 'findRecentSpeech: stored transcript for Trump → returns that story');
ok(!news.findRecentSpeech({ speaker: 'Biden', now: NOW }), 'findRecentSpeech: wrong speaker → null (no false match)');
ok(!news.findRecentSpeech({ speaker: 'Trump', now: NOW + 10 * 24 * 3600 * 1000 }), 'findRecentSpeech: outside recency window → null');
ok(news.findRecentSpeech({ speaker: null, now: NOW }) && news.findRecentSpeech({ speaker: null, now: NOW }).id === sid, 'findRecentSpeech: unspecified speaker ("they") → freshest speech w/ transcript');
// LIMIT-BUG regression (2026-07-17 live): a busy feed with 200+ stories touched MORE RECENTLY than the
// speech-with-transcript story must NOT hide it — the SQL pre-filter on transcript_text keeps it findable.
for (let i = 0; i < 210; i++) insertStory(`Unrelated headline ${i}`, 'news', { outlets: 1, reports: 1, ts: NOW + 1000 + i * 1000 });
ok(news.findRecentSpeech({ speaker: 'Trump', now: NOW + 300000 }) && news.findRecentSpeech({ speaker: 'Trump', now: NOW + 300000 }).id === sid,
  'findRecentSpeech: 210 newer non-transcript stories do NOT bury the captured transcript (LIMIT-bug fixed)');

// ---- 4) captureTranscriptsPass: fetch+store for a speech story lacking a transcript; skip the decoy ----
{
  const sid2 = insertStory('Governor delivers keynote address at convention', 'She delivered the keynote.', { ts: NOW });
  const url = 'https://cspan.org/transcript/keynote';
  const search = async () => ({ results: [{ url, title: 'Full transcript of the keynote' }] });
  const dispatch = mkDispatch({ [url]: BODY });
  const r = await news.captureTranscriptsPass({ dispatch, search, now: NOW, limit: 5 });
  ok(r.captured >= 1, `captureTranscriptsPass captured ≥1 (got ${r.captured})`);
  const got = newsdb.get().prepare('SELECT transcript_text, transcript_url FROM news_stories WHERE id = ?').get(sid2);
  ok(got && got.transcript_text && got.transcript_text.length >= 400, 'captured transcript persisted on the speech story');
  const decoy = newsdb.get().prepare("SELECT transcript_text FROM news_stories WHERE title LIKE 'Trump signs%'").get();
  ok(decoy && decoy.transcript_text == null, 'non-speech decoy was NOT given a transcript');
}

// ---- 5) findSpeechVideo: picks a real video-host URL, prefers authoritative (C-SPAN/.gov) ----
{
  const search = async () => ({ results: [
    { url: 'https://cnn.com/2026/07/politics/analysis', title: 'Analysis' },      // not a video host
    { url: 'https://www.youtube.com/watch?v=abc123', title: 'Trump speech full' }, // video (score 1)
    { url: 'https://www.c-span.org/video/?12345/trump-address', title: 'Address' },// video + authoritative (score 2)
  ] });
  const v = await news.findSpeechVideo({ search, subject: 'Trump address' });
  ok(/c-span\.org\/video/.test(v), `findSpeechVideo: picks the authoritative C-SPAN video (got ${v})`);
  const only = await news.findSpeechVideo({ search: async () => ({ results: [{ url: 'https://nytimes.com/x', title: 'article' }] }), subject: 'x' });
  ok(only === null, 'findSpeechVideo: no video-host hit → null (no false video)');
}

for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
