# Lucas Interaction Profile — drive map for live-test run 2 (2026-08-19)

Built from TWO sources:
1. **Her logs** — sq.db turns table: 2,244 user turns, 954 sessions, latency per kind, sequence bigrams.
2. **My logs** — Claude memory profile (how-lucas-works.md + feedback memories across sessions).

## Layer 1 — what he actually asks her (empirical, sq.db)

Top kinds by 30-day volume (n30) with median/p90 reply latency:

| kind | n30 | p50 | p90 | note |
|---|---|---|---|---|
| statements/brainstorm | 318 | 20.0s | 59.0s | his #1 mode — thinking out loud, steering |
| open questions | 137 | 26.1s | 98.6s | |
| research-order | 97 | 47.6s | 191.5s | SLOWEST high-volume kind — prime target |
| casual-social | 75 | 16.3s | 43.9s | "good morning zoe" ×10 |
| report-order | 52 | 34.1s | 145.3s | |
| canvas-order | 43 | 19.3s | 93.6s | |
| contact-detail | 41 | 22.8s | 89.4s | parish/legislator phones+emails |
| news-current | 36 | 31.2s | 153.4s | |
| affirm-continue | 35 | 30.0s | 171.2s | "yes/yea/ok back to it" — p90 3× worse than fresh asks! |
| schedule-cal | 32 | 40.3s | 92.8s | |
| bill-lookup | 12 | 46.3s | 106.0s | |
| roster-order | 5 | 67.7s | — | |

**His literal most-repeated questions (the rapid-response drill set):**
- "good morning zoe" (10×)
- "who is donald trump" (8×)
- "how many contacts do we hold with a phone number in louisiana" (5×)
- "how many email contacts do we have for louisiana perish leadership" (4×)
- "what documents are sitting on your canvas right now" (4×)
- "status report" (4×)
- "who represents louisiana senate district 14" (4×)
- "what is your favorite color" (4×)
- "what was the most interesting thing you learned today" (4×)
- "give me the parish contact list" (4×)
- "can you pull up that most recent list of ten people in louisiana…" (4×)

**Sequences (bigrams):** statement→statement dominates (brainstorm chains, 306×); question→question (76×);
casual→statement (44×); research-order→statement (39×) — he keeps talking WHILE research runs;
statement→affirm-continue (25×); research→research (20×). Gap-fill pattern while a job runs =
status checks + casual + recall + steering statements.

**Slowest real turns (30d):** deep-dive parish research 593s/445s/402s; "ok back to it, real numbers
this time" 378s; brainstorm-on-angle 379s; power-grid research kickoff 354s. The affirm-continue
("back to it") landing at 378s is the resume-context disease.

## Layer 2 — how he works (my memory profile)

- **Observation-first**: reports symptoms experientially, never prescribes. "Look at that" = measure → mechanism → fact.
- **Briefs by reference**: points at a working system, leaves decomposition to the lane.
- **Register**: casual, typos fine, speed over polish — but rigorous substance. State the mechanical fact, don't exhort. No artificial caps.
- **His stated needs (verbatim 07-23)**: brainstorms/tangents are FEEDSTOCK — the help = pulling real
  materials out of them; connect the dots, tell the bigger story, forecast; smarter reports; learning
  conversations where the AI actively searches + grows mid-talk; the system taking care of its own memory.
- **Reserved levers**: reboots, deletions, commits, brand, unprompted speech, resource policy.

## Drive plan implications

1. **Rapid-response matrix drills**: fire his literal top questions in his literal sequences; measure
   latency; repeat later in the run to see whether any warm path/cache emerges (hypothesis: none exists
   → design a heuristic fast-path from the results).
2. **Gap-fill drills**: start a long research job, then interleave his actual gap-fill kinds (status,
   casual, recall) WHILE it runs — tests contention + the affirm-continue resume disease (p90 171s).
3. **Brainstorm session**: statement-chain like his (angle-hunting), verify she pulls materials/sources
   actively rather than passively acking.
4. **Real work**: Hartfield & Green South report to completion; anti-China bills + sponsors sheet.
5. **Self/world-model probes**: the machine she runs on, her processes, the power grid she touches,
   what he searches vs what she searches, what's on her canvas, her own memory state.
