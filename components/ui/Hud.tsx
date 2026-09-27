"use client";

import { useEffect, useRef } from "react";
import type { Game } from "@/game/Game";
import { fmtDelta, fmtScore, fmtTime, useTicker } from "./common";

function Minimap({ game }: { game: Game }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const b = game.mapBounds;
      const pad = 8;
      const sx = (w - pad * 2) / (b.maxX - b.minX);
      const sz = (h - pad * 2) / (b.maxZ - b.minZ);
      const s = Math.min(sx, sz);
      const ox = (w - (b.maxX - b.minX) * s) / 2;
      const oz = (h - (b.maxZ - b.minZ) * s) / 2;
      // Seen from above with north (+z) up; +x (west) to the left.
      const px = (x: number) => w - (ox + (x - b.minX) * s);
      const pz = (z: number) => h - (oz + (z - b.minZ) * s);
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      game.mapPath.forEach((p, i) => (i ? ctx.lineTo(px(p.x), pz(p.z)) : ctx.moveTo(px(p.x), pz(p.z))));
      ctx.closePath();
      ctx.stroke();
      const hud = game.hud;
      const f = game.mapPath[0];
      if (f) {
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(px(f.x) - 4, pz(f.z) - 1, 8, 2);
      }
      if (hud.ghost.visible) {
        ctx.fillStyle = "rgba(159,212,255,0.85)";
        ctx.beginPath();
        ctx.arc(px(hud.ghost.x), pz(hud.ghost.z), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#86cdb6";
      ctx.strokeStyle = "#0d1316";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(hud.car.x), pz(hud.car.z), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return <canvas ref={ref} className="chip minimap" aria-label="Route map" style={{ width: undefined }} />;
}

export function Hud({ game, touch }: { game: Game; touch: boolean }) {
  useTicker(30);
  const h = game.hud;
  const s = game.settings;
  if (!h.visible) return null;
  const units = s.units === "mph" ? "mph" : "km/h";
  const rpmFrac = Math.min(1, h.rpm / (h.redline * 1.04));
  const timed = h.kind === "timeTrial" || h.kind === "mastery" || h.kind === "sprint" || h.kind === "drift";
  const cd = h.phase === "countdown" ? Math.ceil(h.countdown) : 0;
  return (
    <div className={`hud ${touch ? "touch-mode" : ""}`} aria-live="off">
      {/* Timing */}
      <div className="hud-tl">
        {timed && (
          <div className="chip timing">
            <div className="eyebrow" style={{ fontSize: 11 }}>
              {h.kind === "timeTrial" || h.kind === "mastery" ? `Lap ${h.lap}/${h.laps}` : h.eventName}
              {!h.lapValid && h.lapStarted && <span className="invalid-tag"> · invalid</span>}
            </div>
            {h.kind !== "drift" ? (
              <>
                <div className="big">{(h.kind === "timeTrial" || h.kind === "mastery") && !h.lapStarted ? "0:00.000" : fmtTime(h.lapTime)}</div>
                {(h.kind === "timeTrial" || h.kind === "mastery") && !h.lapStarted && <div className="sub">Timing starts at the line</div>}
                {h.delta !== null && h.lapStarted && <div className={`delta ${h.delta <= 0 ? "good" : "bad"}`}>{fmtDelta(h.delta)}</div>}
                <div className="sub">
                  <span>Best {fmtTime(h.bestLap)}</span>
                  {h.pbLap !== null && <span>PB {fmtTime(h.pbLap)}</span>}
                </div>
              </>
            ) : (
              <div className="big">{fmtTime(h.lapTime)}</div>
            )}
          </div>
        )}
        {h.kind === "free" && (
          <div className="chip timing" style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ fontSize: 11 }}>
              Free Drive
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              <span>
                <span className="kbd">T</span> reset · <span className="kbd">C</span> camera · <span className="kbd">Esc</span> menu
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Lesson / drift / countdown */}
      <div className="hud-top">
        {h.lesson && (
          <div className="chip lesson-card">
            <div className="t">
              {h.lesson.title} · step {Math.min(h.lesson.step + 1, h.lesson.steps.length)} of {h.lesson.steps.length}
            </div>
            <div className="p">{h.lesson.prompt}</div>
            {h.lesson.tip && <div className="tip">{h.lesson.tip}</div>}
            <div className="progress">
              <div style={{ width: `${Math.round(h.lesson.progress * 100)}%` }} />
            </div>
          </div>
        )}
        {h.drift && (
          <div className="chip drift-box">
            <div className="eyebrow" style={{ fontSize: 11 }}>
              {h.drift.zone ?? (h.kind === "drift" ? "Between zones" : "Drift")}
            </div>
            <div className="score">{fmtScore(h.drift.total)}</div>
            <div className="combo">{h.drift.active ? `+${fmtScore(h.drift.combo)}  ×${h.drift.mult.toFixed(1)}  ${Math.round(h.drift.angle)}°` : ""}</div>
          </div>
        )}
      </div>
      {h.phase === "countdown" && (
        <div className="countdown" aria-label={`Starting in ${cd}`}>
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < 4 - cd ? "on" : ""} />
          ))}
        </div>
      )}

      {/* Toasts */}
      <div className="toasts" role="status">
        {h.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>

      {/* Map */}
      {s.hud.minimap && (
        <div className="hud-tr" style={touch ? { top: "calc(66px + var(--safe-t))" } : undefined}>
          <Minimap game={game} />
        </div>
      )}

      {/* Learning overlay */}
      <div className="hud-bl">
        {h.nextCorner && s.learning.racingLine > 0 && !h.nextCorner.flat && h.nextCorner.dist < 260 && h.nextCorner.dist > -5 && (
          <div className="chip corner-info">
            <b>
              {h.nextCorner.name} ({h.nextCorner.short}) {h.nextCorner.dir > 0 ? "↰" : "↱"}
            </b>{" "}
            in {Math.max(0, Math.round(h.nextCorner.dist))} m · about {s.units === "mph" ? Math.round(h.nextCorner.kmh * 0.621) : h.nextCorner.kmh} {units}
          </div>
        )}
        {s.learning.inputDisplay && (
          <div className="chip inputs" aria-label="Input display">
            <div className="bar" title="Brake">
              <div style={{ height: `${h.inputs.brake * 100}%`, background: "var(--bad)" }} />
            </div>
            <div className="bar" title="Throttle">
              <div style={{ height: `${h.inputs.throttle * 100}%`, background: "var(--good)" }} />
            </div>
            <div className="steer" title="Steering">
              <div style={{ left: `${50 + h.inputs.steer * 50}%` }} />
            </div>
            <div className="bar" title="Handbrake">
              <div style={{ height: `${h.inputs.handbrake * 100}%`, background: "var(--warm)" }} />
            </div>
          </div>
        )}
      </div>

      {/* Speed */}
      <div className="hud-br">
        <div className="chip speedo">
          <div className="speed-row">
            <div className="gear" aria-label="Gear">
              {h.gear}
            </div>
            <div>
              <span className="v">{Math.round(h.kmh)}</span>
              <span className="u">{units}</span>
            </div>
          </div>
          <div className={`rpm ${rpmFrac > 0.92 ? "hot" : ""}`}>
            <div style={{ width: `${rpmFrac * 100}%` }} />
          </div>
          <div className="aids">
            <span className={h.assists.abs ? "on" : ""}>ABS</span>
            <span className={h.assists.tc ? "on" : ""}>TC</span>
            <span className={h.assists.esc ? "on" : ""}>ESC</span>
          </div>
        </div>
      </div>
    </div>
  );
}
