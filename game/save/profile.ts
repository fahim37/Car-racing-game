import { CameraMode } from "../render/CameraRig";
import { DEFAULT_INPUT_SETTINGS, InputSettings } from "../input/Input";
import { AssistLevel, DrivingAssists } from "../physics/Vehicle";

export type Quality = "low" | "medium" | "high" | "ultra";
export type Medal = "bronze" | "silver" | "gold";
export type AssistPreset = "beginner" | "intermediate" | "expert" | "custom";

export interface Settings {
  assistPreset: AssistPreset;
  assists: DrivingAssists;
  learning: { racingLine: 0 | 1 | 2; inputDisplay: boolean; tips: boolean; brakeBoards: boolean };
  camera: { mode: CameraMode; fov: number; speedFov: number; shake: number; motionBlur: number };
  graphics: { quality: Quality; resolutionScale: number; dynamicResolution: boolean };
  audio: { master: number; engine: number; effects: number; ambience: number; music: number };
  input: InputSettings;
  units: "kmh" | "mph";
  hud: { minimap: boolean; delta: boolean };
  unlockAll: boolean;
  paint: Record<string, string>;
  lastCar: string;
}

export interface LapRecord {
  time: number;
  sectors: number[];
  /** Elapsed time at every 10 m of the lap, for delta and feedback against the best lap. */
  splits: number[];
  date: number;
  carId: string;
  assists: string;
}

export interface EventRecord {
  best: number; // time (lower better) or score (higher better)
  lap?: LapRecord;
  medal: Medal | null;
  date: number;
  attempts: number;
}

export interface Profile {
  version: 1;
  settings: Settings;
  /** Key: eventId|classId|assistTier */
  records: Record<string, EventRecord>;
  /** Best medal per event regardless of car/assists (drives unlocks). */
  medals: Record<string, Medal>;
  completed: Record<string, boolean>;
  stats: { distance: number; driveTime: number; events: number };
}

export const ASSIST_PRESETS: Record<Exclude<AssistPreset, "custom">, { assists: DrivingAssists; racingLine: 0 | 1 | 2 }> = {
  beginner: {
    assists: { abs: true, tc: "full", esc: "full", autoGear: true, steerSpeedSensitivity: 0.85, steerRate: 1 },
    racingLine: 2,
  },
  intermediate: {
    assists: { abs: true, tc: "sport", esc: "sport", autoGear: true, steerSpeedSensitivity: 0.7, steerRate: 1 },
    racingLine: 1,
  },
  expert: {
    assists: { abs: false, tc: "off", esc: "off", autoGear: false, steerSpeedSensitivity: 0.55, steerRate: 1.1 },
    racingLine: 0,
  },
};

export function isTouchDevice() {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
}

/** Graphics adapter name, where the browser exposes it. */
export function gpuName(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return (ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "") || "";
  } catch {
    return "";
  }
}

/**
 * Starting quality: High on dedicated graphics, Medium on integrated/mobile GPUs (which still
 * looks good and holds 60 fps there). Players can raise it in Settings at any time.
 */
function defaultQuality(): Quality {
  if (typeof window === "undefined") return "high";
  const mobile = isTouchDevice() && Math.min(window.screen.width, window.screen.height) < 900;
  if (mobile) return "medium";
  const gpu = gpuName();
  if (/Intel|UHD|Iris|HD Graphics|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i.test(gpu)) return "medium";
  return "high";
}

export function defaultSettings(): Settings {
  return {
    assistPreset: "beginner",
    assists: { ...ASSIST_PRESETS.beginner.assists },
    learning: { racingLine: 2, inputDisplay: false, tips: true, brakeBoards: true },
    camera: { mode: "chase", fov: 62, speedFov: 4, shake: 0.35, motionBlur: 0 },
    graphics: { quality: defaultQuality(), resolutionScale: 1, dynamicResolution: true },
    audio: { master: 0.85, engine: 0.9, effects: 0.8, ambience: 0.7, music: 0.35 },
    input: { ...DEFAULT_INPUT_SETTINGS, keys: { ...DEFAULT_INPUT_SETTINGS.keys } },
    units: "kmh",
    hud: { minimap: true, delta: true },
    unlockAll: false,
    paint: {},
    lastCar: "meridian",
  };
}

const KEY = "larchmere.profile.v1";
const GHOST_PREFIX = "larchmere.ghost.";

export function assistTier(a: DrivingAssists): "assisted" | "sport" | "pro" {
  if (a.esc !== "off") return "assisted";
  if (a.tc !== "off" || a.abs) return "sport";
  return "pro";
}

export const TIER_LABEL = { assisted: "Assisted", sport: "Sport", pro: "Pro (no aids)" } as const;

export function describeAssist(level: AssistLevel) {
  return level === "off" ? "Off" : level === "sport" ? "Sport" : "Full";
}

function merge<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return (over as T) ?? base;
  const out = { ...(base as Record<string, unknown>) };
  if (over && typeof over === "object") {
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, v) : v;
    }
  }
  return out as T;
}

export function loadProfile(): Profile {
  const fresh: Profile = { version: 1, settings: defaultSettings(), records: {}, medals: {}, completed: {}, stats: { distance: 0, driveTime: 0, events: 0 } };
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return merge(fresh, parsed);
  } catch {
    return fresh;
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode); progress lasts for this session only */
  }
}

export function saveGhost(key: string, data: string) {
  try {
    localStorage.setItem(GHOST_PREFIX + key, data);
    return true;
  } catch {
    return false;
  }
}

export function clearGhosts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(GHOST_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}

export function loadGhost(key: string): string | null {
  try {
    return localStorage.getItem(GHOST_PREFIX + key);
  } catch {
    return null;
  }
}

export const MEDAL_RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3 };

export function betterMedal(a: Medal | null | undefined, b: Medal | null | undefined): Medal | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return MEDAL_RANK[a] >= MEDAL_RANK[b] ? a : b;
}
