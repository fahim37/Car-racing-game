import * as THREE from "three";
import { loadHDR } from "./assets";
import type { Grade } from "./Renderer";

export type TimeOfDay = "morning" | "afternoon" | "dusk";
export type Weather = "dry" | "wet";
export interface Conditions {
  time: TimeOfDay;
  weather: Weather;
}

interface Preset {
  hdr: string;
  sunAzimuth: number; // desired direction of the sun, radians (atan2(-z, x))
  sunIntensity: number;
  envIntensity: number;
  fogDensity: number;
  shadows: boolean;
  hazeStrength: number;
  headlights: boolean;
  tint: THREE.Color;
  grade: Grade;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Lighting and grading per time of day. The grade is deliberately rich and a little dark:
 * deep shadows, warm highlights and cooler shadows, a soft vignette.
 */
function preset(c: Conditions): Preset {
  const wet = c.weather === "wet";
  if (wet) {
    const dusk = c.time === "dusk";
    return {
      hdr: "kloofendal_overcast_puresky",
      sunAzimuth: c.time === "morning" ? Math.PI * 0.85 : 0.4,
      sunIntensity: dusk ? 0.15 : 0.35,
      envIntensity: dusk ? 0.55 : 0.9,
      fogDensity: 0.0017,
      shadows: false,
      hazeStrength: 0.2,
      headlights: dusk,
      tint: new THREE.Color(dusk ? 0x9aa6bd : 0xd6dde6),
      grade: dusk
        ? { exposure: 0.8, contrast: 1.1, saturation: 0.9, vignette: 0.38, lift: v3(0.94, 0.98, 1.06), gain: v3(1.0, 0.99, 0.98) }
        : { exposure: 0.95, contrast: 1.08, saturation: 0.95, vignette: 0.3, lift: v3(0.97, 1.0, 1.03), gain: v3(1.0, 1.0, 1.0) },
    };
  }
  switch (c.time) {
    case "morning":
      return {
        hdr: "qwantani_morning_puresky",
        sunAzimuth: Math.PI * 0.82,
        sunIntensity: 2.8,
        envIntensity: 0.95,
        fogDensity: 0.0006,
        shadows: true,
        hazeStrength: 0.85,
        headlights: false,
        tint: new THREE.Color(0xffffff),
        grade: { exposure: 0.74, contrast: 1.14, saturation: 1.14, vignette: 0.34, lift: v3(0.95, 0.99, 1.05), gain: v3(1.05, 1.01, 0.95) },
      };
    case "afternoon":
      return {
        hdr: "qwantani_late_afternoon_puresky",
        sunAzimuth: -0.55,
        sunIntensity: 3.2,
        envIntensity: 0.9,
        fogDensity: 0.00048,
        shadows: true,
        hazeStrength: 0.7,
        headlights: false,
        tint: new THREE.Color(0xffffff),
        grade: { exposure: 0.7, contrast: 1.16, saturation: 1.16, vignette: 0.36, lift: v3(0.94, 0.98, 1.05), gain: v3(1.08, 1.01, 0.92) },
      };
    default:
      return {
        hdr: "qwantani_dusk_2_puresky",
        sunAzimuth: -0.35,
        sunIntensity: 1.5,
        envIntensity: 1.0,
        fogDensity: 0.00065,
        shadows: true,
        hazeStrength: 1.0,
        headlights: true,
        tint: new THREE.Color(0xffffff),
        grade: { exposure: 0.95, contrast: 1.18, saturation: 1.08, vignette: 0.42, lift: v3(0.93, 0.97, 1.07), gain: v3(1.06, 0.99, 0.94) },
      };
  }
}

const halfToFloat = THREE.DataUtils.fromHalfFloat;

/** Finds the sun (brightest region) and average horizon colour of an equirectangular HDR. */
function analyseHDR(tex: THREE.DataTexture) {
  const img = tex.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { width: W, height: H, data } = img;
  const half = data instanceof Uint16Array;
  const px = (i: number) => (half ? halfToFloat(data[i]) : (data[i] as number));
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let j = 0; j < H / 2; j += 2) {
    for (let i = 0; i < W; i += 2) {
      const k = (j * W + i) * 4;
      const l = px(k) * 0.2126 + px(k + 1) * 0.7152 + px(k + 2) * 0.0722;
      if (l > best) {
        best = l;
        bi = i;
        bj = j;
      }
    }
  }
  const u = (bi + 0.5) / W;
  const v = 1 - (bj + 0.5) / H;
  const phi = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const sunDir = new THREE.Vector3(Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi));
  const k = (bj * W + bi) * 4;
  const sunColor = new THREE.Color(px(k), px(k + 1), px(k + 2));
  const m = Math.max(sunColor.r, sunColor.g, sunColor.b) || 1;
  sunColor.multiplyScalar(1 / m);

  // Horizon colour: average of a band just above the horizon; also towards and away from the sun.
  const horizon = new THREE.Color(0, 0, 0);
  const sunSide = new THREE.Color(0, 0, 0);
  let n = 0;
  let ns = 0;
  const rowFrom = Math.floor(H * (0.5 - 3 / 180));
  const rowTo = Math.floor(H * (0.5 - 0.5 / 180));
  for (let j = rowFrom; j <= rowTo; j++) {
    for (let i = 0; i < W; i += 4) {
      const kk = (j * W + i) * 4;
      const r = Math.min(px(kk), 8);
      const g = Math.min(px(kk + 1), 8);
      const b = Math.min(px(kk + 2), 8);
      horizon.r += r;
      horizon.g += g;
      horizon.b += b;
      n++;
      const du = Math.abs((i + 0.5) / W - u);
      if (Math.min(du, 1 - du) < 0.06) {
        sunSide.r += r;
        sunSide.g += g;
        sunSide.b += b;
        ns++;
      }
    }
  }
  horizon.multiplyScalar(1 / n);
  if (ns) sunSide.multiplyScalar(1 / ns);
  else sunSide.copy(horizon);
  return { sunDir, sunColor, horizon, sunSide };
}

const azimuth = (v: THREE.Vector3) => Math.atan2(-v.z, v.x);

/** Fog with aerial perspective: brighter, warmer haze towards the sun. Values are baked in as defines. */
function installFogChunks(sunDir: THREE.Vector3, sunFog: THREE.Color, haze: number) {
  const f = (n: number) => n.toFixed(5);
  THREE.ShaderChunk.fog_pars_vertex = `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogDir;
#endif`;
  THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogDir = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 fogDirN = normalize( vFogDir );
  float sunAmt = max( dot( fogDirN, vec3( ${f(sunDir.x)}, ${f(sunDir.y)}, ${f(sunDir.z)} ) ), 0.0 );
  vec3 hazeCol = mix( fogColor, vec3( ${f(sunFog.r)}, ${f(sunFog.g)}, ${f(sunFog.b)} ), pow( sunAmt, 6.0 ) * ${f(haze)} );
  // Thinner haze looking up: distant peaks keep some contrast against the sky.
  fogFactor *= mix( 1.0, 0.55, clamp( fogDirN.y * 3.0, 0.0, 1.0 ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeCol, fogFactor );
#endif`;
}

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDir = new THREE.Vector3(0.5, 0.5, 0.5).normalize();
  conditions: Conditions = { time: "morning", weather: "dry" };
  params: Preset = preset(this.conditions);
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private shadowSize = 2048;
  private shadowExtent = 70;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2.5;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x5a6b3a, 0.15);
    scene.add(this.hemi);
  }

  setShadowQuality(size: number, extent: number, enabled: boolean) {
    this.shadowSize = size;
    this.shadowExtent = extent;
    const s = this.sun.shadow;
    if (s.mapSize.x !== size) {
      s.mapSize.set(size, size);
      s.map?.dispose();
      s.map = null;
    }
    const cam = s.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 600;
    cam.updateProjectionMatrix();
    this.sun.castShadow = enabled && this.params.shadows;
  }

  async apply(c: Conditions, hdrRes: "1k" | "2k") {
    this.conditions = c;
    const p = (this.params = preset(c));
    const tex = await loadHDR(`sky/${p.hdr}_${hdrRes}.hdr`);
    const info = analyseHDR(tex);
    const rot = p.sunAzimuth - azimuth(info.sunDir);
    this.scene.background = tex;
    this.scene.backgroundRotation.set(0, rot, 0);
    this.scene.environmentRotation.set(0, rot, 0);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(tex);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = p.envIntensity;
    this.scene.backgroundIntensity = 1;

    this.sunDir.copy(info.sunDir).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).normalize();
    // Keep a little elevation so shadows stay readable.
    if (this.sunDir.y < 0.12) {
      this.sunDir.y = 0.12;
      this.sunDir.normalize();
    }
    this.sun.color.copy(info.sunColor).lerp(new THREE.Color(0xffffff), 0.25);
    this.sun.intensity = p.sunIntensity;
    this.sun.castShadow = p.shadows;
    this.hemi.intensity = c.weather === "wet" ? 0.25 : 0.12;
    // Fog lives in linear HDR (tone-mapped with the scene), matched to the sky's horizon.
    const clampC = (col: THREE.Color, m: number) => col.setRGB(Math.min(col.r, m), Math.min(col.g, m), Math.min(col.b, m));
    const horizon = clampC(info.horizon.clone(), 6).multiply(p.tint);
    const sunSide = clampC(info.sunSide.clone(), 8).multiply(p.tint);
    const fogColor = horizon.clone().lerp(sunSide, 0.15);
    // THREE.Color stores linear values; the fog uniform is converted to output (sRGB) space,
    // so feed it the display colour converted back to linear.
    this.scene.fog = new THREE.FogExp2(fogColor, p.fogDensity);
    installFogChunks(this.sunDir, sunSide.clone(), p.hazeStrength);
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((mm) => (mm.needsUpdate = true));
    });
    this.setShadowQuality(this.shadowSize, this.shadowExtent, true);
    return { fogColor, horizon };
  }

  /** Keeps the shadow frustum centred on the player, snapped to texels to avoid shimmer. */
  update(focus: THREE.Vector3) {
    const d = this.sunDir;
    const texel = (this.shadowExtent * 2) / this.shadowSize;
    // Snap in light space: the shadow camera looks along -sunDir.
    const fwd = _fwd.copy(d).negate();
    const right = _right.crossVectors(_worldUp, fwd).normalize();
    const up = _up.crossVectors(fwd, right);
    const a = Math.round(focus.dot(right) / texel) * texel;
    const b = Math.round(focus.dot(up) / texel) * texel;
    const c = focus.dot(fwd);
    const snapped = _snap.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(fwd, c);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(d, 300);
    this.sun.target.updateMatrixWorld();
  }
}

const _worldUp = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snap = new THREE.Vector3();
