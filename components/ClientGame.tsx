"use client";

import dynamic from "next/dynamic";

// WebGL, Web Audio and input all need the browser: skip prerendering the game itself.
const GameRoot = dynamic(() => import("./GameRoot"), {
  ssr: false,
  loading: () => (
    <div className="loading-screen">
      <div className="loading-title">Larchmere</div>
    </div>
  ),
});

export default function ClientGame() {
  return <GameRoot />;
}
