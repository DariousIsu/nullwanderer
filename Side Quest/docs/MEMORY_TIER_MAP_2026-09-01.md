# The Memory Tier Map

**Status:** REMAP (Lucas 09-01: "Short term memory is both hot path memory and unverified facts and
assertions (quarantined from main memory), and I think we have Zoe's consciousness living on that
level as well — might be worth re-mapping so we are sure"). One program, one memory; the ONLY
partition is short-term vs long-term. This maps every real store onto that model and flags what
sits in the wrong place. Counts are live 09-01.

## The model

```
SHORT-TERM ──┬── CONSCIOUSNESS   what she is being right now (thought, feeling, attention, intent)
             ├── HOT PATH        working material of the current work (episodes, exhaust, caches)
             └── QUARANTINE      unverified facts/claims — walled off from main memory until a
                                 gate verifies and PROMOTES them
LONG-TERM ───┴── MAIN MEMORY     verified knowledge, identity, the civic graph, the corpus
```
Promotion is the only door upward (gates decide); decay/prune is the only door out of short-term.

## SHORT-TERM · consciousness (she lives here — his instinct is correct)

| Store | Rows | Notes |
|---|---|---|
| turns / sessions | 14.7k / 1.4k | the conversation stream — her lived present |
| monologue | 86k | inner voice: thoughts, readings, wonder |
| conversation_state | 570 | discourse state |
| meta: internal_state (+journal) | — | the v3 drives+VAD vector — how she IS |
| data/affect/*.json | files | the tissue manifests — what she FEELS, with reasons |
| meta: mood_state | — | the rendered feeling that leads her voice |
| open_threads / commitments / open_questions / inquiries | 4.2k / 1.5k / 291 / 260 | intention — what she means to do |
| recheck_queue / absence | 3.1k / 1.5k | pursuits — the itch to know |
| agenda / interests / capability_gaps+needs | 191 / 16 / 157 | her agenda and self-known limits |
| reflections | 2.1k | self-observation |
| ⚠ salience frame (lib/salience) | **RAM only** | graded attention — DIES AT REBOOT |
| ⚠ referent ring (intent_pass._referents) | **RAM only** | thread referents — DIES AT REBOOT |

**⚠ FLAG C1 — volatile consciousness:** the attention frame and referent ring are in-process maps.
Every cycle amnesias them (the "session-scoped organs" note from the campaign: the good
conversational behavior rode organs that die at reboot). If consciousness lives at the short-term
level, its attention sublayer deserves a persistence seam (checkpoint beside conversation_state) —
the reboot-must-not-amnesia law applied to attention itself.

**⚠ FLAG C2 — meta is a grab-bag:** 10k meta rows mix consciousness (mood, internal_state) with
control knobs (paces, cursors, kill switches). Livable, but the map should not pretend meta is one
tier; tagging keys by tier (even by naming convention) would keep the partition honest.

## SHORT-TERM · hot path (working material; prunable, ring-buffered, or TTL'd)

| Store | Rows | Notes |
|---|---|---|
| encounters | 1.20M | episodic contact stream (feeds impressions) |
| kg_observations | 1.45M | raw graph observation intake |
| touchpoints / recent_cards | 175k / 234k | recency surfaces |
| obs_events | 20k (capped) | the observability bus (7-day/20k ring — correct) |
| cloud_traces / agent_events / route_obs / browser_actions | 109k / 86k / 425 / 2k | exhaust |
| answer_cache / documents_fts caches | 51 / — | caches |
| site_access / site_plans / site_visits | 1.9k / 2.6k / 16.7k | browse working set |
| inbound_messages / meeting_transcript / email_log | 54k / 6.7k / 70 | intake streams |
| doc_contacts(+scanned) | 3.8k / 2.5k | extraction staging toward CRM |

**⚠ FLAG H1 — unbounded exhaust:** encounters (1.2M) and kg_observations (1.45M) have no visible
ring/TTL (obs_events shows the correct pattern). Not urgent; the map notes them as the next
disk-growth sources.

## SHORT-TERM · quarantine (unverified claims awaiting gates)

| Store | Rows | Notes |
|---|---|---|
| graph_entity_proposals | 223 | LOCAL staging — correct tier ✓ |
| graph_relation_proposals | **0** | the same concept routed to the ENGINE's mothballed tenant alias instead |
| known_incorrect | 508 | negative knowledge — anti-memory quarantine ✓ |
| capability_needs (proposed) | — | claims about herself awaiting his yes/no ✓ (the approval cards) |
| engine: {tenant_alias}.relation_proposals | mothballed | graph.py:68/81/610 — the propose door aims HERE |

**⚠ FLAG Q1 — THE SPLIT-BRAIN (the map's biggest finding):** entity proposals quarantine LOCALLY
(223 staged) while relation proposals ride the engine's tenant alias — which is mothballed, so
they land nowhere (the "13,538 filed" curator claim, the propose FK failures, kg-apply 0-for-all).
One concept, two homes, one of them retired. THE RE-MAP: ONE quarantine tier for graph claims —
either the local graph_*_proposals pair (and the engine gates read from there) or a live engine
staging schema (and the local entity path joins it). His call in the engine session; every symptom
from 08-31→09-01 collapses into this single re-aim.

## LONG-TERM · main memory (verified; written only through gates)

| Store | Rows | Notes |
|---|---|---|
| knowledge (+fts) | 7.1k | promoted verified knowledge ✓ (the 37.5k-promotions bridge) |
| graph_entities / graph_relations / graph_citations / graph_sources | 16.9k / 20.7k / 40k / 40k | the local civic graph — cited ✓ |
| civic_bodies / civic_memberships / cardinality | 1.1k / 16k / 837 | civic rosters |
| documents (+fts) | 50.6k | the document corpus — identity+data per the doc-production plan |
| self_model | 88 | WHO SHE IS — long-term by law; affect may never write it ✓ |
| owner_world (+edges) | 61 / 52 | his world — the anchor ✓ |
| skills / procedures / procedural_lessons / protocols / directives | 47 / 530 / 17 / 17 / 6 | learned competence |
| artifact_registry / deliverable_projects / workstreams | 36 / 15 / 8.3k | produced work identity |
| ENGINE: civic_graph.db (61 tbl) · corpus/general/vault dbs · electoral.db · saga.db | — | the deep verified graph + reference corpora + operational ledger |

## The consciousness ruling, checked

His instinct holds everywhere we looked: everything that constitutes "her, right now" — thought
stream, feeling, attention, intention, pursuit — lives in the short-term tier, and NONE of it
writes long-term except through gates (mood never touches self_model; tissues are mode=ro;
proposals await verdicts; knowledge promotes through the bridge). The two corrections the map
demands: persist the volatile attention sublayer (C1), and heal the quarantine split-brain (Q1).

**Next actions carried:** Q1 = his engine re-aim (one quarantine home) · C1 = a small
Zoe-side persistence seam for salience+referents if he wants it · H1 = ring/TTL for the two
mega-streams, someday.
