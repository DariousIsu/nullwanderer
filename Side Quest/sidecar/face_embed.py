"""
sidecar/face_embed.py — face EMBEDDING runner for the Puller (identity confirmation).

Reads a JSON job from stdin: { "items": [ { "id": <any>, "path": <file> | "url": <http> } ] }
For each item: loads the image, detects the largest face, returns its 512-d ArcFace NORMED embedding.
Writes ONE JSON line to stdout: { "ok": true, "results": [ { "id", "ok", "embedding"?, "faces"?, "reason"? } ] }

Consume-only: this only READS images the caller supplies (a grabbed official headshot, or a PUBLIC profile
photo the caller already found by name/handle) and returns vectors. It does NOT search, scrape, or discover.
The Node side (lib/face_match) does the cosine compare + the verify-before-promote decision.

insightface prints model-init chatter to stdout; we redirect that to stderr so stdout stays clean JSON.
buffalo_l model auto-downloads once to ~/.insightface. CPU provider (no GPU dependency).
"""
import sys
import json
import warnings
warnings.filterwarnings("ignore")
import numpy as np


def _load_image(item):
    import cv2
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


def main():
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
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(640, 640))
    except Exception as e:
        sys.stdout = _real
        sys.stdout.write(json.dumps({"ok": False, "error": "model-init: " + str(e)[:160], "results": []}))
        return
    sys.stdout = _real

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
                # Tightly-cropped headshot / thumbnail (a profile photo cropped to the face edges)? The SCRFD
                # detector needs some margin around the face — pad and retry before giving up.
                import cv2
                pad = int(max(img.shape[:2]) * 0.5)
                faces = app.get(cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_REPLICATE))
            if not faces:
                results.append({"id": rid, "ok": False, "reason": "no-face"})
                continue
            faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
            emb = np.asarray(faces[0].normed_embedding, dtype=float).tolist()
            results.append({"id": rid, "ok": True, "embedding": emb, "faces": len(faces)})
        except Exception as e:
            results.append({"id": rid, "ok": False, "reason": str(e)[:120]})

    sys.stdout.write(json.dumps({"ok": True, "results": results}))


if __name__ == "__main__":
    main()
