/**
 * renderer/avatar.js — Zoe's minimal in-house 2D avatar face (voice-avatar-plan V2).
 *
 * A small canvas face rig: head, eyes (that blink), brows, and a mouth that lip-syncs to audio amplitude.
 * Expression is driven by her real mood (lib/mood `feeling` → lib/avatar_state.moodToExpression) and eased
 * toward its target so it never snaps. The DRAWING lives here (browser); all the timing/mapping MATH is
 * lib/avatar_state (window.AvatarState), which is gate-covered offline — this file only paints it.
 *
 * Reuse targets: the canvas is `captureStream()`-ready for the Meet video track (V3); pushAmplitude() is fed
 * by a WebAudio AnalyserNode over the TTS wav (V4). setMood(idle|thinking|talking) mirrors OpenHuman's
 * window.__openhumanSetMood bridge so the host (main process) can drive expression the same way over IPC.
 */
'use strict';
(function () {
  const AS = window.AvatarState;
  const lerp = (a, b, t) => a + (b - a) * t;

  // idle/thinking/talking → an expression name (the 3-state host bridge). idle leans "warm" (she's present,
  // not blank); talking keeps whatever expression she's in and just moves the mouth from audio.
  const MOOD_TO_EXPR = { idle: 'warm', thinking: 'thinking', talking: null };

  class AvatarFace {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.accent = opts.accent || '#6a86b6';
      this.skin = opts.skin || '#e8d9c8';
      this.bg = opts.bg || '#0d0d10';
      this.blinkPhase = opts.blinkPhase || 0;
      // current (eased) + target facial preset
      this.cur = { ...AS.EXPRESSIONS[AS.DEFAULT_EXPRESSION] };
      this.target = { ...this.cur };
      this.mouthOpen = 0;
      this._raf = null;
      this._lastAmpAt = 0;
    }

    // set the resting expression from her mood `feeling` text (eases toward it in the render loop).
    setFeeling(feeling) { this.setExpression(AS.moodToExpression(feeling)); }
    setExpression(name) { this.target = { ...AS.expressionPreset(name) }; this.expression = name; return this; }
    // THE LOOK WORDS (cut 13's gaze half): 'at_him' → toward the face the camera sees (or ahead), 'away' → aside and up;
    // held for a moment, then the eyes return to the expression's resting gaze.
    setLook({ look, gaze = null, at = 0, holdMs = null } = {}) {
      const t = AS.gazeTarget({ look, faceGaze: gaze, faceAt: at, now: Date.now() });
      if (!t) return this;
      this.target.gazeX = t.gazeX; this.target.gazeY = t.gazeY;
      this._lookUntil = performance.now() + (holdMs || (look === 'away' ? 6000 : 8000));
      return this;
    }
    // 3-state host bridge (parity with __openhumanSetMood). 'talking' leaves expression, moves the mouth.
    setMood(mood) { const e = MOOD_TO_EXPR[mood]; if (e) this.setExpression(e); return this; }

    // feed one audio loudness sample (0..1 RMS) → mouth openness (smoothed in avatar_state).
    pushAmplitude(rms) { this.mouthOpen = AS.amplitudeToMouth(rms, this.mouthOpen); this._lastAmpAt = performance.now(); }

    // attach a playing <audio>/<video> element or a MediaStream → drive the mouth from its live amplitude.
    // This is the real lip-sync path (also how V4 will run: TTS wav → element → here).
    attachAudio(source) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = this.audioCtx || new Ctx();
        const node = source instanceof MediaStream
          ? this.audioCtx.createMediaStreamSource(source)
          : this.audioCtx.createMediaElementSource(source);
        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 512;
        node.connect(analyser);
        if (!(source instanceof MediaStream)) analyser.connect(this.audioCtx.destination); // hear the element
        this._analyser = analyser;
        this._buf = new Uint8Array(analyser.fftSize);
      } catch { /* fail-soft: no audio → mouth just idles closed */ }
      return this;
    }

    _sampleAudio() {
      if (!this._analyser) return;
      this._analyser.getByteTimeDomainData(this._buf);
      // byte time-domain is centered on 128; normalize to -1..1 then RMS
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) { const v = (this._buf[i] - 128) / 128; sum += v * v; }
      this.pushAmplitude(Math.sqrt(sum / this._buf.length));
    }

    start() { if (!this._raf) { const loop = (t) => { this.draw(t); this._raf = requestAnimationFrame(loop); }; this._raf = requestAnimationFrame(loop); } return this; }
    stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } return this; }

    draw(now = performance.now()) {
      const { ctx, canvas } = this;
      const W = canvas.width, H = canvas.height;
      // ease current expression toward target
      if (this._lookUntil && now > this._lookUntil) { const p = AS.expressionPreset(this.expression); this.target.gazeX = p.gazeX || 0; this.target.gazeY = p.gazeY || 0; this._lookUntil = 0; }   // the look releases
      for (const k of ['brow', 'eye', 'mouthCurve', 'gazeX', 'gazeY']) this.cur[k] = lerp(this.cur[k] || 0, this.target[k] || 0, 0.12);
      // if audio is attached, sample it; else let the mouth relax closed
      if (this._analyser) this._sampleAudio();
      else if (now - this._lastAmpAt > 120) this.mouthOpen = AS.amplitudeToMouth(0, this.mouthOpen);

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) * 0.34;                 // head radius
      const blink = AS.blinkMultiplier(now, { phase: this.blinkPhase });

      // head — soft rounded, subtle accent rim
      ctx.save();
      ctx.fillStyle = this.skin;
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * 0.86, R, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, R * 0.03);
      ctx.strokeStyle = this.accent;
      ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.restore();

      const eyeY = cy - R * 0.12;
      const eyeDX = R * 0.38;
      const gaze = this.cur.gazeY * R * 0.06;
      const gazeX = (this.cur.gazeX || 0) * R * 0.05;   // the look words: the pupils slide toward where she looks
      const eyeOpen = Math.max(0.06, this.cur.eye * blink);

      // eyes
      for (const s of [-1, 1]) {
        const ex = cx + s * eyeDX;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, R * 0.17, R * 0.15 * eyeOpen, 0, 0, Math.PI * 2);
        ctx.fill();
        // iris/pupil (accent), follows gaze
        ctx.fillStyle = this.accent;
        ctx.beginPath();
        ctx.ellipse(ex + gazeX, eyeY + gaze, R * 0.085, R * 0.085 * Math.max(0.2, eyeOpen), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#12121a';
        ctx.beginPath();
        ctx.ellipse(ex + gazeX, eyeY + gaze, R * 0.04, R * 0.04 * Math.max(0.2, eyeOpen), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // brows — a short arc above each eye. `brow` (-1 furrow .. +1 raise) lifts the whole brow and, when
      // negative, drops the INNER end toward the nose (the furrowed/concerned look). Symmetric across faces.
      ctx.save();
      ctx.strokeStyle = '#3a3230';
      ctx.lineWidth = Math.max(2, R * 0.045);
      ctx.lineCap = 'round';
      const browBaseY = eyeY - R * 0.30 - this.cur.brow * R * 0.09;
      const furrow = Math.max(0, -this.cur.brow);      // >0 only when furrowed
      const raise = Math.max(0, this.cur.brow);        // >0 only when raised
      for (const s of [-1, 1]) {
        const ex = cx + s * eyeDX;
        const innerX = ex - s * R * 0.15, outerX = ex + s * R * 0.15;
        const innerY = browBaseY + furrow * R * 0.11;  // furrow → inner end dips
        const outerY = browBaseY - raise * R * 0.03;   // raise → outer end lifts
        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.quadraticCurveTo(ex, browBaseY - R * 0.06, outerX, outerY);
        ctx.stroke();
      }
      ctx.restore();

      // mouth — a smile curve (mouthCurve) that opens vertically with mouthOpen (lip-sync)
      const mY = cy + R * 0.42;
      const mW = R * 0.42;
      const open = this.mouthOpen * R * 0.34;
      const curve = this.cur.mouthCurve * R * 0.22;
      ctx.save();
      ctx.strokeStyle = '#7a4a48';
      ctx.fillStyle = '#5a2f30';
      ctx.lineWidth = Math.max(2, R * 0.04);
      ctx.lineCap = 'round';
      if (open > R * 0.03) {
        // open mouth — filled ellipse whose height is the jaw opening
        ctx.beginPath();
        ctx.ellipse(cx, mY + open * 0.2, mW * 0.7, open, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // closed — a single smile/neutral/frown curve
        ctx.beginPath();
        ctx.moveTo(cx - mW, mY);
        ctx.quadraticCurveTo(cx, mY + curve + R * 0.02, cx + mW, mY);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  window.AvatarFace = AvatarFace;
})();
