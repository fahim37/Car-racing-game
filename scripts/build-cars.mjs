// Converts the high-detail CC0 concept cars (Unity Fan's "FREE Concept Car" series, Sketchfab)
// into web-ready files under public/assets/cars:
//   - baked transforms, junk removed, car facing +z, tyres on y = 0, centred between the axles
//   - materials renamed by role (Paint, Glass, Wheel_*, Hub_*, TailLight, HeadLight) so the game
//     can recolour the paint, animate brake lights and split the wheels
//   - a full version and a lighter "_lite" version (for phones / Medium quality)
//   - meshopt geometry compression, textures resized
//
//   node scripts/build-cars.mjs
// Source GLBs are expected in .asset-cache/sketchfab/<key>.glb (downloaded with a Sketchfab account).

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { clearNodeTransform, cloneDocument, dedup, flatten, meshopt, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC = path.join(ROOT, ".asset-cache", "sketchfab");
const OUT = path.join(ROOT, "public", "assets", "cars");
const TMP = path.join(ROOT, ".asset-cache", "tmp");
const MAGICK = process.env.MAGICK || "magick";

/**
 * Per-car configuration. Regexes match source material names.
 *  front: +1 if the car already faces +z, -1 if it faces -z
 *  wheel: parts that spin with the wheel (tyres, rims, discs)
 *  hub: parts that steer but do not spin (brake calipers)
 *  drop: materials to delete (shadow planes etc.)
 */
const CARS = {
  c038: { scale: 0.0118, tire: /rubber___tires/i, front: 1, paint: /body_color/i, glass: /plasticShiny/i, wheel: /rims|rubber|tire|protector|metal_1.001/i, hub: /brakeCalipers/i, tail: /^Material.001$/i, head: /headlightCovers/i, drop: [] },
  khronos: { tire: /^Tiretread$/, front: 1, paint: /^Paint 1 Carmine$/, glass: /^Glass$/, wheel: /^(Tireside|Tiretread|Rim1|Rim2|Disc)$/, hub: /^Brake$/, tail: /^Brakelight$/, head: /^Headlight$/, drop: [/^License$/], stripTextures: /^Tireside$/ },
  c037: { tire: /rubber___tires/i, front: -1, paint: /body_color/i, glass: /^Material.002$/i, wheel: /rims|rubber|tire|protector|metal_1.001/i, hub: /brakeCalipers/i, tail: /^Material.003$/i, head: /headlightCovers/i, drop: [] },
  c025: { tire: /rubber___tires/i, front: 1, paint: /body_color/i, glass: /plasticShiny/i, wheel: /rims|rubber|tire|protector|metal_1.001|chrome.001/i, hub: /brakeCalipers/i, tail: /taillight/i, head: /headlightCovers|^light$/i, drop: [] },
  c040: { tire: /rubber___tires/i, front: 1, paint: /body_color/i, glass: /plasticShiny/i, wheel: /rims|rubber|tire|protector|metal_1.001/i, hub: /brakeCalipers/i, tail: /chrome_StopLight|^Material.002$/i, head: /headlightCovers|turnlight/i, drop: [] },
  c039: { tire: /rubber___tires/i, front: 1, paint: /body_color/i, glass: /plasticShiny/i, wheel: /rims|rubber|tire|protector|metal_1.001/i, hub: /brakeCalipers/i, tail: /^Material.001$/i, head: /headlightCovers|turnlight/i, drop: [] },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });

function forEachPosition(doc, fn) {
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) fn(prim);
}

/** Removes triangles whose centroid lies outside a box (strays far from the car). */
function clipPrimitive(doc, prim, keep) {
  const pos = prim.getAttribute("POSITION");
  const idx = prim.getIndices();
  if (!pos) return;
  const n = idx ? idx.getCount() : pos.getCount();
  const get = (i) => (idx ? idx.getScalar(i) : i);
  const kept = [];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  for (let t = 0; t < n; t += 3) {
    pos.getElement(get(t), a);
    pos.getElement(get(t + 1), b);
    pos.getElement(get(t + 2), c);
    if (keep((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)) kept.push(get(t), get(t + 1), get(t + 2));
  }
  if (kept.length === n) return;
  const maxIndex = pos.getCount();
  const arr = maxIndex > 65535 ? new Uint32Array(kept) : new Uint16Array(kept);
  const acc = doc.createAccessor().setType("SCALAR").setArray(arr).setBuffer(doc.getRoot().listBuffers()[0]);
  prim.setIndices(acc);
}

function boundsOf(doc, filter) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  forEachPosition(doc, (prim) => {
    if (filter && !filter(prim)) return;
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    for (let i = 0; i < n; i++) {
      pos.getElement(idx ? idx.getScalar(i) : i, v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  });
  return { min, max };
}

function transformAll(doc, fn) {
  const done = new Set();
  forEachPosition(doc, (prim) => {
    for (const sem of ["POSITION", "NORMAL"]) {
      const acc = prim.getAttribute(sem);
      if (!acc || done.has(acc)) continue;
      done.add(acc);
      const v = [0, 0, 0];
      for (let i = 0; i < acc.getCount(); i++) {
        acc.getElement(i, v);
        acc.setElement(i, fn(v, sem));
      }
    }
  });
}

function shrinkTextures(doc, size) {
  fs.mkdirSync(TMP, { recursive: true });
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    const mime = tex.getMimeType();
    const src = path.join(TMP, `c_${Math.random().toString(36).slice(2)}.${mime === "image/png" ? "png" : "jpg"}`);
    fs.writeFileSync(src, img);
    const opaque = execFileSync(MAGICK, [src, "-format", "%[opaque]", "info:"]).toString().trim() === "True";
    const dst = src.replace(/\.(png|jpg)$/, opaque ? "_o.jpg" : "_o.png");
    execFileSync(MAGICK, [src, "-resize", `${size}x${size}>`, ...(opaque ? ["-quality", "86"] : ["-strip"]), dst]);
    tex.setImage(new Uint8Array(fs.readFileSync(dst)));
    tex.setMimeType(opaque ? "image/jpeg" : "image/png");
    tex.setURI("");
  }
}

async function build(key, cfg) {
  const file = path.join(SRC, `${key}.glb`);
  if (!fs.existsSync(file)) {
    console.warn(`  skip ${key}: ${file} not found`);
    return null;
  }
  const doc = await io.read(file);
  await doc.transform(flatten());
  for (const n of doc.getRoot().listNodes()) if (n.getMesh()) clearNodeTransform(n);

  // Drop unwanted materials' primitives.
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const name = prim.getMaterial()?.getName() ?? "";
      if (cfg.drop.some((r) => r.test(name))) prim.dispose();
    }
  }

  // Source units to metres.
  if (cfg.scale) transformAll(doc, (v, sem) => (sem === "NORMAL" ? v : [v[0] * cfg.scale, v[1] * cfg.scale, v[2] * cfg.scale]));
  // Remove trademark decals: strip base colour textures from selected materials.
  if (cfg.stripTextures) for (const m of doc.getRoot().listMaterials()) if (cfg.stripTextures.test(m.getName() ?? "")) m.setBaseColorTexture(null).setBaseColorFactor([0.06, 0.06, 0.065, 1]);

  // Face +z (rotate 180 degrees about y, including tangents).
  if (cfg.front < 0) {
    transformAll(doc, (v) => [-v[0], v[1], -v[2]]);
    const seen = new Set();
    forEachPosition(doc, (prim) => {
      const t = prim.getAttribute("TANGENT");
      if (!t || seen.has(t)) return;
      seen.add(t);
      const v = [0, 0, 0, 0];
      for (let i = 0; i < t.getCount(); i++) {
        t.getElement(i, v);
        t.setElement(i, [-v[0], v[1], -v[2], v[3]]);
      }
    });
  }

  // Core box from the painted body; clip strays well outside it.
  const body = boundsOf(doc, (p) => cfg.paint.test(p.getMaterial()?.getName() ?? ""));
  const pad = 0.6;
  forEachPosition(doc, (prim) =>
    clipPrimitive(doc, prim, (x, y, z) => x > body.min[0] - pad && x < body.max[0] + pad && y > -0.3 && y < body.max[1] + pad && z > body.min[2] - pad && z < body.max[2] + pad),
  );

  // Wheels: find the four tyre clusters to get axle positions and the rolling radius.
  const isWheel = (p) => cfg.tire.test(p.getMaterial()?.getName() ?? "");
  const wb = boundsOf(doc, isWheel);
  const cx = (wb.min[0] + wb.max[0]) / 2;
  const cz = (wb.min[2] + wb.max[2]) / 2;
  const quad = [0, 1, 2, 3].map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  forEachPosition(doc, (prim) => {
    if (!isWheel(prim)) return;
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    const v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(idx ? idx.getScalar(i) : i, v);
      const q = (v[0] >= cx ? 0 : 1) + (v[2] >= cz ? 0 : 2); // 0 FL, 1 FR, 2 RL, 3 RR
      for (let k = 0; k < 3; k++) {
        quad[q].min[k] = Math.min(quad[q].min[k], v[k]);
        quad[q].max[k] = Math.max(quad[q].max[k], v[k]);
      }
    }
  });
  const centres = quad.map((b) => b.min.map((m, k) => (m + b.max[k]) / 2));
  const radius = quad.reduce((a, b) => a + (b.max[1] - b.min[1]) / 2, 0) / 4;
  const groundY = Math.min(...quad.map((b) => b.min[1]));
  const zFront = (centres[0][2] + centres[1][2]) / 2;
  const zRear = (centres[2][2] + centres[3][2]) / 2;
  const zMid = (zFront + zRear) / 2;
  // Recentre: axle midpoint at z = 0, tyres on the ground, symmetric in x.
  transformAll(doc, (v, sem) => (sem === "NORMAL" ? v : [v[0] - cx, v[1] - groundY, v[2] - zMid]));

  // Rename materials by role.
  const roles = new Map();
  for (const mat of doc.getRoot().listMaterials()) {
    const n = mat.getName() ?? "";
    let role = null;
    if (cfg.paint.test(n)) role = "Paint";
    else if (cfg.glass.test(n)) role = "Glass";
    else if (cfg.hub.source !== "^$" && cfg.hub.test(n)) role = `Hub_${n}`;
    else if (cfg.wheel.test(n)) role = `Wheel_${n}`;
    else if (cfg.tail.test(n)) role = `TailLight_${n}`;
    else if (cfg.head.test(n)) role = `HeadLight_${n}`;
    if (role) {
      roles.set(n, role);
      mat.setName(role);
    }
    // Sketchfab exports often mark opaque parts as blended; keep blending only for glass.
    if (mat.getAlphaMode() === "BLEND" && role !== "Glass" && !/cover/i.test(n)) mat.setAlphaMode("OPAQUE");
  }

  await doc.transform(weld(), dedup(), prune());
  shrinkTextures(doc, 1024);

  const info = {
    key,
    wheelbase: +(zFront - zRear).toFixed(3),
    trackFront: +(centres[0][0] - centres[1][0]).toFixed(3),
    trackRear: +(centres[2][0] - centres[3][0]).toFixed(3),
    wheelRadius: +radius.toFixed(3),
    length: +(body.max[2] - body.min[2]).toFixed(2),
    width: +(body.max[0] - body.min[0]).toFixed(2),
    height: +(body.max[1] - groundY).toFixed(2),
    frontOverhang: +(body.max[2] - zMid - (zFront - zMid)).toFixed(2),
  };

  const countTris = (d) => {
    let t = 0;
    for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) t += (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3;
    return Math.round(t);
  };

  // Full version: cap very dense meshes, keep detail elsewhere.
  const full = cloneDoc(doc);
  if (countTris(full) > 200000) await full.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 200000 / countTris(full), error: 0.0008 }));
  await full.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  await io.write(path.join(OUT, `${key}.glb`), full);

  // Lite version for phones and Medium quality.
  const lite = cloneDoc(doc);
  await lite.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, 45000 / countTris(lite)), error: 0.004 }));
  await lite.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  shrinkTextures(lite, 512);
  await io.write(path.join(OUT, `${key}_lite.glb`), lite);

  const sz = (f) => (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2) + "MB";
  console.log(`  ${key}: full ${sz(`${key}.glb`)} (${countTris(full)} tris), lite ${sz(`${key}_lite.glb`)} (${countTris(lite)} tris)`, JSON.stringify(info));
  return info;
}

function cloneDoc(doc) {
  return cloneDocument(doc);
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const summary = {};
for (const [key, cfg] of Object.entries(CARS)) {
  if (only.length && !only.includes(key)) continue;
  const info = await build(key, cfg);
  if (info) summary[key] = info;
}
const infoFile = path.join(OUT, "cars.json");
const prev = fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, "utf8")) : {};
fs.writeFileSync(infoFile, JSON.stringify({ ...prev, ...summary }, null, 2));
