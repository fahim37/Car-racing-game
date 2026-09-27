import { Vehicle } from "../physics/Vehicle";
import { Track } from "../track/Track";
import { clamp, smoothstep } from "../util/math";

export interface DriftZone {
  name: string;
  s0: number;
  s1: number;
  /** Apex clipping point: station and the inside side of the road. */
  clipS: number;
  clipSide: 1 | -1;
}

export interface ZoneResult {
  name: string;
  score: number;
  grade: "S" | "A" | "B" | "C" | "-";
  bestAngle: number;
  clean: boolean;
}

export type DriftEvent =
  | { kind: "banked"; points: number; clean: boolean }
  | { kind: "lost"; reason: string }
  | { kind: "transition" }
  | { kind: "clip" }
  | { kind: "zone"; zone: ZoneResult };

const MIN_SPEED = 8.5; // m/s (~30 km/h)
const MIN_ANGLE = 0.2; // rad (~11.5 degrees)
const SPIN_ANGLE = 1.75; // rad (~100 degrees)

/**
 * Scores controlled slides. Points need angle, speed and time together, inside a zone and on
 * the road. A spin, contact with a barrier or tree, or leaving the road loses the unbanked combo.
 * Nothing is awarded outside zones, and drifting is never faster than gripping: it only scores.
 */
export class DriftScorer {
  total = 0;
  combo = 0; // points waiting to be banked
  comboTime = 0;
  multiplier = 1;
  angle = 0; // current drift angle (degrees) for the HUD
  active = false;
  currentZone: DriftZone | null = null;
  zoneScores = new Map<string, ZoneResult>();
  events: DriftEvent[] = [];
  private exitTimer = 0;
  private lastDir = 0;
  private sinceDirChange = 99;
  private clipped = new Set<string>();
  private zoneBestAngle = 0;
  private zoneClean = true;
  driftTime = 0; // total seconds of valid drifting (lessons)
  transitions = 0;

  constructor(
    private track: Track,
    public zones: DriftZone[],
    /** When false, drifting anywhere scores (free drive / pad lessons). */
    private requireZones = true,
  ) {}

  reset() {
    this.total = 0;
    this.combo = 0;
    this.comboTime = 0;
    this.multiplier = 1;
    this.active = false;
    this.zoneScores.clear();
    this.events = [];
    this.clipped.clear();
    this.driftTime = 0;
    this.transitions = 0;
    this.currentZone = null;
  }

  private zoneAt(s: number) {
    for (const z of this.zones) if (this.track.inRange(s, z)) return z;
    return null;
  }

  update(dt: number, v: Vehicle, s: number, d: number, onRoad: boolean) {
    const t = v.telemetry;
    const beta = t.sideslip;
    const ab = Math.abs(beta);
    const speed = t.speed;
    const zone = this.requireZones ? this.zoneAt(s) : null;
    const scoringArea = !this.requireZones || !!zone;

    // Zone bookkeeping.
    if (zone !== this.currentZone) {
      if (this.currentZone) this.closeZone(this.currentZone);
      this.currentZone = zone;
      this.zoneBestAngle = 0;
      this.zoneClean = true;
    }

    const contact = v.stepsSinceContact < 2;
    const spinning = ab > SPIN_ANGLE || (ab > 0.9 && speed < 4);
    const drifting = speed > MIN_SPEED && ab > MIN_ANGLE && !spinning;

    if (this.active && (contact || spinning || !onRoad)) {
      this.lose(contact ? "Contact" : spinning ? "Spun out" : "Off the road");
      return;
    }

    if (drifting && scoringArea && onRoad) {
      const dir = Math.sign(beta);
      if (!this.active) {
        this.active = true;
        this.comboTime = 0;
        this.lastDir = dir;
        this.sinceDirChange = 99;
      } else if (dir !== this.lastDir) {
        // Switching the car from one slide to the other.
        if (this.sinceDirChange < 1.2 || this.exitTimer > 0) {
          this.combo *= 1.2;
          this.transitions++;
          this.events.push({ kind: "transition" });
        }
        this.lastDir = dir;
        this.sinceDirChange = 0;
      }
      this.exitTimer = 0;
      this.sinceDirChange = Math.min(this.sinceDirChange, 99) + dt;
      const angleF = smoothstep(MIN_ANGLE, 0.45, ab) * (1 - 0.6 * smoothstep(1.05, 1.5, ab));
      const speedF = clamp(speed / 16, 0.5, 1.8);
      this.comboTime += dt;
      this.driftTime += dt;
      this.multiplier = 1 + Math.min(1.5, this.comboTime / 2.5);
      this.combo += 120 * angleF * speedF * this.multiplier * dt;
      this.angle = (ab * 180) / Math.PI;
      this.zoneBestAngle = Math.max(this.zoneBestAngle, this.angle);
      // Clipping the apex of a zone: inside edge, near the clip point.
      if (zone && !this.clipped.has(zone.name) && Math.abs(this.track.delta(zone.clipS, s)) < 6) {
        const f = this.track.frameAt(s);
        const insideDist = f.halfWidth - d * zone.clipSide;
        if (insideDist < 1.8) {
          this.clipped.add(zone.name);
          this.combo += 350;
          this.events.push({ kind: "clip" });
        }
      }
    } else if (this.active) {
      // Straightening up: bank after a short, settled exit.
      this.exitTimer += dt;
      this.sinceDirChange += dt;
      if (ab < 0.14 || !scoringArea || speed < MIN_SPEED) {
        if (this.exitTimer > 0.35 || !scoringArea) this.bank(Math.abs(t.yawRate) < 0.5);
      } else if (this.exitTimer > 1.2) {
        this.bank(false);
      }
      if (!this.active) this.angle = 0;
    } else {
      this.angle = 0;
    }
  }

  private bank(clean: boolean) {
    const pts = Math.round(this.combo * (clean ? 1.1 : 1));
    if (pts > 0) {
      this.total += pts;
      if (this.currentZone) {
        const r = this.zoneScores.get(this.currentZone.name) ?? { name: this.currentZone.name, score: 0, grade: "-", bestAngle: 0, clean: true };
        r.score += pts;
        this.zoneScores.set(this.currentZone.name, r);
      }
      this.events.push({ kind: "banked", points: pts, clean });
    }
    this.combo = 0;
    this.comboTime = 0;
    this.multiplier = 1;
    this.active = false;
    this.exitTimer = 0;
  }

  private lose(reason: string) {
    this.events.push({ kind: "lost", reason });
    this.zoneClean = false;
    this.combo = 0;
    this.comboTime = 0;
    this.multiplier = 1;
    this.active = false;
    this.angle = 0;
  }

  private closeZone(z: DriftZone) {
    if (this.active) this.bank(true);
    const r = this.zoneScores.get(z.name) ?? { name: z.name, score: 0, grade: "-", bestAngle: 0, clean: true };
    r.bestAngle = Math.max(r.bestAngle, this.zoneBestAngle);
    r.clean = r.clean && this.zoneClean;
    r.grade = r.score >= 9000 ? "S" : r.score >= 6000 ? "A" : r.score >= 3000 ? "B" : r.score > 0 ? "C" : "-";
    this.zoneScores.set(z.name, r);
    this.events.push({ kind: "zone", zone: { ...r } });
  }

  /** Call when the run ends to bank anything outstanding. */
  finish() {
    if (this.currentZone) this.closeZone(this.currentZone);
    else if (this.active) this.bank(true);
    this.currentZone = null;
  }
}

/** The four scored zones of the lakeside run. */
export function lakesideZones(track: Track): DriftZone[] {
  const out: DriftZone[] = [];
  for (const short of ["T6", "T7", "T10", "T12"]) {
    const c = track.corners.find((k) => k.short === short);
    if (!c) continue;
    out.push({ name: `${c.name} (${c.short})`, s0: c.sStart - 25, s1: c.sEnd + 35, clipS: c.sApex, clipSide: c.dir });
  }
  return out;
}
