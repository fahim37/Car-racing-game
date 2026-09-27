"use client";

import type { Game, UIState } from "@/game/Game";
import { EVENTS, EventDef, STAGE_LABEL, Stage, isUnlocked } from "@/game/session/events";
import { KIND_LABEL, Medal, fmtScore, fmtTime } from "./common";

const FILTERS: { id: UIState["eventsFilter"]; label: string; match: (e: EventDef) => boolean }[] = [
  { id: "all", label: "All events", match: () => true },
  { id: "academy", label: "Driving Academy", match: (e) => e.kind === "lesson" },
  { id: "time", label: "Time Trials", match: (e) => e.kind === "timeTrial" || e.kind === "sprint" },
  { id: "drift", label: "Drift", match: (e) => e.kind === "drift" || e.id === "lesson-drift" || e.id === "lesson-linking" },
  { id: "mastery", label: "Mastery", match: (e) => e.kind === "mastery" },
];

export function EventsScreen({ game, state }: { game: Game; state: UIState }) {
  const p = game.profile;
  const filter = FILTERS.find((f) => f.id === state.eventsFilter) ?? FILTERS[0];
  const list = EVENTS.filter((e) => e.kind !== "free" && filter.match(e));
  const stages: Stage[] = ["beginner", "intermediate", "advanced", "expert"];
  const best = (e: EventDef) => {
    let b: number | null = null;
    for (const [k, r] of Object.entries(p.records)) {
      if (!k.startsWith(e.id + "|")) continue;
      if (b === null || (e.kind === "drift" ? r.best > b : r.best < b)) b = r.best;
    }
    return b;
  };
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={() => game.go("title")} aria-label="Back to title">
          ←
        </button>
        <h2>Events</h2>
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={f.id === filter.id} className={`tab ${f.id === filter.id ? "active" : ""}`} onClick={() => game.store.set({ eventsFilter: f.id })}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="screen-body">
        {stages.map((stage) => {
          const evs = list.filter((e) => e.stage === stage);
          if (!evs.length) return null;
          return (
            <section className="stage-group" key={stage}>
              <h3>{STAGE_LABEL[stage]}</h3>
              <div className="card-grid">
                {evs.map((e) => {
                  const open = isUnlocked(e, p);
                  const b = best(e);
                  const medal = p.medals[e.id];
                  const done = p.completed[e.id];
                  return (
                    <button
                      key={e.id}
                      className={`event-card ${open ? "" : "locked"}`}
                      onClick={() => {
                        if (!open) return;
                        game.selectEvent(e.id);
                        game.go("briefing");
                      }}
                      aria-disabled={!open}
                    >
                      <span className="kind">{KIND_LABEL[e.kind]}</span>
                      <h4>{e.name}</h4>
                      <p>{open ? e.summary : `Locked. ${e.unlockText ?? ""}`}</p>
                      <div className="foot">
                        {e.kind === "lesson" ? (
                          <span>{done ? "✓ Completed" : open ? "Not yet completed" : "🔒"}</span>
                        ) : (
                          <>
                            <Medal m={medal} />
                            <span>{b === null ? (open ? "No record yet" : "🔒") : e.kind === "drift" ? `Best ${fmtScore(b)} pts` : `Best ${fmtTime(b)}`}</span>
                          </>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
        <p className="faint" style={{ fontSize: 13, maxWidth: 640, lineHeight: 1.5 }}>
          Physics are the same everywhere: events get harder through the road, the car, the conditions and the targets. Records are kept separately per car class and assist level, so every comparison is fair.
        </p>
      </div>
    </div>
  );
}
