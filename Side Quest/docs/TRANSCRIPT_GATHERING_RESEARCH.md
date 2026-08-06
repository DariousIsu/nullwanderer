# Automatic transcript gathering — feasibility research (speeches + committee hearings)

_2026-07-17. Research + exploration only (no build). Grounds Lucas's ask: "explore the possibility of
automatic transcript gathering from major speeches but also things like committee hearings." Extends the
speech/transcript lane already shipped (intent.detectSpeechQuery + news_lane transcript capture, commits
50030b6 / 06f9a00 / 9c65f4b)._

## Verdict
**Highly feasible, and most of the hard machinery already exists.** The single biggest enabler is already
built: **`av_transcribe`** (nx-echo) — "probe → download → transcribe a media URL in one call," faster-whisper
CPU int8, no GPU, **~5–10× real-time** (a 10-min hearing → ~1–2 min), accepting **any yt-dlp source (YouTube,
archive.org, C-SPAN, direct mp4/m4a, ~1700 extractors)**. That means the one genuinely hard case — a hearing or
speech that has **no published text yet, only video** — is a solved problem: pull the C-SPAN / committee-webcast
/ YouTube video and transcribe it locally. The rest is source-precedence + discovery/scheduling plumbing.

## The core insight: two transcript regimes, split by LATENCY
Every speech/hearing falls into one of two states, and the gathering strategy differs:

1. **Published-text regime** — an authoritative transcript already exists on the web (presidential remarks on
   whitehouse.gov; the official hearing record on govinfo/congress.gov). → **fetch + `web_extract`** (fast,
   clean, what the current lane does). Authoritative but for hearings it **lags weeks–months–years**.
2. **Video-only regime** — the words exist only as audio/video (a speech an hour ago; a hearing happening
   today; a state/local committee webcast). → **`av_transcribe`** the video (C-SPAN, YouTube, The Florida
   Channel, etc.). Same-day, self-sufficient, no third-party paid service.

A robust design tries regime 1 first (authoritative text), falls back to regime 2 (local transcribe), and — for
hearings — **backfills** the official transcript later when it publishes.

## Source landscape (researched 2026-07-17)

### A. Major speeches — EASY, buildable now, no new keys
| Source | What | Access | Notes |
|---|---|---|---|
| **American Presidency Project** (presidency.ucsb.edu) | THE archive: 35,394 spoken addresses/remarks, 101 SOTU, 2,525 news conferences, 1789→present | HTML scrape (advanced-search); **no official API** | Gold standard for presidential speeches; better than news |
| **whitehouse.gov** /briefing-room | Current admin remarks | web_extract; near-real-time | Authoritative for the sitting president |
| **state.gov, defense.gov, agency sites** | Official remarks | web_extract | |
| **C-SPAN / WH YouTube** | Video of the speech | **av_transcribe** | The video-regime fallback when text isn't posted yet |

### B. Federal committee hearings — feasible, bifurcated by latency
| Source | What | Access | Latency |
|---|---|---|---|
| **congress.gov API** — Committee-Meeting endpoint | `hearingTranscript` element / "Hearing: Transcript" doc type; filter by congress + chamber; also the **schedule** of upcoming/recent hearings | **needs free `CONGRESS_GOV_API_KEY`** (5k req/hr) — NOT set today | official = **lags months** |
| **govinfo.gov CHRG** collection | House/Senate hearings 104th Cong (1995)→present, PDF **or TEXT**; govinfo API (api.data.gov key) | free api.data.gov key | official = lags |
| **C-SPAN** | Video + searchable captions of recent hearings, **same-day** | **av_transcribe** the video (captions themselves aren't downloadable/clean) | **same-day** |
| committee sites, senate.gov/house.gov | Witness **written** testimony posted fast; full transcript lags | web_extract | testimony fast, transcript slow |
| CQ Transcripts / FiscalNote | Unofficial full transcript in ~1 hour | **PAID/commercial** | fast but not free |

**Takeaway:** the only way to get a federal hearing's words **the day it happens, for free** is the video →
`av_transcribe` path. congress.gov/govinfo give the authoritative record + discovery schedule, but late.

### C. State & local hearings — discovery keys ALREADY set
| Source | What | Access |
|---|---|---|
| **LegiScan** (50 states) | Bills, sessions, **committee/hearing schedules** | `LEGISCAN_API_KEY` **SET** ✓ (30k/mo) |
| **OpenStates** | Secondary state-leg source | `OPENSTATES_API_KEY` **SET** ✓ |
| **Legistar** (nx-echo `legistar_*`) | Municipal bodies: events, agenda items, matters | live |
| **The Florida Channel** (thefloridachannel.org) | FL Senate/House committee video archive | **av_transcribe** — relevant to Lucas's FL focus |
| per-state legislature tools (`ut_/md_/mi_/sd_/ks_/ma_legislature*`) | schedules/docs | live |

Pattern: use LegiScan/OpenStates/Legistar to **discover** a hearing (when + which body + a video link), then
`av_transcribe` the webcast for the words.

## What the system already has (reuse, don't rebuild)
- **`av_transcribe` / `av_download` / `av_probe`** — the video→text engine (faster-whisper, C-SPAN-aware).
- **`transcription_*`** — a full local diarization/speaker-ID engine (Whisper) already used for meetings
  ([[meeting-path]], [[media-search-and-watch]]) → gives speaker-attributed hearing transcripts ("who said what").
- **`legistar_*`, `legiscan_*`, per-state tools** — hearing discovery/scheduling.
- **The speech/transcript lane** (this session) — `intent.detectSpeechQuery`, `news_lane.isSpeechStory` +
  `captureTranscriptsPass` + `findRecentSpeech`, transcript_text/url store, cite-or-abstain query handler.
- **`web_extract` / `web_search`** — the published-text fetch path (with the precision gate from 06f9a00).

## Gaps / dependencies
1. **`CONGRESS_GOV_API_KEY` not set** — free signup at api.congress.gov/sign-up (5k req/hr). Needed for the
   official federal hearing transcript + the committee-meeting **schedule** (discovery). Lucas must create it
   (I can't sign up for accounts); then it lands in the Echo keychain like the others.
2. **No govinfo/api.data.gov key** — free; needed only for the govinfo CHRG official-record backfill.
3. **American Presidency Project has no API** — needs a small HTML scraper (stable advanced-search URL shape).
4. **Storage generalization** — today transcripts live on `news_stories.transcript_text` (speech-story-scoped).
   Hearings aren't news stories → want a small dedicated `transcripts` store keyed by (kind, subject, date,
   source_url), and generalize `findRecentSpeech` → `findTranscript({kind, subject})`.
5. **Discovery beyond the news feed** — today capture only fires on news-feed speech stories. "Automatic"
   wants proactive pollers: whitehouse.gov/APP for speeches; congress.gov schedule for federal hearings;
   LegiScan/Legistar for state/local.

## Recommended architecture (crawl → walk → run)
- **Phase 1 (buildable NOW, no new keys) — SPEECHES, source-precedence + video fallback.**
  Upgrade `fetchTranscript`: try authoritative text (whitehouse.gov, American Presidency Project) FIRST, then
  news transcript, then **`av_transcribe`** the speech video. This alone makes "what did X say" rock-solid for
  presidential/major speeches. Reuses the shipped lane.
- **Phase 2 (NOW) — SAME-DAY HEARINGS via video.**
  A `hearings` discovery tick (LegiScan/OpenStates/Legistar — keys already set) finds a hearing + its webcast;
  `av_transcribe` (model_size='small' for crosstalk) produces the transcript; `transcription_*` adds speaker
  attribution. Store in the new `transcripts` table. Florida-first (The Florida Channel) given Lucas's work.
- **Phase 3 (needs the free congress.gov key) — FEDERAL, authoritative + scheduled.**
  Poll congress.gov committee-meeting endpoint for upcoming/recent hearings (discovery) and the published
  `hearingTranscript` (authoritative backfill); govinfo CHRG for the historical record.
- **Cross-cutting:** generalize the query lane to `detectTranscriptQuery` (speech OR hearing) → `findTranscript`
  → cite-or-abstain; keep the deny-host/precision gate; respect `av_transcribe` `max_minutes` (don't pull an
  8-hour livestream); set expectations that Whisper on heavy-crosstalk hearings is good-not-perfect.

## Cautions
- **Latency honesty:** official hearing transcripts lag; be explicit that a same-day answer is a *machine*
  transcript (Whisper) of the video, and backfill the official record when it lands.
- **Accuracy:** faster-whisper `base` is great on clean single-speaker audio (a speech); use `small`/`medium`
  for gaveled hearings with crosstalk. Speaker labels come from the diarization engine, not guaranteed perfect.
- **Copyright/ToS:** C-SPAN video is generally usable for transcription for personal research; keep it local,
  cite the source URL, don't redistribute the media.
- **Compute:** a 60-min hearing at `small` ≈ 10 min CPU. Fine on the idle/nightly cadence; don't do it inline
  on a chat turn (do it on discovery, pre-grounded — same pattern as the news transcript capture).

## First concrete step (recommended)
Live-validate the video path end-to-end: pick one real recent hearing (a C-SPAN URL) and one presidential
speech (WH YouTube), run `av_transcribe`, and confirm quality + timing. That de-risks Phase 2 before any build.

## Sources
- [Congressional Hearings | govinfo](https://www.govinfo.gov/app/collection/chrg) · [govinfo Developer Hub / API](https://www.govinfo.gov/developers) · [usgpo/api (GitHub)](https://github.com/usgpo/api)
- [congress.gov Committee-Meeting endpoint (GitHub)](https://github.com/LibraryOfCongress/api.congress.gov/blob/main/Documentation/CommitteeMeetingEndpoint.md) · [congress.gov API](https://api.congress.gov/) · [House Committee Hearing Transcripts](https://www.congress.gov/house-hearing-transcripts/117th-congress)
- [American Presidency Project](https://www.presidency.ucsb.edu/) · [Advanced Search](https://www.presidency.ucsb.edu/advanced-search) · [Spoken Addresses and Remarks](https://www.presidency.ucsb.edu/documents/app-categories/presidential/spoken-addresses-and-remarks)
- [C-SPAN FAQ (captions/transcripts)](https://www.c-span.org/about/faq/) · [C-SPAN Congressional Chronicle](https://www.c-span.org/congress/) · [CQ Transcripts (paid, ~1hr)](https://info.cq.com/products/cq-transcripts/)
- [Georgetown Law: Hearings & Committee Transcripts](https://guides.ll.georgetown.edu/c.php?g=278869&p=1862823) · [LOC: Where to find hearing transcripts](https://ask.loc.gov/law/faq/300694)
