import * as THREE from "three";
import { Autopilot } from "./ai/Autopilot";
import { AudioEngine } from "./audio/AudioEngine";
import { Input } from "./input/Input";
import { CARS, CarSpec, carById } from "./physics/carSpecs";
import { DriverControls, PHYSICS_DT, Vehicle } from "./physics/Vehicle";
import { loadTexture } from "./render/assets";
import { CAMERA_LABELS, CAMERA_MODES, CameraRig } from "./render/CameraRig";
import { CarPose, CarView, capturePose, lerpPose } from "./render/CarView";
import { Effects } from "./render/Effects";
import { Conditions, Environment } from "./render/Environment";
import { PropsView } from "./render/PropsView";
import { Renderer } from "./render/Renderer";
import { RoadView, loadRoadTextures } from "./render/RoadView";
import { TerrainView, loadTerrainTextures } from "./render/TerrainView";
import { VegetationView } from "./render/VegetationView";
import { WaterView } from "./render/WaterView";
import { GrassView } from "./render/GrassView";
import { EventRecord, Medal, Profile, Settings, assistTier, betterMedal, clearGhosts, loadGhost, loadProfile, saveGhost, saveProfile } from "./save/profile";
import { EVENTS, EventDef, eventById, isCarUnlocked, isUnlocked } from "./session/events";
import { GhostData, decodeGhost, encodeGhost, ghostPoseAt } from "./session/Ghost";
import { Results, Session, Toast, computeTargets } from "./session/Session";
import { Spawn } from "./session/lessons";
import { Store } from "./store";
import { RacingLine, computeRacingLine, lineOffsetAt } from "./track/racingLine";
import { clamp, smoothstep } from "./util/math";
import { World, WATER_Y, setWorld } from "./world/World";
import { Multiplayer, Room } from "./network/Multiplayer";
import { RemoteCars } from "./render/RemoteCars";

export type Screen = "loading" | "title" | "events" | "garage" | "briefing" | "driving" | "multiplayer" | "error";

export interface UIState {
  screen: Screen;
  loadProgress: number;
  loadLabel: string;
  busy: string | null; // short blocking task label (e.g. changing weather)
  paused: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  eventId: string;
  carId: string;
  freeConditions: Conditions;
  results: Results | null;
  showResults: boolean;
  profileRev: number;
  newUnlocks: string[];
  cameraLabel: string | null;
  error: string | null;
  eventsFilter: "all" | "academy" | "time" | "drift" | "mastery";
}

export interface Hud {
  visible: boolean;
  phase: "countdown" | "running" | "finished";
  countdown: number;
  kind: EventDef["kind"];
  eventName: string;
  kmh: number;
  gear: string;
  rpm: number;
  redline: number;
  limiter: boolean;
  lap: number;
  laps: number;
  lapTime: number;
  lapStarted: boolean;
  bestLap: number | null;
  pbLap: number | null;
  lastLap: number | null;
  delta: number | null;
  lapValid: boolean;
  progress: number;
  drift: { total: number; combo: number; mult: number; angle: number; active: boolean; zone: string | null } | null;
  lesson: { title: string; steps: string[]; step: number; prompt: string; tip: string; progress: number; retry: boolean } | null;
  toasts: Toast[];
  assists: { abs: boolean; tc: boolean; esc: boolean };
  inputs: { throttle: number; brake: number; steer: number; handbrake: number };
  car: { x: number; z: number; heading: number };
  ghost: { x: number; z: number; visible: boolean };
  nextCorner: { name: string; short: string; dist: number; kmh: number; dir: number; flat: boolean } | null;
  targets: [number, number, number] | null;
  camera: string;
  wrongSurface: boolean;
  nitro: { enabled: boolean; charge: number; active: boolean };
}

const tmpV = new THREE.Vector3();
const tmpSun = new THREE.Vector3();

/** Menus, free drive and multiplayer: warm, low golden-hour sun. */
const DEFAULT_CONDITIONS: Conditions = { time: "afternoon", weather: "dry" };

export class Game {
  readonly multiplayer = new Multiplayer((room) => this.startNetworkRace(room));
  private opponents: RemoteCars | null = null;
  readonly store: Store<UIState>;
  profile: Profile;
  readonly input = new Input();
  readonly audio = new AudioEngine();
  readonly scene = new THREE.Scene();
  renderer!: Renderer;
  env!: Environment;
  world!: World;
  terrain!: TerrainView;
  road!: RoadView;
  water!: WaterView;
  vegetation!: VegetationView;
  props!: PropsView;
  effects!: Effects;
  grass: GrassView | null = null;
  cameraRig!: CameraRig;
  hud: Hud;
  mapPath: { x: number; z: number }[] = [];
  mapBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };

  private spec: CarSpec = CARS[0];
  vehicle: Vehicle | null = null;
  private carView: CarView | null = null;
  private ghostView: CarView | null = null;
  private ghost: GhostData | null = null;
  session: Session | null = null;
  private line: RacingLine | null = null;
  private lineKey = "";
  private lineCache = new Map<string, RacingLine>();
  private conditions: Conditions = { ...DEFAULT_CONDITIONS };
  private player: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false, digitalSteer: true, digitalPedals: true };
  private acc = 0;
  private prevPose: CarPose | null = null;
  private currPose: CarPose | null = null;
  private renderPose: CarPose | null = null;
  private last = 0;
  private time = 0;
  private raf = 0;
  private disposed = false;
  private resultsTimer = 0;
  private envSample = { nearWater: 0, forest: 0, t: 0 };
  private resizeObs: ResizeObserver | null = null;
  private busy = false;
  /** Test hook: when set, this autopilot drives through the player's controls. */
  debugDriver: Autopilot | null = null;
  enableTestDriver(pace = 0.93) {
    if (this.vehicle && this.line) this.debugDriver = new Autopilot(this.vehicle, this.line, pace);
  }
  /** Rolling per-phase frame timings in ms (inspect via window.__game.prof). */
  readonly prof = { physics: 0, world: 0, render: 0, frame: 0, steps: 0 };
  private profMark = 0;
  private profStep(key: "physics" | "world" | "render") {
    const now = performance.now();
    this.prof[key] = this.prof[key] * 0.95 + (now - this.profMark) * 0.05;
    this.profMark = now;
  }

  private constructor(private canvas: HTMLCanvasElement) {
    this.profile = loadProfile();
    this.store = new Store<UIState>({
      screen: "loading",
      loadProgress: 0,
      loadLabel: "Starting",
      busy: null,
      paused: false,
      settingsOpen: false,
      helpOpen: false,
      eventId: "tt-morning",
      carId: this.profile.settings.lastCar,
      freeConditions: { ...DEFAULT_CONDITIONS },
      results: null,
      showResults: false,
      profileRev: 0,
      newUnlocks: [],
      cameraLabel: null,
      error: null,
      eventsFilter: "all",
    });
    this.hud = this.emptyHud();
  }

  static async create(canvas: HTMLCanvasElement) {
    const g = new Game(canvas);
    g.load().catch((e) => {
      console.error(e);
      g.store.set({ screen: "error", error: e instanceof Error ? e.message : String(e) });
    });
    return g;
  }

  get settings(): Settings {
    return this.profile.settings;
  }

  private progress(p: number, label: string) {
    this.store.set({ loadProgress: p, loadLabel: label });
  }

  private nextFrame() {
    return new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  private async load() {
    const s = this.settings;
    this.renderer = new Renderer(this.canvas, s.graphics.quality);
    this.renderer.setQuality(s.graphics.quality, s.graphics.resolutionScale);
    this.renderer.dynamicResolution = s.graphics.dynamicResolution;
    this.renderer.motionBlur = s.camera.motionBlur;
    this.scene.background = new THREE.Color(0xb8c6d0);
    this.input.settings = s.input;
    this.input.attach(window);
    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas.parentElement ?? this.canvas);

    // Landscape generation (deterministic).
    this.progress(0.02, "Surveying the valley");
    await this.nextFrame();
    this.world = new World();
    let lastYield = performance.now();
    for (const p of this.world.generate()) {
      if (performance.now() - lastYield > 40) {
        this.progress(0.02 + p * 0.4, p < 0.8 ? "Shaping the terrain" : p < 0.9 ? "Painting meadows and forest" : "Planting trees");
        await this.nextFrame();
        lastYield = performance.now();
      }
    }
    setWorld(this.world);
    this.buildMapPath();

    this.progress(0.45, "Loading textures and models");
    const q = this.renderer.quality;
    const [terrainTex, roadTex] = await Promise.all([loadTerrainTextures(), loadRoadTextures(), loadTexture("textures/gravelly_sand_diffuse.jpg")]);
    this.env = new Environment(this.renderer.renderer, this.scene);
    this.env.setShadowQuality(q.shadowSize, q.shadowExtent, q.shadows);
    this.progress(0.55, "Lighting the sky");
    await this.env.apply(this.conditions, q.hdr);
    this.renderer.setGrade(this.env.params.grade);

    this.progress(0.62, "Building the landscape");
    await this.nextFrame();
    this.terrain = new TerrainView(this.world, terrainTex);
    this.terrain.buildFar();
    this.scene.add(this.terrain.group);
    this.progress(0.68, "Laying asphalt");
    await this.nextFrame();
    this.spec = carById(this.store.get().carId);
    this.line = this.getLine(this.spec, false);
    this.road = new RoadView(this.world, roadTex, this.line);
    this.road.buildRacingLine(this.line);
    this.scene.add(this.road.group);
    this.water = new WaterView(new THREE.Vector3(this.world.center.x, 0, this.world.center.z));
    this.scene.add(this.water.mesh);
    this.progress(0.74, "Growing the forest");
    await this.nextFrame();
    this.vegetation = await VegetationView.load(this.world, this.renderer.renderer, { density: q.vegetationDensity, nearScale: q.nearScale });
    this.scene.add(this.vegetation.group);
    this.buildGrass();
    this.props = new PropsView(this.world);
    this.scene.add(this.props.group);
    this.effects = new Effects();
    this.scene.add(this.effects.group);
    this.cameraRig = new CameraRig(this.world);
    this.applyCameraSettings();
    this.resize();

    this.progress(0.86, "Preparing the car");
    await this.setCar(this.spec.id);
    this.parkForMenu();

    this.progress(0.93, "Warming up shaders");
    await this.nextFrame();
    this.terrain.update(this.cameraRig.camera.position, q.lodBias);
    this.vegetation.update(this.cameraRig.camera.position, 0, 1);
    this.vegetation.updateNear(this.cameraRig.camera, this.cameraRig.camera.position, true);
    try {
      await this.renderer.renderer.compileAsync(this.scene, this.cameraRig.camera);
    } catch {
      /* compileAsync is an optimisation only */
    }
    this.progress(1, "Ready");
    this.store.set({ screen: new URLSearchParams(window.location.search).has("room") ? "multiplayer" : "title" });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private onVisibility = () => {
    if (document.hidden) {
      if (this.store.get().screen === "driving" && !this.store.get().paused) this.pause();
      this.audio.suspend();
    } else this.audio.resume();
  };

  private buildMapPath() {
    const t = this.world.track;
    const pts: { x: number; z: number }[] = [];
    for (let s = 0; s < t.length; s += 12) {
      const f = t.frameAt(s);
      pts.push({ x: f.x, z: f.z });
    }
    this.mapPath = pts;
    this.mapBounds = { ...t.bounds };
  }

  private getLine(spec: CarSpec, wet: boolean) {
    const key = `${spec.id}|${wet}`;
    let l = this.lineCache.get(key);
    if (!l) {
      l = computeRacingLine(this.world.track, spec, wet ? 0.7 : 1);
      this.lineCache.set(key, l);
    }
    return l;
  }

  private async setCar(id: string) {
    const spec = carById(id);
    const paint = this.settings.paint[spec.id] ?? spec.paint;
    if (this.carView && this.spec.id === spec.id) {
      this.carView.setPaint(paint);
      return;
    }
    this.spec = spec;
    const view = await CarView.create(spec, paint, false, this.renderer.quality.carLite);
    if (this.carView) {
      this.scene.remove(this.carView.root);
      this.carView.dispose();
    }
    this.carView = view;
    this.scene.add(view.root);
    if (this.ghostView) {
      this.scene.remove(this.ghostView.root);
      this.ghostView.dispose();
    }
    this.ghostView = await CarView.create(spec, paint, true);
    this.ghostView.root.visible = false;
    this.scene.add(this.ghostView.root);
    this.vehicle = new Vehicle(spec, this.world);
    this.vehicle.assists = { ...this.settings.assists };
    this.vehicle.wetness = this.conditions.weather === "wet" ? 1 : 0;
    this.carView.setLights(this.env.params.headlights);
  }

  /** Menu backdrop: the car parked by the start gantry with the camera slowly circling. */
  private parkForMenu() {
    if (!this.vehicle) return;
    const t = this.world.track;
    const f = t.frameAt(t.length - 18);
    this.vehicle.reset(f.x - f.nx * 2.2, f.z - f.nz * 2.2, f.heading, 0);
    for (let i = 0; i < 120; i++) this.vehicle.step({ ...this.player, throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    this.currPose = capturePose(this.vehicle);
    this.prevPose = capturePose(this.vehicle);
    this.renderPose = capturePose(this.vehicle);
    this.carView?.apply(this.renderPose, this.vehicle);
    this.cameraRig.reset();
    this.effects?.clear();
    if (this.ghostView) this.ghostView.root.visible = false;
  }

  // ------------------------------------------------------------------ public API (UI)

  go(screen: Screen) {
    this.audio.start();
    this.audio.uiClick();
    if (screen !== "driving" && this.store.get().screen === "driving") {
      this.multiplayer.leave();
      this.opponents?.dispose();
      this.opponents = null;
      this.session = null;
      this.parkForMenu();
      void this.ensureConditions({ ...DEFAULT_CONDITIONS });
    }
    this.store.set({ screen, paused: false, showResults: false });
  }

  selectEvent(id: string) {
    const ev = eventById(id);
    let carId = this.store.get().carId;
    if (!isCarUnlocked(carId, this.profile)) carId = "meridian";
    this.store.set({ eventId: ev.id, carId });
  }

  async selectCar(id: string) {
    if (!isCarUnlocked(id, this.profile)) return;
    this.store.set({ carId: id });
    this.settings.lastCar = id;
    this.persist();
    if (this.store.get().screen !== "driving") {
      await this.setCar(id);
      this.parkForMenu();
    }
  }

  async setPaint(color: string) {
    this.settings.paint[this.spec.id] = color;
    this.carView?.setPaint(color);
    this.persist();
  }

  setFreeConditions(c: Conditions) {
    this.store.set({ freeConditions: c });
  }

  private async ensureConditions(c: Conditions) {
    if (c.time === this.conditions.time && c.weather === this.conditions.weather) return;
    this.conditions = c;
    await this.env.apply(c, this.renderer.quality.hdr);
    this.renderer.setGrade(this.env.params.grade);
    const wet = c.weather === "wet" ? 1 : 0;
    this.road.setWetness(wet);
    this.terrain.setWetness(wet);
    if (this.vehicle) this.vehicle.wetness = wet;
    this.carView?.setLights(this.env.params.headlights);
  }

  /** Assists for this event: the player's choice, capped where the challenge requires it. */
  private effectiveAssists(ev: EventDef) {
    const a = { ...this.settings.assists };
    const rank = { off: 0, sport: 1, full: 2 } as const;
    if (ev.assistCap?.esc && rank[a.esc] > rank[ev.assistCap.esc]) a.esc = ev.assistCap.esc;
    if (ev.assistCap?.tc && rank[a.tc] > rank[ev.assistCap.tc]) a.tc = ev.assistCap.tc;
    if (ev.assistCap?.abs === false) a.abs = false;
    return a;
  }

  recordKey(ev: EventDef, spec: CarSpec, tier = assistTier(this.effectiveAssists(ev))) {
    return `${ev.id}|${spec.classId}|${tier}`;
  }

  /** Medal targets and records for the briefing screen. */
  eventPreview(eventId: string, carId: string) {
    const ev = eventById(eventId);
    const spec = carById(carId);
    const wet = (ev.kind === "free" ? this.store.get().freeConditions : ev.conditions).weather === "wet";
    const line = this.getLine(spec, wet);
    const { targets, refTime } = computeTargets(ev, line, this.world.track);
    const tier = assistTier(this.effectiveAssists(ev));
    const records = (["assisted", "sport", "pro"] as const).map((t) => ({ tier: t, record: this.profile.records[this.recordKey(ev, spec, t)] ?? null }));
    return { targets, refTime, tier, record: this.profile.records[this.recordKey(ev, spec, tier)] ?? null, records, assists: this.effectiveAssists(ev) };
  }

  async startEvent(eventId = this.store.get().eventId, carId = this.store.get().carId) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.audio.start();
      const ev = eventById(eventId);
      if (!isUnlocked(ev, this.profile)) return;
      if (!isCarUnlocked(carId, this.profile)) carId = "meridian";
      const cond = ev.kind === "free" ? this.store.get().freeConditions : ev.conditions;
      const needsScene = cond.time !== this.conditions.time || cond.weather !== this.conditions.weather;
      if (needsScene) {
        this.store.set({ busy: cond.weather === "wet" ? "Clouds rolling in" : cond.time === "dusk" ? "Waiting for dusk" : cond.time === "afternoon" ? "Afternoon light" : "Morning light" });
        await this.nextFrame();
      }
      await this.ensureConditions(cond);
      await this.setCar(carId);
      const spec = this.spec;
      const v = this.vehicle!;
      v.assists = this.effectiveAssists(ev);
      v.wetness = cond.weather === "wet" ? 1 : 0;
      v.nitro.enabled = ev.kind === "free";
      v.nitro.reset();
      const line = this.getLine(spec, cond.weather === "wet");
      const key = `${spec.id}|${cond.weather}`;
      if (key !== this.lineKey) {
        this.road.buildRacingLine(line);
        this.lineKey = key;
      }
      this.line = line;
      const recKey = this.recordKey(ev, spec);
      const record = this.profile.records[recKey] ?? null;
      this.ghost = ev.kind === "timeTrial" || ev.kind === "sprint" || ev.kind === "mastery" ? decodeGhost(loadGhost(recKey)) : null;
      this.session = new Session(ev, spec, v, this.world, line, this.profile, record, this.ghost);
      this.spawnAt(this.session.spawn(), true);
      this.effects.clear();
      this.input.clearEdges();
      this.resultsTimer = 0;
      this.settings.lastCar = spec.id;
      this.profile.stats.events++;
      this.persist();
      this.store.set({ screen: "driving", paused: false, showResults: false, results: null, eventId: ev.id, carId: spec.id, busy: null, newUnlocks: [] });
    } finally {
      this.busy = false;
      this.store.set({ busy: null });
    }
  }

  restart() {
    if (this.multiplayer.room) { this.resetCar(); return; }
    void this.startEvent();
  }

  async joinMultiplayer(name: string, code?: string) {
    await this.multiplayer.join(name, this.store.get().carId, code);
    try {
      this.store.set({ freeConditions: { ...DEFAULT_CONDITIONS } });
      await this.startEvent("free");
      const room = this.multiplayer.room;
      if (!room || !this.session) throw new Error("Connection closed while loading. Please rejoin.");
      const slot = room.players.findIndex((p) => p.id === this.multiplayer.store.get().id);
      this.carView?.setPaint(room.players[slot].color);
      this.spawnAt({ s: this.world.track.length - 35 - slot * 7, d: slot % 2 ? 2 : -2, speed: 0 }, true);
      this.opponents ??= new RemoteCars(this.scene);
      await this.multiplayer.ready();
    } catch (error) {
      this.multiplayer.leave();
      this.go("multiplayer");
      throw error;
    }
  }

  private startNetworkRace(room: Room) {
    if (!this.session || !this.vehicle) return;
    const slot = room.players.findIndex((p) => p.id === this.multiplayer.store.get().id);
    this.spawnAt({ s: this.world.track.length - 35 - slot * 7, d: slot % 2 ? 2 : -2, speed: 0 }, true);
    this.vehicle.nitro.reset();
    this.session.phase = "countdown";
    this.session.countdown = this.multiplayer.countdown;
    this.session.toasts = [];
    this.store.set({ paused: false, settingsOpen: false, helpOpen: false });
    this.input.clearEdges();
  }

  private spawnAt(sp: Spawn, fresh = false) {
    const v = this.vehicle!;
    const t = this.world.track;
    const f = t.frameAt(sp.s);
    const x = f.x + f.nx * sp.d;
    const z = f.z + f.nz * sp.d;
    v.reset(x, z, sp.heading ?? f.heading, sp.speed);
    if (sp.gear) v.gear = sp.gear;
    if (sp.yawKick) {
      v.angVel.set(0, sp.yawKick, 0);
      v.vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), -sp.yawKick * 0.12);
    }
    this.currPose = capturePose(v);
    this.prevPose = capturePose(v);
    this.renderPose = capturePose(v);
    this.acc = 0;
    if (fresh) this.cameraRig.reset();
  }

  /** Puts the car back on the road, pointing the right way, at rest. */
  resetCar() {
    if (!this.session || !this.vehicle) return;
    const ses = this.session;
    if (ses.lesson) {
      if (ses.lessonRetry) this.retryLesson();
      else void this.startEvent();
      return;
    }
    const t = this.world.track;
    const p = t.project(this.vehicle.pos.x, this.vehicle.pos.z, -1);
    const back = t.wrap(p.s - 8);
    const d = this.line ? lineOffsetAt(this.line, back, t.length) * 0.4 : 0;
    this.spawnAt({ s: back, d, speed: 0 });
    ses.onReset();
    ses.toast("Car reset", "info", 1.4);
  }

  retryLesson() {
    const spawn = this.session?.retryLesson();
    if (spawn) {
      this.spawnAt(spawn);
      this.input.clearEdges();
    }
  }

  pause() {
    if (this.store.get().screen !== "driving") return;
    this.store.set({ paused: true });
    this.audio.update(null, 0, { nearWater: 0, forest: 0, rain: 0, wind: 0 }, false);
  }

  resume() {
    this.input.clearEdges();
    this.last = performance.now();
    this.store.set({ paused: false, settingsOpen: false, helpOpen: false });
  }

  quitToMenu() {
    this.go("events");
  }

  cycleCamera() {
    const i = CAMERA_MODES.indexOf(this.cameraRig.mode);
    const mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.cameraRig.mode = mode;
    this.settings.camera.mode = mode;
    this.carView?.setCockpit(mode === "cockpit");
    this.persist();
    this.store.set({ cameraLabel: CAMERA_LABELS[mode] });
    setTimeout(() => this.store.set({ cameraLabel: null }), 1200);
  }

  applySettings(next: Settings) {
    const prev = this.profile.settings;
    this.profile.settings = next;
    this.input.settings = next.input;
    if (prev.graphics.quality !== next.graphics.quality || prev.graphics.resolutionScale !== next.graphics.resolutionScale) {
      this.renderer.setQuality(next.graphics.quality, next.graphics.resolutionScale);
      const q = this.renderer.quality;
      this.env.setShadowQuality(q.shadowSize, q.shadowExtent, q.shadows);
      if (prev.graphics.quality !== next.graphics.quality) void this.rebuildVegetation();
      this.resize();
    }
    this.renderer.dynamicResolution = next.graphics.dynamicResolution;
    this.renderer.motionBlur = next.camera.motionBlur;
    this.applyCameraSettings();
    this.audio.setLevels(next.audio);
    if (this.vehicle && this.session) this.vehicle.assists = this.effectiveAssists(this.session.event);
    else if (this.vehicle) this.vehicle.assists = { ...next.assists };
    this.persist();
  }

  private buildGrass() {
    if (this.grass) {
      this.scene.remove(this.grass.mesh);
      this.grass.dispose();
      this.grass = null;
    }
    const q = this.renderer.quality.grass;
    if (!q) return;
    this.grass = new GrassView(this.world, q);
    this.scene.add(this.grass.mesh);
  }

  private async rebuildVegetation() {
    this.buildGrass();
    const q = this.renderer.quality;
    this.scene.remove(this.vegetation.group);
    this.vegetation = await VegetationView.load(this.world, this.renderer.renderer, { density: q.vegetationDensity, nearScale: q.nearScale });
    this.scene.add(this.vegetation.group);
  }

  private applyCameraSettings() {
    const c = this.settings.camera;
    this.cameraRig.settings = { fov: c.fov, speedFov: c.speedFov, shake: c.shake };
    this.cameraRig.mode = c.mode;
    this.carView?.setCockpit(c.mode === "cockpit");
  }

  persist() {
    saveProfile(this.profile);
    this.store.set((s) => ({ profileRev: s.profileRev + 1 }));
  }

  resetProgress() {
    const settings = this.profile.settings;
    clearGhosts();
    this.profile = { ...loadProfile(), records: {}, medals: {}, completed: {}, stats: { distance: 0, driveTime: 0, events: 0 } };
    this.profile.settings = settings;
    this.persist();
  }

  // ------------------------------------------------------------------ results & progression

  private commitResults(r: Results) {
    const ev = eventById(r.eventId);
    const before = new Set([...EVENTS.filter((e) => isUnlocked(e, this.profile)).map((e) => e.id), ...CARS.filter((c) => isCarUnlocked(c.id, this.profile)).map((c) => c.id)]);
    const key = this.recordKey(ev, this.spec, r.tier as ReturnType<typeof assistTier>);
    const prev: EventRecord | undefined = this.profile.records[key];
    if (ev.kind === "lesson") {
      if (r.lessonComplete) this.profile.completed[ev.id] = true;
    } else if (r.primary !== null) {
      const better = !prev || (r.lowerBetter ? r.primary < prev.best : r.primary > prev.best);
      const rec: EventRecord = prev ? { ...prev, attempts: prev.attempts + 1 } : { best: r.primary, medal: null, date: Date.now(), attempts: 1 };
      if (better) {
        rec.best = r.primary;
        rec.date = Date.now();
        if (r.bestTrace && (ev.kind === "timeTrial" || ev.kind === "sprint" || ev.kind === "mastery")) {
          const bestIdx = r.laps.findIndex((l) => l.valid && Math.abs(l.time - (ev.kind === "mastery" ? Math.min(...r.laps.filter((x) => x.valid).map((x) => x.time)) : r.primary!)) < 1e-6);
          rec.lap = {
            time: ev.kind === "mastery" ? r.laps[bestIdx]?.time ?? r.primary : r.primary,
            sectors: bestIdx >= 0 ? r.laps[bestIdx].sectors : [],
            splits: r.bestTrace.splits(),
            date: Date.now(),
            carId: r.carId,
            assists: r.tier,
          };
          if (r.ghost) saveGhost(key, encodeGhost(r.ghost));
        }
      }
      rec.medal = betterMedal(rec.medal, r.medal);
      this.profile.records[key] = rec;
      if (r.medal) this.profile.medals[ev.id] = betterMedal(this.profile.medals[ev.id], r.medal) as Medal;
      this.profile.completed[ev.id] = true;
    } else {
      if (prev) prev.attempts++;
    }
    const after = [...EVENTS.filter((e) => isUnlocked(e, this.profile)).map((e) => e.id), ...CARS.filter((c) => isCarUnlocked(c.id, this.profile)).map((c) => c.id)];
    const newly = after.filter((id) => !before.has(id)).map((id) => EVENTS.find((e) => e.id === id)?.name ?? CARS.find((c) => c.id === id)?.name ?? id);
    this.persist();
    this.store.set({ results: r, showResults: true, newUnlocks: newly });
  }

  // ------------------------------------------------------------------ main loop

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    const ui = this.store.get();
    const driving = ui.screen === "driving" && !!this.session && !!this.vehicle;
    this.input.poll(this.player, dt);

    if (driving && ui.showResults) {
      this.input.consume("pause");
      this.input.consume("camera");
      this.input.consume("reset");
      if (this.input.consume("restart")) this.restart();
    } else if (driving) {
      if (this.input.consume("pause")) {
        if (ui.paused) this.resume();
        else this.pause();
      }
      if (!ui.paused) {
        if (this.input.consume("camera")) this.cycleCamera();
        if (this.input.consume("restart")) this.restart();
        if (this.input.consume("reset")) this.resetCar();
      }
    } else {
      this.input.consume("pause");
      this.input.consume("camera");
      this.input.consume("restart");
      this.input.consume("reset");
    }
    this.cameraRig.setLookBack(this.input.lookBack);

    const v = this.vehicle;
    if (this.multiplayer.room?.phase === "countdown" && this.session && this.multiplayer.countdown > 0) {
      this.session.phase = "countdown";
      this.session.countdown = this.multiplayer.countdown;
    }
    if (this.multiplayer.room?.phase === "practice" && this.session?.phase === "countdown") {
      this.session.phase = "running";
      this.session.countdown = 0;
    }
    const frameStart = performance.now();
    this.profMark = frameStart;
    if (driving && !ui.paused && v && this.session) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYSICS_DT && steps < 30) {
        this.prevPose = capturePose(v, this.prevPose ?? undefined);
        const input = this.debugDriver && this.debugDriver.vehicle === v ? this.debugDriver.update(PHYSICS_DT) : this.player;
        const c = this.session.controls(input, PHYSICS_DT);
        v.step(c);
        const req = this.session.step(PHYSICS_DT);
        this.acc -= PHYSICS_DT;
        steps++;
        if (req === "reset") this.resetCar();
        else if (req) this.spawnAt(req);
        this.currPose = capturePose(v, this.currPose ?? undefined);
        if (req) break;
      }
      if (steps >= 30) this.acc = 0;
      this.prof.steps = steps;
      // shiftUp/down are consumed by the vehicle; clear stale edges.
      this.player.shiftUp = false;
      this.player.shiftDown = false;
      this.profile.stats.driveTime += dt;
      if (this.session.phase === "finished") {
        this.resultsTimer += dt;
        if (this.resultsTimer > 1.4 && !ui.showResults && this.session.results) this.commitResults(this.session.results);
      }
    }

    this.profStep("physics");
    // Interpolated pose for rendering.
    if (v && this.prevPose && this.currPose) {
      const alpha = driving && !ui.paused ? clamp(this.acc / PHYSICS_DT, 0, 1) : 1;
      this.renderPose = lerpPose(this.prevPose, this.currPose, alpha, this.renderPose ?? capturePose(v));
      this.carView?.apply(this.renderPose, v);
    }

    // Camera
    const cam = this.cameraRig.camera;
    if (driving && v && this.renderPose) {
      this.cameraRig.update(v, this.carView, this.renderPose, dt, this.time);
      for (const imp of v.impacts) if (imp.speed > 2) this.cameraRig.kick(Math.min(1, imp.speed / 12));
    } else if (v && this.renderPose) {
      const pad = ui.screen === "garage" ? 7 : 10;
      this.cameraRig.updateOrbit(this.renderPose.pos, dt, pad, ui.screen === "garage" ? 1.6 : 2.4);
    }

    // Ghost car
    if (this.ghostView) {
      const gd = this.session?.ghostData;
      const gt = this.session?.ghostTime ?? -1;
      if (driving && gd && gt >= 0 && this.session?.phase === "running") {
        const visible = ghostPoseAt(gd, gt, this.ghostView.root.position, this.ghostView.root.quaternion);
        // Fade when overlapping the player.
        const near = v ? this.ghostView.root.position.distanceTo(v.pos) : 99;
        this.ghostView.root.visible = visible && near > 2.5;
      } else this.ghostView.root.visible = false;
    }

    // World updates
    this.multiplayer.update(dt, driving ? v : null, this.session ? this.session.s / this.world.track.length : 0);
    this.opponents?.update(this.multiplayer.store.get().peers, dt, v?.pos ?? cam.position);
    this.env.update(v && driving ? v.pos : cam.position);
    this.terrain.update(cam.position, this.renderer.quality.lodBias);
    this.vegetation.update(cam.position, this.time, this.conditions.weather === "wet" ? 1.6 : 1);
    this.grass?.update(cam.position, this.time, this.conditions.weather === "wet" ? 1.6 : 1);
    cam.updateMatrixWorld();
    this.vegetation.updateNear(cam, v && driving ? v.pos : cam.position);
    const wet = this.conditions.weather === "wet" ? 1 : 0;
    this.effects.update(driving ? v : null, dt, this.time, cam.position, wet, this.canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1));
    this.water.update(this.time, this.env.sunDir, this.env.sun.color, wet);
    if (this.session && v) {
      const mode = this.settings.learning.racingLine;
      const decel = (this.spec.tyre.mu * (wet ? 0.7 : 1)) * 9.81 * 0.85;
      this.road.updateRacingLine(this.session.s, v.telemetry.speed, decel, driving ? mode : 0);
    } else this.road.updateRacingLine(0, 0, 9, 0);

    // Audio
    this.sampleEnvironment(cam.position, dt);
    this.audio.update(driving && !ui.paused ? v : null, dt, { nearWater: this.envSample.nearWater, forest: this.envSample.forest, rain: wet, wind: wet ? 1.4 : 1 }, driving && !ui.paused);
    if (v) v.impacts.length = 0;

    this.updateHud(driving);
    this.updateSunGlare(cam);
    this.profStep("world");
    this.renderer.trackFrame(dt);
    this.renderer.render(this.scene, cam, driving && v ? v.telemetry.speed : 0);
    this.profStep("render");
    this.prof.frame = this.prof.frame * 0.95 + (performance.now() - frameStart) * 0.05;
  };

  /** Tells the final pass where the sun is on screen; it fades out as the sun leaves the frame. */
  private updateSunGlare(cam: THREE.PerspectiveCamera) {
    const sun = this.env.skySun;
    cam.getWorldDirection(tmpSun);
    if (tmpSun.dot(sun) <= 0.05) {
      this.renderer.setSun(0.5, 0.5, 0, this.env.sun.color);
      return;
    }
    tmpSun.copy(sun).multiplyScalar(1000).add(cam.position).project(cam);
    const edge = Math.max(Math.abs(tmpSun.x), Math.abs(tmpSun.y));
    this.renderer.setSun(tmpSun.x * 0.5 + 0.5, tmpSun.y * 0.5 + 0.5, 1 - smoothstep(0.92, 1.15, edge), this.env.sun.color);
  }

  private sampleEnvironment(p: THREE.Vector3, dt: number) {
    this.envSample.t -= dt;
    if (this.envSample.t > 0) return;
    this.envSample.t = 0.5;
    let water = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const r of [25, 60, 110]) {
        if (this.world.terrainHeight(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r) < WATER_Y) {
          water += r === 25 ? 1 : r === 60 ? 0.6 : 0.3;
          break;
        }
      }
    }
    this.envSample.nearWater = clamp(water / 6, 0, 1);
    const h = this.world.terrainHeight(p.x, p.z);
    this.envSample.forest = smoothstep(0.2, 0.8, this.world.forestDensity(p.x, p.z, h));
  }

  private emptyHud(): Hud {
    return {
      visible: false,
      phase: "running",
      countdown: 0,
      kind: "free",
      eventName: "",
      kmh: 0,
      gear: "N",
      rpm: 0,
      redline: 7000,
      limiter: false,
      lap: 0,
      laps: 0,
      lapTime: 0,
      lapStarted: false,
      bestLap: null,
      pbLap: null,
      lastLap: null,
      delta: null,
      lapValid: true,
      progress: 0,
      drift: null,
      lesson: null,
      toasts: [],
      assists: { abs: false, tc: false, esc: false },
      inputs: { throttle: 0, brake: 0, steer: 0, handbrake: 0 },
      car: { x: 0, z: 0, heading: 0 },
      ghost: { x: 0, z: 0, visible: false },
      nextCorner: null,
      targets: null,
      camera: "Chase",
      wrongSurface: false,
      nitro: { enabled: false, charge: 1, active: false },
    };
  }

  private updateHud(driving: boolean) {
    const h = this.hud;
    const s = this.session;
    const v = this.vehicle;
    h.visible = driving && !!s && !!v;
    if (!h.visible || !s || !v) return;
    const t = v.telemetry;
    h.phase = s.phase;
    h.countdown = s.countdown;
    h.kind = s.event.kind;
    h.eventName = s.event.name;
    h.kmh = this.settings.units === "mph" ? t.kmh * 0.621371 : t.kmh;
    h.gear = t.gear === -1 ? "R" : t.gear === 0 ? "N" : String(t.gear);
    h.rpm = t.rpm;
    h.redline = v.spec.engine.redline;
    h.limiter = t.limiter;
    h.lap = Math.min(s.lap + 1, s.totalLaps || 1);
    h.laps = s.totalLaps;
    h.lapTime = s.kind === "sprint" || s.kind === "drift" ? s.sprintTime : s.lapTime;
    h.lapStarted = s.lapStarted;
    h.bestLap = s.bestLap;
    h.pbLap = s.record?.lap?.time ?? (s.kind === "sprint" ? s.record?.best ?? null : null);
    h.lastLap = s.laps.length ? s.laps[s.laps.length - 1].time : null;
    h.delta = this.settings.hud.delta ? s.lastDelta : null;
    h.lapValid = s.lapValid;
    h.drift = s.kind === "drift" || s.lesson?.scoresDrift || (s.kind === "free" && (s.drift.active || s.drift.total > 0))
      ? { total: s.drift.total, combo: Math.round(s.drift.combo), mult: s.drift.multiplier, angle: s.drift.angle, active: s.drift.active, zone: s.drift.currentZone?.name ?? null }
      : null;
    const l = s.lesson;
    h.lesson = l ? { title: l.title, steps: l.steps, step: l.step, prompt: l.prompt, tip: this.settings.learning.tips ? l.tip : "", progress: l.progress, retry: !!s.lessonRetry } : null;
    h.toasts = s.toasts;
    h.assists = { abs: t.absActive, tc: t.tcActive, esc: t.escActive };
    h.inputs = { throttle: t.throttle, brake: t.brake, steer: t.steer, handbrake: t.handbrake };
    h.car = { x: v.pos.x, z: v.pos.z, heading: Math.atan2(v.fwd.x, v.fwd.z) };
    h.ghost.visible = !!this.ghostView?.root.visible;
    if (h.ghost.visible && this.ghostView) {
      h.ghost.x = this.ghostView.root.position.x;
      h.ghost.z = this.ghostView.root.position.z;
    }
    h.nextCorner = s.phase === "running" && !s.lesson?.padLesson ? s.nextCornerInfo() : null;
    h.targets = s.targets;
    h.camera = CAMERA_LABELS[this.cameraRig.mode];
    h.wrongSurface = t.wheelsOnRoad === 0 && t.wheelsOnGround > 0;
    h.nitro = { enabled: v.nitro.enabled, charge: v.nitro.charge, active: v.nitro.active };
    tmpV.set(0, 0, 0);
  }

  private resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer?.resize(w, h);
    this.cameraRig?.setAspect(w / h);
  }

  dispose() {
    this.multiplayer.leave();
    this.opponents?.dispose();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    this.resizeObs?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer?.renderer.dispose();
  }
}
