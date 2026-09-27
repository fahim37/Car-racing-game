"use client";

import { useState } from "react";
import type { Game } from "@/game/Game";
import { ACTION_LABELS, Action, GAMEPAD_LABELS } from "@/game/input/Input";
import { keyLabel } from "./common";

export function Help({ game }: { game: Game }) {
  const [tab, setTab] = useState<"controls" | "technique">("controls");
  const keys = game.settings.input.keys;
  return (
    <div className="overlay" style={{ zIndex: 30 }} onClick={(e) => e.target === e.currentTarget && game.store.set({ helpOpen: false })}>
      <div className="panel modal wide" role="dialog" aria-label="How to drive">
        <div className="spread">
          <h2>How to drive</h2>
          <button className="btn" onClick={() => game.store.set({ helpOpen: false })}>
            Close
          </button>
        </div>
        <div className="tabs">
          <button className={`tab ${tab === "controls" ? "active" : ""}`} onClick={() => setTab("controls")}>
            Controls
          </button>
          <button className={`tab ${tab === "technique" ? "active" : ""}`} onClick={() => setTab("technique")}>
            Technique
          </button>
        </div>
        {tab === "controls" ? (
          <div style={{ overflowY: "auto" }}>
            <table className="laps-table" style={{ fontSize: 14 }}>
              <thead>
                <tr>
                  <th>Action</th>
                  <th style={{ textAlign: "left" }}>Keyboard</th>
                  <th style={{ textAlign: "left" }}>Controller</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(ACTION_LABELS) as Action[]).map((a) => (
                  <tr key={a}>
                    <td style={{ fontFamily: "var(--font)" }}>{ACTION_LABELS[a]}</td>
                    <td style={{ textAlign: "left" }}>
                      {keys[a].map((k) => (
                        <span className="kbd" key={k} style={{ marginRight: 4 }}>
                          {keyLabel(k)}
                        </span>
                      ))}
                    </td>
                    <td style={{ textAlign: "left", fontFamily: "var(--font)" }}>{GAMEPAD_LABELS[a] ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              <b>Touch:</b> slide on the left half of the screen to steer (or choose tilt / buttons in Settings), pedals on the right, with pause, camera and reset at the top. Hold the device in landscape.
              <br />
              <b>Automatic gearbox:</b> hold brake at a standstill to reverse. <b>Wheels:</b> calibrate once in Settings → Controls.
            </p>
          </div>
        ) : (
          <div className="fb" style={{ overflowY: "auto" }}>
            <h4>The racing line</h4>
            <ul>
              <li>Start the corner from the outside edge, clip the inside at the apex, and let the car run back out to the edge on exit. A wider arc means a higher possible speed.</li>
              <li>For corners that lead onto a straight, turn in a little later and prioritise the exit. Speed carried onto a straight lasts all the way down it.</li>
            </ul>
            <h4>Braking</h4>
            <ul>
              <li>Brake hard in a straight line, then ease off as you turn in. The tyres share their grip between braking and turning; asking for both at 100% makes them slide.</li>
              <li>Braking distance grows with the square of speed: twice as fast needs roughly four times the distance. The 150 / 100 / 50 boards help you find repeatable markers.</li>
              <li>Trail braking (a light brake while turning in) keeps weight on the front tyres and helps the car rotate.</li>
            </ul>
            <h4>Understeer and oversteer</h4>
            <ul>
              <li>
                <b>Understeer</b>: the car goes straighter than you steer; the front tyres are sliding. Don&apos;t add more lock. Ease off the throttle (or brake gently) so the fronts regain grip.
              </li>
              <li>
                <b>Oversteer</b>: the rear steps out and the car rotates too much. Steer into the slide (countersteer), look where you want to go, and smoothly reduce the throttle. Unwind the steering as the car straightens, or it will snap the other way.
              </li>
              <li>Smooth inputs keep the car settled. Sudden throttle, braking or steering shifts the weight abruptly and can unsettle it.</li>
            </ul>
            <h4>Drifting</h4>
            <ul>
              <li>Enter with some speed, turn in and break the rear loose with a firm throttle (rear-wheel drive), a lift and flick, or a quick handbrake tap.</li>
              <li>Hold the angle with the throttle: more throttle, more angle; too much and you spin. Keep a little countersteer and adjust in small movements.</li>
              <li>Exit by gently reducing angle and straightening up. Drifting scores points in drift events, but grip driving is faster against the clock.</li>
            </ul>
            <h4>In the wet</h4>
            <ul>
              <li>Grip is roughly a third lower: brake earlier, turn in more gently, and be patient with the throttle. Painted lines and kerbs are especially slippery.</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
