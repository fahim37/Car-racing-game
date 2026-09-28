import { io, Socket } from "socket.io-client";
import { Vehicle } from "../physics/Vehicle";
import { Store } from "../store";

export interface DriverState {
  p: number[];
  q: number[];
  speed: number;
  steer: number;
  brake: number;
  nitro: boolean;
  progress: number;
}
export interface Player {
  id: string;
  name: string;
  carId: string;
  color: string;
  ready: boolean;
  /** Race distance in laps (grows past 1 on multi-lap races). */
  distance: number;
  /** Laps completed. */
  lap: number;
  finishMs: number | null;
}
export interface Room {
  code: string;
  hostId: string;
  phase: "practice" | "countdown" | "racing" | "finished";
  raceId: number;
  laps: number;
  startAt: number;
  serverTime: number;
  players: Player[];
}
export interface Peer extends Player { state: DriverState }
export interface NetworkState {
  id: string;
  room: Room | null;
  status: "offline" | "connecting" | "connected";
  error: string | null;
  peers: Peer[];
}

/** Standings: finishers by time, then everyone else by race distance. */
export function rankPlayers<T extends Pick<Player, "distance" | "finishMs">>(players: T[]) {
  return [...players].sort((a, b) => {
    if (a.finishMs !== null || b.finishMs !== null) return (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity);
    return b.distance - a.distance;
  });
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number) {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}

/** Quick emotes; the last one is the horn. */
export const EMOTES = ["👋", "😂", "🔥", "😎", "📢"];
export const HORN = EMOTES.length - 1;
export const LAP_CHOICES = [1, 3, 5];

export class Multiplayer {
  readonly store = new Store<NetworkState>({ id: "", room: null, status: "offline", error: null, peers: [] });
  /** Called when anyone in the room (including you) sends an emote. */
  onEmote: ((playerId: string, emote: number) => void) | null = null;
  private socket: Socket | null = null;
  private sendTimer = 0;
  private clockOffset = 0;
  private lastRace = 0;
  constructor(private onRace: (room: Room) => void) {}

  get room() { return this.store.get().room; }
  get countdown() { return this.room?.phase === "countdown" ? Math.max(0, (this.room.startAt - Date.now() - this.clockOffset) / 1000) : 0; }

  private request<T>(event: string, data: object): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error("Not connected. Please rejoin the room."));
      this.socket.timeout(8000).emit(event, data, (err: Error | null, reply: T & { error?: string }) => {
        if (err || reply?.error) reject(new Error(reply?.error ?? "The server did not respond. Try again."));
        else resolve(reply);
      });
    });
  }

  async join(name: string, carId: string, code?: string) {
    this.leave();
    this.store.set({ status: "connecting", error: null });
    const socket = io({ path: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/socket.io`, autoConnect: false, reconnection: false, timeout: 8000 });
    this.socket = socket;
    socket.on("room", (room: Room) => {
      this.clockOffset = room.serverTime - Date.now();
      this.store.set({ room });
      if (room.phase === "countdown" && room.raceId > this.lastRace) {
        this.lastRace = room.raceId;
        this.onRace(room);
      }
    });
    socket.on("snapshot", (snapshot: { serverTime: number; players: Peer[] }) => {
      const current = this.store.get();
      if (!current.room) return;
      const players = current.room.players.map((p) => {
        const update = snapshot.players.find((v) => v.id === p.id);
        return update ? { ...p, distance: update.distance, lap: update.lap, finishMs: update.finishMs } : p;
      });
      this.store.set({ peers: snapshot.players.filter((p) => p.id !== current.id), room: { ...current.room, players } });
    });
    socket.on("disconnect", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.store.set({ room: null, peers: [], status: "offline", error: "Connection lost. Open Multiplayer to rejoin with the invitation code." });
    });
    socket.on("room:closed", (error: string) => { this.leave(); this.store.set({ error }); });
    socket.on("emote", (m: { id: string; e: number }) => { if (Number.isInteger(m?.e) && m.e >= 0 && m.e < EMOTES.length) this.onEmote?.(m.id, m.e); });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", () => reject(new Error("Multiplayer is unavailable. Please try again.")));
        socket.connect();
      });
      const result = await this.request<{ room: Room; id: string }>(code ? "room:join" : "room:create", { name, carId, code });
      this.clockOffset = result.room.serverTime - Date.now();
      this.lastRace = result.room.raceId;
      this.store.set({ room: result.room, id: result.id, status: "connected", error: null });
    } catch (error) {
      this.leave();
      const message = error instanceof Error ? error.message : "Could not join this room.";
      this.store.set({ error: message });
      throw new Error(message);
    }
  }

  async ready() { await this.request("player:ready", {}); }
  async startRace(laps = 1) { await this.request("race:start", { laps }); }
  emote(index: number) { this.socket?.emit("player:emote", index); }
  async practice() { await this.request("race:practice", {}); }

  update(dt: number, vehicle: Vehicle | null, progress: number) {
    if (!this.room || !vehicle || !this.socket?.connected) return;
    this.sendTimer += dt;
    if (this.sendTimer < 1 / 20) return;
    this.sendTimer = 0;
    this.socket.volatile.emit("player:state", {
      p: vehicle.pos.toArray(), q: vehicle.quat.toArray(), speed: vehicle.telemetry.speed,
      steer: vehicle.telemetry.steerAngle, brake: vehicle.telemetry.brake, nitro: vehicle.nitro.active, progress,
    } satisfies DriverState);
  }

  leave() {
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect();
    this.lastRace = 0;
    this.store.set({ room: null, peers: [], id: "", status: "offline", error: null });
  }
}
