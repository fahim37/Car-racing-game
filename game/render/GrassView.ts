import * as THREE from "three";
import { rng } from "../util/math";
import { CELL, World } from "../world/World";

/** Tufts of grass blades drawn onto a transparent card. */
function grassTexture() {
  const W = 256;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const r = rng(99);
  for (let i = 0; i < 70; i++) {
    const x = 10 + r() * (W - 20);
    const h = H * (0.45 + r() * 0.55);
    const lean = (r() - 0.5) * 60;
    const w = 3 + r() * 5;
    const shade = 0.75 + r() * 0.5;
    const grad = g.createLinearGradient(0, H, 0, H - h);
    grad.addColorStop(0, `rgb(${Math.round(34 * shade)},${Math.round(52 * shade)},${Math.round(18 * shade)})`);
    grad.addColorStop(0.6, `rgb(${Math.round(78 * shade)},${Math.round(110 * shade)},${Math.round(40 * shade)})`);
    grad.addColorStop(1, `rgb(${Math.round(128 * shade)},${Math.round(150 * shade)},${Math.round(72 * shade)})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w / 2, H);
    g.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.2, H - h * 0.6, x + w / 2, H);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface GrassQuality {
  tile: number; // metres covered around the camera
  spacing: number; // metres between tufts
}

/**
 * GPU grass: a fixed set of tufts that wraps around the camera. Each tuft reads the terrain
 * height and a meadow mask from textures in the vertex shader, so the field follows the
 * landscape exactly and costs a single draw call.
 */
export class GrassView {
  readonly mesh: THREE.Mesh;
  private uniforms = {
    uCam: { value: new THREE.Vector3() },
    uTile: { value: 64 },
    uFade: { value: 30 },
    uTime: { value: 0 },
    uWind: { value: 1 },
    uGrid: { value: new THREE.Vector4() },
    tHeight: { value: null as THREE.Texture | null },
    tMask: { value: null as THREE.Texture | null },
  };

  constructor(world: World, q: GrassQuality) {
    const cols = world.cols;
    const rows = world.rows;
    const half = new Uint16Array(cols * rows);
    for (let k = 0; k < half.length; k++) half[k] = THREE.DataUtils.toHalfFloat(world.heights[k]);
    const hTex = new THREE.DataTexture(half, cols, rows, THREE.RedFormat, THREE.HalfFloatType);
    hTex.magFilter = hTex.minFilter = THREE.LinearFilter;
    hTex.needsUpdate = true;
    const mTex = new THREE.DataTexture(world.grassMask(), cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
    mTex.magFilter = mTex.minFilter = THREE.LinearFilter;
    mTex.needsUpdate = true;
    const u = this.uniforms;
    u.tHeight.value = hTex;
    u.tMask.value = mTex;
    u.uGrid.value.set(world.x0, world.z0, cols * CELL, rows * CELL);
    u.uTile.value = q.tile;
    u.uFade.value = q.tile * 0.5;

    // One tuft: three crossed cards.
    const blade = new THREE.BufferGeometry();
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const w = 0.34;
    const h = 0.42;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const dx = Math.cos(a) * w;
      const dz = Math.sin(a) * w;
      const b = pos.length / 3;
      pos.push(-dx, 0, -dz, dx, 0, dz, dx, h, dz, -dx, h, -dz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    blade.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    blade.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    blade.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    blade.setIndex(idx);

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = blade.index;
    geo.setAttribute("position", blade.getAttribute("position"));
    geo.setAttribute("uv", blade.getAttribute("uv"));
    geo.setAttribute("normal", blade.getAttribute("normal"));
    const n = Math.floor(q.tile / q.spacing);
    const offsets = new Float32Array(n * n * 3);
    const r = rng(5);
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        offsets[k++] = (i + r()) * q.spacing;
        offsets[k++] = (j + r()) * q.spacing;
        offsets[k++] = r();
      }
    }
    geo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 3));
    geo.instanceCount = n * n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshStandardMaterial({ map: grassTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, color: 0xdde8cc });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute vec3 aOffset;
uniform vec3 uCam; uniform float uTile; uniform float uFade; uniform float uTime; uniform float uWind; uniform vec4 uGrid;
uniform sampler2D tHeight; uniform sampler2D tMask;
varying float vGrassShade;`,
        )
        .replace(
          "#include <begin_vertex>",
          `vec2 gOff = aOffset.xy;
vec2 gBase = gOff + uTile * floor((uCam.xz - gOff) / uTile + 0.5);
vec2 gUv = (gBase - uGrid.xy) / uGrid.zw + vec2(0.5) / vec2(textureSize(tHeight, 0));
float gH = texture2D(tHeight, gUv).r;
float gDens = texture2D(tMask, gUv).r;
float gDist = length(gBase - uCam.xz);
float gFade = 1.0 - smoothstep(uFade * 0.55, uFade, gDist);
float gKeep = step(aOffset.z, gDens * 1.05);
float gScale = gKeep * gFade * (0.65 + aOffset.z * 0.9);
float gAng = aOffset.z * 47.0;
vec3 transformed = position;
transformed.xz = mat2(cos(gAng), -sin(gAng), sin(gAng), cos(gAng)) * transformed.xz;
transformed *= gScale;
float gSway = (sin(uTime * 1.6 + gBase.x * 0.35 + gBase.y * 0.21) * 0.6 + sin(uTime * 3.1 + gBase.x * 0.9) * 0.25) * uWind * 0.1 * transformed.y;
transformed.x += gSway;
transformed.z += gSway * 0.6;
transformed += vec3(gBase.x, gH - 0.04, gBase.y);
vGrassShade = 0.8 + aOffset.z * 0.4;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vGrassShade;")
        .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb *= vGrassShade;");
    };
    mat.customProgramCacheKey = () => "gpu-grass";
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  update(camera: THREE.Vector3, time: number, wind: number) {
    this.uniforms.uCam.value.copy(camera);
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value = wind;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
