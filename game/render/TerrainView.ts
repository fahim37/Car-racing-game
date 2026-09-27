import * as THREE from "three";
import { CELL, World, WATER_Y } from "../world/World";
import { clamp, fbm, smoothstep } from "../util/math";
import { loadTexture } from "./assets";

const CHUNK = 32; // cells per chunk side

interface Chunk {
  i0: number;
  j0: number;
  center: THREE.Vector3;
  lods: (THREE.Mesh | null)[];
  current: number;
  group: THREE.Group;
}

export interface TerrainTextures {
  grass: THREE.Texture;
  forest: THREE.Texture;
  rock: THREE.Texture;
  sand: THREE.Texture;
}

export async function loadTerrainTextures(): Promise<TerrainTextures> {
  const [grass, forest, rock, sand] = await Promise.all([
    loadTexture("textures/leafy_grass_diffuse.jpg"),
    loadTexture("textures/forrest_ground_03_diffuse.jpg"),
    loadTexture("textures/aerial_rocks_02_diffuse.jpg"),
    loadTexture("textures/gravelly_sand_diffuse.jpg"),
  ]);
  return { grass, forest, rock, sand };
}

/** Terrain splat material shared by the near terrain chunks and the road verges. */
export function makeTerrainMaterial(tex: TerrainTextures) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const uniforms = {
    tGrass: { value: tex.grass },
    tForest: { value: tex.forest },
    tRock: { value: tex.rock },
    tSand: { value: tex.sand },
    uWet: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 splat;
varying vec4 vSplat;
varying vec3 vTWPos;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
vSplat = splat;
vTWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D tGrass;
uniform sampler2D tForest;
uniform sampler2D tRock;
uniform sampler2D tSand;
uniform float uWet;
varying vec4 vSplat;
varying vec3 vTWPos;
vec3 antiTile(sampler2D t, vec2 uv) {
  vec3 a = texture2D(t, uv).rgb;
  vec3 b = texture2D(t, uv * 0.27 + vec2(0.37, 0.71)).rgb;
  return mix(a, b, 0.4);
}`,
      )
      .replace(
        "#include <map_fragment>",
        `
vec2 wuv = vTWPos.xz;
vec4 w0 = max(vSplat, 0.0);
// Only sample the layers present here (terrain is spatially coherent, so branching is cheap),
// and weight them by texture brightness so transitions stay crisp instead of muddy.
vec3 terr = vec3(0.0);
vec4 w = vec4(0.0);
if (w0.x > 0.02) {
  vec3 c = antiTile(tGrass, wuv / 6.0) * vec3(0.62, 0.92, 0.42);
  c = mix(c, c * vec3(0.85, 1.06, 0.8), smoothstep(0.35, 0.7, texture2D(tGrass, wuv / 90.0).r));
  w.x = pow(w0.x * (dot(c, vec3(0.33)) * 0.6 + 0.4), 2.0);
  terr += c * w.x;
}
if (w0.y > 0.02) {
  vec3 c = texture2D(tForest, wuv / 5.0).rgb * vec3(0.9, 0.86, 0.78);
  w.y = pow(w0.y * (dot(c, vec3(0.33)) * 0.6 + 0.4), 2.0);
  terr += c * w.y;
}
if (w0.z > 0.02) {
  vec3 c = texture2D(tRock, (wuv + vec2(vTWPos.y * 0.7)) / 9.0).rgb * vec3(0.95, 0.95, 0.98);
  w.z = pow(w0.z * (dot(c, vec3(0.33)) * 0.6 + 0.4), 2.0);
  terr += c * w.z;
}
if (w0.w > 0.02) {
  vec3 c = texture2D(tSand, wuv / 4.0).rgb * vec3(1.05, 1.0, 0.92);
  w.w = pow(w0.w * (dot(c, vec3(0.33)) * 0.6 + 0.4), 2.0);
  terr += c * w.w;
}
float wsum = max(w.x + w.y + w.z + w.w, 1e-4);
terr /= wsum;
w /= wsum;
// Large-scale variation so meadows are not uniform.
float macro = texture2D(tForest, wuv / 170.0).g;
terr *= mix(0.82, 1.14, macro);
terr *= mix(1.0, 0.62, uWet);
diffuseColor.rgb *= terr;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = mix(roughness, 0.55, uWet * (1.0 - w.z * 0.5));`,
      );
  };
  mat.customProgramCacheKey = () => "terrain-splat";
  return { material: mat, uniforms };
}

export class TerrainView {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: ReturnType<typeof makeTerrainMaterial>["uniforms"];
  private chunks: Chunk[] = [];
  private normals: Float32Array;
  far: THREE.Mesh | null = null;

  constructor(
    private world: World,
    textures: TerrainTextures,
  ) {
    const { material, uniforms } = makeTerrainMaterial(textures);
    this.material = material;
    this.uniforms = uniforms;
    this.normals = this.computeNormals();
    const cx = Math.ceil((world.cols - 1) / CHUNK);
    const cz = Math.ceil((world.rows - 1) / CHUNK);
    for (let a = 0; a < cx; a++) {
      for (let b = 0; b < cz; b++) {
        const i0 = a * CHUNK;
        const j0 = b * CHUNK;
        const ic = Math.min(world.cols - 1, i0 + CHUNK / 2);
        const jc = Math.min(world.rows - 1, j0 + CHUNK / 2);
        const center = new THREE.Vector3(world.x0 + ic * CELL, world.heights[jc * world.cols + ic], world.z0 + jc * CELL);
        const group = new THREE.Group();
        this.group.add(group);
        this.chunks.push({ i0, j0, center, lods: [null, null, null], current: -1, group });
      }
    }
  }

  private computeNormals() {
    const { cols, rows, heights } = this.world;
    const n = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const hl = heights[j * cols + Math.max(0, i - 1)];
        const hr = heights[j * cols + Math.min(cols - 1, i + 1)];
        const hd = heights[Math.max(0, j - 1) * cols + i];
        const hu = heights[Math.min(rows - 1, j + 1) * cols + i];
        const nx = hl - hr;
        const nz = hd - hu;
        const ny = 2 * CELL;
        const l = Math.hypot(nx, ny, nz);
        const k = (j * cols + i) * 3;
        n[k] = nx / l;
        n[k + 1] = ny / l;
        n[k + 2] = nz / l;
      }
    }
    return n;
  }

  private buildChunk(c: Chunk, lod: number) {
    const w = this.world;
    const step = 1 << lod;
    const i1 = Math.min(w.cols - 1, c.i0 + CHUNK);
    const j1 = Math.min(w.rows - 1, c.j0 + CHUNK);
    const ni = Math.floor((i1 - c.i0) / step) + 1;
    const nj = Math.floor((j1 - c.j0) / step) + 1;
    const skirt = 2 * (ni + nj);
    const vcount = ni * nj + skirt;
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const spl = new Uint8Array(vcount * 4);
    const idx: number[] = [];
    let v = 0;
    const put = (i: number, j: number, drop: number) => {
      const k = j * w.cols + i;
      pos[v * 3] = w.x0 + i * CELL;
      pos[v * 3 + 1] = w.heights[k] - drop;
      pos[v * 3 + 2] = w.z0 + j * CELL;
      nor[v * 3] = this.normals[k * 3];
      nor[v * 3 + 1] = this.normals[k * 3 + 1];
      nor[v * 3 + 2] = this.normals[k * 3 + 2];
      spl[v * 4] = w.splat[k * 4];
      spl[v * 4 + 1] = w.splat[k * 4 + 1];
      spl[v * 4 + 2] = w.splat[k * 4 + 2];
      spl[v * 4 + 3] = w.splat[k * 4 + 3];
      return v++;
    };
    const grid: number[] = [];
    for (let b = 0; b < nj; b++) for (let a = 0; a < ni; a++) grid.push(put(c.i0 + a * step, c.j0 + b * step, 0));
    const g = (a: number, b: number) => grid[b * ni + a];
    for (let b = 0; b < nj - 1; b++) {
      for (let a = 0; a < ni - 1; a++) {
        // Same diagonal as World.terrainHeight so physics matches the visible surface.
        idx.push(g(a, b), g(a, b + 1), g(a + 1, b));
        idx.push(g(a, b + 1), g(a + 1, b + 1), g(a + 1, b));
      }
    }
    // Skirts hide cracks between neighbouring LODs.
    const drop = 3 + step * 1.5;
    const edge = (list: [number, number][], flip: boolean) => {
      const top = list.map(([a, b]) => g(a, b));
      const bottom = list.map(([a, b]) => put(c.i0 + a * step, c.j0 + b * step, drop));
      for (let k = 0; k < list.length - 1; k++) {
        if (flip) idx.push(top[k], bottom[k], top[k + 1], top[k + 1], bottom[k], bottom[k + 1]);
        else idx.push(top[k], top[k + 1], bottom[k], top[k + 1], bottom[k + 1], bottom[k]);
      }
    };
    const rowA: [number, number][] = [];
    const rowB: [number, number][] = [];
    for (let a = 0; a < ni; a++) {
      rowA.push([a, 0]);
      rowB.push([a, nj - 1]);
    }
    const colA: [number, number][] = [];
    const colB: [number, number][] = [];
    for (let b = 0; b < nj; b++) {
      colA.push([0, b]);
      colB.push([ni - 1, b]);
    }
    edge(rowA, false);
    edge(rowB, true);
    edge(colA, true);
    edge(colB, false);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute("splat", new THREE.BufferAttribute(spl.subarray(0, v * 4), 4, true));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Picks the level of detail for each chunk from the camera distance. */
  update(camera: THREE.Vector3, lodBias = 1) {
    for (const c of this.chunks) {
      const d = Math.hypot(c.center.x - camera.x, c.center.z - camera.z) / lodBias;
      let lod = d < 260 ? 0 : d < 620 ? 1 : 2;
      // hysteresis
      if (c.current >= 0 && Math.abs(lod - c.current) === 1) {
        const bounds = [260, 620];
        const edge = bounds[Math.min(lod, c.current)];
        if (Math.abs(d - edge) < 25) lod = c.current;
      }
      if (lod === c.current) continue;
      if (!c.lods[lod]) c.lods[lod] = this.buildChunk(c, lod);
      c.group.clear();
      c.group.add(c.lods[lod]!);
      c.current = lod;
    }
  }

  /** Distant hills and mountains surrounding the modelled area (visual only). */
  buildFar(radius = 7000, spacing = 70) {
    const w = this.world;
    const n = Math.floor((radius * 2) / spacing) + 1;
    const x0 = w.center.x - radius;
    const z0 = w.center.z - radius;
    const inner = { x0: w.x0, x1: w.x0 + (w.cols - 1) * CELL, z0: w.z0, z1: w.z0 + (w.rows - 1) * CELL };
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const hs = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * spacing;
        const z = z0 + j * spacing;
        const inside = x > inner.x0 + 8 && x < inner.x1 - 8 && z > inner.z0 + 8 && z < inner.z1 - 8;
        let h: number;
        if (inside) h = w.terrainHeight(x, z) - 4;
        else {
          h = w.farHeight(x, z);
          // Tuck the ring slightly under the detailed terrain near the seam.
          const dx = Math.max(inner.x0 - x, 0, x - inner.x1);
          const dz = Math.max(inner.z0 - z, 0, z - inner.z1);
          h -= 3 * (1 - smoothstep(0, 250, Math.hypot(dx, dz)));
        }
        hs[j * n + i] = h;
        pos.set([x, h, z], (j * n + i) * 3);
      }
    }
    const green = new THREE.Color(0x2c4a22);
    const meadow = new THREE.Color(0x5d7a33);
    const rock = new THREE.Color(0x6d6a62);
    const snow = new THREE.Color(0xe8edf2);
    const sand = new THREE.Color(0x9d8f6a);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const h = hs[k];
        const hx = hs[j * n + Math.min(n - 1, i + 1)] - hs[j * n + Math.max(0, i - 1)];
        const hz = hs[Math.min(n - 1, j + 1) * n + i] - hs[Math.max(0, j - 1) * n + i];
        const slope = Math.hypot(hx, hz) / (2 * spacing);
        const x = x0 + i * spacing;
        const z = z0 + j * spacing;
        const forest = smoothstep(0.35, 0.55, fbm(x / 500, z / 500, 3, 44));
        c.copy(meadow).lerp(green, clamp(forest + smoothstep(20, 120, h) * 0.6, 0, 1));
        c.lerp(rock, smoothstep(0.55, 0.95, slope) * 0.9 + smoothstep(260, 420, h) * 0.5);
        c.lerp(snow, smoothstep(430, 520, h + fbm(x / 300, z / 300, 2, 3) * 60) * (1 - smoothstep(0.9, 1.4, slope)));
        if (h < WATER_Y + 1.5) c.lerp(sand, 0.7);
        col.set([c.r, c.g, c.b], k * 3);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + n, a + n + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.far = mesh;
    this.group.add(mesh);
    return mesh;
  }

  setWetness(w: number) {
    this.uniforms.uWet.value = w;
  }
}
