"use client";

import { useEffect, useState } from "react";

function detectTouch() {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const fine = window.matchMedia?.("(pointer: fine)").matches ?? false;
  return coarse || (navigator.maxTouchPoints > 0 && !fine);
}

/** True on touch-first devices (phones, tablets). Switches with the last input used. */
export function useIsTouch() {
  const [touch, setTouch] = useState(detectTouch);
  useEffect(() => {
    const onTouch = () => setTouch(true);
    const onKey = () => setTouch(false);
    window.addEventListener("touchstart", onTouch, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("touchstart", onTouch);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return touch;
}
