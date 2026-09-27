"use client";

import { useEffect } from "react";
import type { Game, UIState } from "@/game/Game";
import { TIER_LABEL } from "@/game/save/profile";
import { EVENTS, isUnlocked } from "@/game/session/events";
import { Medal, fmtDelta, fmtScore, fmtTime } from "./common";

export function ResultsView({ game, state }: { game: Game; state: UIState }) {
  const r = state.results!;
  const drift = r.kind === "drift";
  const lesson = r.kind === "lesson";
  const fmt = (v: number | null) => (v === null ? "-" : drift ? `${fmtScore(v)}` : fmtTime(v));
  const idx = EVENTS.findIndex((e) => e.id === r.eventId);
  const next = EVENTS.slice(idx + 1).find((e) => e.kind !== "free" && isUnlocked(e, game.profile));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // R (and the controller) restart through the game's own bindings.
      if (e.code === "Enter" || e.code === "NumpadEnter") game.restart();
      if (e.code === "Escape") game.quitToMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game]);

  const medalName = r.medal ? `${r.medal[0].toUpperCase()}${r.medal.slice(1)}` : null;
  return (
    <div className="overlay">
      <div className="panel modal wide" role="dialog" aria-label="Results">
        <div className="spread">
          <div>
            <div className="eyebrow">
              {r.eventName} · {r.carName} · {TIER_LABEL[r.tier as keyof typeof TIER_LABEL] ?? r.tier}
            </div>
            <h2 style={{ marginTop: 4 }}>{lesson ? (r.lessonComplete ? "Lesson complete" : "Lesson ended") : r.newBest ? "New personal best" : medalName ? `${medalName} medal` : "Run complete"}</h2>
          </div>
        </div>
        <div className="results">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!lesson && (
              <div className="result-hero">
                <Medal m={r.medal} big />
                <div>
                  <div className="eyebrow">{r.primaryLabel}</div>
                  <div className="val">{r.primary === null ? "No valid time" : fmt(r.primary)}</div>
                  {r.previousBest !== null && r.primary !== null && (
                    <div className={`delta ${(r.lowerBetter ? r.primary <= r.previousBest : r.primary >= r.previousBest) ? "good" : "bad"}`}>
                      {drift ? `${r.primary - r.previousBest >= 0 ? "+" : ""}${fmtScore(r.primary - r.previousBest)} vs best` : `${fmtDelta(r.primary - r.previousBest)} vs previous best`}
                    </div>
                  )}
                </div>
              </div>
            )}
            {lesson && <p style={{ margin: 0, lineHeight: 1.5 }}>{r.message}</p>}
            {lesson && r.lessonRetries > 0 && <p className="muted" style={{ margin: 0 }}>Completed after {r.lessonRetries} retr{r.lessonRetries === 1 ? "y" : "ies"}. Every retry is practice.</p>}
            {r.targets && (
              <div className="targets">
                {(["bronze", "silver", "gold"] as const).map((m, i) => (
                  <div className="target" key={m}>
                    <Medal m={m} />
                    <span className="mono">{fmt(r.targets![i])}</span>
                  </div>
                ))}
              </div>
            )}
            {r.laps.length > 0 && r.kind !== "drift" && (
              <table className="laps-table">
                <thead>
                  <tr>
                    <th>{r.kind === "sprint" ? "Run" : "Lap"}</th>
                    {r.kind !== "sprint" && r.sectorNames.map((n, i) => <th key={n}>S{i + 1}</th>)}
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {r.laps.map((l, i) => (
                    <tr key={i} style={{ opacity: l.valid ? 1 : 0.55 }}>
                      <td>
                        {i + 1}
                        {!l.valid && " ✕"}
                      </td>
                      {r.kind !== "sprint" && r.sectorNames.map((_, k) => <td key={k}>{l.sectors[k] ? l.sectors[k].toFixed(2) : "-"}</td>)}
                      <td>{fmtTime(l.time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.sectorDeltas.some((d) => d !== null) && (
              <div className="fb">
                <h4>Best lap vs personal best</h4>
                <div className="row" style={{ gap: 14 }}>
                  {r.sectorNames.map((n, i) =>
                    r.sectorDeltas[i] === null ? null : (
                      <span key={n} style={{ fontSize: 13.5 }}>
                        <span className="muted">{n}</span> <span className={`mono delta ${r.sectorDeltas[i]! <= 0 ? "good" : "bad"}`}>{fmtDelta(r.sectorDeltas[i])}</span>
                      </span>
                    ),
                  )}
                </div>
              </div>
            )}
            {r.zones.length > 0 && (
              <table className="laps-table">
                <thead>
                  <tr>
                    <th>Zone</th>
                    <th>Best angle</th>
                    <th>Score</th>
                    <th>Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {r.zones.map((z) => (
                    <tr key={z.name}>
                      <td>{z.name}</td>
                      <td>{Math.round(z.bestAngle)}°</td>
                      <td>{fmtScore(z.score)}</td>
                      <td>{z.grade}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="fb">
            {r.feedback && (
              <>
                <p style={{ margin: 0, fontSize: 16, lineHeight: 1.45 }}>{r.feedback.headline}</p>
                {r.feedback.suggestions.length > 0 && (
                  <>
                    <h4>Try this next</h4>
                    <ul>
                      {r.feedback.suggestions.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                {r.feedback.strengths.length > 0 && (
                  <>
                    <h4>Going well</h4>
                    <ul>
                      {r.feedback.strengths.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                {r.feedback.incidents.length > 0 && (
                  <>
                    <h4>Incidents</h4>
                    <ul className="muted">
                      {r.feedback.incidents.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                {r.feedback.corners.length > 0 && (
                  <>
                    <h4>Corner by corner (min speed vs reference)</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "4px 14px", fontSize: 13 }}>
                      {r.feedback.corners.map((c) => (
                        <span key={c.short} className="spread">
                          <span className="muted">
                            {c.short} {c.offRoad ? "⚠" : ""}
                          </span>
                          <span className="mono" style={{ color: c.minKmh >= c.refMinKmh * 0.95 ? "var(--good)" : c.minKmh < c.refMinKmh * 0.85 ? "var(--warm)" : "var(--text)" }}>
                            {c.minKmh}/{c.refMinKmh}
                          </span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {!r.feedback && lesson && (
              <>
                <h4>What you practised</h4>
                <ul>
                  {EVENTS.find((e) => e.id === r.eventId)?.summary && <li>{EVENTS.find((e) => e.id === r.eventId)!.summary}</li>}
                </ul>
              </>
            )}
            {state.newUnlocks.length > 0 && <div className="unlock-note" style={{ marginTop: 14 }}>Unlocked: {state.newUnlocks.join(", ")}</div>}
          </div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn ghost" onClick={() => game.quitToMenu()}>
            Events
          </button>
          {next && (
            <button
              className="btn"
              onClick={() => {
                game.selectEvent(next.id);
                game.go("briefing");
              }}
            >
              Next: {next.name}
            </button>
          )}
          <button className="btn primary" autoFocus onClick={() => game.restart()}>
            Retry <span className="kbd" style={{ background: "rgba(0,0,0,0.15)", borderColor: "rgba(0,0,0,0.2)" }}>R</span>
          </button>
        </div>
      </div>
    </div>
  );
}
