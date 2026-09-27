// Headless handling tests for the vehicle model.
//   npx tsx scripts/physics-test.ts [car]
import { Autopilot } from "../game/ai/Autopilot";
import { CARS, carById } from "../game/physics/carSpecs";
import { Surface } from "../game/physics/surfaces";
import { DEFAULT_ASSISTS, DriverControls, PHYSICS_DT, Vehicle } from "../game/physics/Vehicle";
import { computeRacingLine } from "../game/track/racingLine";
import { World } from "../game/world/World";

const onlyCar = process.argv[2];

// A flat, endless asphalt plane for isolated handling tests.
const flatTrack = {
  length: 1e6,
  project: () => ({ s: 0, d: 0, i: 0, dist: 0 }),
  frameAt: (_s: number, out: Record<string, number> = {}) => Object.assign(out, { x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, heading: 0, bank: 0, grade: 0, halfWidth: 1e6, curvature: 0 }),
  railAt: () => null,
};
function flatWorld(surface = Surface.Asphalt) {
  return {
    track: flatTrack,
    ground(_x: number, _z: number, _h: number, out: Record<string, unknown>) {
      return Object.assign(out, { y: 0, nx: 0, ny: 1, nz: 0, surface, s: 0, d: 0, onRoad: true, hint: 0 });
    },
    collidersNear: (_x: number, _z: number, _r: number, out: unknown[]) => ((out.length = 0), out),
    extent: { x0: -1e9, x1: 1e9, z0: -1e9, z1: 1e9 },
  } as unknown as World;
}

const ctl = (o: Partial<DriverControls> = {}): DriverControls => ({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false, digitalSteer: false, digitalPedals: false, ...o });

function makeCar(id: string, world = flatWorld(), assists = {}) {
  const v = new Vehicle(carById(id), world);
  v.assists = { ...DEFAULT_ASSISTS, ...assists };
  v.reset(0, 0, 0, 0);
  // settle
  for (let i = 0; i < 240; i++) v.step(ctl({ brake: 1 }));
  return v;
}

function accelTest(id: string, tc: "off" | "full") {
  const v = makeCar(id, flatWorld(), { tc, esc: tc === "off" ? "off" : "full" });
  let t = 0;
  let t100 = NaN;
  let t160 = NaN;
  let q = NaN;
  while (t < 40) {
    v.step(ctl({ throttle: 1 }));
    t += PHYSICS_DT;
    const kmh = v.telemetry.kmh;
    if (isNaN(t100) && kmh >= 100) t100 = t;
    if (isNaN(t160) && kmh >= 160) t160 = t;
    if (isNaN(q) && v.pos.z >= 402) q = t;
  }
  return { t100, t160, quarter: q, vmax40s: v.telemetry.kmh };
}

function brakeTest(id: string, kmh: number, abs: boolean) {
  const v = makeCar(id, flatWorld(), { abs });
  v.reset(0, 0, 0, kmh / 3.6);
  const z0 = v.pos.z;
  let t = 0;
  while (v.telemetry.speed > 0.3 && t < 20) {
    v.step(ctl({ brake: 1 }));
    t += PHYSICS_DT;
  }
  return { dist: v.pos.z - z0, time: t, drift: Math.abs(v.pos.x) };
}

/** Constant-radius circle: raise the target speed until the car can no longer hold the line. */
function skidpad(id: string, R = 40) {
  let best = 0;
  for (let kmh = 40; kmh <= 110; kmh += 2) {
    const v = makeCar(id, flatWorld(), { esc: "off", tc: "off", steerSpeedSensitivity: 0 });
    v.reset(-R, 0, 0, kmh / 3.6); // circle centred at origin; centre is to the car's left
    let ok = true;
    let steer = 0;
    for (let t = 0; t < 8; t += PHYSICS_DT) {
      const r = Math.hypot(v.pos.x, v.pos.z);
      // Pure pursuit towards a point 10 m ahead on the circle (anticlockwise seen from above).
      const ang = Math.atan2(v.pos.z, v.pos.x) - 10 / R;
      const tx = Math.cos(ang) * R - v.pos.x;
      const tz = Math.sin(ang) * R - v.pos.z;
      const fl = Math.hypot(v.fwd.x, v.fwd.z);
      const fwdD = (tx * v.fwd.x + tz * v.fwd.z) / fl;
      const latD = (tx * v.fwd.z - tz * v.fwd.x) / fl;
      const alpha = Math.atan2(latD, fwdD);
      const delta = Math.atan((2 * v.spec.wheelbase * Math.sin(alpha)) / Math.hypot(tx, tz));
      steer += (Math.max(-1, Math.min(1, -delta / v.spec.steerLock)) - steer) * 0.1;
      const err = kmh / 3.6 - v.telemetry.speed;
      v.step(ctl({ steer, throttle: Math.max(0, Math.min(1, 0.3 + err * 0.5)), brake: 0 }));
      if (t > 3 && Math.abs(r - R) > 4) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    best = kmh;
  }
  const v = best / 3.6;
  return { maxKmh: best, latG: (v * v) / R / 9.81 };
}

/** Power-over drift: can a controlled driver hold a slide; does a greedy one spin? */
function driftTest(id: string, controlled: boolean) {
  const v = makeCar(id, flatWorld(), { esc: "off", tc: "off", abs: true, steerSpeedSensitivity: 0 });
  v.reset(0, 0, 0, 58 / 3.6);
  v.gear = 2;
  let t = 0;
  const log: number[] = [];
  let maxBeta = 0;
  let spun = false;
  let driftTime = 0;
  let integ = 0;
  let initiated = false;
  let prevBeta = 0;
  while (t < 8) {
    const beta = v.telemetry.sideslip; // + = sliding left (car turning right oversteers to the left)
    let c: DriverControls;
    const betaRate = (beta - prevBeta) / PHYSICS_DT;
    prevBeta = beta;
    if (!initiated && Math.abs(beta) > 0.12) initiated = true;
    if (!initiated || !controlled) c = ctl({ steer: 0.75, throttle: 1 });
    else {
      // Countersteer towards the direction of travel and meter the throttle to hold ~28 degrees.
      const target = 0.48;
      const e = Math.abs(beta) - target;
      integ = Math.max(-0.4, Math.min(0.4, integ + e * PHYSICS_DT * 1.5));
      const thr = Math.max(0, Math.min(1, 0.62 - e * 2.2 - integ - Math.sign(beta) * betaRate * 0.35));
      // Front axle travel direction relative to the car: point the wheels a little inside it.
      const fp = v.pos.clone().addScaledVector(v.fwd, v.a);
      const fv = v.pointVelocity(fp, fp.clone());
      const frontSlide = Math.atan2(fv.dot(v.left), Math.abs(fv.dot(v.fwd)));
      const wheelAngle = frontSlide - Math.sign(frontSlide) * 0.06; // + = left
      const steer = Math.max(-1, Math.min(1, -wheelAngle / v.spec.steerLock));
      c = ctl({ steer, throttle: thr });
    }
    v.step(c);
    t += PHYSICS_DT;
    maxBeta = Math.max(maxBeta, Math.abs(beta));
    if (Math.abs(beta) > 1.45) spun = true;
    if (t > 1 && Math.abs(beta) > 0.3 && v.telemetry.speed > 6) driftTime += PHYSICS_DT;
    if (Math.round(t * 240) % 120 === 0) log.push(+((beta * 180) / Math.PI).toFixed(0));
  }
  return { spun, maxBetaDeg: +((maxBeta * 180) / Math.PI).toFixed(1), driftTime: +driftTime.toFixed(2), endKmh: +v.telemetry.kmh.toFixed(0), betaTrace: log.join(",") };
}

/** Runs the same timed input schedule at several frame rates through a fixed-step accumulator. */
function frameRateTest(id: string) {
  const results: string[] = [];
  const schedule = (t: number) => ctl({ throttle: t < 4 ? 1 : 0.4, steer: t > 2 && t < 5 ? 0.5 : t >= 6 ? -0.4 : 0, brake: t >= 5 && t < 6 ? 0.7 : 0 });
  let ref: number[] | null = null;
  for (const fps of [30, 60, 144, 0]) {
    const v = makeCar(id);
    v.reset(0, 0, 0, 10);
    let acc = 0;
    let simT = 0;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let steps = 0;
    const total = 8 * 240;
    while (steps < total) {
      const frame = fps ? 1 / fps : 1 / 200 + rand() * (1 / 20 - 1 / 200);
      acc += frame;
      while (acc >= PHYSICS_DT && steps < total) {
        steps++;
        v.step(schedule(simT));
        acc -= PHYSICS_DT;
        simT += PHYSICS_DT;
      }
    }
    const pos = [v.pos.x, v.pos.z, v.telemetry.speed];
    if (!ref) ref = pos;
    const dev = Math.hypot(pos[0] - ref[0], pos[1] - ref[1]);
    results.push(`${fps || "variable"}fps: pos (${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}) v=${pos[2].toFixed(2)} dev=${dev.toFixed(3)}m`);
  }
  return results;
}

function lapTest(id: string, pace: number, world: World) {
  const spec = carById(id);
  const line = computeRacingLine(world.track, spec);
  const v = new Vehicle(spec, world);
  v.assists = { ...DEFAULT_ASSISTS, esc: "sport", tc: "sport", steerSpeedSensitivity: 0 };
  const track = world.track;
  const s0 = track.length - 150;
  const f = track.frameAt(s0);
  v.reset(f.x, f.z, f.heading, 0);
  const ap = new Autopilot(v, line, pace);
  let t = 0;
  let started = false;
  let lapStart = 0;
  let lastS = s0;
  let offTrack = 0;
  let impacts = 0;
  let lapTime = NaN;
  let maxSpeed = 0;
  const offWhere = new Set<string>();
  const cornerMin: Record<string, number> = {};
  while (t < 400) {
    v.step(ap.update(PHYSICS_DT));
    t += PHYSICS_DT;
    const s = v.telemetry.s;
    if (lastS > track.length - 50 && s < 50) {
      if (!started) {
        started = true;
        lapStart = t;
      } else {
        lapTime = t - lapStart;
        break;
      }
    }
    lastS = s;
    if (started && v.telemetry.wheelsOnRoad === 0 && v.telemetry.wheelsOnGround > 0) {
      offTrack += PHYSICS_DT;
      const c = track.cornerAt(s, 60);
      offWhere.add(c ? c.short : 's' + Math.round(s));
    }
    if (started) {
      const c = track.cornerAt(s, 0);
      if (c) cornerMin[c.short] = Math.min(cornerMin[c.short] ?? 999, v.telemetry.kmh);
    }
    impacts += v.impacts.length;
    v.impacts.length = 0;
    maxSpeed = Math.max(maxSpeed, v.telemetry.kmh);
    if (!isFinite(v.pos.x)) throw new Error("NaN in simulation");
  }
  const ref: Record<string, number> = {};
  for (const c of track.corners) {
    let m = 999;
    for (let i = 0; i < line.count; i++) if (track.inRange(line.s[i], { s0: c.sStart, s1: c.sEnd })) m = Math.min(m, line.speed[i] * 3.6);
    ref[c.short] = Math.round(m);
  }
  const corners = Object.entries(cornerMin)
    .map(([k, val]) => `${k}:${val.toFixed(0)}/${ref[k]}`)
    .join(" ");
  return { lapTime: +lapTime.toFixed(2), predicted: +line.lapTime.toFixed(2), offTrackSeconds: +offTrack.toFixed(2), offAt: [...offWhere].join(','), impacts, maxKmh: +maxSpeed.toFixed(0), corners };
}

/** A keyboard-style driver: the autopilot's intent, quantised to on/off keys. */
function keyboardLap(id: string, world: World, pace = 0.9) {
  const spec = carById(id);
  const line = computeRacingLine(world.track, spec);
  const v = new Vehicle(spec, world);
  v.assists = { ...DEFAULT_ASSISTS }; // beginner aids, speed-sensitive steering 0.8
  const track = world.track;
  const s0 = track.corners[track.corners.length - 1].sEnd + 12;
  const f = track.frameAt(s0);
  v.reset(f.x, f.z, f.heading, 0);
  const ap = new Autopilot(v, line, pace);
  let t = 0;
  let started = false;
  let lapStart = 0;
  let lastS = s0;
  let offTrack = 0;
  let lap = NaN;
  let held = 0;
  while (t < 400) {
    const want = ap.update(PHYSICS_DT);
    // A player watches the car and presses towards the steering they want, releasing when close.
    // Keys are only ever fully on or off; the game's key smoothing does the rest.
    const target = want.steer;
    const err = target - v.telemetry.steer;
    held = Math.abs(err) > 0.07 ? Math.sign(err) : Math.abs(target) > 0.5 ? Math.sign(target) : 0;
    const c: DriverControls = {
      steer: held,
      throttle: want.brake > 0.1 || want.throttle < 0.2 ? 0 : 1,
      brake: want.brake > 0.15 ? 1 : 0,
      handbrake: 0,
      shiftUp: false,
      shiftDown: false,
      digitalSteer: true,
      digitalPedals: true,
    };
    v.step(c);
    t += PHYSICS_DT;
    const s = v.telemetry.s;
    if (lastS > track.length - 50 && s < 50) {
      if (!started) {
        started = true;
        lapStart = t;
      } else {
        lap = t - lapStart;
        break;
      }
    }
    lastS = s;
    if (started && v.telemetry.wheelsOnRoad === 0 && v.telemetry.wheelsOnGround > 0) offTrack += PHYSICS_DT;
  }
  return { lapTime: +lap.toFixed(2), offTrackSeconds: +offTrack.toFixed(2) };
}

const cars = onlyCar ? [onlyCar] : CARS.map((c) => c.id);
if (process.env.KEYBOARD) {
  const world = new World().generateSync();
  for (const id of cars) console.log(`keyboard lap ${id}`, keyboardLap(id, world, 0.88));
  process.exit(0);
}
for (const id of cars) {
  console.log(`\n=== ${carById(id).name}`);
  console.log("accel TC full", accelTest(id, "full"));
  console.log("accel TC off ", accelTest(id, "off"));
  console.log("brake 100 ABS", brakeTest(id, 100, true), " no ABS", brakeTest(id, 100, false));
  console.log("brake 150 ABS", brakeTest(id, 150, true));
  console.log("skidpad R40  ", skidpad(id));
  console.log("drift controlled", driftTest(id, true));
  console.log("drift greedy    ", driftTest(id, false));
}
console.log("\nframe-rate consistency:", frameRateTest(cars[0]));
const world = new World().generateSync();
for (const id of cars) console.log(`lap ${id}`, lapTest(id, 0.95, world));
