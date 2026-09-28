import * as THREE from "three";
import { Plant, Species, World } from "../world/World";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { loadGLTF, loadTexture } from "./assets";
import { buildFoliageModels, rockMaterial } from "./Foliage";
import { toFloatGeometry } from "./geometry";

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface Model {
  parts: Part[];
  height: number;
  radius: number;
}

interface NearSet {
  species: Species;
  variant: number;
  meshes: THREE.InstancedMesh[];
  radius: number;
  height: number;
  capacity: number;
  count: number;
  matrices: Float32Array;
  colors: Float32Array;
}

const TREE_SPECIES: Species[] = ["pine_a", "pine_b", "pine_c", "pine_d", "birch", "palm"];
const isTree = (s: Species) => (TREE_SPECIES as string[]).includes(s);

const windUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };

function addWind(material: THREE.Material, strength: number, key: string) {
  const m = material as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nuniform float uWind;`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 iOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 iOrigin = vec3(0.0);
#endif
float hgt = max(transformed.y, 0.0);
float ph = iOrigin.x * 0.071 + iOrigin.z * 0.053;
float sway = (sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 2.1 + ph * 1.7) * 0.25) * uWind * ${strength.toFixed(4)};
transformed.x += sway * hgt * hgt * 0.04;
transformed.z += sway * hgt * hgt * 0.025;
transformed.xyz += normal * sin(uTime * 4.0 + ph * 5.0 + transformed.y * 2.0) * ${(strength * 0.4).toFixed(4)} * uWind * hgt * 0.02;`,
      );
    if (m.alphaTest > 0) {
      // Canopy normals describe the whole crown, not the front/back of each leaf card.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_begin>",
        "#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif",
      );
    }
  };
  m.customProgramCacheKey = () => `wind-${key}`;
}

export class VegetationView {
  readonly group = new THREE.Group();
  private models = new Map<string, Model>();
  private near: NearSet[] = [];
  private impostors: THREE.InstancedMesh[] = [];
  private impostorUniforms = { uCamPos: { value: new THREE.Vector3() }, uNearRadius: { value: 120 } };
  private grid = new Map<number, Plant[]>();
  private lastCam = new THREE.Vector3(1e9, 0, 1e9);
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private col = new THREE.Color();
  private setIndex = new Map<string, NearSet>();
  private maxRadius = 0;
  private nearScale = 1;
  shadows = true;

  constructor(private world: World) {}

  static async load(world: World, renderer: THREE.WebGLRenderer, quality: { density: number; nearScale: number }) {
    const v = new VegetationView(world);
    await v.init(renderer, quality);
    return v;
  }

  private async init(renderer: THREE.WebGLRenderer, quality: { density: number; nearScale: number }) {
    this.nearScale = quality.nearScale;
    // Trees, shrubs and ferns: card-based models built from photoscanned sprites.
    const [foliage, gltf, rockTex] = await Promise.all([buildFoliageModels(), loadGLTF("nature/nature.glb"), loadTexture("textures/aerial_rocks_02_diffuse.jpg")]);
    for (const [id, model] of foliage) {
      for (const p of model.parts) {
        const isLeaves = (p.material as THREE.MeshStandardMaterial).alphaTest > 0;
        const mat = (p.material as THREE.MeshStandardMaterial).clone();
        addWind(mat, model.wind ?? (isLeaves ? 1 : 0.3), `${id}-${isLeaves ? "l" : "b"}`);
        p.material = mat;
      }
      this.models.set(id, model);
    }
    // Rocks: shapes from the CC0 pack, photo-textured and smooth-shaded.
    gltf.scene.updateMatrixWorld(true);
    const rockMat = rockMaterial(rockTex);
    for (const species of ["rocks", "rock_big", "rocks_small"] as Species[]) {
      const node = gltf.scene.getObjectByName(species);
      if (!node) continue;
      node.children.forEach((child, variant) => {
        const parts: Part[] = [];
        const box = new THREE.Box3();
        child.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          let geo = toFloatGeometry(mesh.geometry);
          geo.applyMatrix4(mesh.matrixWorld);
          geo.deleteAttribute("normal");
          geo.deleteAttribute("uv");
          geo = mergeVertices(geo, 1e-3);
          geo.computeVertexNormals();
          geo.computeBoundingBox();
          box.union(geo.boundingBox!);
          parts.push({ geometry: geo, material: rockMat });
        });
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        for (const p of parts) p.geometry.translate(-cx, -box.min.y, -cz);
        const size = box.getSize(new THREE.Vector3());
        this.models.set(`${species}:${variant}`, { parts, height: size.y, radius: Math.max(size.x, size.z) / 2 });
      });
    }

    // Spatial grid of plants for fast near-set queries.
    const plants = this.world.plants.filter((_, i) => quality.density >= 1 || (i * 7919) % 100 < quality.density * 100);
    for (const p of plants) {
      const key = this.key(Math.floor(p.x / 32), Math.floor(p.z / 32));
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(p);
    }

    // Near sets: one instanced mesh per model part, refilled as the camera moves. Trees are sparse,
    // so they stay full-detail out to a long way and impostors only fill the far distance.
    const radiusFor = (s: Species) => (isTree(s) ? 300 : s === "rock_big" ? 220 : s === "rocks" ? 180 : s === "bush" || s === "bushes" ? 130 : 100) * this.nearScale;
    for (const [id, model] of this.models) {
      const [species, variantStr] = id.split(":") as [Species, string];
      const variant = +variantStr;
      const all = plants.filter((p) => p.species === species && p.variant === variant);
      const radius = radiusFor(species);
      // Small sets are clustered in groves, so size them for every instance rather than the average density.
      const capacity = Math.max(1, all.length <= 4000 ? all.length : Math.min(all.length, Math.ceil(Math.PI * radius * radius * this.densityPerM2(all) * 1.6) + 60));
      // All parts of a model share one set of instance buffers.
      const matrices = new Float32Array(capacity * 16);
      const colors = new Float32Array(capacity * 3);
      const matAttr = new THREE.InstancedBufferAttribute(matrices, 16).setUsage(THREE.DynamicDrawUsage);
      const colAttr = new THREE.InstancedBufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
      const meshes = model.parts.map((part) => {
        const m = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        m.instanceMatrix = matAttr;
        m.instanceColor = colAttr;
        m.count = 0;
        m.castShadow = species !== "rocks_small" && species !== "bushes";
        m.receiveShadow = true;
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      });
      const set: NearSet = { species, variant, meshes, radius, height: model.height, capacity, count: 0, matrices, colors };
      this.near.push(set);
      this.setIndex.set(id, set);
      this.maxRadius = Math.max(this.maxRadius, radius);
    }

    // Distant trees: impostors rendered from the real models.
    this.impostorUniforms.uNearRadius.value = radiusFor("pine_a") - 8;
    for (const species of TREE_SPECIES) {
      const model = this.models.get(`${species}:0`);
      if (!model) continue;
      const list = plants.filter((p) => p.species === species);
      if (!list.length) continue;
      this.impostors.push(this.buildImpostor(renderer, species, model, list));
    }
  }

  private densityPerM2(list: Plant[]) {
    const b = this.world.extent;
    const area = (b.x1 - b.x0) * (b.z1 - b.z0);
    return list.length / area;
  }

  private key(cx: number, cz: number) {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  private buildImpostor(renderer: THREE.WebGLRenderer, species: Species, model: Model, plants: Plant[]) {
    const W = 384;
    const H = 768;
    const rt = new THREE.WebGLRenderTarget(W * 2, H, { samples: 4, colorSpace: THREE.NoColorSpace });
    rt.texture.generateMipmaps = true;
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    for (const p of model.parts) {
      const src = p.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshBasicMaterial({ map: src.map, color: src.color, alphaTest: 0.32, alphaToCoverage: true, side: THREE.DoubleSide, transparent: false, vertexColors: !!src.vertexColors });
      group.add(new THREE.Mesh(p.geometry, mat));
    }
    scene.add(group);
    const h = model.height;
    const r = Math.max(model.radius, h * 0.25);
    const cam = new THREE.OrthographicCamera(-r, r, h, 0, -50, 50);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevViewport = renderer.getViewport(new THREE.Vector4());
    const prevScissor = renderer.getScissor(new THREE.Vector4());
    const prevScissorTest = renderer.getScissorTest();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x1d2b17, 0);
    renderer.clear();
    for (let view = 0; view < 2; view++) {
      renderer.setViewport(view * W, 0, W, H);
      group.rotation.y = view * (Math.PI / 2);
      cam.position.set(0, 0, 10);
      cam.lookAt(0, 0, 0);
      renderer.render(scene, cam);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setViewport(prevViewport);
    renderer.setScissor(prevScissor);
    renderer.setScissorTest(prevScissorTest);

    // Two crossed quads, each showing one of the rendered views.
    const geo = new THREE.BufferGeometry();
    const pos: number[] = [];
    const uv: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    const quad = (ax: number, az: number, u0: number) => {
      const base = pos.length / 3;
      pos.push(-r * ax, 0, -r * az, r * ax, 0, r * az, r * ax, h, r * az, -r * ax, h, -r * az);
      uv.push(u0, 0, u0 + 0.5, 0, u0 + 0.5, 1, u0, 1);
      for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad(1, 0, 0);
    quad(0, -1, 0.5);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ map: rt.texture, alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.95 });
    const u = this.impostorUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nuniform vec3 uCamPos;\nuniform float uNearRadius;`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vec3 io = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
if (distance(io.xz, uCamPos.xz) < uNearRadius) transformed *= 0.0;`,
        );
    };
    mat.customProgramCacheKey = () => "impostor";
    const mesh = new THREE.InstancedMesh(geo, mat, plants.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const t = new THREE.Vector3();
    const col = new THREE.Color();
    plants.forEach((p, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      s.setScalar(p.scale);
      t.set(p.x, p.y - 0.1, p.z);
      m4.compose(t, q, s);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, this.tint(species, p.tint, col));
    });
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private tint(species: Species, t: number, out: THREE.Color) {
    if (species.startsWith("rock")) return out.setRGB(0.85 + t * 0.2, 0.85 + t * 0.2, 0.85 + t * 0.2);
    if (species === "palm") return out.setRGB(0.92 + t * 0.16, 0.92 + t * 0.1, 0.78 + (1 - t) * 0.14);
    // warmer / cooler greens
    return out.setRGB(0.82 + t * 0.25, 0.88 + t * 0.14, 0.8 + (1 - t) * 0.18);
  }

  update(camera: THREE.Vector3, time: number, wind: number) {
    windUniforms.uTime.value = time;
    windUniforms.uWind.value = wind;
    this.impostorUniforms.uCamPos.value.copy(camera);
  }

  /**
   * Refills the full-detail instances: plants near the camera that are inside the view frustum
   * (with a margin), plus everything close to the car so its surroundings still cast shadows.
   */
  updateNear(cam: THREE.Camera, focus: THREE.Vector3, force = false) {
    const camera = cam.position;
    cam.getWorldDirection(this.dir);
    const moved = Math.hypot(camera.x - this.lastCam.x, camera.z - this.lastCam.z);
    if (!force && moved < 2.5 && this.dir.dot(this.lastDir) > 0.9975) return;
    this.lastCam.copy(camera);
    this.lastDir.copy(this.dir);
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const maxR = this.maxRadius;
    const c0x = Math.floor((camera.x - maxR) / 32);
    const c1x = Math.floor((camera.x + maxR) / 32);
    const c0z = Math.floor((camera.z - maxR) / 32);
    const c1z = Math.floor((camera.z + maxR) / 32);
    for (const set of this.near) set.count = 0;
    const shadowRing = 55 * 55;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.grid.get(this.key(cx, cz));
        if (!list) continue;
        for (const p of list) {
          const set = this.setIndex.get(p.species + ":" + p.variant);
          if (!set) continue;
          const dx = p.x - camera.x;
          const dz = p.z - camera.z;
          if (dx * dx + dz * dz > set.radius * set.radius) continue;
          if (set.count >= set.capacity) continue;
          const fx = p.x - focus.x;
          const fz = p.z - focus.z;
          if (fx * fx + fz * fz > shadowRing) {
            // Sphere around the plant against the six frustum planes.
            const h = set.height * p.scale;
            const cy = p.y + h * 0.5;
            const rad = h * 0.6 + 4;
            let inside = true;
            for (let k = 0; k < 6; k++) {
              const pl = planes[k];
              if (pl.normal.x * p.x + pl.normal.y * cy + pl.normal.z * p.z + pl.constant < -rad) {
                inside = false;
                break;
              }
            }
            if (!inside) continue;
          }
          // Rotation about Y, uniform scale, translation (column-major 4x4).
          const c = Math.cos(p.rot) * p.scale;
          const sn = Math.sin(p.rot) * p.scale;
          const o = set.count * 16;
          const m = set.matrices;
          m[o] = c;
          m[o + 1] = 0;
          m[o + 2] = -sn;
          m[o + 3] = 0;
          m[o + 4] = 0;
          m[o + 5] = p.scale;
          m[o + 6] = 0;
          m[o + 7] = 0;
          m[o + 8] = sn;
          m[o + 9] = 0;
          m[o + 10] = c;
          m[o + 11] = 0;
          m[o + 12] = p.x;
          m[o + 13] = p.y - 0.1;
          m[o + 14] = p.z;
          m[o + 15] = 1;
          this.tint(set.species, p.tint, this.col);
          const co = set.count * 3;
          set.colors[co] = this.col.r;
          set.colors[co + 1] = this.col.g;
          set.colors[co + 2] = this.col.b;
          set.count++;
        }
      }
    }
    for (const set of this.near) {
      for (const mesh of set.meshes) {
        mesh.count = set.count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  setShadows(on: boolean) {
    this.shadows = on;
    for (const set of this.near) for (const m of set.meshes) m.castShadow = on && set.species !== "bushes" && set.species !== "rocks_small";
  }
}
