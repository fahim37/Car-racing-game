import assert from "node:assert/strict";
import test from "node:test";
import { Nitro } from "../game/physics/Nitro";
import { Vehicle, PHYSICS_DT } from "../game/physics/Vehicle";
import { carById } from "../game/physics/carSpecs";
import { Surface } from "../game/physics/surfaces";
import { World } from "../game/world/World";

test("nitro depletes, cannot pulse on an empty tank, and recharges after release", () => {
  const nitro = new Nitro();
  nitro.enabled = true;
  for (let i = 0; i < 301; i++) nitro.step(1 / 60, true, true);
  assert.equal(nitro.charge, 0);
  for (let i = 0; i < 300; i++) assert.equal(nitro.step(1 / 60, true, true), false);
  assert.ok(nitro.charge > 0.15);
  nitro.step(1 / 60, false, true);
  assert.equal(nitro.step(1 / 60, true, true), true);
  nitro.enabled = false;
  assert.equal(nitro.step(1 / 60, true, true), false);
});

test("a nitro gate refill tops up the tank and re-arms an emptied one", () => {
  const nitro = new Nitro();
  nitro.enabled = true;
  for (let i = 0; i < 301; i++) nitro.step(1 / 60, true, true);
  assert.equal(nitro.ready, false);
  nitro.refill(0.4);
  assert.ok(Math.abs(nitro.charge - 0.4) < 1e-9);
  assert.equal(nitro.ready, true);
  assert.equal(nitro.step(1 / 60, true, true), true);
  nitro.refill(5);
  assert.equal(nitro.charge, 1);
});

test("nitro increases real acceleration without boosting in reverse or under braking", () => {
  const world = {
    track: { length: 100000, project: () => ({ s: 0, d: 0, i: 0 }), frameAt: () => ({ x: 0, y: 10, z: 0, nx: 1, nz: 0, tx: 0, tz: 1, halfWidth: 100000, bank: 0 }), railAt: () => null },
    ground(_x: number, _z: number, _hint: number, out: object) { return Object.assign(out, { y: 10, nx: 0, ny: 1, nz: 0, surface: Surface.Asphalt, s: 0, d: 0, onRoad: true, hint: 0 }); },
    collidersNear(_x: number, _z: number, _r: number, out: unknown[]) { out.length = 0; return out; },
    extent: { x0: -100000, x1: 100000, z0: -100000, z1: 100000 },
  } as unknown as World;
  const run = (boost: boolean) => {
    const v = new Vehicle(carById("meridian"), world);
    v.nitro.enabled = true;
    v.reset(0, 0, 0, 25);
    const controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: boost, shiftUp: false, shiftDown: false, digitalSteer: false, digitalPedals: false };
    for (let i = 0; i < 720; i++) v.step(controls, PHYSICS_DT);
    return { v, controls };
  };
  const normal = run(false);
  const boosted = run(true);
  assert.ok(boosted.v.telemetry.speed > normal.v.telemetry.speed + 1);
  // The nitro button alone is enough: it floors the throttle as well.
  const solo = new Vehicle(carById("meridian"), world);
  solo.nitro.enabled = true;
  solo.reset(0, 0, 0, 25);
  for (let i = 0; i < 720; i++) solo.step({ ...boosted.controls, throttle: 0 }, PHYSICS_DT);
  assert.ok(solo.telemetry.speed > normal.v.telemetry.speed + 1);
  boosted.v.step({ ...boosted.controls, brake: 1 });
  assert.equal(boosted.v.nitro.active, false);
  boosted.v.gear = -1;
  boosted.v.step({ ...boosted.controls, throttle: 0, brake: 1 });
  assert.equal(boosted.v.nitro.active, false);
});
