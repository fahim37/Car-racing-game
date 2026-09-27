// Renders a top-down map of the track layout for design review.
//   npx tsx scripts/preview-track.ts out.png
import { getTrack } from "../game/track/Track";
import { Raster } from "./png";

const track = getTrack();
const out = process.argv[2] || "track.png";
const b = track.bounds;
const pad = 120;
const scale = 0.9;
const W = Math.ceil((b.maxX - b.minX + pad * 2) * scale);
const H = Math.ceil((b.maxZ - b.minZ + pad * 2) * scale);
const img = new Raster(W, H, [236, 240, 232]);
// Map: +x to the left of the image so the picture matches a view from above with +z up.
const px = (x: number) => (b.maxX + pad - x) * scale;
const pz = (z: number) => (b.maxZ + pad - z) * scale;

// Terrain preview hook (optional)
const extra = (globalThis as unknown as { __drawExtra?: (img: Raster, px: (x: number) => number, pz: (z: number) => number) => void }).__drawExtra;
if (extra) extra(img, px, pz);

for (let i = 0; i < track.count; i++) {
  const f = track.frameAt(i);
  const hw = f.halfWidth;
  const grade = Math.abs(f.grade);
  const c: [number, number, number] = grade > 0.08 ? [200, 60, 40] : grade > 0.05 ? [200, 140, 40] : [60, 60, 70];
  img.line(px(f.x + f.nx * hw), pz(f.z + f.nz * hw), px(f.x - f.nx * hw), pz(f.z - f.nz * hw), c);
}
for (const r of track.rails) {
  for (let s = r.s0; s < r.s1; s += 2) {
    const f = track.frameAt(s);
    const d = (f.halfWidth + r.offset) * r.side;
    img.dot(px(f.x + f.nx * d), pz(f.z + f.nz * d), 1, [30, 30, 200]);
  }
}
for (const k of track.kerbs) {
  for (let s = k.s0; s < k.s1; s += 1.5) {
    const f = track.frameAt(s);
    const d = (f.halfWidth + 0.5) * k.side;
    img.set(px(f.x + f.nx * d), pz(f.z + f.nz * d), [220, 30, 30]);
  }
}
for (const c of track.corners) {
  const f = track.frameAt(c.sApex);
  img.dot(px(f.x), pz(f.z), 4, [240, 200, 0]);
}
const f0 = track.frameAt(0);
img.line(px(f0.x + f0.nx * 8), pz(f0.z + f0.nz * 8), px(f0.x - f0.nx * 8), pz(f0.z - f0.nz * 8), [0, 160, 0], 2);
img.save(out);

console.log(`length ${track.length.toFixed(1)} m, samples ${track.count}`);
console.log("segments:", track.layout.map((s) => (s.kind === "straight" ? `S${s.len.toFixed(0)}` : `${s.short}:${s.angle.toFixed(0)}`)).join(" "));
let maxGrade = 0;
for (let i = 0; i < track.count; i++) maxGrade = Math.max(maxGrade, Math.abs(track.frameAt(i).grade));
console.log(`max grade ${(maxGrade * 100).toFixed(1)}%, y range ${Math.min(...track.y).toFixed(1)}..${Math.max(...track.y).toFixed(1)}`);
for (const c of track.corners) console.log(`${c.short} ${c.name} R${c.radius} ${c.angle.toFixed(0)}deg apex s=${c.sApex.toFixed(0)}`);
// self-proximity check: closest approach between samples > 150 m apart along the lap
let minSep = Infinity;
let where = "";
for (let i = 0; i < track.count; i += 2) {
  for (let j = i + 150; j < track.count; j += 2) {
    if (track.length - (j - i) < 150) continue;
    const d = Math.hypot(track.x[i] - track.x[j], track.z[i] - track.z[j]);
    if (d < minSep) {
      minSep = d;
      where = `${i} vs ${j}`;
    }
  }
}
console.log(`min separation of distant sections: ${minSep.toFixed(1)} m (${where})`);
