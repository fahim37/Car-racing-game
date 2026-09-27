type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** Must run from a tap/click: browsers require user activation for fullscreen. */
export async function requestGameFullscreen(): Promise<boolean> {
  const root = document.querySelector<FullscreenElement>(".game-root");
  if (!root) return false;
  try {
    if (document.fullscreenElement) return true;
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
    else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    // The responsive viewport still fills the available space when fullscreen is unavailable.
    return false;
  }
}
