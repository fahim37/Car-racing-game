import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Quality } from "../save/profile";
import { GrassQuality } from "./GrassView";

export interface QualityProfile {
  pixelRatio: number;
  shadowSize: number;
  shadowExtent: number;
  vegetationDensity: number;
  nearScale: number;
  lodBias: number;
  hdr: "1k" | "2k";
  shadows: boolean;
  /** Use the lighter car models (phones, integrated graphics). */
  carLite: boolean;
  grass: GrassQuality | null;
  bloom: boolean;
  msaa: number;
}

export function qualityProfile(q: Quality, dpr: number): QualityProfile {
  switch (q) {
    case "low":
      return { pixelRatio: Math.min(dpr, 1), shadowSize: 1024, shadowExtent: 45, vegetationDensity: 0.6, nearScale: 0.6, lodBias: 0.75, hdr: "1k", shadows: true, carLite: true, grass: null, bloom: false, msaa: 0 };
    case "medium":
      return { pixelRatio: Math.min(dpr, 1.5), shadowSize: 2048, shadowExtent: 60, vegetationDensity: 0.85, nearScale: 0.8, lodBias: 1, hdr: "2k", shadows: true, carLite: true, grass: { tile: 48, spacing: 0.62 }, bloom: false, msaa: 2 };
    case "ultra":
      return { pixelRatio: Math.min(dpr, 2), shadowSize: 4096, shadowExtent: 85, vegetationDensity: 1, nearScale: 1.35, lodBias: 1.6, hdr: "2k", shadows: true, carLite: false, grass: { tile: 84, spacing: 0.42 }, bloom: true, msaa: 4 };
    default:
      return { pixelRatio: Math.min(dpr, 2), shadowSize: 4096, shadowExtent: 72, vegetationDensity: 1, nearScale: 1, lodBias: 1.25, hdr: "2k", shadows: true, carLite: false, grass: { tile: 66, spacing: 0.5 }, bloom: true, msaa: 4 };
  }
}

export interface Grade {
  exposure: number;
  contrast: number;
  saturation: number;
  vignette: number;
  lift: THREE.Vector3; // shadow tint
  gain: THREE.Vector3; // highlight tint
}

/**
 * Final pass: filmic tone mapping (ACES, as three.js), sRGB encode, then a cinematic grade in
 * display space (contrast, saturation, split toning), vignette, optional speed blur and dither.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 0.8 },
    uContrast: { value: 1.1 },
    uSaturation: { value: 1.1 },
    uVignette: { value: 0.3 },
    uLift: { value: new THREE.Vector3(0.97, 0.99, 1.03) },
    uGain: { value: new THREE.Vector3(1.04, 1.01, 0.96) },
    uBlur: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uExposure; uniform float uContrast; uniform float uSaturation; uniform float uVignette;
uniform vec3 uLift; uniform vec3 uGain; uniform float uBlur;
varying vec2 vUv;
vec3 gradeRRTODT(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 gradeAces(vec3 color) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = inM * (color / 0.6);
  color = gradeRRTODT(color);
  return clamp(outM * color, 0.0, 1.0);
}
vec3 gradeSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 col;
  if (uBlur > 0.001) {
    vec2 dir = vUv - vec2(0.5, 0.52);
    float edge = smoothstep(0.12, 0.6, length(dir));
    col = vec3(0.0);
    for (int i = 0; i < 8; i++) col += texture2D(tDiffuse, vUv - dir * (float(i) / 7.0) * uBlur * edge * 0.06).rgb;
    col /= 8.0;
  } else col = texture2D(tDiffuse, vUv).rgb;
  col = gradeSrgb(gradeAces(col * uExposure));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = (col - 0.45) * uContrast + 0.45;
  col *= mix(uLift, uGain, smoothstep(0.05, 0.85, l));
  vec2 d = vUv - 0.5;
  col *= 1.0 - dot(d, d) * uVignette * 1.7;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private finalPass: ShaderPass;
  quality: QualityProfile;
  private scale = 1;
  private dynScale = 1;
  private frameTimes: number[] = [];
  dynamicResolution = true;
  motionBlur = 0;
  private size = new THREE.Vector2(1, 1);

  constructor(
    readonly canvas: HTMLCanvasElement,
    q: Quality,
  ) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; // only used when rendering straight to screen
    r.toneMappingExposure = 0.85;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;
    this.quality = qualityProfile(q, window.devicePixelRatio || 1);
    this.composer = this.makeComposer();
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.45, 0.92);
    this.finalPass = new ShaderPass(FinalShader);
    this.finalPass.material.toneMapped = false;
    this.rebuildPasses();
  }

  private makeComposer() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.quality.msaa });
    return new EffectComposer(this.renderer, rt);
  }

  private rebuildPasses() {
    this.composer.passes.length = 0;
    this.composer.addPass(this.renderPass);
    if (this.quality.bloom) this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.finalPass);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.size.x, this.size.y);
  }

  setQuality(q: Quality, scale: number) {
    const prev = this.quality;
    this.quality = qualityProfile(q, window.devicePixelRatio || 1);
    this.scale = scale;
    this.dynScale = 1;
    if (prev.msaa !== this.quality.msaa) {
      this.composer.dispose();
      this.composer = this.makeComposer();
    }
    this.applyPixelRatio();
    this.rebuildPasses();
  }

  setGrade(g: Grade) {
    const u = this.finalPass.uniforms;
    u.uExposure.value = g.exposure;
    u.uContrast.value = g.contrast;
    u.uSaturation.value = g.saturation;
    u.uVignette.value = g.vignette;
    u.uLift.value.copy(g.lift);
    u.uGain.value.copy(g.gain);
  }

  private applyPixelRatio() {
    this.renderer.setPixelRatio(Math.max(0.5, this.quality.pixelRatio * this.scale * this.dynScale));
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.size.x, this.size.y);
  }

  resize(w: number, h: number) {
    this.size.set(w, h);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  /** Gently lowers (or restores) resolution to hold the frame rate. */
  trackFrame(dt: number) {
    if (!this.dynamicResolution) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    const prev = this.dynScale;
    if (avg > 1 / 50 && this.dynScale > 0.6) this.dynScale = Math.max(0.6, this.dynScale - 0.1);
    else if (avg < 1 / 58 && this.dynScale < 1) this.dynScale = Math.min(1, this.dynScale + 0.05);
    if (prev !== this.dynScale) this.applyPixelRatio();
  }

  render(scene: THREE.Scene, camera: THREE.Camera, speed: number) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.finalPass.uniforms.uBlur.value = this.motionBlur * Math.max(0, Math.min(1, (speed - 15) / 45));
    this.composer.render();
  }
}
