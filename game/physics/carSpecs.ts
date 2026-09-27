export type Drivetrain = "RWD" | "FWD" | "AWD";

export interface CarSpec {
  id: string;
  name: string;
  model: string; // asset key in /assets/cars
  modelScale: number;
  classId: string;
  className: string;
  blurb: string;
  paint: string; // default paint colour
  paints: string[];
  drivetrain: Drivetrain;
  cylinders: number; // for the engine sound

  mass: number;
  /** Inertia about pitch (x), yaw (y) and roll (z) axes, kg·m². */
  inertia: [number, number, number];
  wheelbase: number;
  frontWeight: number; // static fraction on the front axle
  trackFront: number;
  trackRear: number;
  cgHeight: number;

  wheelRadius: number;
  wheelInertia: number;

  suspension: {
    restLength: number; // spring length at full droop (mount to wheel centre)
    travel: number; // compression before the bump stop
    springF: number;
    springR: number;
    bumpF: number;
    bumpR: number;
    reboundF: number;
    reboundR: number;
    arbF: number;
    arbR: number;
    rollCentreF: number;
    rollCentreR: number;
  };

  tyre: {
    mu: number;
    peakSlip: number; // slip ratio at peak longitudinal force
    peakAngle: number; // slip angle (rad) at peak lateral force
    slide: number; // fraction of peak left when sliding on asphalt
    loadSensitivity: number;
    /** Extra grip on loose surfaces (all-terrain tyres). */
    looseBonus?: number;
  };

  steerLock: number; // rad at the road wheels
  ackermann: number;

  engine: {
    idle: number;
    redline: number;
    limiter: number;
    torque: [number, number][]; // rpm, Nm at full throttle
    inertia: number;
    frictionBase: number; // engine braking torque, Nm
    frictionPerRpm: number;
    launchRpm: number;
  };

  gears: number[];
  reverse: number;
  finalDrive: number;
  shiftTime: number;
  efficiency: number;

  diff: {
    frontPreload: number;
    frontPower: number;
    frontCoast: number;
    rearPreload: number;
    rearPower: number;
    rearCoast: number;
    frontShare: number; // AWD torque split to the front
    centreLock: number;
  };

  brakes: {
    front: number; // Nm per wheel at full pedal
    rear: number;
    handbrake: number;
  };

  aero: {
    cdA: number;
    clA: number;
    frontShare: number;
  };

  /** Rough performance figures for the garage screen. */
  stats: { power: string; weight: string; layout: string };
}

/** Rigid-body inertia of a car-shaped mass (a box with mass concentrated towards the middle). */
function inertiaFor(mass: number, length: number, width: number, height: number): [number, number, number] {
  const k = 0.82;
  return [(mass * (length * length + height * height) * k) / 12, (mass * (length * length + width * width) * k) / 12, (mass * (width * width + height * height) * k) / 12];
}

/** Springs and dampers from a target ride frequency (Hz) and damping ratios. */
function suspensionFor(mass: number, frontWeight: number, freqF: number, freqR: number, opts: { rest?: number; travel?: number; arbF: number; arbR: number; rcF?: number; rcR?: number }) {
  const mf = (mass * frontWeight) / 2;
  const mr = (mass * (1 - frontWeight)) / 2;
  const kf = mf * (2 * Math.PI * freqF) ** 2;
  const kr = mr * (2 * Math.PI * freqR) ** 2;
  const c = (k: number, m: number, z: number) => 2 * z * Math.sqrt(k * m);
  return {
    restLength: opts.rest ?? 0.28,
    travel: opts.travel ?? 0.15,
    springF: Math.round(kf),
    springR: Math.round(kr),
    bumpF: Math.round(c(kf, mf, 0.28)),
    bumpR: Math.round(c(kr, mr, 0.28)),
    reboundF: Math.round(c(kf, mf, 0.42)),
    reboundR: Math.round(c(kr, mr, 0.42)),
    arbF: opts.arbF,
    arbR: opts.arbR,
    rollCentreF: opts.rcF ?? 0.06,
    rollCentreR: opts.rcR ?? 0.1,
  };
}

// Model dimensions (wheelbase, tracks, tyre radius) come from public/assets/cars/cars.json so the
// physics wheels sit exactly where the visual wheels are.
export const CARS: CarSpec[] = [
  {
    id: "meridian",
    name: "Meridian GT",
    model: "c038",
    modelScale: 1,
    classId: "gt",
    className: "Grand Tourer RWD",
    blurb: "A slender, long-nosed GT. Stable and forgiving, with enough torque to rotate on the throttle when you ask it to.",
    paint: "#b9bcc0",
    paints: ["#b9bcc0", "#1d2a3a", "#6e1b1b", "#2c3f33", "#e5e3dc", "#141517"],
    drivetrain: "RWD",
    cylinders: 6,
    mass: 1480,
    inertia: inertiaFor(1480, 4.48, 1.7, 1.2),
    wheelbase: 2.655,
    frontWeight: 0.52,
    trackFront: 1.348,
    trackRear: 1.348,
    cgHeight: 0.46,
    wheelRadius: 0.392,
    wheelInertia: 1.3,
    suspension: suspensionFor(1480, 0.52, 1.75, 1.85, { arbF: 26000, arbR: 15000 }),
    tyre: { mu: 1.06, peakSlip: 0.09, peakAngle: 0.12, slide: 0.8, loadSensitivity: 0.12 },
    steerLock: 0.62,
    ackermann: 0.5,
    engine: {
      idle: 800,
      redline: 7000,
      limiter: 7100,
      torque: [
        [0, 180],
        [1000, 260],
        [2000, 330],
        [3000, 380],
        [4000, 410],
        [5000, 405],
        [6000, 375],
        [6800, 340],
        [7300, 300],
      ],
      inertia: 0.2,
      frictionBase: 15,
      frictionPerRpm: 0.0062,
      launchRpm: 2500,
    },
    gears: [3.4, 2.2, 1.6, 1.26, 1.0, 0.82],
    reverse: 3.3,
    finalDrive: 3.46,
    shiftTime: 0.12,
    efficiency: 0.9,
    diff: { frontPreload: 0, frontPower: 0, frontCoast: 0, rearPreload: 60, rearPower: 0.45, rearCoast: 0.25, frontShare: 0, centreLock: 0 },
    brakes: { front: 2100, rear: 1150, handbrake: 2600 },
    aero: { cdA: 0.68, clA: 0.3, frontShare: 0.45 },
    stats: { power: "330 hp", weight: "1,480 kg", layout: "Front straight-six · RWD · LSD" },
  },
  {
    id: "vela",
    name: "Vela Coupé",
    model: "khronos",
    modelScale: 1,
    classId: "fwd",
    className: "Sport Coupé FWD",
    blurb: "Front-driven and light on its feet. Pulls itself out of corners; lift mid-corner and the tail helps it turn.",
    paint: "#8c1d1d",
    paints: ["#8c1d1d", "#d9dbdc", "#6f93b8", "#2b2e33", "#d88a2b"],
    drivetrain: "FWD",
    cylinders: 4,
    mass: 1420,
    inertia: inertiaFor(1420, 4.36, 2.0, 1.14),
    wheelbase: 2.799,
    frontWeight: 0.6,
    trackFront: 1.952,
    trackRear: 1.964,
    cgHeight: 0.5,
    wheelRadius: 0.383,
    wheelInertia: 1.3,
    suspension: suspensionFor(1420, 0.6, 1.8, 2.0, { arbF: 18000, arbR: 24000 }),
    tyre: { mu: 1.03, peakSlip: 0.09, peakAngle: 0.12, slide: 0.82, loadSensitivity: 0.12 },
    steerLock: 0.6,
    ackermann: 0.6,
    engine: {
      idle: 800,
      redline: 6700,
      limiter: 6800,
      torque: [
        [0, 150],
        [1500, 260],
        [2000, 340],
        [3000, 360],
        [4500, 360],
        [5500, 335],
        [6200, 300],
        [6900, 250],
      ],
      inertia: 0.16,
      frictionBase: 12,
      frictionPerRpm: 0.006,
      launchRpm: 2800,
    },
    gears: [3.45, 2.05, 1.4, 1.1, 0.9, 0.76],
    reverse: 3.3,
    finalDrive: 4.4,
    shiftTime: 0.12,
    efficiency: 0.92,
    diff: { frontPreload: 30, frontPower: 0.2, frontCoast: 0.1, rearPreload: 0, rearPower: 0, rearCoast: 0, frontShare: 1, centreLock: 0 },
    brakes: { front: 2000, rear: 950, handbrake: 2300 },
    aero: { cdA: 0.66, clA: 0.15, frontShare: 0.5 },
    stats: { power: "265 hp", weight: "1,420 kg", layout: "Turbo 2.0 · FWD" },
  },
  {
    id: "brute",
    name: "Brute V8",
    model: "c037",
    modelScale: 1,
    classId: "muscle",
    className: "Muscle RWD",
    blurb: "A long bonnet and a big V8. Torque from anywhere in the rev range; it rewards patience with the throttle and punishes greed.",
    paint: "#15171a",
    paints: ["#15171a", "#7b1515", "#1f3350", "#c9a227", "#d8d6cf"],
    drivetrain: "RWD",
    cylinders: 8,
    mass: 1620,
    inertia: inertiaFor(1620, 4.7, 1.85, 1.05),
    wheelbase: 2.691,
    frontWeight: 0.54,
    trackFront: 1.58,
    trackRear: 1.58,
    cgHeight: 0.47,
    wheelRadius: 0.335,
    wheelInertia: 1.3,
    suspension: suspensionFor(1620, 0.54, 1.7, 1.8, { arbF: 30000, arbR: 15000 }),
    tyre: { mu: 1.03, peakSlip: 0.09, peakAngle: 0.12, slide: 0.78, loadSensitivity: 0.12 },
    steerLock: 0.6,
    ackermann: 0.5,
    engine: {
      idle: 750,
      redline: 6800,
      limiter: 6900,
      torque: [
        [0, 260],
        [1000, 360],
        [2000, 470],
        [3000, 540],
        [4000, 580],
        [4800, 585],
        [5600, 560],
        [6200, 520],
        [7000, 450],
      ],
      inertia: 0.28,
      frictionBase: 18,
      frictionPerRpm: 0.0075,
      launchRpm: 2200,
    },
    gears: [2.97, 2.07, 1.43, 1.0, 0.84, 0.66],
    reverse: 3.0,
    finalDrive: 3.4,
    shiftTime: 0.16,
    efficiency: 0.9,
    diff: { frontPreload: 0, frontPower: 0, frontCoast: 0, rearPreload: 100, rearPower: 0.5, rearCoast: 0.3, frontShare: 0, centreLock: 0 },
    brakes: { front: 2200, rear: 1250, handbrake: 2600 },
    aero: { cdA: 0.74, clA: 0.2, frontShare: 0.45 },
    stats: { power: "460 hp", weight: "1,620 kg", layout: "V8 · RWD · LSD" },
  },
  {
    id: "strale",
    name: "Strale S",
    model: "c025",
    modelScale: 1,
    classId: "super",
    className: "Supercar RWD",
    blurb: "A mid-engined wedge with a screaming V10 behind your shoulders. Sharp on turn-in, quick to rotate. Stay smooth on the exits.",
    paint: "#c8ccd0",
    paints: ["#c8ccd0", "#d4a017", "#2f7d3b", "#b01e1e", "#1a1c20", "#e37b22"],
    drivetrain: "RWD",
    cylinders: 10,
    mass: 1440,
    inertia: inertiaFor(1440, 4.0, 2.0, 1.05),
    wheelbase: 2.51,
    frontWeight: 0.42,
    trackFront: 1.801,
    trackRear: 1.777,
    cgHeight: 0.42,
    wheelRadius: 0.364,
    wheelInertia: 1.2,
    suspension: suspensionFor(1440, 0.42, 2.1, 2.25, { rest: 0.26, travel: 0.13, arbF: 30000, arbR: 22000, rcF: 0.05, rcR: 0.08 }),
    tyre: { mu: 1.12, peakSlip: 0.085, peakAngle: 0.115, slide: 0.79, loadSensitivity: 0.11 },
    steerLock: 0.6,
    ackermann: 0.45,
    engine: {
      idle: 1000,
      redline: 8400,
      limiter: 8500,
      torque: [
        [0, 250],
        [1500, 360],
        [3000, 450],
        [4500, 520],
        [6000, 560],
        [7000, 555],
        [8000, 520],
        [8600, 470],
      ],
      inertia: 0.18,
      frictionBase: 16,
      frictionPerRpm: 0.0065,
      launchRpm: 3200,
    },
    gears: [3.2, 2.2, 1.65, 1.3, 1.07, 0.9, 0.76],
    reverse: 3.0,
    finalDrive: 3.6,
    shiftTime: 0.08,
    efficiency: 0.9,
    diff: { frontPreload: 0, frontPower: 0, frontCoast: 0, rearPreload: 80, rearPower: 0.4, rearCoast: 0.25, frontShare: 0, centreLock: 0 },
    brakes: { front: 2600, rear: 1700, handbrake: 2800 },
    aero: { cdA: 0.62, clA: 0.75, frontShare: 0.42 },
    stats: { power: "590 hp", weight: "1,440 kg", layout: "Mid-engine V10 · RWD" },
  },
  {
    id: "nocturne",
    name: "Nocturne RS",
    model: "c040",
    modelScale: 1,
    classId: "track",
    className: "Track Special RWD",
    blurb: "Stripped, stiff and pinned to the road by its rear wing. The faster you go, the more it grips. Brakes like a wall.",
    paint: "#15171a",
    paints: ["#15171a", "#e5e4df", "#0f4c81", "#9c1a1a", "#4a5b2e"],
    drivetrain: "RWD",
    cylinders: 6,
    mass: 1360,
    inertia: inertiaFor(1360, 3.95, 1.85, 1.2),
    wheelbase: 2.416,
    frontWeight: 0.44,
    trackFront: 1.518,
    trackRear: 1.518,
    cgHeight: 0.43,
    wheelRadius: 0.411,
    wheelInertia: 1.25,
    suspension: suspensionFor(1360, 0.44, 2.3, 2.45, { rest: 0.24, travel: 0.12, arbF: 34000, arbR: 22000, rcF: 0.05, rcR: 0.08 }),
    tyre: { mu: 1.15, peakSlip: 0.085, peakAngle: 0.11, slide: 0.78, loadSensitivity: 0.1 },
    steerLock: 0.6,
    ackermann: 0.4,
    engine: {
      idle: 1000,
      redline: 8800,
      limiter: 8900,
      torque: [
        [0, 220],
        [2000, 330],
        [3500, 420],
        [5000, 470],
        [6500, 480],
        [7800, 460],
        [8800, 420],
        [9200, 380],
      ],
      inertia: 0.16,
      frictionBase: 14,
      frictionPerRpm: 0.006,
      launchRpm: 3500,
    },
    gears: [3.3, 2.3, 1.75, 1.4, 1.15, 0.97],
    reverse: 3.0,
    finalDrive: 3.9,
    shiftTime: 0.07,
    efficiency: 0.9,
    diff: { frontPreload: 0, frontPower: 0, frontCoast: 0, rearPreload: 90, rearPower: 0.45, rearCoast: 0.3, frontShare: 0, centreLock: 0 },
    brakes: { front: 2800, rear: 1800, handbrake: 2800 },
    aero: { cdA: 0.78, clA: 1.35, frontShare: 0.4 },
    stats: { power: "525 hp", weight: "1,360 kg", layout: "Flat-six · RWD · rear wing" },
  },
  {
    id: "volterra",
    name: "Volterra V12",
    model: "c039",
    modelScale: 1,
    classId: "hyper",
    className: "Hypercar AWD",
    blurb: "A V12 hypercar with drive to all four wheels. Brutal in a straight line, deceptively planted, and demanding of your braking points.",
    paint: "#a31414",
    paints: ["#a31414", "#e8c21a", "#e8e6e1", "#1c1d20", "#1f4e8c", "#3c7a3b"],
    drivetrain: "AWD",
    cylinders: 12,
    mass: 1560,
    inertia: inertiaFor(1560, 4.6, 2.0, 1.1),
    wheelbase: 2.51,
    frontWeight: 0.43,
    trackFront: 1.653,
    trackRear: 1.5,
    cgHeight: 0.43,
    wheelRadius: 0.424,
    wheelInertia: 1.35,
    suspension: suspensionFor(1560, 0.43, 2.1, 2.2, { rest: 0.26, travel: 0.13, arbF: 32000, arbR: 22000, rcF: 0.05, rcR: 0.08 }),
    tyre: { mu: 1.15, peakSlip: 0.085, peakAngle: 0.11, slide: 0.8, loadSensitivity: 0.1 },
    steerLock: 0.6,
    ackermann: 0.45,
    engine: {
      idle: 1000,
      redline: 8500,
      limiter: 8600,
      torque: [
        [0, 300],
        [1500, 450],
        [3000, 560],
        [4500, 640],
        [5500, 690],
        [6500, 690],
        [7500, 660],
        [8600, 600],
      ],
      inertia: 0.22,
      frictionBase: 20,
      frictionPerRpm: 0.0075,
      launchRpm: 3500,
    },
    gears: [3.1, 2.15, 1.65, 1.32, 1.1, 0.93, 0.78],
    reverse: 3.0,
    finalDrive: 3.5,
    shiftTime: 0.06,
    efficiency: 0.88,
    diff: { frontPreload: 30, frontPower: 0.2, frontCoast: 0.1, rearPreload: 90, rearPower: 0.45, rearCoast: 0.25, frontShare: 0.32, centreLock: 0.35 },
    brakes: { front: 3000, rear: 1900, handbrake: 3000 },
    aero: { cdA: 0.7, clA: 1.0, frontShare: 0.43 },
    stats: { power: "760 hp", weight: "1,560 kg", layout: "Mid-engine V12 · AWD" },
  },
];

export const carById = (id: string) => CARS.find((c) => c.id === id) ?? CARS[0];

/** Torque at full throttle for a given rpm (linear interpolation of the curve). */
export function torqueAt(spec: CarSpec, rpm: number) {
  const t = spec.engine.torque;
  if (rpm <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (rpm <= t[i][0]) {
      const [r0, n0] = t[i - 1];
      const [r1, n1] = t[i];
      return n0 + ((n1 - n0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return t[t.length - 1][1];
}
