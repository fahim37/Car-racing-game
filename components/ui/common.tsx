"use client";

import { useEffect, useState } from "react";
import type { Medal as MedalT } from "@/game/save/profile";

export function Medal({ m, big = false, title }: { m: MedalT | null | undefined; big?: boolean; title?: string }) {
  return <span className={`medal ${m ?? "none"} ${big ? "big" : ""}`} title={title ?? (m ? `${m[0].toUpperCase()}${m.slice(1)} medal` : "No medal yet")} aria-label={title ?? m ?? "no medal"} />;
}

export function fmtTime(t: number | null | undefined) {
  if (t === null || t === undefined || !isFinite(t)) return "--:--.---";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}

export function fmtDelta(d: number | null | undefined) {
  if (d === null || d === undefined || !isFinite(d)) return "";
  return `${d <= 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;
}

export function fmtScore(n: number | null | undefined) {
  if (n === null || n === undefined) return "-";
  return Math.round(n).toLocaleString();
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, label, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="mono muted" style={{ minWidth: 44, textAlign: "right", fontSize: 13 }}>
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/** Re-renders a component at a fixed rate (for HUD values). */
export function useTicker(hz = 30) {
  const [, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last >= 1000 / hz) {
        last = now;
        setT((t) => (t + 1) % 1_000_000);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hz]);
}

export const KIND_LABEL: Record<string, string> = {
  free: "Free Drive",
  lesson: "Driving Academy",
  timeTrial: "Time Trial",
  sprint: "Sprint",
  drift: "Drift Challenge",
  mastery: "Mastery Challenge",
};

export function keyLabel(code: string) {
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace("Arrow", "")
    .replace("Left", " L")
    .replace("Right", " R")
    .replace("Up", "↑")
    .replace("Down", "↓")
    .replace("Space", "Space")
    .replace("Escape", "Esc")
    .replace("Backspace", "⌫")
    .replace("Control", "Ctrl")
    .trim();
}
