"use client";

import { CSSProperties, useEffect, useRef, useState } from "react";
import type { Game } from "@/game/Game";
import { requestGameFullscreen } from "@/game/util/fullscreen";

function Pedal({ className, label, onChange, style }: { className: string; label: string; onChange: (v: number) => void; style?: CSSProperties }) {
  const [on, setOn] = useState(false);
  const set = (v: boolean) => {
    setOn(v);
    onChange(v ? 1 : 0);
  };
  return (
    <div
      className={`pedal ${className} ${on ? "on" : ""}`}
      style={style}
      role="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </div>
  );
}

const RANGE = 70; // px of slide for full steering

export function TouchControls({ game }: { game: Game }) {
  const input = game.input;
  const mode = game.settings.input.touchSteer;
  const [thumb, setThumb] = useState<{ x: number; y: number; x0: number } | null>(null);
  const pointer = useRef<number | null>(null);

  useEffect(() => {
    input.setTouch({ active: true });
    if (mode === "tilt") void input.enableTilt();
    return () => input.setTouch({ active: false, steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: false });
  }, [input, mode]);

  const endSlide = () => {
    pointer.current = null;
    setThumb(null);
    input.setTouch({ steer: 0 });
  };

  return (
    <div className="touch" onContextMenu={(e) => e.preventDefault()}>
      {mode === "slide" && (
        <div
          className="zone steer-zone"
          aria-label="Steering: slide left or right"
          onPointerDown={(e) => {
            if (pointer.current !== null) return;
            pointer.current = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = e.currentTarget.getBoundingClientRect();
            setThumb({ x: e.clientX - r.left, y: e.clientY - r.top, x0: e.clientX - r.left });
            input.setTouch({ steer: 0 });
          }}
          onPointerMove={(e) => {
            if (pointer.current !== e.pointerId || !thumb) return;
            const r = e.currentTarget.getBoundingClientRect();
            const v = Math.max(-1, Math.min(1, (e.clientX - r.left - thumb.x0) / RANGE));
            input.setTouch({ steer: Math.sign(v) * Math.pow(Math.abs(v), 1.3) });
            setThumb({ ...thumb, x: thumb.x0 + v * RANGE });
          }}
          onPointerUp={endSlide}
          onPointerCancel={endSlide}
        >
          {thumb ? (
            <>
              <div className="steer-track" style={{ left: thumb.x0 - RANGE, top: thumb.y - 2, width: RANGE * 2 }} />
              <div className="steer-thumb" style={{ left: thumb.x, top: thumb.y }} />
            </>
          ) : (
            <div className="muted" style={{ position: "absolute", left: 24, bottom: 28, fontSize: 12, opacity: 0.7 }}>
              Touch and slide to steer
            </div>
          )}
        </div>
      )}
      {mode === "buttons" && (
        <>
          <Pedal className="steer-btn" style={{ left: "calc(18px + var(--safe-l))" }} label="◀" onChange={(v) => input.setTouch({ steer: v ? -1 : 0 })} />
          <Pedal className="steer-btn" style={{ left: "calc(126px + var(--safe-l))" }} label="▶" onChange={(v) => input.setTouch({ steer: v ? 1 : 0 })} />
        </>
      )}
      {mode === "tilt" && (
        <div className="muted" style={{ position: "absolute", left: 24, bottom: 28, fontSize: 12, opacity: 0.7 }}>
          Tilt the device to steer
        </div>
      )}

      <Pedal className="throttle" label="Gas" onChange={(v) => input.setTouch({ throttle: v })} />
      <Pedal className="brake" label="Brake" onChange={(v) => input.setTouch({ brake: v })} />
      <Pedal className="handbrake" label="Hand" onChange={(v) => input.setTouch({ handbrake: v })} />
      {game.vehicle?.nitro.enabled && <Pedal className="nitro-pedal" label="Nitro" onChange={(v) => input.setTouch({ nitro: !!v })} />}

      <div className="top-btns">
        <button className="icon-btn fullscreen-btn" aria-label="Enter fullscreen" onClick={() => { void requestGameFullscreen(); }}>
          ⛶
        </button>
        <button className="icon-btn" aria-label="Pause" onClick={() => game.pause()}>
          ❚❚
        </button>
        <button className="icon-btn" aria-label="Change camera" onClick={() => game.cycleCamera()}>
          ◎
        </button>
        <button className="icon-btn" aria-label="Reset car to the road" onClick={() => game.resetCar()}>
          ↺
        </button>
      </div>
    </div>
  );
}
