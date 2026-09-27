import { DriverControls } from "../physics/Vehicle";
import { clamp } from "../util/math";

export type Action =
  | "throttle"
  | "brake"
  | "left"
  | "right"
  | "handbrake"
  | "shiftUp"
  | "shiftDown"
  | "camera"
  | "pause"
  | "restart"
  | "reset"
  | "lookBack";

export const ACTION_LABELS: Record<Action, string> = {
  throttle: "Accelerate",
  brake: "Brake / reverse",
  left: "Steer left",
  right: "Steer right",
  handbrake: "Handbrake",
  shiftUp: "Shift up",
  shiftDown: "Shift down",
  camera: "Change camera",
  pause: "Pause",
  restart: "Quick restart",
  reset: "Reset car to road",
  lookBack: "Look back",
};

export const DEFAULT_KEYS: Record<Action, string[]> = {
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  handbrake: ["Space"],
  shiftUp: ["KeyE", "ShiftLeft"],
  shiftDown: ["KeyQ", "ControlLeft"],
  camera: ["KeyC"],
  pause: ["Escape", "KeyP"],
  restart: ["KeyR"],
  reset: ["Backspace", "KeyT"],
  lookBack: ["KeyB"],
};

export const GAMEPAD_LABELS: Partial<Record<Action, string>> = {
  throttle: "RT",
  brake: "LT",
  left: "Left stick",
  right: "Left stick",
  handbrake: "A",
  shiftUp: "B",
  shiftDown: "X",
  camera: "Y",
  pause: "Start / Menu",
  restart: "Hold View",
  reset: "View",
  lookBack: "LB",
};

export interface WheelCalibration {
  index: number; // gamepad index
  steerAxis: number;
  steerInvert: boolean;
  throttleAxis: number;
  throttleRest: number;
  throttleFull: number;
  brakeAxis: number;
  brakeRest: number;
  brakeFull: number;
  rotation: number; // degrees of wheel rotation mapped to full lock (for scaling)
}

export interface InputSettings {
  keys: Record<Action, string[]>;
  deadzone: number; // gamepad stick
  steerCurve: number; // 1 = linear, >1 = finer control near centre
  touchSteer: "slide" | "tilt" | "buttons";
  tiltSensitivity: number;
  wheel: WheelCalibration | null;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  keys: DEFAULT_KEYS,
  deadzone: 0.08,
  steerCurve: 1.6,
  touchSteer: "slide",
  tiltSensitivity: 1,
  wheel: null,
};

export type InputSource = "keyboard" | "gamepad" | "wheel" | "touch";

/** Touch controls write into this from the on-screen overlay. */
export interface TouchState {
  active: boolean;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
}

const EDGE_ACTIONS: Action[] = ["shiftUp", "shiftDown", "camera", "pause", "restart", "reset"];

export class Input {
  settings: InputSettings = { ...DEFAULT_INPUT_SETTINGS };
  source: InputSource = "keyboard";
  readonly touch: TouchState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: 0 };
  private keys = new Set<string>();
  private pressedEdges = new Set<Action>();
  private padPrev: boolean[] = [];
  private viewHeld = 0;
  private tilt = 0;
  private tiltEnabled = false;
  lookBack = false;
  /** Called with a key code while the UI is capturing a new binding. */
  captureKey: ((code: string) => void) | null = null;
  private listeners: (() => void)[] = [];

  attach(target: Window) {
    const down = (e: KeyboardEvent) => {
      if (this.captureKey) {
        e.preventDefault();
        const cb = this.captureKey;
        this.captureKey = null;
        cb(e.code);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const action = this.actionFor(e.code);
      if (action) {
        e.preventDefault();
        if (!this.keys.has(e.code) && EDGE_ACTIONS.includes(action)) this.pressedEdges.add(action);
      }
      this.keys.add(e.code);
      this.source = "keyboard";
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    };
    const blur = () => this.keys.clear();
    const orient = (e: DeviceOrientationEvent) => {
      if (!this.tiltEnabled) return;
      // Landscape: the device's beta axis becomes the steering axis.
      const angle = typeof screen !== "undefined" && screen.orientation ? screen.orientation.angle : 0;
      const raw = angle === 90 ? e.beta ?? 0 : angle === 270 || angle === -90 ? -(e.beta ?? 0) : e.gamma ?? 0;
      this.tilt = clamp((raw / 28) * this.settings.tiltSensitivity, -1, 1);
    };
    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    target.addEventListener("blur", blur);
    target.addEventListener("deviceorientation", orient);
    this.listeners.push(() => {
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
      target.removeEventListener("blur", blur);
      target.removeEventListener("deviceorientation", orient);
    });
  }

  /** Touch overlay updates (methods, so UI code never mutates engine state directly). */
  setTouch(p: Partial<TouchState>) {
    Object.assign(this.touch, p);
    if (p.active) this.source = "touch";
  }

  /** Captures the next key press for rebinding (Escape cancels). */
  beginKeyCapture(cb: (code: string) => void) {
    this.captureKey = cb;
  }

  detach() {
    this.listeners.forEach((f) => f());
    this.listeners = [];
  }

  /** iOS needs an explicit permission request from a user gesture. */
  async enableTilt() {
    const DOE = (globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    try {
      if (DOE?.requestPermission) {
        const res = await DOE.requestPermission();
        this.tiltEnabled = res === "granted";
      } else this.tiltEnabled = true;
    } catch {
      this.tiltEnabled = false;
    }
    return this.tiltEnabled;
  }

  disableTilt() {
    this.tiltEnabled = false;
    this.tilt = 0;
  }

  private actionFor(code: string): Action | null {
    for (const [a, codes] of Object.entries(this.settings.keys) as [Action, string[]][]) if (codes.includes(code)) return a;
    return null;
  }

  private key(a: Action) {
    for (const c of this.settings.keys[a]) if (this.keys.has(c)) return true;
    return false;
  }

  /** Consumes a one-shot action (camera, pause, ...). */
  consume(a: Action) {
    const had = this.pressedEdges.has(a);
    this.pressedEdges.delete(a);
    return had;
  }

  clearEdges() {
    this.pressedEdges.clear();
  }

  /** Samples all devices; call once per frame. */
  poll(out: DriverControls, dt: number) {
    let steer = 0;
    let throttle = 0;
    let brake = 0;
    let handbrake = 0;
    let digitalSteer = true;
    let digitalPedals = true;

    // Keyboard
    const kSteer = (this.key("right") ? 1 : 0) - (this.key("left") ? 1 : 0);
    const kThr = this.key("throttle") ? 1 : 0;
    const kBrk = this.key("brake") ? 1 : 0;
    const kHb = this.key("handbrake") ? 1 : 0;
    this.lookBack = this.key("lookBack");

    // Gamepads (first connected standard pad) and optional calibrated wheel
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    let padUsed = false;
    let wheelUsed = false;
    const wheel = this.settings.wheel;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (wheel && pad.index === wheel.index) {
        const s = pad.axes[wheel.steerAxis] ?? 0;
        const t = axisPedal(pad.axes[wheel.throttleAxis] ?? wheel.throttleRest, wheel.throttleRest, wheel.throttleFull);
        const b = axisPedal(pad.axes[wheel.brakeAxis] ?? wheel.brakeRest, wheel.brakeRest, wheel.brakeFull);
        if (Math.abs(s) > 0.02 || t > 0.02 || b > 0.02) {
          wheelUsed = true;
          this.source = "wheel";
        }
        if (this.source === "wheel") {
          steer = clamp((wheel.steerInvert ? -s : s) * (900 / Math.max(180, wheel.rotation)), -1, 1);
          throttle = t;
          brake = b;
          digitalSteer = false;
          digitalPedals = false;
        }
        this.handleButtons(pad, 0, dt);
        continue;
      }
      if (pad.mapping !== "standard") continue;
      const ax = pad.axes[0] ?? 0;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const a = pad.buttons[0]?.value ?? 0;
      const dz = this.settings.deadzone;
      const stick = Math.abs(ax) < dz ? 0 : (Math.sign(ax) * (Math.abs(ax) - dz)) / (1 - dz);
      if (Math.abs(stick) > 0 || rt > 0.05 || lt > 0.05 || a > 0.5 || pad.buttons.some((b) => b.pressed)) {
        padUsed = true;
        if (this.source !== "wheel") this.source = "gamepad";
      }
      if (this.source === "gamepad") {
        steer = Math.sign(stick) * Math.pow(Math.abs(stick), this.settings.steerCurve);
        throttle = rt;
        brake = lt;
        handbrake = a;
        digitalSteer = false;
        digitalPedals = false;
        this.lookBack = this.lookBack || (pad.buttons[4]?.pressed ?? false);
      }
      this.handleButtons(pad, 1, dt);
      break;
    }
    void padUsed;
    void wheelUsed;

    // Touch overlay
    if (this.touch.active && (this.source === "touch" || Math.abs(this.touch.steer) > 0 || this.touch.throttle > 0 || this.touch.brake > 0)) {
      this.source = "touch";
    }
    if (this.source === "touch") {
      steer = this.settings.touchSteer === "tilt" ? this.tilt : this.touch.steer;
      throttle = this.touch.throttle;
      brake = this.touch.brake;
      handbrake = this.touch.handbrake;
      digitalSteer = this.settings.touchSteer === "buttons";
      digitalPedals = true;
    }

    // Keyboard always works and takes over while used.
    if (kSteer !== 0 || kThr || kBrk || kHb) {
      if (this.source !== "keyboard" && (kSteer !== 0 || kThr || kBrk)) this.source = "keyboard";
    }
    if (this.source === "keyboard") {
      steer = kSteer;
      throttle = kThr;
      brake = kBrk;
      handbrake = kHb;
      digitalSteer = true;
      digitalPedals = true;
    } else {
      handbrake = Math.max(handbrake, kHb);
    }

    out.steer = clamp(steer, -1, 1);
    out.throttle = clamp(throttle, 0, 1);
    out.brake = clamp(brake, 0, 1);
    out.handbrake = clamp(handbrake, 0, 1);
    out.digitalSteer = digitalSteer;
    out.digitalPedals = digitalPedals;
    if (this.consume("shiftUp")) out.shiftUp = true;
    if (this.consume("shiftDown")) out.shiftDown = true;
  }

  /** Standard-pad buttons to one-shot actions. `kind` 1 = standard mapping. */
  private handleButtons(pad: Gamepad, kind: number, dt: number) {
    const map: [number, Action][] =
      kind === 1
        ? [
            [1, "shiftUp"],
            [2, "shiftDown"],
            [3, "camera"],
            [9, "pause"],
          ]
        : [
            [4, "shiftUp"],
            [5, "shiftDown"],
            [9, "pause"],
          ];
    const prev = this.padPrev;
    for (const [bi, action] of map) {
      const pressed = pad.buttons[bi]?.pressed ?? false;
      const key = pad.index * 32 + bi;
      if (pressed && !prev[key]) this.pressedEdges.add(action);
      prev[key] = pressed;
    }
    if (kind === 1) {
      // View button: tap = reset car, hold one second = restart event.
      const view = pad.buttons[8]?.pressed ?? false;
      const key = pad.index * 32 + 8;
      if (view) {
        this.viewHeld += dt;
        if (this.viewHeld >= 1 && this.viewHeld - dt < 1) this.pressedEdges.add("restart");
      } else {
        if (prev[key] && this.viewHeld < 0.6) this.pressedEdges.add("reset");
        this.viewHeld = 0;
      }
      prev[key] = view;
    }
  }

  /** Returns connected gamepads for the settings screen. */
  static gamepads(): Gamepad[] {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
    return navigator.getGamepads().filter((p): p is Gamepad => !!p && p.connected);
  }
}

function axisPedal(v: number, rest: number, full: number) {
  if (Math.abs(full - rest) < 1e-3) return 0;
  return clamp((v - rest) / (full - rest), 0, 1);
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * Wheel calibration helper: watches every axis of a device and reports the one that moved most.
 */
export function detectAxis(baseline: number[], pad: Gamepad) {
  let best = -1;
  let delta = 0;
  pad.axes.forEach((v, i) => {
    const d = Math.abs(v - (baseline[i] ?? 0));
    if (d > delta) {
      delta = d;
      best = i;
    }
  });
  return { axis: best, delta, value: best >= 0 ? pad.axes[best] : 0 };
}
