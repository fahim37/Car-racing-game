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
    void vehicle;
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mm) => mm.dispose());
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
