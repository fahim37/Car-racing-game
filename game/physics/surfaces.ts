export enum Surface {
  Asphalt = 0,
  Kerb = 1,
  Gravel = 2,
  Grass = 3,
  Dirt = 4,
  Sand = 5,
  Rock = 6,
  Water = 7,
}

export interface SurfaceProps {
  name: string;
  /** Friction multiplier relative to the tyre's dry-asphalt peak grip. */
  grip: number;
  /** Rolling resistance coefficient (force = coeff * load). */
  rollRes: number;
  /** Fraction of peak grip remaining when fully sliding. Loose surfaces fall off less. */
  slide: number;
  /** Multiplier on the slip needed to reach peak grip (loose surfaces are "softer"). */
  peakScale: number;
  /** Surface roughness amplitude in metres, felt through the suspension. */
  bump: number;
  /** Counts as the paved racing surface for track-limit checks. */
  paved: boolean;
}

const DRY: Record<Surface, SurfaceProps> = {
  [Surface.Asphalt]: { name: "Asphalt", grip: 1, rollRes: 0.012, slide: 0.76, peakScale: 1, bump: 0, paved: true },
  [Surface.Kerb]: { name: "Kerb", grip: 0.9, rollRes: 0.016, slide: 0.74, peakScale: 1, bump: 0.004, paved: true },
  [Surface.Gravel]: { name: "Gravel", grip: 0.62, rollRes: 0.035, slide: 0.9, peakScale: 1.8, bump: 0.008, paved: false },
  [Surface.Grass]: { name: "Grass", grip: 0.52, rollRes: 0.05, slide: 0.86, peakScale: 1.5, bump: 0.012, paved: false },
  [Surface.Dirt]: { name: "Forest floor", grip: 0.58, rollRes: 0.045, slide: 0.88, peakScale: 1.6, bump: 0.015, paved: false },
  [Surface.Sand]: { name: "Sand", grip: 0.46, rollRes: 0.11, slide: 0.92, peakScale: 2, bump: 0.006, paved: false },
  [Surface.Rock]: { name: "Rock", grip: 0.72, rollRes: 0.02, slide: 0.8, peakScale: 1.2, bump: 0.02, paved: false },
  [Surface.Water]: { name: "Water", grip: 0.25, rollRes: 0.25, slide: 0.9, peakScale: 2, bump: 0.01, paved: false },
};

const WET_GRIP: Record<Surface, number> = {
  [Surface.Asphalt]: 0.7,
  [Surface.Kerb]: 0.55,
  [Surface.Gravel]: 0.92,
  [Surface.Grass]: 0.78,
  [Surface.Dirt]: 0.8,
  [Surface.Sand]: 1,
  [Surface.Rock]: 0.8,
  [Surface.Water]: 1,
};

/** Surface properties for a given wetness (0 = dry, 1 = fully wet). */
export function surfaceProps(surface: Surface, wetness: number, out: SurfaceProps = { ...DRY[Surface.Asphalt] }): SurfaceProps {
  const d = DRY[surface];
  out.name = d.name;
  out.grip = d.grip * (1 - wetness * (1 - WET_GRIP[surface]));
  out.rollRes = d.rollRes;
  out.slide = d.slide - (surface === Surface.Asphalt || surface === Surface.Kerb ? 0.08 * wetness : 0);
  out.peakScale = d.peakScale;
  out.bump = d.bump;
  out.paved = d.paved;
  return out;
}

export const SURFACE_NAMES = Object.values(DRY).map((s) => s.name);
