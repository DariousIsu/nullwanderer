"""
sidecar/motion/extract_motion.py — extract WHITE-LABEL locomotion from any video.

Runs MediaPipe Pose over a video and emits a de-identified motion asset: per-frame body landmarks,
normalized to be identity- and scale-agnostic (hip-centered, torso-scaled) so the SAME motion can drive
ANY avatar — a clone, Zoe, or a from-scratch character. No pixels of the source person are kept; only
the skeleton trajectory. That is what makes it "white label": it captures HOW a body moves, not WHO.

Native Windows, CPU, pure pip (mediapipe/opencv) — no ROCm, no GPU, no patch-arounds.

  in : argv JSON { "video": path, "out_json": path, "out_preview": path|null }
  out: one JSON line { "ok": true, "frames": n, "fps": f, "out_json": path, "out_preview": path|null }
"""
import sys, json, math, traceback

def main():
    try:
        req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad request: {e}"})); return
    try:
        import os, cv2, numpy as np, mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision
        video = req["video"]; out_json = req["out_json"]; out_preview = req.get("out_preview")

        # standard MediaPipe 33-point pose skeleton connections (solutions.POSE_CONNECTIONS is gone in 1.x)
        conns = [(0,1),(1,2),(2,3),(3,7),(0,4),(4,5),(5,6),(6,8),(9,10),(11,12),(11,13),(13,15),
                 (15,17),(15,19),(15,21),(17,19),(12,14),(14,16),(16,18),(16,20),(16,22),(18,20),
                 (11,23),(12,24),(23,24),(23,25),(24,26),(25,27),(26,28),(27,29),(28,30),(29,31),(30,32),(27,31),(28,32)]

        cap = cv2.VideoCapture(video)
        if not cap.isOpened():
            print(json.dumps({"ok": False, "error": f"cannot open video: {video}"})); return
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pose_landmarker.task")
        opts = mp_vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=model_path),
            running_mode=mp_vision.RunningMode.VIDEO)
        landmarker = mp_vision.PoseLandmarker.create_from_options(opts)

        writer = None
        if out_preview:
            # the preview renders the WHITE-LABEL skeleton on a blank ground — no source pixels, proof of de-identification
            writer = cv2.VideoWriter(out_preview, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))

        frames = []
        n = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            res = landmarker.detect_for_video(mp_img, int(n * 1000.0 / fps))
            if res.pose_landmarks:
                lm = res.pose_landmarks[0]
                pts = [(p.x, p.y, p.z, p.visibility) for p in lm]
                # normalize: center on mid-hip (23,24), scale by shoulder->hip torso length → identity/scale-free
                lhip, rhip, lsh, rsh = pts[23], pts[24], pts[11], pts[12]
                cx, cy = (lhip[0] + rhip[0]) / 2, (lhip[1] + rhip[1]) / 2
                torso = math.hypot(((lsh[0] + rsh[0]) / 2) - cx, ((lsh[1] + rsh[1]) / 2) - cy) or 1e-3
                norm = [[(x - cx) / torso, (y - cy) / torso, z / torso, v] for (x, y, z, v) in pts]
                frames.append(norm)
                if writer is not None:
                    canvas = np.zeros((H, W, 3), dtype=np.uint8)
                    px = [(int(x * W), int(y * H)) for (x, y, z, v) in pts]
                    for a, b in conns:
                        cv2.line(canvas, px[a], px[b], (106, 134, 182), 2)
                    for (x, y) in px:
                        cv2.circle(canvas, (x, y), 3, (230, 230, 235), -1)
                    writer.write(canvas)
            elif writer is not None:
                writer.write(np.zeros((H, W, 3), dtype=np.uint8))
            n += 1
        cap.release()
        if writer is not None:
            writer.release()
        landmarker.close()

        asset = {
            "format": "mediapipe-pose-33/normalized-hipcenter-torsoscale",
            "identity_stripped": True,
            "fps": fps, "source_w": W, "source_h": H,
            "frame_count": len(frames), "landmarks_per_frame": 33,
            "frames": frames,
        }
        with open(out_json, "w") as f:
            json.dump(asset, f)
        print(json.dumps({"ok": True, "frames": len(frames), "fps": fps, "out_json": out_json, "out_preview": out_preview}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{e}", "trace": traceback.format_exc()[-800:]}))

if __name__ == "__main__":
    main()
