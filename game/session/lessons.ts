import { Vehicle } from "../physics/Vehicle";
import { RacingLine, lineSpeedAt } from "../track/racingLine";
import { Corner, Track } from "../track/Track";
import { World } from "../world/World";
import { DriftScorer } from "./DriftScorer";

export interface Spawn {
  s: number;
  d: number;
  speed: number;
  gear?: number;
  yawKick?: number;
  heading?: number; // absolute heading override
}

export interface LessonCtx {
  v: Vehicle;
  track: Track;
  world: World;
  line: RacingLine;
  s: number;
  d: number;
  kmh: number;
  offRoad: boolean; // no wheel on paved surface
  paved: boolean;
  contact: boolean;
  drift: DriftScorer;
  dt: number;
}

export interface Flash {
  text: string;
  good: boolean;
}

export abstract class Lesson {
  abstract readonly title: string;
  abstract readonly steps: string[];
  step = 0;
  prompt = "";
  tip = "";
  progress = 0;
  result: "success" | null = null;
  respawn: Spawn | null = null;
  flash: Flash | null = null;
  retries = 0;
  /** Lesson takes place on the paddock pad. */
  padLesson = false;
  /** Drift scoring runs (and shows) during this lesson. */
  scoresDrift = false;
  constructor(
    protected track: Track,
    protected line: RacingLine,
    protected world: World,
  ) {}
  abstract spawn(): Spawn;
  abstract update(c: LessonCtx): void;

  protected corner(short: string): Corner {
    return this.track.corners.find((c) => c.short === short)!;
  }
  /** True once the car has passed station `x` (within a window behind it). */
  protected passed(s: number, x: number, window = 250) {
    const d = this.track.delta(x, s);
    return d >= 0 && d < window;
  }
  protected refKmh(s: number) {
    return lineSpeedAt(this.line, s, this.track.length) * 3.6;
  }
  protected fail(text: string, at: Spawn) {
    this.flash = { text, good: false };
    this.respawn = at;
    this.retries++;
  }
  protected good(text: string) {
    this.flash = { text, good: true };
  }
}

class SteeringLesson extends Lesson {
  title = "Smooth Hands";
  steps = ["Accelerate to 70 km/h", "Follow the line through the Lakeshore Sweep", "Brake to a stop before the 150 board"];
  private t1 = this.corner("T1");
  private t2 = this.corner("T2");
  spawn(): Spawn {
    return { s: this.track.length - 60, d: -1.5, speed: 0 };
  }
  update(c: LessonCtx) {
    const stopZoneEnd = this.t2.sStart - 150;
    if (this.step === 0) {
      this.prompt = "Hold W / ↑ / RT to accelerate. Keep the car pointed along the road.";
      this.tip = "Tap A/D (or use the stick) gently. Small inputs are all you need at speed.";
      this.progress = Math.min(1, c.kmh / 70) / 3;
      if (c.kmh >= 70) {
        this.step = 1;
        this.good("Nice and steady.");
      }
    } else if (this.step === 1) {
      this.prompt = "Follow the green line through the Lakeshore Sweep. Turn in early and smoothly.";
      this.tip = "Look far ahead through the corner. Your hands follow your eyes.";
      this.progress = 1 / 3 + Math.min(1, Math.max(0, this.track.delta(this.t1.sStart - 100, c.s)) / (this.t1.sEnd - this.t1.sStart + 120)) / 3;
      if (c.offRoad) this.fail("All four wheels left the road. Ease off, and steer earlier and more gently.", { s: this.t1.sStart - 160, d: 0, speed: 70 / 3.6 });
      else if (this.passed(c.s, this.t1.sEnd + 20)) {
        this.step = 2;
        this.good("Clean line through the sweep!");
      }
    } else if (this.step === 2) {
      this.prompt = "Brake smoothly to a complete stop before the 150 m board ahead.";
      this.tip = "Press firmly at first, then ease off as the car slows to stop gently.";
      const remaining = this.track.delta(c.s, stopZoneEnd);
      this.progress = 2 / 3 + (1 - Math.min(1, c.kmh / 90)) / 3;
      if (c.kmh < 2 && remaining > -2) {
        this.result = "success";
        this.good("Stopped in the zone. You're ready for braking into corners.");
      } else if (remaining < -2 && c.kmh > 3) {
        this.fail("You passed the board. Start braking earlier, with a firm first press.", { s: this.t1.sEnd + 25, d: 0, speed: 85 / 3.6 });
      } else if (c.offRoad) {
        this.fail("Off the road. Keep the wheel straight while braking.", { s: this.t1.sEnd + 25, d: 0, speed: 85 / 3.6 });
      }
    }
  }
}

class BrakingLesson extends Lesson {
  title = "Brake Before You Turn";
  steps = ["Accelerate down the straight", "Brake in a straight line to the target speed", "Turn in, clip the apex, run out wide"];
  private c = this.corner("T2");
  private target = Math.round(this.refKmh(this.c.sStart + 5) / 5) * 5;
  spawn(): Spawn {
    return { s: this.c.sStart - 330, d: 0, speed: 0 };
  }
  update(c: LessonCtx) {
    const k = this.c;
    if (this.step === 0) {
      this.prompt = "Accelerate hard towards Larch Bend. Watch for the 150 / 100 / 50 boards on the right.";
      this.tip = "Braking distance grows with the square of your speed: twice as fast needs four times the room.";
      this.progress = Math.min(1, this.track.delta(k.sStart - 330, c.s) / 180) / 3;
      if (this.passed(c.s, k.sStart - 150)) this.step = 1;
    } else if (this.step === 1) {
      this.prompt = `Brake now, in a straight line, to about ${this.target} km/h by the corner.`;
      this.tip = "Squeeze the brake on hard, then ease off as you slow. Braking and turning share the tyres' grip.";
      this.progress = 1 / 3 + Math.min(1, Math.max(0, this.track.delta(k.sStart - 150, c.s)) / 150) / 3;
      if (this.passed(c.s, k.sStart)) {
        if (c.kmh > this.target + 12) {
          this.fail(`Too fast: ${Math.round(c.kmh)} km/h. The car would run wide. Brake at the 150 board, and firmer.`, this.spawn());
          this.step = 0;
        } else {
          if (c.kmh < this.target - 30) this.good(`Safe (${Math.round(c.kmh)} km/h) but slow. Next time brake a little later.`);
          else this.good(`${Math.round(c.kmh)} km/h. Right on target.`);
          this.step = 2;
        }
      }
    } else if (this.step === 2) {
      this.prompt = "Turn in now. Aim for the inside kerb at the apex, then let the car drift out on exit.";
      this.tip = "Only add throttle once you can see the exit and start unwinding the steering.";
      this.progress = 2 / 3 + Math.min(1, Math.max(0, this.track.delta(k.sStart, c.s)) / (k.sEnd - k.sStart + 30)) / 3;
      if (c.offRoad) {
        this.fail("Wheels off at the exit. Brake a touch earlier so you can turn more gently.", this.spawn());
        this.step = 0;
      } else if (this.passed(c.s, k.sEnd + 30)) {
        this.result = "success";
        this.good("Brake straight, then turn. That's the foundation of every fast lap.");
      }
    }
  }
}

class ExitLesson extends Lesson {
  title = "Patient Throttle";
  steps = ["Slow for Heron Turn", "Wait at the apex", "Squeeze the throttle and exit fast"];
  private c = this.corner("T10");
  private exitS = this.c.sEnd + 90;
  private targetExit = Math.round((this.refKmh(this.c.sEnd + 90) * 0.88) / 5) * 5;
  private slid = false;
  spawn(): Spawn {
    return { s: this.c.sStart - 110, d: 0, speed: 95 / 3.6 };
  }
  update(c: LessonCtx) {
    const k = this.c;
    if (this.step === 0) {
      this.prompt = `Brake for Heron Turn and turn in. Target exit: ${this.targetExit} km/h at the marker.`;
      this.tip = "A slightly slower entry often gives a much faster exit.";
      this.progress = Math.min(1, Math.max(0, this.track.delta(k.sStart - 110, c.s)) / 110) / 3;
      if (this.passed(c.s, k.sStart)) this.step = 1;
    } else if (this.step === 1) {
      this.prompt = "Hold a steady, light throttle until you reach the apex.";
      this.tip = "Too much power while still turning hard pushes the car wide or makes the rear slide.";
      this.progress = 1 / 3 + Math.min(1, Math.max(0, this.track.delta(k.sStart, c.s)) / (k.sApex - k.sStart)) / 3;
      if (this.passed(c.s, k.sApex)) this.step = 2;
    } else {
      this.prompt = "Unwind the steering and squeeze the throttle to full as the car straightens.";
      this.tip = "Throttle and steering are connected: more lock, less throttle.";
      this.progress = 2 / 3 + Math.min(1, Math.max(0, this.track.delta(k.sApex, c.s)) / (this.exitS - k.sApex)) / 3;
      if (Math.abs(c.v.telemetry.sideslip) > 0.14) this.slid = true;
      if (c.offRoad) {
        this.fail("Ran wide off the road. Wait a moment longer before full throttle.", this.spawn());
        this.step = 0;
        this.slid = false;
      } else if (this.passed(c.s, this.exitS)) {
        if (this.slid) {
          this.fail("The rear stepped out. Add throttle more progressively as you unwind the wheel.", this.spawn());
          this.step = 0;
          this.slid = false;
        } else if (c.kmh + 1 < this.targetExit) {
          this.fail(`Exit speed ${Math.round(c.kmh)} km/h, target ${this.targetExit}. Start squeezing the power a little earlier.`, this.spawn());
          this.step = 0;
        } else {
          this.result = "success";
          this.good(`${Math.round(c.kmh)} km/h out of the corner, with no slide. Patient and fast.`);
        }
      }
    }
  }
}

class TrailLesson extends Lesson {
  title = "Trail Braking";
  steps = ["Brake hard in a straight line", "Keep light brake pressure while turning in", "Release towards the apex and exit cleanly"];
  private c = this.corner("T6");
  private trail = 0;
  spawn(): Spawn {
    return { s: this.c.sStart - 230, d: 0, speed: 105 / 3.6 };
  }
  update(c: LessonCtx) {
    const k = this.c;
    const t = c.v.telemetry;
    if (this.step === 0) {
      this.prompt = "Brake hard for the Pine Hairpin, starting near the 100 board.";
      this.tip = "Maximum braking happens in a straight line, before the steering goes in.";
      this.progress = Math.min(1, Math.max(0, this.track.delta(k.sStart - 230, c.s)) / 215) / 3;
      if (this.passed(c.s, k.sStart - 15)) this.step = 1;
    } else if (this.step === 1) {
      this.prompt = "As you turn in, keep a little brake on and bleed it off towards the apex.";
      this.tip = "Weight stays on the front tyres, so the nose bites and the car rotates.";
      if (t.brake > 0.1 && Math.abs(t.steerAngle) > 0.06) this.trail += c.dt;
      this.progress = 1 / 3 + Math.min(1, this.trail / 0.4) / 3;
      if (this.trail >= 0.4 && !this.flash) this.good("Trail braking ✓");
      if (this.passed(c.s, k.sApex)) this.step = 2;
    } else {
      this.prompt = "Off the brake at the apex, unwind and drive out cleanly.";
      this.tip = "If the rear feels light, stay smooth: sudden inputs upset the car.";
      this.progress = 2 / 3 + Math.min(1, Math.max(0, this.track.delta(k.sApex, c.s)) / (k.sEnd + 30 - k.sApex)) / 3;
      if (c.offRoad || c.contact) {
        this.fail("You ran out of road. Brake slightly earlier, and keep the trail light.", this.spawn());
        this.step = 0;
        this.trail = 0;
      } else if (this.passed(c.s, k.sEnd + 30)) {
        if (this.trail < 0.4) {
          this.fail("You let go of the brake before turning. Keep a light brake on as the steering goes in.", this.spawn());
          this.step = 0;
          this.trail = 0;
        } else {
          this.result = "success";
          this.good("Textbook trail braking. The car turned in beautifully.");
        }
      }
    }
  }
}

function padSpawn(world: World, frac: number, speed: number, dOff = 0): Spawn {
  const p = world.pad;
  return { s: p.s0 + (p.s1 - p.s0) * frac, d: (p.d0 + p.d1) / 2 + dOff, speed };
}

class SlidesLesson extends Lesson {
  title = "Catching Slides";
  steps = ["Recover slide 1", "Recover slide 2", "Recover slide 3"];
  padLesson = true;
  private caught = 0;
  private attemptT = 0;
  private calm = 0;
  private dir = 1;
  private waiting = 0;
  spawn(): Spawn {
    return { ...padSpawn(this.world, 0.08, 16, 0), yawKick: 0.95 * this.dir, gear: 2 };
  }
  update(c: LessonCtx) {
    const t = c.v.telemetry;
    this.progress = this.caught / 3;
    this.step = Math.min(2, this.caught);
    if (this.waiting > 0) {
      this.waiting -= c.dt;
      this.prompt = "Brake gently to a stop. The next slide goes the other way.";
      if (this.waiting <= 0) {
        this.dir = -this.dir;
        this.respawn = this.spawn();
        this.attemptT = 0;
        this.calm = 0;
      }
      return;
    }
    this.prompt = "The rear is stepping out! Steer into the slide and lift off the throttle.";
    this.tip = "Point the front wheels where you want to go. Once the car straightens, unwind quickly or it will snap the other way.";
    this.attemptT += c.dt;
    const ab = Math.abs(t.sideslip);
    if (ab > 1.2) {
      this.fail("Spun. Countersteer sooner, and don't add throttle until the car is straight.", this.spawn());
      this.attemptT = 0;
      this.calm = 0;
      return;
    }
    if (!c.paved) {
      this.fail("Ran off the pad. Catch the slide earlier with a quick countersteer.", this.spawn());
      this.attemptT = 0;
      return;
    }
    if (this.attemptT > 0.5 && ab < 0.09 && Math.abs(t.yawRate) < 0.3) this.calm += c.dt;
    else this.calm = 0;
    if (this.calm > 0.35) {
      this.caught++;
      this.good(this.caught >= 3 ? "Three slides caught. Nicely done!" : `Caught it! (${this.caught}/3)`);
      if (this.caught >= 3) this.result = "success";
      else this.waiting = 1.6;
    } else if (this.attemptT > 5) {
      this.fail("Took too long to settle. Be decisive with the countersteer.", this.spawn());
      this.attemptT = 0;
    }
  }
}

class DriftLesson extends Lesson {
  title = "Drift Basics";
  steps = ["Break the rear loose", "Balance the slide", "Hold 4 seconds of drift"];
  padLesson = true;
  scoresDrift = true;
  spawn(): Spawn {
    return { ...padSpawn(this.world, 0.12, 11, -8), gear: 2 };
  }
  update(c: LessonCtx) {
    const dt = c.drift.driftTime;
    this.progress = Math.min(1, dt / 4);
    this.step = dt > 2 ? 2 : c.drift.active ? 1 : 0;
    if (this.step === 0) {
      this.prompt = "Circle a cone in 2nd gear at ~40 km/h, then turn in and give it lots of throttle, or tap the handbrake.";
      this.tip = "Weight transfer helps: a quick lift or a flick of the wheel unloads the rear.";
    } else {
      this.prompt = "Countersteer to hold the angle, and ride the throttle: more throttle, more angle.";
      this.tip = "Too much throttle spins; too little and the drift fades. Small adjustments.";
    }
    if (!c.paved) this.fail("Off the pad. Keep the circle tighter, closer to the cones.", this.spawn());
    else if (Math.abs(c.v.telemetry.sideslip) > 1.6 && !this.flash) this.good("Spun. That's excessive throttle. Try less next time.");
    if (dt >= 4) {
      this.result = "success";
      this.good("Four seconds of controlled drift. You're drifting!");
    }
  }
}

class LinkingLesson extends Lesson {
  title = "Linking Drifts";
  steps = ["Drift around the first circle", "Transition to the other direction", "Link a second transition"];
  padLesson = true;
  scoresDrift = true;
  spawn(): Spawn {
    return { ...padSpawn(this.world, 0.1, 12, 6), gear: 2 };
  }
  update(c: LessonCtx) {
    const n = c.drift.transitions;
    this.progress = Math.min(1, n / 2);
    this.step = Math.min(2, n + (c.drift.active ? 1 : 0) - (n > 0 ? 1 : 0));
    this.prompt = n === 0 ? "Drift around one cone circle, then swing across towards the other." : "Again: let the car rotate through straight and catch it the other way.";
    this.tip = "At the switch, lift briefly and flick the steering: the weight shift swings the tail across.";
    if (!c.paved) this.fail("Off the pad. Stay between the two circles.", this.spawn());
    if (n >= 2) {
      this.result = "success";
      this.good("Linked! That's the heart of a drift run.");
    }
  }
}

export function createLesson(id: string, track: Track, line: RacingLine, world: World): Lesson {
  switch (id) {
    case "steering":
      return new SteeringLesson(track, line, world);
    case "braking":
      return new BrakingLesson(track, line, world);
    case "exits":
      return new ExitLesson(track, line, world);
    case "trail":
      return new TrailLesson(track, line, world);
    case "slides":
      return new SlidesLesson(track, line, world);
    case "drift":
      return new DriftLesson(track, line, world);
    default:
      return new LinkingLesson(track, line, world);
  }
}
