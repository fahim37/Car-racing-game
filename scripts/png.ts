// Minimal RGB raster + PNG writer for dev tooling (track previews, terrain maps).
import fs from "node:fs";
import zlib from "node:zlib";

export class Raster {
  data: Uint8Array;
  constructor(public w: number, public h: number, bg: [number, number, number] = [255, 255, 255]) {
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3);
  }
  set(x: number, y: number, c: [number, number, number]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 3);
  }
  dot(x: number, y: number, r: number, c: [number, number, number]) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) this.set(x + dx, y + dy, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (r > 0) this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, c);
      else this.set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c);
    }
  }
  save(file: string) {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.data.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const crcTable = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (buf: Buffer) => {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const tb = Buffer.concat([Buffer.from(type), body]);
      const c = Buffer.alloc(4);
      c.writeUInt32BE(crc(tb));
      return Buffer.concat([len, tb, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
      ]),
    );
  }
}
