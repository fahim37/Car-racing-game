import * as THREE from "three";
import { CarSpec } from "../physics/carSpecs";
import { Vehicle } from "../physics/Vehicle";
import { loadGLTF } from "./assets";
import { toFloatGeometry } from "./geometry";

export interface CarPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  wheelY: number[]; // local wheel-centre heights (physics)
  steer: number[];
  spin: number[];
  brake: number;
}

interface WheelNode {
  pivot: THREE.Object3D; // spins and steers
  hub: THREE.Object3D; // steers only (brake calipers)
  center: THREE.Vector3; // model space
  radius: number;
}

const FLAME_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FLAME_FRAG = `uniform float uTime; uniform float uAmount; uniform float uSeed; varying vec2 vUv;
void main() {
  float t = vUv.y;                  // 0 at the pipe, 1 at the tip
  float x = abs(vUv.x - 0.5) * 2.0; // 0 on the axis, 1 at the edge of the card
  float flick = 0.8 + 0.2 * sin(uTime * 53.0 + uSeed) * sin(uTime * 31.0 + t * 9.0 + uSeed);
  float w = (1.0 - pow(t, 1.4)) * (0.45 + 0.55 * smoothstep(0.0, 0.18, t)) * flick;
  float body = 1.0 - smoothstep(w * 0.35, w, x);
  float core = (1.0 - smoothstep(0.0, w * 0.45, x)) * (1.0 - smoothstep(0.1, 0.6, t));
  // White-hot at the pipe, nitro blue, burning out orange at the tips.
  vec3 col = mix(vec3(0.3, 0.65, 1.0), vec3(1.0, 0.5, 0.18), smoothstep(0.35, 0.9, t));
  col = mix(col, vec3(0.92, 0.97, 1.0), core);
  float a = body * (1.0 - smoothstep(0.65, 1.0, t)) * uAmount;
  gl_FragColor = vec4(col * (2.0 + 4.0 * core), a);
  #include <colorspace_fragment>
}`;

/** Soft round glow for the exhaust outlets. */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(220,240,255,1)");
  grd.addColorStop(0.35, "rgba(90,180,255,0.55)");
  grd.addColorStop(1, "rgba(40,120,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

interface BoostFlame {
  root: THREE.Group;
  material: THREE.ShaderMaterial;
  glow: THREE.Sprite;
}

/**
 * Splits a geometry into the four wheel quadrants by triangle centroid.
 * Model space: +x is the car's left, +z forward. Order: FL, FR, RL, RR.
 */
function splitQuadrants(geo: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute("position");
  const names = Object.keys(g.attributes);
  const out: Record<string, number[]>[] = [0, 1, 2, 3].map(() => Object.fromEntries(names.map((n) => [n, [] as number[]])));
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const q = (cx >= 0 ? 0 : 1) + (cz >= 0 ? 0 : 2);
    for (const n of names) {
      const a = g.getAttribute(n);
      for (let k = 0; k < 3; k++) for (let c = 0; c < a.itemSize; c++) out[q][n].push(a.getComponent(t + k, c));
    }
  }
  return out.map((attrs) => {
    const r = new THREE.BufferGeometry();
    for (const n of names) {
      const src = g.getAttribute(n) as THREE.BufferAttribute;
      r.setAttribute(n, new THREE.Float32BufferAttribute(attrs[n], src.itemSize, src.normalized));
    }
    return r;
  });
}

export class CarView {
  readonly root = new THREE.Group(); // positioned at the physics CG
  readonly body = new THREE.Group(); // model space
  readonly wheels: WheelNode[] = [];
  private brakeMats: THREE.MeshStandardMaterial[] = [];
  private headMats: THREE.MeshStandardMaterial[] = [];
  private paintMats: THREE.MeshPhysicalMaterial[] = [];
  private headlight: THREE.SpotLight | null = null;
  private boostFlames: BoostFlame[] = [];
  private boost = 0;
  private boostClock = 0;
  private cgZ = 0;
  private eye = new THREE.Vector3(0.36, 0.55, -0.2);
  private hood = new THREE.Vector3(0, 0.6, 0.8);
  readonly isGhost: boolean;
  lightsOn = false;

  private constructor(
    readonly spec: CarSpec,
    ghost: boolean,
  ) {
    this.isGhost = ghost;
  }

  static async create(spec: CarSpec, paint: string, ghost = false, lite = false) {
    const v = new CarView(spec, ghost);
    await v.init(paint, lite || ghost);
    return v;
  }

  private upgrade(m: THREE.Material, paint: string, ghostMat: THREE.Material): THREE.Material {
    if (this.isGhost) return ghostMat;
    const std = m as THREE.MeshStandardMaterial;
    const name = std.name || "";
    if (name === "Paint") {
      const p = new THREE.MeshPhysicalMaterial({
        color: paint,
        normalMap: std.normalMap ?? null,
        metalness: THREE.MathUtils.clamp(std.metalness ?? 0.4, 0.25, 0.7),
        roughness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.035,
        envMapIntensity: 1.15,
      });
      if (std.normalMap) p.normalScale.set(0.25, 0.25);
      this.paintMats.push(p);
      return p;
    }
    if (name === "Glass") {
      return new THREE.MeshPhysicalMaterial({ color: 0x0c1116, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.55, envMapIntensity: 1.6, depthWrite: false });
    }
    const c = std.clone();
    if (name.startsWith("TailLight_")) {
      c.emissive = new THREE.Color(0xff200c);
      c.emissiveIntensity = 0.25;
      this.brakeMats.push(c);
    } else if (name.startsWith("HeadLight_")) {
      c.emissive = new THREE.Color(0xfff3dc);
      c.emissiveIntensity = 0;
      this.headMats.push(c);
    }
    c.envMapIntensity = 1;
    return c;
  }

  /** Nitro flames from twin exhausts at the rear bumper (body space). */
  private buildBoostFlames(bodyBox: THREE.Box3) {
    // A flame is three crossed cards along -z: v runs from the pipe (0) to the tip (1).
    const card = new THREE.PlaneGeometry(1, 1);
    card.rotateX(-Math.PI / 2);
    card.translate(0, 0, -0.5);
    const glowMap = glowTexture();
    const halfWidth = (bodyBox.max.x - bodyBox.min.x) / 2;
    for (const side of [1, -1]) {
      const material = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uSeed: { value: side * 3.7 } },
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const root = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(card, material);
        m.rotation.z = (k * Math.PI) / 3;
        m.frustumCulled = false;
        root.add(m);
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0x9fd8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      root.add(glow);
      // Model space: tyres on y = 0, the rear bumper at bodyBox.min.z; body space is offset to the CG.
      root.position.set(side * Math.min(0.42, halfWidth * 0.45), bodyBox.min.y + 0.3 - this.spec.cgHeight, bodyBox.min.z + 0.05 - this.cgZ);
      root.visible = false;
      this.root.add(root);
      this.boostFlames.push({ root, material, glow });
    }
  }

  /** Eases the nitro flames in and out; `on` is whether the boost is firing now. */
  setBoost(on: boolean) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.boostClock || now));
    this.boostClock = now;
    this.boost += ((on ? 1 : 0) - this.boost) * Math.min(1, dt * (on ? 14 : 7));
    for (const f of this.boostFlames) {
      f.root.visible = this.boost > 0.02;
      if (!f.root.visible) continue;
      const jitter = 0.85 + Math.random() * 0.3;
      f.root.scale.set(0.32 + 0.08 * this.boost, 0.32 + 0.08 * this.boost, (0.6 + 1.1 * this.boost) * jitter);
      f.material.uniforms.uTime.value = now;
      f.material.uniforms.uAmount.value = this.boost;
      // The glow sprite lives inside the scaled flame group; undo the stretch.
      f.glow.scale.set((0.95 * this.boost) / f.root.scale.x, (0.95 * this.boost) / f.root.scale.y, 1);
    }
  }

  private async init(paint: string, lite: boolean) {
    const gltf = await loadGLTF(`cars/${this.spec.model}${lite ? "_lite" : ""}.glb`);
    const src = gltf.scene;
    src.updateMatrixWorld(true);
    const ghostMat = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.26, depthWrite: false, roughness: 0.4, metalness: 0.1 });
    const wheelParts: [THREE.BufferGeometry, THREE.Material][] = [];
    const hubParts: [THREE.BufferGeometry, THREE.Material][] = [];
    const glassBox = new THREE.Box3();
    const bodyBox = new THREE.Box3();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = toFloatGeometry(mesh.geometry).applyMatrix4(mesh.matrixWorld);
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const name = mat.name || "";
      if (name.startsWith("Wheel_")) wheelParts.push([geo, mat]);
      else if (name.startsWith("Hub_")) hubParts.push([geo, mat]);
      else {
        const m = new THREE.Mesh(geo, this.upgrade(mat, paint, ghostMat));
        m.castShadow = !this.isGhost;
        m.receiveShadow = !this.isGhost;
        this.body.add(m);
        geo.computeBoundingBox();
        bodyBox.union(geo.boundingBox!);
        if (name === "Glass") glassBox.union(geo.boundingBox!);
      }
    });

    // Wheels: split every wheel part into quadrants, centre each wheel on its own axle.
    const wheelGeos: [THREE.BufferGeometry, THREE.Material][][] = [[], [], [], []];
    const hubGeos: [THREE.BufferGeometry, THREE.Material][][] = [[], [], [], []];
    for (const [geo, mat] of wheelParts) splitQuadrants(geo).forEach((g, q) => g.getAttribute("position").count > 0 && wheelGeos[q].push([g, mat]));
    for (const [geo, mat] of hubParts) splitQuadrants(geo).forEach((g, q) => g.getAttribute("position").count > 0 && hubGeos[q].push([g, mat]));
    for (let q = 0; q < 4; q++) {
      const bb = new THREE.Box3();
      for (const [g] of wheelGeos[q]) {
        g.computeBoundingBox();
        bb.union(g.boundingBox!);
      }
      const center = bb.isEmpty() ? new THREE.Vector3() : bb.getCenter(new THREE.Vector3());
      const radius = bb.isEmpty() ? this.spec.wheelRadius : (bb.max.y - bb.min.y) / 2;
      const pivot = new THREE.Group();
      pivot.rotation.order = "YXZ";
      const hub = new THREE.Group();
      for (const [g, mat] of wheelGeos[q]) {
        g.translate(-center.x, -center.y, -center.z);
        const m = new THREE.Mesh(g, this.upgrade(mat, paint, ghostMat));
        m.castShadow = !this.isGhost;
        pivot.add(m);
      }
      for (const [g, mat] of hubGeos[q]) {
        g.translate(-center.x, -center.y, -center.z);
        hub.add(new THREE.Mesh(g, this.upgrade(mat, paint, ghostMat)));
      }
      this.body.add(pivot, hub);
      this.wheels.push({ pivot, hub, center, radius });
    }

    // Model origin: axle midpoint at z = 0, tyres on y = 0. Body space origin: the physics CG.
    const L = this.spec.wheelbase;
    this.cgZ = L * (this.spec.frontWeight - 0.5);
    this.body.position.set(0, -this.spec.cgHeight, -this.cgZ);
    this.root.add(this.body);

    // Camera anchor points from the model: driver's eye inside the cabin, hood cam above the bonnet.
    const cabin = glassBox.isEmpty() ? bodyBox : glassBox;
    const roof = bodyBox.max.y;
    const eyeY = Math.min(roof - 0.14, Math.max(cabin.min.y + 0.18, roof * 0.78));
    const eyeZ = (cabin.min.z + cabin.max.z) / 2 - 0.12;
    this.eye.set(0.36, eyeY - this.spec.cgHeight, eyeZ - this.cgZ);
    this.hood.set(0, roof * 0.8 - this.spec.cgHeight, L * 0.42 - this.cgZ);
    if (!this.isGhost) this.buildBoostFlames(bodyBox);

    if (!this.isGhost) {
      const light = new THREE.SpotLight(0xfff1d8, 0, 150, 0.55, 0.45, 1.2);
      light.position.set(0, 0.6 - this.spec.cgHeight, bodyBox.max.z - this.cgZ);
      light.target.position.set(0, -1.2, bodyBox.max.z - this.cgZ + 30);
      this.root.add(light, light.target);
      this.headlight = light;
    }
  }

  /** Driver eye position in body (CG) space, for the cockpit camera. */
  get eyeLocal() {
    return this.eye.clone();
  }

  get hoodLocal() {
    return this.hood.clone();
  }

  /** The models have full interiors, so the cockpit needs no special handling. */
  setCockpit(on: boolean) {
    void on;
  }

  setPaint(color: string) {
    for (const m of this.paintMats) m.color.set(color);
  }

  setLights(on: boolean) {
    this.lightsOn = on;
    for (const m of this.headMats) m.emissiveIntensity = on ? 4 : 0;
    if (this.headlight) this.headlight.intensity = on ? 110 : 0;
  }

  /** Applies an interpolated physics pose. */
  apply(pose: CarPose, vehicle: Vehicle) {
    this.root.position.copy(pose.pos);
    this.root.quaternion.copy(pose.quat);
    const rPhys = this.spec.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // body-space wheel height from the suspension, converted to model space
      const y = pose.wheelY[i] - (rPhys - w.radius) + this.spec.cgHeight;
      w.pivot.position.set(w.center.x, y, w.center.z);
      w.hub.position.copy(w.pivot.position);
      w.pivot.rotation.y = pose.steer[i];
      w.hub.rotation.y = pose.steer[i];
      w.pivot.rotation.x = (pose.spin[i] * rPhys) / w.radius;
    }
    for (const m of this.brakeMats) m.emissiveIntensity = pose.brake > 0.05 ? 3.2 : this.lightsOn ? 1 : 0.25;
    this.setBoost(vehicle.nitro.active);
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mm) => mm.dispose());
      } else if ((o as THREE.Sprite).isSprite) {
        const sm = (o as THREE.Sprite).material;
        sm.map?.dispose();
        sm.dispose();
      }
    });
  }
}

/** Captures the physics state needed for rendering (for interpolation between steps). */
export function capturePose(v: Vehicle, out?: CarPose): CarPose {
  const p = out ?? { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), wheelY: [0, 0, 0, 0], steer: [0, 0, 0, 0], spin: [0, 0, 0, 0], brake: 0 };
  p.pos.copy(v.pos);
  p.quat.copy(v.quat);
  for (let i = 0; i < 4; i++) {
    const w = v.wheels[i];
    p.wheelY[i] = w.mount.y - w.springLength;
    p.steer[i] = w.steer;
    p.spin[i] = w.spin;
  }
  p.brake = v.telemetry.brake;
  return p;
}

export function lerpPose(a: CarPose, b: CarPose, t: number, out: CarPose) {
  out.pos.lerpVectors(a.pos, b.pos, t);
  out.quat.slerpQuaternions(a.quat, b.quat, t);
  for (let i = 0; i < 4; i++) {
    out.wheelY[i] = a.wheelY[i] + (b.wheelY[i] - a.wheelY[i]) * t;
    out.steer[i] = a.steer[i] + (b.steer[i] - a.steer[i]) * t;
    let ds = b.spin[i] - a.spin[i];
    if (ds > Math.PI) ds -= Math.PI * 2;
    if (ds < -Math.PI) ds += Math.PI * 2;
    out.spin[i] = a.spin[i] + ds * t;
  }
  out.brake = b.brake;
  return out;
}
