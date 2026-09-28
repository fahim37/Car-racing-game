import * as THREE from "three";
import { Vehicle } from "../physics/Vehicle";
import { clamp, dampFactor, smoothstep, valueNoise, wrapAngle } from "../util/math";
import { World } from "../world/World";
import { CarView } from "./CarView";

export type CameraMode = "chase" | "chaseFar" | "hood" | "cockpit";
export const CAMERA_MODES: CameraMode[] = ["chase", "chaseFar", "hood", "cockpit"];
export const CAMERA_LABELS: Record<CameraMode, string> = { chase: "Chase", chaseFar: "Far chase", hood: "Hood", cockpit: "Cockpit" };

export interface CameraSettings {
  fov: number;
  speedFov: number; // extra degrees at high speed (0..8)
  shake: number; // 0..1
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = "chase";
  settings: CameraSettings = { fov: 62, speedFov: 4, shake: 0.35 };
  private heading = 0;
  private pitchSmooth = 0;
  private focusY = 0;
  private pullBack = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private initialised = false;
  private orbitAngle = 0;
  private shakeKick = 0;
  private headOffset = new THREE.Vector3();
  private lookBack = false;

  constructor(private world: World) {
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.08, 9000);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  reset() {
    this.initialised = false;
  }

  kick(amount: number) {
    this.shakeKick = Math.min(1, this.shakeKick + amount);
  }

  setLookBack(on: boolean) {
    this.lookBack = on;
  }

  /** Slow scenic orbit used behind menus. */
  updateOrbit(target: THREE.Vector3, dt: number, radius = 9, height = 2.2) {
    this.orbitAngle += dt * 0.08;
    const x = target.x + Math.cos(this.orbitAngle) * radius;
    const z = target.z + Math.sin(this.orbitAngle) * radius;
    const ground = this.world.terrainHeight(x, z);
    this.camera.position.set(x, Math.max(target.y + height, ground + 1.2), z);
    this.camera.lookAt(target.x, target.y + 0.6, target.z);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  update(v: Vehicle, view: CarView | null, pose: { pos: THREE.Vector3; quat: THREE.Quaternion }, dt: number, time: number) {
    const cam = this.camera;
    const speed = v.telemetry.speed;
    const fwd = tmp.set(0, 0, 1).applyQuaternion(pose.quat);
    const carHeading = Math.atan2(fwd.x, fwd.z);
    const velHeading = Math.atan2(v.vel.x, v.vel.z);
    const s = this.settings;

    // FOV widens a little with speed (subtle sense of pace).
    const targetFov = s.fov + Math.min(1, speed / 55) * s.speedFov + (this.mode === "cockpit" ? -4 : 0) + (v.nitro.active ? 9 : 0);
    cam.fov += (targetFov - cam.fov) * dampFactor(3, dt);

    // Camera shake: road texture at speed plus impacts; never large.
    this.shakeKick = Math.max(0, this.shakeKick - dt * 2.5);
    const rough = v.wheels.reduce((a, w) => a + (w.surface === 0 ? 0 : 1), 0) / 4;
    const shakeAmp = s.shake * (0.004 + rough * 0.012 + this.shakeKick * 0.05) * Math.min(1, speed / 25 + this.shakeKick);
    const sx = (valueNoise(time * 17, 1.3) - 0.5) * shakeAmp;
    const sy = (valueNoise(time * 19, 7.1) - 0.5) * shakeAmp;

    if (this.mode === "chase" || this.mode === "chaseFar") {
      const far = this.mode === "chaseFar";
      // Hills: follow the grade of the road (the direction of travel), not the body pitching under
      // braking and power, so the horizon stays calm.
      const pitch = speed > 3 ? Math.asin(clamp(v.vel.y / speed, -0.5, 0.5)) : Math.asin(clamp(fwd.y, -0.5, 0.5));
      // Follow a blend of where the car points and where it travels (shows slides nicely).
      const blend = 0.35 * smoothstep(2, 8, speed);
      let targetHeading = carHeading + wrapAngle(velHeading - carHeading) * blend;
      if (this.lookBack) targetHeading += Math.PI;
      if (!this.initialised) {
        this.heading = targetHeading;
        this.pitchSmooth = pitch;
        this.focusY = pose.pos.y;
        this.pullBack = 0;
        this.initialised = true;
      }
      this.heading += wrapAngle(targetHeading - this.heading) * dampFactor(this.lookBack ? 30 : 5.5, dt);
      this.pitchSmooth += (pitch - this.pitchSmooth) * dampFactor(3, dt);
      // Ride height is filtered, so suspension bounce and kerb strikes move the car rather than the
      // whole view; the climb rate is fed forward so the camera does not sag behind on hills.
      const climb = speed * Math.sin(this.pitchSmooth);
      this.focusY += (pose.pos.y + climb / 9 - this.focusY) * dampFactor(9, dt);
      // The camera eases back a little under power and closes in under braking: a sense of weight.
      this.pullBack += (clamp(v.telemetry.longG, -1, 1) * 0.45 - this.pullBack) * dampFactor(2.5, dt);
      const dist = (far ? 7.8 : 5.6) + Math.min(speed, 60) * 0.012 + this.pullBack;
      const height = far ? 2.5 : 1.75;
      const hx = Math.sin(this.heading);
      const hz = Math.cos(this.heading);
      const px = pose.pos.x - hx * dist;
      const pz = pose.pos.z - hz * dist;
      let py = this.focusY + height - Math.sin(this.pitchSmooth) * dist * 0.7;
      const ground = this.world.terrainHeight(px, pz);
      py = Math.max(py, ground + 0.6);
      this.pos.set(px, py, pz);
      this.look.set(pose.pos.x + hx * 3.2, this.focusY + 0.75 + Math.sin(this.pitchSmooth) * 3, pose.pos.z + hz * 3.2);
      cam.position.copy(this.pos);
      cam.position.x += sx;
      cam.position.y += sy;
      cam.lookAt(this.look);
      cam.near = 0.1;
    } else {
      // Attached views ride with the car; the horizon is partly stabilised for comfort.
      const local = this.mode === "hood" ? (view ? view.hoodLocal : tmp2.set(0, 0.62, 0.8)) : view ? view.eyeLocal : tmp2.set(0.36, 0.62, -0.2);
      // Head leans slightly against acceleration in the cockpit.
      if (this.mode === "cockpit") {
        const lat = v.telemetry.latG;
        const lon = v.telemetry.longG;
        const target = tmp2.set(-lat * 0.03, -Math.abs(lon) * 0.005, -lon * 0.025);
        this.headOffset.lerp(target, dampFactor(6, dt));
      } else this.headOffset.set(0, 0, 0);
      const worldPos = tmp.copy(local).add(this.headOffset).applyQuaternion(pose.quat).add(pose.pos);
      cam.position.copy(worldPos);
      cam.position.x += sx * 0.5;
      cam.position.y += sy * 0.5;
      // Blend car orientation with a level horizon.
      const yawOnly = tmpQ.setFromAxisAngle(tmp2.set(0, 1, 0), carHeading + (this.lookBack ? Math.PI : 0));
      const full = pose.quat.clone();
      if (this.lookBack) full.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      const q = yawOnly.clone().slerp(full, 0.55);
      // camera looks down -z; the car faces +z
      cam.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      cam.near = this.mode === "cockpit" ? 0.05 : 0.1;
      this.initialised = false;
    }
    cam.updateProjectionMatrix();
  }
}
