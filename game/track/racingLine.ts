import { CarSpec, torqueAt } from "../physics/carSpecs";
import { clamp } from "../util/math";
import { Track } from "./Track";

/**
 * A reference line and speed profile for a car on this road.
 *
 * The line minimises curvature within the road edges (what a tidy driver does: wide entry,
 * clipped apex, wide exit). The speed profile is the fastest the tyres allow along it,
 * using a friction circle for combined braking/accelerating and cornering. It is a guide,
 * not a promise: real laps depend on weight transfer and driver inputs.
 */
export interface RacingLine {
  count: number;
  step: number;
  s: Float32Array; // centreline station of each point
  offset: Float32Array; // lateral offset from the centreline (+ left)
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  curvature: Float32Array;
  speed: Float32Array; // m/s
  /** -1 braking, 0 coasting/cornering at the limit, 1 accelerating. */
  phase: Int8Array;
  /** Braking points (s along centreline) and target speeds, one per braking zone. */
  brakeZones: { sStart: number; sEnd: number; entrySpeed: number; minSpeed: number; corner: number }[];
  lapTime: number;
}

const LINE_STEP = 3;

export function computeRacingLine(track: Track, spec: CarSpec, gripScale = 1, margin = 1.35): RacingLine {
  const n = Math.floor(track.length / LINE_STEP);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  const lim = new Float64Array(n);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const si = (i * track.length) / n;
    const f = track.frameAt(si);
    s[i] = si;
    cx[i] = f.x;
    cz[i] = f.z;
    nx[i] = f.nx;
    nz[i] = f.nz;
    lim[i] = Math.max(0, f.halfWidth - margin);
  }
  const o = new Float64Array(n);
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  const update = () => {
    for (let i = 0; i < n; i++) {
      px[i] = cx[i] + nx[i] * o[i];
      pz[i] = cz[i] + nz[i] * o[i];
    }
  };
  // Minimise the sum of squared second differences (discrete curvature) by projected
  // gradient descent along each point's normal.
  update();
  const iters = 2500;
  for (let it = 0; it < iters; it++) {
    const stepSize = 0.09;
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n;
      const b = (i - 1 + n) % n;
      const c = (i + 1) % n;
      const d = (i + 2) % n;
      const gx = px[a] - 4 * px[b] + 6 * px[i] - 4 * px[c] + px[d];
      const gz = pz[a] - 4 * pz[b] + 6 * pz[i] - 4 * pz[c] + pz[d];
      const g = gx * nx[i] + gz * nz[i];
      o[i] = clamp(o[i] - g * stepSize, -lim[i], lim[i]);
      px[i] = cx[i] + nx[i] * o[i];
      pz[i] = cz[i] + nz[i] * o[i];
    }
  }

  // Curvature of the line.
  const curvature = new Float32Array(n);
  const segLen = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const c = (i + 1) % n;
    const ax = px[i] - px[a];
    const az = pz[i] - pz[a];
    const bx = px[c] - px[i];
    const bz = pz[c] - pz[i];
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    // turning left (towards +x from +z) gives negative cross in this x/z convention
    curvature[i] = -Math.atan2(cross, dot) / ((la + lb) / 2);
    segLen[i] = lb;
  }
  // Light smoothing of curvature to avoid spikes from the discretisation.
  const kSm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -2; j <= 2; j++) sum += curvature[(i + j + n) % n];
    kSm[i] = sum / 5;
  }

  const g = 9.81;
  const mu = spec.tyre.mu * gripScale * 0.95;
  const mass = spec.mass;
  const rho = 1.225;
  const drag = (v: number) => (0.5 * rho * spec.aero.cdA * v * v) / mass;
  const down = (v: number) => (0.5 * rho * spec.aero.clA * v * v) / mass;
  const topGear = spec.gears[spec.gears.length - 1] * spec.finalDrive;
  const vTop = ((spec.engine.redline * 2 * Math.PI) / 60 / topGear) * spec.wheelRadius;
  const maxLat = (v: number) => mu * (g + down(v));
  const vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(kSm[i]);
    let v = vTop;
    if (k > 1e-5) {
      // solve v^2 k = mu (g + c v^2)
      const c = (0.5 * rho * spec.aero.clA * mu) / mass;
      const denom = k - c;
      v = denom > 0 ? Math.min(vTop, Math.sqrt((mu * g) / denom)) : vTop;
    }
    vmax[i] = v;
  }
  const driveFraction = spec.drivetrain === "AWD" ? 1 : spec.drivetrain === "FWD" ? spec.frontWeight * 0.92 : (1 - spec.frontWeight) * 1.08;
  const accel = (v: number, k: number) => {
    const lat = v * v * k;
    const avail = Math.max(0, maxLat(v) ** 2 - lat * lat);
    const traction = Math.sqrt(avail) * driveFraction;
    // best gear power
    let best = 0;
    for (let gi = 0; gi < spec.gears.length; gi++) {
      const ratio = spec.gears[gi] * spec.finalDrive;
      const rpm = ((Math.max(v, 1) / spec.wheelRadius) * ratio * 60) / (2 * Math.PI);
      if (rpm > spec.engine.redline) continue;
      const t = torqueAt(spec, Math.max(rpm, spec.engine.launchRpm));
      best = Math.max(best, (t * ratio * spec.efficiency) / spec.wheelRadius / mass);
    }
    return Math.min(traction, best) - drag(v) - 0.012 * g;
  };
  const decel = (v: number, k: number) => {
    const lat = v * v * k;
    const avail = Math.max(0, maxLat(v) ** 2 - lat * lat);
    return Math.sqrt(avail) * 0.92 + drag(v);
  };
  const v = Float32Array.from(vmax);
  for (let pass = 0; pass < 3; pass++) {
    // backward (braking)
    for (let j = 0; j < n; j++) {
      const i = (n - 1 - j + n) % n;
      const nxt = (i + 1) % n;
      const vv = Math.sqrt(v[nxt] * v[nxt] + 2 * decel(v[nxt], Math.abs(kSm[nxt])) * segLen[i]);
      if (vv < v[i]) v[i] = vv;
    }
    // forward (accelerating)
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const vv = Math.sqrt(Math.max(0, v[prev] * v[prev] + 2 * accel(v[prev], Math.abs(kSm[prev])) * segLen[prev]));
      if (vv < v[i]) v[i] = vv;
    }
  }
  const phase = new Int8Array(n);
  let lapTime = 0;
  for (let i = 0; i < n; i++) {
    const nxt = (i + 1) % n;
    const dv = v[nxt] - v[i];
    phase[i] = dv < -0.05 ? -1 : dv > 0.05 ? 1 : 0;
    lapTime += segLen[i] / Math.max(1, (v[i] + v[nxt]) / 2);
  }
  // Braking zones.
  const brakeZones: RacingLine["brakeZones"] = [];
  let i0 = -1;
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    if (phase[i] === -1 && i0 < 0) i0 = i;
    if (phase[i] !== -1 && i0 >= 0) {
      const len = (i - i0 + n) % n;
      const drop = v[i0] - v[i];
      if (len * LINE_STEP > 15 && drop > 4) {
        const corner = track.nextCorner(s[i0]);
        brakeZones.push({ sStart: s[i0], sEnd: s[i], entrySpeed: v[i0], minSpeed: v[i], corner: corner.corner.index });
      }
      i0 = -1;
    }
  }
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = track.roadHeight(s[i], o[i]);
  return {
    count: n,
    step: track.length / n,
    s,
    offset: Float32Array.from(o),
    x: Float32Array.from(px),
    z: Float32Array.from(pz),
    y,
    curvature: kSm,
    speed: v,
    phase,
    brakeZones,
    lapTime,
  };
}

/** Index of the racing-line point for a centreline station. */
export function lineIndex(line: RacingLine, s: number, trackLength: number) {
  const f = ((((s % trackLength) + trackLength) % trackLength) / trackLength) * line.count;
  return Math.floor(f) % line.count;
}

/** Interpolated reference speed at centreline station s. */
export function lineSpeedAt(line: RacingLine, s: number, trackLength: number) {
  const f = ((((s % trackLength) + trackLength) % trackLength) / trackLength) * line.count;
  const i = Math.floor(f) % line.count;
  const j = (i + 1) % line.count;
  const t = f - Math.floor(f);
  return line.speed[i] + (line.speed[j] - line.speed[i]) * t;
}

export function lineOffsetAt(line: RacingLine, s: number, trackLength: number) {
  const f = ((((s % trackLength) + trackLength) % trackLength) / trackLength) * line.count;
  const i = Math.floor(f) % line.count;
  const j = (i + 1) % line.count;
  const t = f - Math.floor(f);
  return line.offset[i] + (line.offset[j] - line.offset[i]) * t;
}
