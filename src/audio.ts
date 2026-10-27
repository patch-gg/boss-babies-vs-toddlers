import { clock } from "./util";
// Audio bus. Every sound is synthesised with WebAudio by default.
// Drop an mp3 at public/sfx/<name>.mp3 (e.g. fire.mp3, splat.mp3, cry.mp3) and it replaces the synth version.
export const SFX_NAMES = [
  "fire", "fire2", "sniper", "splat", "hit", "step", "cry", "reload", "poof", "hurt", "win", "lose", "empty",
  "jump", "giggle", "tick", "switch", "drone", "whistle", "boom", "streak", "headshot",
  "baby_mama1", "baby_mama2", "baby_mama3", "baby_mama4", "baby_scream_sfx", "baby_peekaboo", "baby_uhoh", "baby_booboo",
  "baby_giggle2", "baby_nightnight", "baby_myturn", "baby_gimme", "baby_nofair", "baby_bottle", "rattle",
  "vo_drone_ready", "vo_drone_launched", "vo_strike_ready", "vo_strike_inbound", "vo_round_won", "vo_nap_time",
] as const;

/** Bundled sample pack in public/sfx. `public/sfx/<name>.mp3` overrides these; missing files fall back to the synth. */
const PACK: Partial<Record<string, [file: string, rate: number]>> = {
  fire: ["blaster_pop", 1], fire2: ["blaster_pop", 1.45], sniper: ["sniper", 1],
  splat: ["splat_hit", 1], hit: ["splat_hit", 1.12], cry: ["baby_cry", 1], giggle: ["giggle", 1],
  poof: ["poof", 1], boom: ["poof", 0.75],
};
export type SfxName = (typeof SFX_NAMES)[number];

interface PlayOpts { vol?: number; pan?: number; rate?: number; exact?: boolean }

export class AudioBus {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  samples = new Map<string, AudioBuffer>();
  rates = new Map<string, number>();
  private last = new Map<string, number>();
  muted = false;
  /** Step mode (offline capture): nothing is played; every sound event is logged with sim time. */
  stepMode = false;
  log: { t: number; name: string; rate: number; gain: number; pan: number }[] = [];
  private seq = 0;

  constructor(ctx?: AudioContext) {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = ctx ?? new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const n = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, n, n);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      if (!ctx) void this.loadSamples();
    } catch {
      this.ctx = null;
    }
  }

  /** Wait until the sample pack has decoded (capture tooling). */
  async ready(): Promise<number> {
    for (let i = 0; i < 200 && this.samples.size < 6; i++) await new Promise((r) => setTimeout(r, 50));
    return this.samples.size;
  }

  /**
   * Render the logged sound events (samples + synth fallbacks, exactly as the game would play them) to stereo PCM.
   * Used by tools/capture.mjs after a step-mode run.
   */
  async renderLog(log: AudioBus["log"], seconds: number, sr = 48000): Promise<Float32Array[]> {
    const oc = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
    let now = 0;
    const proxy = new Proxy(oc, {
      get(t, k) {
        if (k === "currentTime") return now;
        if (k === "state") return "running";
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as unknown as AudioContext;
    const bus = new AudioBus(proxy);
    bus.samples = this.samples; bus.rates = this.rates;
    for (const e of log) {
      now = e.t;
      bus.play(e.name as SfxName, { vol: e.gain, pan: e.pan, rate: e.rate, exact: true });
    }
    const buf = await oc.startRendering();
    return [buf.getChannelData(0), buf.getChannelData(1)];
  }

  /** Call from a user gesture. */
  unlock() {
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume();
  }

  private async loadSamples() {
    const cache = new Map<string, AudioBuffer | null>();
    const get = async (file: string) => {
      if (cache.has(file)) return cache.get(file)!;
      let buf: AudioBuffer | null = null;
      try {
        const res = await fetch(`/sfx/${file}.mp3`);
        const type = res.headers.get("content-type") || "";
        if (res.ok && !type.includes("text/html")) buf = await this.ctx!.decodeAudioData(await res.arrayBuffer());
      } catch { /* synth fallback */ }
      cache.set(file, buf);
      return buf;
    };
    for (const name of SFX_NAMES) {
      let buf = await get(name);
      let rate = 1;
      if (!buf) {
        const pk = PACK[name] ?? (name.startsWith("vo_") ? [name, 1] as [string, number] : undefined);
        if (pk) { buf = await get(pk[0]); rate = pk[1]; }
      }
      if (buf) { this.samples.set(name, buf); this.rates.set(name, rate); }
    }
  }

  play(name: SfxName, o: PlayOpts = {}) {
    const c = this.ctx;
    const vol = o.vol ?? 1;
    if (this.stepMode) {
      if (vol < 0.02) return;
      const t = clock.t;
      const lt = this.last.get(name) ?? -1;
      if (t - lt < (name === "step" ? 0.05 : 0.025)) return;
      this.last.set(name, t);
      // deterministic pitch jitter (same log for every viewport)
      const h = Math.sin((++this.seq) * 12.9898) * 43758.5453, jit = h - Math.floor(h);
      const rate = (o.rate ?? 1) * (name.startsWith("vo_") ? 1 : 0.92 + jit * 0.16);
      this.log.push({ t: +t.toFixed(4), name, rate: +rate.toFixed(4), gain: +vol.toFixed(4), pan: +(o.pan ?? 0).toFixed(3) });
      return;
    }
    if (!c || this.muted || c.state !== "running") return;
    if (vol < 0.02) return;
    const now = c.currentTime;
    // limit per-sound spam
    const lt = this.last.get(name) ?? -1;
    if (now - lt < (name === 'step' ? 0.05 : 0.025)) return;
    this.last.set(name, now);
    const g = c.createGain();
    g.gain.value = vol;
    let out: AudioNode = g;
    if (o.pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      g.connect(p);
      out = p;
    }
    out.connect(this.master);
    const rate = o.exact ? (o.rate ?? 1) : (o.rate ?? 1) * (name.startsWith("vo_") ? 1 : 0.92 + Math.random() * 0.16);
    const smp = this.samples.get(name);
    if (smp) {
      const s = c.createBufferSource();
      s.buffer = smp;
      s.playbackRate.value = rate * (this.rates.get(name) ?? 1);
      s.connect(g);
      s.start();
      return;
    }
    this.synth(name, g, rate);
  }

  // ---- synth helpers
  private tone(out: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, attack = 0.005) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(out: AudioNode, dur: number, vol: number, ftype: BiquadFilterType, f0: number, f1: number, q = 1, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = ftype;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  private synth(name: SfxName, out: AudioNode, rate: number) {
    const T = (type: OscillatorType, f0: number, f1: number, d: number, v: number, dl = 0, a = 0.005) =>
      this.tone(out, type, f0 * rate, f1 * rate, d, v, dl, a);
    const N = (d: number, v: number, ft: BiquadFilterType, f0: number, f1: number, q = 1, dl = 0) =>
      this.noise(out, d, v, ft, f0, f1, q, dl);
    switch (name) {
      case "fire":
        T("sine", 700, 170, 0.11, 0.5);
        N(0.06, 0.28, "bandpass", 2200, 700, 1.2);
        T("triangle", 320, 980, 0.07, 0.18, 0.02);
        break;
      case "fire2": // pacifier pistol: higher "thwip"
        T("sine", 1100, 260, 0.09, 0.45);
        T("triangle", 500, 1500, 0.06, 0.2, 0.015);
        N(0.05, 0.2, "highpass", 3000, 1500, 1);
        break;
      case "sniper":
        T("sine", 260, 55, 0.35, 0.8);
        N(0.25, 0.55, "lowpass", 4000, 200, 0.8);
        T("triangle", 900, 200, 0.2, 0.25, 0.01);
        N(0.5, 0.15, "bandpass", 900, 300, 0.6, 0.05);
        break;
      case "splat":
        N(0.22, 0.55, "lowpass", 2600, 280, 0.8);
        T("sine", 230, 70, 0.17, 0.35);
        N(0.05, 0.25, "highpass", 3200, 2000, 1);
        break;
      case "hit":
        N(0.2, 0.5, "lowpass", 2600, 300, 0.8);
        T("sine", 240, 80, 0.16, 0.3);
        T("triangle", 520, 1250, 0.11, 0.3, 0.01);
        break;
      case "headshot":
        T("sine", 900, 1800, 0.12, 0.35);
        T("sine", 1350, 2700, 0.14, 0.3, 0.06);
        N(0.15, 0.3, "lowpass", 3000, 400, 1);
        break;
      case "rattle": // beads shaking in a plastic shell
        for (let i = 0; i < 7; i++) { N(0.035, 0.22, "bandpass", 3600 + (i % 3) * 700, 2400, 4, i * 0.045); T("square", 2200 + (i % 2) * 500, 1500, 0.02, 0.05, i * 0.045); }
        break;
      case "tick":
        T("square", 1400, 1000, 0.035, 0.12);
        break;
      case "step":
        T("triangle", 850 + Math.random() * 250, 1500 + Math.random() * 500, 0.07, 0.16);
        N(0.03, 0.06, "highpass", 4000, 3000);
        break;
      case "jump":
        T("sine", 300, 700, 0.12, 0.18);
        break;
      case "cry": { // "waaah": sweeping sawtooth through formants with vibrato
        const c = this.ctx!;
        const t = c.currentTime;
        const base = 560 * rate;
        const o = c.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(base * 0.7, t);
        o.frequency.linearRampToValueAtTime(base * 1.5, t + 0.16);
        o.frequency.linearRampToValueAtTime(base * 1.05, t + 0.55);
        o.frequency.linearRampToValueAtTime(base * 0.8, t + 0.95);
        const lfo = c.createOscillator();
        lfo.frequency.value = 7;
        const lg = c.createGain();
        lg.gain.value = 28;
        lfo.connect(lg).connect(o.frequency);
        const f1 = c.createBiquadFilter();
        f1.type = "bandpass"; f1.Q.value = 4;
        f1.frequency.setValueAtTime(700, t);
        f1.frequency.linearRampToValueAtTime(1300, t + 0.2);
        f1.frequency.linearRampToValueAtTime(800, t + 0.9);
        const f2 = c.createBiquadFilter();
        f2.type = "bandpass"; f2.Q.value = 6; f2.frequency.value = 2800;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.9, t + 0.06);
        g.gain.setValueAtTime(0.8, t + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
        o.connect(f1).connect(g);
        o.connect(f2).connect(g);
        g.connect(out);
        o.start(t); lfo.start(t); o.stop(t + 1.05); lfo.stop(t + 1.05);
        break;
      }
      case "giggle":
        for (let i = 0; i < 4; i++) T("sine", 900 + (i % 2) * 250, 1250 + (i % 2) * 300, 0.07, 0.2, i * 0.09);
        break;
      case "reload":
        N(0.03, 0.4, "bandpass", 2500, 2500, 3);
        T("sine", 300, 520, 0.18, 0.3, 0.12);
        T("sine", 520, 260, 0.16, 0.25, 0.3);
        N(0.04, 0.45, "bandpass", 1800, 1800, 3, 0.75);
        T("triangle", 160, 80, 0.1, 0.35, 0.78);
        break;
      case "empty":
        T("square", 220, 150, 0.04, 0.2);
        break;
      case "switch":
        N(0.04, 0.3, "bandpass", 3000, 3000, 3);
        T("triangle", 600, 900, 0.05, 0.12, 0.03);
        break;
      case "poof":
        N(0.32, 0.45, "bandpass", 500, 3200, 0.8);
        T("sine", 300, 1000, 0.14, 0.3);
        break;
      case "hurt":
        T("sawtooth", 420, 190, 0.22, 0.22);
        N(0.15, 0.3, "lowpass", 2000, 300);
        break;
      case "drone":
        T("sawtooth", 140, 170, 0.5, 0.12);
        T("square", 280, 330, 0.5, 0.05);
        break;
      case "whistle":
        T("sine", 2400, 600, 0.9, 0.18, 0, 0.1);
        break;
      case "boom":
        T("sine", 140, 35, 0.6, 0.9);
        N(0.6, 0.7, "lowpass", 1800, 120, 0.7);
        T("triangle", 500, 120, 0.2, 0.3);
        break;
      case "streak":
        [523, 659, 784, 1046].forEach((f, i) => T("triangle", f, f, 0.16, 0.22, i * 0.08));
        break;
      case "win":
        [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => T("triangle", f, f * 1.01, 0.22, 0.28, i * 0.11));
        break;
      case "lose":
        [392, 370, 349, 262].forEach((f, i) => T("sawtooth", f, f * 0.93, 0.3, 0.16, i * 0.28));
        break;
    }
  }
}
