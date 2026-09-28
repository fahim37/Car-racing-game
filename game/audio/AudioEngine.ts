import { CarSpec } from "../physics/carSpecs";
import { Surface } from "../physics/surfaces";
import type { ImpactEvent, Vehicle } from "../physics/Vehicle";
import { clamp, smoothstep } from "../util/math";

export interface AudioLevels {
  master: number;
  engine: number;
  effects: number;
  ambience: number;
  music: number;
}

/** A rival car the listener can hear (online). */
export interface HeardCar {
  x: number;
  y: number;
  z: number;
  speed: number;
  cylinders: number;
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

/** How an engine sounds: its firing pattern, exhaust and character. */
interface EngineVoice {
  /** Firing pulses per crank revolution (cylinders / 2 for a four-stroke). */
  order: number;
  /** Strength of the orders between firing pulses: the burble of an uneven firing order. */
  uneven: number;
  /** Harmonic roll-off: lower is brighter, more of a scream. */
  rolloff: number;
  /** Waveshaper drive: rasp. */
  drive: number;
  /** Exhaust resonance (Hz) and its emphasis (dB). */
  resonance: number;
  resonanceGain: number;
  /** Idle lope: a slow wobble at low revs. */
  lope: number;
  /** Pops and crackles on the overrun, 0..1. */
  crackle: number;
  turbo: boolean;
  /** Straight-cut gearbox whine, 0..1. */
  whine: number;
  /** Deep rumble under the note. */
  sub: number;
}

function voiceFor(spec: Pick<CarSpec, "cylinders"> & { stats?: CarSpec["stats"] }): EngineVoice {
  const layout = spec.stats?.layout ?? "";
  const base: EngineVoice = { order: spec.cylinders / 2, uneven: 0.12, rolloff: 1, drive: 1.8, resonance: 320, resonanceGain: 6, lope: 0, crackle: 0.3, turbo: /turbo/i.test(layout), whine: 0, sub: 0.3 };
  switch (spec.cylinders) {
    case 4: // raspy turbo four
      return { ...base, uneven: 0.16, rolloff: 0.85, drive: 2.6, resonance: 480, crackle: 0.2 };
    case 6:
      return /flat/i.test(layout)
        ? { ...base, uneven: 0.26, rolloff: 0.78, drive: 2.3, resonance: 560, resonanceGain: 7, crackle: 0.55, whine: 0.6 } // metallic flat-six
        : { ...base, uneven: 0.07, rolloff: 1.05, drive: 1.6, resonance: 280, crackle: 0.35 }; // silky straight-six
    case 8: // cross-plane V8: lumpy and deep
      return { ...base, uneven: 0.62, rolloff: 1.2, drive: 2.1, resonance: 150, resonanceGain: 8, lope: 0.35, crackle: 0.85, sub: 0.6 };
    case 10: // screaming V10
      return { ...base, uneven: 0.2, rolloff: 0.72, drive: 2.2, resonance: 650, crackle: 0.6 };
    default: // smooth, high V12
      return { ...base, uneven: 0.06, rolloff: 0.68, drive: 1.5, resonance: 760, crackle: 0.4 };
  }
}

/**
 * One crank revolution of engine sound as a periodic wave (fundamental = crank speed). Firing
 * orders dominate; an uneven firing order adds the orders in between. On the overrun the note is
 * duller and more hollow.
 */
function engineWave(ctx: AudioContext, v: EngineVoice, onLoad: boolean) {
  const n = 64;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  const roll = v.rolloff * (onLoad ? 0.85 : 1.3);
  for (let k = 1; k < n; k++) {
    const firing = k % v.order === 0;
    const weight = firing ? 1 : v.uneven * (0.55 + 0.45 * Math.abs(Math.sin(k * 2.3)));
    const a = (weight / Math.pow(Math.max(1, k / v.order), roll)) * (onLoad || k <= v.order * 3 ? 1 : 0.6);
    real[k] = a * Math.sin(k * 1.9);
    imag[k] = a * Math.cos(k * 1.9);
  }
  return ctx.createPeriodicWave(real, imag);
}

function driveCurve(drive: number) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * drive);
  return curve;
}

interface RivalVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  cylinders: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<"engine" | "effects" | "ambience" | "music", GainNode>;
  private engine!: {
    on: OscillatorNode;
    on2: OscillatorNode;
    off: OscillatorNode;
    onGain: GainNode;
    offGain: GainNode;
    sub: OscillatorNode;
    subGain: GainNode;
    shaper: WaveShaperNode;
    resonance: BiquadFilterNode;
    filter: BiquadFilterNode;
    lope: GainNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    gain: GainNode;
    intakeFilter: BiquadFilterNode;
    intakeGain: GainNode;
    turbo: OscillatorNode;
    turboGain: GainNode;
    whine: OscillatorNode;
    whineGain: GainNode;
  };
  private nitro!: { hiss: GainNode; roar: GainNode };
  private tyre!: { filter: BiquadFilterNode; gain: GainNode; filter2: BiquadFilterNode; gain2: GainNode; tone: OscillatorNode; toneGain: GainNode };
  private gravel!: { filter: BiquadFilterNode; gain: GainNode };
  private road!: { filter: BiquadFilterNode; gain: GainNode };
  private wind!: { filter: BiquadFilterNode; gain: GainNode };
  private amb!: { trees: GainNode; treesFilter: BiquadFilterNode; water: GainNode; rain: GainNode };
  private rivals: RivalVoice[] = [];
  private rivalWaves = new Map<number, PeriodicWave>();
  private white!: AudioBuffer;
  private levels: AudioLevels = { master: 0.85, engine: 0.9, effects: 0.8, ambience: 0.7, music: 0.35 };
  private voice: EngineVoice = voiceFor({ cylinders: 6 });
  private voiceId = "";
  private birdTimer = 2;
  private musicTimer = 0;
  private lastGear = 0;
  private prevComp = [0, 0, 0, 0];
  private prevThrottle = 0;
  private overrun = 0;
  private spool = 0;
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
      s.start(0, Math.random() * buf.duration);
      return s;
    };
    const gainNode = (value = 0) => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const filterNode = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };

    // Engine: on-load and overrun notes (plus a detuned double for body) through a rasp, the
    // exhaust's resonance and a filter that opens with revs and throttle.
    const on = ctx.createOscillator();
    const on2 = ctx.createOscillator();
    const off = ctx.createOscillator();
    const sub = ctx.createOscillator();
    sub.type = "sine";
    const onGain = gainNode(0.5);
    const on2Gain = gainNode(0.22);
    const offGain = gainNode(0.3);
    const subGain = gainNode(0.3);
    const shaper = ctx.createWaveShaper();
    const resonance = filterNode("peaking", 300, 1.4);
    const filter = filterNode("lowpass", 800, 0.9);
    const lope = gainNode(1);
    const lfo = ctx.createOscillator();
    const lfoDepth = gainNode(0);
    lfo.connect(lfoDepth).connect(lope.gain);
    const gain = gainNode(0);
    on.connect(onGain).connect(shaper);
    on2.connect(on2Gain).connect(onGain);
    off.connect(offGain).connect(shaper);
    shaper.connect(resonance).connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(lope).connect(gain).connect(this.buses.engine);
    const intakeFilter = filterNode("bandpass", 800, 2.5);
    const intakeGain = gainNode();
    loop(this.white).connect(intakeFilter).connect(intakeGain).connect(this.buses.engine);
    const turbo = ctx.createOscillator();
    turbo.type = "sine";
    const turboGain = gainNode();
    turbo.connect(turboGain).connect(this.buses.engine);
    const whine = ctx.createOscillator();
    whine.type = "triangle";
    const whineGain = gainNode();
    whine.connect(whineGain).connect(this.buses.engine);
    for (const o of [on, on2, off, sub, lfo, turbo, whine]) o.start();
    this.engine = { on, on2, off, onGain, offGain, sub, subGain, shaper, resonance, filter, lope, lfo, lfoDepth, gain, intakeFilter, intakeGain, turbo, turboGain, whine, whineGain };
    this.applyVoice(this.voice);

    // Nitro: a rushing hiss over a low roar while the boost fires.
    const hiss = gainNode();
    loop(this.white).connect(filterNode("bandpass", 1300, 0.7)).connect(hiss).connect(this.buses.effects);
    const roar = gainNode();
    loop(brown).connect(filterNode("lowpass", 220)).connect(roar).connect(this.buses.effects);
    this.nitro = { hiss, roar };

    // Tyre squeal: two resonant noise bands with a wavering tone.
    const tfilter = filterNode("bandpass", 1100, 8);
    const tgain = gainNode();
    loop(this.white).connect(tfilter).connect(tgain).connect(this.buses.effects);
    const tfilter2 = filterNode("bandpass", 1750, 14);
    const tgain2 = gainNode();
    loop(this.white).connect(tfilter2).connect(tgain2).connect(this.buses.effects);
    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = 900;
    const toneGain = gainNode();
    tone.connect(toneGain).connect(this.buses.effects);
    tone.start();
    this.tyre = { filter: tfilter, gain: tgain, filter2: tfilter2, gain2: tgain2, tone, toneGain };

    // Loose-surface crunch, road rumble and wind.
    const gfilter = filterNode("bandpass", 2200, 0.7);
    const ggain = gainNode();
    loop(this.white).connect(gfilter).connect(ggain).connect(this.buses.effects);
    this.gravel = { filter: gfilter, gain: ggain };
    const rfilter = filterNode("lowpass", 300);
    const rgain = gainNode();
    loop(brown).connect(rfilter).connect(rgain).connect(this.buses.effects);
    this.road = { filter: rfilter, gain: rgain };
    const wfilter = filterNode("bandpass", 600, 0.4);
    const wgain = gainNode();
    loop(this.white).connect(wfilter).connect(wgain).connect(this.buses.effects);
    this.wind = { filter: wfilter, gain: wgain };

    // Ambience: wind in the trees, water, rain.
    const trees = gainNode();
    const treesFilter = filterNode("bandpass", 900, 0.3);
    loop(this.white).connect(treesFilter).connect(trees).connect(this.buses.ambience);
    const water = gainNode();
    loop(brown).connect(filterNode("lowpass", 420)).connect(water).connect(this.buses.ambience);
    const rain = gainNode();
    loop(this.white).connect(filterNode("highpass", 1400)).connect(rain).connect(this.buses.ambience);
    this.amb = { trees, treesFilter, water, rain };

    // Rivals online: the nearest few engines, placed around the listener.
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const vf = filterNode("lowpass", 900, 0.8);
      const vg = gainNode();
      const panner = ctx.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "inverse";
      panner.refDistance = 7;
      panner.rolloffFactor = 1.1;
      panner.maxDistance = 400;
      osc.setPeriodicWave(this.rivalWave(8));
      osc.connect(vf).connect(vg).connect(panner).connect(this.buses.engine);
      osc.start();
      this.rivals.push({ osc, filter: vf, gain: vg, panner, cylinders: 8 });
    }
    this.applyLevels();
  }

  /** Rebuilds the engine note for a car. */
  private applyVoice(v: EngineVoice) {
    const e = this.engine;
    const ctx = this.ctx!;
    e.on.setPeriodicWave(engineWave(ctx, v, true));
    e.on2.setPeriodicWave(engineWave(ctx, v, true));
    e.off.setPeriodicWave(engineWave(ctx, v, false));
    e.shaper.curve = driveCurve(v.drive);
    e.resonance.frequency.value = v.resonance;
    e.resonance.gain.value = v.resonanceGain;
    e.subGain.gain.value = v.sub;
  }

  private rivalWave(cylinders: number) {
    let w = this.rivalWaves.get(cylinders);
    if (!w) {
      w = engineWave(this.ctx!, voiceFor({ cylinders }), true);
      this.rivalWaves.set(cylinders, w);
    }
    return w;
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
      if (v.spec.id !== this.voiceId) {
        this.voiceId = v.spec.id;
        this.voice = voiceFor(v.spec);
        this.applyVoice(this.voice);
      }
      const voice = this.voice;
      const e = this.engine;
      const tel = v.telemetry;
      const spec = v.spec;
      const rpm = Math.max(spec.engine.idle * 0.9, tel.rpm);
      const crank = rpm / 60;
      e.on.frequency.setTargetAtTime(crank, t, tc);
      e.on2.frequency.setTargetAtTime(crank * 1.006, t, tc);
      e.off.frequency.setTargetAtTime(crank, t, tc);
      e.sub.frequency.setTargetAtTime((crank * voice.order) / 2, t, tc);
      const load = clamp(tel.throttle, 0, 1);
      const rpmN = rpm / spec.engine.redline;
      e.onGain.gain.setTargetAtTime(0.2 + 0.6 * load, t, 0.05);
      e.offGain.gain.setTargetAtTime(0.1 + 0.4 * (1 - load), t, 0.05);
      // Idle lope: the wobble of a big engine, fading as the revs rise.
      e.lfo.frequency.setTargetAtTime(crank * 0.5, t, tc);
      e.lfoDepth.gain.setTargetAtTime(voice.lope * (1 - smoothstep(0.15, 0.45, rpmN)), t, 0.1);
      let lim = 1;
      if (tel.limiter) {
        this.limiterPhase += dt * 14;
        lim = Math.sin(this.limiterPhase * Math.PI * 2) > 0 ? 1 : 0.35;
      }
      const boost = v.nitro.active ? 1.15 : 1;
      const g = (0.14 + 0.22 * load + 0.12 * rpmN) * lim * boost * (tel.shifting ? 0.4 : 1);
      e.gain.gain.setTargetAtTime(g, t, 0.03);
      e.filter.frequency.setTargetAtTime(400 + rpmN * 2200 + load * 2600, t, tc);
      e.intakeFilter.frequency.setTargetAtTime(crank * voice.order * 4, t, tc);
      e.intakeGain.gain.setTargetAtTime(0.05 * load * rpmN, t, tc);

      // Turbo spools up with revs under load; lifting vents it through the blow-off valve.
      const lifted = this.prevThrottle > 0.45 && load < 0.12;
      if (voice.turbo) {
        this.spool += ((load > 0.3 ? load * smoothstep(0.3, 0.8, rpmN) : 0) - this.spool) * Math.min(1, dt * (load > 0.3 ? 2.2 : 6));
        e.turbo.frequency.setTargetAtTime(2400 + this.spool * 4800, t, 0.05);
        e.turboGain.gain.setTargetAtTime(this.spool * 0.035, t, 0.05);
        if (lifted && this.spool > 0.4) this.blowOff(this.spool);
      } else e.turboGain.gain.setTargetAtTime(0, t, 0.1);
      e.whine.frequency.setTargetAtTime(crank * 9, t, tc);
      e.whineGain.gain.setTargetAtTime(voice.whine * 0.018 * (0.3 + load) * rpmN, t, 0.05);

      // Overrun: pops and crackles for a moment after lifting at high revs.
      if (lifted && rpmN > 0.5) this.overrun = 0.35 + voice.crackle * 0.9;
      this.overrun = Math.max(0, this.overrun - dt);
      if (this.overrun > 0 && load < 0.15 && rpmN > 0.35 && Math.random() < voice.crackle * 22 * dt) this.pop(0.35 + Math.random() * 0.65 * voice.crackle);
      this.prevThrottle = load;
      // Gear changes: a clunk, and a crack from the exhaust on a hard upshift in the loud cars.
      if (tel.gear !== this.lastGear && this.lastGear !== 0 && tel.gear > 0) {
        this.clunk();
        if (tel.gear > this.lastGear && load > 0.6 && voice.crackle > 0.4) this.pop(0.9);
      }
      this.lastGear = tel.gear;

      // Nitro.
      this.nitro.hiss.gain.setTargetAtTime(v.nitro.active ? 0.2 : 0, t, v.nitro.active ? 0.05 : 0.15);
      this.nitro.roar.gain.setTargetAtTime(v.nitro.active ? 0.5 : 0, t, v.nitro.active ? 0.05 : 0.2);

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
      const flutter = 0.8 + 0.2 * Math.sin(t * 31 + Math.sin(t * 7) * 3);
      const sq = squeal * (1 - wet * 0.75) * flutter;
      this.tyre.gain.gain.setTargetAtTime(sq * 0.3, t, 0.05);
      this.tyre.gain2.gain.setTargetAtTime(sq * sq * 0.22, t, 0.05);
      this.tyre.toneGain.gain.setTargetAtTime(sq * sq * 0.05, t, 0.05);
      this.tyre.tone.frequency.setTargetAtTime(760 + squeal * 260 + Math.sin(t * 23) * 12, t, 0.02);
      this.tyre.filter.frequency.setTargetAtTime(900 + squeal * 500, t, 0.05);
      this.tyre.filter2.frequency.setTargetAtTime(1600 + squeal * 400 + Math.sin(t * 11) * 60, t, 0.05);
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
      for (const imp of v.impacts) if (imp.speed > 1) this.impact(imp.speed, imp.kind);
      this.musicDuck = 0.55;
    } else {
      const e = this.engine;
      for (const g of [e.gain, e.intakeGain, e.turboGain, e.whineGain, this.nitro.hiss, this.nitro.roar]) g.gain.setTargetAtTime(0, t, 0.2);
      for (const g of [this.tyre.gain, this.tyre.gain2, this.tyre.toneGain, this.gravel.gain]) g.gain.setTargetAtTime(0, t, 0.1);
      this.road.gain.gain.setTargetAtTime(0, t, 0.2);
      this.wind.gain.gain.setTargetAtTime(0, t, 0.2);
      this.spool = 0;
      this.overrun = 0;
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
        this.phrase();
        this.musicTimer = 7.5;
      }
    }
  }

  /**
   * Rival engines online: the nearest three cars, placed around the listener (the camera). Their
   * revs are estimated from speed with gear changes, so they rise and drop as they would.
   */
  updateRivals(cars: HeardCar[] | null, listener: { x: number; y: number; z: number; fx: number; fy: number; fz: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.rivals.length) return;
    const t = ctx.currentTime;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(listener.x, t, 0.02);
      L.positionY.setTargetAtTime(listener.y, t, 0.02);
      L.positionZ.setTargetAtTime(listener.z, t, 0.02);
      L.forwardX.setTargetAtTime(listener.fx, t, 0.02);
      L.forwardY.setTargetAtTime(listener.fy, t, 0.02);
      L.forwardZ.setTargetAtTime(listener.fz, t, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(listener.x, listener.y, listener.z);
      L.setOrientation(listener.fx, listener.fy, listener.fz, 0, 1, 0);
    }
    const near = cars ? [...cars].sort((a, b) => Math.hypot(a.x - listener.x, a.z - listener.z) - Math.hypot(b.x - listener.x, b.z - listener.z)).slice(0, this.rivals.length) : [];
    this.rivals.forEach((r, i) => {
      const c = near[i];
      if (!c) {
        r.gain.gain.setTargetAtTime(0, t, 0.2);
        return;
      }
      if (r.cylinders !== c.cylinders) {
        r.cylinders = c.cylinders;
        r.osc.setPeriodicWave(this.rivalWave(c.cylinders));
      }
      const band = (c.speed % 13) / 13;
      const rpm = c.speed < 1 ? 900 : 2600 + band * 4600;
      r.osc.frequency.setTargetAtTime(rpm / 60, t, 0.05);
      r.filter.frequency.setTargetAtTime(500 + band * 2500, t, 0.05);
      r.gain.gain.setTargetAtTime(0.25 + 0.15 * clamp(c.speed / 40, 0, 1), t, 0.1);
      if (r.panner.positionX) {
        r.panner.positionX.setTargetAtTime(c.x, t, 0.03);
        r.panner.positionY.setTargetAtTime(c.y, t, 0.03);
        r.panner.positionZ.setTargetAtTime(c.z, t, 0.03);
      } else r.panner.setPosition(c.x, c.y, c.z);
    });
  }

  private noise(dest: AudioNode, filter: BiquadFilterNode, peak: number, attack: number, decay: number, rate = 1) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    s.connect(filter).connect(g).connect(dest);
    s.start(t, Math.random() * 1.5);
    s.stop(t + attack + decay + 0.05);
  }

  private band(type: BiquadFilterType, freq: number, q: number) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** An exhaust pop; bigger ones come with a thud. */
  private pop(size: number) {
    this.noise(this.buses.engine, this.band("bandpass", 350 + Math.random() * 900, 1.2), 0.5 * size, 0.004, 0.03 + Math.random() * 0.05 * size, 0.6 + Math.random() * 0.8);
    if (size > 0.6) this.thump(size * 0.5);
  }

  /** Turbo blow-off valve: a falling "pssh". */
  private blowOff(amount: number) {
    const f = this.band("highpass", 3200, 0.9);
    f.frequency.exponentialRampToValueAtTime(1200, this.ctx!.currentTime + 0.35);
    this.noise(this.buses.engine, f, 0.22 * amount, 0.01, 0.35);
  }

  private clunk() {
    this.noise(this.buses.engine, this.band("lowpass", 700, 1), 0.08, 0.003, 0.05);
  }

  private thump(amount: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f0 = 80 + Math.random() * 25;
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(amount * 0.35, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    o.connect(g).connect(this.buses.effects);
    o.start();
    o.stop(ctx.currentTime + 0.2);
  }

  /** Collisions sound like what was hit: metal rings, wood knocks, stone crunches. */
  private impact(speed: number, kind: ImpactEvent["kind"]) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const a = clamp(speed / 12, 0.1, 1);
    if (kind === "rail" || kind === "car") {
      this.noise(this.buses.effects, this.band("lowpass", 1400 + speed * 90, 0.7), a * 0.6, 0.003, 0.3);
      // A few ringing partials: panel and barrier resonances, different every time.
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = (kind === "car" ? 260 : 420) * (1 + i * 1.37 + Math.random() * 0.3);
        g.gain.setValueAtTime(a * 0.08, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25 + Math.random() * 0.35);
        o.connect(g).connect(this.buses.effects);
        o.start(t);
        o.stop(t + 0.7);
      }
    } else if (kind === "tree") {
      this.noise(this.buses.effects, this.band("bandpass", 380 + Math.random() * 120, 2), a * 0.7, 0.002, 0.12);
    } else {
      this.noise(this.buses.effects, this.band("lowpass", 700 + speed * 40, 0.8), a * 0.65, 0.003, 0.28, 0.7);
    }
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

  /** A slow pad chord with a soft bass note and, now and then, a few bell-like notes on top. */
  private phrase() {
    const ctx = this.ctx!;
    const chords = [
      [48, 55, 59, 64, 67], // Cmaj7
      [45, 52, 57, 60, 64], // Am9
      [41, 48, 55, 57, 64], // Fmaj7
      [43, 50, 55, 59, 62], // G6
      [40, 47, 52, 55, 59], // Em7
      [50, 57, 60, 65, 69], // Dm9
      [38, 45, 50, 54, 57], // D
      [44, 51, 56, 60, 63], // Ab
    ];
    const notes = chords[Math.floor(Math.random() * chords.length)];
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.06;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    out.connect(lp).connect(this.buses.music);
    const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
    const voice = (f: number, type: OscillatorType, start: number, peak: number, attack: number, hold: number, release: number, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + attack);
      g.gain.setValueAtTime(peak, start + attack + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
      o.connect(g).connect(out);
      o.start(start);
      o.stop(start + attack + hold + release + 0.1);
    };
    for (const n of notes) for (const detune of [-4, 4]) voice(midi(n), "triangle", t, 0.18, 2.8, 2.7, 3.5, detune);
    voice(midi(notes[0] - 12), "sine", t, 0.35, 0.4, 5, 2.5);
    if (Math.random() < 0.45) {
      let at = t + 2 + Math.random() * 2;
      for (let i = 0; i < 3; i++) {
        voice(midi(notes[1 + Math.floor(Math.random() * 4)] + 12), "sine", at, 0.12, 0.01, 0.05, 1.4);
        at += 0.35 + Math.random() * 0.4;
      }
    }
  }

  uiClick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 1200;
    g.gain.setValueAtTime(0.02, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
    o.connect(g).connect(this.buses.engine);
    o.start();
    o.stop(ctx.currentTime + 0.05);
  }

  /** Bright rising chime: driving through a nitro gate, or a good finish. */
  pickup() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [880, 1320, 1760].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(f, t + i * 0.06);
      g.gain.setValueAtTime(0.0001, t + i * 0.06);
      g.gain.exponentialRampToValueAtTime(0.09, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.06 + 0.25);
      o.connect(g).connect(this.buses.effects);
      o.start(t + i * 0.06);
      o.stop(t + i * 0.06 + 0.3);
    });
  }

  /** Rushing whoosh as the nitro kicks in. */
  boost() {
    const ctx = this.ctx;
    if (!ctx) return;
    const f = this.band("bandpass", 300, 0.8);
    f.frequency.exponentialRampToValueAtTime(2400, ctx.currentTime + 0.45);
    this.noise(this.buses.effects, f, 0.35, 0.08, 0.6);
  }

  /** Two-tone car horn. */
  horn(gain = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.16 * gain, t + 0.02);
    out.gain.setValueAtTime(0.16 * gain, t + 0.42);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    const lp = this.band("lowpass", 2200, 0.7);
    lp.connect(out).connect(this.buses.effects);
    for (const f of [415, 523]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + 0.55);
    }
  }
}
