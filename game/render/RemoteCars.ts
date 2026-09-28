import * as THREE from "three";
import { Peer } from "../network/Multiplayer";
import { carById } from "../physics/carSpecs";
import type { CircleCollider } from "../world/World";
import { CarView } from "./CarView";

interface Remote {
  view: CarView | null;
  target: Peer;
  spin: number;
  label: THREE.Sprite;
  /** Last received position, to notice a fresh packet. */
  lastX: number;
  lastZ: number;
  receivedAt: number;
  emote: THREE.Sprite | null;
  emoteAge: number;
}

/** Where an opponent is, which way it faces and how fast it goes (for bumps and slipstream). */
export interface RemoteCarState {
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  speed: number;
  cylinders: number;
}

/** Seconds of network and snapshot delay to predict opponents over. */
const LEAD = 0.1;

function nameplate(name: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 384; canvas.height = 64;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "rgba(10,18,24,0.84)";
  g.fillRect(0, 0, 384, 64);
  g.fillStyle = color; g.fillRect(0, 0, 8, 64);
  g.font = "600 28px system-ui"; g.fillStyle = "#ffffff";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(name, 196, 32, 340);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
  sprite.position.y = 2.6;
  sprite.scale.set(4.8, 0.8, 1);
  return sprite;
}

function emoteBubble(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "rgba(10,18,24,0.8)";
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.fill();
  g.font = "72px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji'";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  sprite.scale.set(1.8, 1.8, 1);
  return sprite;
}

/** Smoothed, slightly predicted opponents that the local car can bump into. */
export class RemoteCars {
  private cars = new Map<string, Remote>();
  private quaternion = new THREE.Quaternion();
  private position = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  /** Opponents this frame, for slipstream and collisions. */
  readonly states: RemoteCarState[] = [];
  constructor(private scene: THREE.Scene) {}

  update(peers: Peer[], dt: number, local: THREE.Vector3) {
    const now = performance.now() / 1000;
    const ids = new Set(peers.map((p) => p.id));
    for (const [id, remote] of this.cars) if (!ids.has(id)) { this.remove(remote); this.cars.delete(id); }
    this.states.length = 0;
    for (const peer of peers) {
      let remote = this.cars.get(peer.id);
      if (!remote) {
        remote = { view: null, target: peer, spin: 0, label: nameplate(peer.name, peer.color), lastX: NaN, lastZ: NaN, receivedAt: now, emote: null, emoteAge: 0 };
        this.cars.set(peer.id, remote);
        const entry = remote;
        void CarView.create(carById(peer.carId), peer.color, false, true).then((view) => {
          if (this.cars.get(peer.id) !== entry) { view.dispose(); return; }
          entry.view = view;
          view.root.position.fromArray(entry.target.state.p);
          view.root.quaternion.fromArray(entry.target.state.q);
          view.root.add(entry.label);
          this.scene.add(view.root);
        }).catch(() => { /* A missing car asset must not stop the local race. */ });
      }
      remote.target = peer;
      const s = peer.state;
      if (s.p[0] !== remote.lastX || s.p[2] !== remote.lastZ) {
        remote.lastX = s.p[0];
        remote.lastZ = s.p[2];
        remote.receivedAt = now;
      }
      const view = remote.view;
      if (!view) continue;
      // Dead reckoning: carry the car on along its heading for the time its update spent travelling.
      this.quaternion.fromArray(s.q);
      this.fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
      const ahead = s.speed * Math.min(0.4, now - remote.receivedAt + LEAD);
      this.position.fromArray(s.p).addScaledVector(this.fwd, ahead);
      const blend = view.root.position.distanceToSquared(this.position) > 900 ? 1 : 1 - Math.exp(-14 * dt);
      view.root.position.lerp(this.position, blend);
      view.root.quaternion.slerp(this.quaternion, blend);
      remote.spin += s.speed * dt / view.spec.wheelRadius;
      for (let i = 0; i < view.wheels.length; i++) {
        view.wheels[i].pivot.rotation.x = remote.spin;
        view.wheels[i].pivot.rotation.y = i < 2 ? s.steer : 0;
      }
      remote.label.visible = view.root.position.distanceToSquared(local) < 250 * 250;
      view.setBoost(s.nitro);
      if (remote.emote) {
        remote.emoteAge += dt;
        remote.emote.position.y = 3.7 + remote.emoteAge * 0.4;
        remote.emote.material.opacity = Math.min(1, (2.8 - remote.emoteAge) / 0.5);
        if (remote.emoteAge > 2.8) this.clearEmote(remote);
      }
      const p = view.root.position;
      const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
      this.states.push({ x: p.x, y: p.y, z: p.z, fx: this.fwd.x / fl, fz: this.fwd.z / fl, speed: s.speed, cylinders: view.spec.cylinders });
    }
  }

  /** Each opponent as two overlapping circles along its length, moving at its speed. */
  colliders(out: CircleCollider[]) {
    out.length = 0;
    for (const c of this.states) {
      for (const o of [1.15, -1.15]) out.push({ x: c.x + c.fx * o, z: c.z + c.fz * o, r: 1.05, kind: "car", vx: c.fx * c.speed, vz: c.fz * c.speed });
    }
    return out;
  }

  /** Floats an emoji above a player's car for a moment. */
  showEmote(id: string, text: string) {
    const remote = this.cars.get(id);
    if (!remote?.view) return;
    this.clearEmote(remote);
    remote.emote = emoteBubble(text);
    remote.emoteAge = 0;
    remote.view.root.add(remote.emote);
  }

  private clearEmote(remote: Remote) {
    if (!remote.emote) return;
    remote.emote.removeFromParent();
    remote.emote.material.map?.dispose();
    remote.emote.material.dispose();
    remote.emote = null;
  }

  private remove(remote: Remote) {
    this.clearEmote(remote);
    if (remote.view) { remote.view.root.remove(remote.label); this.scene.remove(remote.view.root); remote.view.dispose(); }
    remote.label.material.map?.dispose(); remote.label.material.dispose();
  }
  dispose() { for (const remote of this.cars.values()) this.remove(remote); this.cars.clear(); this.states.length = 0; }
}
