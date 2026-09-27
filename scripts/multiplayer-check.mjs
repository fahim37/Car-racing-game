import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.URL || "http://localhost:3002";
const out = process.argv[2] || ".asset-cache/multiplayer";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const pages = [];
try {
  const makePage = async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 680 } });
    await context.addInitScript(() => localStorage.setItem("larchmere.profile.v1", JSON.stringify({ settings: { graphics: { quality: "low", resolutionScale: 1, dynamicResolution: false } } })));
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    return page;
  };
  const host = await makePage();
  await host.goto(url);
  await host.waitForFunction(() => window.__game?.store.get().screen === "title", { timeout: 60000 });
  await host.getByRole("button", { name: /^Multiplayer/ }).click();
  await host.getByLabel("Driver name").fill("Fahim");
  await host.screenshot({ path: `${out}/lobby.png` });
  await host.getByRole("button", { name: "Host a room" }).click();
  await host.waitForFunction(() => window.__game?.multiplayer.room?.players[0]?.ready);
  const code = await host.evaluate(() => window.__game.multiplayer.room.code);
  console.log("hosted room", code);
  const guest = await makePage();
  await guest.goto(`${url}?room=${code}`);
  await guest.getByLabel("Driver name").waitFor({ state: "visible", timeout: 60000 });
  await guest.getByLabel("Driver name").fill("Guest");
  assert.equal(await guest.getByLabel("Invitation code").inputValue(), code);
  await guest.getByRole("button", { name: "Join room", exact: true }).click();
  await guest.waitForTimeout(1500);
  console.log("join state", JSON.stringify(await guest.evaluate(() => ({ ui: window.__game.store.get(), network: window.__game.multiplayer.store.get() }))));
  console.log("host state", JSON.stringify(await host.evaluate(() => window.__game.multiplayer.store.get())));
  await host.waitForFunction(() => window.__game.multiplayer.room?.players.length === 2 && window.__game.multiplayer.room.players.every((p) => p.ready));
  await guest.waitForFunction(() => window.__game.opponents?.cars.size === 1 && [...window.__game.opponents.cars.values()][0].view);
  console.log("two clients joined; opponent models visible");
  await host.getByRole("button", { name: "Start race", exact: true }).click();
  await guest.waitForFunction(() => window.__game.multiplayer.room?.phase === "countdown");
  const heldAt = await host.evaluate(() => window.__game.vehicle.pos.toArray());
  await host.keyboard.down("KeyW");
  await host.waitForTimeout(700);
  const heldNow = await host.evaluate(() => window.__game.vehicle.pos.toArray());
  assert.ok(Math.hypot(heldAt[0] - heldNow[0], heldAt[2] - heldNow[2]) < 1, "grid must hold during countdown");
  await guest.screenshot({ path: `${out}/countdown.png` });
  await host.waitForFunction(() => window.__game.multiplayer.room?.phase === "racing");
  await host.keyboard.down("KeyN");
  await host.waitForFunction(() => window.__game.vehicle.nitro.active && window.__game.vehicle.nitro.charge < 0.95);
  await guest.waitForFunction(() => window.__game.multiplayer.store.get().peers.some((p) => p.state.nitro));
  await guest.screenshot({ path: `${out}/race-opponent.png` });
  await host.screenshot({ path: `${out}/nitro.png` });
  await host.keyboard.up("KeyN"); await host.keyboard.up("KeyW");
  const transport = await host.evaluate(() => window.__game.multiplayer.socket.io.engine.transport.name);
  assert.equal(transport, "websocket");
  await host.evaluate(() => window.__game.multiplayer.leave());
  await guest.waitForFunction(() => window.__game.multiplayer.room?.hostId === window.__game.multiplayer.store.get().id);
  await guest.getByRole("button", { name: "End race", exact: true }).click();
  await guest.waitForFunction(() => window.__game.multiplayer.room?.phase === "practice");
  await guest.getByRole("button", { name: "Leave", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("PASS: invite link, joining, remote cars, countdown hold, nitro relay, WebSocket upgrade, host transfer, leave");
} catch (error) {
  console.log("browser errors", errors);
  for (let i = 0; i < pages.length; i++) {
    await pages[i].screenshot({ path: `${out}/failure-${i}.png` }).catch(() => {});
    console.log("failure state", i, await pages[i].evaluate(() => ({ ui: window.__game?.store.get(), network: window.__game?.multiplayer.store.get() })).catch(() => null));
  }
  throw error;
} finally { await browser.close(); }
