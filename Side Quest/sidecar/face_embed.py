"""
sidecar/face_embed.py — face EMBEDDING runner (the Puller's identity confirmation) + THE RESIDENT SERVE
MODE for the camera sense (the wants project, cut 13, 2026-09-05).

One-shot (the original): reads ONE JSON job from stdin: { "items": [ { "id", "path" | "url" | "b64" } ] }
and writes ONE JSON line: { "ok": true, "results": [ { "id", "ok", "embedding"?, "faces"?, "box"?, "kps"?,
"img"?, "det"?, "reason"? } ] }.

--serve (the camera): the model loads ONCE; then one job per stdin LINE (the same shape, plus an optional
"id" on the job) → one result line per job, flushed. A frame arrives as "b64" (a small JPEG the renderer
sampled) and is decoded IN MEMORY — no file is ever written by this process. Each result carries the
largest face's bounding box, its five keypoints and the image size, so the caller can judge whether the
face is turned to the screen and where it sits (the gaze target) without any second model.

Consume-only: it only READS what the caller supplies and returns vectors + geometry. It does NOT search,
scrape or discover, and it never stores an image. insightface's init chatter goes to stderr so stdout
stays clean JSON. buffalo_l auto-downloads once to ~/.insightface. CPU provider.
"""
import base64
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import numpy as np  # noqa: E402


def _load_image(item):
    import cv2
    if item.get("b64"):
        try:
            raw = base64.b64decode(str(item["b64"]).split(",")[-1])
        except Exception:
            return None
        return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if item.get("path"):
        return cv2.imread(item["path"])
    if item.get("url"):
        import requests
        r = requests.get(item["url"], timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            return None
        ct = r.headers.get("content-type", "")
        if "image" not in ct.lower():
            return None
        arr = np.frombuffer(r.content, np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return None


def _init_app(det_size):
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=det_size)
    return app


def _process(app, items):
    results = []
    for it in items:
        rid = it.get("id")
        try:
            img = _load_image(it)
            if img is None:
                results.append({"id": rid, "ok": False, "reason": "load-failed"})
                continue
            faces = app.get(img)
            if not faces:
                # Tightly-cropped headshot / thumbnail? The SCRFD detector needs some margin — pad and retry.
                import cv2
                pad = int(max(img.shape[:2]) * 0.5)
                faces = app.get(cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_REPLICATE))
                if faces:
                    for f in faces:   # bring the geometry back into the original frame
                        f.bbox = f.bbox - pad
                        if getattr(f, "kps", None) is not None:
                            f.kps = f.kps - pad
            if not faces:
                results.append({"id": rid, "ok": False, "reason": "no-face", "faces": 0,
                                "img": [int(img.shape[1]), int(img.shape[0])]})
                continue
            faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
            f0 = faces[0]
            emb = np.asarray(f0.normed_embedding, dtype=float).tolist()
            box = [float(v) for v in np.asarray(f0.bbox, dtype=float).tolist()]
            kps = [[float(x), float(y)] for x, y in np.asarray(f0.kps, dtype=float).tolist()] if getattr(f0, "kps", None) is not None else None
            results.append({"id": rid, "ok": True, "embedding": emb, "faces": len(faces), "box": box, "kps": kps,
                            "img": [int(img.shape[1]), int(img.shape[0])],
                            "det": float(getattr(f0, "det_score", 0.0) or 0.0)})
        except Exception as e:
            results.append({"id": rid, "ok": False, "reason": str(e)[:120]})
    return results


def _serve():
    _real = sys.stdout
    sys.stdout = sys.stderr
    try:
        app = _init_app((320, 320))   # small frames (the sampler sends 320×240); multiples of 32
    except Exception as e:
        sys.stdout = _real
        sys.stdout.write(json.dumps({"ok": False, "error": "model-init: " + str(e)[:160], "results": []}) + "\n")
        sys.stdout.flush()
        return
    sys.stdout = _real
    sys.stdout.write(json.dumps({"ok": True, "ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({"ok": False, "error": "bad job json", "results": []}) + "\n")
            sys.stdout.flush()
            continue
        _saved = sys.stdout
        sys.stdout = sys.stderr   # anything the model prints mid-job stays off the JSON stream
        try:
            results = _process(app, job.get("items", []) or [])
        finally:
            sys.stdout = _saved
        sys.stdout.write(json.dumps({"ok": True, "id": job.get("id"), "results": results}) + "\n")
        sys.stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        _serve()
        return
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception:
        sys.stdout.write(json.dumps({"ok": False, "error": "bad job json", "results": []}))
        return
    items = job.get("items", []) or []

    # model-init noise → stderr; keep stdout for the final JSON only
    _real = sys.stdout
    sys.stdout = sys.stderr
    try:
        app = _init_app((640, 640))
    except Exception as e:
        sys.stdout = _real
        sys.stdout.write(json.dumps({"ok": False, "error": "model-init: " + str(e)[:160], "results": []}))
        return
    sys.stdout = _real
    sys.stdout.write(json.dumps({"ok": True, "results": _process(app, items)}))


if __name__ == "__main__":
    main()
