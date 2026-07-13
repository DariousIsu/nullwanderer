// Offline smoke for lib/caption_stream — pure helpers + the follower poll loop with an INJECTED fetch
// (no yt-dlp, no network). The live 4-feed end-to-end check lives in scratchpad (needs the network).
const cs = require('../lib/caption_stream');
let ok = 0, bad = 0;
const t = (c, m) => { if (c) { ok++; } else { bad++; console.log('  ✗ FAIL', m); } };

// parseManifest
const pm = cs.parseManifest(['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:100', 'https://x/a.vtt', 'https://x/b.vtt'].join('\n'));
t(pm.mediaSequence === 100, 'media-sequence');
t(pm.segments.length === 2 && pm.segments[0].seq === 100 && pm.segments[1].seq === 101, 'segment seq numbering');
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

// follower poll loop with injected fetch (no network): only NEWER segments fetched, dedup across polls
(async () => {
  const SEG = (tag) => `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nLINE ${tag}\n`;
  let manCall = 0;
  const mockFetch = async (u) => {
    if (u === 'http://m') { manCall++; const body = manCall === 1
      ? ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5', 'https://s/5', 'https://s/6'].join('\n')
      : ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:6', 'https://s/6', 'https://s/7'].join('\n');
      return { ok: true, status: 200, text: async () => body }; }
    return { ok: true, status: 200, text: async () => SEG(u.slice(-1)) };   // segment tag = last char (5/6/7)
  };
  const fol = new cs.CaptionFollower({ url: 'x', title: 'T' }, { fetchImpl: mockFetch });
  fol.manifestUrl = 'http://m'; fol.expiresAt = Date.now() + 1e9;   // skip yt-dlp resolve
  const p1 = await fol.poll({ now: 1000 });
  t(p1.join(',') === 'LINE 5,LINE 6', 'poll1 fetches segs 5+6');
  t(fol.lastSeq === 6, 'poll1 advances lastSeq to 6');
  const p2 = await fol.poll({ now: 2000 });
  t(p2.join(',') === 'LINE 7', 'poll2 fetches ONLY the new seg 7 (skips already-seen 6)');
  t(fol.lastSeq === 7, 'poll2 advances lastSeq to 7');

  console.log(bad ? `caption_stream: ${ok} ok, ${bad} FAILED` : `caption_stream: ${ok} ok`);
  process.exit(bad ? 1 : 0);
})();
