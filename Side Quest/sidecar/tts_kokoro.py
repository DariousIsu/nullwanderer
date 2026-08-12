"""sidecar/tts_kokoro.py — local GPU text-to-speech runner (Kokoro-82M blend), Zoe's voice.

Same NDJSON contract as sidecar/tts_piper.py, so lib/tts.js drives it identically:
  * ONE-SHOT (default): read ONE JSON job from stdin, synthesize, write ONE JSON line, exit.
  * SERVE (--serve): resident loop, one NDJSON request per line -> one NDJSON response.

Request:  { "id"?: <any>, "text": <str>, "out": <wav path>, "speed"?: <float>, "lang"?: "a"|"b" }
Response: { "id"?, "ok": true, "out", "bytes", "sampleRate" }  |  { "id"?, "ok": false, "error" }

The VOICE is a Kokoro style-vector blend read from data/voices/zoe_voice.json (weights + lang + speed),
so callers don't pass a voice model. Runs on the RX 7900 XT via native-Windows ROCm PyTorch (device 'cuda').
Consume-only / offline. Piper chatter + MIOpen notes go to stderr; the protocol stream stays clean JSON.
"""
import sys, os, json

# GPU + MIOpen env BEFORE torch import (discrete 7900 XT; persistent kernel cache; OpenMP dup-guard).
os.environ.setdefault("HIP_VISIBLE_DEVICES", "1")
os.environ.setdefault("MIOPEN_FIND_MODE", "2")
os.environ.setdefault("MIOPEN_USER_DB_PATH", os.path.expanduser(r"~\.miopen_cache"))
os.environ.setdefault("MIOPEN_CUSTOM_CACHE_DIR", os.path.expanduser(r"~\.miopen_cache"))
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import warnings
warnings.filterwarnings("ignore")

_REAL_STDOUT = sys.stdout  # responses go here; all other output -> stderr
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECIPE_PATH = os.path.join(APP_ROOT, "data", "voices", "zoe_voice.json")

_state = {"model": None, "pipes": {}, "blend": None, "recipe": None}


def _respond(obj):
    _REAL_STDOUT.write(json.dumps(obj) + "\n")
    _REAL_STDOUT.flush()


def _load_recipe():
    with open(RECIPE_PATH, "r", encoding="utf-8") as f:
        r = json.load(f)
    r.setdefault("weights", {"af_bella": 1.0})
    r.setdefault("lang", "a")
    r.setdefault("speed", 1.0)
    return r


def _ensure_model():
    if _state["model"] is not None:
        return
    import torch
    from kokoro import KModel, KPipeline
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    _state["model"] = KModel().to(dev).eval()
    recipe = _load_recipe()
    _state["recipe"] = recipe
    # a lang-agnostic pipeline just to load voice packs, then blend the style tensors
    loader = KPipeline(lang_code=recipe["lang"], model=_state["model"])
    _state["pipes"][recipe["lang"]] = loader
    w = {k: float(v) for k, v in recipe["weights"].items() if float(v) > 0}
    s = sum(w.values()) or 1.0
    blend = None
    for vid, coef in w.items():
        pack = loader.load_voice(vid)
        term = (coef / s) * pack
        blend = term if blend is None else blend + term
    _state["blend"] = blend


def _pipe(lang):
    if lang not in _state["pipes"]:
        from kokoro import KPipeline
        _state["pipes"][lang] = KPipeline(lang_code=lang, model=_state["model"])
    return _state["pipes"][lang]


def synth_one(req):
    """Synthesize one request with Zoe's blend. Never raises."""
    rid = req.get("id")
    text = (req.get("text") or "").strip()
    out = req.get("out") or ""
    if not text:
        return {"id": rid, "ok": False, "error": "empty text"}
    if not out:
        return {"id": rid, "ok": False, "error": "no out path"}
    try:
        _ensure_model()
        import torch, soundfile as sf
        recipe = _state["recipe"]
        lang = req.get("lang") or recipe["lang"]
        speed = float(req.get("speed") or recipe["speed"])
        pipe = _pipe(lang)
        chunks = [a for _, _, a in pipe(text, voice=_state["blend"], speed=speed)]
        if not chunks:
            return {"id": rid, "ok": False, "error": "no audio produced"}
        wav = torch.cat(chunks).detach().cpu().numpy()
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        sf.write(out, wav, 24000)
        size = os.path.getsize(out) if os.path.exists(out) else 0
    except Exception as e:
        return {"id": rid, "ok": False, "error": ("synthesize: " + str(e))[:200]}
    if not size:
        return {"id": rid, "ok": False, "error": "wav not written"}
    return {"id": rid, "ok": True, "out": out, "bytes": size, "sampleRate": 24000}


def serve():
    sys.stdout = sys.stderr  # keep kokoro/torch/MIOpen chatter off the protocol stream
    try:
        _ensure_model()
        # pre-warm 2 shapes so the first real utterance doesn't pay MIOpen autotune
        pipe = _pipe(_state["recipe"]["lang"])
        for _ in pipe("Warming up.", voice=_state["blend"], speed=_state["recipe"]["speed"]):
            pass
        for _ in pipe("This is a slightly longer warm up pass for kernel autotuning.",
                      voice=_state["blend"], speed=_state["recipe"]["speed"]):
            pass
    except Exception as e:
        _respond({"ok": True, "ready": True, "warn": ("warmup: " + str(e))[:160]})
    else:
        _respond({"ok": True, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            _respond({"ok": False, "error": "bad request json"})
            continue
        _respond(synth_one(req))


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception:
        _respond({"ok": False, "error": "bad job json"})
        return
    sys.stdout = sys.stderr
    _respond(synth_one(job))


if __name__ == "__main__":
    main()
