import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import { createRoomServer } from "../server/rooms.mjs";

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out: ${name}`)); }, 4000);
    const listener = (data) => { if (predicate(data)) { clearTimeout(timer); socket.off(name, listener); resolve(data); } };
    socket.on(name, listener);
  });
}
const request = (socket, name, data = {}) => new Promise((resolve, reject) => {
  socket.timeout(3000).emit(name, data, (error, reply) => error ? reject(error) : resolve(reply));
});

test("invite rooms isolate drivers, validate races, transfer hosts, and clean up", async (t) => {
  let clock = Date.now();
  const http = createServer();
  const server = createRoomServer(http, { path: "/racing/socket.io", now: () => clock });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.disconnect()); await server.close(); });
  const connect = async () => {
    const socket = io(url, { path: "/racing/socket.io", transports: ["websocket"], autoConnect: false, reconnection: false });
    sockets.push(socket);
    const ready = event(socket, "connect"); socket.connect(); await ready;
    return socket;
  };
  const host = await connect();
  const guest = await connect();
  const outsider = await connect();
  const created = await request(host, "room:create", { name: "Host", carId: "meridian" });
  assert.match(created.room.code, /^[A-Z2-9]{6}$/);
  const invalid = await request(guest, "room:join", { code: "XXXXXX", name: "Guest" });
  assert.ok(invalid.error);
  const joined = await request(guest, "room:join", { code: created.room.code.toLowerCase(), name: "Guest", carId: "vela" });
  assert.equal(joined.room.players.length, 2);
  const separate = await request(outsider, "room:create", { name: "Other" });
  assert.notEqual(separate.room.code, created.room.code);
  assert.ok((await request(guest, "race:start")).error);
  assert.ok((await request(host, "race:start")).error);
  await request(host, "player:ready"); await request(guest, "player:ready"); await request(outsider, "player:ready");

  const sample = (progress) => ({ p: [10, 10, 10], q: [0, 0, 0, 1], speed: 25, steer: 0, brake: 0, nitro: true, progress });
  const received = event(guest, "snapshot", (s) => s.players.some((p) => p.id === host.id));
  host.emit("player:state", sample(0.99));
  const snapshot = await received;
  assert.equal(snapshot.players[0].state.nitro, true);
  const isolated = await event(outsider, "snapshot");
  assert.equal(isolated.players.length, 0);
  clock += 100;
  host.emit("player:state", { ...sample(0.5), p: [NaN, 0, 0] });
  const safe = await event(guest, "snapshot");
  assert.equal(safe.players[0].state.progress, 0.99);

  assert.ok((await request(host, "race:start")).ok);
  assert.ok((await request(outsider, "room:join", { code: created.room.code, name: "Late" })).error);
  const go = event(guest, "room", (r) => r.phase === "racing");
  clock += 6000; await go;
  for (const progress of [0.995, 0.005, 0.1, 0.2, 0.26, 0.36, 0.46, 0.51, 0.61, 0.71, 0.76, 0.86, 0.96, 0.995, 0.005]) {
    clock += 2000;
    const tick = event(guest, "snapshot", (s) => s.players.some((p) => p.id === host.id && p.state.progress === progress));
    host.emit("player:state", sample(progress)); await tick;
  }
  const finished = server.rooms.get(created.room.code).players.get(host.id);
  assert.ok(finished.finishMs > 10000);
  assert.equal(server.rooms.get(created.room.code).players.get(guest.id).finishMs, null);
  const transfer = event(guest, "room", (r) => r.hostId === guest.id);
  host.disconnect(); await transfer;
  assert.ok((await request(guest, "race:practice")).ok);
  guest.disconnect(); outsider.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.rooms.size, 0);
});

test("hosts pick the race length, laps are counted, and emotes reach the room", async (t) => {
  let clock = Date.now();
  const http = createServer();
  const server = createRoomServer(http, { path: "/racing/socket.io", now: () => clock });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.disconnect()); await server.close(); });
  const connect = async () => {
    const socket = io(url, { path: "/racing/socket.io", transports: ["websocket"], autoConnect: false, reconnection: false });
    sockets.push(socket);
    const ready = event(socket, "connect"); socket.connect(); await ready;
    return socket;
  };
  const host = await connect();
  const guest = await connect();
  const { room } = await request(host, "room:create", { name: "Host", carId: "brute" });
  await request(guest, "room:join", { code: room.code, name: "Guest" });
  await request(host, "player:ready"); await request(guest, "player:ready");

  const emote = event(guest, "emote");
  host.emit("player:emote", 2);
  assert.deepEqual(await emote, { id: host.id, e: 2 });
  host.emit("player:emote", 99); // out of range: ignored
  host.emit("player:emote", 1); // too soon after the last one: ignored
  await request(host, "player:ready"); // acknowledged, so the server has handled the emotes above
  clock += 800;
  const next = event(guest, "emote");
  host.emit("player:emote", 4);
  assert.equal((await next).e, 4);

  const counted = event(guest, "room", (r) => r.phase === "countdown");
  assert.ok((await request(host, "race:start", { laps: 3 })).ok);
  assert.equal((await counted).laps, 3);
  const go = event(guest, "room", (r) => r.phase === "racing");
  clock += 6000; await go;
  const sample = (progress) => ({ p: [10, 10, 10], q: [0, 0, 0, 1], speed: 25, steer: 0, brake: 0, nitro: false, progress });
  const lap = [0.1, 0.2, 0.26, 0.36, 0.46, 0.51, 0.61, 0.71, 0.76, 0.86, 0.96, 0.995, 0.005];
  const drive = async (progresses) => {
    for (const progress of progresses) {
      clock += 2000;
      const tick = event(guest, "snapshot", (s) => s.players.some((p) => p.id === host.id && p.state.progress === progress));
      host.emit("player:state", sample(progress)); await tick;
    }
  };
  await drive([0.995, 0.005, ...lap]);
  const me = () => server.rooms.get(room.code).players.get(host.id);
  assert.equal(me().lap, 1);
  assert.equal(me().finishMs, null);
  await drive([...lap, ...lap]);
  assert.equal(me().lap, 3);
  assert.ok(me().finishMs > 10000);
  assert.ok(me().distance > 2.9);
});
