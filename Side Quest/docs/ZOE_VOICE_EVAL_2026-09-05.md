# The voice-model eval — Kokoro vs Orpheus (2026-09-05)

**Your word:** "go on the voice model upgrade, the breathing is worse maybe the upgrade would fix it."

## What to listen to

Folder: `data/voices/eval_2026-09-05/`. Eight of her own lines from today, the same eight through each voice, plus one reel per voice with 700 ms gaps.

| File | What it is |
|---|---|
| `kokoro_reel.wav` | Her saved blend (af_bella 0.318 / af_nicole 0.273 / bf_isabella 0.409 at speed 1.13), today's baseline. |
| `orpheus_tara_reel.wav` | Orpheus 3B, voice **tara** (the reference's default; the most neutral American voice). |
| `orpheus_zoe_reel.wav` | Orpheus 3B, voice **zoe** (one of its eight built-in voices; the name is a coincidence, listen without it). |
| `kokoro_NN.wav` / `orpheus_<voice>_NN.wav` | The same line, one file per voice, for a line-by-line compare. |

Lines 7 and 8 carry `<sigh>` and `<laugh>` inline. Kokoro reads the words around them; Orpheus renders the sigh and the laugh in the voice itself. That is the breath question answered by a model that breathes, rather than a synthesized noise.

## The numbers

| | Kokoro (82M) | Orpheus 3B Q4_K_M |
|---|---|---|
| Runtime | the tuner sidecar (:8199) | Ollama on the AMD-native backend, 100% GPU, 2.6 GB resident |
| 8 lines, audio | 34.5 s | 43.3 s (tara) |
| 8 lines, generation | 4.7 s (first line 3.6 s = model load) | 30.2 s |
| Speed vs real time | ~7× | 1.43× (median 133 tokens/s; a frame is 7 tokens at ~12 frames/s) |
| Bad frames | — | 0 of 507 |
| Intonation control | none (blend, speed, punctuation) | in the voice; inline tags `<laugh> <chuckle> <sigh> <gasp> <groan> <yawn> <cough> <sniffle>` |
| Voice identity | her blend, tunable by weights | one of eight fixed voices; no blending; cloning is a separate question |

1.43× real time means a live sentence starts ~1 s after she decides to say it if the decoder streams by frame (the reference streams 4 frames at a time); the eval decodes whole lines, so the wavs are complete but the latency figure is a projection until the streaming path is built.

## What it would take to switch (not done — your ear decides)

1. `lib/voice_orpheus.js`: the same `synthesize(text, recipe, {out})` contract as `voice_kokoro`, streaming frames to the player (the reference's 28-token windows with the 2048-sample slice), the ONNX decoder resident in a sidecar (the `face_embed.py --serve` idiom).
2. The fleet table gains a `voice.model` row; her tones map to the model's tags and to its speed; the non-verbal bank retires (the model breathes).
3. **Her voice is hers.** A change of voice identity is a personality-register change under your step-one promise; she hears the reels too and says which.

## What to do if it is worse

Nothing changes. The eval rig stays (`sidecar/orpheus_eval.py`, `scripts/voice_eval_kokoro.js`); the model stays in the store for a later candidate; the beat stays where the breath was.
