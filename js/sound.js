// Tiny procedural sound: wind, carve hiss, rail grind, landing thuds.
export class Sound {
  constructor() { this.ctx = null; this.enabled = true; }

  start(enabled) {
    this.enabled = enabled;
    if (this.ctx) { this.master.gain.value = enabled ? 0.6 : 0; return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = enabled ? 0.6 : 0;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { f, g };
    };
    this.wind = loop('lowpass', 500, 0.5);
    this.carve = loop('bandpass', 2400, 0.9);
    this.rail = loop('bandpass', 3800, 6);
    this.grinding = false;
  }

  setEnabled(v) { this.enabled = v; if (this.master) this.master.gain.value = v ? 0.6 : 0; }

  update(dt, r) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const sp = r.speed;
    this.wind.g.gain.setTargetAtTime(Math.min(0.5, sp * sp * 0.0009), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + sp * 30, t, 0.1);
    const carving = r.mode === 'ground' ? Math.min(1, sp / 14) * (0.15 + Math.abs(r.lean) * 0.5 + r.brake * 0.8) : 0;
    this.carve.g.gain.setTargetAtTime(carving * 0.35, t, 0.05);
    this.rail.g.gain.setTargetAtTime(r.mode === 'rail' ? 0.18 : 0, t, 0.03);
  }

  grind() { /* handled by update */ }

  thud(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * strength + 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.4);
  }

  pop() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.15);
  }

  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [660, 990].forEach((fr, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.4);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.45);
    });
  }
}
