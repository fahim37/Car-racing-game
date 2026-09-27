"use client";

import { useEffect, useRef, useState } from "react";
import type { Game } from "@/game/Game";
import { ACTION_LABELS, Action, DEFAULT_KEYS, Input, detectAxis } from "@/game/input/Input";
import { CAMERA_LABELS, CAMERA_MODES } from "@/game/render/CameraRig";
import { ASSIST_PRESETS, AssistPreset, Quality, Settings } from "@/game/save/profile";
import { Seg, Slider, Switch, keyLabel } from "./common";

type Tab = "assists" | "learning" | "controls" | "camera" | "graphics" | "audio" | "game";
const TABS: { id: Tab; label: string }[] = [
  { id: "assists", label: "Assists" },
  { id: "learning", label: "Learning" },
  { id: "controls", label: "Controls" },
  { id: "camera", label: "Camera" },
  { id: "graphics", label: "Graphics" },
  { id: "audio", label: "Audio" },
  { id: "game", label: "Game" },
];

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <span className="label">{label}</span>
      <div>{children}</div>
      {help && <span className="help">{help}</span>}
    </div>
  );
}

export function SettingsView({ game }: { game: Game }) {
  const [tab, setTab] = useState<Tab>("assists");
  const s = game.settings;
  const update = (fn: (d: Settings) => void, custom = false) => {
    const d = structuredClone(s);
    fn(d);
    if (custom) d.assistPreset = "custom";
    game.applySettings(d);
  };
  const close = () => game.store.set({ settingsOpen: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape" && !game.input.captureKey) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="overlay" style={{ zIndex: 30 }}>
      <div className="panel modal wide" role="dialog" aria-label="Settings" style={{ height: "min(760px, 100%)" }}>
        <div className="spread">
          <h2>Settings</h2>
          <button className="btn" onClick={close}>
            Done
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-grid" style={{ overflowY: "auto", flex: 1 }}>
          {tab === "assists" && (
            <>
              <Row label="Preset" help="Beginner keeps every aid on. Club gives you more freedom to slide. Expert turns everything off and uses a manual gearbox. Records are grouped by aid level so comparisons stay fair.">
                <Seg<AssistPreset>
                  label="Assist preset"
                  value={s.assistPreset}
                  options={[
                    { v: "beginner", label: "Beginner" },
                    { v: "intermediate", label: "Club" },
                    { v: "expert", label: "Expert" },
                    { v: "custom", label: "Custom" },
                  ]}
                  onChange={(v) =>
                    v !== "custom" &&
                    update((d) => {
                      d.assistPreset = v;
                      d.assists = { ...ASSIST_PRESETS[v].assists, steerSpeedSensitivity: d.assists.steerSpeedSensitivity, steerRate: d.assists.steerRate };
                      d.learning.racingLine = ASSIST_PRESETS[v].racingLine;
                    })
                  }
                />
              </Row>
              <Row label="Anti-lock brakes (ABS)" help="Stops the wheels locking when you brake hard, so you can still steer. Without it, stamping on the brake locks the wheels: the car slides straight on and stops later. Squeeze the pedal instead.">
                <Switch label="ABS" on={s.assists.abs} onChange={(v) => update((d) => (d.assists.abs = v), true)} />
              </Row>
              <Row label="Traction control (TC)" help="Cuts engine power when the driven wheels spin. Full keeps the car tidy; Sport allows some wheelspin and small slides; Off leaves the throttle entirely to you. Too much throttle without TC can spin the car.">
                <Seg
                  label="Traction control"
                  value={s.assists.tc}
                  options={[
                    { v: "off", label: "Off" },
                    { v: "sport", label: "Sport" },
                    { v: "full", label: "Full" },
                  ]}
                  onChange={(v) => update((d) => (d.assists.tc = v), true)}
                />
              </Row>
              <Row label="Stability control (ESC)" help="Brakes individual wheels and trims power when the car starts to spin or push wide. Full catches slides early; Sport lets the car rotate more before stepping in; Off means you catch every slide yourself. Drift events limit this aid.">
                <Seg
                  label="Stability control"
                  value={s.assists.esc}
                  options={[
                    { v: "off", label: "Off" },
                    { v: "sport", label: "Sport" },
                    { v: "full", label: "Full" },
                  ]}
                  onChange={(v) => update((d) => (d.assists.esc = v), true)}
                />
              </Row>
              <Row label="Gearbox" help={`Automatic shifts for you (and selects reverse when you hold the brake while stopped). Manual: shift with ${keyLabel(s.input.keys.shiftUp[0])}/${keyLabel(s.input.keys.shiftDown[0])} or B/X on a controller; useful for holding a gear through a drift.`}>
                <Seg
                  label="Gearbox"
                  value={s.assists.autoGear ? "auto" : "manual"}
                  options={[
                    { v: "auto", label: "Automatic" },
                    { v: "manual", label: "Manual" },
                  ]}
                  onChange={(v) => update((d) => (d.assists.autoGear = v === "auto"), true)}
                />
              </Row>
            </>
          )}
          {tab === "learning" && (
            <>
              <Row label="Racing line" help="Full shows the ideal line, coloured by what to do for your current speed: green accelerate, amber ease off, red brake. Braking zones only shows the line where you need to slow down. The corner advice panel shows the next corner and its typical speed.">
                <Seg
                  label="Racing line"
                  value={s.learning.racingLine}
                  options={[
                    { v: 0, label: "Off" },
                    { v: 1, label: "Braking zones" },
                    { v: 2, label: "Full" },
                  ]}
                  onChange={(v) => update((d) => (d.learning.racingLine = v as 0 | 1 | 2))}
                />
              </Row>
              <Row label="Input display" help="Shows your throttle, brake, steering and handbrake in the corner of the screen. Useful for checking you are smooth.">
                <Switch label="Input display" on={s.learning.inputDisplay} onChange={(v) => update((d) => (d.learning.inputDisplay = v))} />
              </Row>
              <Row label="Lesson tips" help="Extra coaching lines under each lesson prompt.">
                <Switch label="Lesson tips" on={s.learning.tips} onChange={(v) => update((d) => (d.learning.tips = v))} />
              </Row>
              <Row label="Route map">
                <Switch label="Route map" on={s.hud.minimap} onChange={(v) => update((d) => (d.hud.minimap = v))} />
              </Row>
              <Row label="Live delta to personal best">
                <Switch label="Live delta" on={s.hud.delta} onChange={(v) => update((d) => (d.hud.delta = v))} />
              </Row>
            </>
          )}
          {tab === "controls" && <ControlsTab game={game} update={update} />}
          {tab === "camera" && (
            <>
              <Row label="Default view" help={`Switch any time with ${keyLabel(s.input.keys.camera[0])} or Y on a controller.`}>
                <Seg
                  label="Camera"
                  value={s.camera.mode}
                  options={CAMERA_MODES.map((m) => ({ v: m, label: CAMERA_LABELS[m] }))}
                  onChange={(v) => update((d) => (d.camera.mode = v))}
                />
              </Row>
              <Row label="Field of view">
                <Slider label="Field of view" value={s.camera.fov} min={50} max={85} step={1} onChange={(v) => update((d) => (d.camera.fov = v))} format={(v) => `${v}°`} />
              </Row>
              <Row label="Speed widening" help="How much the view widens at high speed.">
                <Slider label="Speed FOV" value={s.camera.speedFov} min={0} max={8} step={0.5} onChange={(v) => update((d) => (d.camera.speedFov = v))} format={(v) => `${v}°`} />
              </Row>
              <Row label="Camera shake" help="Road texture and impacts felt through the camera. Keep low if you are sensitive to motion.">
                <Slider label="Camera shake" value={s.camera.shake} min={0} max={1} step={0.05} onChange={(v) => update((d) => (d.camera.shake = v))} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Motion blur" help="Subtle speed blur at the edges of the screen. Off by default.">
                <Slider label="Motion blur" value={s.camera.motionBlur} min={0} max={1} step={0.05} onChange={(v) => update((d) => (d.camera.motionBlur = v))} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
            </>
          )}
          {tab === "graphics" && (
            <>
              <Row label="Quality" help="High and Ultra use full-detail trees further out, sharper shadows and 2K skies. Medium is tuned for phones and laptops. Changing quality rebuilds the forest (a second or two).">
                <Seg<Quality>
                  label="Quality"
                  value={s.graphics.quality}
                  options={[
                    { v: "low", label: "Low" },
                    { v: "medium", label: "Medium" },
                    { v: "high", label: "High" },
                    { v: "ultra", label: "Ultra" },
                  ]}
                  onChange={(v) => update((d) => (d.graphics.quality = v))}
                />
              </Row>
              <Row label="Resolution scale">
                <Slider label="Resolution scale" value={s.graphics.resolutionScale} min={0.5} max={1} step={0.05} onChange={(v) => update((d) => (d.graphics.resolutionScale = v))} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Dynamic resolution" help="Lowers the resolution slightly when the frame rate drops below 50, and restores it when there is headroom. Keeps the driving smooth.">
                <Switch label="Dynamic resolution" on={s.graphics.dynamicResolution} onChange={(v) => update((d) => (d.graphics.dynamicResolution = v))} />
              </Row>
            </>
          )}
          {tab === "audio" && (
            <>
              {(["master", "engine", "effects", "ambience", "music"] as const).map((k) => (
                <Row key={k} label={{ master: "Master", engine: "Engine", effects: "Tyres, road & wind", ambience: "Nature ambience", music: "Music" }[k]} help={k === "effects" ? "Tyre squeal rises gradually as you approach the grip limit: listen for it." : k === "music" ? "Calm, optional background music. Set to zero to switch it off." : undefined}>
                  <Slider label={k} value={s.audio[k]} min={0} max={1} step={0.05} onChange={(v) => update((d) => (d.audio[k] = v))} format={(v) => `${Math.round(v * 100)}%`} />
                </Row>
              ))}
            </>
          )}
          {tab === "game" && <GameTab game={game} update={update} />}
        </div>
      </div>
    </div>
  );
}

function ControlsTab({ game, update }: { game: Game; update: (fn: (d: Settings) => void, custom?: boolean) => void }) {
  const s = game.settings;
  const [capturing, setCapturing] = useState<Action | null>(null);
  const [wizard, setWizard] = useState(false);
  const bind = (a: Action) => {
    setCapturing(a);
    game.input.beginKeyCapture((code) => {
      setCapturing(null);
      if (code === "Escape") return;
      update((d) => {
        // Remove the key from any other action first.
        for (const k of Object.keys(d.input.keys) as Action[]) d.input.keys[k] = d.input.keys[k].filter((c) => c !== code);
        d.input.keys[a] = [code, ...d.input.keys[a].filter((c) => c !== code)].slice(0, 2);
      });
    });
  };
  return (
    <>
      <Row label="Steering speed sensitivity" help="Reduces steering lock as speed rises so small inputs stay precise. Steering into a slide (countersteer) is always allowed in full. 0% is raw, full lock at any speed.">
        <Slider label="Speed sensitivity" value={s.assists.steerSpeedSensitivity} min={0} max={1} step={0.05} onChange={(v) => update((d) => (d.assists.steerSpeedSensitivity = v))} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Keyboard steering speed" help="How quickly the wheel turns while a steering key is held. Lower is smoother, higher is more responsive.">
        <Slider label="Keyboard steering speed" value={s.assists.steerRate} min={0.5} max={1.8} step={0.05} onChange={(v) => update((d) => (d.assists.steerRate = v))} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Controller stick deadzone">
        <Slider label="Deadzone" value={s.input.deadzone} min={0} max={0.3} step={0.01} onChange={(v) => update((d) => (d.input.deadzone = v))} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Controller steering curve" help="Higher values give finer control around the centre of the stick.">
        <Slider label="Steering curve" value={s.input.steerCurve} min={1} max={2.5} step={0.1} onChange={(v) => update((d) => (d.input.steerCurve = v))} format={(v) => v.toFixed(1)} />
      </Row>
      <Row label="Touch steering" help="Slide: touch anywhere on the left and slide sideways (analog). Buttons: two steering buttons. Tilt: tilt your phone like a wheel (landscape).">
        <Seg
          label="Touch steering"
          value={s.input.touchSteer}
          options={[
            { v: "slide", label: "Slide" },
            { v: "buttons", label: "Buttons" },
            { v: "tilt", label: "Tilt" },
          ]}
          onChange={(v) => {
            if (v === "tilt") void game.input.enableTilt();
            else game.input.disableTilt();
            update((d) => (d.input.touchSteer = v));
          }}
        />
      </Row>
      {s.input.touchSteer === "tilt" && (
        <Row label="Tilt sensitivity">
          <Slider label="Tilt sensitivity" value={s.input.tiltSensitivity} min={0.5} max={2} step={0.05} onChange={(v) => update((d) => (d.input.tiltSensitivity = v))} format={(v) => `${Math.round(v * 100)}%`} />
        </Row>
      )}
      <Row label="Steering wheel & pedals" help={s.input.wheel ? `Calibrated: steering axis ${s.input.wheel.steerAxis}, throttle axis ${s.input.wheel.throttleAxis}, brake axis ${s.input.wheel.brakeAxis}.` : "Most USB wheels appear to the browser as a generic controller. Calibrate once to map the wheel and pedal axes."}>
        <div className="row">
          <button className="btn small" onClick={() => setWizard(true)}>
            {s.input.wheel ? "Recalibrate" : "Calibrate"}
          </button>
          {s.input.wheel && (
            <button className="btn small ghost" onClick={() => update((d) => (d.input.wheel = null))}>
              Remove
            </button>
          )}
        </div>
      </Row>
      {wizard && <WheelWizard game={game} onDone={() => setWizard(false)} update={update} />}
      <div className="eyebrow" style={{ margin: "18px 0 4px" }}>
        Keyboard
      </div>
      {(Object.keys(ACTION_LABELS) as Action[]).map((a) => (
        <Row key={a} label={ACTION_LABELS[a]}>
          <div className="bind">
            {capturing === a ? (
              <span className="muted">Press a key… (Esc to cancel)</span>
            ) : (
              s.input.keys[a].map((k) => (
                <span className="kbd" key={k}>
                  {keyLabel(k)}
                </span>
              ))
            )}
            <button className="btn small" onClick={() => bind(a)}>
              Change
            </button>
          </div>
        </Row>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => update((d) => (d.input.keys = structuredClone(DEFAULT_KEYS)))}>
          Restore default keys
        </button>
      </div>
      <p className="faint" style={{ fontSize: 13, lineHeight: 1.5 }}>
        Controller (standard layout): RT accelerate · LT brake · left stick steer · A handbrake · B / X shift up / down · Y camera · LB look back · View: tap to reset the car, hold to restart · Menu to pause.
      </p>
    </>
  );
}

function WheelWizard({ game, onDone, update }: { game: Game; onDone: () => void; update: (fn: (d: Settings) => void) => void }) {
  const [step, setStep] = useState(0);
  const [msg, setMsg] = useState("");
  const data = useRef({ index: -1, base: [] as number[], steerAxis: -1, steerInvert: false, thrAxis: -1, thrRest: 0, thrFull: 1, brkAxis: -1, brkRest: 0, brkFull: 1, peak: 0, peakVal: 0, axis: -1 });
  const steps = ["Release the pedals and centre the wheel, then press Next.", "Turn the wheel fully to the RIGHT and hold it, then press Next.", "Centre the wheel, press the THROTTLE fully and hold it, then press Next.", "Release the throttle, press the BRAKE fully and hold it, then press Next."];
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pads = Input.gamepads();
      const d = data.current;
      const pad = pads.find((p) => p.index === d.index) ?? pads.find((p) => p.mapping !== "standard") ?? pads[0];
      if (!pad) {
        setMsg("No wheel or controller detected. Press a button on the device.");
        return;
      }
      if (d.index < 0) d.index = pad.index;
      setMsg(`Device: ${pad.id.slice(0, 60)}`);
      if (step > 0 && d.base.length) {
        const r = detectAxis(d.base, pad);
        if (r.delta > d.peak) {
          d.peak = r.delta;
          d.axis = r.axis;
          d.peakVal = r.value;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [step]);
  const next = () => {
    const pads = Input.gamepads();
    const d = data.current;
    const pad = pads.find((p) => p.index === d.index) ?? pads[0];
    if (!pad) return;
    if (step === 0) d.base = [...pad.axes];
    if (step === 1) {
      d.steerAxis = d.axis;
      d.steerInvert = d.peakVal < d.base[d.axis];
    }
    if (step === 2) {
      d.thrAxis = d.axis;
      d.thrRest = d.base[d.axis] ?? 0;
      d.thrFull = d.peakVal;
    }
    if (step === 3) {
      d.brkAxis = d.axis;
      d.brkRest = d.base[d.axis] ?? 0;
      d.brkFull = d.peakVal;
      if (d.steerAxis < 0 || d.thrAxis < 0 || d.brkAxis < 0) {
        setMsg("Could not detect all axes. Please try again.");
        setStep(0);
        return;
      }
      update((s) => {
        s.input.wheel = { index: d.index, steerAxis: d.steerAxis, steerInvert: d.steerInvert, throttleAxis: d.thrAxis, throttleRest: d.thrRest, throttleFull: d.thrFull, brakeAxis: d.brkAxis, brakeRest: d.brkRest, brakeFull: d.brkFull, rotation: 900 };
      });
      onDone();
      return;
    }
    d.peak = 0;
    d.axis = -1;
    setStep(step + 1);
  };
  void game;
  return (
    <div className="panel" style={{ padding: 14, margin: "8px 0" }}>
      <div className="eyebrow">
        Wheel calibration · step {step + 1} of 4
      </div>
      <p style={{ margin: "8px 0" }}>{steps[step]}</p>
      <p className="faint" style={{ fontSize: 12.5 }}>
        {msg}
      </p>
      <div className="row">
        <button className="btn small primary" onClick={next}>
          Next
        </button>
        <button className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function GameTab({ game, update }: { game: Game; update: (fn: (d: Settings) => void) => void }) {
  const s = game.settings;
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Row label="Speed units">
        <Seg
          label="Units"
          value={s.units}
          options={[
            { v: "kmh", label: "km/h" },
            { v: "mph", label: "mph" },
          ]}
          onChange={(v) => update((d) => (d.units = v))}
        />
      </Row>
      <Row label="Explore mode: open every event" help="Opens all events and cars without earning them. Progress and records still count. Handy for exploring, or if you just want to drive.">
        <Switch label="Open every event" on={s.unlockAll} onChange={(v) => update((d) => (d.unlockAll = v))} />
      </Row>
      <Row label="Reset progress" help="Clears records, medals, ghosts and completed lessons. Settings are kept.">
        {confirm ? (
          <div className="row">
            <button
              className="btn small"
              onClick={() => {
                game.resetProgress();
                setConfirm(false);
              }}
            >
              Yes, reset
            </button>
            <button className="btn small ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn small" onClick={() => setConfirm(true)}>
            Reset…
          </button>
        )}
      </Row>
      <div className="setting" style={{ display: "block" }}>
        <div className="label">Credits</div>
        <p className="help" style={{ marginTop: 6 }}>
          Car, tree, bush and rock models by <b>Quaternius</b> (CC0, via Poly Pizza). Asphalt, gravel, grass, forest-floor, rock and sand textures and the HDRI skies from <b>Poly Haven</b> (CC0). Engine, tyre and nature sounds are synthesised in the browser. Everything else was made for this game.
        </p>
      </div>
    </>
  );
}
