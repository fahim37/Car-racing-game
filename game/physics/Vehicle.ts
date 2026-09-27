import { Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import type { Frame, Track } from "../track/Track";
import { clamp, lerp, sign, valueNoise } from "../util/math";
import { CircleCollider, GroundHit, World, WATER_Y } from "../world/World";
import { CarSpec, torqueAt } from "./carSpecs";
import { Surface, SurfaceProps, surfaceProps } from "./surfaces";
import { TyreOutput, loadedMu, tyreForce } from "./tire";
import { Nitro } from "./Nitro";

export const PHYSICS_HZ = 240;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
const G = 9.81;
const AIR_DENSITY = 1.225;

export interface DriverControls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  handbrake: number; // 0..1
  nitro?: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  /** On/off steering (keys, touch buttons) is rate-limited like a smooth pair of hands. */
  digitalSteer: boolean;
  /** On/off pedals (keys, touch buttons) ramp in quickly but not instantly, like a real foot. */
  digitalPedals: boolean;
}

export type AssistLevel = "off" | "sport" | "full";

export interface DrivingAssists {
  abs: boolean;
  tc: AssistLevel;
  esc: AssistLevel;
  autoGear: boolean;
  /** 0 = full steering lock at any speed, 1 = lock reduced with speed (recommended for keys). */
  steerSpeedSensitivity: number;
  /** Keyboard steering speed multiplier. */
  steerRate: number;
}

export const DEFAULT_ASSISTS: DrivingAssists = {
  abs: true,
  tc: "full",
  esc: "full",
  autoGear: true,
  steerSpeedSensitivity: 0.8,
  steerRate: 1,
};

export interface ImpactEvent {
  kind: "rail" | "tree" | "rock" | "ground" | "bounds";
  speed: number;
  x: number;
  y: number;
  z: number;
}

export interface Wheel {
  index: number;
  front: boolean;
  left: boolean;
  mount: Vector3; // local mount point
  radius: number;
  steer: number;
  omega: number;
  spin: number; // accumulated rotation angle for visuals
  compression: number;
  prevCompression: number;
  springLength: number; // mount to wheel centre
  contact: boolean;
  contactPoint: Vector3;
  normal: Vector3;
  surface: Surface;
  onRoad: boolean;
  load: number;
  slipRatio: number;
  slipAngle: number;
  combinedSlip: number;
  fx: number;
  fy: number;
  driveTorque: number;
  brakeTorque: number;
  /** Drivetrain inertia reflected onto this wheel while the clutch is engaged. */
  extraInertia: number;
  absFactor: number;
  hint: number;
  /** Visual/audio slide intensity 0..1. */
  skid: number;
  s: number;
  d: number;
}

export interface Telemetry {
  speed: number;
  forwardSpeed: number;
  kmh: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number; // smoothed input -1..1
  steerAngle: number; // road wheel angle
  handbrake: number;
  sideslip: number; // rad, + = sliding left
  yawRate: number;
  latG: number;
  longG: number;
  absActive: boolean;
  tcActive: boolean;
  escActive: boolean;
  limiter: boolean;
  wheelsOnRoad: number;
  wheelsOnGround: number;
  airborne: boolean;
  inWater: boolean;
  upright: number; // up.y
  shifting: boolean;
  s: number;
  d: number;
}

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpQ = new Quaternion();
const hit: GroundHit = { y: 0, nx: 0, ny: 1, nz: 0, surface: Surface.Grass, s: 0, d: 0, onRoad: false, hint: -1 };
const surf: SurfaceProps = surfaceProps(Surface.Asphalt, 0);
const tyreOut: TyreOutput = { fx: 0, fy: 0, slipRatio: 0, slipAngle: 0, combined: 0 };
const colliders: CircleCollider[] = [];

export class Vehicle {
  readonly spec: CarSpec;
  readonly world: World;
  readonly track: Track;
  assists: DrivingAssists = { ...DEFAULT_ASSISTS };
  wetness = 0;
  readonly nitro = new Nitro();

  // Rigid body
  readonly pos = new Vector3();
  readonly quat = new Quaternion();
  readonly vel = new Vector3();
  readonly angVel = new Vector3();
  private readonly rot = new Matrix3();
  private readonly invInertia: Vector3;
  private readonly inertia: Vector3;
  /** Body axes in world space: +x local is the car's left, +y up, +z forward. */
  readonly left = new Vector3();
  readonly up = new Vector3();
  readonly fwd = new Vector3();

  readonly wheels: Wheel[] = [];
  readonly a: number; // CG to front axle
  readonly b: number; // CG to rear axle
  readonly halfExtents = new Vector3(0.9, 0.62, 2.2);
  private readonly bottomY: number;

  // Drivetrain state
  rpm: number;
  gear = 1;
  private shiftTimer = 0;
  private shiftCooldown = 0;
  private reverseTimer = 0;
  private tcFactor = 1;
  private escThrottle = 1;
  private steerState = 0;
  private throttleState = 0;
  private brakeState = 0;
  private handbrakeState = 0;
  private refLoad: number;
  private airTime = 0;

  readonly telemetry: Telemetry;
  /** Road-wheel angle that full steering input currently maps to (speed-sensitive). */
  steerLockNow = 0.6;
  readonly impacts: ImpactEvent[] = [];
  /** Steps since the last collision with a barrier, tree or rock (for drift scoring). */
  stepsSinceContact = 1e9;
  private lastForceX = 0;
  private lastForceZ = 0;

  constructor(spec: CarSpec, world: World) {
    this.spec = spec;
    this.world = world;
    this.track = world.track;
    const L = spec.wheelbase;
    this.a = L * (1 - spec.frontWeight);
    this.b = L * spec.frontWeight;
    this.inertia = new Vector3(...spec.inertia);
    this.invInertia = new Vector3(1 / spec.inertia[0], 1 / spec.inertia[1], 1 / spec.inertia[2]);
    this.refLoad = (spec.mass * G) / 4;
    this.rpm = spec.engine.idle;
    this.bottomY = -(spec.cgHeight - 0.14);
    const sus = spec.suspension;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      const track = front ? spec.trackFront : spec.trackRear;
      const k = front ? sus.springF : sus.springR;
      const axleLoad = spec.mass * G * (front ? spec.frontWeight : 1 - spec.frontWeight);
      const staticComp = axleLoad / 2 / k;
      const mountY = spec.wheelRadius - spec.cgHeight + sus.restLength - staticComp;
      this.wheels.push({
        index: i,
        front,
        left,
        mount: new Vector3(left ? track / 2 : -track / 2, mountY, front ? this.a : -this.b),
        radius: spec.wheelRadius,
        steer: 0,
        omega: 0,
        spin: 0,
        compression: staticComp,
        prevCompression: staticComp,
        springLength: sus.restLength - staticComp,
        contact: false,
        contactPoint: new Vector3(),
        normal: new Vector3(0, 1, 0),
        surface: Surface.Asphalt,
        onRoad: true,
        load: 0,
        slipRatio: 0,
        slipAngle: 0,
        combinedSlip: 0,
        fx: 0,
        fy: 0,
        driveTorque: 0,
        brakeTorque: 0,
        extraInertia: 0,
        absFactor: 1,
        hint: -1,
        skid: 0,
        s: 0,
        d: 0,
      });
    }
    this.halfExtents.set(Math.max(spec.trackFront, spec.trackRear) / 2 + 0.12, 0.62, (this.a + this.b) / 2 + 0.85);
    this.telemetry = {
      speed: 0,
      forwardSpeed: 0,
      kmh: 0,
      rpm: this.rpm,
      gear: 1,
      throttle: 0,
      brake: 0,
      steer: 0,
      steerAngle: 0,
      handbrake: 0,
      sideslip: 0,
      yawRate: 0,
      latG: 0,
      longG: 0,
      absActive: false,
      tcActive: false,
      escActive: false,
      limiter: false,
      wheelsOnRoad: 4,
      wheelsOnGround: 4,
      airborne: false,
      inWater: false,
      upright: 1,
      shifting: false,
      s: 0,
      d: 0,
    };
  }

  get mass() {
    return this.spec.mass;
  }

  /** Places the car at rest (or rolling) on the ground at (x, z), facing `heading`. */
  reset(x: number, z: number, heading: number, speed = 0) {
    const g = this.world.ground(x, z, -1, hit);
    const n = tmpV.set(g.nx, g.ny, g.nz);
    const f = tmpV2.set(Math.sin(heading), 0, Math.cos(heading));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const l = tmpV3.crossVectors(n, f).normalize();
    const m = new Matrix3().set(l.x, n.x, f.x, l.y, n.y, f.y, l.z, n.z, f.z);
    this.quat.setFromRotationMatrix(matrix4From3(m));
    this.pos.set(x, g.y, z).addScaledVector(n, this.spec.cgHeight + 0.02);
    this.vel.copy(f).multiplyScalar(speed);
    this.angVel.set(0, 0, 0);
    for (const w of this.wheels) {
      w.omega = speed / w.radius;
      const k = w.front ? this.spec.suspension.springF : this.spec.suspension.springR;
      const axleLoad = this.spec.mass * G * (w.front ? this.spec.frontWeight : 1 - this.spec.frontWeight);
      w.compression = w.prevCompression = axleLoad / 2 / k;
      w.hint = g.hint;
      w.absFactor = 1;
      w.skid = 0;
    }
    this.gear = speed > 1 ? this.gearForSpeed(speed) : 1;
    this.rpm = Math.max(this.spec.engine.idle, this.wheelRpm());
    this.shiftTimer = 0;
    this.tcFactor = 1;
    this.escThrottle = 1;
    this.steerState = 0;
    this.throttleState = 0;
    this.brakeState = 0;
    this.airTime = 0;
    this.impacts.length = 0;
    this.stepsSinceContact = 1e9;
    this.updateBasis();
    this.updateTelemetry(0);
  }

  private gearForSpeed(v: number) {
    const s = this.spec;
    for (let g = 1; g <= s.gears.length; g++) {
      const rpm = ((v / s.wheelRadius) * s.gears[g - 1] * s.finalDrive * 60) / (2 * Math.PI);
      if (rpm < s.engine.redline * 0.75) return g;
    }
    return s.gears.length;
  }

  private updateBasis() {
    this.rot.setFromMatrix4(tmpMat4.makeRotationFromQuaternion(this.quat));
    const e = this.rot.elements;
    this.left.set(e[0], e[1], e[2]);
    this.up.set(e[3], e[4], e[5]);
    this.fwd.set(e[6], e[7], e[8]);
  }

  private toWorld(local: Vector3, out: Vector3) {
    return out.copy(local).applyMatrix3(this.rot).add(this.pos);
  }

  pointVelocity(worldPoint: Vector3, out: Vector3) {
    tmpVel.subVectors(worldPoint, this.pos);
    return out.crossVectors(this.angVel, tmpVel).add(this.vel);
  }

  private gearRatio(gear = this.gear) {
    const s = this.spec;
    if (gear === 0) return 0;
    if (gear < 0) return -s.reverse * s.finalDrive;
    return s.gears[gear - 1] * s.finalDrive;
  }

  /** Engine rpm implied by the driven wheels in the current gear. */
  private wheelRpm() {
    const ratio = Math.abs(this.gearRatio());
    return (Math.abs(this.drivenOmega()) * ratio * 60) / (2 * Math.PI);
  }

  private drivenOmega() {
    const w = this.wheels;
    switch (this.spec.drivetrain) {
      case "RWD":
        return (w[2].omega + w[3].omega) / 2;
      case "FWD":
        return (w[0].omega + w[1].omega) / 2;
      default: {
        const fs = this.spec.diff.frontShare;
        return ((w[0].omega + w[1].omega) / 2) * fs + ((w[2].omega + w[3].omega) / 2) * (1 - fs);
      }
    }
  }

  // ---------------------------------------------------------------- driver inputs

  private processInputs(c: DriverControls, dt: number, forwardSpeed: number) {
    const a = this.assists;
    // Pedals: on/off presses ramp in quickly but not instantly, like a real foot.
    if (c.digitalPedals) {
      this.throttleState = approachRate(this.throttleState, c.throttle, 7, 12, dt);
      this.brakeState = approachRate(this.brakeState, c.brake, 9, 14, dt);
      this.handbrakeState = approachRate(this.handbrakeState, c.handbrake, 14, 14, dt);
    } else {
      this.throttleState = c.throttle;
      this.brakeState = c.brake;
      this.handbrakeState = c.handbrake;
    }

    // Steering.
    if (c.digitalSteer) {
      const rate = a.steerRate;
      const target = c.steer;
      let r: number;
      if (Math.abs(target) < 0.01) r = 4.2 * rate;
      else if (sign(target) !== sign(this.steerState) && Math.abs(this.steerState) > 0.05) r = 6 * rate;
      else r = 2.4 * rate;
      this.steerState = approachRate(this.steerState, target, r, r, dt);
    } else {
      this.steerState += (c.steer - this.steerState) * Math.min(1, dt * 30);
    }

    // Gear selection.
    if (a.autoGear) {
      const wantsReverse = this.brakeState > 0.5 && this.throttleState < 0.1 && forwardSpeed < 0.6;
      const wantsForward = this.throttleState > 0.3 && forwardSpeed > -0.6;
      if (this.gear >= 1 && wantsReverse) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.35) {
          this.gear = -1;
          this.reverseTimer = 0;
        }
      } else if (this.gear === -1 && wantsForward && this.brakeState < 0.1) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.1) {
          this.gear = 1;
          this.reverseTimer = 0;
        }
      } else this.reverseTimer = 0;
      if (this.gear === 0) this.gear = 1;
    }
    if (c.shiftUp) {
      c.shiftUp = false;
      if (!a.autoGear || this.gear >= 1) this.requestShift(this.gear + 1);
      else if (this.gear === -1) this.gear = 1;
    }
    if (c.shiftDown) {
      c.shiftDown = false;
      if (!a.autoGear || this.gear > 1) this.requestShift(this.gear - 1);
    }
  }

  private requestShift(target: number) {
    const n = this.spec.gears.length;
    target = clamp(target, -1, n);
    if (target === this.gear) return;
    if (this.assists.autoGear && target < 1) return;
    // Protect the engine from a money-shift.
    if (target > 0 && target < this.gear) {
      const ratio = this.gearRatio(target);
      const rpm = (Math.abs(this.drivenOmega()) * ratio * 60) / (2 * Math.PI);
      if (rpm > this.spec.engine.limiter + 400) return;
    }
    this.gear = target;
    this.shiftTimer = target === 0 ? 0 : this.spec.shiftTime;
    this.shiftCooldown = 0.5;
  }

  private autoShift(dt: number, forwardSpeed: number) {
    this.shiftCooldown -= dt;
    if (!this.assists.autoGear || this.gear < 1 || this.shiftCooldown > 0 || this.telemetry.airborne) return;
    const s = this.spec;
    const groundRpm = ((Math.max(0, forwardSpeed) / s.wheelRadius) * this.gearRatio() * 60) / (2 * Math.PI);
    const thr = this.throttleState;
    const upRpm = lerp(3400, s.engine.redline - 150, clamp((thr - 0.2) / 0.7, 0, 1));
    if (this.gear < s.gears.length && this.rpm > upRpm && groundRpm > upRpm * 0.9) {
      this.requestShift(this.gear + 1);
      return;
    }
    if (this.gear > 1) {
      const lower = (groundRpm * this.gearRatio(this.gear - 1)) / this.gearRatio();
      const braking = this.brakeState > 0.2;
      const downRpm = braking ? s.engine.redline * 0.55 : lerp(1700, s.engine.redline * 0.62, clamp(thr, 0, 1));
      // Hysteresis: only drop a gear if the lower gear would not immediately want to upshift.
      const room = braking ? s.engine.redline - 700 : Math.min(s.engine.redline - 700, upRpm - 900);
      if (groundRpm < downRpm && lower < room) this.requestShift(this.gear - 1);
    }
  }

  // ---------------------------------------------------------------- simulation step

  step(c: DriverControls, dt = PHYSICS_DT) {
    const spec = this.spec;
    const sus = spec.suspension;
    this.updateBasis();
    const forwardSpeed = this.vel.dot(this.fwd);
    this.processInputs(c, dt, forwardSpeed);
    this.autoShift(dt, forwardSpeed);

    const reversing = this.gear === -1 && this.assists.autoGear;
    let throttle = reversing ? this.brakeState : this.throttleState;
    const brake = reversing ? this.throttleState : this.brakeState;
    const handbrake = this.handbrakeState;
    const boosting = this.nitro.step(dt, !!c.nitro, this.gear > 0 && throttle > 0.2 && brake < 0.1 && handbrake < 0.1 && this.telemetry.wheelsOnGround >= 2 && !this.telemetry.inWater && this.up.y > 0.5);

    // ---- steering geometry
    const speed = this.vel.length();
    const lockFull = spec.steerLock;
    // Speed-sensitive steering: at speed, full input maps to roughly the angle that uses all the
    // front grip (geometric angle for the tightest possible radius plus the tyre's peak slip angle).
    // Anything beyond that only scrubs speed, and it makes on/off keys far more manageable.
    const gripAngle = (spec.wheelbase * spec.tyre.mu * G) / Math.max(1, speed * speed) + spec.tyre.peakAngle * 1.35;
    const lockAtSpeed = Math.min(lockFull, gripAngle);
    let lock = lerp(lockFull, lockAtSpeed, this.assists.steerSpeedSensitivity);
    this.steerLockNow = lock;
    // Always allow the front wheels to point where the car is travelling (countersteer).
    const frontVel = this.pointVelocity(tmpV.copy(this.fwd).multiplyScalar(this.a).add(this.pos), tmpV2);
    const fvLong = frontVel.dot(this.fwd);
    const fvLat = frontVel.dot(this.left);
    const frontSlide = speed > 3 ? Math.atan2(fvLat, Math.abs(fvLong)) : 0;
    const steerDir = -this.steerState; // + = left
    if (sign(steerDir) === sign(frontSlide)) lock = Math.max(lock, Math.min(lockFull, Math.abs(frontSlide) + 0.1));
    const delta = steerDir * lock;
    this.applyAckermann(delta);

    // ---- assists that watch the whole car
    const latVel = this.vel.dot(this.left);
    const yawRate = this.angVel.dot(this.up);
    const sideslip = speed > 4 ? Math.atan2(latVel, Math.abs(forwardSpeed)) : 0;
    const escBrake = [0, 0, 0, 0];
    let escActive = false;
    this.escThrottle = Math.min(1, this.escThrottle + dt * 2.5);
    if (this.assists.esc !== "off" && speed > 6 && this.gear !== -1) {
      const full = this.assists.esc === "full";
      const L = spec.wheelbase;
      let targetYaw = (forwardSpeed * delta) / (L * (1 + 0.0022 * speed * speed));
      const maxYaw = (0.9 * spec.tyre.mu * G) / Math.max(speed, 1);
      targetYaw = clamp(targetYaw, -maxYaw, maxYaw);
      const err = yawRate - targetYaw;
      const betaLimit = full ? 0.1 : 0.26;
      const yawTol = full ? 0.12 : 0.3;
      // Oversteer: rotating faster than the driver asks, or the rear sliding out.
      const oversteer = (Math.abs(yawRate) > Math.abs(targetYaw) + yawTol && sign(err) === sign(yawRate)) || Math.abs(sideslip) > betaLimit;
      if (oversteer) {
        const amount = clamp(Math.max(Math.abs(err) - yawTol, Math.abs(sideslip) - betaLimit) * (full ? 5 : 3), 0, 1);
        // Brake the outside front wheel to pull the nose back in line.
        const rotDir = Math.abs(sideslip) > betaLimit ? -sign(sideslip) : sign(yawRate);
        const outerFront = rotDir > 0 ? 1 : 0; // yawing left -> right front is outside
        escBrake[outerFront] += amount * spec.brakes.front * 0.9;
        this.escThrottle = Math.min(this.escThrottle, 1 - amount * (full ? 0.9 : 0.6));
        escActive = amount > 0.05;
      } else if (full && Math.abs(targetYaw) > 0.05 && Math.abs(yawRate) < Math.abs(targetYaw) - 0.15 && sign(yawRate) === sign(targetYaw)) {
        // Understeer: trim the throttle and brake the inside rear gently.
        const amount = clamp((Math.abs(targetYaw) - Math.abs(yawRate) - 0.15) * 2, 0, 0.6);
        const innerRear = targetYaw > 0 ? 2 : 3;
        escBrake[innerRear] += amount * spec.brakes.rear * 0.5;
        this.escThrottle = Math.min(this.escThrottle, 1 - amount * 0.5);
        escActive = amount > 0.05;
      }
    }
    throttle *= this.escThrottle;

    // ---- engine and gearbox
    const eng = spec.engine;
    let engineTorque = 0;
    let clutchEngaged = false;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = this.gearRatio();
    const thrEff = throttle * this.tcFactor;
    if (this.gear === 0 || this.shiftTimer > 0) {
      const target = this.gear === 0 ? eng.idle + thrEff * (eng.redline - eng.idle) : this.wheelRpm();
      this.rpm += clamp(target - this.rpm, -9000 * dt, 12000 * dt);
    } else {
      const wr = this.wheelRpm();
      if (wr >= eng.idle * 0.95) {
        this.rpm = wr;
        clutchEngaged = true;
      } else if (thrEff > 0.02) {
        const target = eng.idle + (eng.launchRpm - eng.idle) * Math.min(1, thrEff * 1.2);
        this.rpm += clamp(target - this.rpm, -6000 * dt, 9000 * dt);
      } else {
        this.rpm += clamp(eng.idle - this.rpm, -4000 * dt, 4000 * dt);
      }
      const limiter = this.rpm >= eng.limiter;
      const friction = eng.frictionBase + eng.frictionPerRpm * this.rpm;
      if (limiter) engineTorque = -friction;
      else if (clutchEngaged) engineTorque = thrEff * torqueAt(spec, this.rpm) - (1 - thrEff) * friction;
      else if (thrEff > 0.02) engineTorque = thrEff * torqueAt(spec, this.rpm) * Math.min(1, 0.4 + thrEff);
      this.telemetry.limiter = limiter;
    }
    this.rpm = clamp(this.rpm, eng.idle * 0.9, eng.limiter + 200);
    const shaftTorque = engineTorque * ratio * (engineTorque >= 0 ? spec.efficiency * (boosting ? 1.7 : 1) : 1);
    const engineInertia = clutchEngaged ? eng.inertia * ratio * ratio : 0;

    // ---- distribute drive torque (differentials)
    this.distributeTorque(shaftTorque, engineInertia, dt);

    // ---- brakes
    let absActive = false;
    for (const w of this.wheels) {
      const pedal = brake * (w.front ? spec.brakes.front : spec.brakes.rear);
      let absF = 1;
      if (this.assists.abs && pedal > 0 && speed > 2.5) {
        if (w.slipRatio < -spec.tyre.peakSlip * 1.2) w.absFactor = Math.max(0.15, w.absFactor - dt * 22);
        else w.absFactor = Math.min(1, w.absFactor + dt * 9);
        absF = w.absFactor;
        if (absF < 0.95) absActive = true;
      } else w.absFactor = 1;
      w.brakeTorque = pedal * absF + escBrake[w.index] + (!w.front ? handbrake * spec.brakes.handbrake : 0);
    }

    // ---- suspension, ground contact and tyres
    const force = tmpForce.set(0, -spec.mass * G, 0);
    const torque = tmpTorque.set(0, 0, 0);
    const up = this.up;
    let onRoad = 0;
    let onGround = 0;
    let tcSlip = 0;
    let inWater = false;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const mount = this.toWorld(w.mount, tmpMount);
      // Ray from the mount down along the body's -up axis; intersect the local ground plane.
      let t = sus.restLength + w.radius;
      let gHint = w.hint;
      let gy = 0;
      for (let it = 0; it < 2; it++) {
        const px = mount.x - up.x * t;
        const pz = mount.z - up.z * t;
        this.world.ground(px, pz, gHint, hit);
        gHint = hit.hint;
        gy = hit.y;
        surfaceProps(hit.surface, this.wetness, surf);
        if (surf.bump > 0) gy += surf.bump * (valueNoise(px * 1.9, pz * 1.9, 3) * 2 - 1);
        const nDotUp = hit.nx * up.x + hit.ny * up.y + hit.nz * up.z;
        if (nDotUp < 0.2) {
          t = 99;
          break;
        }
        t = (hit.nx * (mount.x - px) + hit.ny * (mount.y - gy) + hit.nz * (mount.z - pz)) / nDotUp;
      }
      w.hint = gHint;
      w.s = hit.s;
      w.d = hit.d;
      const length = t - w.radius;
      const comp = sus.restLength - length;
      w.prevCompression = w.compression;
      if (hit.surface === Surface.Water && gy < WATER_Y - 0.3) inWater = true;
      if (comp <= 0) {
        w.contact = false;
        w.compression = 0;
        w.springLength = sus.restLength;
        w.load = 0;
        w.surface = hit.surface;
        continue;
      }
      w.contact = true;
      w.compression = comp;
      w.springLength = length;
      w.surface = hit.surface;
      w.onRoad = hit.onRoad;
      w.normal.set(hit.nx, hit.ny, hit.nz);
      w.contactPoint.copy(mount).addScaledVector(up, -t);
      onGround++;
      if (hit.onRoad) onRoad++;
    }

    // Spring, damper, anti-roll bars.
    const loads = tmpLoads;
    for (let axle = 0; axle < 2; axle++) {
      const l = this.wheels[axle * 2];
      const r = this.wheels[axle * 2 + 1];
      const front = axle === 0;
      const k = front ? sus.springF : sus.springR;
      const arb = front ? sus.arbF : sus.arbR;
      for (const w of [l, r]) {
        if (!w.contact) {
          loads[w.index] = 0;
          continue;
        }
        const vel = (w.compression - w.prevCompression) / dt;
        const damper = vel > 0 ? (front ? sus.bumpF : sus.bumpR) : front ? sus.reboundF : sus.reboundR;
        let f = k * w.compression + damper * vel;
        if (w.compression > sus.travel) f += k * 14 * (w.compression - sus.travel);
        const other = w === l ? r : l;
        f += arb * (w.compression - (other.contact ? other.compression : 0));
        loads[w.index] = Math.max(0, f);
      }
    }

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.load = loads[i];
      if (!w.contact) {
        // Free-spinning wheel: drive and brake act on the wheel alone.
        const inertia = spec.wheelInertia + w.extraInertia;
        w.omega += (w.driveTorque * dt) / inertia;
        const b = (w.brakeTorque * dt) / inertia;
        w.omega = Math.abs(w.omega) <= b ? 0 : w.omega - Math.sign(w.omega) * b;
        w.skid = Math.max(0, w.skid - dt * 4);
        w.fx = w.fy = 0;
        continue;
      }
      // Suspension force along the body's up axis at the contact point.
      tmpF.copy(up).multiplyScalar(w.load);
      this.addForceAt(tmpF, w.contactPoint, force, torque);

      // Contact frame.
      surfaceProps(w.surface, this.wetness, surf);
      const n = w.normal;
      const cs = Math.cos(w.steer);
      const sn = Math.sin(w.steer);
      // wheel heading in world: fwd*cos + right*sin (positive steer turns left)
      const hx = this.fwd.x * cs + this.left.x * sn;
      const hy = this.fwd.y * cs + this.left.y * sn;
      const hz = this.fwd.z * cs + this.left.z * sn;
      const hn = hx * n.x + hy * n.y + hz * n.z;
      const wf = tmpWf.set(hx - n.x * hn, hy - n.y * hn, hz - n.z * hn).normalize();
      const ws = tmpWs.crossVectors(n, wf).normalize(); // left
      const pv = this.pointVelocity(w.contactPoint, tmpPv);
      const vx = pv.dot(wf);
      const vy = pv.dot(ws);
      const looseBonus = surf.paved ? 1 : 1 + (spec.tyre.looseBonus ?? 0);
      const mu = loadedMu(spec.tyre.mu * surf.grip * looseBonus, w.load, this.refLoad, spec.tyre.loadSensitivity);
      const peakSlip = spec.tyre.peakSlip * surf.peakScale;
      const peakAngle = Math.min(0.5, spec.tyre.peakAngle * Math.sqrt(surf.peakScale));
      const slide = surf.paved ? spec.tyre.slide + (surf.slide - 0.76) : Math.max(surf.slide, spec.tyre.slide);
      const R = w.radius;
      const tyreIn = tmpTyreIn;
      tyreIn.vx = vx;
      tyreIn.vy = vy;
      tyreIn.load = w.load;
      tyreIn.mu = mu;
      tyreIn.peakSlip = peakSlip;
      tyreIn.peakAngle = peakAngle;
      tyreIn.slide = slide;

      // Implicit wheel-spin update: linearise the tyre's longitudinal force around omega.
      const inertia = spec.wheelInertia + w.extraInertia;
      tyreIn.omegaR = w.omega * R;
      const f0 = tyreForce(tyreIn, tyreOut).fx;
      const eps = 0.05;
      tyreIn.omegaR = (w.omega + eps) * R;
      const f1 = tyreForce(tyreIn, tyreOut).fx;
      const dFdw = Math.max(0, (f1 - f0) / eps);
      const denom = inertia + dt * R * dFdw;
      const free = w.omega + (dt * (w.driveTorque - R * f0)) / denom;
      const rollRes = surf.rollRes * w.load * R;
      const friction = (dt * (w.brakeTorque + rollRes)) / denom;
      w.omega = Math.abs(free) <= friction ? 0 : free - Math.sign(free) * friction;

      tyreIn.omegaR = w.omega * R;
      tyreForce(tyreIn, tyreOut);
      w.slipRatio = tyreOut.slipRatio;
      w.slipAngle = tyreOut.slipAngle;
      w.combinedSlip = tyreOut.combined;
      w.fx = tyreOut.fx;
      w.fy = tyreOut.fy;
      // Rolling resistance acts through the wheel; at a standstill hold the car gently.
      tmpF.copy(wf).multiplyScalar(tyreOut.fx).addScaledVector(ws, tyreOut.fy);
      const rc = w.front ? sus.rollCentreF : sus.rollCentreR;
      tmpP.copy(w.contactPoint).addScaledVector(up, rc);
      this.addForceAt(tmpF, tmpP, force, torque);

      // Loose surfaces: extra drag from ploughing through grass/sand.
      if (!surf.paved) {
        const plough = (w.surface === Surface.Sand ? 0.08 : w.surface === Surface.Water ? 0.3 : 0.02) * w.load;
        const pvh = Math.hypot(vx, vy);
        if (pvh > 0.1) {
          tmpF.copy(wf).multiplyScalar((-vx / pvh) * plough).addScaledVector(ws, (-vy / pvh) * plough);
          this.addForceAt(tmpF, w.contactPoint, force, torque);
        }
      }

      const slideAmt = clamp((tyreOut.combined - 0.85) * 1.6, 0, 1) * clamp(Math.hypot(vx, vy) / 4, 0, 1);
      w.skid = slideAmt;
      const driven = spec.drivetrain === "AWD" || (spec.drivetrain === "FWD") === w.front;
      if (driven && throttle > 0.02) tcSlip = Math.max(tcSlip, w.slipRatio * sign(w.omega || 1));
    }

    // ---- traction control reacts to driven wheels spinning up
    let tcActive = false;
    if (this.assists.tc !== "off" && speed > 0.5 && this.gear !== 0) {
      const limit = spec.tyre.peakSlip * (this.assists.tc === "full" ? 1.25 : 2.6);
      if (tcSlip > limit) {
        this.tcFactor = Math.max(0.08, this.tcFactor - dt * (5 + (tcSlip - limit) * 40));
        tcActive = true;
      } else this.tcFactor = Math.min(1, this.tcFactor + dt * 2.2);
      if (this.tcFactor < 0.95) tcActive = true;
    } else this.tcFactor = 1;

    // ---- aerodynamics
    const v2 = speed * speed;
    if (speed > 0.1) {
      const drag = 0.5 * AIR_DENSITY * spec.aero.cdA * v2;
      force.addScaledVector(this.vel, -drag / speed);
      const down = 0.5 * AIR_DENSITY * spec.aero.clA * v2;
      tmpF.copy(up).multiplyScalar(-down * spec.aero.frontShare);
      this.addForceAt(tmpF, tmpP.copy(this.fwd).multiplyScalar(this.a).add(this.pos), force, torque);
      tmpF.copy(up).multiplyScalar(-down * (1 - spec.aero.frontShare));
      this.addForceAt(tmpF, tmpP.copy(this.fwd).multiplyScalar(-this.b).add(this.pos), force, torque);
    }
    if (inWater || this.pos.y < WATER_Y + 0.1) {
      force.addScaledVector(this.vel, -spec.mass * 1.6);
      inWater = true;
    }

    // ---- integrate
    const prevVel = tmpPrevVel.copy(this.vel);
    this.vel.addScaledVector(force, dt / spec.mass);
    // Angular: work in body space with the diagonal inertia tensor.
    const wb = tmpWb.copy(this.angVel).applyMatrix3(tmpRotT.copy(this.rot).transpose());
    const tb = tmpTb.copy(torque).applyMatrix3(tmpRotT);
    const Iw = tmpIw.set(wb.x * this.inertia.x, wb.y * this.inertia.y, wb.z * this.inertia.z);
    const gyro = tmpGyro.crossVectors(wb, Iw);
    wb.x += (tb.x - gyro.x) * this.invInertia.x * dt;
    wb.y += (tb.y - gyro.y) * this.invInertia.y * dt;
    wb.z += (tb.z - gyro.z) * this.invInertia.z * dt;
    this.angVel.copy(wb).applyMatrix3(this.rot);
    this.pos.addScaledVector(this.vel, dt);
    const av = this.angVel;
    tmpQ.set(av.x * dt * 0.5, av.y * dt * 0.5, av.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.set(this.quat.x + tmpQ.x, this.quat.y + tmpQ.y, this.quat.z + tmpQ.z, this.quat.w + tmpQ.w).normalize();
    this.updateBasis();

    // ---- collisions
    this.collide(dt);

    // Visual wheel spin
    for (const w of this.wheels) w.spin = (w.spin + w.omega * dt) % (Math.PI * 2);

    this.lastForceX = (this.vel.x - prevVel.x) / dt;
    this.lastForceZ = (this.vel.z - prevVel.z) / dt;
    this.telemetry.absActive = absActive;
    this.telemetry.tcActive = tcActive;
    this.telemetry.escActive = escActive;
    this.telemetry.wheelsOnRoad = onRoad;
    this.telemetry.wheelsOnGround = onGround;
    this.telemetry.inWater = inWater;
    this.airTime = onGround === 0 ? this.airTime + dt : 0;
    this.telemetry.airborne = this.airTime > 0.15;
    this.updateTelemetry(dt, throttle, brake, prevVel);
  }

  private applyAckermann(delta: number) {
    const spec = this.spec;
    const L = spec.wheelbase;
    const t = spec.trackFront;
    let inner = delta;
    let outer = delta;
    if (Math.abs(delta) > 1e-4) {
      const R = L / Math.tan(Math.abs(delta));
      const ai = Math.atan(L / Math.max(0.5, R - t / 2));
      const ao = Math.atan(L / (R + t / 2));
      inner = sign(delta) * lerp(Math.abs(delta), ai, spec.ackermann);
      outer = sign(delta) * lerp(Math.abs(delta), ao, spec.ackermann);
    }
    // turning left (delta > 0): left wheel is inside
    this.wheels[0].steer = delta > 0 ? inner : outer;
    this.wheels[1].steer = delta > 0 ? outer : inner;
    this.wheels[2].steer = 0;
    this.wheels[3].steer = 0;
    this.telemetry.steerAngle = delta;
  }

  private distributeTorque(shaft: number, engineInertia: number, dt: number) {
    const spec = this.spec;
    const w = this.wheels;
    for (const wh of w) {
      wh.driveTorque = 0;
      wh.extraInertia = 0;
    }
    const axle = (l: Wheel, r: Wheel, torque: number, inertiaShare: number, preload: number, power: number, coast: number) => {
      l.extraInertia = r.extraInertia = inertiaShare / 2;
      const I = spec.wheelInertia + inertiaShare / 2;
      const dw = l.omega - r.omega;
      const lockMax = preload + (torque >= 0 ? power : coast) * Math.abs(torque);
      // A clutch-type LSD resists speed difference up to its lock torque, without overshooting.
      const needed = (Math.abs(dw) * I) / (2 * dt) * 0.8;
      const lock = sign(dw) * Math.min(lockMax, needed);
      l.driveTorque = torque / 2 - lock;
      r.driveTorque = torque / 2 + lock;
    };
    const d = spec.diff;
    if (spec.drivetrain === "RWD") axle(w[2], w[3], shaft, engineInertia, d.rearPreload, d.rearPower, d.rearCoast);
    else if (spec.drivetrain === "FWD") axle(w[0], w[1], shaft, engineInertia, d.frontPreload, d.frontPower, d.frontCoast);
    else {
      // Centre differential with a viscous coupling biasing torque to the slower axle.
      const fOmega = (w[0].omega + w[1].omega) / 2;
      const rOmega = (w[2].omega + w[3].omega) / 2;
      const lockMax = d.centreLock * Math.abs(shaft) + 40;
      const I = spec.wheelInertia * 2;
      const bias = sign(rOmega - fOmega) * Math.min(lockMax, ((Math.abs(rOmega - fOmega) * I) / (2 * dt)) * 0.6);
      const front = shaft * d.frontShare + bias;
      const rear = shaft * (1 - d.frontShare) - bias;
      axle(w[0], w[1], front, engineInertia * d.frontShare, d.frontPreload, d.frontPower, d.frontCoast);
      axle(w[2], w[3], rear, engineInertia * (1 - d.frontShare), d.rearPreload, d.rearPower, d.rearCoast);
    }
  }

  private addForceAt(f: Vector3, point: Vector3, force: Vector3, torque: Vector3) {
    force.add(f);
    const rx = point.x - this.pos.x;
    const ry = point.y - this.pos.y;
    const rz = point.z - this.pos.z;
    torque.x += ry * f.z - rz * f.y;
    torque.y += rz * f.x - rx * f.z;
    torque.z += rx * f.y - ry * f.x;
  }

  /** World-space inverse inertia applied to a vector. */
  private invInertiaWorld(v: Vector3, out: Vector3) {
    out.copy(v).applyMatrix3(tmpRotT.copy(this.rot).transpose());
    out.x *= this.invInertia.x;
    out.y *= this.invInertia.y;
    out.z *= this.invInertia.z;
    return out.applyMatrix3(this.rot);
  }

  /** Resolves a contact at `point` with normal `n` (pointing out of the obstacle). */
  private contactImpulse(point: Vector3, n: Vector3, depth: number, restitution: number, friction: number): number {
    const r = tmpR.subVectors(point, this.pos);
    const v = this.pointVelocity(point, tmpCv);
    const vn = v.dot(n);
    if (depth > 0.005) {
      const corr = Math.min(depth, 0.25) * 0.85;
      this.pos.addScaledVector(n, corr);
    }
    if (vn >= 0) return 0;
    const rn = tmpRn.crossVectors(r, n);
    const k = 1 / this.spec.mass + this.invInertiaWorld(rn, tmpK).cross(r).dot(n);
    const j = (-(1 + restitution) * vn) / k;
    tmpImp.copy(n).multiplyScalar(j);
    // Friction along the sliding direction.
    const vt = tmpVt.copy(v).addScaledVector(n, -vn);
    const vtl = vt.length();
    if (vtl > 1e-3) {
      vt.divideScalar(vtl);
      const rt = tmpRn.crossVectors(r, vt);
      const kt = 1 / this.spec.mass + this.invInertiaWorld(rt, tmpK).cross(r).dot(vt);
      const jt = Math.min(friction * j, vtl / kt);
      tmpImp.addScaledVector(vt, -jt);
    }
    this.vel.addScaledVector(tmpImp, 1 / this.spec.mass);
    const ang = this.invInertiaWorld(tmpRn.crossVectors(r, tmpImp), tmpK);
    this.angVel.add(ang);
    return -vn;
  }

  private collide(dt: number) {
    const he = this.halfExtents;
    this.stepsSinceContact++;
    // Body against the ground (bottoming out, rollovers).
    for (let i = 0; i < BODY_POINTS.length; i++) {
      const bp = BODY_POINTS[i];
      tmpLocal.set(bp[0] * he.x * 0.92, bp[1] > 0 ? 0.62 : this.bottomY, bp[2] * he.z * (bp[1] > 0 ? 0.45 : 0.92));
      const p = this.toWorld(tmpLocal, tmpP2);
      this.world.ground(p.x, p.z, this.wheels[0].hint, hit);
      const depth = hit.y - p.y;
      if (depth > 0) {
        tmpN.set(hit.nx, hit.ny, hit.nz);
        const imp = this.contactImpulse(p, tmpN, depth * tmpN.y, 0.1, 0.45);
        if (imp > 2) this.impacts.push({ kind: "ground", speed: imp, x: p.x, y: p.y, z: p.z });
      }
    }

    // Guardrails: barriers at a fixed lateral offset from the road edge.
    const proj = this.track.project(this.pos.x, this.pos.z, this.wheels[0].hint);
    const f = this.track.frameAt(proj.s, tmpFrame);
    for (const side of SIDES) {
      const rail = this.track.railAt(proj.s, side);
      if (!rail) continue;
      const railD = (f.halfWidth + rail.offset) * side;
      const railY = f.y - railD * Math.tan(f.bank);
      if (this.pos.y - railY > 2.5) continue;
      for (const c of CORNERS) {
        tmpLocal.set(c[0] * he.x, 0, c[1] * he.z);
        const p = this.toWorld(tmpLocal, tmpP2);
        const d = proj.d + (p.x - this.pos.x) * f.nx + (p.z - this.pos.z) * f.nz;
        const pen = side > 0 ? d - railD : railD - d;
        if (pen > 0 && pen < 2.5) {
          tmpN.set(-f.nx * side, 0, -f.nz * side);
          const imp = this.contactImpulse(p, tmpN, pen, 0.18, 0.3);
          this.stepsSinceContact = 0;
          if (imp > 0.4) this.impacts.push({ kind: "rail", speed: imp, x: p.x, y: p.y, z: p.z });
        }
      }
    }

    // Trees and rocks: circles against the car's footprint rectangle.
    this.world.collidersNear(this.pos.x, this.pos.z, 4, colliders);
    if (colliders.length) {
      const fx = this.fwd.x;
      const fz = this.fwd.z;
      const fl = Math.hypot(fx, fz) || 1;
      const hx = fx / fl;
      const hz = fz / fl;
      for (const c of colliders) {
        const dx = c.x - this.pos.x;
        const dz = c.z - this.pos.z;
        // local: lz along heading, lx to the left
        const lz = dx * hx + dz * hz;
        const lx = dx * hz - dz * hx;
        const cx = clamp(lx, -he.x, he.x);
        const cz = clamp(lz, -he.z, he.z);
        let nxL = lx - cx;
        let nzL = lz - cz;
        let dist = Math.hypot(nxL, nzL);
        let pen: number;
        if (dist < 1e-6) {
          // centre inside the footprint: push out along the shallowest axis
          const px = he.x - Math.abs(lx);
          const pz = he.z - Math.abs(lz);
          if (px < pz) {
            nxL = Math.sign(lx);
            nzL = 0;
          } else {
            nxL = 0;
            nzL = Math.sign(lz);
          }
          dist = 0;
          pen = c.r + Math.min(px, pz);
        } else {
          if (dist >= c.r) continue;
          nxL /= dist;
          nzL /= dist;
          pen = c.r - dist;
        }
        // normal pointing from obstacle into the car = -(towards obstacle)
        const wx = -(nxL * hz + nzL * hx);
        const wz = -(-nxL * hx + nzL * hz);
        tmpN.set(wx, 0, wz).normalize();
        tmpP2.set(this.pos.x + cx * hz + cz * hx, this.pos.y, this.pos.z - cx * hx + cz * hz);
        const imp = this.contactImpulse(tmpP2, tmpN, pen, 0.12, 0.35);
        this.stepsSinceContact = 0;
        if (imp > 0.4) this.impacts.push({ kind: c.kind === "tree" ? "tree" : "rock", speed: imp, x: tmpP2.x, y: tmpP2.y, z: tmpP2.z });
      }
    }

    // Keep inside the modelled world.
    const ext = this.world.extent;
    const bx = this.pos.x < ext.x0 ? 1 : this.pos.x > ext.x1 ? -1 : 0;
    const bz = this.pos.z < ext.z0 ? 1 : this.pos.z > ext.z1 ? -1 : 0;
    if (bx || bz) {
      tmpN.set(bx, 0, bz).normalize();
      const pen = Math.max(bx > 0 ? ext.x0 - this.pos.x : bx < 0 ? this.pos.x - ext.x1 : 0, bz > 0 ? ext.z0 - this.pos.z : bz < 0 ? this.pos.z - ext.z1 : 0);
      const imp = this.contactImpulse(this.pos, tmpN, pen, 0.1, 0.2);
      if (imp > 0.5) this.impacts.push({ kind: "bounds", speed: imp, x: this.pos.x, y: this.pos.y, z: this.pos.z });
    }
    void dt;
  }

  private updateTelemetry(dt: number, throttle = 0, brake = 0, prevVel?: Vector3) {
    const t = this.telemetry;
    const fwd = this.vel.dot(this.fwd);
    t.speed = this.vel.length();
    t.forwardSpeed = fwd;
    t.kmh = Math.abs(fwd) * 3.6;
    t.rpm = this.rpm;
    t.gear = this.gear;
    t.throttle = throttle;
    t.brake = brake;
    t.steer = this.steerState;
    t.handbrake = this.handbrakeState;
    const lat = this.vel.dot(this.left);
    t.sideslip = t.speed > 3 ? Math.atan2(lat, Math.abs(fwd)) : 0;
    t.yawRate = this.angVel.dot(this.up);
    if (prevVel && dt > 0) {
      const ax = (this.vel.x - prevVel.x) / dt;
      const az = (this.vel.z - prevVel.z) / dt;
      const ay = (this.vel.y - prevVel.y) / dt;
      const latA = ax * this.left.x + ay * this.left.y + az * this.left.z;
      const lonA = ax * this.fwd.x + ay * this.fwd.y + az * this.fwd.z;
      t.latG += (latA / G - t.latG) * Math.min(1, dt * 12);
      t.longG += (lonA / G - t.longG) * Math.min(1, dt * 12);
    }
    t.upright = this.up.y;
    t.shifting = this.shiftTimer > 0;
    t.s = this.wheels[0].s;
    t.d = (this.wheels[0].d + this.wheels[1].d + this.wheels[2].d + this.wheels[3].d) / 4;
  }

  /** Car-relative force estimate (for camera and audio). */
  get planarAccel() {
    return { x: this.lastForceX, z: this.lastForceZ };
  }
}


function approachRate(cur: number, target: number, up: number, down: number, dt: number) {
  const rising = Math.abs(target) > Math.abs(cur) && sign(target) === sign(cur || target);
  const r = (rising ? up : down) * dt;
  return cur < target ? Math.min(cur + r, target) : Math.max(cur - r, target);
}

const tmpMat4 = new Matrix4();
function matrix4From3(m: Matrix3) {
  const e = m.elements;
  return tmpMat4.set(e[0], e[3], e[6], 0, e[1], e[4], e[7], 0, e[2], e[5], e[8], 0, 0, 0, 0, 1);
}

const SIDES: (1 | -1)[] = [1, -1];
const CORNERS: [number, number][] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
];
const BODY_POINTS: [number, number, number][] = [
  [1, -1, 1],
  [-1, -1, 1],
  [1, -1, -1],
  [-1, -1, -1],
  [1, 1, 1],
  [-1, 1, 1],
  [1, 1, -1],
  [-1, 1, -1],
];
const tmpFrame = {} as Frame;
const tmpVel = new Vector3();
const tmpMount = new Vector3();
const tmpForce = new Vector3();
const tmpTorque = new Vector3();
const tmpF = new Vector3();
const tmpP = new Vector3();
const tmpP2 = new Vector3();
const tmpPv = new Vector3();
const tmpWf = new Vector3();
const tmpWs = new Vector3();
const tmpN = new Vector3();
const tmpR = new Vector3();
const tmpRn = new Vector3();
const tmpK = new Vector3();
const tmpCv = new Vector3();
const tmpVt = new Vector3();
const tmpImp = new Vector3();
const tmpLocal = new Vector3();
const tmpWb = new Vector3();
const tmpTb = new Vector3();
const tmpIw = new Vector3();
const tmpGyro = new Vector3();
const tmpPrevVel = new Vector3();
const tmpRotT = new Matrix3();
const tmpLoads = [0, 0, 0, 0];
const tmpTyreIn = { vx: 0, vy: 0, omegaR: 0, load: 0, mu: 1, peakSlip: 0.1, peakAngle: 0.12, slide: 0.75 };
