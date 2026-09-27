export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};
export const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const DEG = Math.PI / 180;

/** Frame-rate independent exponential approach: returns the blend factor for `rate` per second. */
export const dampFactor = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
export const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * dampFactor(rate, dt);

/** Moves `current` towards `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number) =>
  current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);

export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, seed: number) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1]. */
export function valueNoise(x: number, y: number, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

/** Fractal value noise, roughly in [0,1]. */
export function fbm(x: number, y: number, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise for mountain silhouettes, in [0,1]. */
export function ridged(x: number, y: number, octaves = 5, seed = 0) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 31) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export function formatTime(t: number | null | undefined, showPlus = false) {
  if (t === null || t === undefined || !isFinite(t)) return "--:--.---";
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  const str = `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
  return neg ? `-${str}` : showPlus ? `+${str}` : str;
}

export function formatDelta(d: number) {
  if (!isFinite(d)) return "";
  const s = Math.abs(d).toFixed(2);
  return d < 0 ? `-${s}` : `+${s}`;
}
