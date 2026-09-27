/**
 * Combined-slip tyre model.
 *
 * Longitudinal slip (wheel speed vs ground speed) and lateral slip (the angle between where
 * the tyre points and where it travels) are normalised by their peak values and combined into
 * one slip magnitude. Grip rises to a peak and then falls off towards a sliding level, and the
 * force points along the combined slip direction. This gives a friction circle: braking or
 * spinning the wheels uses up grip that is then unavailable for cornering.
 */

export interface TyreInput {
  vx: number; // contact patch velocity along the wheel heading
  vy: number; // contact patch velocity sideways (+ = left)
  omegaR: number; // wheel surface speed (omega * radius)
  load: number; // normal load, N
  mu: number; // peak friction after surface and load effects
  peakSlip: number;
  peakAngle: number;
  slide: number;
}

export interface TyreOutput {
  fx: number;
  fy: number;
  slipRatio: number;
  slipAngle: number;
  /** Combined normalised slip: <1 gripping, ~1 at the limit, >1 sliding. */
  combined: number;
}

/** Below this speed slip is measured against a fixed reference so it stays well behaved. */
export const SLIP_V_MIN = 2.0;

/** Normalised friction curve: 0 at 0, 1 at s = 1 (peak), easing to `slide` by s ≈ 3.5. */
export function frictionCurve(s: number, slide: number) {
  if (s <= 1) return Math.sin(s * Math.PI * 0.5);
  const t = Math.min(1, (s - 1) / 2.5);
  const e = t * t * (3 - 2 * t);
  return 1 - (1 - slide) * e;
}

export function tyreForce(i: TyreInput, out: TyreOutput): TyreOutput {
  const denom = Math.max(Math.abs(i.vx), SLIP_V_MIN);
  const kappa = (i.omegaR - i.vx) / denom;
  const tanAlpha = -i.vy / denom;
  const sx = kappa / i.peakSlip;
  const sy = tanAlpha / Math.tan(i.peakAngle);
  const s = Math.hypot(sx, sy);
  out.slipRatio = kappa;
  out.slipAngle = Math.atan2(i.vy, Math.abs(i.vx));
  out.combined = s;
  if (i.load <= 0 || s < 1e-9) {
    out.fx = 0;
    out.fy = 0;
    return out;
  }
  const f = i.mu * i.load * frictionCurve(s, i.slide);
  out.fx = (f * sx) / s;
  out.fy = (f * sy) / s;
  return out;
}

/** Effective peak friction including load sensitivity (heavily loaded tyres grip less per N). */
export function loadedMu(mu: number, load: number, refLoad: number, sensitivity: number) {
  const k = 1 - sensitivity * (load / refLoad - 1);
  return mu * Math.min(1.25, Math.max(0.6, k));
}
