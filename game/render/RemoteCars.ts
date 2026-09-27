import * as THREE from "three";
import { Peer } from "../network/Multiplayer";
import { carById } from "../physics/carSpecs";
import { CarView } from "./CarView";

interface Remote {
  view: CarView | null;
  target: Peer;
  spin: number;
  label: THREE.Sprite;
  flame: THREE.Mesh;
}

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

/** Smoothed visual opponents; cars do not collide over the network. */
export class RemoteCars {
  private cars = new Map<string, Remote>();
  private quaternion = new THREE.Quaternion();
  private position = new THREE.Vector3();
  constructor(private scene: THREE.Scene) {}

  update(peers: Peer[], dt: number, local: THREE.Vector3) {
    const ids = new Set(peers.map((p) => p.id));
    for (const [id, remote] of this.cars) if (!ids.has(id)) { this.remove(remote); this.cars.delete(id); }
    for (const peer of peers) {
      let remote = this.cars.get(peer.id);
      if (!remote) {
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.2, 6), new THREE.MeshBasicMaterial({ color: 0x67deff, transparent: true, opacity: 0.85, depthWrite: false }));
        flame.rotation.x = -Math.PI / 2;
        flame.position.set(0, -0.1, -2.4);
        remote = { view: null, target: peer, spin: 0, label: nameplate(peer.name, peer.color), flame };
        this.cars.set(peer.id, remote);
        const entry = remote;
        void CarView.create(carById(peer.carId), peer.color, false, true).then((view) => {
          if (this.cars.get(peer.id) !== entry) { view.dispose(); return; }
          entry.view = view;
          view.root.position.fromArray(entry.target.state.p);
          view.root.quaternion.fromArray(entry.target.state.q);
          view.root.add(entry.label, entry.flame);
          this.scene.add(view.root);
        }).catch(() => { /* A missing car asset must not stop the local race. */ });
      }
      remote.target = peer;
      const view = remote.view;
      if (!view) continue;
      this.position.fromArray(peer.state.p);
      this.quaternion.fromArray(peer.state.q);
      const blend = view.root.position.distanceToSquared(this.position) > 900 ? 1 : 1 - Math.exp(-14 * dt);
      view.root.position.lerp(this.position, blend);
      view.root.quaternion.slerp(this.quaternion, blend);
      remote.spin += peer.state.speed * dt / view.spec.wheelRadius;
      for (let i = 0; i < view.wheels.length; i++) {
        view.wheels[i].pivot.rotation.x = remote.spin;
        view.wheels[i].pivot.rotation.y = i < 2 ? peer.state.steer : 0;
      }
      remote.label.visible = view.root.position.distanceToSquared(local) < 250 * 250;
      remote.flame.visible = peer.state.nitro;
      remote.flame.scale.y = 0.8 + Math.sin(performance.now() * 0.04) * 0.2;
    }
  }

  private remove(remote: Remote) {
    if (remote.view) { remote.view.root.remove(remote.label, remote.flame); this.scene.remove(remote.view.root); remote.view.dispose(); }
    remote.label.material.map?.dispose(); remote.label.material.dispose();
    remote.flame.geometry.dispose(); (remote.flame.material as THREE.Material).dispose();
  }
  dispose() { for (const remote of this.cars.values()) this.remove(remote); this.cars.clear(); }
}
