"""Local Kokoro Voice Tuner — a GPU-backed blend studio.

Loads Kokoro-82M once onto the RX 7900 XT (ROCm) and serves a small web UI where
you mix voice style-vectors live (sliders), pick accent + speed, type any line, and
hear it instantly. When a blend is "her", copy the recipe — it bakes straight into
the app as a 256-dim voice vector.

Run (env pins the discrete GPU + persistent MIOpen cache):
  HIP_VISIBLE_DEVICES=1 MIOPEN_FIND_MODE=2 \
  MIOPEN_USER_DB_PATH=C:/Users/azrae/.miopen_cache MIOPEN_CUSTOM_CACHE_DIR=C:/Users/azrae/.miopen_cache \
  sidecar/tts_kokoro_venv/Scripts/python.exe sidecar/kokoro_tuner_server.py
Then open http://127.0.0.1:8199  (loopback only).
"""
import io, json, sys, threading, time, wave, gc, os
import numpy as np
import torch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from kokoro import KModel, KPipeline

PORT = 8199
# THE CONSOLIDATION (2026-09-01, RAM lever 3): this server is the ONE resident Kokoro on the box.
# A /synth request WITHOUT weights defaults to Zoe's saved blend (data/voices/zoe_voice.json), so
# lib/tts.js speaks through the tuner instead of each consumer holding its own ~3GB stdio child.
# The recipe is re-read when its mtime changes — a re-tuned voice lands without a restart.
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECIPE_PATH = os.path.join(APP_ROOT, "data", "voices", "zoe_voice.json")
_recipe_cache = {"mtime": 0.0, "recipe": None}


def _zoe_recipe():
    """Load (and mtime-cache) the saved voice recipe; None when absent/unreadable (fail-absent)."""
    try:
        mtime = os.path.getmtime(RECIPE_PATH)
        if _recipe_cache["recipe"] is None or mtime != _recipe_cache["mtime"]:
            with open(RECIPE_PATH, encoding="utf-8") as f:
                r = json.load(f)
            r.setdefault("weights", {"af_bella": 1.0})
            r.setdefault("lang", "a")
            r.setdefault("speed", 1.0)
            _recipe_cache.update(mtime=mtime, recipe=r)
        return _recipe_cache["recipe"]
    except OSError:
        return None
    except ValueError:
        return None
# Female voices worth blending (a=American, b=British). label -> (voice_id, lang)
VOICES = [
    ("Bella (Am, warm)",      "af_bella",    "a"),
    ("Nicole (Am, soft)",     "af_nicole",   "a"),
    ("Sarah (Am, bright)",    "af_sarah",    "a"),
    ("Aoede (Am, mellow)",    "af_aoede",    "a"),
    ("Heart (Am, neutral)",   "af_heart",    "a"),
    ("Kore (Am)",             "af_kore",     "a"),
    ("Nova (Am)",             "af_nova",     "a"),
    ("River (Am)",            "af_river",    "a"),
    ("Isabella (Br)",         "bf_isabella", "b"),
    ("Alice (Br, light)",     "bf_alice",    "b"),
    ("Emma (Br)",             "bf_emma",     "b"),
    ("Lily (Br)",             "bf_lily",     "b"),
]
DEFAULT_TEXT = ("Oh, that's brilliant, I found exactly what you were looking for. "
                "Give me a moment... okay, here's what I think we should do next.")

_lock = threading.Lock()
_model = None
_pipes = {}          # lang_code -> KPipeline
_packs = {}          # voice_id -> style tensor [510,1,256]
_loaded = False
_last_use = 0.0
# ON-DEMAND: hold the GPU only while in use. Load Kokoro on the first synth, free it after this many
# idle seconds so video renders get the full GPU. First synth after a (re)load pays a one-time autotune
# (cached in MIOPEN_USER_DB_PATH); subsequent calls are instant.
IDLE_S = float(os.environ.get("ZOE_TUNER_IDLE_S", "90"))


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


def _load():
    """Load Kokoro + voice packs onto the GPU. Idempotent (guarded by _loaded). Call under _lock."""
    global _model, _loaded
    if _loaded:
        return
    _log("[tuner] loading Kokoro onto GPU (on demand)...")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    _model = KModel().to(dev).eval()
    for lang in ("a", "b"):
        _pipes[lang] = KPipeline(lang_code=lang, model=_model)
    for _, vid, _l in VOICES:
        try:
            _packs[vid] = _pipes["a"].load_voice(vid)
        except Exception as e:
            _log(f"[tuner] WARN load {vid}: {e!r}")
    _loaded = True
    _log(f"[tuner] model on {dev} — loaded")


def _unload():
    """Free Kokoro from the GPU so a video render gets the VRAM back. Call under _lock."""
    global _model, _loaded
    if not _loaded:
        return
    _pipes.clear(); _packs.clear(); _model = None; _loaded = False
    gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    _log("[tuner] idle — model unloaded, GPU freed")


def _idle_watcher():
    """Unload the model after IDLE_S of no synth, so the tuner can stay up without holding VRAM."""
    while True:
        time.sleep(15)
        try:
            with _lock:
                if _loaded and _last_use and (time.time() - _last_use) > IDLE_S:
                    _unload()
        except Exception as e:
            _log(f"[tuner] idle watcher note: {e!r}")


def _blend(weights):
    """weights: {voice_id: float}. Returns normalized weighted-sum style tensor, or None."""
    items = [(vid, float(w)) for vid, w in weights.items() if float(w) > 0 and vid in _packs]
    if not items:
        return None
    s = sum(w for _, w in items) or 1.0
    out = None
    for vid, w in items:
        term = (w / s) * _packs[vid]
        out = term if out is None else out + term
    return out


def _synth(text, weights, lang, speed):
    global _last_use
    _load()                 # lazy: bring Kokoro onto the GPU if it isn't already (under _lock via do_POST)
    _last_use = time.time()
    v = _blend(weights)
    if v is None:
        raise ValueError("no voices selected")
    pipe = _pipes.get(lang, _pipes["a"])
    t0 = time.perf_counter()
    chunks = [a for _, _, a in pipe(text, voice=v, speed=float(speed))]
    wav = torch.cat(chunks).detach().cpu().numpy()
    dt = time.perf_counter() - t0
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(24000)
        wf.writeframes((np.clip(wav, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue(), dt, len(wav) / 24000


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
        elif self.path == "/voices":
            self._send(200, json.dumps([{"label": l, "id": v, "lang": lg} for l, v, lg in VOICES]).encode(), "application/json")
        elif self.path == "/status":
            self._send(200, json.dumps({"loaded": _loaded, "idle_s": IDLE_S,
                                        "since_use_s": round(time.time() - _last_use, 1) if _last_use else None}).encode(), "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path != "/synth":
            return self._send(404, b"not found", "text/plain")
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        text = (req.get("text") or DEFAULT_TEXT).strip()[:800]
        weights = req.get("weights") or {}
        lang = req.get("lang")
        speed = req.get("speed")
        if not weights:
            # no explicit blend → Zoe's saved recipe (the consolidation default); request fields win
            rc = _zoe_recipe()
            if rc:
                weights = rc["weights"]
                lang = lang or rc["lang"]
                speed = speed or rc["speed"]
        lang = lang or "a"
        speed = speed or 1.0
        try:
            with _lock:
                audio, dt, secs = _synth(text, weights, lang, speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("X-Compute-Ms", str(round(dt * 1000)))
            self.send_header("X-Audio-Secs", str(round(secs, 2)))
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as e:
            self._send(500, json.dumps({"error": repr(e)}).encode(), "application/json")


PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice Tuner</title><style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1a1a1e;--mut:#6b6b76;--line:#e4e4e8;--acc:#6c5ce7;--acc2:#00b894}
@media(prefers-color-scheme:dark){:root{--bg:#151519;--card:#1e1e24;--fg:#ececf1;--mut:#9a9aa6;--line:#2c2c34;--acc:#a29bfe;--acc2:#55efc4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--mut);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.row{display:flex;align-items:center;gap:12px;margin:9px 0}
.row label{width:150px;font-size:13px;flex:none}
.row input[type=range]{flex:1;accent-color:var(--acc)}
.row .val{width:44px;text-align:right;font-variant-numeric:tabular-nums;color:var(--mut);font-size:13px}
textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);padding:10px;font:inherit;resize:vertical}
.opts{display:flex;gap:20px;flex-wrap:wrap;align-items:center;margin-top:10px}
.opts .grp{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mut)}
button{border:0;border-radius:10px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
.speak{background:var(--acc);color:#fff;font-size:16px;padding:12px 26px}
.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
.presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.presets button{background:transparent;border:1px solid var(--line);color:var(--fg);font-size:12px;padding:6px 11px;font-weight:500}
.recipe{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mut);background:var(--bg);border:1px dashed var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word}
.stat{color:var(--acc2);font-size:13px;font-weight:600;min-height:18px}
.hint{color:var(--mut);font-size:12px}
</style></head><body><div class="wrap">
<h1>Voice Tuner <span style="color:var(--mut);font-weight:400;font-size:14px">· Kokoro on the 7900 XT</span></h1>
<p class="sub">Mix the voices, pick accent + speed, type a line, hit Speak. When it's her, copy the recipe.</p>

<div class="card">
  <div class="presets" id="presets"></div>
  <div id="sliders"></div>
</div>

<div class="card">
  <textarea id="text"></textarea>
  <div class="opts">
    <div class="grp">Accent:
      <label><input type="radio" name="acc" value="a" checked> American</label>
      <label><input type="radio" name="acc" value="b"> British</label>
    </div>
    <div class="grp">Speed <input type="range" id="speed" min="0.7" max="1.25" step="0.01" value="1.0" style="width:120px;accent-color:var(--acc)"> <span class="val" id="speedv">1.00</span></div>
    <button class="speak" id="speak">▶ Speak</button>
    <button class="ghost" id="dl">⤓ Save wav</button>
    <span class="stat" id="stat"></span>
  </div>
  <p class="hint">First click on a new length may pause a few seconds (one-time GPU kernel tune); after that it's instant.</p>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <strong style="font-size:13px">Recipe</strong>
    <button class="ghost" id="copy" style="font-size:12px;padding:6px 12px">Copy recipe</button>
  </div>
  <div class="recipe" id="recipe"></div>
</div>

<audio id="player" style="display:none"></audio>
</div>
<script>
const PRESETS = {
  "Your spec (45/40/15)": {af_bella:45, bf_isabella:40, af_nicole:15},
  "Less rasp (50/40/10)": {af_bella:50, bf_isabella:40, af_nicole:10},
  "British lean (40/45/15)": {af_bella:40, bf_isabella:45, af_nicole:15},
  "Bella only": {af_bella:100},
};
let VOICES=[], lastBlob=null;
const $=s=>document.querySelector(s);
async function init(){
  VOICES = await (await fetch('/voices')).json();
  const sc=$('#sliders');
  for(const v of VOICES){
    const def = (v.id==='af_bella')?45:(v.id==='bf_isabella')?40:(v.id==='af_nicole')?15:0;
    const row=document.createElement('div');row.className='row';
    row.innerHTML=`<label>${v.label}</label><input type="range" min="0" max="100" step="1" value="${def}" data-id="${v.id}"><span class="val"></span>`;
    sc.appendChild(row);
    const r=row.querySelector('input'), val=row.querySelector('.val');
    val.textContent=def; r.oninput=()=>{val.textContent=r.value;recipe();};
  }
  const pc=$('#presets');
  for(const [name,w] of Object.entries(PRESETS)){
    const b=document.createElement('button');b.textContent=name;
    b.onclick=()=>{applyPreset(w);};pc.appendChild(b);
  }
  $('#text').value = "Oh, that's brilliant, I found exactly what you were looking for. Give me a moment... okay, here's what I think we should do next.";
  $('#speed').oninput=()=>{$('#speedv').textContent=(+$('#speed').value).toFixed(2);recipe();};
  document.querySelectorAll('input[name=acc]').forEach(x=>x.onchange=recipe);
  $('#speak').onclick=speak;$('#dl').onclick=()=>{if(lastBlob){const a=document.createElement('a');a.href=URL.createObjectURL(lastBlob);a.download='voice.wav';a.click();}};
  $('#copy').onclick=()=>{navigator.clipboard.writeText($('#recipe').textContent);$('#copy').textContent='Copied!';setTimeout(()=>$('#copy').textContent='Copy recipe',1200);};
  recipe();
}
function applyPreset(w){
  document.querySelectorAll('#sliders input').forEach(r=>{const v=w[r.dataset.id]||0;r.value=v;r.nextElementSibling.textContent=v;});
  recipe();
}
function weights(){const o={};document.querySelectorAll('#sliders input').forEach(r=>{if(+r.value>0)o[r.dataset.id]=+r.value;});return o;}
function acc(){return document.querySelector('input[name=acc]:checked').value;}
function recipe(){
  const w=weights(),s=Object.values(w).reduce((a,b)=>a+b,0)||1;
  const norm=Object.entries(w).map(([k,v])=>`${k}:${(v/s).toFixed(3)}`).join('  ');
  $('#recipe').textContent=`voices: ${norm||'(none)'}\naccent: ${acc()==='a'?'American':'British'}   speed: ${(+$('#speed').value).toFixed(2)}`;
}
async function speak(){
  const b=$('#speak');b.disabled=true;$('#stat').textContent='synthesizing…';
  try{
    const t0=performance.now();
    const res=await fetch('/synth',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:$('#text').value,weights:weights(),lang:acc(),speed:+$('#speed').value})});
    if(!res.ok){$('#stat').textContent='error: '+(await res.text());return;}
    lastBlob=await res.blob();
    const ms=res.headers.get('X-Compute-Ms'),sec=res.headers.get('X-Audio-Secs');
    const p=$('#player');p.src=URL.createObjectURL(lastBlob);await p.play();
    $('#stat').textContent=`${ms}ms compute · ${sec}s audio · ${(performance.now()-t0|0)}ms round-trip`;
  }catch(e){$('#stat').textContent='error: '+e;}finally{b.disabled=false;}
}
init();
</script></body></html>"""


def main():
    threading.Thread(target=_idle_watcher, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    _log(f"[tuner] READY (on-demand) on http://127.0.0.1:{PORT} — model loads on first Speak, "
         f"frees after {int(IDLE_S)}s idle. device={'cuda' if torch.cuda.is_available() else 'cpu'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
