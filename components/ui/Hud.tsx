"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Game } from "@/game/Game";
import { fmtDelta, fmtScore, fmtTime, useTicker } from "./common";

// Round speedometer: a 270° dial opening at the bottom, clockwise from bottom-left (SVG degrees).
const DIAL_FROM = 135;
const DIAL_SWEEP = 270;
const DIAL_R = 84;

function polar(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)] as const;
}

function arc(r: number, from: number, to: number) {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** White at cruising speed, warming to peach towards the top of the dial. */
function dialColour(frac: number) {
  const t = Math.min(1, Math.max(0, (frac - 0.35) / 0.5));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(255, 255)},${mix(255, 172)},${mix(255, 128)})`;
}

function Speedometer({ speed, mph, gear, rpmFrac, hot }: { speed: number; mph: boolean; gear: string; rpmFrac: number; hot: boolean }) {
  const max = mph ? 200 : 320;
  const labelEvery = mph ? 40 : 80;
  const minor = 20;
  const scale = useMemo(() => {
    const ticks: { d: string; major: boolean }[] = [];
    const labels: { x: number; y: number; v: number }[] = [];
    for (let v = 0; v <= max; v += minor) {
      const deg = DIAL_FROM + (v / max) * DIAL_SWEEP;
      const major = v % labelEvery === 0;
      const [x0, y0] = polar(DIAL_R - 6, deg);
      const [x1, y1] = polar(DIAL_R - (major ? 14 : 10), deg);
      ticks.push({ d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`, major });
      if (major) {
        const [lx, ly] = polar(DIAL_R - 25, deg);
        labels.push({ x: lx, y: ly, v });
      }
    }
    // Engine speed: a thin arc over the top, clear of the scale labels and the readout.
    return { ticks, labels, track: arc(DIAL_R, DIAL_FROM, DIAL_FROM + DIAL_SWEEP), rpm: arc(46, 215, 325) };
  }, [max, labelEvery]);
  const frac = Math.min(1, Math.max(0, speed / max));
  return (
    <div className="dial" role="img" aria-label={`${Math.round(speed)} ${mph ? "miles" : "kilometres"} per hour, gear ${gear}`}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="97" className="dial-face" />
        <path d={scale.track} className="dial-track" />
        {frac > 0.001 && <path d={scale.track} pathLength={1} strokeDasharray={`${frac} 1`} className="dial-fill" style={{ stroke: dialColour(frac) }} />}
        {scale.ticks.map((t, i) => (
          <path key={i} d={t.d} className={t.major ? "dial-tick major" : "dial-tick"} />
        ))}
        {scale.labels.map((l) => (
          <text key={l.v} x={l.x} y={l.y} className="dial-label" textAnchor="middle" dominantBaseline="central">
            {l.v}
          </text>
        ))}
        <path d={scale.rpm} className="dial-rpm-track" />
        <path d={scale.rpm} pathLength={1} strokeDasharray={`${Math.min(1, rpmFrac)} 1`} className={`dial-rpm ${hot ? "hot" : ""}`} />
        <text x="100" y="109" className="dial-speed" textAnchor="middle" dominantBaseline="central">
          {Math.round(speed)}
        </text>
        <text x="100" y="138" className="dial-unit" textAnchor="middle" dominantBaseline="central">
          {mph ? "MPH" : "KM/H"}
        </text>
        <text x="100" y="166" className="dial-gear" textAnchor="middle" dominantBaseline="central">
          GEAR {gear}
        </text>
      </svg>
    </div>
  );
}

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
  const laps = h.kind === "timeTrial" || h.kind === "mastery";
  const cd = h.phase === "countdown" ? Math.ceil(h.countdown) : 0;
  return (
    <div className={`hud ${touch ? "touch-mode" : ""}`} aria-live="off">
      {/* Timing */}
      <div className="hud-tl">
        {timed && (
          <div className="race-timing">
            {laps && (
              <div className="chip lap-count" aria-label={`Lap ${h.lap} of ${h.laps}`}>
                <div>
                  <b>{h.lap}</b>
                  <span>/{h.laps}</span>
                </div>
                <small>LAP</small>
              </div>
            )}
            <div className="chip timing">
              {!laps && <div className="eyebrow" style={{ fontSize: 11 }}>{h.eventName}</div>}
              {h.kind !== "drift" ? (
                <>
                  <div className="t-row main">
                    <span>{laps ? "LAP" : "TIME"}</span>
                    <b>{laps && !h.lapStarted ? "0:00.000" : fmtTime(h.lapTime)}</b>
                  </div>
                  {laps && !h.lapStarted && <div className="sub">Timing starts at the line</div>}
                  {h.delta !== null && h.lapStarted && <div className={`delta ${h.delta <= 0 ? "good" : "bad"}`}>{fmtDelta(h.delta)}</div>}
                  <div className="t-row">
                    <span>BEST</span>
                    <b>{fmtTime(h.bestLap)}</b>
                  </div>
                  {h.pbLap !== null && (
                    <div className="t-row">
                      <span>PB</span>
                      <b>{fmtTime(h.pbLap)}</b>
                    </div>
                  )}
                </>
              ) : (
                <div className="t-row main">
                  <span>TIME</span>
                  <b>{fmtTime(h.lapTime)}</b>
                </div>
              )}
              {!h.lapValid && h.lapStarted && <div className="invalid-tag">Lap invalid</div>}
            </div>
          </div>
        )}
        {h.kind === "free" && !game.multiplayer.room && (
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
            {h.lesson.retry && <button className="btn small lesson-retry" onClick={() => game.retryLesson()}>Retry lesson section</button>}
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
        <div className="speed-side">
          {h.nitro.enabled && <div className={`chip nitro-meter ${h.nitro.active ? "boosting" : ""}`}>
            <div className="nitro-label"><span>{h.nitro.active ? "BOOST" : "NITRO"}</span><span>{touch ? "Hold Nitro + Gas" : "Hold N + accelerate"}</span></div>
            <div role="progressbar" aria-label="Nitro charge" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(h.nitro.charge * 100)}><i style={{ width: `${h.nitro.charge * 100}%` }} /></div>
          </div>}
          <div className="aids">
            <span className={h.assists.abs ? "on" : ""}>ABS</span>
            <span className={h.assists.tc ? "on" : ""}>TC</span>
            <span className={h.assists.esc ? "on" : ""}>ESC</span>
          </div>
        </div>
        <Speedometer speed={h.kmh} mph={s.units === "mph"} gear={h.gear} rpmFrac={rpmFrac} hot={rpmFrac > 0.92} />
      </div>
    </div>
  );
}
