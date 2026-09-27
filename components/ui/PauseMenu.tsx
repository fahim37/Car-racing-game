"use client";

import type { Game } from "@/game/Game";

export function PauseMenu({ game }: { game: Game }) {
  const name = game.session?.event.name ?? "";
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && game.resume()}>
      <div className="panel modal" role="dialog" aria-label="Paused">
        <div className="eyebrow">{game.multiplayer.room ? "Menu · online race continues" : "Paused"}</div>
        <h2>{name}</h2>
        <button className="btn primary" autoFocus onClick={() => game.resume()}>
          Resume <span className="kbd" style={{ background: "rgba(0,0,0,0.15)", borderColor: "rgba(0,0,0,0.2)" }}>Esc</span>
        </button>
        <button
          className="btn"
          onClick={() => {
            game.resume();
            game.restart();
          }}
        >
          Restart event <span className="kbd">R</span>
        </button>
        <button
          className="btn"
          onClick={() => {
            game.resume();
            game.resetCar();
          }}
        >
          Reset car to the road <span className="kbd">T</span>
        </button>
        <button className="btn" onClick={() => game.store.set({ settingsOpen: true })}>
          Settings
        </button>
        <button className="btn" onClick={() => game.store.set({ helpOpen: true })}>
          Controls &amp; tips
        </button>
        <button className="btn ghost" onClick={() => game.quitToMenu()}>
          Quit to events
        </button>
      </div>
    </div>
  );
}
