import { DriverControls, Vehicle } from "../physics/Vehicle";
import { RacingLine, lineSpeedAt } from "../track/racingLine";
import { clamp, wrapAngle } from "../util/math";

/**
 * A driver that follows the reference line using the same controls as a player.
 * It has no access to extra grip or speed: all it can do is steer, brake and accelerate.
 * `pace` scales the reference speed (skill); `lineOffset` shifts its line sideways.
 *
 * Steering is a path-tracking controller: curvature feed-forward (how much the line bends)
 * plus corrections for heading and lateral error, measured at the front axle.
 */
export class Autopilot {
  readonly controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false, digitalSteer: false, digitalPedals: false };
  private hint = -1;
  private steer = 0;

  constructor(
    public vehicle: Vehicle,
    public line: RacingLine,
    public pace = 0.95,
    public lineOffset = 0,
  ) {}

  private nearest(x: number, z: number, s: number) {
    const line = this.line;
    const n = line.count;
    const L = this.vehicle.track.length;
    let i = Math.floor((((s % L) + L) % L) / (L / n)) % n;
    let best = Infinity;
    let bi = i;
    for (let k = -6; k <= 6; k++) {
      const j = (i + k + n) % n;
      const d = (line.x[j] - x) ** 2 + (line.z[j] - z) ** 2;
      if (d < best) {
        best = d;
        bi = j;
      }
    }
    i = bi;
    return i;
  }

  update(dt: number): DriverControls {
    const v = this.vehicle;
    const track = v.track;
    const line = this.line;
    const n = line.count;
    const speed = v.telemetry.speed;
    // Measure at the front axle.
    const fx = v.pos.x + v.fwd.x * v.a;
    const fz = v.pos.z + v.fwd.z * v.a;
    const p = track.project(fx, fz, this.hint);
    this.hint = p.i;
    const i = this.nearest(fx, fz, p.s);
    const j = (i + 1) % n;
    const lx = line.x[j] - line.x[i];
    const lz = line.z[j] - line.z[i];
    const lineHeading = Math.atan2(lx, lz);
    const ll = Math.hypot(lx, lz) || 1;
    // left normal of the line direction (lx, lz) is (lz, -lx)
    const nx = lz / ll;
    const nz = -lx / ll;
    let ex = fx - line.x[i];
    let ez = fz - line.z[i];
    if (this.lineOffset) {
      ex -= nx * this.lineOffset;
      ez -= nz * this.lineOffset;
    }
    const cross = ex * nx + ez * nz; // + = car is left of the line
    const carHeading = Math.atan2(v.fwd.x, v.fwd.z);
    const headingErr = wrapAngle(lineHeading - carHeading);
    // Curvature a little ahead to cover steering lag.
    const ahead = (i + Math.round((speed * 0.15) / line.step)) % n;
    const kappa = line.curvature[ahead];
    const L = v.spec.wheelbase;
    let delta = Math.atan(L * kappa * (1 + 0.0015 * speed * speed)) + headingErr * 0.9 + Math.atan((-1.6 * cross) / (speed + 3));
    delta -= (v.telemetry.yawRate - speed * kappa) * 0.03;
    // Catch slides by steering towards the direction of travel.
    delta += v.telemetry.sideslip * 0.5;
    const target = clamp(-delta / Math.max(0.05, v.steerLockNow), -1, 1);
    this.steer += (target - this.steer) * Math.min(1, dt * 18);

    const lead = Math.max(3, speed * 0.28);
    const vRef = lineSpeedAt(line, p.s + lead, track.length) * this.pace;
    const err = vRef - speed;
    const c = this.controls;
    c.steer = this.steer;
    if (err > 0.3) {
      c.throttle = clamp(0.25 + err * 0.4, 0, 1);
      c.brake = 0;
    } else if (err < -0.8) {
      c.throttle = 0;
      c.brake = clamp(-err * 0.25, 0, 1);
    } else {
      c.throttle = 0.18;
      c.brake = 0;
    }
    if (Math.abs(v.telemetry.sideslip) > 0.12) c.throttle *= 0.5;
    c.handbrake = 0;
    return c;
  }
}
