import { RacingLine, lineSpeedAt } from "../track/racingLine";
import { Track } from "../track/Track";

export const BIN = 5; // metres

/** Telemetry for one lap (or one sprint run), binned by distance along the road. */
export class LapTrace {
  readonly n: number;
  time: Float32Array;
  speed: Float32Array;
  brake: Float32Array;
  throttle: Float32Array;
  slip: Float32Array;
  off: Uint8Array;
  tc: Uint8Array;
  filled: Uint8Array;
  incidents: { s: number; kind: string }[] = [];
  constructor(length: number) {
    this.n = Math.ceil(length / BIN);
    this.time = new Float32Array(this.n);
    this.speed = new Float32Array(this.n);
    this.brake = new Float32Array(this.n);
    this.throttle = new Float32Array(this.n);
    this.slip = new Float32Array(this.n);
    this.off = new Uint8Array(this.n);
    this.tc = new Uint8Array(this.n);
    this.filled = new Uint8Array(this.n);
  }
  record(s: number, t: number, speed: number, brake: number, throttle: number, slip: number, off: boolean, tc: boolean) {
    const i = Math.floor(s / BIN) % this.n;
    if (!this.filled[i]) {
      this.filled[i] = 1;
      this.time[i] = t;
      this.speed[i] = speed;
    }
    this.speed[i] = Math.min(this.speed[i], speed);
    this.brake[i] = Math.max(this.brake[i], brake);
    this.throttle[i] = Math.max(this.throttle[i], throttle);
    this.slip[i] = Math.max(this.slip[i], slip);
    if (off) this.off[i] = 1;
    if (tc) this.tc[i] = 1;
  }
  at(s: number) {
    return Math.floor((((s % (this.n * BIN)) + this.n * BIN) % (this.n * BIN)) / BIN) % this.n;
  }
  /** Elapsed time at station s (interpolating unfilled bins). */
  timeAt(s: number) {
    let i = this.at(s);
    for (let k = 0; k < 6 && !this.filled[i]; k++) i = (i + 1) % this.n;
    return this.time[i];
  }
  /** Splits every 10 m for the live delta. */
  splits(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i += 2) out.push(this.filled[i] ? +this.time[i].toFixed(3) : -1);
    return out;
  }
}

export interface CornerReport {
  name: string;
  short: string;
  entryKmh: number;
  refEntryKmh: number;
  minKmh: number;
  refMinKmh: number;
  exitKmh: number;
  refExitKmh: number;
  brakeAt: number | null; // metres before turn-in where braking began
  refBrakeAt: number | null;
  offRoad: boolean;
  exitSlide: number; // degrees
  timeLoss: number; // seconds vs reference pace
}

export interface Feedback {
  headline: string;
  suggestions: string[];
  strengths: string[];
  incidents: string[];
  corners: CornerReport[];
}

/** Metres before the corner where the reference begins braking (walking back from its slowest point). */
function referenceBrakePoint(line: RacingLine, track: Track, sStart: number, sEnd: number): number | null {
  let minS = sStart;
  let minV = Infinity;
  for (let x = sStart; x <= sEnd; x += 2) {
    const v = lineSpeedAt(line, x, track.length);
    if (v < minV) {
      minV = v;
      minS = x;
    }
  }
  let x = minS;
  let v = minV;
  for (let k = 0; k < 250; k++) {
    const vPrev = lineSpeedAt(line, x - 2, track.length);
    if (vPrev <= v + 0.02) break;
    v = vPrev;
    x -= 2;
  }
  const d = track.delta(x, sStart);
  return minV > 0 && d > 5 ? Math.round(d) : null;
}

function refTime(line: RacingLine, track: Track, s0: number, s1: number) {
  let t = 0;
  const len = track.delta(s0, s1);
  for (let x = 0; x < len; x += 2) t += 2 / Math.max(1, lineSpeedAt(line, s0 + x, track.length));
  return t;
}

/** Builds encouraging, specific feedback from a lap trace and the reference profile. */
export function analyseLap(trace: LapTrace, track: Track, line: RacingLine, pace = 0.97, laps: LapTrace[] = []): Feedback {
  const corners: CornerReport[] = [];
  const kmh = (v: number) => Math.round(v * 3.6);
  for (const c of track.corners) {
    const flat = track.layout.some((l) => l.kind === "turn" && l.short === c.short && l.flat);
    if (flat) continue;
    const from = c.sStart - 150;
    const to = c.sEnd + 60;
    if (!trace.filled[trace.at(from)] || !trace.filled[trace.at(to)]) continue;
    let tIn = trace.timeAt(to) - trace.timeAt(from);
    if (tIn < 0) tIn += 1e6; // shouldn't happen within a lap
    const ref = refTime(line, track, from, to) / pace;
    let minV = Infinity;
    let off = false;
    for (let x = c.sStart - 20; x <= c.sEnd + 40; x += BIN) {
      const i = trace.at(x);
      if (trace.filled[i]) minV = Math.min(minV, trace.speed[i]);
      if (trace.off[i]) off = true;
    }
    let refMin = Infinity;
    for (let x = c.sStart; x <= c.sEnd; x += 2) refMin = Math.min(refMin, lineSpeedAt(line, x, track.length));
    let exitSlide = 0;
    for (let x = c.sApex; x <= c.sEnd + 60; x += BIN) exitSlide = Math.max(exitSlide, trace.slip[trace.at(x)]);
    let brakeAt: number | null = null;
    for (let x = c.sStart - 260; x <= c.sApex; x += BIN) {
      if (trace.brake[trace.at(x)] > 0.3) {
        brakeAt = Math.round(c.sStart - x);
        break;
      }
    }
    const refBrake = referenceBrakePoint(line, track, c.sStart, c.sEnd);
    corners.push({
      name: c.name,
      short: c.short,
      entryKmh: kmh(trace.speed[trace.at(c.sStart)]),
      refEntryKmh: kmh(lineSpeedAt(line, c.sStart, track.length) * pace),
      minKmh: kmh(minV),
      refMinKmh: kmh(refMin * pace),
      exitKmh: kmh(trace.speed[trace.at(c.sEnd + 60)]),
      refExitKmh: kmh(lineSpeedAt(line, c.sEnd + 60, track.length) * pace),
      brakeAt,
      refBrakeAt: refBrake,
      offRoad: off,
      exitSlide: Math.round((exitSlide * 180) / Math.PI),
      timeLoss: tIn - ref,
    });
  }

  const suggestions: { loss: number; text: string }[] = [];
  const incidents: string[] = [];
  for (const r of corners) {
    const where = `${r.name} (${r.short})`;
    if (r.offRoad) incidents.push(`Left the road at ${where}.`);
    const late = r.entryKmh > r.refEntryKmh * 1.08 && (r.offRoad || r.minKmh < r.refMinKmh * 0.82);
    const board = r.refBrakeAt ? (r.refBrakeAt > 125 ? "150" : r.refBrakeAt > 75 ? "100" : "50") : null;
    if (late) {
      suggestions.push({
        loss: Math.max(r.timeLoss, 0.4) + (r.offRoad ? 1 : 0),
        text: `Braking point at ${where}: you arrived at ${r.entryKmh} km/h; about ${r.refEntryKmh} works. ${board ? `Start braking near the ${board} board.` : "Brake a little earlier."}`,
      });
      continue;
    }
    if (r.exitSlide >= 8 && !r.offRoad) {
      suggestions.push({
        loss: Math.max(r.timeLoss, 0.2),
        text: `The rear slid ${r.exitSlide}° out of ${where}. Squeeze the throttle as you unwind the steering instead of all at once.`,
      });
      continue;
    }
    if (r.minKmh < r.refMinKmh * 0.86 && !r.offRoad) {
      suggestions.push({
        loss: r.timeLoss,
        text: `Carry more speed through ${where}: your slowest point was ${r.minKmh} km/h; the car can manage about ${r.refMinKmh}. Brake a touch later or release it sooner.`,
      });
      continue;
    }
    if (r.exitKmh < r.refExitKmh * 0.9 && !r.offRoad) {
      suggestions.push({
        loss: r.timeLoss,
        text: `Exit of ${where}: ${r.exitKmh} km/h vs about ${r.refExitKmh}. Get back to full throttle a little earlier as the car straightens.`,
      });
    }
  }
  for (const inc of trace.incidents) incidents.push(inc.kind);
  suggestions.sort((a, b) => b.loss - a.loss);
  // Always offer something concrete: the corners where the most time went, and which phase.
  const used = new Set(suggestions.map((s) => s.text.split(":")[0]));
  const ranked = corners.filter((r) => !r.offRoad && r.timeLoss > 0.15).sort((a, b) => b.timeLoss - a.timeLoss);
  for (const r of ranked) {
    if (suggestions.length >= 2) break;
    const where = `${r.name} (${r.short})`;
    if ([...used].some((u) => u.includes(r.short))) continue;
    const exitGap = r.exitKmh / Math.max(1, r.refExitKmh);
    const minGap = r.minKmh / Math.max(1, r.refMinKmh);
    const entryGap = r.entryKmh / Math.max(1, r.refEntryKmh);
    let text: string;
    if (exitGap <= minGap && exitGap <= entryGap)
      text = `Exit of ${where}: ${r.exitKmh} km/h against about ${r.refExitKmh}. Aim to be back on full throttle as the steering unwinds; a slightly later apex helps.`;
    else if (minGap <= entryGap)
      text = `Mid-corner at ${where}: ${r.minKmh} km/h against about ${r.refMinKmh}. Release the brake a little earlier and let the car roll through the apex.`;
    else
      text = `Entry to ${where}: ${r.entryKmh} km/h against about ${r.refEntryKmh}.${r.brakeAt && r.refBrakeAt && r.brakeAt > r.refBrakeAt + 15 ? ` You began braking about ${r.brakeAt} m out; the car can wait until roughly ${r.refBrakeAt} m.` : r.brakeAt === null ? " No braking needed here: carry more speed in by taking a straighter line through the corner before." : " Brake a touch later and harder, then ease off smoothly."}`;
    suggestions.push({ loss: r.timeLoss, text });
    used.add(where);
  }

  const strengths: string[] = [];
  const clean = corners.filter((r) => !r.offRoad && r.exitSlide < 8).sort((a, b) => a.timeLoss - b.timeLoss);
  if (clean[0] && clean[0].timeLoss < 0.25) strengths.push(`Strong through ${clean[0].name} (${clean[0].short}): right on the reference pace.`);
  if (!incidents.length) strengths.push("Clean run: no time off the road.");
  if (laps.length >= 2) {
    const times = laps.map((l) => l.time[l.n - 1] || 0).filter((t) => t > 0);
    if (times.length >= 2) {
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      const sd = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length);
      if (sd < 0.6) strengths.push(`Consistent: your laps were within ${sd.toFixed(2)} s of each other.`);
    }
  }

  const total = corners.reduce((a, r) => a + Math.max(0, r.timeLoss), 0);
  const headline =
    incidents.length > 2
      ? "Focus on staying on the road first. Speed follows control."
      : total < 2
        ? "Very tidy. You're close to what the car can do."
        : total < 6
          ? "Good lap. A couple of corners hold the key to more time."
          : "Solid start. Small changes in the corners below will cut seconds.";
  return {
    headline,
    suggestions: suggestions.slice(0, 2).map((s) => s.text),
    strengths: strengths.slice(0, 2),
    incidents: incidents.slice(0, 5),
    corners,
  };
}
