# Conversational Latency — Streaming Reality + Transitional Talk Design

**Status:** DESIGN (no code). 2026-08-14. Research pass + code audit, per Lucas: *"how we could make her more conversationally capable, how can we stream tokens in our set up and add transitional talking to fill large gaps."*

---

## 1. What the setup already does (audited, not assumed)

Token streaming is **already built, end to end** — the ask is not "add streaming," it is "kill the silences streaming doesn't cover":

- **Model → UI:** the reply streams token-by-token through `TagStreamParser.onSayToken` → `emit` → `chat:say-token` (`main.js:9646`, `:11697`), with the leak-guard stream filter inline.
- **Model → voice:** the chat handler speaks **each complete sentence the moment it lands** (`main.js:11700-11706`, `_lastSentenceEnd` boundary logic) — she starts talking on sentence one while sentence two is still generating. This is the sentence-chunked pattern the 2026 literature recommends ([AssemblyAI](https://www.assemblyai.com/blog/voice-agent-architecture), [ElevenLabs](https://elevenlabs.io/blog/voice-agent-latency-optimization)).
- **Synthesis pipeline:** `_speech.enqueue` (`main.js:594-624`) runs synth strictly serial but **pipelined ahead of playback** (sentence N+1 synthesizes while N plays), with generation-counter barge-in (`voice:barge` → `flush()`).
- **A `busy()` channel already exists** (`chat:busy` → renderer, `main.js:11718`) — currently text-only. This is the natural carrier for transitional talk.

Published latency budgets: streaming pipelines land **420–520 ms** total turn latency vs 2.5–5.5 s non-streaming; delays past **500–700 ms** start to feel unnatural; the optimal human response window is **300–700 ms** ([Retell](https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts), [Mitigating Response Delays, arXiv 2507.22352](https://arxiv.org/html/2507.22352v1)).

## 2. Where the dead air actually is

The silence lives in the places streaming can't reach — everything **before the first token** and **between turns of the tool chain**:

1. **Pre-stream (the big one):** signal computation → route → on lookup routes the **grounding pass runs before the reply** (ground-from-DB, then mandatory search per the DB-is-foundation rule) → package build (identity ~31-34k chars) → cloud TTFT. On a lookup turn this is seconds to tens of seconds of nothing.
2. **Mid-tool:** reply streams, `<echo-do>`/`<dig>` tags execute (20 s wrapper timeout each, multiple hops), then `fireToolFollowup` generates a second reply — dead air between the first reply ending and the follow-up starting.
3. **Deep-dives** already ACK fast and run on a separate lane (`main.js:11677` comment) — the pattern exists; it isn't voiced or generalized.

## 3. Research: what works and what doesn't

- **Sentence-level contextual fillers beat "um."** Simple filler words used substantially *hurt* perception; rich early acknowledgments that reference the actual request help ([ConvFill, arXiv 2511.07397](https://arxiv.org/html/2511.07397); [backchannel/filler representation, arXiv 2509.20237](https://arxiv.org/html/2509.20237v1)).
- **Natural fillers mask latency; artificial wait indicators don't** (spinner-speak like "processing your request" does nothing for felt latency — [arXiv 2507.22352](https://arxiv.org/html/2507.22352v1)).
- **ConvFill's architecture is ours already:** a small fast model responds instantly while the big pipeline completes, handing off mid-conversation. We have a resident warm local front model (gemma4:12b) and a serialized speech queue — the collaboration pattern drops straight in.
- **Interruptions + backchannels** materially improve naturalness for voice agents ([CHI 2025](https://dl.acm.org/doi/10.1145/3706598.3714228)); full-duplex models ([PersonaPlex, arXiv 2602.06053](https://arxiv.org/html/2602.06053v1)) are the far end — our stack is half-duplex (AEC dead, barge-in shelved), so that's a later chapter.

## 4. The design — three layers, all riding existing organs

**Doctrine constraint first (non-negotiable):** transitional talk is speech about *work in progress*. It must be **bound to a real event** (a route decision, an operator step actually dispatched) — never model-invented — and it may **never claim a result, a completion, or a finding**. A filler that says "I found it" before anything landed is the fabrication disease with a voice. Deterministic templates + the small local model under a strict contract; the anti-fab gate's spirit applies to the transition layer.

### Layer 1 — instant acknowledgment (kills the pre-stream silence)
- **Trigger:** the moment `computeTurnRoute` returns a route that historically runs long (lookup-with-operator, task, docqa) — before the grounding pass starts. Gate on a **rolling per-route TTFT median** (measure first — see §5), not a hardcoded route list: routes that stream fast get no filler.
- **Utterance:** one sentence, ≤ ~12 words, topical ("let me pull up what I have on the Osceola race"), from a deterministic route+topic template bank with the local front model as the variety layer (template output validated: length cap, no past-tense claim verbs, no numbers). Falls back to pure template when the local model is cold — first audio must beat ~700 ms.
- **Path:** `_speech.enqueue` directly (respects voice guard + serialization); mirrored to `chat:busy` so the text UI shows the same acknowledgment.

### Layer 2 — progress narration (fills the mid-tool gap)
- **Trigger:** an operator run or tool chain still working N seconds after the last spoken audio ended (start ~8–10 s, tunable). Throttled to one line per interval, max 2–3 per run.
- **Utterance:** derived **deterministically from the step actually executing** (tool name → template: `usaspending_search` → "still going through the federal grant records…"). Never generated from what the model *hopes* is happening. Silent skip when the voice guard holds or she's mid-sentence (`skipIfBusy` semantics).
- **This is the "transitional talking to fill large gaps"** — and it doubles as honest progress reporting: the same event stream that feeds the step markers feeds the voice.

### Layer 3 — clean handoff into the real answer
- When the real reply's first sentence enqueues, any **unplayed** filler chunks are dropped (a filler-class marker on queue entries; the reply cancels pending fillers, never vice versa, and never cancels a filler already mid-playback — no audible cut).
- The follow-up reply after tools reuses the same streaming sentence-speak path, so the answer itself needs no changes.

### Later chapters (named, not designed here)
- **Barge-in revival** (renderer AEC-referenced path is scaffolded; half-duplex is the current bound) — the single biggest naturalness win after fillers, per CHI 2025.
- **Listener backchannels** while Lucas speaks (needs duplex; parked with it).
- **Mood-modulated filler style** — a consumer for the internal-state vector (proposal §4), *after* that organ exists.

## 5. Build order (measure → mechanism, each slice provable)

| Slice | Build | Proof |
|---|---|---|
| 0 — Instrument | Per-route timing: end-of-user-turn → route / first-token / first-audio, logged per turn (route_obs already wraps dispatch; the turn side needs ~3 timestamps) | A week of real distributions; the filler gate threshold comes from THIS data, not a guess |
| 1 — Layer 1 | Template-bank acknowledgment on slow routes, `chat:busy` mirror | Measured first-audio on slow routes < 700 ms; zero fillers on fast routes; no filler ever contains a claim (template lint in smoke) |
| 2 — Layer 3 | Filler-class queue marker + reply-cancels-pending-fillers | Smoke: reply sentence enqueued while filler pending → filler dropped, reply plays; mid-playback filler never cut |
| 3 — Layer 2 | Step-derived progress lines on long runs, throttled | Live: a >20 s operator run speaks ≤3 honest progress lines; a <8 s run speaks none |
| 4 — Variety | Local-model paraphrase over templates, contract-validated | Same lint gate; repetition rate across a day's fillers drops |

**Sequencing vs. the defect review:** Slice 0 can start immediately (instrumentation only). Slices 1–3 touch the reply path and the speech queue — they should land *after* the fabrication-surface fixes (defect review §6 item 2), since Layer 1's honesty contract and the tag-parser fixes guard the same door.

## 6. Sources

[ConvFill: Model Collaboration for Responsive Conversational Voice Agents](https://arxiv.org/html/2511.07397) · [Mitigating Response Delays in Free-Form Conversations (arXiv 2507.22352)](https://arxiv.org/html/2507.22352v1) · [LLM voice agents with interruptions and backchannels (CHI 2025)](https://dl.acm.org/doi/10.1145/3706598.3714228) · [Backchannels/fillers in fine-tuned LMs (arXiv 2509.20237)](https://arxiv.org/html/2509.20237v1) · [PersonaPlex full-duplex (arXiv 2602.06053)](https://arxiv.org/html/2602.06053v1) · [Voice agent architecture (AssemblyAI)](https://www.assemblyai.com/blog/voice-agent-architecture) · [Latency optimization (ElevenLabs)](https://elevenlabs.io/blog/voice-agent-latency-optimization) · [STT-LLM-TTS pipeline latency (Retell)](https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts) · [Low-latency TTS TTFA comparisons (Gradium)](https://gradium.ai/content/best-low-latency-tts-apis-2026)

**Companions:** `PROGRAM_DEFECT_REVIEW_2026-08-14.md` (fix-order interlock) · `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` (mood-modulated style, later) · `voice-two-way` memory (half-duplex bound, AEC status)
