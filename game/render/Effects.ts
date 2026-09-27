import * as THREE from "three";
import { Surface } from "../physics/surfaces";
import { Vehicle } from "../physics/Vehicle";

/** Soft round sprite used for smoke and dust. */
function puffTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

const MAX_MARKS = 3000;

/** Tyre marks laid where tyres slide; they fade over about a minute. */
class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private info: Float32Array; // birth time, intensity
  private head = 0;
  private last: (THREE.Vector3 | null)[] = [null, null, null, null];
  private uniforms = { uTime: { value: 0 }, uLife: { value: 70 } };

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_MARKS * 4 * 3);
    this.info = new Float32Array(MAX_MARKS * 4 * 2).fill(-1000);
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("markInfo", new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < MAX_MARKS; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide,
      vertexShader: `attribute vec2 markInfo; uniform float uTime; uniform float uLife; varying float vA;
void main() { float age = uTime - markInfo.x; vA = markInfo.y * clamp(1.0 - age / uLife, 0.0, 1.0);
gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vA; void main() { if (vA <= 0.0) discard; gl_FragColor = vec4(0.03, 0.03, 0.035, vA * 0.55);
#include <colorspace_fragment>
}`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(v: Vehicle, time: number) {
    this.uniforms.uTime.value = time;
    let changed = false;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const paved = w.surface === Surface.Asphalt || w.surface === Surface.Kerb;
      const intensity = w.contact && paved ? Math.min(1, w.skid * 1.4) : 0;
      if (intensity < 0.25) {
        this.last[i] = null;
        continue;
      }
      const p = w.contactPoint.clone().addScaledVector(w.normal, 0.012);
      const prev = this.last[i];
      if (prev && prev.distanceToSquared(p) > 0.09 && prev.distanceToSquared(p) < 9) {
        const dir = p.clone().sub(prev).normalize();
        const side = new THREE.Vector3().crossVectors(w.normal, dir).normalize().multiplyScalar(0.11);
        const k = this.head;
        const base = k * 12;
        this.pos.set([prev.x - side.x, prev.y, prev.z - side.z, prev.x + side.x, prev.y, prev.z + side.z, p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z], base);
        for (let j = 0; j < 4; j++) {
          this.info[(k * 4 + j) * 2] = time;
          this.info[(k * 4 + j) * 2 + 1] = intensity;
        }
        this.head = (this.head + 1) % MAX_MARKS;
        this.last[i] = p;
        changed = true;
      } else if (!prev || prev.distanceToSquared(p) >= 9) this.last[i] = p;
    }
    if (changed) {
      (this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (this.mesh.geometry.getAttribute("markInfo") as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear() {
    this.info.fill(-1000);
    (this.mesh.geometry.getAttribute("markInfo") as THREE.BufferAttribute).needsUpdate = true;
    this.last = [null, null, null, null];
  }
}

const MAX_PUFFS = 420;

/** Tyre smoke (paved), dust (loose surfaces) and spray (wet), as soft billboards. */
class Puffs {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private data: Float32Array; // size, alpha
  private col: Float32Array;
  private head = 0;
  private acc = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_PUFFS * 3);
    this.vel = new Float32Array(MAX_PUFFS * 3);
    this.life = new Float32Array(MAX_PUFFS).fill(0);
    this.data = new Float32Array(MAX_PUFFS * 2);
    this.col = new Float32Array(MAX_PUFFS * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("puff", new THREE.BufferAttribute(this.data, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: puffTexture() }, uScale: { value: 400 }, fogColor: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      vertexShader: `attribute vec2 puff; varying float vAlpha; varying vec3 vCol; uniform float uScale;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vAlpha = puff.y; vCol = color;
gl_PointSize = puff.x * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D tMap; varying float vAlpha; varying vec3 vCol;
void main() { vec4 t = texture2D(tMap, gl_PointCoord); gl_FragColor = vec4(vCol, t.a * vAlpha); if (gl_FragColor.a < 0.01) discard;
#include <colorspace_fragment>
}`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setViewportHeight(h: number) {
    ((this.points.material as THREE.ShaderMaterial).uniforms.uScale.value as number) = h * 0.9;
  }

  private emit(p: THREE.Vector3, v: THREE.Vector3, size: number, alpha: number, life: number, color: [number, number, number]) {
    const i = this.head;
    this.head = (this.head + 1) % MAX_PUFFS;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = life;
    this.data[i * 2] = size;
    this.data[i * 2 + 1] = alpha;
    this.col.set(color, i * 3);
  }

  update(v: Vehicle, dt: number, wet: number, enabled: boolean) {
    this.acc += dt;
    const emitStep = 1 / 28;
    while (enabled && this.acc > emitStep) {
      this.acc -= emitStep;
      for (const w of v.wheels) {
        if (!w.contact) continue;
        const speed = v.telemetry.speed;
        const paved = w.surface === Surface.Asphalt || w.surface === Surface.Kerb;
        const vel = new THREE.Vector3(v.vel.x * 0.25 + (Math.random() - 0.5), 0.5 + Math.random() * 0.6, v.vel.z * 0.25 + (Math.random() - 0.5));
        if (paved && wet < 0.5 && w.skid > 0.55 && speed > 3 && !w.front) {
          const a = Math.min(0.2, (w.skid - 0.5) * 0.35);
          this.emit(w.contactPoint.clone().setY(w.contactPoint.y + 0.2), vel, 0.55, a, 1.6, [0.82, 0.82, 0.84]);
        } else if (!paved && speed > 6 && Math.random() < Math.min(1, speed / 25)) {
          const col: [number, number, number] = w.surface === Surface.Sand ? [0.7, 0.62, 0.48] : w.surface === Surface.Grass ? [0.45, 0.42, 0.3] : [0.55, 0.48, 0.38];
          this.emit(w.contactPoint.clone().setY(w.contactPoint.y + 0.2), vel.multiplyScalar(1.4), 0.6, wet > 0.5 ? 0.08 : 0.2, 1.4, col);
        } else if (paved && wet > 0.5 && speed > 12 && !w.front && Math.random() < 0.6) {
          const back = v.vel.clone().multiplyScalar(0.55);
          back.y = 0.6;
          this.emit(w.contactPoint.clone().setY(w.contactPoint.y + 0.15), back, 0.7, Math.min(0.28, speed / 120), 0.9, [0.8, 0.83, 0.86]);
        }
      }
    }
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.life[i] <= 0) {
        this.data[i * 2 + 1] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 1.5;
      this.vel[i * 3 + 2] *= 1 - dt * 1.5;
      this.data[i * 2] += dt * 1.1;
      this.data[i * 2 + 1] *= 1 - dt * 1.3;
    }
    const g = this.points.geometry;
    (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("puff") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
  }
}

/** Light rain streaks around the camera; kept sparse so the road stays readable. */
class Rain {
  readonly mesh: THREE.LineSegments;
  private uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uOpacity: { value: 0 } };
  constructor(count = 5000) {
    const pos = new Float32Array(count * 6);
    const seed = new Float32Array(count * 2 * 1);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 60;
      const y = Math.random() * 30;
      const z = (Math.random() - 0.5) * 60;
      pos.set([x, y, z, x, y - 0.55, z], i * 6);
      seed[i * 2] = seed[i * 2 + 1] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `attribute float seed; uniform float uTime; uniform vec3 uCam; varying float vA;
void main() {
  vec3 p = position;
  p.y = mod(p.y - uTime * (14.0 + seed * 4.0), 30.0) - 8.0;
  p.x += uTime * 1.5;
  p.xz = mod(p.xz - uCam.xz + 30.0, 60.0) - 30.0 + uCam.xz;
  p.y += uCam.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = clamp(1.0 - length(mv.xyz) / 30.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `uniform float uOpacity; varying float vA; void main() { gl_FragColor = vec4(0.78, 0.82, 0.88, vA * uOpacity);
#include <colorspace_fragment>
}`,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  update(time: number, cam: THREE.Vector3, intensity: number) {
    this.mesh.visible = intensity > 0;
    this.uniforms.uTime.value = time;
    this.uniforms.uCam.value.copy(cam);
    this.uniforms.uOpacity.value = 0.32 * intensity;
  }
}

export class Effects {
  readonly group = new THREE.Group();
  readonly skid = new SkidMarks();
  readonly puffs = new Puffs();
  readonly rain = new Rain();
  enabled = true;
  constructor() {
    this.group.add(this.skid.mesh, this.puffs.points, this.rain.mesh);
  }
  update(v: Vehicle | null, dt: number, time: number, cam: THREE.Vector3, wet: number, viewportH: number) {
    this.puffs.setViewportHeight(viewportH);
    if (v) {
      this.skid.update(v, time);
      this.puffs.update(v, dt, wet, this.enabled);
    }
    this.rain.update(time, cam, wet);
  }
  clear() {
    this.skid.clear();
    this.puffs.clear();
  }
}
