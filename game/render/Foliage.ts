import * as THREE from "three";
import { rng } from "../util/math";
import { ASSET_BASE, loadTexture } from "./assets";

/**
 * Realistic vegetation built from photoscanned CC0 sprites (Poly Haven: fir_tree_01 twigs and
 * bark, jacaranda_tree leaves, fern_02 fronds). Branch and leaf-cluster textures are composed
 * on a canvas at load time; trees are cheap card-based meshes (~500 triangles) with soft,
 * volumetric normals and baked ambient occlusion so they light like real foliage.
 */

export interface FoliagePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface FoliageModel {
  parts: FoliagePart[];
  height: number;
  radius: number;
}

type Rect = [number, number, number, number]; // x, y, w, h in the 1024 atlas

// Sprite rectangles measured from the atlases (stems at the bottom for twigs and fern fronds).
const TWIGS: Rect[] = [
  [313, 409, 347, 385],
  [649, 463, 332, 387],
  [668, 41, 292, 337],
  [194, 48, 245, 271],
  [505, 266, 141, 143],
];
// Leaves: [rect, stem side] (-1 = stem on the left, 1 = stem on the right)
const LEAVES: [Rect, number][] = [
  [[165, 23, 847, 460], -1],
  [[250, 604, 774, 415], 1],
  [[0, 332, 439, 380], -1],
];
const FERNS: Rect[] = [
  [321, 25, 145, 757],
  [90, 114, 151, 858],
  [731, 111, 126, 806],
  [520, 27, 154, 485],
  [524, 523, 120, 466],
];

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function canvasTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** A full fir branch seen from above: tapering stem with photographed sprigs along both sides. */
function composeBranch(twigs: HTMLImageElement, seed: number) {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const r = rng(seed);
  const y0 = H / 2;
  const x0 = 24;
  const x1 = W - 40;
  const draw = (rect: Rect, x: number, y: number, angle: number, height: number) => {
    const [sx, sy, sw, sh] = rect;
    const h = height;
    const w = (sw / sh) * h;
    g.save();
    g.translate(x, y);
    g.rotate(angle + Math.PI / 2);
    g.drawImage(twigs, sx, sy, sw, sh, -w / 2, -h, w, h);
    g.restore();
  };
  // Stem
  g.strokeStyle = "#4a3524";
  g.lineCap = "round";
  for (let i = 0; i < 20; i++) {
    const t0 = i / 20;
    const t1 = (i + 1) / 20;
    g.lineWidth = 12 * (1 - t0) + 2;
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * t0, y0 + Math.sin(t0 * 3) * 4);
    g.lineTo(x0 + (x1 - x0) * t1, y0 + Math.sin(t1 * 3) * 4);
    g.stroke();
  }
  // Sprigs: larger near the base, angled towards the tip, both sides.
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = 0.04 + (i / n) * 0.9;
    const x = x0 + (x1 - x0) * t + (r() - 0.5) * 12;
    for (const side of [-1, 1]) {
      const spread = (58 - 26 * t + (r() - 0.5) * 16) * (Math.PI / 180);
      const angle = -side * spread; // 0 = along the branch, towards the tip
      const size = (230 - 120 * t) * (0.8 + r() * 0.4);
      draw(TWIGS[Math.floor(r() * 4)], x, y0 + side * 3, angle, size);
    }
    if (i % 3 === 0) draw(TWIGS[Math.floor(r() * 5)], x, y0, (r() - 0.5) * 0.4, (150 - 70 * t) * (0.8 + r() * 0.4));
  }
  draw(TWIGS[2], x1 - 20, y0, 0, 160);
  // Self-shadowing: darker towards the base and the stem.
  g.globalCompositeOperation = "source-atop";
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "rgba(10,20,8,0.3)");
  grad.addColorStop(0.45, "rgba(10,20,8,0.06)");
  grad.addColorStop(1, "rgba(10,20,8,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const vgrad = g.createLinearGradient(0, 0, 0, H);
  vgrad.addColorStop(0, "rgba(0,0,0,0)");
  vgrad.addColorStop(0.5, "rgba(8,16,6,0.1)");
  vgrad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = vgrad;
  g.fillRect(0, 0, W, H);
  return canvasTexture(c);
}

/** A bunch of leaves radiating from a twig, used for broadleaf crowns and bushes. */
function composeLeafCluster(leaves: HTMLImageElement, seed: number) {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const r = rng(seed);
  for (let i = 0; i < 11; i++) {
    const [rect, stemSide] = LEAVES[Math.floor(r() * LEAVES.length)];
    const [sx, sy, sw, sh] = rect;
    const len = S * (0.34 + r() * 0.16);
    const h = (sh / sw) * len;
    const a = r() * Math.PI * 2;
    g.save();
    g.translate(S / 2 + (r() - 0.5) * 40, S / 2 + (r() - 0.5) * 40);
    g.rotate(a);
    if (stemSide > 0) g.scale(-1, 1);
    g.drawImage(leaves, sx, sy, sw, sh, 0, -h / 2, len, h);
    g.restore();
  }
  g.globalCompositeOperation = "source-atop";
  const rad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rad.addColorStop(0, "rgba(6,14,4,0.25)");
  rad.addColorStop(1, "rgba(6,14,4,0)");
  g.fillStyle = rad;
  g.fillRect(0, 0, S, S);
  return canvasTexture(c);
}

/** Pale birch bark with dark lenticels and knots. */
function composeBirchBark(seed: number) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 512;
  const g = c.getContext("2d")!;
  const r = rng(seed);
  g.fillStyle = "#d9d4c8";
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 1400; i++) {
    const v = 200 + r() * 40;
    g.fillStyle = `rgba(${v},${v - 6},${v - 18},0.25)`;
    g.fillRect(r() * 256, r() * 512, 2 + r() * 10, 1 + r() * 2);
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(35,32,28,${0.4 + r() * 0.5})`;
    const w = 6 + r() * 40;
    g.fillRect(r() * 256, r() * 512, w, 1.5 + r() * 3);
  }
  for (let i = 0; i < 10; i++) {
    g.fillStyle = "rgba(40,36,30,0.7)";
    g.beginPath();
    g.ellipse(r() * 256, r() * 512, 6 + r() * 12, 3 + r() * 6, 0, 0, Math.PI * 2);
    g.fill();
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Collects vertices for a card-based mesh. */
class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  quad(p: THREE.Vector3[], uv: [number, number][], n: THREE.Vector3[], ao: number[]) {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i].x, p[i].y, p[i].z);
      this.nor.push(n[i].x, n[i].y, n[i].z);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(ao[i], ao[i], ao[i]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Tapered, slightly bent trunk with tiled bark UVs. */
function trunk(height: number, r0: number, r1: number, sides: number, rings: number, seed: number, uvScale = 1.6) {
  const r = rng(seed);
  const b = new Builder();
  const bendX = (r() - 0.5) * 0.06 * height;
  const bendZ = (r() - 0.5) * 0.06 * height;
  const ring = (k: number) => {
    const t = k / rings;
    const y = t * height;
    const rad = r0 + (r1 - r0) * Math.pow(t, 0.8);
    const cx = bendX * t * t;
    const cz = bendZ * t * t;
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad));
    }
    return { pts, y, rad };
  };
  let prev = ring(0);
  for (let k = 1; k <= rings; k++) {
    const cur = ring(k);
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2;
      const a1 = ((s + 1) / sides) * Math.PI * 2;
      const n0 = new THREE.Vector3(Math.cos(a0), 0.15, Math.sin(a0)).normalize();
      const n1 = new THREE.Vector3(Math.cos(a1), 0.15, Math.sin(a1)).normalize();
      const u0 = (s / sides) * 2;
      const u1 = ((s + 1) / sides) * 2;
      const v0 = (prev.y / uvScale) * 1;
      const v1 = (cur.y / uvScale) * 1;
      const ao0 = 0.55 + 0.45 * Math.min(1, prev.y / (height * 0.3));
      const ao1 = 0.55 + 0.45 * Math.min(1, cur.y / (height * 0.3));
      b.quad([prev.pts[s], prev.pts[s + 1], cur.pts[s + 1], cur.pts[s]], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [n0, n1, n1, n0], [ao0, ao0, ao1, ao1]);
    }
    prev = cur;
  }
  return b.build();
}

const UP = new THREE.Vector3(0, 1, 0);

/** Soft "canopy" normal: from the crown's centre outwards, biased upwards. */
function canopyNormal(p: THREE.Vector3, centre: THREE.Vector3, up = 0.55) {
  return p.clone().sub(centre).setY((p.y - centre.y) * 0.7).normalize().addScaledVector(UP, up).normalize();
}

/** Conifer: whorls of drooping branch cards around a tapering trunk. */
function buildFir(seed: number, height: number, opts: { crownBase: number; crownR: number; droop: number; spacing: number }) {
  const r = rng(seed);
  const b = new Builder();
  const crownBase = height * opts.crownBase;
  const centre = new THREE.Vector3(0, height * 0.42, 0);
  const trunkR = height * 0.024;
  let whorl = 0;
  for (let h = crownBase; h < height * 0.97; h += opts.spacing * (0.8 + r() * 0.4)) {
    const rel = (h - crownBase) / (height - crownBase);
    const L = opts.crownR * height * Math.pow(1 - rel, 0.92) * (0.8 + r() * 0.35) + 0.35;
    const count = rel > 0.8 ? 3 : 4 + Math.floor(r() * 3);
    const az0 = whorl++ * 2.39996 + r() * 0.5;
    for (let k = 0; k < count; k++) {
      const az = az0 + (k / count) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const pitch = -(opts.droop * (1 - rel * 0.7) + (r() - 0.5) * 0.12);
      dir.y = Math.tan(pitch);
      dir.normalize();
      const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
      const upv = new THREE.Vector3().crossVectors(dir, side).normalize();
      const base = new THREE.Vector3(0, h + (r() - 0.5) * opts.spacing * 0.8, 0).addScaledVector(dir, trunkR * (1 - h / height));
      const tip = base.clone().addScaledVector(dir, L * (0.85 + r() * 0.25));
      tip.y += L * 0.12;
      const mid = base.clone().lerp(tip, 0.52).addScaledVector(UP, -L * 0.09);
      const W = Math.max(0.32, L * (0.68 + r() * 0.15));
      const roll = (r() - 0.5) * 0.85;
      const across = side.clone().multiplyScalar(Math.cos(roll)).addScaledVector(upv, Math.sin(roll));
      const aoBase = 0.66 + 0.15 * rel;
      const aoTip = 0.9 + 0.1 * rel;
      // Arch each bough and taper its tip instead of stacking flat rectangular shelves.
      const stations = [base, mid, tip];
      const widths = [W * 0.43, W * 0.5, W * 0.18];
      for (let segment = 0; segment < 2; segment++) {
        const p = [stations[segment].clone().addScaledVector(across, -widths[segment]), stations[segment + 1].clone().addScaledVector(across, -widths[segment + 1]), stations[segment + 1].clone().addScaledVector(across, widths[segment + 1]), stations[segment].clone().addScaledVector(across, widths[segment])];
        const u0 = segment * 0.5;
        const u1 = (segment + 1) * 0.5;
        const shade0 = THREE.MathUtils.lerp(aoBase, aoTip, u0);
        const shade1 = THREE.MathUtils.lerp(aoBase, aoTip, u1);
        b.quad(p, [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], p.map((q) => canopyNormal(q, centre)), [shade0, shade1, shade1, shade0]);
      }
      // Vertical card for volume from the side
      const vW = W * 0.78;
      const across2 = upv.clone().multiplyScalar(Math.cos(roll)).addScaledVector(side, -Math.sin(roll));
      const p2 = [base.clone().addScaledVector(across2, -vW * 0.5), tip.clone().addScaledVector(across2, -vW * 0.5), tip.clone().addScaledVector(across2, vW * 0.5), base.clone().addScaledVector(across2, vW * 0.5)];
      b.quad(p2, [[0, 0], [1, 0], [1, 1], [0, 1]], p2.map((q) => canopyNormal(q, centre)), [aoBase, aoTip, aoTip, aoBase]);
    }
  }
  // Leader at the top.
  for (const a of [0, Math.PI / 2]) {
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.35);
    const y0 = height * 0.9;
    const p = [new THREE.Vector3(-d.x, y0, -d.z), new THREE.Vector3(-d.x, height, -d.z), new THREE.Vector3(d.x, height, d.z), new THREE.Vector3(d.x, y0, d.z)];
    b.quad(p, [[0, 0.2], [1, 0.2], [1, 0.8], [0, 0.8]], p.map(() => UP.clone()), [0.8, 1, 1, 0.8]);
  }
  return { foliage: b.build(), trunk: trunk(height * 0.96, trunkR, trunkR * 0.12, 7, 6, seed + 1) };
}

/** Broadleaf (birch-like): slim pale trunk, a few limbs, a crown of leaf clusters. */
function buildBroadleaf(seed: number, height: number) {
  const r = rng(seed);
  const b = new Builder();
  const centre = new THREE.Vector3((r() - 0.5) * 0.08 * height, height * 0.66, (r() - 0.5) * 0.08 * height);
  const rx = height * (0.2 + r() * 0.06);
  const ry = height * (0.3 + r() * 0.05);
  const card = height * 0.26;
  const clusters = 90;
  for (let i = 0; i < clusters; i++) {
    // Points on/inside an ellipsoid, denser near the surface.
    const u = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const rr = Math.pow(r(), 0.35);
    const dirv = new THREE.Vector3(Math.sqrt(1 - u * u) * Math.cos(a), u, Math.sqrt(1 - u * u) * Math.sin(a));
    const lobe = 0.82 + 0.18 * Math.sin(a * 3 + u * 2);
    const p = new THREE.Vector3(centre.x + dirv.x * rx * rr * lobe + u * height * 0.04, centre.y + dirv.y * ry * rr, centre.z + dirv.z * rx * rr * lobe);
    // Card facing roughly outwards, random spin.
    const n = dirv.clone().addScaledVector(UP, 0.3).normalize();
    const t1 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const spin = r() * Math.PI * 2;
    const ax = t1.clone().multiplyScalar(Math.cos(spin)).addScaledVector(t2, Math.sin(spin)).multiplyScalar(card * (0.8 + r() * 0.5) * 0.5);
    const ay = t2.clone().multiplyScalar(Math.cos(spin)).addScaledVector(t1, -Math.sin(spin)).multiplyScalar(card * (0.8 + r() * 0.5) * 0.5);
    const q = [p.clone().sub(ax).sub(ay), p.clone().add(ax).sub(ay), p.clone().add(ax).add(ay), p.clone().sub(ax).add(ay)];
    const ao = 0.45 + 0.55 * rr * (0.6 + 0.4 * (dirv.y * 0.5 + 0.5));
    b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], q.map((v) => canopyNormal(v, centre, 0.4)), [ao, ao, ao, ao]);
  }
  const tr = trunk(height * 0.78, height * 0.018, height * 0.006, 6, 6, seed + 3, 1.2);
  return { foliage: b.build(), trunk: tr };
}

/** Low shrub of leaf clusters. */
function buildBush(seed: number, height: number) {
  const r = rng(seed);
  const b = new Builder();
  const centre = new THREE.Vector3(0, height * 0.45, 0);
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2;
    const u = r() * 0.9;
    const dirv = new THREE.Vector3(Math.cos(a) * Math.sqrt(1 - u * u), u, Math.sin(a) * Math.sqrt(1 - u * u));
    const p = centre.clone().add(new THREE.Vector3(dirv.x * height * 0.6, dirv.y * height * 0.45, dirv.z * height * 0.6).multiplyScalar(0.4 + r() * 0.6));
    const n = dirv.clone().addScaledVector(UP, 0.4).normalize();
    const t1 = new THREE.Vector3().crossVectors(n, UP).normalize();
    if (t1.lengthSq() < 0.01) t1.set(1, 0, 0);
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const s = height * (0.45 + r() * 0.25);
    const q = [p.clone().addScaledVector(t1, -s).addScaledVector(t2, -s), p.clone().addScaledVector(t1, s).addScaledVector(t2, -s), p.clone().addScaledVector(t1, s).addScaledVector(t2, s), p.clone().addScaledVector(t1, -s).addScaledVector(t2, s)];
    const ao = 0.5 + 0.5 * (dirv.y * 0.5 + 0.5);
    b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], q.map((v) => canopyNormal(v, centre, 0.5)), [ao, ao, ao, ao]);
  }
  return b.build();
}

/** Fern: arching fronds radiating from the ground. */
function buildFern(seed: number, height: number) {
  const r = rng(seed);
  const b = new Builder();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const [sx, sy, sw, sh] = FERNS[Math.floor(r() * FERNS.length)];
    const u0 = sx / 1024;
    const u1 = (sx + sw) / 1024;
    const vTop = 1 - sy / 1024;
    const vBot = 1 - (sy + sh) / 1024;
    const az = (i / n) * Math.PI * 2 + r() * 0.5;
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const len = height * (1.1 + r() * 0.5);
    const w = (len * sw) / sh;
    // two segments: rising, then arching outwards
    const p0 = new THREE.Vector3(0, 0, 0);
    const p1 = dir.clone().multiplyScalar(len * 0.35).setY(height * 0.75);
    const p2 = dir.clone().multiplyScalar(len * 0.85).setY(height * 0.45);
    const vMid = vBot + (vTop - vBot) * 0.45;
    const nrm = UP.clone().addScaledVector(dir, 0.3).normalize();
    b.quad([p0.clone().addScaledVector(side, -w * 0.3), p0.clone().addScaledVector(side, w * 0.3), p1.clone().addScaledVector(side, w * 0.5), p1.clone().addScaledVector(side, -w * 0.5)], [[u0, vBot], [u1, vBot], [u1, vMid], [u0, vMid]], [nrm, nrm, nrm, nrm], [0.45, 0.45, 0.8, 0.8]);
    b.quad([p1.clone().addScaledVector(side, -w * 0.5), p1.clone().addScaledVector(side, w * 0.5), p2.clone().addScaledVector(side, w * 0.4), p2.clone().addScaledVector(side, -w * 0.4)], [[u0, vMid], [u1, vMid], [u1, vTop], [u0, vTop]], [nrm, nrm, nrm, nrm], [0.8, 0.8, 1, 1]);
  }
  return b.build();
}

function foliageMaterial(map: THREE.Texture, color: number) {
  return new THREE.MeshStandardMaterial({
    map,
    color,
    alphaTest: 0.32,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    envMapIntensity: 0.9,
    emissive: new THREE.Color(0x0d1a08),
  });
}

/** Builds every vegetation model used by the forest. */
export async function buildFoliageModels(): Promise<Map<string, FoliageModel>> {
  const [twigs, leaves, fernTex, bark, barkNor] = await Promise.all([
    loadImage(`${ASSET_BASE}/foliage/twigs.webp`),
    loadImage(`${ASSET_BASE}/foliage/leaves.webp`),
    loadTexture("foliage/fern.webp"),
    loadTexture("foliage/bark.jpg"),
    loadTexture("foliage/bark_nor.jpg", false),
  ]);
  fernTex.wrapS = fernTex.wrapT = THREE.ClampToEdgeWrapping;
  const models = new Map<string, FoliageModel>();
  const barkMat = new THREE.MeshStandardMaterial({ map: bark, normalMap: barkNor, roughness: 0.95, vertexColors: true, color: 0xb8aa98 });
  const birchBark = new THREE.MeshStandardMaterial({ map: composeBirchBark(7), roughness: 0.8, vertexColors: true });
  const branchTex = [composeBranch(twigs, 11), composeBranch(twigs, 29)];
  const leafTex = [composeLeafCluster(leaves, 5), composeLeafCluster(leaves, 17)];
  const firMats = [foliageMaterial(branchTex[0], 0xd6e8c6), foliageMaterial(branchTex[1], 0xc8e0b6)];
  const leafMats = [foliageMaterial(leafTex[0], 0xa8d27c), foliageMaterial(leafTex[1], 0xb4d88a)];

  // Conifers: the old species keys keep the world's placement unchanged.
  const firs: [string, number, { crownBase: number; crownR: number; droop: number; spacing: number }][] = [
    ["pine_a", 8.2, { crownBase: 0.16, crownR: 0.24, droop: 0.38, spacing: 0.34 }], // spruce, drooping
    ["pine_b", 9.6, { crownBase: 0.3, crownR: 0.2, droop: 0.2, spacing: 0.4 }], // tall fir
    ["pine_c", 7.4, { crownBase: 0.12, crownR: 0.27, droop: 0.3, spacing: 0.32 }], // full, bushy
    ["pine_d", 8.8, { crownBase: 0.22, crownR: 0.18, droop: 0.45, spacing: 0.36 }], // slender
  ];
  firs.forEach(([key, h, o], i) => {
    const { foliage, trunk: tr } = buildFir(100 + i * 17, h, o);
    models.set(`${key}:0`, { parts: [{ geometry: tr, material: barkMat }, { geometry: foliage, material: firMats[i % 2] }], height: h, radius: h * o.crownR });
  });
  const bl = buildBroadleaf(301, 2.7);
  models.set("birch:0", { parts: [{ geometry: bl.trunk, material: birchBark }, { geometry: bl.foliage, material: leafMats[0] }], height: 2.7, radius: 0.7 });
  models.set("bush:0", { parts: [{ geometry: buildBush(41, 1.1), material: leafMats[1] }], height: 1.1, radius: 0.8 });
  const fernMat = foliageMaterial(fernTex, 0x9fbf82);
  for (let v = 0; v < 3; v++) models.set(`bushes:${v}`, { parts: [{ geometry: buildFern(61 + v * 13, 0.7), material: fernMat }], height: 0.7, radius: 0.8 });
  // Fit distant sprites to the actual crown, including outlying leaves and branch tips.
  for (const model of models.values()) {
    const bounds = new THREE.Box3();
    for (const part of model.parts) {
      part.geometry.computeBoundingBox();
      bounds.union(part.geometry.boundingBox!);
    }
    model.height = bounds.max.y + 0.08;
    model.radius = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z)) + 0.08;
  }
  return models;
}

/** Photo-textured, smooth-shaded material for the rock meshes (world-space triplanar mapping). */
export function rockMaterial(tex: THREE.Texture) {
  const m = new THREE.MeshStandardMaterial({ color: 0xb3b0a8, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tRock = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockNrm;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
#ifdef USE_INSTANCING
vRockPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
vRockNrm = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal);
#else
vRockPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRockNrm = normalize(mat3(modelMatrix) * objectNormal);
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D tRock;\nvarying vec3 vRockPos;\nvarying vec3 vRockNrm;")
      .replace(
        "#include <map_fragment>",
        `vec3 bw = pow(abs(normalize(vRockNrm)), vec3(4.0));
bw /= (bw.x + bw.y + bw.z);
vec3 rp = vRockPos / 3.5;
vec3 rock = texture2D(tRock, rp.yz).rgb * bw.x + texture2D(tRock, rp.xz).rgb * bw.y + texture2D(tRock, rp.xy).rgb * bw.z;
// moss on top faces
rock = mix(rock, rock * vec3(0.55, 0.75, 0.4), smoothstep(0.55, 0.9, normalize(vRockNrm).y) * 0.6);
diffuseColor.rgb *= rock * 1.25;`,
      );
  };
  m.customProgramCacheKey = () => "rock-triplanar";
  return m;
}
