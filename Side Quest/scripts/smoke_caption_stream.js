// Offline smoke for lib/caption_stream — pure helpers + the follower poll loop with an INJECTED fetch
// (no yt-dlp, no network). The live 4-feed end-to-end check lives in scratchpad (needs the network).
const cs = require('../lib/caption_stream');
let ok = 0, bad = 0;
const t = (c, m) => { if (c) { ok++; } else { bad++; console.log('  ✗ FAIL', m); } };

// parseSegmentUrls — URL lines only, ignores #-directives (works on a full playlist OR just its tail)
const urls = cs.parseSegmentUrls(['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:100', '#EXTINF:5,', 'https://x/a', '#EXTINF:5,', 'https://x/b'].join('\n'));
t(urls.length === 2 && urls[0] === 'https://x/a' && urls[1] === 'https://x/b', 'parseSegmentUrls extracts segment URLs in order');
t(cs.parseSegmentUrls('#EXTM3U\n#EXT-X-ENDLIST').length === 0, 'no URLs → empty');
// parseVtt
const lines = cs.parseVtt('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:0,MPEGTS:5\n\n1\n00:00:01.000 --> 00:00:03.000 align:start\n<c>HELLO</c> WORLD\n');
t(lines.length === 1 && lines[0] === 'HELLO WORLD', 'vtt → clean words');
// freshLines dedup
const seen = new Set();
t(cs.freshLines(seen, ['A', 'B']).join(',') === 'A,B', 'fresh: all unseen');
t(cs.freshLines(seen, ['B', 'C']).join(',') === 'C', 'fresh: dedup overlap');
// captionUrlFromInfo
t(cs.captionUrlFromInfo({ automatic_captions: { en: [{ ext: 'json3', url: 'J' }, { ext: 'vtt', url: 'V' }] } }) === 'V', 'prefers vtt');
t(cs.captionUrlFromInfo({ automatic_captions: {} }) === null, 'null when none');

// follower poll loop with injected fetch (no network): fetches only UNSEEN segment URLs, dedups across polls
(async () => {
  const SEG = (tag) => `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nLINE ${tag}\n`;
  let manCall = 0;
  let lastRange = null;
  const mockFetch = async (u, opts) => {
    if (u === 'http://m') {
      manCall++; lastRange = opts && opts.headers && opts.headers.Range;
      const body = manCall === 1
        ? ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5', 'https://s/5', 'https://s/6'].join('\n')
        : ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:6', 'https://s/6', 'https://s/7'].join('\n');
      return { ok: true, status: 200, text: async () => body };   // 200 → follower slices tail itself
    }
    return { ok: true, status: 200, text: async () => SEG(u.slice(-1)) };
  };
  const fol = new cs.CaptionFollower({ url: 'x', title: 'T' }, { fetchImpl: mockFetch });
  fol.manifestUrl = 'http://m'; fol.expiresAt = Date.now() + 1e9;   // skip yt-dlp resolve
  const p1 = await fol.poll({ now: 1000 });
  t(p1.join(',') === 'LINE 5,LINE 6', 'poll1 fetches segs 5+6');
  t(lastRange === undefined, 'poll does NOT send a Range header (googlevideo 400s on it) — slices tail in memory');
  const p2 = await fol.poll({ now: 2000 });
  t(p2.join(',') === 'LINE 7', 'poll2 fetches ONLY the new URL (seg 7), skips already-seen seg 6');

  console.log(bad ? `caption_stream: ${ok} ok, ${bad} FAILED` : `caption_stream: ${ok} ok`);
  process.exit(bad ? 1 : 0);
})();
