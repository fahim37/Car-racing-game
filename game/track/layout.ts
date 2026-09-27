/**
 * Larchmere Lakeside Loop: a closed scenic road around the eastern shore of a mountain lake.
 *
 * The road is described like a surveyor would lay it out: straights and constant-radius
 * arcs joined by clothoid (Euler spiral) transitions, so curvature changes smoothly the way
 * it does on real roads. Positive angles turn left. The loop runs counter-clockwise, so
 * the lake (outside the loop) is always on the driver's right.
 */

export type LayoutSegment =
  | { kind: "straight"; len: number; width?: number; y?: number; adjust?: boolean }
  | {
      kind: "turn";
      angle: number; // degrees, + = left
      radius: number;
      spiral: number; // clothoid length on entry and exit
      width?: number;
      y?: number;
      name: string;
      short: string;
      closing?: boolean; // angle is solved so the loop closes
      flat?: boolean; // taken flat out; not a braking corner
    };

export const START_Y = 3.2;

export const LAYOUT: LayoutSegment[] = [
  /* 0 */ { kind: "straight", len: 200, width: 11, y: 3.4 },
  /* 1 */ { kind: "turn", angle: 34, radius: 260, spiral: 60, width: 10.5, y: 4.2, name: "Lakeshore Sweep", short: "T1" },
  /* 2 */ { kind: "straight", len: 170, width: 10.5, y: 6 },
  /* 3 */ { kind: "turn", angle: 100, radius: 44, spiral: 24, width: 11, y: 7.5, name: "Larch Bend", short: "T2" },
  /* 4 */ { kind: "straight", len: 160, width: 10, y: 15.5 },
  /* 5 */ { kind: "turn", angle: -44, radius: 90, spiral: 32, width: 9.5, y: 19.5, name: "Fern Esses", short: "T3" },
  /* 6 */ { kind: "straight", len: 45, width: 9.5, y: 21.5 },
  /* 7 */ { kind: "turn", angle: 40, radius: 72, spiral: 30, width: 9.5, y: 24.5, name: "Fern Esses", short: "T4" },
  /* 8 */ { kind: "straight", len: 45, width: 9.5, y: 26.5 },
  /* 9 */ { kind: "turn", angle: -50, radius: 100, spiral: 32, width: 9.5, y: 29.5, name: "Fern Esses", short: "T5" },
  /* 10 */ { kind: "straight", len: 260, width: 9.5, y: 30 },
  /* 11 */ { kind: "turn", angle: 170, radius: 18, spiral: 18, width: 11.5, y: 26.5, name: "Pine Hairpin", short: "T6" },
  /* 12 */ { kind: "straight", len: 220, width: 10, y: 15 },
  /* 13 */ { kind: "turn", angle: -40, radius: 58, spiral: 26, width: 10, y: 11, name: "Mill Corner", short: "T7" },
  /* 14 */ { kind: "straight", len: 300, width: 10, y: 9, adjust: true },
  /* 15 */ { kind: "turn", angle: -14, radius: 380, spiral: 40, width: 10, y: 8, name: "Birch Kink", short: "T8", flat: true },
  /* 16 */ { kind: "straight", len: 120, width: 10, y: 7.5 },
  /* 17 */ { kind: "turn", angle: 14, radius: 380, spiral: 40, width: 10, y: 7, name: "Birch Kink", short: "T9", flat: true },
  /* 18 */ { kind: "straight", len: 80, width: 10, y: 6.5 },
  /* 19 */ { kind: "turn", angle: 50, radius: 38, spiral: 22, width: 10.5, y: 5.5, name: "Heron Turn", short: "T10" },
  /* 20 */ { kind: "straight", len: 250, width: 10, y: 4.3, adjust: true },
  /* 21 */ { kind: "turn", angle: 40, radius: 300, spiral: 60, width: 10, y: 3.8, name: "Far Shore Curve", short: "T11" },
  /* 22 */ { kind: "straight", len: 120, width: 10.5, y: 3.6 },
  /* 23 */ { kind: "turn", angle: 0, radius: 36, spiral: 22, width: 11, y: 3.4, name: "Jetty Corner", short: "T12", closing: true },
  /* 24 */ { kind: "straight", len: 150, width: 11, y: START_Y },
];

export const SHOULDER_WIDTH = 1.4;
export const KERB_WIDTH = 1.0;

/** Sector boundaries: index of the layout segment where each sector starts. */
export const SECTOR_STARTS = [0, 4, 11, 14];
export const SECTOR_NAMES = ["Lakeshore", "Fern Esses", "Hairpin & Mill", "Birch Run & Jetty"];
