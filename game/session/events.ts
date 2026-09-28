import { Conditions } from "../render/Environment";
import { DrivingAssists } from "../physics/Vehicle";
import { Medal, Profile, betterMedal, MEDAL_RANK } from "../save/profile";

export type EventKind = "free" | "lesson" | "timeTrial" | "sprint" | "drift" | "mastery";
export type Stage = "beginner" | "intermediate" | "advanced" | "expert";

export interface UnlockRule {
  event: string;
  medal?: Medal; // required medal, or completion if omitted
}

export interface EventDef {
  id: string;
  name: string;
  kind: EventKind;
  stage: Stage;
  summary: string;
  objective: string;
  conditions: Conditions;
  laps?: number;
  /** Point-to-point: start and finish stations (metres along the loop). Resolved at runtime. */
  sprint?: { from: string; to: string; fromOffset: number; toOffset: number };
  /** Medal targets. For timed events these are multipliers of the car's reference time. */
  targetFactors?: [number, number, number];
  /** Drift events: score targets. */
  scoreTargets?: [number, number, number];
  /** Aids that are capped in this event (dedicated challenges). */
  assistCap?: Partial<Pick<DrivingAssists, "esc" | "tc" | "abs">>;
  lesson?: string;
  unlock: UnlockRule[]; // any one rule unlocks; empty = open
  unlockText?: string;
  recommendedCar?: string;
}

export const EVENTS: EventDef[] = [
  {
    id: "free",
    name: "Free Drive",
    kind: "free",
    stage: "beginner",
    summary: "The whole valley, no timer. Explore the loop, practise a corner, or slide around the paddock pad.",
    objective: "No objectives. Choose any time of day and weather.",
    conditions: { time: "morning", weather: "dry" },
    unlock: [],
  },
  {
    id: "lesson-steering",
    name: "Smooth Hands",
    kind: "lesson",
    stage: "beginner",
    summary: "Accelerate, steer and stop. Learn how gentle, early inputs keep the car settled.",
    objective: "Follow the line through the Lakeshore Sweep and stop in the marked zone.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "steering",
    unlock: [],
  },
  {
    id: "lesson-braking",
    name: "Brake Before You Turn",
    kind: "lesson",
    stage: "beginner",
    summary: "Do the braking in a straight line, then turn. The distance boards show where.",
    objective: "Reach Larch Bend at the right speed and take it cleanly.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "braking",
    unlock: [],
  },
  {
    id: "lesson-exits",
    name: "Patient Throttle",
    kind: "lesson",
    stage: "beginner",
    summary: "The exit matters more than the entry. Wait for the car to straighten, then squeeze the power on.",
    objective: "Carry a strong exit speed out of Heron Turn without sliding.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "exits",
    unlock: [],
  },
  {
    id: "tt-morning",
    name: "Lakeshore Time Trial",
    kind: "timeTrial",
    stage: "beginner",
    summary: "Three flying laps of the Larchmere loop in the still morning air. Your best lap counts.",
    objective: "Set your best lap. Leaving the road for more than a moment invalidates the lap.",
    conditions: { time: "morning", weather: "dry" },
    laps: 3,
    targetFactors: [1.32, 1.17, 1.09],
    unlock: [],
    recommendedCar: "meridian",
  },
  {
    id: "lesson-trail",
    name: "Trail Braking",
    kind: "lesson",
    stage: "intermediate",
    summary: "Keep a little brake on as you turn in. The weight on the front tyres helps the car rotate.",
    objective: "Trail the brakes into the Pine Hairpin and exit cleanly.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "trail",
    unlock: [{ event: "lesson-braking" }, { event: "tt-morning", medal: "bronze" }],
    unlockText: "Complete Brake Before You Turn, or take bronze in the Lakeshore Time Trial.",
  },
  {
    id: "lesson-slides",
    name: "Catching Slides",
    kind: "lesson",
    stage: "intermediate",
    summary: "The rear will step out. Look where you want to go, steer into the slide and ease the throttle.",
    objective: "Recover three slides on the paddock pad without spinning. Stability aid is off here.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "slides",
    assistCap: { esc: "off", tc: "off" },
    unlock: [{ event: "lesson-exits" }, { event: "tt-morning", medal: "bronze" }],
    unlockText: "Complete Patient Throttle, or take bronze in the Lakeshore Time Trial.",
  },
  {
    id: "sprint-forest",
    name: "Fern Esses Sprint",
    kind: "sprint",
    stage: "intermediate",
    summary: "A standing start up through the linked esses, over the crest and down into the hairpin.",
    objective: "Beat the target time from Larch Bend to Mill Corner.",
    conditions: { time: "morning", weather: "dry" },
    sprint: { from: "T2", fromOffset: 45, to: "T7", toOffset: 60 },
    targetFactors: [1.3, 1.15, 1.08],
    unlock: [{ event: "tt-morning", medal: "bronze" }],
    unlockText: "Take bronze in the Lakeshore Time Trial.",
  },
  {
    id: "lesson-drift",
    name: "Drift Basics",
    kind: "lesson",
    stage: "intermediate",
    summary: "Break the rear loose with throttle or a handbrake tap, then balance angle with steering and throttle.",
    objective: "Hold four seconds of controlled drift around the cones.",
    conditions: { time: "morning", weather: "dry" },
    lesson: "drift",
    assistCap: { esc: "off", tc: "off" },
    unlock: [{ event: "lesson-slides" }, { event: "tt-morning", medal: "bronze" }],
    unlockText: "Complete Catching Slides, or take bronze in the Lakeshore Time Trial.",
    recommendedCar: "meridian",
  },
  {
    id: "drift-lakeside",
    name: "Lakeside Drift Challenge",
    kind: "drift",
    stage: "intermediate",
    summary: "From the crest down to the lake: four scored zones. Angle, speed, commitment and a clean exit.",
    objective: "Score in the marked zones. Spins, walls and leaving the road cost you the combo.",
    conditions: { time: "afternoon", weather: "dry" },
    sprint: { from: "T6", fromOffset: -260, to: "T12", toOffset: 120 },
    scoreTargets: [9000, 20000, 34000],
    assistCap: { esc: "off" },
    unlock: [{ event: "lesson-drift" }, { event: "tt-morning", medal: "bronze" }],
    unlockText: "Complete Drift Basics, or take bronze in the Lakeshore Time Trial.",
    recommendedCar: "meridian",
  },
  {
    id: "tt-afternoon",
    name: "Golden Hour Hot Laps",
    kind: "timeTrial",
    stage: "advanced",
    summary: "Low sun, long shadows and tighter targets. The stability aid is limited to Sport.",
    objective: "Set your best lap. Tighter targets than the morning trial.",
    conditions: { time: "afternoon", weather: "dry" },
    laps: 3,
    targetFactors: [1.24, 1.12, 1.06],
    assistCap: { esc: "sport" },
    unlock: [{ event: "tt-morning", medal: "silver" }],
    unlockText: "Take silver in the Lakeshore Time Trial.",
  },
  {
    id: "lesson-linking",
    name: "Linking Drifts",
    kind: "lesson",
    stage: "advanced",
    summary: "Swing the car from one slide into the next: a figure-eight around the two cone circles.",
    objective: "Make two clean transitions from one drift direction to the other.",
    conditions: { time: "afternoon", weather: "dry" },
    lesson: "linking",
    assistCap: { esc: "off", tc: "off" },
    unlock: [{ event: "drift-lakeside", medal: "bronze" }],
    unlockText: "Take bronze in the Lakeside Drift Challenge.",
  },
  {
    id: "tt-rain",
    name: "Dusk Rain Trial",
    kind: "timeTrial",
    stage: "advanced",
    summary: "Wet asphalt at dusk. Less grip, longer braking, slippery kerbs. Smoothness is speed.",
    objective: "Three laps in the wet. Your best lap counts.",
    conditions: { time: "dusk", weather: "wet" },
    laps: 3,
    targetFactors: [1.28, 1.15, 1.08],
    unlock: [{ event: "tt-afternoon", medal: "bronze" }, { event: "tt-morning", medal: "gold" }],
    unlockText: "Take bronze in Golden Hour Hot Laps, or gold in the Lakeshore Time Trial.",
  },
  {
    id: "mastery-loop",
    name: "Lakeside Mastery",
    kind: "mastery",
    stage: "expert",
    summary: "Three consecutive clean laps, every one under the target. No stability aid. Consistency is the test.",
    objective: "Chain three clean laps. Your medal is set by the slowest of the three.",
    conditions: { time: "morning", weather: "dry" },
    laps: 6,
    targetFactors: [1.16, 1.09, 1.045],
    assistCap: { esc: "off" },
    unlock: [{ event: "tt-morning", medal: "gold" }, { event: "tt-rain", medal: "silver" }],
    unlockText: "Take gold in the Lakeshore Time Trial, or silver in the Dusk Rain Trial.",
  },
  {
    id: "drift-dusk",
    name: "Twilight Drift Masters",
    kind: "drift",
    stage: "expert",
    summary: "The same four zones at dusk with every aid off. Higher targets, no forgiveness.",
    objective: "Score in the marked zones with no stability or traction control.",
    conditions: { time: "dusk", weather: "dry" },
    sprint: { from: "T6", fromOffset: -260, to: "T12", toOffset: 120 },
    scoreTargets: [18000, 32000, 46000],
    assistCap: { esc: "off", tc: "off" },
    unlock: [{ event: "drift-lakeside", medal: "gold" }, { event: "lesson-linking" }],
    unlockText: "Take gold in the Lakeside Drift Challenge, or complete Linking Drifts.",
  },
];

export const STAGE_LABEL: Record<Stage, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
};

export const eventById = (id: string) => EVENTS.find((e) => e.id === id) ?? EVENTS[0];

export function isUnlocked(ev: EventDef, profile: Profile) {
  if (profile.settings.unlockAll || ev.unlock.length === 0) return true;
  return ev.unlock.some((r) => {
    if (!r.medal) return !!profile.completed[r.event] || !!profile.medals[r.event];
    const m = profile.medals[r.event];
    return !!m && MEDAL_RANK[m] >= MEDAL_RANK[r.medal];
  });
}

export interface CarUnlock {
  carId: string;
  rule: UnlockRule[];
  text: string;
}

/** Every car is open from the start. */
export const CAR_UNLOCKS: CarUnlock[] = [
  { carId: "meridian", rule: [], text: "" },
  { carId: "vela", rule: [], text: "" },
  { carId: "strale", rule: [], text: "" },
  { carId: "brute", rule: [], text: "" },
  { carId: "nocturne", rule: [], text: "" },
  { carId: "volterra", rule: [], text: "" },
];

export function isCarUnlocked(carId: string, profile: Profile) {
  const u = CAR_UNLOCKS.find((c) => c.carId === carId);
  if (!u || profile.settings.unlockAll || u.rule.length === 0) return true;
  return u.rule.some((r) => {
    const m = profile.medals[r.event];
    return !!m && (!r.medal || MEDAL_RANK[m] >= MEDAL_RANK[r.medal]);
  });
}

export function medalFor(ev: EventDef, value: number, targets: [number, number, number]): Medal | null {
  const lowerBetter = ev.kind !== "drift";
  const [b, s, g] = targets;
  if (lowerBetter) return value <= g ? "gold" : value <= s ? "silver" : value <= b ? "bronze" : null;
  return value >= g ? "gold" : value >= s ? "silver" : value >= b ? "bronze" : null;
}

export { betterMedal };
