"use client";

import { useEffect } from "react";
import type { Game, UIState } from "@/game/Game";
import { CARS } from "@/game/physics/carSpecs";
import { ASSIST_PRESETS, AssistPreset, TIER_LABEL, describeAssist } from "@/game/save/profile";
import { CAR_UNLOCKS, eventById, isCarUnlocked } from "@/game/session/events";
import { KIND_LABEL, Medal, Seg, fmtScore, fmtTime } from "./common";

const TIME_LABEL = { morning: "Early morning", afternoon: "Late afternoon", dusk: "Dusk" } as const;

export function Briefing({ game, state }: { game: Game; state: UIState }) {
  const ev = eventById(state.eventId);
  const p = game.profile;
  const preview = game.eventPreview(ev.id, state.carId);
  const cond = ev.kind === "free" ? state.freeConditions : ev.conditions;
  const drift = ev.kind === "drift";
  const fmt = (v: number) => (drift ? `${fmtScore(v)} pts` : fmtTime(v));
  const a = preview.assists;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "NumpadEnter") void game.startEvent();
      if (e.code === "Escape") game.go(ev.kind === "free" ? "title" : "events");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, ev.kind]);

  const setPreset = (preset: Exclude<AssistPreset, "custom">) => {
    const s = structuredClone(game.settings);
    s.assistPreset = preset;
    s.assists = { ...ASSIST_PRESETS[preset].assists, steerSpeedSensitivity: s.assists.steerSpeedSensitivity, steerRate: s.assists.steerRate };
    s.learning.racingLine = ASSIST_PRESETS[preset].racingLine;
    game.applySettings(s);
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={() => game.go(ev.kind === "free" ? "title" : "events")} aria-label="Back">
          ←
        </button>
        <h2>{ev.name}</h2>
        <button className="btn primary" onClick={() => void game.startEvent()} disabled={!!state.busy}>
          {ev.kind === "free" ? "Drive" : "Start"} <span className="kbd" style={{ background: "rgba(0,0,0,0.15)", borderColor: "rgba(0,0,0,0.2)" }}>Enter</span>
        </button>
      </div>
      <div className="screen-body">
        <div className="brief">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="panel">
              <div className="eyebrow">{KIND_LABEL[ev.kind]}</div>
              <h3 style={{ marginTop: 6 }}>{ev.summary}</h3>
              <p>{ev.objective}</p>
              {ev.kind === "free" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                  <div className="spread">
                    <span>Time of day</span>
                    <Seg
                      label="Time of day"
                      value={cond.time}
                      options={[
                        { v: "morning", label: "Morning" },
                        { v: "afternoon", label: "Afternoon" },
                        { v: "dusk", label: "Dusk" },
                      ]}
                      onChange={(v) => game.setFreeConditions({ ...cond, time: v })}
                    />
                  </div>
                  <div className="spread">
                    <span>Weather</span>
                    <Seg
                      label="Weather"
                      value={cond.weather}
                      options={[
                        { v: "dry", label: "Dry" },
                        { v: "wet", label: "Rain" },
                      ]}
                      onChange={(v) => game.setFreeConditions({ ...cond, weather: v })}
                    />
                  </div>
                  <p className="faint" style={{ fontSize: 13 }}>
                    The paddock pad beside the start straight is a safe place to practise slides. Press <span className="kbd">T</span> to put the car back on the road at any time.
                  </p>
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>
                  {TIME_LABEL[cond.time]} · {cond.weather === "wet" ? "Wet road, reduced grip" : "Dry"}
                  {ev.laps ? ` · ${ev.laps} laps` : ""}
                </p>
              )}
            </div>

            {preview.targets && (
              <div className="panel">
                <h3>Targets for this car</h3>
                <div className="targets">
                  {(["bronze", "silver", "gold"] as const).map((m, i) => (
                    <div className="target" key={m}>
                      <Medal m={m} />
                      <span className="mono">{fmt(preview.targets![i])}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14 }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>
                    Your records ({CARS.find((c) => c.id === state.carId)?.className})
                  </div>
                  {preview.records.map(({ tier, record }) => (
                    <div className="spread" key={tier} style={{ fontSize: 14, padding: "3px 0", color: tier === preview.tier ? "var(--text)" : "var(--muted)" }}>
                      <span>
                        {TIER_LABEL[tier]}
                        {tier === preview.tier ? " (current)" : ""}
                      </span>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="mono">{record ? fmt(record.best) : "-"}</span>
                        <Medal m={record?.medal} />
                      </span>
                    </div>
                  ))}
                  {preview.record?.lap && <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Your personal-best ghost will drive with you.</p>}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="panel">
              <h3>Car</h3>
              <div className="car-pick">
                {CARS.map((c) => {
                  const unlocked = isCarUnlocked(c.id, p);
                  return (
                    <button
                      key={c.id}
                      className={`car-opt ${state.carId === c.id ? "active" : ""}`}
                      disabled={!unlocked}
                      title={unlocked ? c.blurb : CAR_UNLOCKS.find((u) => u.carId === c.id)?.text}
                      onClick={() => void game.selectCar(c.id)}
                    >
                      <b>
                        {c.name} {!unlocked && "🔒"}
                      </b>
                      <span>{c.className}</span>
                      {ev.recommendedCar === c.id && <span style={{ display: "block", color: "var(--accent)" }}>Recommended</span>}
                    </button>
                  );
                })}
              </div>
              <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>
                {CARS.find((c) => c.id === state.carId)?.blurb}
              </p>
            </div>
            <div className="panel">
              <div className="spread">
                <h3>Driving aids</h3>
                <Seg
                  label="Assist preset"
                  value={game.settings.assistPreset === "custom" ? ("custom" as AssistPreset) : game.settings.assistPreset}
                  options={[
                    { v: "beginner" as AssistPreset, label: "Beginner" },
                    { v: "intermediate" as AssistPreset, label: "Club" },
                    { v: "expert" as AssistPreset, label: "Expert" },
                  ]}
                  onChange={(v) => v !== "custom" && setPreset(v)}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 12px", fontSize: 14, marginTop: 8 }}>
                <span className="muted">Anti-lock brakes</span>
                <span>{a.abs ? "On" : "Off"}</span>
                <span className="muted">Traction control</span>
                <span>{describeAssist(a.tc)}</span>
                <span className="muted">Stability control</span>
                <span>{describeAssist(a.esc)}</span>
                <span className="muted">Gearbox</span>
                <span>{a.autoGear ? "Automatic" : "Manual"}</span>
                <span className="muted">Racing line</span>
                <span>{["Off", "Braking zones", "Full"][game.settings.learning.racingLine]}</span>
              </div>
              {ev.assistCap && (
                <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>
                  This challenge limits {ev.assistCap.esc ? `stability control to ${describeAssist(ev.assistCap.esc)}` : ""}
                  {ev.assistCap.esc && ev.assistCap.tc ? " and " : ""}
                  {ev.assistCap.tc ? `traction control to ${describeAssist(ev.assistCap.tc)}` : ""}. Accessibility options are never restricted.
                </p>
              )}
              <button className="btn small" style={{ marginTop: 10 }} onClick={() => game.store.set({ settingsOpen: true })}>
                All settings
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
