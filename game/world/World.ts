import { Surface } from "../physics/surfaces";
import { KERB_WIDTH, SHOULDER_WIDTH } from "../track/layout";
import { Frame, Projection, Track, getTrack } from "../track/Track";
import { clamp, fbm, lerp, ridged, rng, smoothstep, valueNoise } from "../util/math";

export const WATER_Y = 0;
export const CELL = 4;
const MARGIN = 460;

export interface GroundHit {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
  s: number;
  d: number;
  /** Within the paved road width (asphalt or kerb). */
  onRoad: boolean;
  hint: number;
}

export interface Pad {
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

export type Species = "pine_a" | "pine_b" | "pine_c" | "pine_d" | "birch" | "palm" | "bush" | "bushes" | "rocks" | "rock_big" | "rocks_small";

export interface Plant {
  species: Species;
  variant: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
  tint: number;
}

export interface CircleCollider {
  x: number;
  z: number;
  r: number;
  kind: "tree" | "rock" | "post" | "car";
  /** Ground velocity of a moving obstacle (another player's car), m/s. */
  vx?: number;
  vz?: number;
}

const scratchFrame = {} as Frame;

export class World {
  readonly track: Track;
  readonly x0: number;
  readonly z0: number;
  readonly cols: number; // vertices along x
  readonly rows: number; // vertices along z
  readonly heights: Float32Array;
  readonly surface: Uint8Array;
  /** Per-vertex splat weights (grass, forest floor, rock, sand) packed as bytes. */
  readonly splat: Uint8Array;
  readonly pad: Pad;
  readonly center: { x: number; z: number };
  readonly lakeDir: { x: number; z: number };
  readonly island: { x: number; z: number };
  plants: Plant[] = [];
  private colliderGrid = new Map<number, CircleCollider[]>();
  private coarse: { x: number; z: number; y: number }[] = [];
  private projS = new Float32Array(0);
  private projD = new Float32Array(0);
  private lakeS0: number;
  private lakeS1: number;
  private forestSeed = 5;

  constructor(track = getTrack()) {
    this.track = track;
    const b = track.bounds;
    this.x0 = Math.floor((b.minX - MARGIN) / CELL) * CELL;
    this.z0 = Math.floor((b.minZ - MARGIN) / CELL) * CELL;
    this.cols = Math.ceil((b.maxX + MARGIN - this.x0) / CELL) + 1;
    this.rows = Math.ceil((b.maxZ + MARGIN - this.z0) / CELL) + 1;
    this.heights = new Float32Array(this.cols * this.rows);
    this.surface = new Uint8Array(this.cols * this.rows);
    this.splat = new Uint8Array(this.cols * this.rows * 4);
    this.center = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };

    // Lake lies outside the loop along the final sections and the start/finish straight.
    const t10 = track.corners.find((c) => c.short === "T10")!;
    const t1 = track.corners.find((c) => c.short === "T1")!;
    this.lakeS0 = t10.sStart - 40;
    this.lakeS1 = t1.sApex;
    const jetty = track.corners.find((c) => c.short === "T12")!;
    const jf = track.frameAt(jetty.sApex);
    const lx = jf.x - this.center.x;
    const lz = jf.z - this.center.z;
    const ll = Math.hypot(lx, lz);
    this.lakeDir = { x: lx / ll, z: lz / ll };
    this.island = { x: jf.x + this.lakeDir.x * 330, z: jf.z + this.lakeDir.z * 330 };

    // Practice pad beside the start straight, on the inside of the loop.
    const f = track.frameAt(90);
    const edge = f.halfWidth + SHOULDER_WIDTH;
    this.pad = { s0: 25, s1: 155, d0: edge, d1: edge + 72 };

    for (let s = 0; s < track.length; s += 10) {
      const fr = track.frameAt(s);
      this.coarse.push({ x: fr.x, z: fr.z, y: fr.y });
    }
  }

  /** Generates the terrain. Yields between rows so a loading screen can animate. */
  *generate(): Generator<number> {
    const { cols, rows, track } = this;
    this.projS = new Float32Array(cols * rows);
    this.projD = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      const z = this.z0 + j * CELL;
      for (let i = 0; i < cols; i++) {
        const x = this.x0 + i * CELL;
        const p = track.projectApprox(x, z);
        const k = j * cols + i;
        this.projS[k] = p.s;
        this.projD[k] = p.d;
        this.heights[k] = this.heightFromProjection(x, z, p);
      }
      if (j % 16 === 0) yield (j / rows) * 0.8;
    }
    this.classify();
    yield 0.85;
    this.placeVegetation();
    yield 1;
  }

  generateSync() {
    const it = this.generate();
    while (!it.next().done) {
      /* run to completion */
    }
    return this;
  }

  private idwBase(x: number, z: number) {
    let sw = 0;
    let sy = 0;
    for (const c of this.coarse) {
      const d2 = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) + 900;
      const w = 1 / (d2 * Math.sqrt(d2));
      sw += w;
      sy += w * c.y;
    }
    return sy / sw;
  }

  /** Mountain factor 0..1: how far into the surrounding ranges a point is. */
  mountainFactor(x: number, z: number) {
    const dx = x - this.center.x;
    const dz = z - this.center.z;
    const r = Math.hypot(dx, dz);
    const towardLake = Math.max(0, (dx * this.lakeDir.x + dz * this.lakeDir.z) / (r || 1));
    const start = 850 + towardLake * towardLake * 1700;
    return smoothstep(start, start + 1500, r);
  }

  lakeFactor(p: Projection, f: Frame) {
    const L = this.track.length;
    const inRange = this.track.inRange(p.s, { s0: this.lakeS0, s1: this.lakeS1 + (this.lakeS1 < this.lakeS0 ? L : 0) });
    if (!inRange || p.d > 0) return 0;
    const a = this.track.delta(this.lakeS0, p.s);
    const b = this.track.delta(p.s, this.lakeS1);
    const endFade = smoothstep(0, 180, Math.min(a, b));
    const shore = f.halfWidth + SHOULDER_WIDTH + 20 + 26 * valueNoise(p.s / 70, 1.3, 21) + (1 - endFade) * 600;
    return smoothstep(shore - 6, shore + 55, -p.d);
  }

  /** 1 on the lake side of the lakeshore sections (fading in and out at their ends), else 0. */
  private lakeSide(p: Projection) {
    const L = this.track.length;
    if (p.d > 0 || !this.track.inRange(p.s, { s0: this.lakeS0, s1: this.lakeS1 + (this.lakeS1 < this.lakeS0 ? L : 0) })) return 0;
    return smoothstep(0, 180, Math.min(this.track.delta(this.lakeS0, p.s), this.track.delta(p.s, this.lakeS1)));
  }

  /**
   * The untouched landscape. Smooth, rounded grassy hills rise from the verges so the road winds
   * along the valleys between them; the lake shore stays open, and larger hills ring the valley.
   */
  natural(x: number, z: number, p: Projection, f: Frame) {
    const base = this.idwBase(x, z);
    const dist = Math.max(0, Math.abs(p.d) - f.halfWidth);
    let h = base + (fbm(x / 60, z / 60, 3, 9) - 0.5) * 2.2;
    // Rolling hills: rounded crests and saddles, some stretches more open than others.
    const crest = smoothstep(0.28, 0.74, fbm(x / 250, z / 250, 3, 3));
    const open = lerp(0.45, 1, smoothstep(0.3, 0.62, fbm(x / 800, z / 800, 2, 13)));
    const rise = smoothstep(12, 120, dist) * (1 - this.lakeSide(p));
    h += rise * open * (7 + 40 * crest);
    const m = this.mountainFactor(x, z);
    if (m > 0) h += m * (fbm(x / 1000, z / 1000, 4, 7) * 250 + ridged(x / 1500, z / 1500, 3, 7) * 110);
    const lake = this.lakeFactor(p, f) * (1 - smoothstep(0.2, 0.6, m));
    if (lake > 0) h = lerp(h, WATER_Y - 9 - 5 * valueNoise(x / 90, z / 90, 4), lake);
    // Small island in the bay.
    const id = Math.hypot(x - this.island.x, z - this.island.z) + (valueNoise(x / 25, z / 25, 12) - 0.5) * 30;
    h = Math.max(h, lerp(WATER_Y - 6, WATER_Y + 7, 1 - smoothstep(20, 75, id)));
    return h;
  }

  private heightFromProjection(x: number, z: number, p: Projection) {
    const f = this.track.frameAt(p.s, scratchFrame);
    const edge = f.halfWidth + SHOULDER_WIDTH;
    const ad = Math.abs(p.d);
    if (ad <= edge) return this.track.roadHeight(p.s, p.d, f) - 0.12;
    let h = this.natural(x, z, p, f);
    const side = p.d >= 0 ? 1 : -1;
    const edgeY = this.track.roadHeight(p.s, side * edge, f);
    const dist = ad - edge;
    const runoff = this.track.runoffWidth(p.s, p.d);
    const rail = this.track.railAt(p.s, side as 1 | -1);
    const flat = runoff + (rail ? rail.offset + 1.5 : 0);
    // Wide enough that hills roll down to the verge instead of ending in steep cuttings.
    const blend = 30 + flat;
    const verge = edgeY - 0.06 - Math.min(dist, flat) * 0.012;
    h = lerp(verge, h, smoothstep(flat, blend, dist));
    // Practice pad, flattened into the landscape (with room for the hills to roll down to it).
    const padD = this.padDistance(p);
    if (padD < 60) {
      const py = this.padHeight(p) - 0.12;
      h = lerp(py, h, smoothstep(0, 60, padD));
    }
    return h;
  }

  /** Distance from a projected point to the pad rectangle (0 inside). */
  padDistance(p: Projection) {
    const { pad } = this;
    if (p.s > this.track.length / 2) return Infinity;
    const ds = Math.max(pad.s0 - p.s, 0, p.s - pad.s1);
    const dd = Math.max(pad.d0 - p.d, 0, p.d - pad.d1);
    return Math.hypot(ds, dd);
  }

  padHeight(p: Projection) {
    const s = clamp(p.s, this.pad.s0, this.pad.s1);
    return this.track.roadHeight(s, this.pad.d0) - (Math.max(p.d, this.pad.d0) - this.pad.d0) * 0.006;
  }

  /** 0..1 tree cover: small scattered groves; most of the land is open grass. */
  forestDensity(x: number, z: number, h: number) {
    const n = fbm(x / 150, z / 150, 3, this.forestSeed) - (1 - smoothstep(2, 6, h)) * 0.12;
    return smoothstep(0.6, 0.78, n);
  }

  private classify() {
    const { cols, rows, heights } = this;
    const p: Projection = { s: 0, d: 0, i: 0, dist: 0 };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const x = this.x0 + i * CELL;
        const z = this.z0 + j * CELL;
        const h = heights[k];
        const hx = heights[j * cols + Math.min(cols - 1, i + 1)] - heights[j * cols + Math.max(0, i - 1)];
        const hz = heights[Math.min(rows - 1, j + 1) * cols + i] - heights[Math.max(0, j - 1) * cols + i];
        const slope = Math.hypot(hx, hz) / (2 * CELL);
        p.s = this.projS[k];
        p.d = this.projD[k];
        const f = this.track.frameAt(p.s, scratchFrame);
        const dist = Math.abs(p.d) - f.halfWidth - SHOULDER_WIDTH;
        let sand = 1 - smoothstep(WATER_Y + 0.35, WATER_Y + 1.3, h);
        let rock = smoothstep(0.95, 1.35, slope);
        // Groves stand in the grass: only a light scatter of leaf litter beneath them.
        const forest = this.forestDensity(x, z, h) * 0.3 * smoothstep(3, 14, dist) * (1 - sand);
        const padD = this.padDistance(p);
        if (padD < 4) sand = rock = 0;
        const mountain = this.mountainFactor(x, z);
        rock = Math.max(rock, smoothstep(0.3, 0.8, mountain) * smoothstep(0.3, 0.6, slope));
        const grass = Math.max(0, 1 - sand - rock - forest);
        const sum = grass + forest + rock + sand || 1;
        this.splat[k * 4] = Math.round((grass / sum) * 255);
        this.splat[k * 4 + 1] = Math.round((forest / sum) * 255);
        this.splat[k * 4 + 2] = Math.round((rock / sum) * 255);
        this.splat[k * 4 + 3] = Math.round((sand / sum) * 255);
        let surf = Surface.Grass;
        if (h < WATER_Y - 0.25) surf = Surface.Water;
        else if (sand > 0.5) surf = Surface.Sand;
        else if (rock > 0.5) surf = Surface.Rock;
        else if (forest > 0.5) surf = Surface.Dirt;
        this.surface[k] = surf;
      }
    }
  }

  /** Terrain height by triangle interpolation (matches the rendered mesh exactly). */
  terrainHeight(x: number, z: number, n?: { x: number; y: number; z: number }) {
    const { cols, rows, heights } = this;
    const fx = clamp((x - this.x0) / CELL, 0, cols - 1.0001);
    const fz = clamp((z - this.z0) / CELL, 0, rows - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h00 = heights[j * cols + i];
    const h10 = heights[j * cols + i + 1];
    const h01 = heights[(j + 1) * cols + i];
    const h11 = heights[(j + 1) * cols + i + 1];
    let h: number;
    let dhdx: number;
    let dhdz: number;
    if (u + v <= 1) {
      dhdx = (h10 - h00) / CELL;
      dhdz = (h01 - h00) / CELL;
      h = h00 + (h10 - h00) * u + (h01 - h00) * v;
    } else {
      dhdx = (h11 - h01) / CELL;
      dhdz = (h11 - h10) / CELL;
      h = h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
    }
    if (n) {
      const l = Math.hypot(dhdx, 1, dhdz);
      n.x = -dhdx / l;
      n.y = 1 / l;
      n.z = -dhdz / l;
    }
    return h;
  }

  terrainSurface(x: number, z: number): Surface {
    const i = clamp(Math.round((x - this.x0) / CELL), 0, this.cols - 1);
    const j = clamp(Math.round((z - this.z0) / CELL), 0, this.rows - 1);
    return this.surface[j * this.cols + i];
  }

  /** Physics ground query. `hint` is the track sample index from the previous query. */
  ground(x: number, z: number, hint: number, out: GroundHit): GroundHit {
    const { track } = this;
    const p = track.project(x, z, hint);
    const f = track.frameAt(p.s, scratchFrame);
    out.s = p.s;
    out.d = p.d;
    out.hint = p.i;
    const hw = f.halfWidth;
    const ad = Math.abs(p.d);
    const edge = hw + SHOULDER_WIDTH;
    if (ad <= edge) {
      out.y = track.roadHeight(p.s, p.d, f);
      // Normal from the road's tangent and lateral slopes.
      const lat = -Math.tan(f.bank) + (ad > hw ? -0.035 * Math.sign(p.d) : 0);
      // T = (tx, grade, tz), L = (nx, lat, nz); n = T x L
      const tx = f.tx;
      const ty = f.grade;
      const tz = f.tz;
      const lx = f.nx;
      const ly = lat;
      const lz = f.nz;
      let nx = ty * lz - tz * ly;
      let ny = tz * lx - tx * lz;
      let nz = tx * ly - ty * lx;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      if (ad <= hw) {
        out.surface = Surface.Asphalt;
        out.onRoad = true;
      } else if (ad <= hw + KERB_WIDTH && track.kerbAt(p.s, p.d)) {
        out.surface = Surface.Kerb;
        out.onRoad = true;
      } else {
        out.surface = Surface.Gravel;
        out.onRoad = false;
      }
      return out;
    }
    out.onRoad = false;
    if (p.d > 0 && this.padDistance(p) === 0) {
      out.y = this.padHeight(p);
      const up = { x: 0, y: 1, z: 0 };
      out.nx = up.x;
      out.ny = up.y;
      out.nz = up.z;
      out.surface = Surface.Asphalt;
      return out;
    }
    const n = scratchN;
    out.y = this.terrainHeight(x, z, n);
    out.nx = n.x;
    out.ny = n.y;
    out.nz = n.z;
    out.surface = out.y < WATER_Y - 0.25 ? Surface.Water : this.terrainSurface(x, z);
    return out;
  }

  // ---------------------------------------------------------------- vegetation

  private placeVegetation() {
    const rand = rng(1234);
    const { track } = this;
    const spacing = 6.5;
    const plants: Plant[] = [];
    const x1 = this.x0 + (this.cols - 1) * CELL;
    const z1 = this.z0 + (this.rows - 1) * CELL;
    for (let z = this.z0 + 8; z < z1 - 8; z += spacing) {
      for (let x = this.x0 + 8; x < x1 - 8; x += spacing) {
        const px = x + (rand() - 0.5) * spacing * 0.9;
        const pz = z + (rand() - 0.5) * spacing * 0.9;
        const p = track.projectApprox(px, pz);
        const f = track.frameAt(p.s, scratchFrame);
        const edge = f.halfWidth + SHOULDER_WIDTH;
        const dist = Math.abs(p.d) - edge;
        const side = (p.d >= 0 ? 1 : -1) as 1 | -1;
        const rail = track.railAt(p.s, side);
        const corner = track.cornerAt(p.s, 40);
        // Keep sight lines and run-off clear: more room on the outside of corners.
        let clearance = 6 + track.runoffWidth(p.s, p.d) + (rail ? rail.offset + 3 : 0);
        if (corner && side === -corner.dir) clearance += 6;
        if (dist < clearance) continue;
        if (this.padDistance(p) < 14) continue;
        // start/finish area stays open
        if (p.s < 40 || p.s > track.length - 60) {
          if (dist < 30) continue;
        }
        const y = this.terrainHeight(px, pz, scratchN);
        if (y < WATER_Y + 0.9) continue;
        const slope = Math.sqrt(1 - scratchN.y * scratchN.y) / scratchN.y;
        const forest = this.forestDensity(px, pz, y);
        const mountain = this.mountainFactor(px, pz);
        const nearLake = 1 - smoothstep(WATER_Y + 1.5, WATER_Y + 5, y);
        const r = rand();
        // Trees: a few small groves and lone palms dotted over the hills, never a wall of forest.
        let treeChance = (0.008 + 0.18 * forest) * (1 - nearLake * 0.4) * (1 - smoothstep(0.6, 0.95, slope));
        treeChance *= smoothstep(4, 14, dist - clearance);
        treeChance *= 1 - smoothstep(0.5, 0.95, mountain);
        if (r < treeChance) {
          const species: Species = rand() < 0.74 - forest * 0.24 ? "palm" : "birch";
          const variant = species === "palm" ? Math.floor(rand() * 2) : 0;
          const scale = species === "birch" ? 3.4 + rand() * 1.4 : 0.85 + rand() * 0.4;
          plants.push({ species, variant, x: px, y, z: pz, scale, rot: rand() * Math.PI * 2, tint: rand() });
          continue;
        }
        const r2 = rand();
        if (r2 < 0.01 + forest * 0.05 && dist > 2.5) {
          const species: Species = forest < 0.3 || rand() < 0.6 ? "bush" : "bushes";
          plants.push({
            species,
            variant: species === "bushes" ? Math.floor(rand() * 3) : 0,
            x: px,
            y,
            z: pz,
            scale: 0.9 + rand() * 0.9,
            rot: rand() * Math.PI * 2,
            tint: rand(),
          });
        } else if (r2 < 0.006 + smoothstep(0.45, 0.9, slope) * 0.08 + nearLake * 0.02) {
          const pick = rand();
          const species: Species = pick < 0.45 ? "rocks" : pick < 0.75 ? "rock_big" : "rocks_small";
          const scale = species === "rocks" ? 0.8 + rand() * 1.4 : species === "rock_big" ? 2 + rand() * 4 : 3 + rand() * 5;
          plants.push({
            species,
            variant: species === "rocks" ? Math.floor(rand() * 5) : 0,
            x: px,
            y: y - 0.1,
            z: pz,
            scale,
            rot: rand() * Math.PI * 2,
            tint: rand(),
          });
        }
      }
    }
    this.plants = plants;
    for (const pl of plants) {
      if (pl.species.startsWith("pine") || pl.species === "birch" || pl.species === "palm") {
        const r = pl.species === "birch" ? 0.25 * (pl.scale / 4) : pl.species === "palm" ? 0.3 * pl.scale : 0.28 * pl.scale;
        this.addCollider({ x: pl.x, z: pl.z, r, kind: "tree" });
      } else if (pl.species === "rocks" || pl.species === "rock_big") {
        this.addCollider({ x: pl.x, z: pl.z, r: pl.species === "rock_big" ? 0.3 * pl.scale : 0.45 * pl.scale, kind: "rock" });
      }
    }
  }

  private colliderKey(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  addCollider(c: CircleCollider) {
    const key = this.colliderKey(Math.floor(c.x / 16), Math.floor(c.z / 16));
    let list = this.colliderGrid.get(key);
    if (!list) this.colliderGrid.set(key, (list = []));
    list.push(c);
  }

  /** Circle colliders near a point. */
  collidersNear(x: number, z: number, radius: number, out: CircleCollider[] = []) {
    out.length = 0;
    const c0x = Math.floor((x - radius) / 16);
    const c1x = Math.floor((x + radius) / 16);
    const c0z = Math.floor((z - radius) / 16);
    const c1z = Math.floor((z + radius) / 16);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.colliderGrid.get(this.colliderKey(cx, cz));
        if (list) for (const c of list) out.push(c);
      }
    }
    return out;
  }

  /** Terrain limits for keeping the car inside the modelled area. */
  get extent() {
    return { x0: this.x0 + 30, x1: this.x0 + (this.cols - 1) * CELL - 30, z0: this.z0 + 30, z1: this.z0 + (this.rows - 1) * CELL - 30 };
  }

  /** Height of the natural landscape anywhere (used for the distant terrain ring). */
  farHeight(x: number, z: number) {
    const p = this.track.projectApprox(x, z);
    const f = this.track.frameAt(p.s, scratchFrame);
    return this.natural(x, z, p, f);
  }
}

const scratchN = { x: 0, y: 1, z: 0 };

let sharedWorld: World | null = null;
export function getWorld() {
  if (!sharedWorld) sharedWorld = new World().generateSync();
  return sharedWorld;
}
export function setWorld(w: World) {
  sharedWorld = w;
}
