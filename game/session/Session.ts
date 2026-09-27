import { Autopilot } from "../ai/Autopilot";
import { CarSpec } from "../physics/carSpecs";
import { Surface } from "../physics/surfaces";
import { DriverControls, Vehicle } from "../physics/Vehicle";
import { EventRecord, Medal, Profile, assistTier } from "../save/profile";
import { RacingLine, lineOffsetAt, lineSpeedAt } from "../track/racingLine";
import { Track } from "../track/Track";
import { World } from "../world/World";
import { LapTrace, analyseLap, Feedback } from "./analysis";
import { DriftScorer, DriftZone, ZoneResult, lakesideZones } from "./DriftScorer";
import { EventDef, medalFor } from "./events";
import { GhostData, GhostRecorder } from "./Ghost";
import { Flash, Lesson, Spawn, createLesson } from "./lessons";

export type Phase = "countdown" | "running" | "finished";

export interface Toast {
  id: number;
  text: string;
  kind: "good" | "bad" | "info" | "sector";
  until: number;
}

export interface LapResult {
  time: number;
  valid: boolean;
  sectors: number[];
}

export interface Results {
  eventId: string;
  eventName: string;
  kind: EventDef["kind"];
  carId: string;
  carName: string;
  className: string;
  tier: string;
  primaryLabel: string;
  primary: number | null;
  lowerBetter: boolean;
  medal: Medal | null;
  newBest: boolean;
  previousBest: number | null;
  targets: [number, number, number] | null;
  laps: LapResult[];
  sectorNames: string[];
  sectorDeltas: (number | null)[];
  bestSectors: number[];
  zones: ZoneResult[];
  feedback: Feedback | null;
  lessonComplete: boolean;
  lessonRetries: number;
  message: string;
  ghost: GhostData | null;
  bestTrace: LapTrace | null;
}

const COUNTDOWN = 3;

export class Session {
  phase: Phase = "countdown";
  countdown = COUNTDOWN;
  time = 0; // running time since GO
  lapTime = 0;
  lap = 0; // completed laps
  laps: LapResult[] = [];
  lapValid = true;
  lapStarted = false;
  bestLap: number | null = null;
  sprintTime = 0;
  toasts: Toast[] = [];
  private toastId = 0;
  readonly drift: DriftScorer;
  readonly lesson: Lesson | null;
  private recorder = new GhostRecorder();
  private lapGhost: GhostData | null = null;
  private bestGhost: GhostData | null = null;
  private trace: LapTrace;
  private traces: LapTrace[] = [];
  private bestTrace: LapTrace | null = null;
  private hint = -1;
  s = 0;
  d = 0;
  private lastS = 0;
  private progress = 0; // metres travelled forward since start of lap / run
  private sectorIndex = -1;
  private sectorStart = 0;
  private sectorTimes: number[] = [];
  private sectorsVisited = new Set<number>();
  private offTime = 0;
  private wrongWay = 0;
  private flipped = 0;
  private waterTime = 0;
  private finishedAt = 0;
  results: Results | null = null;
  readonly autopilot: Autopilot;
  readonly sprintFrom: number;
  readonly sprintTo: number;
  readonly targets: [number, number, number] | null;
  readonly refTime: number;
  private pbSplits: number[] | null;
  private pbSectors: number[] | null;
  readonly heldControls: DriverControls = { throttle: 0, brake: 1, steer: 0, handbrake: 1, shiftUp: false, shiftDown: false, digitalSteer: false, digitalPedals: false };
  private masteryWindow: number | null = null;
  lastDelta: number | null = null;
  resets = 0;

  constructor(
    readonly event: EventDef,
    readonly car: CarSpec,
    readonly vehicle: Vehicle,
    readonly world: World,
    readonly line: RacingLine,
    readonly profile: Profile,
    readonly record: EventRecord | null,
    readonly pbGhost: GhostData | null,
  ) {
    const track = world.track;
    this.trace = new LapTrace(track.length);
    this.autopilot = new Autopilot(vehicle, line, 0.72);
    // Point-to-point stations
    const st = sprintStations(event, track);
    this.sprintFrom = st.from;
    this.sprintTo = st.to;
    // Reference time and medal targets for this car and conditions.
    const tg = computeTargets(event, line, track);
    this.refTime = tg.refTime;
    this.targets = tg.targets;
    this.pbSplits = record?.lap?.splits ?? null;
    this.pbSectors = record?.lap?.sectors ?? null;

    const zones: DriftZone[] = event.kind === "drift" ? lakesideZones(track) : [];
    this.lesson = event.lesson ? createLesson(event.lesson, track, line, world) : null;
    this.drift = new DriftScorer(track, zones, event.kind === "drift");
    if (event.kind === "timeTrial" || event.kind === "mastery" || event.kind === "free" || event.kind === "lesson") {
      this.countdown = 0;
      this.phase = "running";
    }
  }

  get kind() {
    return this.event.kind;
  }

  get lowerBetter() {
    return this.event.kind !== "drift";
  }

  get totalLaps() {
    return this.event.laps ?? 0;
  }

  /** Where the car starts for this event. */
  spawn(): Spawn {
    const track = this.world.track;
    switch (this.event.kind) {
      case "lesson":
        return this.lesson!.spawn();
      case "timeTrial":
      case "mastery": {
        // On the final straight, after the Jetty Corner, with a run-up to the line.
        const last = track.corners[track.corners.length - 1];
        const s = last.sEnd + 12;
        return { s, d: lineOffsetAt(this.line, s, track.length) * 0.5, speed: 0 };
      }
      case "sprint":
      case "drift":
        return { s: this.sprintFrom, d: 0, speed: 0 };
      default:
        return { s: track.length - 35, d: -2, speed: 0 };
    }
  }

  toast(text: string, kind: Toast["kind"] = "info", seconds = 2.6) {
    if (this.toasts.some((toast) => toast.text === text && toast.kind === kind && toast.until > this.time)) return;
    this.toasts.push({ id: ++this.toastId, text, kind, until: this.time + seconds });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  /** Controls to feed the car this step (player input, held during countdown, autopilot after). */
  controls(player: DriverControls, dt: number): DriverControls {
    if (this.phase === "countdown") return this.heldControls;
    if (this.phase === "finished" && this.event.kind !== "free") return this.autopilot.update(dt);
    return player;
  }

  onReset() {
    this.resets++;
    if (this.lapStarted) {
      if (this.lapValid) this.toast("Lap invalidated by reset", "bad");
      this.lapValid = false;
    }
    this.drift.combo = 0;
    this.drift.active = false;
  }

  /** Per physics step. Returns a spawn request when the car must be repositioned. */
  step(dt: number): Spawn | "reset" | null {
    const v = this.vehicle;
    const track = this.world.track;
    const p = track.project(v.pos.x, v.pos.z, this.hint);
    this.hint = p.i;
    this.lastS = this.s;
    this.s = p.s;
    this.d = p.d;

    if (this.phase === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = "running";
        this.toast("Go!", "good", 1.2);
        if (this.event.kind === "sprint" || this.event.kind === "drift") {
          this.recorder.start();
          this.lapStarted = true;
        }
      }
      return null;
    }

    this.time += dt;
    this.toasts = this.toasts.filter((t) => t.until > this.time);
    const t = v.telemetry;
    const ds = track.delta(this.lastS, this.s);
    const paved = v.wheels.some((w) => w.contact && (w.onRoad || w.surface === Surface.Asphalt));
    const offRoad = t.wheelsOnGround > 0 && !paved;
    const contact = v.stepsSinceContact < 2;

    // Safety: water, rollover.
    this.waterTime = t.inWater ? this.waterTime + dt : 0;
    this.flipped = t.upright < 0.35 ? this.flipped + dt : 0;
    if (this.waterTime > 1.2 || this.flipped > 2.5) {
      this.toast(this.waterTime > 1.2 ? "Into the lake. Resetting on the road" : "Rolled over. Resetting on the road", "bad");
      this.waterTime = 0;
      this.flipped = 0;
      return "reset";
    }

    // Wrong way warning.
    if (ds < -0.02 && t.speed > 5 && this.event.kind !== "lesson") this.wrongWay += dt;
    else this.wrongWay = Math.max(0, this.wrongWay - dt * 2);
    if (this.wrongWay > 2.5 && this.event.kind !== "free") {
      this.toast("Wrong way", "bad", 1.5);
      this.wrongWay = 1;
    }

    // Impacts become incidents (and hints).
    for (const imp of v.impacts) {
      if (imp.speed > 3 && this.phase === "running") {
        if (this.lapStarted) this.trace.incidents.push({ s: this.s, kind: `Contact with a ${imp.kind === "rail" ? "guardrail" : imp.kind} near ${this.placeName(this.s)}.` });
      }
    }

    if (this.phase === "finished") {
      this.finishedAt += dt;
      return null;
    }

    // Drift scoring (drift events, pad lessons and free drive).
    if (this.event.kind === "drift" || this.event.kind === "free" || this.lesson?.scoresDrift) {
      this.drift.update(dt, v, this.s, this.d, paved && !offRoad);
      for (const e of this.drift.events) {
        if (e.kind === "banked" && e.points > 50) this.toast(`+${e.points.toLocaleString()}${e.clean ? "  clean exit" : ""}`, "good", 1.8);
        else if (e.kind === "lost") this.toast(`${e.reason}. Combo lost`, "bad", 1.8);
        else if (e.kind === "transition") this.toast("Transition ×1.2", "good", 1.2);
        else if (e.kind === "clip") this.toast("Apex clipped +350", "good", 1.2);
        else if (e.kind === "zone" && e.zone.score > 0) this.toast(`${e.zone.name}: ${e.zone.score.toLocaleString()} (${e.zone.grade})`, "sector", 2.8);
      }
      this.drift.events.length = 0;
    }

    if (this.lesson) return this.stepLesson(dt, paved, offRoad, contact);

    switch (this.event.kind) {
      case "timeTrial":
      case "mastery":
        this.stepLaps(dt, ds, offRoad);
        break;
      case "sprint":
      case "drift":
        this.stepSprint(dt, ds, offRoad);
        break;
      default:
        break;
    }
    return null;
  }

  private placeName(s: number) {
    const c = this.world.track.cornerAt(s, 60);
    return c ? `${c.name} (${c.short})` : "the straight";
  }

  private recordTrace(offRoad: boolean) {
    const t = this.vehicle.telemetry;
    this.trace.record(this.s, this.lapTime, t.speed, t.brake, t.throttle, Math.abs(t.sideslip), offRoad, t.tcActive);
  }

  private trackLimits(dt: number, offRoad: boolean) {
    if (offRoad) this.offTime += dt;
    else this.offTime = 0;
    if (this.offTime > 0.6 && this.lapValid && this.lapStarted) {
      this.lapValid = false;
      this.trace.incidents.push({ s: this.s, kind: `Off the road at ${this.placeName(this.s)}.` });
      if (this.event.kind !== "drift") this.toast("Off the road: lap invalid", "bad");
    }
  }

  private stepLaps(dt: number, ds: number, offRoad: boolean) {
    const track = this.world.track;
    const L = track.length;
    const crossed = this.lastS > L - 80 && this.s < 80 && ds > 0;
    if (crossed) {
      // Sub-step accuracy: time since the actual line crossing.
      const frac = ds > 0 ? this.s / ds : 0;
      const over = dt * Math.min(1, Math.max(0, frac));
      if (this.lapStarted) this.completeLap(this.lapTime + dt - over);
      if (this.phase === "running") this.startLap(over);
      return;
    }
    if (!this.lapStarted) return;
    this.lapTime += dt;
    this.recorder.sample(dt, this.vehicle);
    this.recordTrace(offRoad);
    this.trackLimits(dt, offRoad);
    // Sectors
    const sec = track.sectorAt(this.s);
    if (sec !== this.sectorIndex && ds > 0) {
      if (sec === this.sectorIndex + 1) {
        const time = this.lapTime - this.sectorStart;
        this.sectorTimes[this.sectorIndex] = time;
        this.sectorFlash(this.sectorIndex, time);
        this.sectorStart = this.lapTime;
        this.sectorsVisited.add(sec);
      }
      this.sectorIndex = sec;
    }
    // Live delta against the personal-best lap.
    if (this.pbSplits) {
      const k = Math.floor(this.s / 10);
      const ref = this.pbSplits[k];
      if (ref !== undefined && ref >= 0) this.lastDelta = this.lapTime - ref;
    } else if (this.bestTrace) {
      this.lastDelta = this.lapTime - this.bestTrace.timeAt(this.s);
    }
  }

  private sectorFlash(i: number, time: number) {
    const pb = this.pbSectors?.[i];
    const name = this.world.track.sectors[i]?.name ?? `Sector ${i + 1}`;
    if (pb) {
      const d = time - pb;
      this.toast(`${name}  ${time.toFixed(2)}  (${d <= 0 ? "" : "+"}${d.toFixed(2)})`, d <= 0 ? "good" : "sector", 2.4);
    } else this.toast(`${name}  ${time.toFixed(2)}`, "sector", 2.2);
  }

  private startLap(over: number) {
    this.lapStarted = true;
    this.lapTime = over;
    this.lapValid = true;
    this.offTime = 0;
    this.sectorIndex = 0;
    this.sectorStart = 0;
    this.sectorTimes = [];
    this.sectorsVisited = new Set([0]);
    this.trace = new LapTrace(this.world.track.length);
    this.recorder.start();
    this.lastDelta = null;
  }

  private completeLap(time: number) {
    const track = this.world.track;
    const lastSector = track.sectors.length - 1;
    this.sectorTimes[lastSector] = time - this.sectorStart;
    const allSectors = this.sectorsVisited.size >= track.sectors.length;
    const valid = this.lapValid && allSectors;
    this.trace.time[this.trace.n - 1] = time;
    this.lap++;
    this.laps.push({ time, valid, sectors: [...this.sectorTimes] });
    this.traces.push(this.trace);
    const ghost = this.recorder.finish();
    this.lapGhost = ghost;
    if (valid && (this.bestLap === null || time < this.bestLap)) {
      const improved = this.bestLap !== null;
      this.bestLap = time;
      this.bestGhost = ghost;
      this.bestTrace = this.trace;
      const beatPb = this.record?.lap && time < this.record.lap.time;
      this.toast(`Lap ${this.lap}: ${fmt(time)}${beatPb ? "  New personal best!" : improved ? "  Session best" : ""}`, "good", 3.2);
    } else {
      this.toast(`Lap ${this.lap}: ${fmt(time)}${valid ? "" : "  (invalid)"}`, valid ? "info" : "bad", 3);
    }
    if (this.event.kind === "mastery") {
      this.masteryWindow = masteryScore(this.laps);
      if (this.masteryWindow !== null && this.targets && this.masteryWindow <= this.targets[2]) {
        this.finish("Mastery achieved.");
        return;
      }
    }
    if (this.lap >= this.totalLaps) this.finish();
  }

  private stepSprint(dt: number, ds: number, offRoad: boolean) {
    const track = this.world.track;
    this.sprintTime += dt;
    this.lapTime = this.sprintTime;
    this.recorder.sample(dt, this.vehicle);
    this.recordTrace(offRoad);
    this.trackLimits(dt, offRoad);
    if (ds > 0) this.progress += ds;
    const total = track.delta(this.sprintFrom, this.sprintTo) > 0 ? track.delta(this.sprintFrom, this.sprintTo) : track.delta(this.sprintFrom, this.sprintTo) + track.length;
    if (this.pbSplits) {
      const ref = this.pbSplits[Math.floor(this.s / 10)];
      if (ref !== undefined && ref >= 0) this.lastDelta = this.sprintTime - ref;
    }
    if (this.progress >= total - 0.5 || (this.progress > total * 0.8 && Math.abs(track.delta(this.sprintTo, this.s)) < 3)) {
      this.laps.push({ time: this.sprintTime, valid: this.lapValid, sectors: [] });
      this.traces.push(this.trace);
      this.bestTrace = this.trace;
      this.bestGhost = this.recorder.finish();
      if (this.lapValid || this.event.kind === "drift") this.bestLap = this.sprintTime;
      this.drift.finish();
      this.finish();
    }
  }

  private stepLesson(dt: number, paved: boolean, offRoad: boolean, contact: boolean): Spawn | null {
    const l = this.lesson!;
    const v = this.vehicle;
    l.flash = null;
    l.update({
      v,
      track: this.world.track,
      world: this.world,
      line: this.line,
      s: this.s,
      d: this.d,
      kmh: v.telemetry.speed * 3.6,
      offRoad,
      paved,
      contact,
      drift: this.drift,
      dt,
    });
    const flash = l.flash as Flash | null;
    if (flash) this.toast(flash.text, flash.good ? "good" : "bad", flash.good ? 2.6 : 3.6);
    if (l.result === "success") {
      this.finish(flash?.text ?? "Lesson complete.");
      return null;
    }
    if (l.respawn) {
      const sp = l.respawn;
      l.respawn = null;
      if (l.padLesson) this.drift.combo = 0;
      return sp;
    }
    return null;
  }

  finish(message = "") {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.finishedAt = 0;
    this.results = this.buildResults(message);
  }

  /** Seconds since the finish (UI shows results after a short beat). */
  get sinceFinish() {
    return this.phase === "finished" ? this.finishedAt : 0;
  }

  private buildResults(message: string): Results {
    const ev = this.event;
    const track = this.world.track;
    let primary: number | null = null;
    let label = "Best lap";
    if (ev.kind === "timeTrial") primary = this.bestLap;
    else if (ev.kind === "mastery") {
      primary = masteryScore(this.laps);
      label = "Slowest of best 3-lap streak";
    } else if (ev.kind === "sprint") {
      primary = this.laps[0]?.valid ? this.laps[0].time : null;
      label = "Time";
    } else if (ev.kind === "drift") {
      primary = this.drift.total;
      label = "Drift score";
    } else if (ev.kind === "lesson") label = "Lesson";
    const medal = primary !== null && this.targets ? medalFor(ev, primary, this.targets) : null;
    const prev = this.record?.best ?? null;
    const newBest = primary !== null && (prev === null || (this.lowerBetter ? primary < prev : primary > prev));
    const bestLapIdx = this.laps.findIndex((l) => l.valid && l.time === this.bestLap);
    const bestSectors = bestLapIdx >= 0 ? this.laps[bestLapIdx].sectors : [];
    const sectorDeltas = bestSectors.map((t, i) => (this.pbSectors?.[i] ? t - this.pbSectors[i] : null));
    const feedbackTrace = this.bestTrace ?? this.traces[this.traces.length - 1] ?? null;
    let feedback: Feedback | null = null;
    if (feedbackTrace && (ev.kind === "timeTrial" || ev.kind === "mastery" || ev.kind === "sprint")) {
      feedback = analyseLap(feedbackTrace, track, this.line, 0.97, this.traces);
    } else if (ev.kind === "drift") {
      const zones = [...this.drift.zoneScores.values()];
      const weakest = zones.sort((a, b) => a.score - b.score)[0];
      feedback = {
        headline: this.drift.total > (this.targets?.[1] ?? 0) ? "Committed and controlled. Great run." : "Good control. More angle and speed through each zone will lift the score.",
        suggestions: [
          weakest ? `${weakest.name} was your weakest zone (${weakest.score.toLocaleString()}). Carry more entry speed and initiate earlier, before the turn-in point.` : "Initiate earlier so the slide is established as you enter each zone.",
          "Hold the angle with the throttle rather than the steering, and straighten smoothly for the clean-exit bonus.",
        ],
        strengths: this.drift.transitions > 0 ? [`${this.drift.transitions} transition${this.drift.transitions > 1 ? "s" : ""} linked.`] : [],
        incidents: this.traces[0]?.incidents.map((i) => i.kind).slice(0, 4) ?? [],
        corners: [],
      };
    }
    return {
      eventId: ev.id,
      eventName: ev.name,
      kind: ev.kind,
      carId: this.car.id,
      carName: this.car.name,
      className: this.car.className,
      tier: assistTier(this.vehicle.assists),
      primaryLabel: label,
      primary,
      lowerBetter: this.lowerBetter,
      medal,
      newBest,
      previousBest: prev,
      targets: this.targets,
      laps: this.laps,
      sectorNames: track.sectors.map((s) => s.name),
      sectorDeltas,
      bestSectors,
      zones: [...this.drift.zoneScores.values()],
      feedback,
      lessonComplete: this.lesson?.result === "success",
      lessonRetries: this.lesson?.retries ?? 0,
      message,
      ghost: this.bestGhost,
      bestTrace: this.bestTrace,
    };
  }

  /** Time since the current lap/run began, for ghost playback. */
  get ghostTime() {
    return this.lapStarted ? this.lapTime : -1;
  }

  /** Where the next corner is and how fast the reference takes it (learning overlay). */
  nextCornerInfo() {
    const track = this.world.track;
    const { corner, dist } = track.nextCorner(this.s);
    const flat = track.layout.some((l) => l.kind === "turn" && l.short === corner.short && l.flat);
    let minV = Infinity;
    for (let x = corner.sStart; x <= corner.sEnd; x += 3) minV = Math.min(minV, lineSpeedAt(this.line, x, track.length));
    return { name: corner.name, short: corner.short, dist, kmh: Math.round(minV * 3.6 * 0.97), flat, dir: corner.dir };
  }

  /** Position helpers for the minimap. */
  get ghostData() {
    return this.pbGhost ?? this.bestGhost;
  }
}

/** Best (lowest) "slowest lap" over any window of three consecutive valid laps. */
function masteryScore(laps: LapResult[]): number | null {
  let best: number | null = null;
  for (let i = 0; i + 2 < laps.length; i++) {
    const w = laps.slice(i, i + 3);
    if (!w.every((l) => l.valid)) continue;
    const worst = Math.max(...w.map((l) => l.time));
    if (best === null || worst < best) best = worst;
  }
  return best;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}


/** Start/finish stations of a point-to-point event. */
export function sprintStations(event: EventDef, track: Track) {
  if (!event.sprint) return { from: 0, to: 0 };
  const from = track.corners.find((c) => c.short === event.sprint!.from)!;
  const to = track.corners.find((c) => c.short === event.sprint!.to)!;
  return {
    from: track.wrap((event.sprint.fromOffset >= 0 ? from.sEnd : from.sStart) + event.sprint.fromOffset),
    to: track.wrap((event.sprint.toOffset >= 0 ? to.sEnd : to.sStart) + event.sprint.toOffset),
  };
}

/** Reference time (fastest the tyres allow, from the speed profile) and medal targets. */
export function computeTargets(event: EventDef, line: RacingLine, track: Track): { refTime: number; targets: [number, number, number] | null } {
  let refTime = line.lapTime;
  if (event.kind === "sprint") {
    const st = sprintStations(event, track);
    let len = track.delta(st.from, st.to);
    if (len <= 0) len += track.length;
    let t = 0;
    for (let x = 0; x < len; x += 2) t += 2 / Math.max(3, lineSpeedAt(line, st.from + x, track.length));
    refTime = t + 2.2; // standing start
  }
  const targets = event.targetFactors
    ? (event.targetFactors.map((f) => Math.round(refTime * f * 10) / 10) as [number, number, number])
    : event.scoreTargets ?? null;
  return { refTime, targets };
}
