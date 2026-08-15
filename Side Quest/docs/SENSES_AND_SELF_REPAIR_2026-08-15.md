# Senses & Self-Repair — the last piece
2026-08-15 · Lucas: "better user-information delivery, screen reading, program accessing, camera,
better ambient listening, better calendar exposure — and real self-audit and improvement runs.
These diagnostics you are running should be native: identify a problem or missing skill, research
the repair or gap-fill, apply it." · Companion to DETERMINISTIC_LOOPS (the beat contract §0b
governs every perception loop here: python senses, python computes deltas, SHE processes the
delta on beats that already end at a model).

## PART ONE — THE SIX SENSES (exists / weak / upgrade)

**1. Delivery to Lucas.** EXISTS: chat+TTS, sheep rail, presence.js desktop notify, Discord DM
(away channel), canvas/saga, hourly briefing widget, the share outbox, and a real moment-gate
(heartbeat importance × lane thresholds). WEAK: the gate is binary SPEAK/SILENT — suppressed
items die in a rail he doesn't watch; channel choice ignores presence. UPGRADE (M): a delivery
ROUTER replacing the binary suppress — importance × presence → chat-now / notify+DM / a booked
"held for you" digest on the recheck queue, surfaced in awareness. Zero new model calls.

**2. Screen.** EXISTS: `<observe-screen/>` (titles, sanitized) + `<screen-see/>` (720p capture →
vision model, auto-fires on "look at my screen"); Echo UIA text reads + the gui_do grounder.
WEAK: all on-demand, zero ambient awareness; the SQ and Echo stacks don't share. UPGRADE (M):
an ambient screen beat per §0b — 60–120s title-only sampler → python deltas → one awareness
line; the vision model only on threshold events. (S): text-heavy reads route via
os_read_focused_text before pixels.

**3. Program access.** EXISTS: the full Echo UIA suite (launch/keys/click/invoke/set_value/
window mgmt/powershell) behind the decide() confirm gate, gui_do as layer-2. WEAK — headline:
**her own prompt still says "you can't control anything" (screen.js buildPromptBlock)** — the
capability is built-and-dark at the prompt layer; approvals rot unwatched; no act→verify loop
outside gui_do. UPGRADE: (S) make the prompt name the real doors; (S) pipe pending approvals
into notify/awareness; (M) act→os_describe_focused_ui verify wrapper.

**4. Camera.** CONFIRMED NOT BUILT — both getUserMedia calls are audio-only; videoCapture is
granted only to the Meet/Teams webviews and nothing reads frames. Adjacent substrate ready:
face_match.js, vision.describe. UPGRADE (M): PRESENCE-FIRST — periodic frame → local
motion/face-present detection (python, free), a model call only on state CHANGE
(arrived/left/someone-else) → one status_vector line. Explicit opt-in + a hard off toggle.
Full room/identity vision is L and later.

**5. Ambient listening.** EXISTS: always-on mic (VAD, pre-roll, Parakeet STT), speaker gate
calibrated, voice_guard priority chain, Echo's diarizing transcription suite with voiceprints.
WEAK: two disjoint ears — the always-on loop DISCARDS every non-Lucas utterance instead of
logging "someone else said X"; the diarizing ear only runs on explicit session start; non-speech
sound invisible. UPGRADE: (S) retain gate-rejects as room-awareness lines (+ voiceprint match
against known speakers); (S) surface reject streaks ("re-enroll?"); (M) a voice_guard pause
auto-offers a loopback attend session; AEC/barge-in stays shelved (hardware).

**6. Calendar.** EXISTS: gcal.js Echo-OAuth bridge (near-1:1 surface), isCalendarBusy, Echo
calendar tools. WEAK — headline BUG: **lib/calendar.js is still on its stub — setProvider() is
never called anywhere**, so the meeting-aware ETA/deadline engine has run blind the entire time
gcal has been live. No day-model in her prompts, no prep-before-meeting. UPGRADE: (S) wire
setProvider with a cached gcal fetch at boot — everything downstream lights up; (S) a "today
ahead" line (next 2–3 events + countdown) in awareness; (M) a T-15min prep organ via the
recheck queue → research lane → the §1 delivery router.

**Cross-cutting:** every sense is on-demand pull today. The status_vector (Loop A) is the spine
all six plug into. Cheapest wins first: calendar setProvider (S, a bug), prompt-block truth for
OS control (S, a lie), speaker-reject retention (S), delivery router (M).

## PART TWO — THE NATIVE SELF-REPAIR LOOP (identify → research → apply → verify)

**Audit headline: the chain is live up to the R2 proposal card and NOTHING exists past it** —
no adopt() anywhere; "landing" a green card writes a document and adoption is "apply by hand."
IDENTIFY only watches runtime exhaust, never her own code. The four links:

**1. IDENTIFY — new `lib/self_audit.js` (Stage 1, M).** A scheduled deterministic source sweep
on the existing audit clock: seven detectors mirroring what the external deep-dives found
mechanically — zero-caller exports, unconsumed setMeta/getMeta keys, orphan env flags,
advertised≠emitted lanes, LIVE-claim/TODO contradictions, fail-open catches in gate-named
functions, un-gated smoke orphans. (self_check.js already does advertised≠executed checking —
but only for recipes; the pattern exists, aimed at nothing.) Findings mint through the SAME
capped need door, bornFrom `self-audit:<detector>:<file>`; only findings recurring across ≥2
passes mint (one-pass noise never does).

**2. RESEARCH — class-branched study (Stage 2, M).** The study pass is right for skills
(web patterns + URL-demand), wrong-shaped for repairs. Repair needs get a DIAGNOSIS pass:
deterministic pre-gather (log tail, implicated source region, git history for the file) and a
validator demanding FILE:LINE citations instead of URLs. Web study unchanged for skill needs.

**3. APPLY — the staged-patch path (Stage 3, M–L).** A green R2 exit also writes
`data/staged_patches/<slug>/`: diff, files, baseline sha256s, gate + refuter verdicts, and the
pre-land-sweep answers as a card section (the sweep becomes HER discipline). The approval verb
is INTERACTIVE-ONLY — same posture as the enforced tier gate; no autonomous surface can write
"approved". `scripts/apply_staged_patch.js`: baseline-hash staleness guard → clean-tree check →
branch `rehearsal/<slug>` (named files only — the Desktop-repo rule) → full live-tree gate →
commit only on green. ROLLBACK IS GIT ITSELF; Lucas merges and restarts on his clock.
**Stage 4 (M, default-off):** autonomous branch-commit for exactly one class — files the live
loader never executes (sandbox tools + new smokes) — under a standing, revocable grant.

**4. VERIFY — new `lib/repair_verify.js` (S–M).** Need status `verifying` on apply; a repair
resolves only when its anomaly signature stays silent 7 days AND the lane fired live (silence
by starvation is not a cure — the stray-video lesson); a skill resolves on first live use.
Recurrence reopens the same need with history attached to the card as regression evidence.

**Safety: nine doors, four already exist** (mint cap + content firewall, triage, sandbox jail,
gate + refuter). Lucas sits at exactly TWO new ones: per-patch approval (Stage 3) and the
per-class standing grant (Stage 4). Nothing self-adopts into loaded code, ever.

## ORDER
Quick wins now: calendar setProvider · OS-control prompt truth · speaker-reject retention.
Then: Stage 1 self_audit (the native diagnostics Lucas named) → delivery router → ambient
screen beat → Stage 2 diagnosis study → camera presence (behind the opt-in) → Stage 3 staged
patches → calendar prep organ → Stage 4 (his grant). The self-repair stages interleave with the
senses — each stage's first live proof gates the next.
