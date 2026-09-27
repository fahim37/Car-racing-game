import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SHOULDER_WIDTH } from "../track/layout";
import { Track } from "../track/Track";
import { World, WATER_Y } from "../world/World";

/** Draws a sign face into a canvas texture. */
function signTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 256) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function boardTexture(label: string) {
  return signTexture((ctx, w, h) => {
    ctx.fillStyle = "#f4f4f0";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "bold 120px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, w / 2, h / 2 + 6);
  }, 256, 256);
}

const chevronTex = () =>
  signTexture((ctx, w, h) => {
    ctx.fillStyle = "#1f1f1f";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f2c230";
    ctx.beginPath();
    ctx.moveTo(w * 0.25, h * 0.12);
    ctx.lineTo(w * 0.72, h * 0.5);
    ctx.lineTo(w * 0.25, h * 0.88);
    ctx.lineTo(w * 0.42, h * 0.88);
    ctx.lineTo(w * 0.89, h * 0.5);
    ctx.lineTo(w * 0.42, h * 0.12);
    ctx.closePath();
    ctx.fill();
  });

const curveWarningTex = (left: boolean, tight: boolean) =>
  signTexture((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#f2c230";
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 10;
    const s = w * 0.6;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeRect(-s / 2 + 8, -s / 2 + 8, s - 16, s - 16);
    ctx.restore();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.beginPath();
    const dir = left ? -1 : 1;
    ctx.moveTo(w / 2, h * 0.72);
    if (tight) {
      ctx.lineTo(w / 2, h * 0.45);
      ctx.arc(w / 2 + dir * 22, h * 0.45, 22, Math.PI, left ? Math.PI * 2 : 0, !left);
      ctx.lineTo(w / 2 + dir * 44, h * 0.55);
    } else {
      ctx.quadraticCurveTo(w / 2, h * 0.4, w / 2 + dir * 40, h * 0.3);
    }
    ctx.stroke();
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    const tipX = tight ? w / 2 + dir * 44 : w / 2 + dir * 40;
    const tipY = tight ? h * 0.62 : h * 0.26;
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - dir * 14 - (tight ? 0 : 6), tipY + (tight ? -18 : 14));
    ctx.lineTo(tipX + dir * 14 - (tight ? 0 : -6), tipY + (tight ? -18 : 14));
    ctx.fill();
  });

export class PropsView {
  readonly group = new THREE.Group();

  constructor(private world: World) {
    const track = world.track;
    this.buildRails(track);
    this.buildCornerSigns(track);
    this.buildStartGantry(track);
    this.buildPadCones();
    this.buildJetty(track);
    this.buildMarkerPosts(track);
  }

  private buildRails(track: Track) {
    const postGeo = new THREE.BoxGeometry(0.12, 1.1, 0.16);
    postGeo.translate(0, 0.35, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d8f, metalness: 0.6, roughness: 0.5 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcbf, metalness: 0.75, roughness: 0.35, side: THREE.DoubleSide });
    const posts: THREE.Matrix4[] = [];
    for (const r of track.rails) {
      const pos: number[] = [];
      const idx: number[] = [];
      const step = 2;
      const n = Math.ceil((r.s1 - r.s0) / step);
      // W-beam profile (lateral offset from rail line, height)
      const profile: [number, number][] = [
        [0, 0.52],
        [0.06, 0.58],
        [0, 0.64],
        [0.06, 0.7],
        [0, 0.76],
      ];
      for (let i = 0; i <= n; i++) {
        const s = r.s0 + (i * (r.s1 - r.s0)) / n;
        const f = track.frameAt(s);
        const d = (f.halfWidth + r.offset) * r.side;
        const base = track.roadHeight(s, (f.halfWidth + SHOULDER_WIDTH) * r.side) - 0.1 + (Math.min(r.offset, 20) > SHOULDER_WIDTH ? 0 : 0);
        const y0 = Math.max(base, this.world.terrainHeight(f.x + f.nx * d, f.z + f.nz * d));
        for (const [off, hgt] of profile) {
          const dd = d - r.side * off;
          pos.push(f.x + f.nx * dd, y0 + hgt, f.z + f.nz * dd);
        }
        if (i % 2 === 0) {
          const m = new THREE.Matrix4().makeRotationY(f.heading);
          m.setPosition(f.x + f.nx * (d + r.side * 0.12), y0, f.z + f.nz * (d + r.side * 0.12));
          posts.push(m);
        }
      }
      const cols = profile.length;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < cols - 1; k++) {
          const a = i * cols + k;
          idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, railMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    const inst = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    posts.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.castShadow = true;
    inst.receiveShadow = true;
    this.group.add(inst);
  }

  private placeSign(track: Track, s: number, d: number, tex: THREE.Texture, w: number, h: number, height: number, mirror = false) {
    const f = track.frameAt(s);
    const x = f.x + f.nx * d;
    const z = f.z + f.nz * d;
    const y = Math.max(track.roadHeight(s, d), this.world.terrainHeight(x, z));
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, height + h / 2, 8), POST_MAT);
    post.position.y = (height + h / 2) / 2;
    post.castShadow = true;
    g.add(post);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, roughness: 0.6, side: THREE.FrontSide }));
    board.position.set(0, height + h / 2, -0.05);
    board.rotation.y = Math.PI; // face oncoming traffic (towards -tangent)
    if (mirror) board.scale.x = -1;
    board.castShadow = true;
    g.add(board);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), BACK_MAT);
    back.position.set(0, height + h / 2, -0.06);
    g.add(back);
    g.position.set(x, y, z);
    g.rotation.y = f.heading;
    this.group.add(g);
  }

  private buildCornerSigns(track: Track) {
    const chev = chevronTex();
    for (const c of track.corners) {
      const flat = track.layout.some((l) => l.kind === "turn" && l.short === c.short && l.flat);
      if (flat) continue;
      const outside = -c.dir;
      if (c.radius < 120) {
        // Chevrons on the outside through the corner.
        const n = Math.max(3, Math.round((c.sEnd - c.sStart) / 18));
        for (let i = 0; i < n; i++) {
          const s = c.sStart + ((c.sEnd - c.sStart) * (i + 0.5)) / n;
          const f = track.frameAt(s);
          const rail = track.railAt(s, outside as 1 | -1);
          const d = outside * (f.halfWidth + (rail ? rail.offset + 0.6 : SHOULDER_WIDTH + 2.2));
          // Chevron arrow points in the turning direction.
          this.placeSign(track, s, d, chev, 0.75, 0.9, 0.9, c.dir > 0);
        }
      }
      // Warning sign well before the corner, on the right-hand verge.
      const warnS = c.sStart - 140;
      const tight = c.radius < 30;
      const fw = track.frameAt(warnS);
      this.placeSign(track, warnS, -(fw.halfWidth + SHOULDER_WIDTH + 1.6), curveWarningTex(c.dir > 0, tight), 1.1, 1.1, 1.3);
    }
  }

  /** Distance boards before the heavy braking zones. */
  private buildMarkerPosts(track: Track) {
    const boards = { 150: boardTexture("150"), 100: boardTexture("100"), 50: boardTexture("50") };
    for (const short of ["T2", "T6", "T7", "T10", "T12"]) {
      const c = track.corners.find((k) => k.short === short);
      if (!c) continue;
      for (const dist of [150, 100, 50] as const) {
        const s = c.sStart - dist + 10;
        const f = track.frameAt(s);
        const side = -c.dir; // outside of the approach
        this.placeSign(track, s, side * (f.halfWidth + SHOULDER_WIDTH + 1.3), boards[dist], 0.8, 0.8, 0.5);
      }
    }
  }

  private buildStartGantry(track: Track) {
    const f = track.frameAt(0);
    const span = f.halfWidth + 2.2;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c3136, metalness: 0.5, roughness: 0.45 });
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 0.4), mat);
      pillar.position.set(side * span, 3, 0);
      pillar.castShadow = true;
      g.add(pillar);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.4, 0.9, 0.35), mat);
    beam.position.set(0, 5.6, 0);
    beam.castShadow = true;
    g.add(beam);
    const banner = signTexture((ctx, w, h) => {
      ctx.fillStyle = "#1c2a2f";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#e8e4d8";
      ctx.font = "600 64px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("LARCHMERE", w / 2, h / 2 + 4);
    }, 1024, 128);
    for (const face of [1, -1]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(span * 1.6, 0.7), new THREE.MeshStandardMaterial({ map: banner, roughness: 0.7 }));
      b.position.set(0, 5.6, face * 0.18);
      if (face < 0) b.rotation.y = Math.PI;
      g.add(b);
    }
    // Start lights
    const lightMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000, roughness: 0.3 });
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), lightMat.clone());
      l.position.set((i - 2) * 0.5, 4.95, -0.2);
      l.rotation.y = Math.PI;
      g.add(l);
      this.startLights.push(l);
    }
    g.position.set(f.x, f.y, f.z);
    g.rotation.y = f.heading;
    this.group.add(g);
  }

  startLights: THREE.Mesh[] = [];

  /** Countdown lights: n lit red (0..5), or green. */
  setStartLights(red: number, green: boolean) {
    this.startLights.forEach((l, i) => {
      const m = l.material as THREE.MeshStandardMaterial;
      if (green) {
        m.color.set(0x0b3d12);
        m.emissive.set(0x33ff66);
        m.emissiveIntensity = 2;
      } else if (i < red) {
        m.color.set(0x330000);
        m.emissive.set(0xff2a1a);
        m.emissiveIntensity = 2.5;
      } else {
        m.color.set(0x1a0505);
        m.emissive.set(0x000000);
      }
    });
  }

  private buildPadCones() {
    const w = this.world;
    const track = w.track;
    const pad = w.pad;
    const cone = new THREE.ConeGeometry(0.22, 0.6, 12);
    cone.translate(0, 0.3, 0);
    const base = new THREE.BoxGeometry(0.4, 0.04, 0.4);
    base.translate(0, 0.02, 0);
    const geo = mergeGeometries([cone, base]);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.55 });
    const spots: [number, number][] = [];
    const sMid = (pad.s0 + pad.s1) / 2;
    const dMid = (pad.d0 + pad.d1) / 2;
    // Two drift circles (figure-eight) and the pad corners.
    for (const [cs, cd] of [
      [sMid - 26, dMid],
      [sMid + 26, dMid],
    ]) {
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        spots.push([cs + Math.cos(a) * 3, cd + Math.sin(a) * 3]);
      }
      spots.push([cs, cd]);
    }
    for (const s of [pad.s0 + 2, pad.s1 - 2]) for (const d of [pad.d0 + 2, pad.d1 - 2]) spots.push([s, d]);
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach(([s, d], i) => {
      const f = track.frameAt(s);
      const x = f.x + f.nx * d;
      const z = f.z + f.nz * d;
      const y = w.padHeight({ s, d, i: 0, dist: 0 });
      inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y, z));
    });
    inst.castShadow = true;
    this.group.add(inst);
    this.padCircles = [
      [sMid - 26, dMid],
      [sMid + 26, dMid],
    ];
  }

  padCircles: [number, number][] = [];

  private buildJetty(track: Track) {
    // A timber jetty reaching into the lake beside the Jetty Corner, and a small boathouse.
    const c = track.corners.find((k) => k.short === "T12");
    if (!c) return;
    const s = c.sApex + 40;
    const f = track.frameAt(s);
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b5238, roughness: 0.85 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 });
    // find the shore on the right-hand side
    let shoreD = -(f.halfWidth + 10);
    for (let d = -(f.halfWidth + 6); d > -200; d -= 1) {
      const x = f.x + f.nx * d;
      const z = f.z + f.nz * d;
      if (this.world.terrainHeight(x, z) < WATER_Y + 0.3) {
        shoreD = d;
        break;
      }
    }
    const g = new THREE.Group();
    const len = 34;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, len), wood);
    deck.position.set(0, 0.9, -len / 2 + 4);
    deck.castShadow = true;
    deck.receiveShadow = true;
    g.add(deck);
    for (let k = 0; k <= len / 4; k++) {
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3, 8), darkWood);
        p.position.set(side * 1.1, -0.4, 4 - k * 4);
        p.castShadow = true;
        g.add(p);
      }
    }
    // Boathouse at the shore end
    const house = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 7), new THREE.MeshStandardMaterial({ color: 0x7a3b2e, roughness: 0.9 }));
    walls.position.y = 1.6;
    walls.castShadow = true;
    walls.receiveShadow = true;
    house.add(walls);
    const roofGeo = new THREE.CylinderGeometry(0.01, 4.6, 2.2, 4, 1);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.scale(1, 1, 1.2);
    const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x2f3432, roughness: 0.8 }));
    roof.position.y = 4.3;
    roof.castShadow = true;
    house.add(roof);
    house.position.set(6, 0, 6);
    g.add(house);
    const x = f.x + f.nx * shoreD;
    const z = f.z + f.nz * shoreD;
    g.position.set(x, WATER_Y, z);
    // point the jetty out across the water (away from the road)
    g.rotation.y = Math.atan2(-f.nx, -f.nz) + Math.PI;
    const hy = this.world.terrainHeight(x + 6, z + 6);
    house.position.y = Math.max(0, hy - WATER_Y);
    this.group.add(g);
  }
}

const POST_MAT = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, metalness: 0.5, roughness: 0.5 });
const BACK_MAT = new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.4, roughness: 0.6, side: THREE.BackSide });
