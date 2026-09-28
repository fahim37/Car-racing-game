import * as THREE from "three";
import { SHOULDER_WIDTH } from "../track/layout";
import { Track } from "../track/Track";
import { World } from "../world/World";

const GATE_COUNT = 7;
const HEIGHT = 5.2;
/** Seconds a gate stays dim after it has been collected. */
const RECHARGE = 20;

interface Gate {
  s: number;
  halfWidth: number;
  root: THREE.Group;
  frame: THREE.MeshStandardMaterial;
  curtain: THREE.ShaderMaterial;
  icon: THREE.Mesh;
  cooldown: number;
  level: number; // 0 = spent, 1 = charged (eased)
  flash: number;
}

const CURTAIN_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CURTAIN_FRAG = `uniform float uTime; uniform float uLevel; uniform float uFlash; varying vec2 vUv;
void main() {
  // Bands of light rising through a thin field, bright at the frame and fading out near the road.
  float bands = pow(0.5 + 0.5 * sin((vUv.y * 9.0 - uTime * 2.4) * 3.14159), 5.0);
  float edge = smoothstep(0.06, 0.0, min(vUv.x, 1.0 - vUv.x)) + smoothstep(0.08, 0.0, 1.0 - vUv.y);
  float a = (0.07 + 0.3 * bands + 0.7 * edge) * smoothstep(0.0, 0.3, vUv.y);
  vec3 col = mix(vec3(0.18, 0.72, 1.0), vec3(0.85, 0.97, 1.0), bands * 0.4 + uFlash);
  gl_FragColor = vec4(col * (0.35 + 1.4 * uLevel + 3.0 * uFlash), a);
  #include <colorspace_fragment>
}`;

/**
 * Glowing gates across the road that top up the nitro tank. They sit on the straightest stretches,
 * spread around the lap; a collected gate dims and recharges after a while.
 */
export class NitroGates {
  readonly group = new THREE.Group();
  private gates: Gate[] = [];
  private time = { value: 0 };
  private lastS = NaN;

  constructor(
    private track: Track,
    world: World,
  ) {
    const L = track.length;
    const pillarGeo = new THREE.BoxGeometry(0.32, 1, 0.32);
    const iconGeo = new THREE.OctahedronGeometry(0.55);
    for (let k = 0; k < GATE_COUNT; k++) {
      const s = this.straightestNear(((k + 0.5) * L) / GATE_COUNT, 110);
      const f = track.frameAt(s);
      const half = f.halfWidth + SHOULDER_WIDTH + 0.6;
      const root = new THREE.Group();
      // Local frame: +x to the left of the road, +y up, +z along the direction of travel.
      const left = new THREE.Vector3(f.nx, 0, f.nz);
      const fwd = new THREE.Vector3(f.tx, 0, f.tz);
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, new THREE.Vector3(0, 1, 0), fwd));
      root.position.set(f.x, f.y, f.z);
      const frame = new THREE.MeshStandardMaterial({ color: 0x0d1820, emissive: 0x3fd0ff, emissiveIntensity: 1.6, metalness: 0.5, roughness: 0.35 });
      for (const side of [1, -1]) {
        const x = f.x + f.nx * half * side;
        const z = f.z + f.nz * half * side;
        const ground = Math.min(world.terrainHeight(x, z), track.roadHeight(s, half * side)) - f.y - 0.8;
        const pillar = new THREE.Mesh(pillarGeo, frame);
        pillar.scale.y = HEIGHT - ground;
        pillar.position.set(half * side, (HEIGHT + ground) / 2, 0);
        pillar.castShadow = true;
        root.add(pillar);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.32, 0.34, 0.34), frame);
      beam.position.y = HEIGHT;
      beam.castShadow = true;
      root.add(beam);
      const curtain = new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uLevel: { value: 1 }, uFlash: { value: 0 } },
        vertexShader: CURTAIN_VERT,
        fragmentShader: CURTAIN_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, HEIGHT - 0.17), curtain);
      plane.position.y = (HEIGHT - 0.17) / 2;
      root.add(plane);
      const icon = new THREE.Mesh(iconGeo, frame);
      icon.position.y = HEIGHT + 1.2;
      root.add(icon);
      this.group.add(root);
      this.gates.push({ s, halfWidth: f.halfWidth, root, frame, curtain, icon, cooldown: 0, level: 1, flash: 0 });
    }
  }

  /** The point near `target` whose surroundings are closest to straight. */
  private straightestNear(target: number, range: number) {
    let best = target;
    let bestK = Infinity;
    for (let s = target - range; s <= target + range; s += 5) {
      let k = 0;
      for (let o = -30; o <= 30; o += 10) k = Math.max(k, Math.abs(this.track.frameAt(s + o).curvature));
      if (k < bestK) {
        bestK = k;
        best = s;
      }
    }
    return this.track.wrap(best);
  }

  /** Recharges every gate and forgets the car's last position (new event, respawn). */
  reset() {
    for (const g of this.gates) {
      g.cooldown = 0;
      g.level = 1;
      g.flash = 0;
    }
    this.lastS = NaN;
  }

  /**
   * Animates the gates and reports a gate the car has just driven through while it was charged.
   * `car` is the car's track position, or null when it cannot collect (menus, paused, no nitro).
   */
  update(dt: number, time: number, car: { s: number; d: number } | null): boolean {
    this.time.value = time;
    let collected = false;
    const moved = car && !isNaN(this.lastS) ? this.track.delta(this.lastS, car.s) : NaN;
    for (const g of this.gates) {
      // Forward through the gate line this frame (a respawn or reversing never counts).
      if (car && moved > 0 && moved < 30 && g.cooldown <= 0) {
        const ahead = this.track.delta(this.lastS, g.s);
        if (ahead > 0 && ahead <= moved && Math.abs(car.d) < g.halfWidth + SHOULDER_WIDTH + 0.5) {
          g.cooldown = RECHARGE;
          g.flash = 1;
          collected = true;
        }
      }
      g.cooldown = Math.max(0, g.cooldown - dt);
      g.level += ((g.cooldown > 0 ? 0 : 1) - g.level) * Math.min(1, dt * (g.cooldown > 0 ? 6 : 1.5));
      g.flash = Math.max(0, g.flash - dt * 2.2);
      g.frame.emissiveIntensity = 0.25 + 1.5 * g.level + 4 * g.flash;
      g.curtain.uniforms.uLevel.value = g.level;
      g.curtain.uniforms.uFlash.value = g.flash;
      g.icon.visible = g.level > 0.5;
      g.icon.rotation.y = time * 1.8;
      g.icon.position.y = HEIGHT + 1.2 + Math.sin(time * 2.2 + g.s) * 0.18;
    }
    this.lastS = car ? car.s : NaN;
    return collected;
  }
}
