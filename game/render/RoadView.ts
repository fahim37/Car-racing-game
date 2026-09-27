import * as THREE from "three";
import { KERB_WIDTH, SHOULDER_WIDTH } from "../track/layout";
import { RacingLine, lineOffsetAt } from "../track/racingLine";
import { Track } from "../track/Track";
import { World } from "../world/World";
import { loadTexture } from "./assets";

const TILE = 5; // metres per asphalt texture repeat

export interface RoadTextures {
  asphalt: THREE.Texture;
  asphaltNormal: THREE.Texture;
  asphaltRough: THREE.Texture;
  gravel: THREE.Texture;
  gravelNormal: THREE.Texture;
}

export async function loadRoadTextures(): Promise<RoadTextures> {
  const [asphalt, asphaltNormal, asphaltRough, gravel, gravelNormal] = await Promise.all([
    loadTexture("textures/asphalt_track_diffuse.jpg"),
    loadTexture("textures/asphalt_track_nor_gl.jpg", false),
    loadTexture("textures/asphalt_track_rough.jpg", false),
    loadTexture("textures/gravel_road_diffuse.jpg"),
    loadTexture("textures/gravel_road_nor_gl.jpg", false),
  ]);
  return { asphalt, asphaltNormal, asphaltRough, gravel, gravelNormal };
}

const ROAD_COMMON = `
float rhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rhash(i), rhash(i + vec2(1, 0)), f.x), mix(rhash(i + vec2(0, 1)), rhash(i + vec2(1, 1)), f.x), f.y);
}`;

function makeAsphaltMaterial(tex: RoadTextures, trackLength: number) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.asphalt,
    normalMap: tex.asphaltNormal,
    roughnessMap: tex.asphaltRough,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 1,
    metalness: 0,
    color: 0xcacaca,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const uniforms = { uWet: { value: 0 }, uTrackLength: { value: trackLength } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 roadInfo; // d, s, halfWidth, racing line offset
varying vec4 vRoad;`,
      )
      .replace("#include <uv_vertex>", `#include <uv_vertex>\nvRoad = roadInfo;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWet;
uniform float uTrackLength;
varying vec4 vRoad;
${ROAD_COMMON}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
float d = vRoad.x; float s = vRoad.y; float hw = vRoad.z; float lineOff = vRoad.w;
// Low-frequency tone variation and anti-tiling.
vec3 base = diffuseColor.rgb;
vec3 far = texture2D(map, vMapUv * 0.21 + vec2(0.31, 0.17)).rgb;
diffuseColor.rgb = mix(base, far, 0.35);
diffuseColor.rgb *= mix(0.9, 1.08, rnoise(vec2(d * 0.15, s * 0.02)));
// Repair patches: slightly darker, fresher tar with sealed seams.
float cell = floor(s / 23.0);
float h = rhash(vec2(cell, 3.1));
float patchMask = 0.0;
float seam = 0.0;
if (h < 0.32) {
  float ps0 = cell * 23.0 + 2.0 + rhash(vec2(cell, 1.7)) * 8.0;
  float plen = 3.0 + rhash(vec2(cell, 5.3)) * 9.0;
  float pd0 = (rhash(vec2(cell, 7.9)) - 0.5) * hw * 1.4;
  float pw = 1.2 + rhash(vec2(cell, 9.1)) * 2.4;
  vec2 q = vec2(abs(s - (ps0 + plen * 0.5)) - plen * 0.5, abs(d - pd0) - pw * 0.5);
  float inside = max(q.x, q.y);
  patchMask = 1.0 - smoothstep(-0.02, 0.02, inside);
  seam = 1.0 - smoothstep(0.0, 0.06, abs(inside));
}
diffuseColor.rgb *= mix(1.0, 0.8, patchMask);
diffuseColor.rgb *= mix(1.0, 0.55, seam);
// Rubbered-in tyre tracks along the usual line.
float trackA = abs(d - (lineOff + 0.78));
float trackB = abs(d - (lineOff - 0.78));
float rubber = (1.0 - smoothstep(0.1, 0.5, trackA)) + (1.0 - smoothstep(0.1, 0.5, trackB));
diffuseColor.rgb *= mix(1.0, 0.86, clamp(rubber, 0.0, 1.0) * 0.8);
// Markings: edge lines, dashed centre line, start/finish checkers.
float paint = 0.0;
float edgeLine = 1.0 - smoothstep(0.065, 0.085, abs(abs(d) - (hw - 0.32)));
paint = max(paint, edgeLine);
float dash = step(mod(s, 12.0), 4.0) * (1.0 - smoothstep(0.055, 0.075, abs(d)));
paint = max(paint, dash * step(9.0, hw * 2.0));
float sl = min(s, uTrackLength - s);
if (sl < 1.25 && s < uTrackLength - 0.01) {
  float chk = mod(floor(d / 0.625) + floor(s / 0.625), 2.0);
  diffuseColor.rgb = mix(vec3(0.03), vec3(0.85), chk);
}
float wear = mix(0.7, 1.0, rnoise(vec2(d * 3.0, s * 0.8)));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82), paint * wear);
// Wet asphalt darkens.
diffuseColor.rgb *= mix(1.0, 0.5, uWet * (1.0 - paint * 0.6));`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor * 0.95, 0.55, paint);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.9, patchMask);
float puddle = smoothstep(0.55, 0.75, rnoise(vec2(d * 0.35, s * 0.08)));
roughnessFactor = mix(roughnessFactor, mix(0.38, 0.2, puddle), uWet);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = normalize(mix(normal, normalize(vNormal), clamp(paint + uWet * 0.6, 0.0, 1.0)));`,
      );
  };
  mat.customProgramCacheKey = () => "asphalt-road";
  return { material: mat, uniforms };
}

function makeShoulderMaterial(tex: RoadTextures) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.gravel,
    normalMap: tex.gravelNormal,
    roughness: 0.95,
    color: 0xd8d0c0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const uniforms = { uWet: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 roadInfo; // d, s, halfWidth, kerb flag
varying vec4 vRoad;`,
      )
      .replace("#include <uv_vertex>", `#include <uv_vertex>\nvRoad = roadInfo;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWet;
varying vec4 vRoad;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
float ad = abs(vRoad.x) - vRoad.z;
float kerb = step(0.5, vRoad.w) * (1.0 - step(${KERB_WIDTH.toFixed(2)}, ad));
float stripe = step(0.5, fract(vRoad.y / 2.4));
vec3 kerbCol = mix(vec3(0.62, 0.05, 0.04), vec3(0.8, 0.8, 0.78), stripe);
diffuseColor.rgb = mix(diffuseColor.rgb, kerbCol, kerb);
diffuseColor.rgb *= mix(1.0, 0.6, uWet);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.45, kerb);
roughnessFactor = mix(roughnessFactor, 0.25, uWet * kerb);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = normalize(mix(normal, normalize(vNormal), kerb));`,
      );
  };
  mat.customProgramCacheKey = () => "road-shoulder";
  return { material: mat, uniforms };
}

export class RoadView {
  readonly group = new THREE.Group();
  readonly asphaltUniforms: { uWet: { value: number }; uTrackLength: { value: number } };
  readonly shoulderUniforms: { uWet: { value: number } };
  private lineMesh: THREE.Mesh | null = null;
  private lineUniforms = {
    uPlayerS: { value: 0 },
    uPlayerV: { value: 0 },
    uDecel: { value: 9 },
    uTrackLength: { value: 1 },
    uMode: { value: 2 }, // 0 off, 1 braking only, 2 full
    uOpacity: { value: 0.85 },
  };

  constructor(
    private world: World,
    tex: RoadTextures,
    line: RacingLine | null,
  ) {
    const track = world.track;
    const asphalt = makeAsphaltMaterial(tex, track.length);
    this.asphaltUniforms = asphalt.uniforms;
    const shoulder = makeShoulderMaterial(tex);
    this.shoulderUniforms = shoulder.uniforms;
    const chunkLen = 120;
    for (let s0 = 0; s0 < track.length; s0 += chunkLen) {
      const s1 = Math.min(track.length, s0 + chunkLen);
      this.group.add(this.buildAsphalt(track, s0, s1, asphalt.material, line));
      this.group.add(this.buildShoulders(track, s0, s1, shoulder.material));
    }
    this.group.add(this.buildPad(asphalt.material));
    this.lineUniforms.uTrackLength.value = track.length;
  }

  private buildAsphalt(track: Track, s0: number, s1: number, mat: THREE.Material, line: RacingLine | null) {
    const lat = 10; // segments across
    const rows = Math.ceil(s1 - s0) + 1;
    const pos: number[] = [];
    const uv: number[] = [];
    const info: number[] = [];
    const idx: number[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (let r = 0; r < rows; r++) {
      const s = Math.min(s1, s0 + r);
      const f = track.frameAt(s);
      const lo = line ? lineOffsetAt(line, s, track.length) : 0;
      for (let k = 0; k <= lat; k++) {
        const d = -f.halfWidth + (2 * f.halfWidth * k) / lat;
        track.pointAt(s, d, p);
        pos.push(p.x, p.y, p.z);
        uv.push(d / TILE, s / TILE);
        info.push(d, s, f.halfWidth, lo);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < lat; k++) {
        const a = r * (lat + 1) + k;
        const b = a + lat + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return this.finish(pos, uv, info, idx, mat);
  }

  private buildShoulders(track: Track, s0: number, s1: number, mat: THREE.Material) {
    const offsets = [0, KERB_WIDTH * 0.5, KERB_WIDTH, SHOULDER_WIDTH, SHOULDER_WIDTH + 0.25];
    const rows = Math.ceil(s1 - s0) + 1;
    const pos: number[] = [];
    const uv: number[] = [];
    const info: number[] = [];
    const idx: number[] = [];
    const p = { x: 0, y: 0, z: 0 };
    const cols = offsets.length;
    for (const side of [1, -1]) {
      const start = pos.length / 3;
      for (let r = 0; r < rows; r++) {
        const s = Math.min(s1, s0 + r);
        const f = track.frameAt(s);
        const kerb = track.kerbAt(s, side) ? 1 : 0;
        for (let k = 0; k < cols; k++) {
          const off = offsets[k];
          const d = side * (f.halfWidth + Math.min(off, SHOULDER_WIDTH));
          track.pointAt(s, d, p);
          // Final column is a skirt that tucks into the verge.
          const y = k === cols - 1 ? p.y - 0.35 : p.y;
          const dd = side * (f.halfWidth + off);
          const x = k === cols - 1 ? f.x + f.nx * dd : p.x;
          const z = k === cols - 1 ? f.z + f.nz * dd : p.z;
          pos.push(x, y, z);
          uv.push(d / 3, s / 3);
          info.push(d, s, f.halfWidth, kerb);
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let k = 0; k < cols - 1; k++) {
          const a = start + r * cols + k;
          const b = a + cols;
          if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
          else idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    return this.finish(pos, uv, info, idx, mat);
  }

  private buildPad(mat: THREE.Material) {
    const w = this.world;
    const pad = w.pad;
    const track = w.track;
    const ns = Math.ceil((pad.s1 - pad.s0) / 2);
    const nd = Math.ceil((pad.d1 - pad.d0) / 2);
    const pos: number[] = [];
    const uv: number[] = [];
    const info: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= ns; i++) {
      const s = pad.s0 + ((pad.s1 - pad.s0) * i) / ns;
      const f = track.frameAt(s);
      for (let j = 0; j <= nd; j++) {
        const d = pad.d0 + ((pad.d1 - pad.d0) * j) / nd;
        const y = w.padHeight({ s, d, i: 0, dist: 0 });
        pos.push(f.x + f.nx * d, y, f.z + f.nz * d);
        uv.push(d / TILE, s / TILE);
        // Pad: no centre line; put the "edge line" around the border.
        info.push(d - (pad.d0 + pad.d1) / 2, s + 1000, (pad.d1 - pad.d0) / 2, -99);
      }
    }
    for (let i = 0; i < ns; i++) {
      for (let j = 0; j < nd; j++) {
        const a = i * (nd + 1) + j;
        const b = a + nd + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return this.finish(pos, uv, info, idx, mat);
  }

  private finish(pos: number[], uv: number[], info: number[], idx: number[], mat: THREE.Material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("roadInfo", new THREE.Float32BufferAttribute(info, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Coloured reference line: green = accelerate, amber = ease off, red = brake now for your speed. */
  buildRacingLine(line: RacingLine) {
    if (this.lineMesh) {
      this.group.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
    }
    const track = this.world.track;
    const n = line.count;
    const pos: number[] = [];
    const attr: number[] = [];
    const idx: number[] = [];
    const halfW = 0.28;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const s = line.s[k];
      const f = track.frameAt(s);
      const o = line.offset[k];
      for (const side of [-1, 1]) {
        const d = o + side * halfW;
        const y = track.roadHeight(s, d, f) + 0.03;
        pos.push(f.x + f.nx * d, y, f.z + f.nz * d);
        attr.push(i === n ? track.length : s, line.speed[k], side);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("lineInfo", new THREE.Float32BufferAttribute(attr, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: this.lineUniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: `
attribute vec3 lineInfo;
uniform float uPlayerS; uniform float uPlayerV; uniform float uDecel; uniform float uTrackLength; uniform float uMode;
varying vec3 vCol; varying float vAlpha; varying float vSide;
void main() {
  float ds = lineInfo.x - uPlayerS;
  if (ds < -5.0) ds += uTrackLength;
  float vRef = lineInfo.y;
  float need = (uPlayerV * uPlayerV - vRef * vRef) / (2.0 * max(ds, 1.0));
  float t = need / uDecel;
  vec3 green = vec3(0.15, 0.85, 0.35);
  vec3 amber = vec3(1.0, 0.72, 0.1);
  vec3 red = vec3(0.95, 0.15, 0.1);
  vCol = t > 0.8 ? red : (t > 0.35 ? mix(amber, red, (t - 0.35) / 0.45) : mix(green, amber, clamp(t / 0.35, 0.0, 1.0)));
  float ahead = smoothstep(3.0, 11.0, ds) * (1.0 - smoothstep(180.0, 260.0, ds));
  float show = uMode > 1.5 ? 1.0 : smoothstep(0.3, 0.45, t);
  vAlpha = ahead * show;
  vSide = lineInfo.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform float uOpacity;
varying vec3 vCol; varying float vAlpha; varying float vSide;
void main() {
  float edge = 1.0 - smoothstep(0.6, 1.0, abs(vSide));
  gl_FragColor = vec4(vCol, vAlpha * uOpacity * (0.55 + 0.45 * edge));
  #include <colorspace_fragment>
}`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.lineMesh = mesh;
    this.group.add(mesh);
  }

  updateRacingLine(playerS: number, playerSpeed: number, decel: number, mode: 0 | 1 | 2) {
    this.lineUniforms.uPlayerS.value = playerS;
    this.lineUniforms.uPlayerV.value = playerSpeed;
    this.lineUniforms.uDecel.value = decel;
    this.lineUniforms.uMode.value = mode;
    if (this.lineMesh) this.lineMesh.visible = mode > 0;
  }

  setWetness(w: number) {
    this.asphaltUniforms.uWet.value = w;
    this.shoulderUniforms.uWet.value = w;
  }
}
