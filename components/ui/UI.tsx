"use client";

import type { Game, UIState } from "@/game/Game";
import { Briefing } from "./Briefing";
import { EventsScreen } from "./EventsScreen";
import { Garage } from "./Garage";
import { Help } from "./Help";
import { Hud } from "./Hud";
import { PauseMenu } from "./PauseMenu";
import { ResultsView } from "./Results";
import { SettingsView } from "./Settings";
import { Title } from "./Title";
import { TouchControls } from "./TouchControls";
import { useIsTouch } from "./useIsTouch";
import { MultiplayerHud, MultiplayerLobby } from "./Multiplayer";

export function UI({ game, state }: { game: Game; state: UIState }) {
  const touch = useIsTouch();
  const s = state.screen;
  return (
    <div className="layer">
      {s === "loading" && (
        <div className="loading-screen">
          <div className="loading-title">Larchmere</div>
          <div className="loading-bar" role="progressbar" aria-valuenow={Math.round(state.loadProgress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${state.loadProgress * 100}%` }} />
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {state.loadLabel}
          </div>
        </div>
      )}
      {s === "error" && (
        <div className="loading-screen">
          <div className="loading-title">Larchmere</div>
          <p className="muted" style={{ maxWidth: 480, textAlign: "center", lineHeight: 1.5 }}>
            The game could not start ({state.error}). If this keeps happening, try an up-to-date Chrome, Edge, Firefox or Safari with hardware acceleration enabled.
          </p>
          <button className="btn" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      )}
      {s === "title" && <Title game={game} />}
      {s === "events" && <EventsScreen game={game} state={state} />}
      {s === "briefing" && <Briefing game={game} state={state} />}
      {s === "garage" && <Garage game={game} state={state} />}
      {s === "multiplayer" && <MultiplayerLobby game={game} />}
      {s === "driving" && (
        <>
          <Hud game={game} touch={touch} />
          {!state.paused && <MultiplayerHud game={game} />}
          {touch && !state.paused && !state.showResults && <TouchControls game={game} />}
          {!touch && !state.paused && !state.showResults && (
            <div className="drive-btns">
              <button className="icon-btn" aria-label="Back to menu" title="Back to menu" onClick={() => game.back()}>
                ←
              </button>
              <button className="icon-btn" aria-label="Pause" title="Pause (Esc)" onClick={() => game.pause()}>
                ❚❚
              </button>
            </div>
          )}
          {state.paused && !state.settingsOpen && !state.helpOpen && <PauseMenu game={game} />}
          {state.showResults && state.results && <ResultsView game={game} state={state} />}
        </>
      )}
      {state.settingsOpen && <SettingsView game={game} />}
      {state.helpOpen && <Help game={game} />}
      {state.busy && <div className="busy panel">{state.busy}…</div>}
      {state.cameraLabel && s === "driving" && (
        <div className="toast" style={{ position: "absolute", left: "50%", bottom: "22%", transform: "translateX(-50%)" }}>
          Camera: {state.cameraLabel}
        </div>
      )}
    </div>
  );
}
