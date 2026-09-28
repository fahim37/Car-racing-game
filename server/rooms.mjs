import { randomInt } from "node:crypto";
import { Server } from "socket.io";

const CARS = new Set(["meridian", "vela", "brute", "strale", "nocturne", "volterra"]);
const COLORS = ["#f2ad50", "#5ad8ef", "#ef718d", "#91d575", "#bb9afa", "#f4de73", "#69dbc3", "#e6edf3"];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LAP_CHOICES = new Set([1, 3, 5]);
/** Emote indices clients may send (see EMOTES in game/network/Multiplayer.ts). */
const EMOTE_COUNT = 5;

export function createRoomServer(httpServer, { path = "/socket.io", now = Date.now } = {}) {
  const rooms = new Map();
  const io = new Server(httpServer, {
    path, serveClient: false, maxHttpBufferSize: 4096, pingTimeout: 15000,
    // Browsers connect through the same origin (including the /racing reverse proxy).
    allowRequest(req, done) {
      const origin = req.headers.origin;
      if (!origin) return done(null, true);
      try { done(null, new URL(origin).host === req.headers.host); }
      catch { done(null, false); }
    },
  });
  const member = (p) => ({ id: p.id, name: p.name, carId: p.carId, color: p.color, ready: p.ready, distance: p.distance, lap: p.lap, finishMs: p.finishMs });
  const serialize = (r) => ({ code: r.code, hostId: r.hostId, phase: r.phase, raceId: r.raceId, laps: r.laps, startAt: r.startAt, serverTime: now(), players: [...r.players.values()].map(member) });
  const publish = (r) => io.to(r.code).emit("room", serialize(r));
  function leave(socket) {
    const r = rooms.get(socket.data.code);
    if (!r) return;
    r.players.delete(socket.id);
    socket.leave(r.code);
    socket.data.code = null;
    if (!r.players.size) rooms.delete(r.code);
    else {
      if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
      publish(r);
    }
  }
  function addPlayer(socket, r, data) {
    const taken = new Set([...r.players.values()].map((p) => p.color));
    const p = { id: socket.id, name: data.name.trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, 18) || "Driver", carId: CARS.has(data.carId) ? data.carId : "meridian", color: COLORS.find((c) => !taken.has(c)) ?? COLORS[0], ready: false, state: null, lastPacket: 0, lastProgress: null, started: false, checkpoint: 0, distance: 0, lap: 0, finishMs: null, lastEmote: 0 };
    r.players.set(socket.id, p);
    socket.data.code = r.code;
    socket.join(r.code);
    r.activeAt = now();
    return p;
  }
  io.on("connection", (socket) => {
    socket.data.ops = [];
    for (const event of ["room:create", "room:join", "race:start", "race:practice", "player:ready"]) {
      socket.on(event, (data, ack) => {
        if (typeof ack !== "function") return;
        const fail = (error) => ack({ error });
        socket.data.ops = socket.data.ops.filter((t) => now() - t < 60000);
        if (socket.data.ops.length >= 20) return fail("Too many requests. Please wait a moment.");
        socket.data.ops.push(now());
        if (event === "room:create" || event === "room:join") {
          if (!data || typeof data.name !== "string" || !data.name.trim() || data.name.length > 80) return fail("Enter a driver name.");
          let r;
          if (event === "room:create") {
            if (rooms.size >= 100) return fail("All rooms are busy. Please try again shortly.");
            let code;
            do { code = Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join(""); } while (rooms.has(code));
            r = { code, hostId: socket.id, phase: "practice", raceId: 0, laps: 1, startAt: 0, activeAt: now(), players: new Map() };
            rooms.set(code, r);
          } else {
            const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
            r = rooms.get(code);
            if (!r) return fail("Room not found. Check the invitation code.");
            if (r.players.size >= 8) return fail("This room is full (8 drivers).");
            if (r.phase === "racing" || r.phase === "countdown") return fail("This race is in progress. Join after it finishes.");
          }
          leave(socket);
          addPlayer(socket, r, data);
          ack({ room: serialize(r), id: socket.id });
          publish(r);
          return;
        }
        const r = rooms.get(socket.data.code);
        const p = r?.players.get(socket.id);
        if (!r || !p) return fail("Join a room first.");
        if (event === "player:ready") {
          p.ready = true;
        } else {
          if (r.hostId !== socket.id) return fail("Only the host can start or end a race.");
          if (event === "race:start") {
            if (r.phase === "countdown" || r.phase === "racing") return fail("The race has already started.");
            if (r.players.size < 2 || [...r.players.values()].some((v) => !v.ready)) return fail("Wait for at least two drivers to load the track.");
            r.phase = "countdown";
            r.raceId++;
            r.laps = LAP_CHOICES.has(data?.laps) ? data.laps : 1;
            r.startAt = now() + 5000;
            for (const v of r.players.values()) {
              v.started = false; v.checkpoint = 0; v.distance = -0.02; v.lap = 0; v.finishMs = null; v.lastProgress = null;
            }
          } else r.phase = "practice";
        }
        r.activeAt = now();
        ack({ ok: true });
        publish(r);
      });
    }
    socket.on("player:state", (s) => {
      const r = rooms.get(socket.data.code);
      const p = r?.players.get(socket.id);
      const t = now();
      if (!r || !p?.ready || t - p.lastPacket < 35 || !s || typeof s !== "object") return;
      if (!Array.isArray(s.p) || s.p.length !== 3 || !s.p.every((v) => Number.isFinite(v) && Math.abs(v) < 20000)) return;
      if (!Array.isArray(s.q) || s.q.length !== 4 || !s.q.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.01)) return;
      const qLen = Math.hypot(...s.q);
      if (qLen < 0.9 || qLen > 1.1 || ![s.speed, s.steer, s.brake, s.progress].every(Number.isFinite) || s.progress < 0 || s.progress >= 1) return;
      const elapsed = Math.min(2, (t - p.lastPacket) / 1000);
      p.lastPacket = t;
      r.activeAt = t;
      p.state = { p: s.p, q: s.q.map((v) => v / qLen), speed: Math.max(0, Math.min(140, s.speed)), steer: Math.max(-0.8, Math.min(0.8, s.steer)), brake: Math.max(0, Math.min(1, s.brake)), nitro: !!s.nitro, progress: s.progress };
      if (r.phase === "racing" && p.finishMs === null && p.lastProgress !== null) {
        let delta = s.progress - p.lastProgress;
        if (delta < -0.5) delta += 1;
        if (delta > 0.5) delta -= 1;
        if (Math.abs(delta) <= 0.015 + elapsed * 0.05) {
          p.distance += delta;
          const crossed = delta > 0 && p.lastProgress > 0.85 && s.progress < 0.15;
          if (crossed && !p.started) { p.started = true; p.distance = s.progress; }
          else if (crossed && p.started && p.checkpoint === 3 && t - r.startAt > 10000) {
            // A full lap: every quarter of the track passed in order.
            p.lap++;
            p.checkpoint = 0;
            if (p.lap >= r.laps) p.finishMs = t - r.startAt;
          } else if (p.started && p.checkpoint < 3 && p.lastProgress < (p.checkpoint + 1) / 4 && s.progress >= (p.checkpoint + 1) / 4) p.checkpoint++;
        }
      }
      p.lastProgress = s.progress;
    });
    // Quick emotes (and the horn), shared with the room; at most a few per second per driver.
    socket.on("player:emote", (e) => {
      const r = rooms.get(socket.data.code);
      const p = r?.players.get(socket.id);
      const t = now();
      if (!r || !p || !Number.isInteger(e) || e < 0 || e >= EMOTE_COUNT || t - p.lastEmote < 700) return;
      p.lastEmote = t;
      io.to(r.code).emit("emote", { id: socket.id, e });
    });
    socket.on("room:leave", () => leave(socket));
    socket.on("disconnect", () => leave(socket));
  });
  const timer = setInterval(() => {
    const t = now();
    for (const r of rooms.values()) {
      if (t - r.activeAt > 20 * 60 * 1000) {
        io.to(r.code).emit("room:closed", "The room expired after being idle.");
        io.in(r.code).socketsLeave(r.code);
        rooms.delete(r.code);
        continue;
      }
      if (r.phase === "countdown" && t >= r.startAt) { r.phase = "racing"; publish(r); }
      if (r.phase === "racing" && ([...r.players.values()].every((p) => p.finishMs !== null) || t - r.startAt > Math.max(10, 4 + 3 * r.laps) * 60 * 1000)) { r.phase = "finished"; publish(r); }
      io.to(r.code).volatile.emit("snapshot", { serverTime: t, players: [...r.players.values()].filter((p) => p.ready && p.state).map((p) => ({ ...member(p), state: p.state })) });
    }
  }, 1000 / 15);
  timer.unref();
  io.on("close", () => clearInterval(timer));
  return { io, rooms, close: () => { clearInterval(timer); return new Promise((resolve) => io.close(resolve)); } };
}
