// Renders a shaded top-down map of the generated world (terrain, water, vegetation, road).
//   npx tsx scripts/preview-world.ts out.png
import { World, WATER_Y, CELL } from "../game/world/World";
import { Raster } from "./png";

const t0 = performance.now();
const world = new World().generateSync();
const t1 = performance.now();
console.log(`world ${world.cols}x${world.rows} generated in ${(t1 - t0).toFixed(0)} ms, plants ${world.plants.length}`);
const counts: Record<string, number> = {};
for (const p of world.plants) counts[p.species] = (counts[p.species] || 0) + 1;
console.log(counts);

const scale = 0.5; // pixels per metre
const W = Math.floor(world.cols * CELL * scale);
const H = Math.floor(world.rows * CELL * scale);
const img = new Raster(W, H);
const x1 = world.x0 + (world.cols - 1) * CELL;
const z1 = world.z0 + (world.rows - 1) * CELL;
const px = (x: number) => (x1 - x) * scale;
const pz = (z: number) => (z1 - z) * scale;
let minH = Infinity;
let maxH = -Infinity;
for (const h of world.heights) {
  minH = Math.min(minH, h);
  maxH = Math.max(maxH, h);
}
console.log(`height range ${minH.toFixed(1)} .. ${maxH.toFixed(1)}`);
const n = { x: 0, y: 1, z: 0 };
for (let py = 0; py < H; py++) {
  for (let pxi = 0; pxi < W; pxi++) {
    const x = x1 - pxi / scale;
    const z = z1 - py / scale;
    const h = world.terrainHeight(x, z, n);
    const shade = Math.max(0.35, Math.min(1.2, 0.75 + (n.x * 0.5 + n.z * 0.5) * 2.5));
    let c: [number, number, number];
    if (h < WATER_Y) {
      const d = Math.min(1, (WATER_Y - h) / 8);
      c = [60 - d * 30, 110 - d * 40, 150 - d * 30];
    } else {
      const t = Math.min(1, (h - WATER_Y) / 60);
      const s = world.terrainSurface(x, z);
      const base: [number, number, number] =
        s === 5 ? [200, 185, 140] : s === 6 ? [130, 125, 115] : s === 4 ? [95, 110, 60] : [120 + t * 40, 150 + t * 20, 80];
      c = [base[0] * shade, base[1] * shade, base[2] * shade].map((v) => Math.max(0, Math.min(255, v))) as [number, number, number];
    }
    img.set(pxi, py, c);
  }
}
for (const p of world.plants) {
  const col: [number, number, number] = p.species.startsWith("pine")
    ? [25, 70, 35]
    : p.species === "birch"
      ? [140, 170, 70]
      : p.species.startsWith("bush")
        ? [60, 130, 50]
        : [90, 90, 95];
  img.dot(px(p.x), pz(p.z), p.species.startsWith("pine") ? 1 : 0, col);
}
const t = world.track;
for (let i = 0; i < t.count; i++) {
  const f = t.frameAt(i);
  img.line(px(f.x + f.nx * f.halfWidth), pz(f.z + f.nz * f.halfWidth), px(f.x - f.nx * f.halfWidth), pz(f.z - f.nz * f.halfWidth), [50, 50, 55]);
}
img.save(process.argv[2] || "world.png");
