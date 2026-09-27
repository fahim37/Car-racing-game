"use client";

import type { Game, UIState } from "@/game/Game";
import { CARS } from "@/game/physics/carSpecs";
import { CAR_UNLOCKS, isCarUnlocked } from "@/game/session/events";

export function Garage({ game, state }: { game: Game; state: UIState }) {
  const p = game.profile;
  const car = CARS.find((c) => c.id === state.carId) ?? CARS[0];
  const paint = p.settings.paint[car.id] ?? car.paint;
  return (
    <>
      <div className="menu-shade" />
      <div className="title-wrap" style={{ gap: 18 }}>
        <div className="row">
          <button className="btn" onClick={() => game.go("title")} aria-label="Back">
            ←
          </button>
          <span className="eyebrow">Garage</span>
        </div>
        <div>
          <h1 className="game-title" style={{ fontSize: "clamp(30px, 4.5vw, 52px)", letterSpacing: "0.12em" }}>
            {car.name}
          </h1>
          <p className="game-sub">{car.blurb}</p>
        </div>
        <div className="panel" style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 16px", fontSize: 14 }}>
          <span className="muted">Class</span>
          <span>{car.className}</span>
          <span className="muted">Power</span>
          <span>{car.stats.power}</span>
          <span className="muted">Weight</span>
          <span>{car.stats.weight}</span>
          <span className="muted">Layout</span>
          <span>{car.stats.layout}</span>
          <span className="muted">Weight on front</span>
          <span>{Math.round(car.frontWeight * 100)}%</span>
        </div>
        {car.paints.length > 1 && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Paint
            </div>
            <div className="swatches">
              {car.paints.map((c) => (
                <button key={c} className={`swatch ${c === paint ? "active" : ""}`} style={{ background: c }} aria-label={`Paint ${c}`} onClick={() => void game.setPaint(c)} />
              ))}
            </div>
          </div>
        )}
        <div className="car-pick">
          {CARS.map((c) => {
            const unlocked = isCarUnlocked(c.id, p);
            return (
              <button key={c.id} className={`car-opt ${c.id === car.id ? "active" : ""}`} disabled={!unlocked} onClick={() => void game.selectCar(c.id)} title={unlocked ? c.className : CAR_UNLOCKS.find((u) => u.carId === c.id)?.text}>
                <b>
                  {c.name} {!unlocked && "🔒"}
                </b>
                <span>{unlocked ? c.className : CAR_UNLOCKS.find((u) => u.carId === c.id)?.text}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
