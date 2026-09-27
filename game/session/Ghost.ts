import * as THREE from "three";
import { Vehicle } from "../physics/Vehicle";

const HZ = 20;
const STRIDE = 8; // x y z qx qy qz qw steer

export interface GhostData {
  hz: number;
  duration: number;
  frames: Float32Array;
}

export class GhostRecorder {
  private frames: number[] = [];
  private acc = 0;
  private t = 0;

  start() {
    this.frames = [];
    this.acc = 0;
    this.t = 0;
  }

  sample(dt: number, v: Vehicle) {
    if (this.frames.length === 0) this.push(v);
    this.t += dt;
    this.acc += dt;
    while (this.acc >= 1 / HZ) {
      this.acc -= 1 / HZ;
      this.push(v);
    }
  }

  private push(v: Vehicle) {
    this.frames.push(v.pos.x, v.pos.y, v.pos.z, v.quat.x, v.quat.y, v.quat.z, v.quat.w, v.telemetry.steerAngle);
  }

  finish(): GhostData {
    return { hz: HZ, duration: this.t, frames: Float32Array.from(this.frames) };
  }
}

export function encodeGhost(g: GhostData): string {
  const bytes = new Uint8Array(g.frames.buffer, g.frames.byteOffset, g.frames.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return JSON.stringify({ hz: g.hz, duration: g.duration, data: btoa(bin) });
}

export function decodeGhost(s: string | null): GhostData | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as { hz: number; duration: number; data: string };
    const bin = atob(o.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { hz: o.hz, duration: o.duration, frames: new Float32Array(bytes.buffer) };
  } catch {
    return null;
  }
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** Interpolated ghost pose at time t (seconds since the ghost's start). */
export function ghostPoseAt(g: GhostData, t: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
  const n = g.frames.length / STRIDE;
  if (n === 0) return false;
  const f = Math.max(0, Math.min(n - 1.0001, t * g.hz));
  const i = Math.floor(f);
  const k = f - i;
  const a = i * STRIDE;
  const b = Math.min(n - 1, i + 1) * STRIDE;
  const F = g.frames;
  pos.set(F[a] + (F[b] - F[a]) * k, F[a + 1] + (F[b + 1] - F[a + 1]) * k, F[a + 2] + (F[b + 2] - F[a + 2]) * k);
  qa.set(F[a + 3], F[a + 4], F[a + 5], F[a + 6]);
  qb.set(F[b + 3], F[b + 4], F[b + 5], F[b + 6]);
  quat.slerpQuaternions(qa, qb, k);
  return t <= g.duration + 0.5;
}
