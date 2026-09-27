import * as THREE from "three";
import { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export const ASSET_BASE = "/assets";

export type Progress = (fraction: number, label: string) => void;

const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
const hdrLoader = new HDRLoader().setDataType(THREE.HalfFloatType);

const gltfCache = new Map<string, Promise<GLTF>>();
const texCache = new Map<string, Promise<THREE.Texture>>();
const hdrCache = new Map<string, Promise<THREE.DataTexture>>();

export function loadGLTF(path: string): Promise<GLTF> {
  let p = gltfCache.get(path);
  if (!p) {
    p = gltfLoader.loadAsync(`${ASSET_BASE}/${path}`);
    gltfCache.set(path, p);
  }
  return p;
}

export function loadTexture(path: string, srgb = true, repeat = true): Promise<THREE.Texture> {
  const key = `${path}|${srgb}`;
  let p = texCache.get(key);
  if (!p) {
    p = texLoader.loadAsync(`${ASSET_BASE}/${path}`).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
      return t;
    });
    texCache.set(key, p);
  }
  return p;
}

export function loadHDR(path: string): Promise<THREE.DataTexture> {
  let p = hdrCache.get(path);
  if (!p) {
    p = hdrLoader.loadAsync(`${ASSET_BASE}/${path}`).then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    });
    hdrCache.set(path, p);
  }
  return p;
}

/** Runs loaders in parallel while reporting overall progress. */
export async function loadAll<T extends Record<string, Promise<unknown>>>(jobs: T, progress?: Progress, label = "Loading"): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(jobs);
  let done = 0;
  const out: Record<string, unknown> = {};
  await Promise.all(
    keys.map((k) =>
      jobs[k].then((v) => {
        out[k] = v;
        done++;
        progress?.(done / keys.length, label);
      }),
    ),
  );
  return out as { [K in keyof T]: Awaited<T[K]> };
}
