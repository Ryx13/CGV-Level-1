import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state } from './state.js';

/* ======================================================================
   Scene.js — RENDERER / SCENE / CAMERA / PHYSICS WORLD / HUD

   This is the reusable "base scene" every level builds on. It is
   intentionally a leaf module: it does NOT import characters.js,
   PowerUps.js, or Actions.js. Those three files already import each
   other (and import Scene.js), and characters.js in particular touches
   Scene.js's exports (world, scene, camera, addStaticBox, etc.) at its
   own module top-level (not inside a function) — e.g. it does
   `world.addBody(playerBody)` as a bare statement while the player body
   is being constructed. If Scene.js statically imported characters.js
   too, the circular import would force characters.js to start
   evaluating before Scene.js's own top-level code (this file) has run,
   and that top-level code would then crash trying to use `world`/`scene`
   before they exist. Keeping Scene.js dependency-free of the other three
   avoids that entirely — Level1/2/3.js import Scene.js, characters.js,
   PowerUps.js and Actions.js side-by-side and wire them together at
   runtime, after every module has finished loading.
====================================================================== */

export const dom = {
  loading: document.getElementById('loading'),
  loadFill: document.getElementById('load-fill'),
  loadStatus: document.getElementById('load-status'),
  start: document.getElementById('start-screen'),
  hud: document.getElementById('hud'),
  death: document.getElementById('deathscreen'),
  win: document.getElementById('winscreen'),
  enterBtn: document.getElementById('enter-btn'),
  canvas: document.getElementById('game-canvas'),
  healthFill: document.getElementById('health-fill'),
  staminaFill: document.getElementById('stamina-fill'),
  ammo: document.getElementById('ammo'),
  reloadText: document.getElementById('reload-text'),
  prompt: document.getElementById('prompt'),
  promptText: document.getElementById('prompt-text'),
  killcount: document.getElementById('kills'),
  objective: document.getElementById('objective'),
  objCount: document.getElementById('obj-count'),
  compass: document.getElementById('objective-compass'),
  compassArrow: document.getElementById('compass-arrow'),
  compassLabel: document.getElementById('compass-label'),
  debugReadout: document.getElementById('debug-readout'),
  radar: document.getElementById('radar'),
  crosshair: document.getElementById('crosshair'),
  hitmarker: document.getElementById('hitmarker'),
  killfeed: document.getElementById('killfeed'),
  speedo: document.getElementById('speedo'),
  kph: document.getElementById('kph'),
  flash: document.getElementById('screen-flash'),
  deathStats: document.getElementById('death-stats'),
  winStats: document.getElementById('win-stats'),
  bloodVig: document.getElementById('blood-vignette'),
};

export function addObstacle(x, z, r) { state.obstacles.push({ x, z, r }); }

/* ---------------------------------------------------------------------
   AUDIO — synthesized, no extra files
--------------------------------------------------------------------- */
export const sfx = {
  ctx: null,
  master: null,
  engineOsc: null,
  engineGain: null,
  engineFilter: null,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 280;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
  },
  burst(type, freq, dur, gain = 0.2) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.35), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, gain = 0.15, freq = 1800) {
    if (!this.ctx) return;
    const n = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
  },
  shoot() { this.noise(0.09, 0.22, 1400); this.burst('triangle', 180, 0.12, 0.12); },
  hit() { this.burst('square', 90, 0.08, 0.1); },
  hurt() { this.burst('sawtooth', 140, 0.18, 0.16); },
  pickup() { this.burst('sine', 660, 0.15, 0.1); this.burst('sine', 990, 0.18, 0.06); },
  melee() { this.noise(0.08, 0.12, 400); },
  groan() { this.burst('sawtooth', 70 + Math.random() * 40, 0.45, 0.05); },
  foot() { this.noise(0.05, 0.05, 220); },
  explosion() { this.noise(0.55, 0.4, 300); this.burst('sawtooth', 55, 0.6, 0.32); },
  setEngine(speed, on) {
    if (!this.engineGain) return;
    const t = this.ctx.currentTime;
    const target = on ? THREE.MathUtils.clamp(0.02 + speed * 0.012, 0.02, 0.14) : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.08);
    if (this.engineOsc) this.engineOsc.frequency.setTargetAtTime(42 + speed * 3.2, t, 0.08);
  },
};

/* ---------------------------------------------------------------------
   1. RENDERER / SCENE / CAMERA
--------------------------------------------------------------------- */
export const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;

export const scene = new THREE.Scene();
const SKY_COLOR = 0x6e6258;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.009);

export const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.12, 520);
scene.add(camera); // so a camera-attached first-person viewmodel (added later) actually renders
camera.position.set(3.4, 3.1, 38);
camera.lookAt(1.5, 1.2, 22);

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
onResize();

function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}

const skyCanvas = makeCanvas(8, 64, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1c1a22');
  g.addColorStop(0.45, '#6a5346');
  g.addColorStop(0.72, '#c48a52');
  g.addColorStop(1, '#d9b07a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
});
const skyTex = new THREE.CanvasTexture(skyCanvas);
export const sky = new THREE.Mesh(
  new THREE.SphereGeometry(420, 24, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
);
scene.add(sky);
scene.add(new THREE.HemisphereLight(0xe7c9a0, 0x1a1612, 0.55));
const sun = new THREE.DirectionalLight(0xffc48a, 1.15);
sun.position.set(-80, 42, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 320;
sun.shadow.bias = -0.0007;
scene.add(sun);
sun.target.position.set(0, 0, -50);
scene.add(sun.target);
scene.add(new THREE.AmbientLight(0x3a322c, 0.28));

/* ---------------------------------------------------------------------
   2. PHYSICS WORLD
--------------------------------------------------------------------- */
export const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 16;
world.defaultContactMaterial.friction = 0.45;
export const matGround = new CANNON.Material('ground');
export const matWheel = new CANNON.Material('wheel');
export const matPlayer = new CANNON.Material('player');
export const matChassis = new CANNON.Material('chassis');
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matWheel, {
  friction: 1.4, restitution: 0, contactEquationStiffness: 1e4,
}));
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matPlayer, {
  friction: 0.02, restitution: 0,
}));
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matChassis, {
  friction: 0.1, restitution: 0.1, contactEquationStiffness: 1e4,
}));
const groundBody = new CANNON.Body({ mass: 0, material: matGround });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

export function addStaticBox(hx, hy, hz, x, y, z, ry = 0) {
  const body = new CANNON.Body({ mass: 0, material: matGround });
  body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, ry, 0);
  world.addBody(body);
  addObstacle(x, z, Math.max(hx, hz) + 0.4);
  return body;
}

export const WORLD_BOUND_X = 78;

/* ---------------------------------------------------------------------
   MISSION / LEVEL CONSTANTS — shared by every level
--------------------------------------------------------------------- */
export const STREET_LENGTH = 220;
export const STREET_HALF_W = 10;
export const KILL_TARGET = 10;
export const ZOMBIE_MAX_ALIVE = 14;
export const ZOMBIE_SPAWN_INTERVAL = 2.5;
export const DEPOT_POS = new THREE.Vector3(46, 0, -118);
export const WEST_POCKET_Z = -55;
export const rowX = STREET_HALF_W + 6.4;

export function loadWorldBounds() {
  addStaticBox(2, 10, STREET_LENGTH / 2 + 10, -WORLD_BOUND_X, 10, -STREET_LENGTH / 2 + 20);
  addStaticBox(2, 10, STREET_LENGTH / 2 + 10, WORLD_BOUND_X, 10, -STREET_LENGTH / 2 + 20);
  addStaticBox(WORLD_BOUND_X, 10, 2, 0, 10, 40);
  addStaticBox(WORLD_BOUND_X, 10, 2, 0, 10, -STREET_LENGTH + 10);
}

/* ---------------------------------------------------------------------
   EXTRACTION POINT — self-contained (only needs scene + STREET_LENGTH)
--------------------------------------------------------------------- */
export const extractPos = new THREE.Vector3(0, 0, -STREET_LENGTH + 24);
export const extractRing = new THREE.Mesh(
  new THREE.RingGeometry(2.2, 2.65, 40),
  new THREE.MeshBasicMaterial({ color: 0x33ff77, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
);
extractRing.rotation.x = -Math.PI / 2;
extractRing.position.copy(extractPos).setY(0.06);
extractRing.visible = false;
scene.add(extractRing);
export const extractLight = new THREE.PointLight(0x33ff77, 0, 16, 2);
extractLight.position.copy(extractPos).setY(2);
scene.add(extractLight);

export function updateExtractRing(dt) {
  extractRing.rotation.z += dt * 0.4;
}

export function checkExtraction(pos, onWin) {
  if (!state.ingredientCollected) return;
  if (pos.distanceTo(extractPos) < 3.2) onWin();
}

/* ---------------------------------------------------------------------
   MISSION TRACKER — depot pickup / stage progression.
   Factored as a small factory instead of a top-level function because
   the depot yard object (marker/beam/crate meshes) is built inside
   characters.js's loadBuildings() and returned to the caller — Scene.js
   can't import characters.js (see header note), so the level file hands
   the depotYard reference in here once, after loadBuildings() resolves.
--------------------------------------------------------------------- */
export function createMissionTracker(depotYard) {
  function collectIngredient() {
    if (state.ingredientCollected) return;
    state.ingredientCollected = true;
    state.stage = 3;
    scene.remove(depotYard.crate);
    depotYard.marker.visible = false;
    depotYard.markerLight.intensity = 0;
    depotYard.beam.visible = false;
    depotYard.beamLight.intensity = 0;
    extractRing.visible = true;
    extractLight.intensity = 2.2;
    pushKillFeed('Culture sample secured');
    sfx.pickup();
    updateObjectiveHUD();
  }
  function checkDepotObjective(pos) {
    if (state.ingredientCollected) return;
    if (pos.distanceTo(DEPOT_POS) < 3) collectIngredient();
  }
  return { collectIngredient, checkDepotObjective };
}

/* ---------------------------------------------------------------------
   SMALL SHARED MATH HELPERS
--------------------------------------------------------------------- */
export function forwardFromYaw(yawAngle) {
  return new THREE.Vector3(-Math.sin(yawAngle), 0, -Math.cos(yawAngle));
}
export function rightFromYaw(yawAngle) {
  return new THREE.Vector3(Math.cos(yawAngle), 0, -Math.sin(yawAngle));
}

/* ---------------------------------------------------------------------
   LOADING SCREEN
--------------------------------------------------------------------- */
export function setLoadUI() {
  const n = (state.loadFlags.player ? 1 : 0) + (state.loadFlags.zombie ? 1 : 0) + (state.loadFlags.car ? 1 : 0);
  if (dom.loadFill) dom.loadFill.style.width = `${20 + n * 26}%`;
  if (dom.loadStatus) dom.loadStatus.textContent = `MODELS ${n}/3`;
}
// The intro screen (title/controls/"Enter The City") and the level-select
// screen now both run BEFORE this point (wired in main.js), so by the
// time assets finish loading there's nothing left to gate behind another
// click — reveal the HUD directly. Scene.js still can't import
// characters.js (see the header comment above), so any level-specific
// setup that needs to happen exactly once assets are ready (spawning the
// depot guards, requesting pointer lock, etc.) is registered from
// Actions.js via onAssetsReady() instead of hardcoded here.
let readyCallback = null;
export function onAssetsReady(cb) { readyCallback = cb; }
export function maybeReady() {
  setLoadUI();
  if (state.readyShown) return;
  if (state.loadFlags.player && state.loadFlags.zombie) {
    state.readyShown = true;
    if (dom.loadFill) dom.loadFill.style.width = '100%';
    setTimeout(() => {
      dom.loading.classList.add('hidden');
      dom.hud.classList.remove('hidden');
      if (readyCallback) readyCallback();
    }, 200);
  }
}
export function markLoaded(which) {
  state.loadFlags[which] = true;
  maybeReady();
}
setTimeout(() => {
  state.loadFlags.player = true; state.loadFlags.zombie = true;
  maybeReady();
}, 12000);

/* ---------------------------------------------------------------------
   DYNAMIC HUD ELEMENTS — coins, fuel, weapon and shield readouts didn't
   exist in the original page markup, so they're created here at
   runtime instead of requiring an HTML edit.
--------------------------------------------------------------------- */
export function makeHudEl(id, styles) {
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, {
    position: 'fixed',
    fontFamily: 'inherit, sans-serif',
    color: '#fff',
    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
    zIndex: 20,
    pointerEvents: 'none',
    userSelect: 'none',
  }, styles);
  document.body.appendChild(el);
  return el;
}
dom.coinLabel = makeHudEl('coin-label', {
  top: '14px', left: '50%', transform: 'translateX(-50%)',
  fontSize: '20px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px',
});
dom.fuelWrap = makeHudEl('fuel-wrap', {
  bottom: '86px', right: '18px', width: '150px',
});
dom.fuelWrap.innerHTML = `
  <div style="font-size:12px;letter-spacing:1px;margin-bottom:3px;">FUEL</div>
  <div style="width:100%;height:10px;border:1px solid rgba(255,255,255,0.5);border-radius:4px;overflow:hidden;background:rgba(0,0,0,0.35);">
    <div id="fuel-fill" style="height:100%;width:100%;background:linear-gradient(90deg,#ff8a1a,#ffd27a);"></div>
  </div>`;
dom.fuelFill = document.getElementById('fuel-fill');
dom.weaponLabel = makeHudEl('weapon-label', {
  bottom: '18px', left: '50%', transform: 'translateX(-50%)',
  fontSize: '15px', letterSpacing: '2px', fontWeight: 'bold',
});
dom.shieldLabel = makeHudEl('shield-label', {
  top: '46px', left: '50%', transform: 'translateX(-50%)',
  fontSize: '14px', color: '#37c8ff', display: 'none',
});

export function updateCoinHUD() {
  dom.coinLabel.innerHTML = `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ffd94a;box-shadow:0 0 4px #ffb400;"></span>${state.coins}`;
}
// maxFuel is passed in (rather than imported) because the fuel cap
// (CAR_MAX_FUEL) is defined in characters.js alongside the vehicle, and
// Scene.js cannot import characters.js — see the header note.
export function updateFuelHUD(maxFuel) {
  if (dom.fuelFill) dom.fuelFill.style.width = `${Math.max(0, (state.carFuel / maxFuel) * 100)}%`;
}
export function updateShieldHUD() {
  if (!dom.shieldLabel) return;
  if (state.shieldActive) {
    dom.shieldLabel.style.display = 'block';
    dom.shieldLabel.textContent = `SHIELD ${state.shieldTimer.toFixed(1)}s`;
  } else {
    dom.shieldLabel.style.display = 'none';
  }
}
export function updateWeaponHUD() {
  if (!dom.weaponLabel) return;
  dom.weaponLabel.textContent = state.currentWeapon === 'gun' ? 'PISTOL' : 'KNIFE';
  dom.weaponLabel.style.color = state.currentWeapon === 'gun' ? '#fff4c2' : '#ffd8a8';
}
export function updateAmmoHUD() {
  const low = state.ammoMag <= 3 ? ' id="low-ammo"' : '';
  dom.ammo.innerHTML = `<span${low}>${state.ammoMag}</span><small> / ${state.ammoReserve}</small>`;
}
export function updateObjectiveHUD() {
  dom.killcount.textContent = state.kills;
  if (state.kills >= KILL_TARGET && state.stage === 1) state.stage = 2;
  if (state.stage === 1) {
    dom.objective.innerHTML = `Objective: <b>Fight through to the depot</b> — neutralize <span id="obj-count">${Math.min(state.kills, KILL_TARGET)}/${KILL_TARGET}</span> infected. <i>(Look east for an amber glow above the rooftops — that's the depot, off the main road. A supply cache is hidden west too.)</i>`;
  } else if (state.stage === 2) {
    dom.objective.innerHTML = `Objective: <b>Recover the culture sample</b> — follow the amber marker east into the depot yard.`;
  } else {
    dom.objective.innerHTML = `Objective: <b>Get the sample to extraction</b> — head to the green marker.`;
  }
}
export function updateCompass(pos, forward) {
  const target = state.ingredientCollected ? extractPos : DEPOT_POS;
  const label = state.ingredientCollected ? 'EXTRACTION' : 'DEPOT';
  dom.compass.classList.remove('hidden');
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  const tx = dx / (dist || 1), tz = dz / (dist || 1);
  const cross = forward.x * tz - forward.z * tx;
  const dot = forward.x * tx + forward.z * tz;
  const angle = Math.atan2(cross, dot);
  dom.compassArrow.style.transform = `rotate(${(-angle * 180) / Math.PI}deg)`;
  dom.compassLabel.textContent = `${label} — ${Math.round(dist)}m`;
}
export function pushKillFeed(text) {
  const el = document.createElement('div');
  el.className = 'kf-item';
  el.textContent = text;
  dom.killfeed.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
export function flashDamage() {
  dom.flash.style.background = 'rgba(200,0,0,0.32)';
  setTimeout(() => { dom.flash.style.background = 'rgba(200,0,0,0)'; }, 140);
}
export function doDeath() {
  state.isDead = true;
  sfx.setEngine(0, false);
  document.exitPointerLock();
  state.killStreak = 0;
  dom.deathStats.textContent = `Infected eliminated: ${state.kills} · Coins: ${state.coins}`;
  dom.death.classList.remove('hidden');
}
export function doWin() {
  state.isDead = true;
  sfx.setEngine(0, false);
  document.exitPointerLock();
  dom.winStats.textContent = `Infected eliminated: ${state.kills} · Coins: ${state.coins} · Extraction successful.`;
  dom.win.classList.remove('hidden');
}

/* ---------------------------------------------------------------------
   RADAR
--------------------------------------------------------------------- */
const radarCtx = dom.radar.getContext('2d');
const RADAR_RANGE = 42;
export function drawRadar(selfPos, selfYaw) {
  const w = dom.radar.width, h = dom.radar.height, cx = w / 2, cy = h / 2;
  radarCtx.clearRect(0, 0, w, h);
  radarCtx.fillStyle = 'rgba(20,28,18,0.55)';
  radarCtx.beginPath(); radarCtx.arc(cx, cy, w / 2, 0, Math.PI * 2); radarCtx.fill();
  radarCtx.strokeStyle = 'rgba(80,120,70,0.35)';
  radarCtx.beginPath(); radarCtx.arc(cx, cy, w * 0.25, 0, Math.PI * 2); radarCtx.stroke();
  radarCtx.save();
  radarCtx.translate(cx, cy);
  radarCtx.rotate(-selfYaw);
  state.zombies.forEach((z) => {
    if (!z.alive) return;
    const rx = (z.mesh.position.x - selfPos.x);
    const rz = (z.mesh.position.z - selfPos.z);
    const d = Math.sqrt(rx * rx + rz * rz);
    if (d > RADAR_RANGE) return;
    const px = (rx / RADAR_RANGE) * (w / 2);
    const py = (rz / RADAR_RANGE) * (h / 2);
    radarCtx.fillStyle = '#ff3b3b';
    radarCtx.beginPath(); radarCtx.arc(px, py, 3.5, 0, Math.PI * 2); radarCtx.fill();
  });
  if (extractRing.visible) {
    const rx = extractPos.x - selfPos.x, rz = extractPos.z - selfPos.z;
    if (Math.hypot(rx, rz) < RADAR_RANGE * 1.4) {
      const px = (rx / RADAR_RANGE) * (w / 2), py = (rz / RADAR_RANGE) * (h / 2);
      radarCtx.fillStyle = '#33ff77';
      radarCtx.beginPath(); radarCtx.arc(px, py, 4, 0, Math.PI * 2); radarCtx.fill();
    }
  }
  if (state.stage === 2 && !state.ingredientCollected) {
    const rx = DEPOT_POS.x - selfPos.x, rz = DEPOT_POS.z - selfPos.z;
    const d = Math.hypot(rx, rz);
    const clampedD = Math.min(d, RADAR_RANGE * 0.9);
    const scale = clampedD / (d || 1);
    const px = (rx * scale / RADAR_RANGE) * (w / 2), py = (rz * scale / RADAR_RANGE) * (h / 2);
    radarCtx.fillStyle = '#ffaa22';
    radarCtx.beginPath(); radarCtx.arc(px, py, 4, 0, Math.PI * 2); radarCtx.fill();
  }
  radarCtx.restore();
  radarCtx.fillStyle = '#fff';
  radarCtx.beginPath();
  radarCtx.moveTo(cx, cy - 6); radarCtx.lineTo(cx - 5, cy + 5); radarCtx.lineTo(cx + 5, cy + 5);
  radarCtx.closePath(); radarCtx.fill();
}
