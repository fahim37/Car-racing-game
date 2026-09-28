"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Game } from "@/game/Game";
import { EMOTES, HORN, LAP_CHOICES, ordinal, rankPlayers } from "@/game/network/Multiplayer";
import { CARS } from "@/game/physics/carSpecs";
import { isCarUnlocked } from "@/game/session/events";
import { fmtTime, useTicker } from "./common";

export function MultiplayerLobby({ game }: { game: Game }) {
  const network = useSyncExternalStore(game.multiplayer.store.subscribe, game.multiplayer.store.get, game.multiplayer.store.get);
  const [name, setName] = useState(() => { try { return localStorage.getItem("larchmere.driverName") ?? "Driver"; } catch { return "Driver"; } });
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("room")?.toUpperCase().slice(0, 6) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const join = async (host: boolean) => {
    if (busy) return;
    if (!host && code.trim().length !== 6) { setError("Enter the six-character invitation code."); return; }
    setBusy(true); setError("");
    try {
      await game.joinMultiplayer(name.trim(), host ? undefined : code.trim());
      try { localStorage.setItem("larchmere.driverName", name.trim()); } catch { /* optional preference */ }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not join the room."); }
    finally { setBusy(false); }
  };
  return <div className="screen multiplayer-screen">
    <div className="screen-head">
      <button className="btn" disabled={busy} onClick={() => game.go("title")} aria-label="Back">←</button>
      <h2>Multiplayer</h2>
      <span className="muted">2–8 drivers</span>
    </div>
    <div className="screen-body">
      <div className="panel multiplayer-card">
        <div className="eyebrow">Your road. Your friends.</div>
        <h2>Meet on the starting grid.</h2>
        <p className="muted">Create a private room and share its code, or enter a friend’s invitation. Cruise together, then race 1, 3 or 5 laps: trade paint, hide in a rival’s slipstream to charge your nitro, and grab the nitro gates.</p>
        <label>Driver name<input maxLength={18} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" disabled={busy} /></label>
        <label>Car<select value={game.store.get().carId} disabled={busy} onChange={(e) => { void game.selectCar(e.target.value); }}>
          {CARS.filter((c) => isCarUnlocked(c.id, game.profile)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => { void join(true); }}>{busy ? "Connecting…" : "Host a room"}</button>
        <div className="multiplayer-divider">or join a friend</div>
        <form onSubmit={(e) => { e.preventDefault(); void join(false); }}>
          <label>Invitation code<input className="invite-input" aria-label="Invitation code" maxLength={6} value={code} placeholder="ABC123" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} autoCapitalize="characters" autoCorrect="off" spellCheck={false} disabled={busy} /></label>
          <button className="btn" type="submit" disabled={busy || !name.trim() || code.length !== 6}>Join room</button>
        </form>
        {(error || network.error) && <p className="multiplayer-error" role="alert">{error || network.error}</p>}
        <p className="faint">Bumping is on: cars push each other around. Send emotes with 1–4 and honk with H. Room races are casual and do not change your solo records.</p>
      </div>
    </div>
  </div>;
}

export function MultiplayerHud({ game }: { game: Game }) {
  const state = useSyncExternalStore(game.multiplayer.store.subscribe, game.multiplayer.store.get, game.multiplayer.store.get);
  const [message, setMessage] = useState("");
  const [laps, setLaps] = useState(3);
  useTicker(10);
  const inRoom = !!state.room;
  // Emotes from the keyboard: 1-4, and H for the horn.
  useEffect(() => {
    if (!inRoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement | null)?.tagName === "INPUT") return;
      const i = e.code === "KeyH" ? HORN : e.code.startsWith("Digit") ? Number(e.code.slice(5)) - 1 : -1;
      if (i >= 0 && i < EMOTES.length) game.multiplayer.emote(i);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, inRoom]);
  const room = state.room;
  if (!room) return state.error ? <div className="network-notice panel" role="status">{state.error}<button className="btn small" onClick={() => game.go("multiplayer")}>Rejoin</button></div> : null;
  const host = room.hostId === state.id;
  const racing = room.phase === "racing" || room.phase === "countdown";
  const ranked = rankPlayers(room.players);
  const place = ranked.findIndex((p) => p.id === state.id) + 1;
  const me = room.players.find((p) => p.id === state.id);
  const raceLaps = room.laps ?? 1;
  const run = async (action: () => Promise<unknown>) => {
    setMessage("");
    try { await action(); } catch (err) { setMessage(err instanceof Error ? err.message : "Please try again."); }
  };
  const copy = async () => {
    const link = new URL(window.location.href);
    link.search = ""; link.searchParams.set("room", room.code);
    try { await navigator.clipboard.writeText(link.href); setMessage("Invitation link copied"); }
    catch { setMessage(`Share this code: ${room.code}`); }
  };
  const showPlace = room.phase !== "practice";
  return <div className="multiplayer-hud panel">
    <div className="mp-heading">
      {showPlace ? (
        <strong className="mp-place" aria-label={`Position ${place} of ${room.players.length}`}><b>{place}</b><sup>{ordinal(place).replace(/\d+/, "")}</sup><small>/{room.players.length}</small></strong>
      ) : <span className="eyebrow">Drive together</span>}
      {showPlace ? (
        <span className="mp-lap" aria-label="Lap">{room.phase === "finished" ? "FINISHED" : <>LAP <b>{Math.min(raceLaps, (me?.lap ?? 0) + 1)}</b>/{raceLaps}</>}</span>
      ) : <span className="faint">{room.players.length} in room</span>}
    </div>
    <div className="mp-code"><span>ROOM <b>{room.code}</b></span><button onClick={() => { void copy(); }}>Copy invite</button></div>
    {host && !racing && <div className="mp-laps" role="radiogroup" aria-label="Race length">
      {LAP_CHOICES.map((n) => <button key={n} role="radio" aria-checked={laps === n} className={laps === n ? "on" : ""} onClick={() => setLaps(n)}>{n} {n === 1 ? "lap" : "laps"}</button>)}
    </div>}
    <div className="mp-actions">
      {host && !racing && <button className="btn small primary" disabled={room.players.length < 2 || room.players.some((p) => !p.ready)} onClick={() => { void run(() => game.multiplayer.startRace(laps)); }}>{room.phase === "finished" ? "Race again" : "Start race"}</button>}
      {host && racing && <button className="btn small" onClick={() => { void run(() => game.multiplayer.practice()); }}>End race</button>}
      {!host && !racing && <span className="faint">Waiting for host</span>}
      <button className="btn small" onClick={() => game.back()}>Leave</button>
    </div>
    <ol className="mp-standings" aria-label="Race standings">
      {ranked.map((player, index) => <li key={player.id} className={player.id === state.id ? "you" : ""}>
        <span className="mp-dot" style={{ background: player.color }} /><b>{index + 1}</b><span className="mp-name">{player.id === state.id ? `${player.name} · You` : player.name}</span>
        <span>{player.finishMs !== null ? fmtTime(player.finishMs / 1000) : !player.ready ? "Loading" : racing ? `${Math.min(100, Math.max(0, Math.round((player.distance / raceLaps) * 100)))}%` : player.id === room.hostId ? "Host" : "Ready"}</span>
      </li>)}
    </ol>
    <div className="mp-emotes" aria-label="Emotes">
      {EMOTES.map((e, i) => <button key={e} title={i === HORN ? "Horn (H)" : `Emote (${i + 1})`} aria-label={i === HORN ? "Horn" : `Emote ${e}`} onClick={() => game.multiplayer.emote(i)}>{e}</button>)}
    </div>
    {message && <div className="mp-message" role="status">{message}</div>}
  </div>;
}
