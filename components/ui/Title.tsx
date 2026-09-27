"use client";

import type { Game } from "@/game/Game";
import { EVENTS, isUnlocked } from "@/game/session/events";

export function Title({ game }: { game: Game }) {
  const p = game.profile;
  // Suggest the first unlocked event that has not been completed yet.
  const next = EVENTS.find((e) => e.kind !== "free" && isUnlocked(e, p) && !p.completed[e.id]);
  const open = (filter: "all" | "academy" | "time" | "drift" | "mastery") => {
    game.store.set({ eventsFilter: filter });
    game.go("events");
  };
  const brief = (id: string) => {
    game.selectEvent(id);
    game.go("briefing");
  };
  return (
    <>
      <div className="menu-shade" />
      <div className="title-wrap">
        <div>
          <h1 className="game-title">Larchmere</h1>
          <p className="game-sub">A quiet lakeside road, a willing car, and every lap a little better than the last.</p>
        </div>
        <nav className="menu-list" aria-label="Main menu">
          {next && (
            <button className="menu-item" onClick={() => brief(next.id)} autoFocus>
              <span>Continue</span>
              <small>{next.name}</small>
            </button>
          )}
          <button className="menu-item" onClick={() => brief("free")}>
            <span>Free Drive</span>
            <small>explore with nitro boost</small>
          </button>
          <button className="menu-item" onClick={() => game.go("multiplayer")}>
            <span>Multiplayer</span>
            <small>host a room or join with a code</small>
          </button>
          <button className="menu-item" onClick={() => open("academy")}>
            <span>Driving Academy</span>
            <small>short lessons</small>
          </button>
          <button className="menu-item" onClick={() => open("time")}>
            <span>Time Trials</span>
            <small>beat your ghost</small>
          </button>
          <button className="menu-item" onClick={() => open("drift")}>
            <span>Drift Challenges</span>
            <small>controlled slides</small>
          </button>
          <button className="menu-item" onClick={() => open("mastery")}>
            <span>Mastery</span>
            <small>consistency tests</small>
          </button>
          <button className="menu-item" onClick={() => game.go("garage")}>
            <span>Garage</span>
            <small>cars &amp; paint</small>
          </button>
          <button className="menu-item" onClick={() => game.store.set({ settingsOpen: true })}>
            <span>Settings</span>
            <small>assists, controls, graphics</small>
          </button>
          <button className="menu-item" onClick={() => game.store.set({ helpOpen: true })}>
            <span>How to drive</span>
            <small>controls &amp; tips</small>
          </button>
        </nav>
      </div>
      <div className="title-foot">
        Cars &amp; nature models by Quaternius (CC0) · Textures &amp; skies from Poly Haven (CC0)
      </div>
    </>
  );
}
