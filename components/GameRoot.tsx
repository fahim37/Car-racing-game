"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Game, UIState } from "@/game/Game";
import { UI } from "./ui/UI";

export default function GameRoot() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);

  useEffect(() => {
    let g: Game | null = null;
    let cancelled = false;
    (async () => {
      const { Game } = await import("@/game/Game");
      if (cancelled || !canvasRef.current) return;
      g = await Game.create(canvasRef.current);
      if (cancelled) {
        g.dispose();
        return;
      }
      (window as unknown as { __game?: Game }).__game = g;
      setGame(g);
    })();
    return () => {
      cancelled = true;
      g?.dispose();
    };
  }, []);

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />
      {game ? <Connected game={game} /> : <div className="loading-screen"><div className="loading-title">Larchmere</div></div>}
    </div>
  );
}

function Connected({ game }: { game: Game }) {
  const state = useSyncExternalStore(game.store.subscribe, game.store.get, game.store.get) as UIState;
  return <UI game={game} state={state} />;
}
