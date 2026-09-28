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

/** What makes each car itself: its model, looks and engine sound. */
interface CarLook {
  id: string;
  name: string;
  model: string;
  classId: string;
  className: string;
  blurb: string;
  paint: string;
  paints: string[];
  cylinders: number;
  /** Engine description; the engine sound reads "Turbo" and "Flat" from it. */
  engine: string;
  // Model dimensions (from public/assets/cars/cars.json) so the physics wheels sit exactly where
  // the visual wheels are.
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
}

const MASS = 1450;
const FRONT_WEIGHT = 0.46;
/** The wheel size the gearing and brakes are tuned for; other wheel sizes are compensated. */
const REF_WHEEL = 0.39;

/**
 * Every car shares one balanced chassis and powertrain, so all of them have the same speed,
 * grip and handling: rear-biased all-wheel drive for easy, confident control, and grippy,
 * forgiving tyres that build and let go gradually. Gearing and brakes are scaled to each
 * model's wheel size so road speed per rpm and stopping power come out identical.
 */
function balanced(look: CarLook): CarSpec {
  const wheel = look.wheelRadius / REF_WHEEL;
  return {
    id: look.id,
    name: look.name,
    model: look.model,
    modelScale: 1,
    classId: look.classId,
    className: look.className,
    blurb: look.blurb,
    paint: look.paint,
    paints: look.paints,
    drivetrain: "AWD",
    cylinders: look.cylinders,
    mass: MASS,
    inertia: inertiaFor(MASS, 4.4, 1.9, 1.15),
    wheelbase: look.wheelbase,
    frontWeight: FRONT_WEIGHT,
    trackFront: look.trackFront,
    trackRear: look.trackRear,
    cgHeight: 0.45,
    wheelRadius: look.wheelRadius,
    wheelInertia: 1.3,
    suspension: suspensionFor(MASS, FRONT_WEIGHT, 1.95, 2.05, { rest: 0.27, travel: 0.14, arbF: 30000, arbR: 19000, rcF: 0.05, rcR: 0.08 }),
    tyre: { mu: 1.14, peakSlip: 0.09, peakAngle: 0.125, slide: 0.86, loadSensitivity: 0.1 },
    steerLock: 0.6,
    ackermann: 0.45,
    engine: {
      idle: 900,
      redline: 7800,
      limiter: 7900,
      torque: [
        [0, 260],
        [1500, 380],
        [3000, 480],
        [4500, 540],
        [5500, 560],
        [6500, 545],
        [7400, 510],
        [8000, 470],
      ],
      inertia: 0.2,
      frictionBase: 16,
      frictionPerRpm: 0.0068,
      launchRpm: 3200,
    },
    gears: [3.2, 2.2, 1.65, 1.3, 1.07, 0.88],
    reverse: 3.0,
    finalDrive: 3.6 * wheel,
    shiftTime: 0.08,
    efficiency: 0.9,
    diff: { frontPreload: 30, frontPower: 0.2, frontCoast: 0.1, rearPreload: 80, rearPower: 0.4, rearCoast: 0.25, frontShare: 0.3, centreLock: 0.35 },
    brakes: { front: 2700 * wheel, rear: 1700 * wheel, handbrake: 2800 * wheel },
    aero: { cdA: 0.7, clA: 0.8, frontShare: 0.44 },
    stats: { power: "430 hp", weight: "1,450 kg", layout: `${look.engine} · AWD` },
  };
}

export const CARS: CarSpec[] = [
  {
    id: "meridian",
    name: "Meridian GT",
    model: "c038",
    classId: "gt",
    className: "Grand Tourer",
    blurb: "A slender, long-nosed GT with a silky straight-six.",
    paint: "#b9bcc0",
    paints: ["#b9bcc0", "#1d2a3a", "#6e1b1b", "#2c3f33", "#e5e3dc", "#141517"],
    cylinders: 6,
    engine: "Straight-six",
    wheelbase: 2.655,
    trackFront: 1.348,
    trackRear: 1.348,
    wheelRadius: 0.392,
  },
  {
    id: "vela",
    name: "Vela Coupé",
    model: "khronos",
    classId: "fwd",
    className: "Sport Coupé",
    blurb: "A compact coupé with a raspy turbo four that whistles as it spools up.",
    paint: "#8c1d1d",
    paints: ["#8c1d1d", "#d9dbdc", "#6f93b8", "#2b2e33", "#d88a2b"],
    cylinders: 4,
    engine: "Turbo 2.0",
    wheelbase: 2.799,
    trackFront: 1.952,
    trackRear: 1.964,
    wheelRadius: 0.383,
  },
  {
    id: "brute",
    name: "Brute V8",
    model: "c037",
    classId: "muscle",
    className: "Muscle Car",
    blurb: "A long bonnet and a lumpy, thundering V8 that pops and crackles on the overrun.",
    paint: "#15171a",
    paints: ["#15171a", "#7b1515", "#1f3350", "#c9a227", "#d8d6cf"],
    cylinders: 8,
    engine: "V8",
    wheelbase: 2.691,
    trackFront: 1.58,
    trackRear: 1.58,
    wheelRadius: 0.335,
  },
  {
    id: "strale",
    name: "Strale S",
    model: "c025",
    classId: "super",
    className: "Supercar",
    blurb: "A mid-engined wedge with a screaming V10 right behind your shoulders.",
    paint: "#c8ccd0",
    paints: ["#c8ccd0", "#d4a017", "#2f7d3b", "#b01e1e", "#1a1c20", "#e37b22"],
    cylinders: 10,
    engine: "Mid-engine V10",
    wheelbase: 2.51,
    trackFront: 1.801,
    trackRear: 1.777,
    wheelRadius: 0.364,
  },
  {
    id: "nocturne",
    name: "Nocturne RS",
    model: "c040",
    classId: "track",
    className: "Track Special",
    blurb: "Stripped, low and winged, with a metallic flat-six and a whining straight-cut gearbox.",
    paint: "#15171a",
    paints: ["#15171a", "#e5e4df", "#0f4c81", "#9c1a1a", "#4a5b2e"],
    cylinders: 6,
    engine: "Flat-six",
    wheelbase: 2.416,
    trackFront: 1.518,
    trackRear: 1.518,
    wheelRadius: 0.411,
  },
  {
    id: "volterra",
    name: "Volterra V12",
    model: "c039",
    classId: "hyper",
    className: "Hypercar",
    blurb: "A V12 hypercar: smooth, high-pitched and always building.",
    paint: "#a31414",
    paints: ["#a31414", "#e8c21a", "#e8e6e1", "#1c1d20", "#1f4e8c", "#3c7a3b"],
    cylinders: 12,
    engine: "Mid-engine V12",
    wheelbase: 2.51,
    trackFront: 1.653,
    trackRear: 1.5,
    wheelRadius: 0.424,
  },
].map(balanced);

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
