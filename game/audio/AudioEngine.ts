import { Surface } from "../physics/surfaces";
import { Vehicle } from "../physics/Vehicle";
import { clamp, smoothstep } from "../util/math";

export interface AudioLevels {
  master: number;
  engine: number;
  effects: number;
  ambience: number;
  music: number;
}

function noiseBuffer(ctx: AudioContext, seconds = 2, brown = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

/** An engine note built from firing-order harmonics (a periodic wave), shaped by load. */
function engineWave(ctx: AudioContext, cylinders: number, rough: number) {
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    // Strong firing harmonics, weaker sub-harmonics give the "burble".
    const firing = k % 2 === 0 ? 1 : 0.45 + rough;
    imag[k] = (firing / Math.pow(k, 0.9)) * (1 + 0.3 * Math.sin(k * 1.7));
    real[k] = (rough * 0.3) / k;
  }
  void cylinders;
  return ctx.createPeriodicWave(real, imag);
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<"engine" | "effects" | "ambience" | "music", GainNode>;
  private engine!: {
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    sub: OscillatorNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    shaper: WaveShaperNode;
    intake: AudioBufferSourceNode;
    intakeFilter: BiquadFilterNode;
    intakeGain: GainNode;
  };
  private tyre!: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; tone: OscillatorNode; toneGain: GainNode };
  private gravel!: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private road!: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private wind!: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private amb!: { trees: GainNode; treesFilter: BiquadFilterNode; water: GainNode; rain: GainNode };
  private white!: AudioBuffer;
  private levels: AudioLevels = { master: 0.85, engine: 0.9, effects: 0.8, ambience: 0.7, music: 0.35 };
  private birdTimer = 2;
  private musicTimer = 0;
  private chordIndex = 0;
  private lastGear = 0;
  private prevComp = [0, 0, 0, 0];
  private cylinders = 4;
  enabled = true;
  private wantMusic = true;
  private musicDuck = 1;
  private limiterPhase = 0;

  /** Creates the audio graph. Must be called from a user gesture on mobile browsers. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.buses = { engine: bus(), effects: bus(), ambience: bus(), music: bus() };
    this.white = noiseBuffer(ctx, 2);
    const brown = noiseBuffer(ctx, 3, true);
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };

    // Engine
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const sub = ctx.createOscillator();
    oscA.setPeriodicWave(engineWave(ctx, 4, 0.2));
    oscB.setPeriodicWave(engineWave(ctx, 4, 0.45));
    sub.type = "sine";
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8);
    }
    shaper.curve = curve;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const mixA = ctx.createGain();
    mixA.gain.value = 0.5;
    const mixB = ctx.createGain();
    mixB.gain.value = 0.25;
    const mixSub = ctx.createGain();
    mixSub.gain.value = 0.35;
    oscA.connect(mixA).connect(shaper);
    oscB.connect(mixB).connect(shaper);
    sub.connect(mixSub).connect(filter);
    shaper.connect(filter).connect(gain).connect(this.buses.engine);
    const intake = loop(this.white);
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = "bandpass";
    intakeFilter.Q.value = 2.5;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    intake.connect(intakeFilter).connect(intakeGain).connect(this.buses.engine);
    oscA.start();
    oscB.start();
    sub.start();
    this.engine = { oscA, oscB, sub, filter, gain, shaper, intake, intakeFilter, intakeGain };

    // Tyre squeal: resonant filtered noise plus a wavering tone.
    const tsrc = loop(this.white);
    const tfilter = ctx.createBiquadFilter();
    tfilter.type = "bandpass";
    tfilter.frequency.value = 1100;
    tfilter.Q.value = 8;
    const tgain = ctx.createGain();
    tgain.gain.value = 0;
    tsrc.connect(tfilter).connect(tgain).connect(this.buses.effects);
    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = 900;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    tone.connect(toneGain).connect(this.buses.effects);
    tone.start();
    this.tyre = { src: tsrc, filter: tfilter, gain: tgain, tone, toneGain };

    // Loose-surface crunch
    const gsrc = loop(this.white);
    const gfilter = ctx.createBiquadFilter();
    gfilter.type = "bandpass";
    gfilter.frequency.value = 2200;
    gfilter.Q.value = 0.7;
    const ggain = ctx.createGain();
    ggain.gain.value = 0;
    gsrc.connect(gfilter).connect(ggain).connect(this.buses.effects);
    this.gravel = { src: gsrc, filter: gfilter, gain: ggain };

    // Road rumble
    const rsrc = loop(brown);
    const rfilter = ctx.createBiquadFilter();
    rfilter.type = "lowpass";
    rfilter.frequency.value = 300;
    const rgain = ctx.createGain();
    rgain.gain.value = 0;
    rsrc.connect(rfilter).connect(rgain).connect(this.buses.effects);
    this.road = { src: rsrc, filter: rfilter, gain: rgain };

    // Wind
    const wsrc = loop(this.white);
    const wfilter = ctx.createBiquadFilter();
    wfilter.type = "bandpass";
    wfilter.frequency.value = 600;
    wfilter.Q.value = 0.4;
    const wgain = ctx.createGain();
    wgain.gain.value = 0;
    wsrc.connect(wfilter).connect(wgain).connect(this.buses.effects);
    this.wind = { src: wsrc, filter: wfilter, gain: wgain };

    // Ambience: wind in the trees, water, rain
    const trees = ctx.createGain();
    trees.gain.value = 0;
    const treesFilter = ctx.createBiquadFilter();
    treesFilter.type = "bandpass";
    treesFilter.frequency.value = 900;
    treesFilter.Q.value = 0.3;
    loop(this.white).connect(treesFilter).connect(trees).connect(this.buses.ambience);
    const water = ctx.createGain();
    water.gain.value = 0;
    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = "lowpass";
    waterFilter.frequency.value = 420;
    loop(brown).connect(waterFilter).connect(water).connect(this.buses.ambience);
    const rain = ctx.createGain();
    rain.gain.value = 0;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = "highpass";
    rainFilter.frequency.value = 1400;
    loop(this.white).connect(rainFilter).connect(rain).connect(this.buses.ambience);
    this.amb = { trees, treesFilter, water, rain };
    this.applyLevels();
  }

  setCar(cylinders: number) {
    this.cylinders = cylinders;
  }

  setLevels(l: AudioLevels) {
    this.levels = { ...l };
    this.applyLevels();
  }

  setMusic(on: boolean) {
    this.wantMusic = on;
  }

  private applyLevels() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? this.levels.master : 0, t, 0.1);
    this.buses.engine.gain.setTargetAtTime(this.levels.engine * 0.55, t, 0.1);
    this.buses.effects.gain.setTargetAtTime(this.levels.effects * 0.6, t, 0.1);
    this.buses.ambience.gain.setTargetAtTime(this.levels.ambience * 0.5, t, 0.1);
    this.buses.music.gain.setTargetAtTime(this.levels.music * 0.35 * this.musicDuck, t, 0.5);
  }

  suspend() {
    void this.ctx?.suspend();
  }
  resume() {
    void this.ctx?.resume();
  }

  /** Per-frame update from the player's car (or null in menus). */
  update(v: Vehicle | null, dt: number, env: { nearWater: number; forest: number; rain: number; wind: number }, driving: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const tc = 0.04;
    if (v && driving) {
      const tel = v.telemetry;
      const spec = v.spec;
      const rpm = Math.max(spec.engine.idle * 0.9, tel.rpm);
      // Firing frequency: rpm/60 * cylinders/2 (four-stroke). V8 gets a lower, richer note.
      const cyl = spec.cylinders;
      const fire = (rpm / 60) * (cyl / 2);
      const base = fire / 2;
      this.engine.oscA.frequency.setTargetAtTime(base, t, tc);
      this.engine.oscB.frequency.setTargetAtTime(base * 1.005, t, tc);
      this.engine.sub.frequency.setTargetAtTime(base / 2, t, tc);
      const load = clamp(tel.throttle, 0, 1);
      const rpmN = rpm / spec.engine.redline;
      // Limiter stutter
      let lim = 1;
      if (tel.limiter) {
        this.limiterPhase += dt * 14;
        lim = Math.sin(this.limiterPhase * Math.PI * 2) > 0 ? 1 : 0.35;
      }
      const g = (0.16 + 0.22 * load + 0.1 * rpmN) * lim * (tel.shifting ? 0.45 : 1);
      this.engine.gain.gain.setTargetAtTime(g, t, 0.03);
      this.engine.filter.frequency.setTargetAtTime(350 + rpmN * 1900 + load * 2200, t, tc);
      this.engine.intakeFilter.frequency.setTargetAtTime(fire * 4, t, tc);
      this.engine.intakeGain.gain.setTargetAtTime(0.05 * load * rpmN, t, tc);
      if (tel.gear !== this.lastGear && this.lastGear !== 0 && tel.gear > 0) this.blip(0.06, 180, 0.05);
      this.lastGear = tel.gear;

      // Tyres: squeal grows progressively as slip approaches and passes the limit.
      let squeal = 0;
      let loose = 0;
      let paved = 0;
      for (const w of v.wheels) {
        if (!w.contact) continue;
        const isPaved = w.surface === Surface.Asphalt || w.surface === Surface.Kerb;
        const s = smoothstep(0.7, 1.35, w.combinedSlip) * clamp(tel.speed / 6, 0, 1) * clamp(w.load / 4000, 0.2, 1.2);
        if (isPaved) {
          squeal = Math.max(squeal, s);
          paved++;
        } else loose += clamp(tel.speed / 15, 0, 1) * (w.surface === Surface.Water ? 0.5 : 1);
      }
      const wet = env.rain;
      const sq = squeal * (1 - wet * 0.75);
      this.tyre.gain.gain.setTargetAtTime(sq * 0.35, t, 0.05);
      this.tyre.toneGain.gain.setTargetAtTime(sq * sq * 0.05, t, 0.05);
      this.tyre.tone.frequency.setTargetAtTime(760 + squeal * 260 + Math.sin(t * 23) * 12, t, 0.02);
      this.tyre.filter.frequency.setTargetAtTime(900 + squeal * 500, t, 0.05);
      this.gravel.gain.gain.setTargetAtTime((loose / 4) * 0.4, t, 0.05);
      this.road.gain.gain.setTargetAtTime(clamp(tel.speed / 45, 0, 1) * (paved / 4) * (0.35 + wet * 0.3), t, 0.1);
      this.road.filter.frequency.setTargetAtTime(160 + tel.speed * 6 + wet * 800, t, 0.1);
      this.wind.gain.gain.setTargetAtTime(clamp((tel.speed / 70) ** 2, 0, 1) * 0.18, t, 0.1);
      this.wind.filter.frequency.setTargetAtTime(400 + tel.speed * 12, t, 0.1);

      // Suspension thumps over kerbs and bumps.
      v.wheels.forEach((w, i) => {
        const dv = (w.compression - this.prevComp[i]) / Math.max(dt, 1e-3);
        this.prevComp[i] = w.compression;
        if (dv > 1.1 && w.contact) this.thump(clamp(dv / 5, 0.1, 0.6));
      });
      for (const imp of v.impacts) if (imp.speed > 1) this.impact(imp.speed);
      this.musicDuck = 0.55;
    } else {
      this.engine.gain.gain.setTargetAtTime(0, t, 0.2);
      this.engine.intakeGain.gain.setTargetAtTime(0, t, 0.2);
      this.tyre.gain.gain.setTargetAtTime(0, t, 0.1);
      this.tyre.toneGain.gain.setTargetAtTime(0, t, 0.1);
      this.gravel.gain.gain.setTargetAtTime(0, t, 0.1);
      this.road.gain.gain.setTargetAtTime(0, t, 0.2);
      this.wind.gain.gain.setTargetAtTime(0, t, 0.2);
      this.musicDuck = 1;
    }
    this.buses.music.gain.setTargetAtTime(this.levels.music * 0.35 * this.musicDuck, t, 1);

    // Ambience
    const gust = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.13 + 1);
    this.amb.trees.gain.setTargetAtTime((0.04 + 0.08 * env.forest) * env.wind * (0.5 + gust * 0.8), t, 0.5);
    this.amb.water.gain.setTargetAtTime(env.nearWater * 0.35 * (0.7 + 0.3 * Math.sin(t * 0.7)), t, 0.4);
    this.amb.rain.gain.setTargetAtTime(env.rain * 0.12, t, 0.5);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0 && env.rain < 0.5) {
      this.bird(env.forest);
      this.birdTimer = 1.5 + Math.random() * (5 - env.forest * 2.5);
    }
    if (this.wantMusic && this.levels.music > 0.01) {
      this.musicTimer -= dt;
      if (this.musicTimer <= 0) {
        this.chord();
        this.musicTimer = 7.5;
      }
    }
  }

  private blip(gain: number, freq: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.buses.engine);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  private thump(amount: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(90, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(amount * 0.35, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    o.connect(g).connect(this.buses.effects);
    o.start();
    o.stop(ctx.currentTime + 0.2);
  }

  private impact(speed: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900 + speed * 80;
    const g = ctx.createGain();
    const a = clamp(speed / 12, 0.1, 1);
    g.gain.setValueAtTime(a * 0.7, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    s.connect(f).connect(g).connect(this.buses.effects);
    s.start();
    s.stop(ctx.currentTime + 0.4);
    this.thump(a);
  }

  private bird(forest: number) {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain();
    g.connect(pan).connect(this.buses.ambience);
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2400 + Math.random() * 1800 - forest * 400;
    let t = ctx.currentTime + 0.05;
    const vol = 0.03 + Math.random() * 0.03;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      o.type = "sine";
      const f0 = base * (0.9 + Math.random() * 0.25);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.35 : 0.75), t + 0.09);
      const eg = ctx.createGain();
      eg.gain.setValueAtTime(0.0001, t);
      eg.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      eg.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(eg).connect(g);
      o.start(t);
      o.stop(t + 0.13);
      t += 0.13 + Math.random() * 0.08;
    }
  }

  /** Slow, quiet pad chords (optional). */
  private chord() {
    const ctx = this.ctx!;
    const progressions = [
      [48, 55, 59, 64, 67], // Cmaj7-ish
      [45, 52, 57, 60, 64], // Am9
      [41, 48, 55, 57, 64], // Fmaj7
      [43, 50, 55, 59, 62], // G6
    ];
    const notes = progressions[this.chordIndex % progressions.length];
    this.chordIndex++;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.06;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    out.connect(lp).connect(this.buses.music);
    for (const n of notes) {
      const f = 440 * Math.pow(2, (n - 69) / 12);
      for (const detune of [-4, 4]) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = f;
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 2.8);
        g.gain.setValueAtTime(0.18, t + 5.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 9);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 9.2);
      }
    }
  }

  uiClick() {
    if (!this.ctx) return;
    this.blip(0.02, 1200, 0.03);
  }
}
