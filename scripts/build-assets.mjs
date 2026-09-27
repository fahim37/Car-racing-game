// Downloads the free (CC0) source assets used by the game and converts them into
// compact, web/mobile friendly files under public/assets.
//
//   node scripts/build-assets.mjs
//
// Sources (all CC0 / public domain):
//   - Cars and nature models by Quaternius, via Poly Pizza (https://poly.pizza/u/Quaternius)
//   - PBR textures and HDRI skies from Poly Haven (https://polyhaven.com)
//
// Texture resizing uses ImageMagick (`magick` on PATH, or the MAGICK env var).

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  clearNodeTransform,
  dedup,
  flatten,
  join,
  mergeDocuments,
  prune,
  weld,
} from "@gltf-transform/functions";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const CACHE = path.join(ROOT, ".asset-cache");
const OUT = path.join(ROOT, "public", "assets");
const MAGICK = process.env.MAGICK || "magick";

const POLY = (id) => `https://static.poly.pizza/${id}.glb`;

const CARS = {
  // key: [poly.pizza static id, page id]
  coupe: ["34db1344-31cc-49ac-bc46-c055f68e39ca", "1mkmFkAz5v"],
  hatch: ["d35173c8-6078-4367-8f87-b1f2599f0bb7", "unqqkULtRU"],
  sedan: ["59a67a6c-490e-472e-bae6-5a4d2541f1c7", "Cz6yDaUcM9"],
  muscle: ["1847cc66-801a-42fd-9a87-47e86c7a5435", "Gzj704DXdr"],
};

const NATURE = {
  pine_a: ["c55b8641-4679-4a85-8bd8-2a20e79abecd", "699sFuLCN2"],
  pine_b: ["082c2026-56af-4e3f-bea7-9ae5de71101f", "79gmlLnweB"],
  pine_c: ["be462d46-2e48-401e-8da9-2f4d9bc9df0c", "Zt62gceKXZ"],
  pine_d: ["712aaefa-ae7f-4cb3-8834-a1b8860df3b2", "igSu0cPoBz"],
  birch: ["f51ba6c2-51e9-43ce-b2a9-ccb0230b55e6", "k6cozoNfLH"],
  bush: ["6bbb833e-26cb-4bf9-ae67-a31b98e30bd9", "ooG6CkLyE8"],
  bushes: ["11bcb3a1-5901-402c-9863-75988b9e21d8", "J2h3HrO356"],
  rocks: ["01671e28-0504-4db1-a5d5-af71ce0a6a1e", "gYhoEOKItJ"],
  rock_big: ["87d3dfd2-de47-4b03-b9f1-4c84c2a605b0", "RtLRqYjfMs"],
  rocks_small: ["c6f65def-08c5-4c81-b17f-f37b171ad911", "OQvi8PIZ40"],
};

// Poly Haven textures: [asset id, maps to fetch, output size]
const TEXTURES = [
  ["asphalt_track", ["Diffuse", "nor_gl", "Rough"], 1024],
  ["gravel_road", ["Diffuse", "nor_gl"], 512],
  ["leafy_grass", ["Diffuse"], 1024],
  ["forrest_ground_03", ["Diffuse"], 1024],
  ["aerial_rocks_02", ["Diffuse"], 1024],
  ["gravelly_sand", ["Diffuse"], 512],
];

const HDRIS = [
  "qwantani_morning_puresky",
  "qwantani_late_afternoon_puresky",
  "qwantani_dusk_2_puresky",
  "kloofendal_overcast_puresky",
];

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log("  downloaded", path.relative(ROOT, file));
  return file;
}

function magick(args) {
  execFileSync(MAGICK, args, { stdio: "inherit" });
}

/** Shrinks an embedded texture with ImageMagick. Keeps PNG when the image has alpha. */
function shrinkTexture(texture, maxSize, tmpDir) {
  const mime = texture.getMimeType();
  const image = texture.getImage();
  if (!image) return;
  const src = path.join(tmpDir, `src_${Math.random().toString(36).slice(2)}.${mime === "image/png" ? "png" : "jpg"}`);
  fs.writeFileSync(src, image);
  const opaque = execFileSync(MAGICK, [src, "-format", "%[opaque]", "info:"]).toString().trim() === "True";
  const isNormal = /normal/i.test(texture.getName() || texture.getURI() || "");
  const dst = src.replace(/\.(png|jpg)$/, opaque ? "_o.jpg" : "_o.png");
  if (opaque) {
    magick([src, "-resize", `${maxSize}x${maxSize}>`, "-quality", isNormal ? "92" : "84", dst]);
  } else {
    magick([src, "-resize", `${maxSize}x${maxSize}>`, "-strip", "-define", "png:compression-level=9", dst]);
  }
  texture.setImage(new Uint8Array(fs.readFileSync(dst)));
  texture.setMimeType(opaque ? "image/jpeg" : "image/png");
  texture.setURI("");
}

async function processCars(io) {
  console.log("Cars");
  const outDir = path.join(OUT, "cars");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [key, [id]] of Object.entries(CARS)) {
    const src = await download(POLY(id), path.join(CACHE, "cars", `${key}.glb`));
    const doc = await io.read(src);
    await doc.transform(flatten());
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh()) clearNodeTransform(node);
    }
    // Normalise node names so the game can find the wheels regardless of source naming.
    for (const node of doc.getRoot().listNodes()) {
      const name = node.getName();
      if (!node.getMesh()) continue;
      if (/FrontLeftWheel|FrontWheel_L/i.test(name)) node.setName("wheel_fl");
      else if (/FrontRightWheel|FrontWheel_R/i.test(name)) node.setName("wheel_fr");
      else if (/BackWheels|RearWheels/i.test(name)) node.setName("wheels_rear");
      else node.setName("body");
    }
    await doc.transform(dedup(), prune(), weld());
    const tmp = path.join(CACHE, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    for (const tex of doc.getRoot().listTextures()) shrinkTexture(tex, 256, tmp);
    await io.write(path.join(outDir, `${key}.glb`), doc);
    console.log("  wrote cars/" + key + ".glb", (fs.statSync(path.join(outDir, `${key}.glb`)).size / 1024).toFixed(0) + "KB");
  }
}

async function processNature(io) {
  console.log("Nature");
  const tmp = path.join(CACHE, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  let target = null;
  let targetScene = null;
  for (const [key, [id]] of Object.entries(NATURE)) {
    const src = await download(POLY(id), path.join(CACHE, "nature", `${key}.glb`));
    const doc = await io.read(src);
    await doc.transform(flatten());
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh()) clearNodeTransform(node);
    }
    // Leaves: alpha-tested instead of blended (cheaper, sorts correctly, casts cut-out shadows).
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getAlphaMode() === "BLEND") mat.setAlphaMode("MASK").setAlphaCutoff(0.45);
      mat.setDoubleSided(mat.getAlphaMode() === "MASK");
    }
    // Group every mesh node of this model under one named root. Packs that contain several
    // separate items (e.g. a row of rocks) keep one child per item, named `${key}_${i}`.
    const scene = doc.getRoot().listScenes()[0];
    const group = doc.createNode(key);
    let index = 0;
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      if (child.getMesh()) child.setName(`${key}_${index++}`);
      group.addChild(child);
    }
    scene.addChild(group);
    await doc.transform(join({ keepNamed: true }), prune());

    if (!target) {
      target = doc;
      targetScene = scene;
    } else {
      const map = mergeDocuments(target, doc);
      for (const s of doc.getRoot().listScenes()) {
        const merged = map.get(s);
        for (const child of merged.listChildren()) {
          merged.removeChild(child);
          targetScene.addChild(child);
        }
        merged.dispose();
      }
    }
  }
  await target.transform(dedup(), prune(), weld());
  for (const tex of target.getRoot().listTextures()) shrinkTexture(tex, 512, tmp);
  const buffers = target.getRoot().listBuffers();
  for (let i = 1; i < buffers.length; i++) {
    for (const acc of target.getRoot().listAccessors()) if (acc.getBuffer() === buffers[i]) acc.setBuffer(buffers[0]);
    buffers[i].dispose();
  }
  const dst = path.join(OUT, "nature", "nature.glb");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await io.write(dst, target);
  console.log("  wrote nature/nature.glb", (fs.statSync(dst).size / 1024).toFixed(0) + "KB");
}

async function processTextures() {
  console.log("Textures");
  for (const [id, maps, size] of TEXTURES) {
    const info = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
    for (const map of maps) {
      const entry = info[map]?.["1k"]?.jpg || info[map]?.["2k"]?.jpg;
      if (!entry) throw new Error(`Missing ${map} for ${id}`);
      const src = await download(entry.url, path.join(CACHE, "textures", `${id}_${map}.jpg`));
      const dst = path.join(OUT, "textures", `${id}_${map.toLowerCase()}.jpg`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      magick([src, "-resize", `${size}x${size}>`, "-quality", map === "nor_gl" ? "92" : "85", "-strip", dst]);
      console.log("  wrote", path.relative(OUT, dst));
    }
  }
}

async function processHdris() {
  console.log("HDRIs");
  for (const id of HDRIS) {
    const info = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
    for (const res of ["1k", "2k"]) {
      const url = info.hdri[res].hdr.url;
      const dst = path.join(OUT, "sky", `${id}_${res}.hdr`);
      if (!fs.existsSync(dst)) {
        const src = await download(url, path.join(CACHE, "sky", `${id}_${res}.hdr`));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      console.log("  wrote", path.relative(OUT, dst));
    }
  }
}

/**
 * Foliage atlases from Poly Haven's CC0 photoscans (fir_tree_01 twigs and bark, jacaranda_tree
 * leaves, fern_02 fronds). Colour and alpha are merged into WebP; the game composes realistic
 * branch and leaf-cluster textures from these sprites at load time.
 */
async function processFoliage() {
  console.log("Foliage");
  const dir = path.join(CACHE, "foliage");
  const out = path.join(OUT, "foliage");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const base = "https://dl.polyhaven.org/file/ph-assets/Models";
  const files = {
    twigDiff: `${base}/png/1k/fir_tree_01/fir_tree_01_twig_diff_1k.png`,
    twigAlpha: `${base}/png/1k/fir_tree_01/fir_tree_01_twig_alpha_1k.png`,
    barkDiff: `${base}/png/1k/fir_tree_01/fir_tree_01_bark_diff_1k.png`,
    barkNor: `${base}/png/1k/fir_tree_01/fir_tree_01_bark_nor_gl_1k.png`,
    leafDiff: `${base}/png/1k/jacaranda_tree/jacaranda_tree_leaves_diff_1k.png`,
    leafAlpha: `${base}/png/1k/jacaranda_tree/jacaranda_tree_leaves_alpha_1k.png`,
    fernDiff: `${base}/jpg/1k/fern_02/fern_02_diff_1k.jpg`,
    fernAlpha: `${base}/png/1k/fern_02/fern_02_alpha_1k.png`,
  };
  const local = {};
  for (const [k, url] of Object.entries(files)) local[k] = await download(url, path.join(dir, path.basename(url)));
  const rgba = (diff, alpha, dst, size) =>
    magick([diff, alpha, "-alpha", "off", "-compose", "CopyOpacity", "-composite", "-resize", `${size}x${size}`, "-define", "webp:alpha-quality=90", "-quality", "88", path.join(out, dst)]);
  rgba(local.twigDiff, local.twigAlpha, "twigs.webp", 1024);
  rgba(local.leafDiff, local.leafAlpha, "leaves.webp", 1024);
  rgba(local.fernDiff, local.fernAlpha, "fern.webp", 1024);
  magick([local.barkDiff, "-resize", "512x512", "-quality", "86", path.join(out, "bark.jpg")]);
  magick([local.barkNor, "-resize", "512x512", "-quality", "90", path.join(out, "bark_nor.jpg")]);
  for (const f of fs.readdirSync(out)) console.log("  wrote foliage/" + f, (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + "KB");
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.mkdirSync(OUT, { recursive: true });
if (process.argv.includes("--legacy-cars")) await processCars(io);
await processNature(io);
await processTextures();
await processHdris();
await processFoliage();
console.log("Done.");
