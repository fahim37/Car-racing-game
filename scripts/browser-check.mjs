// Loads the game in headless Chrome, drives a little and saves screenshots.
//   node scripts/browser-check.mjs [outDir] [scenario]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const out = process.argv[2] || "shots";
const scenario = process.argv[3] || "basic";
const url = process.env.URL || "http://localhost:3000/";
fs.mkdirSync(out, { recursive: true });

const chrome = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"],
});
const mobile = scenario === "mobile" || scenario === "recovery";
const context = await browser.newContext(
  mobile
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 },
);
const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded" });
const shot = async (name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("shot", name);
};
const screen = () => page.evaluate(() => window.__game?.store.get().screen);
const waitScreen = async (s, ms = 120000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await screen()) === s) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const ok = await waitScreen("title");
console.log("title reached:", ok, "in", ((Date.now() - t0) / 1000).toFixed(1), "s");
await page.waitForTimeout(1500);
await shot("01-title");
const fps = async (label) => {
  const r = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(f);
          else res(n / ((performance.now() - t0) / 1000));
        };
        requestAnimationFrame(f);
      }),
  );
  console.log(`fps ${label}: ${r.toFixed(1)}`);
};
await fps("title");

if (scenario === "mobile") {
  await page.evaluate(() => window.__game.store.set({ eventsFilter: "academy" }));
  await page.evaluate(() => { const g = window.__game; g.selectEvent("lesson-braking"); });
  await page.evaluate(() => window.__game.startEvent());
  await waitScreen("driving", 30000);
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__game.input.touch.throttle = 1; });
  await page.waitForTimeout(5000);
  await shot("m-lesson");
  await fps("mobile driving");
  await page.evaluate(() => { const t = window.__game.input.touch; t.throttle = 0; t.brake = 1; });
  await page.waitForTimeout(2000);
  await shot("m-braking");
  await page.evaluate(() => window.__game.pause());
  await page.waitForTimeout(500);
  await shot("m-pause");
}

if (scenario === "recovery") {
  await page.getByRole("button", { name: /^Free Drive/ }).tap();
  await page.waitForTimeout(500);
  console.log("mobile fullscreen:", await page.evaluate(() => !!document.fullscreenElement));
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const r = document.querySelector(".game-canvas").getBoundingClientRect();
      return { width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(Math.abs(layout.width - layout.viewportWidth) < 2 && Math.abs(layout.height - layout.viewportHeight) < 2, JSON.stringify(layout));
  }
  await page.evaluate(() => window.__game.startEvent("lesson-steering", "meridian"));
  assert.ok(await waitScreen("driving", 30000));
  await page.evaluate(() => {
    const g = window.__game;
    g.session.lesson.step = 1;
    g.spawnAt({ s: 300, d: -14, speed: 0 });
  });
  await page.waitForTimeout(2200);
  const offroad = await page.evaluate(() => {
    const g = window.__game;
    return { d: g.session.d, wheels: g.vehicle.telemetry.wheelsOnRoad, retries: g.session.lesson.retries, prompt: g.session.lesson.prompt };
  });
  assert.equal(offroad.wheels, 0);
  assert.equal(offroad.retries, 0);
  assert.ok(Math.abs(offroad.d) > 10, JSON.stringify(offroad));
  await shot("recovery-offroad-landscape");

  await page.evaluate(() => {
    const g = window.__game;
    const t2 = g.world.track.corners.find((c) => c.short === "T2");
    g.session.lesson.step = 2;
    g.spawnAt({ s: t2.sStart - 35, d: 0, speed: 8 });
  });
  const retry = page.getByRole("button", { name: "Retry lesson section" });
  await retry.waitFor({ state: "visible" });
  const beforeRetry = await page.evaluate(() => window.__game.session.s);
  await shot("recovery-manual-retry");
  await retry.tap();
  await page.waitForTimeout(300);
  const afterRetry = await page.evaluate(() => ({ s: window.__game.session.s, pending: !!window.__game.session.lessonRetry }));
  assert.ok(beforeRetry - afterRetry.s > 50, JSON.stringify({ beforeRetry, afterRetry }));
  assert.equal(afterRetry.pending, false);
  assert.equal(logs.filter((line) => line.startsWith("[pageerror]") || line.startsWith("[error]")).length, 0, logs.join("\n"));
  console.log("off-road recovery, manual retry, and mobile viewport checks passed");
}

if (scenario === "basic") {
  await page.evaluate(() => {
    const g = window.__game;
    g.selectEvent("tt-morning");
    g.go("briefing");
  });
  await page.waitForTimeout(800);
  await shot("02-briefing");
  await page.evaluate(() => window.__game.startEvent());
  await waitScreen("driving", 30000);
  await page.waitForTimeout(1000);
  await shot("03-start");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(6000);
  await shot("04-accelerating");
  await fps("driving");
  await page.waitForTimeout(4000);
  await shot("05-t1");
  await page.keyboard.up("KeyW");
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(800);
  await shot("06-far-chase");
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(800);
  await shot("07-hood");
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(800);
  await shot("08-cockpit");
  await page.keyboard.press("KeyC");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await shot("09-pause");
}

if (scenario === "tour") {
  // Teleport the car around the lap for scenery screenshots.
  await page.evaluate(() => window.__game.startEvent("free", "meridian"));
  await waitScreen("driving", 30000);
  const stations = JSON.parse(process.env.STATIONS || "[0, 300, 640, 900, 1200, 1530, 1830, 2150, 2400, 2700, 2930]");
  for (const s of stations) {
    await page.evaluate((s) => {
      const g = window.__game;
      g["spawnAt"]({ s, d: 0, speed: 14 });
    }, s);
    await page.waitForTimeout(2500);
    await shot(`tour-${String(s).padStart(4, "0")}`);
  }
}

if (scenario === "perf") {
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  console.log("GPU:", gpu);
  await page.evaluate(() => window.__game.startEvent("tt-morning", "meridian"));
  await waitScreen("driving", 30000);
  for (const q of ["high", "medium", "low", "ultra"]) {
    await page.evaluate((q) => {
      const g = window.__game;
      const s = structuredClone(g.settings);
      s.graphics.quality = q;
      s.graphics.dynamicResolution = false;
      g.applySettings(s);
    }, q);
    await page.waitForTimeout(2500);
    // Place the car in the forest esses (densest scenery).
    await page.evaluate(() => window.__game["spawnAt"]({ s: 880, d: 0, speed: 20 }));
    await page.waitForTimeout(800);
    const info = await page.evaluate(() => {
      const r = window.__game.renderer.renderer;
      return { calls: r.info.render.calls, tris: r.info.render.triangles, geos: r.info.memory.geometries, tex: r.info.memory.textures, pr: r.getPixelRatio() };
    });
    await fps(`quality ${q}`);
    console.log(q, JSON.stringify(info));
    await shot(`perf-${q}`);
  }
}

if (scenario === "breakdown") {
  await page.evaluate(() => window.__game.startEvent("tt-morning", "meridian"));
  await waitScreen("driving", 30000);
  await page.evaluate(() => {
    const g = window.__game;
    const s = structuredClone(g.settings);
    s.graphics.quality = "medium";
    s.graphics.dynamicResolution = false;
    g.applySettings(s);
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__game["spawnAt"]({ s: 880, d: 0, speed: 0 }));
  await page.waitForTimeout(1000);
  await fps("baseline medium");
  console.log("prof ms", JSON.stringify(await page.evaluate(() => { const p = window.__game.prof; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +v.toFixed(2)])); })));
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2500);
  console.log("prof ms (driving)", JSON.stringify(await page.evaluate(() => { const p = window.__game.prof; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +v.toFixed(2)])); })));
  await page.keyboard.up("KeyW");
  const toggles = [
    ["no vegetation", "g.vegetation.group.visible=false", "g.vegetation.group.visible=true"],
    ["no shadows", "g.renderer.renderer.shadowMap.enabled=false", "g.renderer.renderer.shadowMap.enabled=true"],
    ["no terrain", "g.terrain.group.visible=false", "g.terrain.group.visible=true"],
    ["no far terrain", "g.terrain.far.visible=false", "g.terrain.far.visible=true"],
    ["no road", "g.road.group.visible=false", "g.road.group.visible=true"],
    ["no water", "g.water.mesh.visible=false", "g.water.mesh.visible=true"],
    ["no sky bg", "g.scene.userData.bg=g.scene.background; g.scene.background=null", "g.scene.background=g.scene.userData.bg"],
    ["half res", "g.renderer.renderer.setPixelRatio(0.5)", "g.renderer.renderer.setPixelRatio(1)"],
  ];
  for (const [label, on, off] of toggles) {
    await page.evaluate(`(() => { const g = window.__game; ${on}; })()`);
    await page.waitForTimeout(500);
    await fps(label);
    await page.evaluate(`(() => { const g = window.__game; ${off}; })()`);
  }
}

if (scenario === "laps") {
  // Autopilot drives the player's car through a full time trial; check timing, results, records, ghost.
  await page.evaluate(() => window.__game.startEvent("tt-morning", "meridian"));
  await waitScreen("driving", 30000);
  await page.evaluate(() => window.__game.enableTestDriver(0.93));
  const start = Date.now();
  let lastLap = -1;
  while (Date.now() - start < 420000) {
    const st = await page.evaluate(() => { const g = window.__game; const h = g.hud; return { lap: g.session?.lap, phase: h.phase, t: h.lapTime, show: g.store.get().showResults, toasts: h.toasts.map((x) => x.text) }; });
    if (st.lap !== lastLap) {
      console.log("lap", st.lap, "phase", st.phase, "t", st.t?.toFixed(2), st.toasts.join(" | "));
      lastLap = st.lap;
      if (st.lap === 1) await shot("laps-1");
    }
    if (st.show) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(800);
  await shot("laps-results");
  const summary = await page.evaluate(() => { const g = window.__game; const r = g.store.get().results; return { primary: r?.primary, medal: r?.medal, laps: r?.laps.map((l) => [l.time.toFixed(2), l.valid]), fb: r?.feedback, recs: Object.keys(g.profile.records), ghostSaved: Object.keys(localStorage).filter((k) => k.includes("ghost")) }; });
  console.log(JSON.stringify(summary, null, 1).slice(0, 3000));
  // Retry: the PB ghost should now appear.
  await page.evaluate(() => window.__game.restart());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__game.enableTestDriver(0.9));
  await page.waitForTimeout(25000);
  const gh = await page.evaluate(() => ({ ghost: window.__game.hud.ghost.visible, delta: window.__game.hud.delta, lapStarted: window.__game.hud.lapStarted }));
  console.log("retry ghost/delta:", JSON.stringify(gh));
  await shot("laps-ghost");
}

if (scenario === "modes") {
  // Runs events with the test driver and reports how each one ends.
  const events = (process.env.EVENTS || "lesson-braking,lesson-exits,lesson-trail,sprint-forest,drift-lakeside").split(",");
  await page.evaluate(() => {
    const g = window.__game;
    const s = structuredClone(g.settings);
    s.unlockAll = true;
    g.applySettings(s);
  });
  for (const id of events) {
    await page.evaluate((id) => window.__game.startEvent(id, "meridian"), id);
    await waitScreen("driving", 30000);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__game.enableTestDriver(0.93));
    await page.waitForTimeout(1500);
    await shot(`mode-${id}-start`);
    const start = Date.now();
    let seen = new Set();
    let done = false;
    while (Date.now() - start < +(process.env.MODE_MS || 150000)) {
      const st = await page.evaluate(() => {
        const g = window.__game;
        const h = g.hud;
        return { phase: h.phase, show: g.store.get().showResults, toasts: h.toasts.map((t) => t.text), prompt: h.lesson?.prompt, step: h.lesson?.step, drift: h.drift?.total };
      });
      for (const t of st.toasts) {
        if (seen.has(t)) continue;
        seen.add(t);
        console.log(`  [${id}] toast: ${t}`);
      }
      if (st.prompt && !seen.has(st.prompt)) {
        seen.add(st.prompt);
        console.log(`  [${id}] step ${st.step}: ${st.prompt}`);
      }
      if (st.show) {
        done = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    const r = await page.evaluate(() => {
      const res = window.__game.store.get().results;
      return res ? { primary: res.primary, medal: res.medal, lesson: res.lessonComplete, msg: res.message, sugg: res.feedback?.suggestions, zones: res.zones.map((z) => `${z.name}:${z.score}`) } : null;
    });
    console.log(`${id}: finished=${done}`, JSON.stringify(r));
    await shot(`mode-${id}-end`);
  }
}

if (scenario === "conditions") {
  await page.evaluate(() => {
    const g = window.__game;
    const s = structuredClone(g.settings);
    s.unlockAll = true;
    g.applySettings(s);
  });
  const runs = [
    ["tt-afternoon", null],
    ["tt-rain", null],
    ["free", { time: "dusk", weather: "dry" }],
  ];
  for (const [id, cond] of runs) {
    if (cond) await page.evaluate((c) => window.__game.setFreeConditions(c), cond);
    await page.evaluate((id) => window.__game.startEvent(id, "meridian"), id);
    await waitScreen("driving", 60000);
    for (const s of [120, 1480, 2700]) {
      await page.evaluate((s) => window.__game["spawnAt"]({ s, d: 0, speed: 0 }), s);
      await page.waitForTimeout(1800);
      await shot(`cond-${id}-${cond ? cond.time : ""}-${s}`);
    }
    await fps(`${id}`);
  }
}

if (scenario === "cars") {
  await page.evaluate((q) => {
    const g = window.__game;
    const s = structuredClone(g.settings);
    s.unlockAll = true;
    if (q) s.graphics.quality = q;
    g.applySettings(s);
  }, process.env.QUALITY || "");
  const ids = (process.env.CARS || "meridian,vela,brute,strale,nocturne,volterra").split(",");
  await page.evaluate(() => window.__game.go("garage"));
  for (const id of ids) {
    await page.evaluate((id) => window.__game.selectCar(id), id);
    await page.waitForTimeout(2500);
    await shot(`car-${id}-garage`);
  }
  for (const id of ids.slice(0, +(process.env.DRIVE_N || 3))) {
    await page.evaluate((id) => window.__game.startEvent("free", id), id);
    await waitScreen("driving", 30000);
    await page.evaluate(() => window.__game["spawnAt"]({ s: 60, d: 0, speed: 16 }));
    await page.waitForTimeout(1500);
    await shot(`car-${id}-drive`);
    await page.evaluate(() => window.__game.go("title"));
    await page.waitForTimeout(500);
  }
}

console.log(logs.filter((l) => !l.includes("[vite]") && !l.includes("Download the React DevTools")).slice(0, 40).join("\n"));
await browser.close();
