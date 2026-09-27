import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../game/session/Session";
import { createLesson, LessonCtx, Spawn } from "../game/session/lessons";
import { Track } from "../game/track/Track";
import { RacingLine } from "../game/track/racingLine";
import { World } from "../game/world/World";
import { carById } from "../game/physics/carSpecs";
import { Vehicle } from "../game/physics/Vehicle";
import { Surface } from "../game/physics/surfaces";
import { eventById } from "../game/session/events";
import { loadProfile } from "../game/save/profile";
import { computeRacingLine } from "../game/track/racingLine";

test("Smooth Hands leaves room to stop and retries before the target", () => {
  const track = new Track();
  const t1 = track.corners.find((corner) => corner.short === "T1")!;
  const t2 = track.corners.find((corner) => corner.short === "T2")!;
  const target = t2.sStart - 50;
  const lesson = createLesson("steering", track, {} as RacingLine, {} as World);
  const context = (s: number, kmh: number): LessonCtx => ({ s, kmh, offRoad: false, track } as LessonCtx);

  lesson.step = 2;
  lesson.update(context(t1.sEnd + 20, 70));
  assert.equal(lesson.respawn, null);
  assert.ok(target - (t1.sEnd + 20) >= 100);

  lesson.update(context(target + 3, 70));
  const retry = lesson.respawn as Spawn | null;
  assert.ok(retry);
  assert.ok(target - retry.s >= 100);

  lesson.respawn = null;
  lesson.update(context(retry.s, retry.speed * 3.6));
  assert.equal(lesson.respawn, null);

  lesson.update(context(target - 5, 0));
  assert.equal(lesson.result, "success");
});

test("an active failure toast is not stacked twice", () => {
  const state = { toasts: [], time: 0, toastId: 0 } as unknown as Session;
  Session.prototype.toast.call(state, "same failure", "bad");
  Session.prototype.toast.call(state, "same failure", "bad");
  assert.equal(state.toasts.length, 1);
});

function sessionFixture() {
  const track = new Track();
  const world = { track } as World;
  const car = carById("meridian");
  const vehicle = new Vehicle(car, world);
  const line = computeRacingLine(track, car);
  const session = new Session(eventById("lesson-steering"), car, vehicle, world, line, loadProfile(), null, null);
  const place = (s: number, offRoad: boolean) => {
    const f = track.frameAt(s);
    const d = offRoad ? f.halfWidth + 8 : 0;
    vehicle.pos.set(f.x + f.nx * d, f.y + 1, f.z + f.nz * d);
    vehicle.telemetry.speed = 20;
    for (const wheel of vehicle.wheels) {
      wheel.contact = true;
      wheel.onRoad = !offRoad;
      wheel.surface = offRoad ? Surface.Grass : Surface.Asphalt;
    }
  };
  return { track, vehicle, session, place };
}

test("four wheels off-road never request a teleport, and rejoining resumes the lesson", () => {
  const { session, place } = sessionFixture();
  session.lesson!.step = 1;
  place(300, true);
  for (let i = 0; i < 240; i++) assert.equal(session.step(1 / 60), null);
  assert.equal(session.lesson!.retries, 0);
  assert.equal(session.lesson!.step, 1);
  assert.equal(session.lessonRetry, null);
  assert.match(session.lesson!.prompt, /Off the road/);
  place(300, false);
  session.step(1 / 60);
  assert.match(session.lesson!.prompt, /Follow the green line/);
});

test("a failed braking target waits for an explicit retry", () => {
  const { track, session, place } = sessionFixture();
  const target = track.corners.find((corner) => corner.short === "T2")!.sStart - 50;
  session.lesson!.step = 2;
  place(target + 8, false);
  assert.equal(session.step(1 / 60), null);
  assert.ok(session.lessonRetry);
  for (let i = 0; i < 120; i++) assert.equal(session.step(1 / 60), null);
  assert.equal(session.lesson!.retries, 1);
  const retry = session.retryLesson();
  assert.ok(retry && track.delta(retry.s, target) > 90);
  assert.equal(session.lessonRetry, null);
});

test("safety recovery ignores a moving rollover and water flags on paved road", () => {
  const { session, vehicle, place } = sessionFixture();
  place(300, false);
  vehicle.telemetry.inWater = true;
  vehicle.telemetry.upright = 0;
  for (let i = 0; i < 240; i++) assert.equal(session.step(1 / 60), null);
  vehicle.telemetry.inWater = false;
  vehicle.telemetry.speed = 0;
  let recovered = false;
  for (let i = 0; i < 180; i++) recovered ||= session.step(1 / 60) === "reset";
  assert.equal(recovered, true);
});
