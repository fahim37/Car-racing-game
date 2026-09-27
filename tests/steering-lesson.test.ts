import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../game/session/Session";
import { createLesson, LessonCtx, Spawn } from "../game/session/lessons";
import { Track } from "../game/track/Track";
import { RacingLine } from "../game/track/racingLine";
import { World } from "../game/world/World";

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
