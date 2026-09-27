import { clamp, lerp, smoothstep, valueNoise, wrapAngle } from "../util/math";
import { KERB_WIDTH, LAYOUT, LayoutSegment, SECTOR_NAMES, SECTOR_STARTS, SHOULDER_WIDTH, START_Y } from "./layout";

export interface Corner {
  index: number;
  name: string;
  short: string;
  dir: 1 | -1; // 1 = left
  radius: number;
  sStart: number; // entry of clothoid
  sApex: number;
  sEnd: number;
  angle: number; // degrees
}

export interface Projection {
  s: number;
  d: number; // lateral offset, + = left of travel direction
  i: number; // sample index (floor of s / step)
  dist: number;
}

export interface Frame {
  x: number;
  y: number;
  z: number;
  tx: number; // horizontal unit tangent
  tz: number;
  nx: number; // horizontal unit normal (left)
  nz: number;
  heading: number;
  bank: number;
  grade: number;
  halfWidth: number;
  curvature: number;
}

export interface Range {
  s0: number;
  s1: number;
  side: 1 | -1;
}

export interface RailRange extends Range {
  offset: number; // lateral distance from the road edge
}

const STEP = 1; // metres between samples
const GRID = 24; // spatial hash cell size

/** Heading 0 points along +z; positive heading turns towards +x (left). */
const dirX = (h: number) => Math.sin(h);
const dirZ = (h: number) => Math.cos(h);

interface Piece {
  len: number;
  k0: number;
  k1: number;
  seg: number;
}

function buildPieces(layout: LayoutSegment[]): Piece[] {
  const pieces: Piece[] = [];
  layout.forEach((seg, i) => {
    if (seg.kind === "straight") {
      pieces.push({ len: seg.len, k0: 0, k1: 0, seg: i });
    } else {
      const k = (seg.angle >= 0 ? 1 : -1) / seg.radius;
      const total = Math.abs(seg.angle) * (Math.PI / 180);
      const spiralAngle = seg.spiral / seg.radius; // two clothoids, each len/(2R)
      const arcLen = Math.max(0, (total - spiralAngle) * seg.radius);
      pieces.push({ len: seg.spiral, k0: 0, k1: k, seg: i });
      if (arcLen > 0) pieces.push({ len: arcLen, k0: k, k1: k, seg: i });
      pieces.push({ len: seg.spiral, k0: k, k1: 0, seg: i });
    }
  });
  return pieces;
}

/** Integrates the pieces; returns end point. Optionally records samples every STEP metres. */
function integrate(pieces: Piece[], record?: (s: number, x: number, z: number, h: number, k: number, seg: number) => void) {
  let x = 0;
  let z = 0;
  let h = 0;
  let s = 0;
  const ds = 0.05;
  let nextRecord = 0;
  for (const p of pieces) {
    const n = Math.max(1, Math.ceil(p.len / ds));
    const d = p.len / n;
    for (let j = 0; j < n; j++) {
      const t0 = j / n;
      const t1 = (j + 1) / n;
      const k0 = lerp(p.k0, p.k1, t0);
      const k1 = lerp(p.k0, p.k1, t1);
      if (record && s >= nextRecord - 1e-9) {
        record(s, x, z, h, k0, p.seg);
        nextRecord += STEP;
      }
      const hMid = h + ((k0 * 3 + k1) / 4) * d * 0.5;
      x += dirX(hMid) * d;
      z += dirZ(hMid) * d;
      h += ((k0 + k1) / 2) * d;
      s += d;
    }
  }
  return { x, z, h, s };
}

function resolveLayout(base: LayoutSegment[]): LayoutSegment[] {
  const layout = base.map((s) => ({ ...s })) as LayoutSegment[];
  const closing = layout.find((s) => s.kind === "turn" && s.closing) as Extract<LayoutSegment, { kind: "turn" }>;
  const others = layout.reduce((acc, s) => acc + (s.kind === "turn" && !s.closing ? s.angle : 0), 0);
  closing.angle = 360 - others;
  const adjustIdx = layout.map((s, i) => (s.kind === "straight" && s.adjust ? i : -1)).filter((i) => i >= 0);
  if (adjustIdx.length !== 2) throw new Error("Layout needs exactly two adjustable straights");
  for (let iter = 0; iter < 3; iter++) {
    const end = integrate(buildPieces(layout));
    // heading at each adjustable straight
    const headings = adjustIdx.map((idx) => {
      let h = 0;
      for (let i = 0; i < idx; i++) {
        const s = layout[i];
        if (s.kind === "turn") h += s.angle * (Math.PI / 180);
      }
      return h;
    });
    const a = [dirX(headings[0]), dirZ(headings[0])];
    const b = [dirX(headings[1]), dirZ(headings[1])];
    const det = a[0] * b[1] - a[1] * b[0];
    const ex = -end.x;
    const ez = -end.z;
    const da = (ex * b[1] - ez * b[0]) / det;
    const db = (a[0] * ez - a[1] * ex) / det;
    (layout[adjustIdx[0]] as { len: number }).len += da;
    (layout[adjustIdx[1]] as { len: number }).len += db;
  }
  for (const i of adjustIdx) {
    const seg = layout[i] as { len: number };
    if (seg.len < 20) throw new Error(`Closure made straight ${i} too short (${seg.len.toFixed(1)} m)`);
  }
  return layout;
}

/** Monotone cubic interpolation through periodic keyframes (s, v). */
function periodicMonotone(keys: { s: number; v: number }[], L: number) {
  const n = keys.length;
  const tang = new Array<number>(n).fill(0);
  const slope = (i: number) => {
    const a = keys[(i + n) % n];
    const b = keys[(i + 1 + n) % n];
    const ds = ((b.s - a.s) % L + L) % L || L;
    return (b.v - a.v) / ds;
  };
  for (let i = 0; i < n; i++) {
    const m0 = slope(i - 1);
    const m1 = slope(i);
    tang[i] = m0 * m1 <= 0 ? 0 : (2 * m0 * m1) / (m0 + m1);
  }
  return (s: number) => {
    s = ((s % L) + L) % L;
    let i = n - 1;
    for (let j = 0; j < n; j++) {
      if (keys[j].s > s) {
        i = j - 1;
        break;
      }
    }
    if (i < 0) i = n - 1;
    const a = keys[i];
    const b = keys[(i + 1) % n];
    let span = b.s - a.s;
    if (span <= 0) span += L;
    let t = s - a.s;
    if (t < 0) t += L;
    const u = t / span;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    return h00 * a.v + h10 * span * tang[i] + h01 * b.v + h11 * span * tang[(i + 1) % n];
  };
}

function boxSmooth(src: Float32Array, radius: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let j = -radius; j <= radius; j++) sum += src[(j + n) % n];
  for (let i = 0; i < n; i++) {
    out[i] = sum / (radius * 2 + 1);
    sum += src[(i + radius + 1) % n] - src[(i - radius + n) % n];
  }
  return out;
}

export class Track {
  readonly layout: LayoutSegment[];
  readonly length: number;
  readonly count: number;
  readonly step = STEP;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;
  readonly curvature: Float32Array;
  readonly bank: Float32Array;
  readonly halfWidth: Float32Array;
  readonly segIndex: Uint8Array;
  readonly segStart: number[] = [];
  readonly corners: Corner[] = [];
  readonly sectors: { name: string; s0: number; s1: number }[] = [];
  readonly kerbs: Range[] = [];
  readonly rails: RailRange[] = [];
  readonly runoffs: (Range & { width: number })[] = [];
  readonly bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  private grid = new Map<number, number[]>();

  constructor() {
    this.layout = resolveLayout(LAYOUT);
    const pieces = buildPieces(this.layout);
    const xs: number[] = [];
    const zs: number[] = [];
    const hs: number[] = [];
    const ks: number[] = [];
    const segs: number[] = [];
    const end = integrate(pieces, (s, x, z, h, k, seg) => {
      xs.push(x);
      zs.push(z);
      hs.push(h);
      ks.push(k);
      segs.push(seg);
    });
    // Drop a duplicate closing sample and spread any residual closure error along the lap.
    const L = end.s;
    this.length = L;
    let n = xs.length;
    if ((n - 1) * STEP >= L - 0.5) n -= 1;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.curvature = new Float32Array(n);
    this.bank = new Float32Array(n);
    this.halfWidth = new Float32Array(n);
    this.segIndex = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = (i * STEP) / L;
      this.x[i] = xs[i] - end.x * f;
      this.z[i] = zs[i] - end.z * f;
      this.heading[i] = wrapAngle(hs[i]);
      this.curvature[i] = ks[i];
      this.segIndex[i] = segs[i];
    }

    // Segment start positions along s.
    let acc = 0;
    for (const seg of this.layout) {
      this.segStart.push(acc);
      acc += seg.kind === "straight" ? seg.len : this.turnLength(seg);
    }

    // Elevation: keyframes at segment ends, monotone cubic, plus gentle long-wave undulation.
    const keys: { s: number; v: number }[] = [{ s: 0, v: START_Y }];
    this.layout.forEach((seg, i) => {
      const sEnd = i + 1 < this.layout.length ? this.segStart[i + 1] : L;
      if (seg.y !== undefined && sEnd < L - 1) keys.push({ s: sEnd, v: seg.y });
    });
    const elev = periodicMonotone(keys, L);
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      const und = (valueNoise(s / 90, 3.7, 11) - 0.5) * 0.7 * smoothstep(40, 120, Math.min(s, L - s));
      this.y[i] = elev(s) + und;
    }

    // Width with smooth transitions between segments.
    const rawW = new Float32Array(n);
    for (let i = 0; i < n; i++) rawW[i] = (this.layout[this.segIndex[i]].width ?? 10) / 2;
    this.halfWidth.set(boxSmooth(rawW, 20));

    // Banking follows curvature, smoothed so it builds through the transitions.
    const rawB = new Float32Array(n);
    for (let i = 0; i < n; i++) rawB[i] = clamp(this.curvature[i] * 3.2, -0.085, 0.085);
    this.bank.set(boxSmooth(boxSmooth(rawB, 18), 12));

    for (let i = 0; i < n; i++) {
      this.bounds.minX = Math.min(this.bounds.minX, this.x[i]);
      this.bounds.maxX = Math.max(this.bounds.maxX, this.x[i]);
      this.bounds.minZ = Math.min(this.bounds.minZ, this.z[i]);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, this.z[i]);
      const key = this.cellKey(Math.floor(this.x[i] / GRID), Math.floor(this.z[i] / GRID));
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    }

    this.buildCorners();
    this.buildSectors();
    this.buildRoadside();
  }

  private turnLength(seg: Extract<LayoutSegment, { kind: "turn" }>) {
    const total = Math.abs(seg.angle) * (Math.PI / 180);
    return seg.spiral * 2 + Math.max(0, (total - seg.spiral / seg.radius) * seg.radius);
  }

  private cellKey(cx: number, cz: number) {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  private buildCorners() {
    this.layout.forEach((seg, i) => {
      if (seg.kind !== "turn") return;
      const s0 = this.segStart[i];
      const len = this.turnLength(seg);
      this.corners.push({
        index: this.corners.length,
        name: seg.name,
        short: seg.short,
        dir: seg.angle >= 0 ? 1 : -1,
        radius: seg.radius,
        sStart: s0,
        sApex: s0 + len / 2,
        sEnd: s0 + len,
        angle: seg.angle,
      });
    });
  }

  private buildSectors() {
    for (let k = 0; k < SECTOR_STARTS.length; k++) {
      const s0 = this.segStart[SECTOR_STARTS[k]];
      const s1 = k + 1 < SECTOR_STARTS.length ? this.segStart[SECTOR_STARTS[k + 1]] : this.length;
      this.sectors.push({ name: SECTOR_NAMES[k], s0, s1 });
    }
  }

  private buildRoadside() {
    for (const c of this.corners) {
      if (c.radius <= 110 && !this.layout.some((l) => l.kind === "turn" && l.short === c.short && l.flat)) {
        // Inside kerb around the apex, outside kerb on exit.
        const half = Math.min(40, (c.sEnd - c.sStart) * 0.35);
        this.kerbs.push({ s0: c.sApex - half, s1: c.sApex + half, side: c.dir });
        this.kerbs.push({ s0: c.sApex + half * 0.4, s1: c.sEnd + 12, side: (-c.dir) as 1 | -1 });
      }
      if (c.radius <= 60) {
        this.runoffs.push({ s0: c.sStart - 30, s1: c.sEnd + 20, side: (-c.dir) as 1 | -1, width: 16 });
      }
    }
    const byShort = (short: string) => this.corners.find((c) => c.short === short)!;
    // Guardrails where the road runs above a drop or along the water.
    const t6 = byShort("T6");
    this.rails.push({ s0: t6.sStart - 60, s1: t6.sEnd + 25, side: (-t6.dir) as 1 | -1, offset: 17 });
    const t7 = byShort("T7");
    this.rails.push({ s0: t7.sStart - 20, s1: t7.sEnd + 40, side: (-t7.dir) as 1 | -1, offset: 6 });
    const t11 = byShort("T11");
    this.rails.push({ s0: t11.sStart - 80, s1: t11.sEnd + 60, side: -1, offset: 4.5 });
  }

  /** Wraps s into [0, length). */
  wrap(s: number) {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /** Signed distance from a to b along the loop, in (-L/2, L/2]. */
  delta(a: number, b: number) {
    let d = this.wrap(b) - this.wrap(a);
    if (d > this.length / 2) d -= this.length;
    if (d <= -this.length / 2) d += this.length;
    return d;
  }

  inRange(s: number, r: { s0: number; s1: number }) {
    const d0 = this.delta(r.s0, s);
    return d0 >= 0 && d0 <= r.s1 - r.s0;
  }

  frameAt(s: number, out: Frame = {} as Frame): Frame {
    s = this.wrap(s);
    const n = this.count;
    const f = s / STEP;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const lastSpan = i1 === 0 ? this.length - (n - 1) * STEP : STEP;
    const tt = i1 === 0 ? Math.min(1, (s - (n - 1) * STEP) / lastSpan) : t;
    out.x = lerp(this.x[i0], this.x[i1], tt);
    out.y = lerp(this.y[i0], this.y[i1], tt);
    out.z = lerp(this.z[i0], this.z[i1], tt);
    const h0 = this.heading[i0];
    const dh = wrapAngle(this.heading[i1] - h0);
    out.heading = h0 + dh * tt;
    out.tx = Math.sin(out.heading);
    out.tz = Math.cos(out.heading);
    out.nx = out.tz;
    out.nz = -out.tx;
    out.bank = lerp(this.bank[i0], this.bank[i1], tt);
    out.halfWidth = lerp(this.halfWidth[i0], this.halfWidth[i1], tt);
    out.curvature = lerp(this.curvature[i0], this.curvature[i1], tt);
    out.grade = (this.y[i1] - this.y[i0]) / lastSpan;
    return out;
  }

  /** Nearest point on the centreline. `hint` is a previous sample index for a fast local search. */
  project(x: number, z: number, hint = -1): Projection {
    const n = this.count;
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      let i = hint % n;
      let d = this.dist2(i, x, z);
      // walk downhill in both directions
      for (let iter = 0; iter < 400; iter++) {
        const fwd = (i + 1) % n;
        const back = (i - 1 + n) % n;
        const df = this.dist2(fwd, x, z);
        const db = this.dist2(back, x, z);
        if (df < d && df <= db) {
          i = fwd;
          d = df;
        } else if (db < d) {
          i = back;
          d = db;
        } else break;
      }
      // Accept the local result only where it cannot be confused with another section of road
      // (distinct sections are always more than 40 m apart).
      if (d < 16 * 16) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) {
      const cx = Math.floor(x / GRID);
      const cz = Math.floor(z / GRID);
      for (let r = 1; r <= 32; r = r < 3 ? r + 1 : r * 2) {
        let ringBest = -1;
        let ringD = Infinity;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          for (let gz = cz - r; gz <= cz + r; gz++) {
            const list = this.grid.get(this.cellKey(gx, gz));
            if (!list) continue;
            for (const i of list) {
              const d = this.dist2(i, x, z);
              if (d < ringD) {
                ringD = d;
                ringBest = i;
              }
            }
          }
        }
        // Everything within r cells is covered, so the result is exact if it lies within that radius.
        if (ringBest >= 0 && Math.sqrt(ringD) <= r * GRID) {
          best = ringBest;
          bestD = ringD;
          break;
        }
      }
      if (best < 0) {
        bestD = Infinity;
        for (let i = 0; i < n; i++) {
          const d = this.dist2(i, x, z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // Refine on the neighbouring segments.
    const out = this.refine(best, x, z);
    return out;
  }

  /**
   * Fast nearest-point search for bulk work (terrain generation): brute force over every
   * 8th sample, then a local walk. Exact except exactly on the medial axis between sections.
   */
  projectApprox(x: number, z: number): Projection {
    const n = this.count;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i += 8) {
      const d = this.dist2(i, x, z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let i = best;
    let d = bestD;
    for (let iter = 0; iter < 16; iter++) {
      const fwd = (i + 1) % n;
      const back = (i - 1 + n) % n;
      const df = this.dist2(fwd, x, z);
      const db = this.dist2(back, x, z);
      if (df < d && df <= db) {
        i = fwd;
        d = df;
      } else if (db < d) {
        i = back;
        d = db;
      } else break;
    }
    return this.refine(i, x, z);
  }

  private dist2(i: number, x: number, z: number) {
    const dx = this.x[i] - x;
    const dz = this.z[i] - z;
    return dx * dx + dz * dz;
  }

  private refine(i: number, x: number, z: number): Projection {
    const n = this.count;
    let bestS = i * STEP;
    let bestD2 = Infinity;
    let bestLat = 0;
    for (const a of [(i - 1 + n) % n, i]) {
      const b = (a + 1) % n;
      const ax = this.x[a];
      const az = this.z[a];
      const bx = this.x[b];
      const bz = this.z[b];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      let t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = clamp(t, 0, 1);
      const px = ax + ex * t;
      const pz = az + ez * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bestD2) {
        bestD2 = d2;
        const span = b === 0 ? this.length - a * STEP : STEP;
        bestS = a * STEP + t * span;
        // left normal of segment = (ez, -ex)
        const len = Math.sqrt(len2);
        bestLat = ((x - ax) * ez - (z - az) * ex) / len;
      }
    }
    const s = this.wrap(bestS);
    return { s, d: bestLat, i: Math.floor(s / STEP) % n, dist: Math.sqrt(bestD2) };
  }

  /** Road surface height at track coordinates, including banking and the shoulder fall-off. */
  roadHeight(s: number, d: number, f: Frame = this.frameAt(s, scratchFrame)) {
    const hw = f.halfWidth;
    const ad = Math.abs(d);
    let y = f.y - d * Math.tan(f.bank);
    if (ad > hw) {
      y -= (ad - hw) * 0.035;
      if (this.kerbAt(s, d) && ad < hw + KERB_WIDTH) {
        const u = (ad - hw) / KERB_WIDTH;
        y += 0.03 * Math.sin(Math.min(1, u * 1.4) * Math.PI * 0.5);
      }
    }
    return y;
  }

  /** Outer edge of the shoulder / verge, measured from the centreline. */
  edgeWidth(f: Frame) {
    return f.halfWidth + SHOULDER_WIDTH;
  }

  kerbAt(s: number, d: number) {
    const side = d >= 0 ? 1 : -1;
    for (const k of this.kerbs) if (k.side === side && this.inRange(s, k)) return true;
    return false;
  }

  runoffWidth(s: number, d: number) {
    const side = d >= 0 ? 1 : -1;
    let w = 0;
    for (const r of this.runoffs) {
      if (r.side !== side) continue;
      const d0 = this.delta(r.s0, s);
      const len = r.s1 - r.s0;
      if (d0 < -25 || d0 > len + 25) continue;
      const fade = Math.min(smoothstep(-25, 10, d0), 1 - smoothstep(len - 10, len + 25, d0));
      w = Math.max(w, r.width * fade);
    }
    return w;
  }

  railAt(s: number, side: 1 | -1): RailRange | null {
    for (const r of this.rails) if (r.side === side && this.inRange(s, r)) return r;
    return null;
  }

  cornerAt(s: number, margin = 0): Corner | null {
    for (const c of this.corners) {
      if (this.inRange(s, { s0: c.sStart - margin, s1: c.sEnd + margin })) return c;
    }
    return null;
  }

  /** Next corner whose apex is ahead of s. */
  nextCorner(s: number): { corner: Corner; dist: number } {
    let best = this.corners[0];
    let bestD = Infinity;
    for (const c of this.corners) {
      let d = this.wrap(c.sStart - s);
      if (d > this.length - 5) d -= this.length;
      if (d >= -5 && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return { corner: best, dist: bestD };
  }

  sectorAt(s: number) {
    s = this.wrap(s);
    for (let i = 0; i < this.sectors.length; i++) if (s >= this.sectors[i].s0 && s < this.sectors[i].s1) return i;
    return this.sectors.length - 1;
  }

  /** World position at (s, d) on the road surface. */
  pointAt(s: number, d: number, out = { x: 0, y: 0, z: 0 }) {
    const f = this.frameAt(s, scratchFrame2);
    out.x = f.x + f.nx * d;
    out.z = f.z + f.nz * d;
    out.y = this.roadHeight(s, d, f);
    return out;
  }
}

const scratchFrame = {} as Frame;
const scratchFrame2 = {} as Frame;

let shared: Track | null = null;
export function getTrack() {
  if (!shared) shared = new Track();
  return shared;
}
