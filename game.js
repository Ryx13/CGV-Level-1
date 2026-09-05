import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import * as CANNON from 'cannon-es';
// Live-tunable facing offsets (I / O / P in-game cycle these 90°).
let ZOMBIE_RIG_YAW_OFFSET = 0;
let PLAYER_RIG_YAW_OFFSET = Math.PI;
// The car's procedural fallback mesh is built nose-at--Z, matching the
// physics setup (front wheels at z=-1.55) — but the real GLB car model
// that replaces it (assets/zombie_variant_b.glb, loaded further below)
// has its own unverified native orientation, and this defaulted to 0 (no
// correction). Once the engine-force sign was fixed to be physically
// correct (positive = toward -Z, the nose), driving went "all opposite" —
// meaning the loaded model's actual nose very likely faces +Z, the
// opposite of the procedural mesh's. Set to Math.PI to re-align it; press
// P in-game to cycle 90° at a time if this guess isn't quite right.
let CAR_RIG_YAW_OFFSET = Math.PI;
/* ======================================================================
DEADWAY CITY — VERTICAL SLICE
====================================================================== */
const STREET_LENGTH = 220;
const STREET_HALF_W = 10; // was 7 — a big part of "still feels like one street" was
// that the road itself was a narrow ~14-unit corridor. This
// widens it to a proper boulevard (~20 units) before any side
// content is even considered.
const KILL_TARGET = 10; // Stage 1 target — lowered vs. the old 15 because
// confirmed kills now take a follow-up hit (see
// the stabilize/reanimate mechanic below), so
// raw ammo-per-clear time is similar to before.
const ZOMBIE_MAX_ALIVE = 14;
const ZOMBIE_SPAWN_INTERVAL = 2.5;
/* ---------------------------------------------------------------------
MISSION STRUCTURE (matches the story: fight to the depot, recover the
culture sample, get it back to extraction)
--------------------------------------------------------------------- */
let stage = 1; // 1 = clear the route, 2 = recover the sample, 3 = extract
let ingredientCollected = false;
const DEPOT_POS = new THREE.Vector3(46, 0, -118); // side-street compound, off the main road
function mulberry32(a) {
return function () {
a |= 0; a = a + 0x6D2B79F5 | 0;
let t = Math.imul(a ^ a >>> 15, 1 | a);
t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
}
const rnd = mulberry32(0xDEAD01);
document.getElementById('start-screen').style.backgroundImage = "url('assets/splash1.jpg')";
const dom = {
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
const occluders = [];
const obstacles = []; // {x, z, r} for zombie avoidance
const pickups = [];
let shake = 0;
function addObstacle(x, z, r) { obstacles.push({ x, z, r }); }
/* ---------------------------------------------------------------------
AUDIO — synthesized, no extra files
--------------------------------------------------------------------- */
const sfx = {
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
const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
const scene = new THREE.Scene();
const SKY_COLOR = 0x6e6258;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.009); // was 0.012 — the street is now wider
// (STREET_HALF_W 7→10 in an earlier pass), which
// pushes the building rows further from center,
// meaning more of the world was fading into fog
// than before at the same density.
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.12, 520);
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
const skyCanvas = makeCanvas(8, 64, (ctx, w, h) => {
const g = ctx.createLinearGradient(0, 0, 0, h);
g.addColorStop(0, '#1c1a22');
g.addColorStop(0.45, '#6a5346');
g.addColorStop(0.72, '#c48a52');
g.addColorStop(1, '#d9b07a');
ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
});
const skyTex = new THREE.CanvasTexture(skyCanvas);
const sky = new THREE.Mesh(
new THREE.SphereGeometry(420, 24, 16),
new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
);
scene.add(sky);
scene.add(new THREE.HemisphereLight(0xe7c9a0, 0x1a1612, 0.55));
const sun = new THREE.DirectionalLight(0xffc48a, 1.15);
sun.position.set(-80, 42, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); // was 2048 — a 2048² shadow map covering a
// 240×240-unit frustum, re-rendered every
// frame from every shadow-casting object in
// the scene (every building, wreck, prop,
// zombie, and now a skinned character), is a
// classic cause of exactly this kind of
// slowdown. Quarters the shadow render cost.
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
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 16;
world.defaultContactMaterial.friction = 0.45;
const matGround = new CANNON.Material('ground');
const matWheel = new CANNON.Material('wheel');
const matPlayer = new CANNON.Material('player');
const matChassis = new CANNON.Material('chassis');
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matWheel, {
friction: 1.4, restitution: 0, contactEquationStiffness: 1e4,
}));
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matPlayer, {
friction: 0.02, restitution: 0,
}));
// The chassis needs its OWN material, separate from matWheel. RaycastVehicle
// wheels aren't real physics bodies — grip comes from `frictionSlip` on each
// wheel, not from a Body/Material contact — so matWheel above was never
// actually touching anything through a wheel. It WAS being applied to the
// chassis body itself (see chassisBody below), meaning any time the car's
// undercarriage touched the ground or clipped a curb/barrier, it got
// friction 1.4 (high grip, tuned for tires) with very stiff contacts —
// the car effectively glued itself to whatever it touched. This is almost
// certainly the "car always gets stuck" bug.
world.addContactMaterial(new CANNON.ContactMaterial(matGround, matChassis, {
friction: 0.1, restitution: 0.1, contactEquationStiffness: 1e4,
}));
const groundBody = new CANNON.Body({ mass: 0, material: matGround });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);
function addStaticBox(hx, hy, hz, x, y, z, ry = 0) {
const body = new CANNON.Body({ mass: 0, material: matGround });
body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
body.position.set(x, y, z);
body.quaternion.setFromEuler(0, ry, 0);
world.addBody(body);
addObstacle(x, z, Math.max(hx, hz) + 0.4);
return body;
}
// These four are invisible physics-only boundary walls (no mesh) meant to
// stop the player wandering into the decorative silhouette buildings at
// the edge of the world. They used to be tied to STREET_HALF_W, which was
// fine when the only playable area WAS the street — but once the depot
// yard (x≈46) and west supply pocket (x≈-31) were added as real,
// reachable side areas, walls anchored at STREET_HALF_W+14 (=24 at the
// current width) sat BETWEEN the street and both of them, sealing off
// the entire east/west world past x=±24 along the whole length of the
// level. This is almost certainly the "invisible wall, can't reach the
// depot or other places" bug — it would have blocked the depot from the
// very first pass that added it. Widened generously to clear both side
// areas with margin, and decoupled from STREET_HALF_W so it doesn't
// silently break again the next time the street width changes.
const WORLD_BOUND_X = 78;
addStaticBox(2, 10, STREET_LENGTH / 2 + 10, -WORLD_BOUND_X, 10, -STREET_LENGTH / 2 + 20);
addStaticBox(2, 10, STREET_LENGTH / 2 + 10, WORLD_BOUND_X, 10, -STREET_LENGTH / 2 + 20);
addStaticBox(WORLD_BOUND_X, 10, 2, 0, 10, 40);
addStaticBox(WORLD_BOUND_X, 10, 2, 0, 10, -STREET_LENGTH + 10);
/* ---------------------------------------------------------------------
3. TEXTURE HELPERS
--------------------------------------------------------------------- */
function makeCanvas(w, h, draw) {
const c = document.createElement('canvas');
c.width = w; c.height = h;
draw(c.getContext('2d'), w, h);
return c;
}
const asphaltTex = new THREE.CanvasTexture(makeCanvas(512, 512, (ctx, w, h) => {
ctx.fillStyle = '#2a2b2c'; ctx.fillRect(0, 0, w, h);
for (let i = 0; i < 5000; i++) {
const v = 18 + Math.random() * 28;
ctx.fillStyle = `rgba(${v},${v},${v + 2},${Math.random() * 0.55})`;
ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
}
ctx.strokeStyle = 'rgba(8,8,8,0.55)';
ctx.lineWidth = 1.2;
for (let i = 0; i < 14; i++) {
ctx.beginPath();
let x = Math.random() * w, y = Math.random() * h;
ctx.moveTo(x, y);
for (let j = 0; j < 8; j++) {
x += (Math.random() - 0.5) * 50; y += (Math.random() - 0.5) * 50;
ctx.lineTo(x, y);
}
ctx.stroke();
}
// Added purely for visual richness — same texture resolution, same
// single draw call as before, so this costs nothing extra at runtime.
// Oil/fluid stains: soft dark radial blotches, the kind that collect
// under parked engines over years.
for (let i = 0; i < 6; i++) {
const x = Math.random() * w, y = Math.random() * h, r = 12 + Math.random() * 30;
const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
grad.addColorStop(0, 'rgba(5,6,8,0.5)');
grad.addColorStop(0.6, 'rgba(5,6,8,0.22)');
grad.addColorStop(1, 'rgba(5,6,8,0)');
ctx.fillStyle = grad;
ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
// Tire skid marks: paired parallel dark streaks with a slight curve
for (let i = 0; i < 3; i++) {
const startX = Math.random() * w, startY = Math.random() * h;
const angle = Math.random() * Math.PI * 2;
const len = 80 + Math.random() * 140;
const curve = (Math.random() - 0.5) * 0.6;
ctx.strokeStyle = 'rgba(10,10,10,0.4)';
ctx.lineWidth = 3;
[-4, 4].forEach((offset) => {
ctx.beginPath();
for (let t = 0; t <= 1; t += 0.05) {
const a = angle + curve * t;
const px = startX + Math.cos(a) * len * t + Math.cos(a + Math.PI / 2) * offset;
const py = startY + Math.sin(a) * len * t + Math.sin(a + Math.PI / 2) * offset;
t === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
}
ctx.stroke();
});
}
// Patch repairs: lighter rectangular blotches where the road's been
// resurfaced in one spot, breaking up the otherwise uniform tone
for (let i = 0; i < 4; i++) {
const pw = 30 + Math.random() * 60, ph = 20 + Math.random() * 40;
const px = Math.random() * w, py = Math.random() * h;
ctx.fillStyle = `rgba(${40 + Math.random() * 15},${40 + Math.random() * 15},${42},${0.25 + Math.random() * 0.2})`;
ctx.fillRect(px, py, pw, ph);
}
}));
asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping;
asphaltTex.repeat.set(6, 40);
asphaltTex.anisotropy = 8;
const sidewalkTex = new THREE.CanvasTexture(makeCanvas(128, 128, (ctx, w, h) => {
ctx.fillStyle = '#6a655c'; ctx.fillRect(0, 0, w, h);
ctx.strokeStyle = 'rgba(40,38,34,0.45)';
for (let x = 0; x < w; x += 32) {
for (let y = 0; y < h; y += 32) {
ctx.strokeRect(x + 1, y + 1, 30, 30);
}
}
for (let i = 0; i < 200; i++) {
const v = 80 + Math.random() * 40;
ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},0.25)`;
ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
}
// Weeds/grass pushing through slab joints and a few dark grime patches —
// texture-only additions, same draw call, no runtime cost.
for (let i = 0; i < 10; i++) {
const gx = Math.floor(Math.random() * 4) * 32 + 1, gy = Math.floor(Math.random() * 4) * 32;
ctx.strokeStyle = `rgba(${50 + Math.random() * 20},${75 + Math.random() * 20},${30},0.55)`;
ctx.lineWidth = 1;
for (let b = 0; b < 3; b++) {
ctx.beginPath();
ctx.moveTo(gx + Math.random() * 30, gy);
ctx.lineTo(gx + Math.random() * 30, gy - 4 - Math.random() * 5);
ctx.stroke();
}
}
for (let i = 0; i < 8; i++) {
const x = Math.random() * w, y = Math.random() * h, r = 4 + Math.random() * 8;
const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
grad.addColorStop(0, 'rgba(20,20,18,0.35)');
grad.addColorStop(1, 'rgba(20,20,18,0)');
ctx.fillStyle = grad;
ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
}));
sidewalkTex.wrapS = sidewalkTex.wrapT = THREE.RepeatWrapping;
sidewalkTex.repeat.set(2, 40);
const laneTex = new THREE.CanvasTexture(makeCanvas(64, 512, (ctx, w, h) => {
ctx.clearRect(0, 0, w, h);
ctx.fillStyle = 'rgba(220,190,80,0.8)';
for (let y = 0; y < h; y += 90) ctx.fillRect(w / 2 - 3, y, 6, 42);
}));
laneTex.wrapS = laneTex.wrapT = THREE.RepeatWrapping;
laneTex.repeat.set(1, 18);
laneTex.transparent = true;
const windowTex = new THREE.CanvasTexture(makeCanvas(128, 256, (ctx, w, h) => {
ctx.fillStyle = '#2a2724'; ctx.fillRect(0, 0, w, h);
const cols = 5, rows = 10;
for (let r = 0; r < rows; r++) {
for (let c = 0; c < cols; c++) {
const lit = Math.random() < 0.18;
ctx.fillStyle = lit ? `rgba(255,${170 + Math.random() * 50},90,0.95)` : 'rgba(8,9,11,0.92)';
const cw = w / cols, rh = h / rows;
ctx.fillRect(c * cw + 4, r * rh + 4, cw - 8, rh - 8);
}
}
}));
windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
const concreteTex = new THREE.CanvasTexture(makeCanvas(128, 128, (ctx, w, h) => {
ctx.fillStyle = '#4d4a44'; ctx.fillRect(0, 0, w, h);
for (let i = 0; i < 500; i++) {
const v = 60 + Math.random() * 40;
ctx.fillStyle = `rgba(${v},${v - 4},${v - 10},${Math.random() * 0.4})`;
ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
}
}));
concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;
const bloodTex = new THREE.CanvasTexture(makeCanvas(64, 64, (ctx, w, h) => {
const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
g.addColorStop(0, 'rgba(120,8,8,0.85)');
g.addColorStop(0.5, 'rgba(70,4,4,0.45)');
g.addColorStop(1, 'rgba(40,0,0,0)');
ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}));
/* ---------------------------------------------------------------------
4. ENVIRONMENT
--------------------------------------------------------------------- */
const groundGeo = new THREE.PlaneGeometry(STREET_HALF_W * 2 + 70, STREET_LENGTH + 90);
const dirtMat = new THREE.MeshStandardMaterial({ color: 0x3a3530, roughness: 1, metalness: 0 });
const groundMesh = new THREE.Mesh(groundGeo, dirtMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.position.set(0, -0.02, -STREET_LENGTH / 2 + 20);
groundMesh.receiveShadow = true;
scene.add(groundMesh);
const road = new THREE.Mesh(
new THREE.PlaneGeometry(STREET_HALF_W * 2, STREET_LENGTH + 70),
new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.95, metalness: 0 })
);
road.rotation.x = -Math.PI / 2;
road.position.set(0, 0.005, -STREET_LENGTH / 2 + 20);
road.receiveShadow = true;
scene.add(road);
[-1, 1].forEach((side) => {
const walk = new THREE.Mesh(
new THREE.PlaneGeometry(4.2, STREET_LENGTH + 70),
new THREE.MeshStandardMaterial({ map: sidewalkTex, roughness: 0.92 })
);
walk.rotation.x = -Math.PI / 2;
walk.position.set(side * (STREET_HALF_W + 2.1), 0.03, -STREET_LENGTH / 2 + 20);
walk.receiveShadow = true;
scene.add(walk);
const curb = new THREE.Mesh(
new THREE.BoxGeometry(0.22, 0.16, STREET_LENGTH + 70),
new THREE.MeshStandardMaterial({ color: 0x6e6a62, roughness: 0.9 })
);
curb.position.set(side * STREET_HALF_W, 0.08, -STREET_LENGTH / 2 + 20);
curb.castShadow = true; curb.receiveShadow = true;
scene.add(curb);
});
const laneMesh = new THREE.Mesh(
new THREE.PlaneGeometry(0.45, STREET_LENGTH + 60),
new THREE.MeshBasicMaterial({ map: laneTex, transparent: true, opacity: 0.85, depthWrite: false })
);
laneMesh.rotation.x = -Math.PI / 2;
laneMesh.position.set(0, 0.02, -STREET_LENGTH / 2 + 20);
scene.add(laneMesh);
function makeBuilding(x, z, w, h, d) {
const g = new THREE.Group();
const tex = windowTex.clone(); tex.needsUpdate = true;
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.repeat.set(Math.max(2, Math.round(w / 4)), Math.max(3, Math.round(h / 4)));
const tint = new THREE.Color().setHSL(0.08, 0.08, 0.38 + rnd() * 0.12);
const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, color: tint });
const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
mesh.position.y = h / 2;
mesh.castShadow = true; mesh.receiveShadow = true;
g.add(mesh);
const band = new THREE.Mesh(
new THREE.BoxGeometry(w + 0.08, 3.2, d + 0.08),
new THREE.MeshStandardMaterial({ color: 0x2b2724, roughness: 0.9 })
);
band.position.y = 1.6;
g.add(band);
const door = new THREE.Mesh(
new THREE.BoxGeometry(1.2, 2.4, 0.12),
new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.8 })
);
const face = x > 0 ? -1 : 1;
door.position.set(face * (w / 2 - 1.4) * 0.15, 1.2, (x > 0 ? -1 : 1) * (d / 2 + 0.05));
if (x > 0) door.position.z = -d / 2 - 0.06;
else door.position.z = d / 2 + 0.06;
g.add(door);
const roof = new THREE.Mesh(
new THREE.BoxGeometry(w * 0.92, 0.4, d * 0.92),
new THREE.MeshStandardMaterial({ color: 0x2a2824, roughness: 1 })
);
roof.position.y = h + 0.15;
g.add(roof);
if (rnd() > 0.4) {
const ac = new THREE.Mesh(
new THREE.BoxGeometry(1.6, 0.7, 1.2),
new THREE.MeshStandardMaterial({ color: 0x4a4e50, metalness: 0.4, roughness: 0.5 })
);
ac.position.set((rnd() - 0.5) * w * 0.4, h + 0.7, (rnd() - 0.5) * d * 0.3);
ac.castShadow = true;
g.add(ac);
}
if (h > 18 && rnd() > 0.45) {
const railMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 });
for (let i = 0; i < 5; i++) {
const step = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, d * 0.55), railMat);
step.position.set((x > 0 ? -1 : 1) * (w / 2 + 0.35), 4 + i * 2.6, 0);
g.add(step);
}
}
// A stepped-back upper tier on some taller buildings — a single
// rectangular prism reads as "a block" no matter how much surface detail
// (windows, bands, AC units) gets added on top of it, because the
// silhouette itself never changes. This breaks that silhouette on a
// portion of the skyline instead of every building being one box.
if (h > 22 && rnd() > 0.5) {
const tierH = h * (0.25 + rnd() * 0.2);
const tierW = w * (0.55 + rnd() * 0.2);
const tierD = d * (0.55 + rnd() * 0.2);
const tier = new THREE.Mesh(new THREE.BoxGeometry(tierW, tierH, tierD), mat);
tier.position.set((rnd() - 0.5) * (w - tierW) * 0.5, h + tierH / 2, (rnd() - 0.5) * (d - tierD) * 0.5);
tier.castShadow = true; tier.receiveShadow = true;
g.add(tier);
const tierRoof = new THREE.Mesh(
new THREE.BoxGeometry(tierW * 0.94, 0.3, tierD * 0.94),
new THREE.MeshStandardMaterial({ color: 0x2a2824, roughness: 1 })
);
tierRoof.position.set(tier.position.x, h + tierH + 0.15, tier.position.z);
g.add(tierRoof);
}
g.position.set(x, 0, z);
scene.add(g);
g.traverse((o) => { if (o.isMesh) occluders.push(o); });
addStaticBox(w / 2, h / 2, d / 2, x, h / 2, z);
return g;
}
const rowX = STREET_HALF_W + 6.4;
const WEST_POCKET_Z = -55; // a second, smaller side pocket — a supply cache, not a mission —
// purely so the street reads as having multiple real breaks in it
// instead of exactly one side path to notice or miss.
for (let z = 30; z > -STREET_LENGTH + 10; z -= (15 + rnd() * 9)) {
const h = 16 + rnd() * 28;
const w = 11 + rnd() * 7;
const d = 11 + rnd() * 7;
// Skip the east-row building here so there's a guaranteed, real gap in
// the block leading to the depot yard's cross street — previously this
// relied on the row's random spacing happening to leave a gap, which
// wasn't guaranteed and made the depot feel like a random pocket in the
// fog rather than a real side street you could see and choose to enter.
if (Math.abs(z - DEPOT_POS.z) > 16) makeBuilding(rowX + w / 2, z, w, h, d);
if (Math.abs((z + 5) - WEST_POCKET_Z) > 14) {
makeBuilding(-rowX - w / 2, z + 5, w * (0.85 + rnd() * 0.3), h * (0.7 + rnd() * 0.4), d);
}
}
buildWestPocket();
for (let i = 0; i < 18; i++) {
const sil = new THREE.Mesh(
new THREE.BoxGeometry(18 + rnd() * 22, 28 + rnd() * 50, 16 + rnd() * 18),
new THREE.MeshStandardMaterial({ color: 0x1b1816, roughness: 1 })
);
sil.position.set((rnd() < 0.5 ? -1 : 1) * (48 + rnd() * 40), sil.geometry.parameters.height / 2, -20 - rnd() * STREET_LENGTH);
scene.add(sil);
}
const smokeTex = new THREE.CanvasTexture(makeCanvas(64, 64, (ctx, w, h) => {
const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
g.addColorStop(0, 'rgba(70,68,64,0.55)'); g.addColorStop(1, 'rgba(70,68,64,0)');
ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}));
const smokeGroups = [];
function spawnFireEffect(pos, scale = 1) {
const group = new THREE.Group();
for (let i = 0; i < 7; i++) {
const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0.48, depthWrite: false }));
sp.scale.setScalar((1.6 + Math.random()) * scale);
sp.position.set(pos.x + (Math.random() - 0.5), pos.y + i * 0.55 * scale, pos.z + (Math.random() - 0.5));
sp.userData.speed = 0.35 + Math.random() * 0.35;
sp.userData.baseY = sp.position.y;
group.add(sp);
}
scene.add(group);
smokeGroups.push(group);
}
function makeWreck(x, z, ry, burning) {
const g = new THREE.Group();
const col = burning ? 0x2a2320 : [0x4a3a32, 0x3d4550, 0x5c4030, 0x2f3340, 0x8a1f1f, 0x1f3a52][Math.floor(rnd() * 6)];
const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.75, metalness: 0.35 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.2 });
const glassMat = new THREE.MeshStandardMaterial({
color: 0x0e1216, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.55,
});
const crushed = rnd() < 0.4; // flips between a "sitting normally" wreck and a crumpled one
// A real silhouette instead of one flat box: lower chassis + a shorter
// hood + a taller cabin + a shorter trunk, so it actually reads as a
// sedan shape from any angle instead of a slab with a floating cab.
const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.42, 4.2), bodyMat);
chassis.position.y = 0.34;
g.add(chassis);
const hood = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.3, 1.35), bodyMat);
hood.position.set(0, 0.62, 1.42);
g.add(hood);
const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.34, 1.05), bodyMat);
trunk.position.set(0, 0.64, -1.6);
g.add(trunk);
const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.56, 1.9), bodyMat);
cabin.position.set(0, 0.98, -0.1);
if (crushed) { cabin.scale.y = 0.45; cabin.position.y = 0.78; }
g.add(cabin);
const glass = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.4, 1.72), glassMat);
glass.position.copy(cabin.position); glass.position.y += crushed ? 0.06 : 0.1;
g.add(glass);
// Bumpers, ground effect
[1.98, -2.02].forEach((bz) => {
const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.22, 0.18), darkMat);
bumper.position.set(0, 0.3, bz);
g.add(bumper);
});
// Side mirrors — small but they're exactly the kind of detail that
// separates "car-shaped block" from "car"
[-1, 1].forEach((side) => {
const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.22), darkMat);
mirror.position.set(side * 0.85, 1.0, 0.65);
g.add(mirror);
});
const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 12);
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 1 });
const rimGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.3, 8);
const rimMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.4, metalness: 0.6 });
[[-0.92, 0.36, 1.35], [0.92, 0.36, 1.35], [-0.92, 0.36, -1.35], [0.92, 0.36, -1.35]].forEach((p) => {
const wm = new THREE.Mesh(wheelGeo, wheelMat);
wm.rotation.z = Math.PI / 2; wm.position.set(...p); wm.castShadow = true;
g.add(wm);
const rim = new THREE.Mesh(rimGeo, rimMat);
rim.rotation.z = Math.PI / 2; rim.position.set(...p); rim.castShadow = true;
g.add(rim);
});
g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
g.position.set(x, 0, z);
g.rotation.y = ry;
if (crushed || rnd() > 0.6) g.rotation.z = (rnd() - 0.5) * (crushed ? 0.35 : 0.18);
scene.add(g);
g.traverse((o) => { if (o.isMesh) occluders.push(o); });
addStaticBox(1.05, 0.7, 2.15, x, 0.7, z, ry);
if (burning) {
const light = new THREE.PointLight(0xff6a1a, 3.4, 11, 2);
light.position.set(x, 1.15, z);
scene.add(light);
spawnFireEffect(new THREE.Vector3(x, 0.9, z));
}
return g;
}
for (let z = 20; z > -STREET_LENGTH + 20; z -= (18 + rnd() * 16)) {
const side = rnd() < 0.5 ? -1 : 1;
const x = side * (STREET_HALF_W - 1.7 - rnd() * 2);
makeWreck(x, z, (rnd() - 0.5) * 1.1 + (side < 0 ? Math.PI / 2 : -Math.PI / 2), rnd() < 0.32);
}
/* ---------------------------------------------------------------------
Decorative parked/wrecked cars using real GLB models — separate from
the procedural makeWreck() boxes above and from the drivable truck.
Auto-normalizes to a target length the same way the drivable vehicle
does, rather than a hardcoded scale, so it's self-correcting regardless
of the source model's original units.
--------------------------------------------------------------------- */
function loadDecorCar(url, x, z, ry, targetLength) {
new GLTFLoader().load(url, (gltf) => {
const obj = gltf.scene;
obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
const box = new THREE.Box3().setFromObject(obj);
const size = new THREE.Vector3(); box.getSize(size);
const scale = targetLength / Math.max(size.x, size.z, 0.01);
obj.scale.setScalar(scale);
const box2 = new THREE.Box3().setFromObject(obj);
const center = new THREE.Vector3(); box2.getCenter(center);
const wrap = new THREE.Group();
obj.position.set(-center.x, -box2.min.y, -center.z);
wrap.add(obj);
wrap.position.set(x, 0, z);
wrap.rotation.y = ry;
scene.add(wrap);
wrap.traverse((o) => { if (o.isMesh) occluders.push(o); });
const finalSize = box2.getSize(new THREE.Vector3());
addStaticBox(finalSize.x / 2, finalSize.y / 2, finalSize.z / 2, x, finalSize.y / 2, z, ry);
}, undefined, () => { /* if it fails to load, the spot is just empty — no crash */ });
}
// old_rusty_car_2.glb — the car you just gave us, used as street decor.
loadDecorCar('assets/old_rusty_car_2.glb', -(STREET_HALF_W + 3.5), -30, Math.PI / 2 + 0.15, 4.8);
loadDecorCar('assets/old_rusty_car_2.glb', STREET_HALF_W + 4, -150, -Math.PI / 2 - 0.1, 4.8);
// zombie_variant_b.glb — this was the drivable car's model before the
// truck replaced it; repurposed as decor instead of just discarding it,
// per "use the other ones as world decor".
loadDecorCar('assets/zombie_variant_b.glb', -(STREET_HALF_W + 3.2), -95, Math.PI / 2 - 0.2, 4.5);
loadDecorCar('assets/zombie_variant_b.glb', DEPOT_POS.x + 10, DEPOT_POS.z - 4, 0.3, 4.5);
function makeBarrier(x, z, ry) {
const canvasTex = new THREE.CanvasTexture(makeCanvas(64, 64, (ctx, w, h) => {
ctx.fillStyle = '#c8c24a'; ctx.fillRect(0, 0, w, h);
ctx.fillStyle = '#111';
for (let i = -1; i < 3; i++) {
ctx.save(); ctx.translate(i * 22, 0); ctx.rotate(Math.PI / 4); ctx.fillRect(-40, -6, 90, 12); ctx.restore();
}
}));
const mesh = new THREE.Mesh(
new THREE.BoxGeometry(2.4, 0.85, 0.55),
new THREE.MeshStandardMaterial({ map: canvasTex, roughness: 0.9 })
);
mesh.position.set(x, 0.42, z); mesh.rotation.y = ry;
mesh.castShadow = true; mesh.receiveShadow = true;
scene.add(mesh);
occluders.push(mesh);
addStaticBox(1.2, 0.42, 0.28, x, 0.42, z, ry);
}
for (let i = 0; i < 6; i++) {
const z = -20 - i * 24;
makeBarrier((i % 2 === 0 ? -2.4 : 2.4), z, Math.PI / 2 + (rnd() - 0.5) * 0.28);
}
function makeStreetlight(x, z) {
const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2c2c, roughness: 0.55, metalness: 0.65 });
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 8), poleMat);
pole.position.set(x, 3, z); pole.castShadow = true;
scene.add(pole);
const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6), poleMat);
arm.rotation.z = Math.PI / 2;
arm.position.set(x + (x > 0 ? -0.7 : 0.7), 5.9, z);
scene.add(arm);
const lamp = new THREE.Mesh(
new THREE.SphereGeometry(0.18, 8, 8),
new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffc266, emissiveIntensity: 1.8 })
);
lamp.position.set(x + (x > 0 ? -1.35 : 1.35), 5.85, z);
scene.add(lamp);
const pl = new THREE.PointLight(0xffc070, 1.15, 16, 1.8);
pl.position.copy(lamp.position);
scene.add(pl);
addObstacle(x, z, 0.35);
}
for (let z = 24; z > -STREET_LENGTH + 20; z -= 42) {
makeStreetlight(-STREET_HALF_W + 0.55, z);
makeStreetlight(STREET_HALF_W - 0.55, z);
}
function makeDumpster(x, z) {
const mesh = new THREE.Mesh(
new THREE.BoxGeometry(1.35, 1.15, 0.85),
new THREE.MeshStandardMaterial({ color: 0x2d4a32, roughness: 0.7, metalness: 0.25 })
);
mesh.position.set(x, 0.58, z);
mesh.castShadow = true; mesh.receiveShadow = true;
scene.add(mesh);
occluders.push(mesh);
addStaticBox(0.7, 0.58, 0.45, x, 0.58, z);
}
for (let i = 0; i < 8; i++) {
const side = i % 2 === 0 ? -1 : 1;
makeDumpster(side * (STREET_HALF_W + 1.6), 8 - i * 22 - rnd() * 6);
}
for (let i = 0; i < 20; i++) {
const side = rnd() < 0.5 ? -1 : 1;
const x = side * (STREET_HALF_W + 0.4 + rnd() * 2.2);
const z = 18 - rnd() * (STREET_LENGTH + 8);
const rock = new THREE.Mesh(
new THREE.DodecahedronGeometry(0.28 + rnd() * 0.55, 0),
new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 })
);
rock.position.set(x, 0.22, z);
rock.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
rock.castShadow = true; rock.receiveShadow = true;
scene.add(rock);
}
for (let i = 0; i < 6; i++) {
spawnFireEffect(new THREE.Vector3((rnd() - 0.5) * 90, 6 + rnd() * 8, -STREET_LENGTH * (0.25 + rnd() * 0.7)), 2.2);
}
const extractPos = new THREE.Vector3(0, 0, -STREET_LENGTH + 24);
const extractRing = new THREE.Mesh(
new THREE.RingGeometry(2.2, 2.65, 40),
new THREE.MeshBasicMaterial({ color: 0x33ff77, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
);
extractRing.rotation.x = -Math.PI / 2;
extractRing.position.copy(extractPos).setY(0.06);
extractRing.visible = false;
scene.add(extractRing);
const extractLight = new THREE.PointLight(0x33ff77, 0, 16, 2);
extractLight.position.copy(extractPos).setY(2);
scene.add(extractLight);
/* ---------------------------------------------------------------------
4b. DEPOT YARD — the open-world side objective
A walled compound reached by breaking off the main street to the east,
through the gaps between the row buildings. This is what turns the
level from "one street" into a small open area with a real side
destination instead of empty fog on either side.
--------------------------------------------------------------------- */
function buildWestPocket() {
// A small supply cache off the west side of the street — no mission gate,
// no guards, just a second real reason to step off the main road. On its
// own the depot could still read as "the one designated side-quest spot";
// this is here so leaving the street to look around is something the
// level rewards more than once.
const px = -(rowX + 15), pz = WEST_POCKET_Z;
const lot = new THREE.Mesh(
new THREE.PlaneGeometry(20, 18),
new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 })
);
lot.rotation.x = -Math.PI / 2;
lot.position.set(px, 0.015, pz);
lot.receiveShadow = true;
scene.add(lot);
makeWreck(px - 4, pz - 3, Math.PI * 0.15, false);
makeWreck(px + 5, pz + 4, -Math.PI * 0.4, rnd() < 0.3);
makeDumpster(px + 3, pz - 5);
makeStreetlight(px, pz + 8);
spawnPickup(new THREE.Vector3(px, 0, pz), rnd() < 0.5 ? 'health' : 'ammo');
pickups[pickups.length - 1].life = Infinity; // a placed cache, not a combat drop —
// shouldn't despawn before it's found
}
let crateModelTemplate = null; // cached once crate_box.glb loads, so decorative
// duplicates can clone it instead of re-fetching
function buildDepotYard() {
const cx = DEPOT_POS.x, cz = DEPOT_POS.z;
// The cross street: a real paved road connecting the main street to the
// depot, with its own sidewalk edge and a streetlight — this is what
// turns "gap in the buildings" into a readable side street you'd
// actually recognize and choose to walk down, instead of empty fog.
const crossRoadTex = asphaltTex.clone();
crossRoadTex.needsUpdate = true;
crossRoadTex.repeat.set(Math.max(2, Math.round((cx - STREET_HALF_W + 4) / 6)), 3);
const crossRoad = new THREE.Mesh(
new THREE.PlaneGeometry(cx - STREET_HALF_W + 4, 8),
new THREE.MeshStandardMaterial({ map: crossRoadTex, roughness: 1 })
);
crossRoad.rotation.x = -Math.PI / 2;
crossRoad.position.set((STREET_HALF_W + cx) / 2 - 2, 0.015, cz);
crossRoad.receiveShadow = true;
scene.add(crossRoad);
const crossSidewalkTex = sidewalkTex.clone();
crossSidewalkTex.needsUpdate = true;
crossSidewalkTex.repeat.set(Math.max(2, Math.round((cx - STREET_HALF_W + 4) / 3)), 4);
const crossSidewalk = new THREE.Mesh(
new THREE.PlaneGeometry(cx - STREET_HALF_W + 4, 11),
new THREE.MeshStandardMaterial({ map: crossSidewalkTex, roughness: 1 })
);
crossSidewalk.rotation.x = -Math.PI / 2;
crossSidewalk.position.set((STREET_HALF_W + cx) / 2 - 2, 0.008, cz);
scene.add(crossSidewalk);
makeStreetlight(STREET_HALF_W + 6, cz + 5.5);
makeStreetlight(cx - 10, cz - 5.5);
// Yard ground plate (visually marks the compound from a distance)
const yard = new THREE.Mesh(
new THREE.PlaneGeometry(34, 30),
new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 })
);
yard.rotation.x = -Math.PI / 2;
yard.position.set(cx, 0.02, cz);
yard.receiveShadow = true;
scene.add(yard);
// Two low warehouse buildings framing a courtyard
makeBuilding(cx - 12, cz - 8, 12, 10, 14);
makeBuilding(cx + 11, cz + 7, 10, 8, 12);
// Zombies steer via the soft `obstacles` list (they have no physics body),
// so without these two circles the depot guards could visually clip
// through the warehouse walls while wandering — buildings elsewhere never
// needed this because zombies are normally clamped well clear of them.
addObstacle(cx - 12, cz - 8, 8);
addObstacle(cx + 11, cz + 7, 7);
// Perimeter fencing (reuses the barrier mesh) with a gap facing the street —
// this is the way in, so the player never has to backtrack far
const fencePts = [
[cx - 16, cz + 12, 0], [cx - 8, cz + 12, 0],
[cx + 4, cz + 12, 0], [cx + 12, cz + 12, 0],
[cx - 16, cz - 12, 0], [cx - 8, cz - 12, 0], [cx, cz - 12, 0],
[cx + 8, cz - 12, 0], [cx + 16, cz - 12, 0],
// West-side (street-facing) fence intentionally left out entirely —
// this is where the cross-road actually enters the yard, and the two
// segments that used to be here (at cz-6 and cz+2) overlapped the
// road's own arrival span (cz±4), physically blocking part of the one
// path into the yard. That's a second, smaller contributor to "can't
// reach the depot" on top of the world-boundary wall bug above.
[cx + 16, cz - 6, Math.PI / 2], [cx + 16, cz + 2, Math.PI / 2], [cx + 16, cz + 8, Math.PI / 2],
];
fencePts.forEach((p) => makeBarrier(p[0], p[1], p[2]));
makeDumpster(cx - 6, cz + 6);
makeDumpster(cx + 5, cz - 9);
for (let i = 0; i < 5; i++) {
const rock = new THREE.Mesh(
new THREE.DodecahedronGeometry(0.3 + rnd() * 0.4, 0),
new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 })
);
rock.position.set(cx + (rnd() - 0.5) * 24, 0.2, cz + (rnd() - 0.5) * 20);
rock.castShadow = true;
scene.add(rock);
}
// Amber marker over the sample crate — same visual language as the green
// extraction ring, so the player reads it instantly as "objective here"
const marker = new THREE.Mesh(
new THREE.RingGeometry(1.5, 1.85, 32),
new THREE.MeshBasicMaterial({ color: 0xffaa22, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
);
marker.rotation.x = -Math.PI / 2;
marker.position.set(cx, 0.08, cz);
scene.add(marker);
const markerLight = new THREE.PointLight(0xffaa22, 2.4, 14, 2);
markerLight.position.set(cx, 2, cz);
scene.add(markerLight);
// A beam visible above the rooftops from most of the main street — the
// ground-level ring/light alone was too easy to miss from a distance
// through fog and behind buildings. This is a thin, additive, unlit
// cone that reads as a glow in the sky rather than a solid object, the
// same visual language as a searchlight or beacon.
const beam = new THREE.Mesh(
new THREE.CylinderGeometry(0.15, 2.2, 34, 16, 1, true),
new THREE.MeshBasicMaterial({
color: 0xffaa22, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
})
);
beam.position.set(cx, 17, cz);
scene.add(beam);
// No extra PointLight here — a 60-radius light affects every object's
// shading calculation across a huge swath of the scene simultaneously
// (three.js's default forward renderer evaluates every light against
// every lit material in view), and this project had already accumulated
// ~15+ always-on point lights across several passes. That combination is
// a textbook cause of "most of the world stops rendering" on anything
// but a high-end GPU — the unlit additive beam mesh above reads as a
// glow without that cost.
const beamLight = { intensity: 0 }; // inert stand-in so collectIngredient()'s cleanup still works
const crateGroup = new THREE.Group();
crateGroup.position.set(cx, 0, cz);
const cratePlaceholder = new THREE.Mesh(
new THREE.BoxGeometry(0.7, 0.7, 0.7),
new THREE.MeshStandardMaterial({ color: 0xffcc55, emissive: 0xaa6600, emissiveIntensity: 0.6, roughness: 0.5 })
);
cratePlaceholder.position.y = 0.35;
crateGroup.add(cratePlaceholder);
scene.add(crateGroup);
// crate_box.glb loads async — the placeholder box shows immediately so
// there's never a moment with nothing there, then gets swapped once the
// real model is ready. crateGroup itself is what collectIngredient()
// removes, so it stays a stable reference regardless of which visual
// is currently inside it.
const CRATE_SCALE = 0.01; // measured 60.018 units -> real ~0.6m crate
new GLTFLoader().load('assets/crate_box.glb', (gltf) => {
crateModelTemplate = gltf.scene;
const model = crateModelTemplate.clone(true);
model.scale.setScalar(CRATE_SCALE);
model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
crateGroup.remove(cratePlaceholder);
crateGroup.add(model);
// A few extra, purely decorative crates nearby (reusing the already-
// loaded template, so no extra network fetch) — just visual density
// around the depot yard, no gameplay significance.
[[cx - 5, cz - 9, 0.4], [cx - 4.4, cz - 9, 0.9], [cx + 8, cz + 8, -0.3]].forEach(([dx, dz, ry]) => {
const c = crateModelTemplate.clone(true);
c.scale.setScalar(CRATE_SCALE);
c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
c.position.set(dx, 0, dz);
c.rotation.y = ry;
scene.add(c);
c.traverse((o) => { if (o.isMesh) occluders.push(o); });
addStaticBox(0.3, 0.3, 0.3, dx, 0.3, dz);
});
}, undefined, () => { /* keep the placeholder box if this fails to load */ });
// A directional signpost near the main street pointing toward the yard,
// so it doesn't feel randomly tacked on — the player is told it exists.
const signPole = new THREE.Mesh(
new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6),
new THREE.MeshStandardMaterial({ color: 0x333333 })
);
signPole.position.set(STREET_HALF_W + 3, 1.2, -70);
scene.add(signPole);
const signBoard = new THREE.Mesh(
new THREE.BoxGeometry(1.6, 0.6, 0.06),
new THREE.MeshStandardMaterial({ color: 0xdaa520, emissive: 0x442a00, emissiveIntensity: 0.4 })
);
signBoard.position.set(STREET_HALF_W + 3, 2.1, -70);
signBoard.rotation.y = Math.PI / 5;
scene.add(signBoard);
return { marker, markerLight, crate: crateGroup, beam, beamLight };
}
const depotYard = buildDepotYard();
function collectIngredient() {
if (ingredientCollected) return;
ingredientCollected = true;
stage = 3;
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
/* ---------------------------------------------------------------------
5. ASSETS
--------------------------------------------------------------------- */
const loader = new GLTFLoader();
let corpseTemplate = null;
const loadFlags = { player: false, zombie: false, car: false };
let readyShown = false;
function setLoadUI() {
const n = (loadFlags.player ? 1 : 0) + (loadFlags.zombie ? 1 : 0) + (loadFlags.car ? 1 : 0);
if (dom.loadFill) dom.loadFill.style.width = `${20 + n * 26}%`;
if (dom.loadStatus) dom.loadStatus.textContent = `MODELS ${n}/3`;
}
function maybeReady() {
setLoadUI();
if (readyShown) return;
if (loadFlags.player && loadFlags.zombie) {
readyShown = true;
if (dom.loadFill) dom.loadFill.style.width = '100%';
setTimeout(() => {
dom.loading.classList.add('hidden');
dom.start.classList.remove('hidden');
}, 200);
}
}
setTimeout(() => {
loadFlags.player = true; loadFlags.zombie = true;
maybeReady();
}, 12000);
loader.load('assets\\zombie_running_on_metel_maniac.glb', (gltf) => {
const obj = gltf.scene;
const box = new THREE.Box3().setFromObject(obj);
const size = new THREE.Vector3(); box.getSize(size);
const longest = Math.max(size.x, size.y, size.z) || 1;
obj.scale.setScalar(1.8 / longest);
obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
corpseTemplate = obj;
scatterCorpses();
}, undefined, () => {});
function scatterCorpses() {
if (!corpseTemplate) return;
for (let i = 0; i < 8; i++) {
const c = corpseTemplate.clone(true);
const side = rnd() < 0.5 ? -1 : 1;
const x = side * (STREET_HALF_W - 1 - rnd() * 3);
const z = 10 - rnd() * (STREET_LENGTH + 10);
c.rotation.y = rnd() * Math.PI * 2;
c.rotation.x = Math.PI / 2 + (rnd() - 0.5) * 0.28;
c.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(c);
c.position.set(x, -box.min.y, z);
scene.add(c);
}
}
const ZOMBIE_TARGET_HEIGHT = 1.8;
const zombieTemplates = [];
let zombieTemplateResolved = false;
// Finds a skeleton bone/node whose name CONTAINS the given substring,
// rather than matching it exactly. The two zombie rigs below are both
// Mixamo exports, but one keeps the "mixamorig:" prefix on every bone
// name and the other has it stripped — an exact getObjectByName('L_Ankle')
// (the old rig's convention) matches neither, so foot-bone lookups need to
// search by substring against Mixamo's actual bone names ("LeftFoot",
// "RightFoot") to work for both files.
function findBoneLike(root, substr) {
let found = null;
root.traverse((o) => {
if (!found && o.name && o.name.includes(substr)) found = o;
});
return found;
}
function loadZombieTemplate(path) {
new GLTFLoader().load(path, (gltf) => {
const obj = gltf.scene;
let box = new THREE.Box3().setFromObject(obj);
const size = new THREE.Vector3(); box.getSize(size);
const scale = THREE.MathUtils.clamp(ZOMBIE_TARGET_HEIGHT / Math.max(size.y, 0.2), 0.15, 2.8);
obj.scale.setScalar(scale);
box = new THREE.Box3().setFromObject(obj);
const footOffset = -box.min.y + 0.05;
obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
zombieTemplates.push({ scene: obj, animations: gltf.animations || [], footOffset });
loadFlags.zombie = true;
maybeReady();
if (!zombieTemplateResolved) {
zombieTemplateResolved = true;
for (let i = 0; i < 6; i++) spawnZombie();
}
}, undefined, () => {
loadFlags.zombie = true;
maybeReady();
if (!zombieTemplateResolved) {
zombieTemplateResolved = true;
for (let i = 0; i < 6; i++) spawnZombie();
}
});
}
// Both files are actual RUNNING-loop animations (a single baked Mixamo
// run cycle each, "mixamo.com" / "Animation"), replacing the old walking
// zombie_rigged.glb. Zombies now randomly pick one of these two rigs per
// spawn (see the Zombie constructor) instead of always using one model,
// so the horde reads as a mixed crowd instead of identical clones.
loadZombieTemplate('assets/zombie_running_on_metel_maniac.glb');
loadZombieTemplate('assets/zombie_Running.glb');
/* ---------------------------------------------------------------------
6. PLAYER
--------------------------------------------------------------------- */
const playerHeight = 1.9;
const playerBody = new CANNON.Body({
mass: 80,
material: matPlayer,
fixedRotation: true,
linearDamping: 0.9,
});
playerBody.addShape(new CANNON.Cylinder(0.32, 0.32, playerHeight, 8));
playerBody.position.set(1.5, playerHeight / 2 + 0.25, 30);
playerBody.updateMassProperties();
world.addBody(playerBody);
function buildPlayerMesh() {
const g = new THREE.Group();
const proceduralBody = new THREE.Group();
g.add(proceduralBody);
const skin = new THREE.MeshStandardMaterial({ color: 0xcbb499, roughness: 0.8 });
const jacket = new THREE.MeshStandardMaterial({ color: 0x33383c, roughness: 0.7 });
const pants = new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.8 });
const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 0.58, 4, 8), jacket);
torso.position.y = 1.0; torso.castShadow = true;
proceduralBody.add(torso);
// A neck, and a head positioned to actually sit ABOVE the torso instead
// of overlapping into it. The previous numbers put the head's bottom
// ~0.27 units inside the torso capsule's top — with no gap between
// them at all, they visually fused into one rounded blob, which is
// exactly what was reported ("a thing with a round body and head").
const torsoTop = 1.0 + 0.29 + 0.23; // capsule half-length + radius
const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.09, 8), skin);
neck.position.y = torsoTop + 0.045;
neck.castShadow = true;
proceduralBody.add(neck);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 12), skin);
head.position.y = torsoTop + 0.09 + 0.155;
head.castShadow = true;
proceduralBody.add(head);
const hip = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.2, 4, 8), pants);
hip.position.y = 0.6; hip.castShadow = true;
proceduralBody.add(hip);
function limb(mat, len, radius) {
const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 4, 8), mat);
m.castShadow = true;
return m;
}
const legL = limb(pants, 0.7, 0.11); legL.position.set(-0.13, 0.35, 0);
const legR = limb(pants, 0.7, 0.11); legR.position.set(0.13, 0.35, 0);
const armL = limb(jacket, 0.55, 0.09); armL.position.set(-0.42, 1.05, 0);
const armR = limb(jacket, 0.55, 0.09); armR.position.set(0.42, 1.05, 0);
proceduralBody.add(legL, legR, armL, armR);
const gunPivot = new THREE.Group();
const gun = buildRifleMesh();
gunPivot.add(gun);
gunPivot.position.set(0.42, 0.95, -0.15);
g.add(gunPivot);
return { group: g, proceduralBody, legL, legR, armL, armR, gun, gunPivot, head, rigged: false, mixer: null };
}
/* A shared rifle-shaped weapon mesh, used for both the third-person
holstered/aiming gun and the first-person viewmodel. The previous gun
was 3 boxes (a "slide", a grip, a thin barrel) — no magazine, no stock,
no sights, which reads as a pistol silhouette even though it fires
full-auto out of a 30-round mag. A hanging magazine alone is most of
what makes a shape instantly read as "rifle" rather than "pistol". */
function buildRifleMesh() {
const g = new THREE.Group();
const dark = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.65, roughness: 0.38 });
const grip = new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.1, roughness: 0.75 });
const metal = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.8, roughness: 0.3 });
// Upper receiver / body — the main long spine of the weapon
const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.62), dark);
body.position.z = -0.08;
g.add(body);
// Barrel + front handguard
const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.26, 8), metal);
barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.5;
g.add(barrel);
const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.06, 0.24), dark);
handguard.position.z = -0.42;
g.add(handguard);
const foreSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.012), metal);
foreSight.position.set(0, 0.07, -0.62);
g.add(foreSight);
// Pistol grip, angled back-and-down under the receiver
const gripMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.19, 0.075), grip);
gripMesh.position.set(0, -0.13, 0.1);
gripMesh.rotation.x = -0.28;
g.add(gripMesh);
// Magazine — hanging down ahead of the grip, angled slightly forward.
// This is the single detail that most separates "rifle" from "pistol".
const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.24, 0.06), dark);
mag.position.set(0, -0.22, -0.02);
mag.rotation.x = 0.18;
g.add(mag);
// Stock, folded back behind the grip
const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.24), dark);
stock.position.set(0, -0.01, 0.28);
g.add(stock);
const stockPad = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.03), grip);
stockPad.position.set(0, -0.01, 0.4);
g.add(stockPad);
// Rear sight / low optic block on top of the receiver
const optic = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.045, 0.11), metal);
optic.position.set(0, 0.075, -0.1);
g.add(optic);
// Trigger guard
const guard = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 10, Math.PI), metal);
guard.rotation.x = Math.PI / 2;
guard.position.set(0, -0.06, 0.06);
g.add(guard);
g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
// Scale is intentionally NOT baked in here anymore. A real rifle is
// roughly 1m — proportionate and correctly visible on a ~1.8m third-
// person body. The earlier "gun is huge" complaints were specifically
// about the first-person viewmodel a few inches from the camera, where
// true-to-life scale reads as oversized on screen; that's a viewmodel
// framing problem, not a wrong model size. Baking a 0.5 shrink in here
// fixed the close-up view but also shrank the third-person gun to the
// point it was barely visible on the full body — see viewmodelGun below
// for where the shrink now actually belongs.
return g;
}
const playerVis = buildPlayerMesh();
scene.add(playerVis.group);
/* ---------------------------------------------------------------------
PISTOL MODEL — replaces the procedural rifle mesh once it loads. Scale
factor (0.00987) computed from the model's actual measured geometry
(29.37 units long) against a real pistol's ~0.29m length — this file
came from an FBX pipeline (same telltale as the player/vehicle models
below), which conventionally exports at 1 unit = 1cm.
--------------------------------------------------------------------- */
const PISTOL_SCALE = 0.00987;
let pistolTemplate = null;
function makePistolVisual() {
const wrap = new THREE.Group();
const inst = pistolTemplate.clone(true);
inst.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
inst.scale.setScalar(PISTOL_SCALE);
wrap.add(inst);
return wrap;
}
// Applies the current grip preset's rotation to whichever gun instances
// aren't updated reactively elsewhere. The hand-tracked third-person case
// (syncHandGun) already reads GUN_GRIP_PRESETS live every frame; this
// covers the first-person viewmodel and the static (non-hand-tracked)
// fallback case, both of which only need to be set when the preset
// actually changes, not every frame.
function applyGunOrientation() {
const preset = GUN_GRIP_PRESETS[gunGripIndex];
if (viewmodelGun.children[0]) viewmodelGun.children[0].rotation.set(...preset.rot);
if (!playerVis.gunOnHand && playerVis.gun) playerVis.gun.rotation.set(...preset.rot);
}
function applyPistolModel() {
if (!pistolTemplate) return;
const newThirdPerson = makePistolVisual();
playerVis.gunPivot.remove(playerVis.gun);
playerVis.gunPivot.add(newThirdPerson);
playerVis.gun = newThirdPerson;
const newViewGun = makePistolVisual();
newViewGun.scale.multiplyScalar(0.7); // still shrunk for the close-up
// viewmodel, less aggressively
// than the old rifle (0.5) since
// a real pistol is already small
if (viewmodelGun.children[0]) viewmodelGun.remove(viewmodelGun.children[0]);
viewmodelGun.add(newViewGun);
applyGunOrientation();
pushKillFeed('Pistol model loaded');
}
new GLTFLoader().load('assets/pistol.glb', (gltf) => {
pistolTemplate = gltf.scene;
applyPistolModel();
}, undefined, () => {
pushKillFeed('Pistol model failed to load — using procedural gun');
});
/* First-person viewmodel — a separate gun model attached directly to the
camera (not the character rig), so its position is fully under our
control instead of depending on rig-bone transforms we have no way to
verify without seeing it rendered. This is also what makes first-person
aiming exact: the shot raycast already fires from the camera's own
position/direction, and in third person there's an inherent gap between
that and where the character visually looks aimed, especially at close
range. In first person the camera IS the gun's reference frame, so
there's no gap to begin with. */
const viewmodelGun = new THREE.Group();
const viewmodelGunMesh = buildRifleMesh();
viewmodelGunMesh.scale.setScalar(0.5); // shrink belongs here, not in the shared
// builder — see buildRifleMesh's own note
viewmodelGun.add(viewmodelGunMesh);
viewmodelGun.position.set(0.22, -0.2, -0.42);
viewmodelGun.visible = false;
camera.add(viewmodelGun);
const PLAYER_TARGET_HEIGHT = 1.9;
const PLAYER_FOOT_ADJUST = 1.0;;
// The auto-computed scale (target height ÷ measured bounding-box height)
// came out roughly 3x too large for this specific rig — likely the bind-
// pose bounding box for a SkinnedMesh doesn't measure the same as the
// posed character. Rather than guess a fixed correction blind a second
// time, this is a live-adjustable multiplier: press [ and ] in-game to
// scale the model down/up 5% at a time, with the resulting height printed
// to the kill feed each press. Tell me the final number that looks right
// and I'll bake it in as the permanent default.
let playerScaleOverride = 0.55; // was 0.4 — still measured too small. Rather than
// guess a 4th time, the debug readout now shows
// actual height in meters directly next to the
// zombie reference height, so [ / ] can be dialed
// in precisely instead of by feel.
let playerBaseScale = 1; // the raw auto-computed value, before the override
let playerRigObjRef = null;
let playerCurrentHeight = 0; // cached each time applyPlayerScale runs, so the
// persistent debug readout can show it without
// recomputing a Box3 every single frame
function applyPlayerScale() {
if (!playerRigObjRef) return;
const finalScale = playerBaseScale * playerScaleOverride;
playerRigObjRef.scale.setScalar(finalScale);
const box = new THREE.Box3().setFromObject(playerRigObjRef);
playerRigObjRef.position.y = -box.min.y + PLAYER_FOOT_ADJUST;
const height = box.max.y - box.min.y;
playerCurrentHeight = height;
pushKillFeed(`Player scale ×${finalScale.toFixed(3)} — height ${height.toFixed(2)}m (zombies are ~${ZOMBIE_TARGET_HEIGHT}m)`);
}
// A handful of candidate grip orientations for attaching the gun to the
// hand bone — this rig's hand_r bone axis conventions are UE-mannequin
// style, different from the zombie rig's, and I have no way to render
// the result to pick the right one blind. Press U in-game to cycle
// through these; whichever looks right, tell me the preset number shown
// in the kill feed and I'll make it the permanent default next pass.
const GUN_GRIP_PRESETS = [
{ pos: [0.04, -0.02, 0.09], rot: [-Math.PI / 2, 0, 0] },
{ pos: [0.04, -0.02, 0.09], rot: [-Math.PI / 2, 0, Math.PI / 2] },
{ pos: [0.02, 0.03, 0.06], rot: [0, Math.PI / 2, 0] },
{ pos: [0.02, 0.03, 0.06], rot: [Math.PI / 2, 0, Math.PI / 2] },
{ pos: [0, -0.05, 0.1], rot: [0, 0, 0] },
// Added for the pistol.glb swap — its native orientation is unknown, so
// these cover more of the sphere of likely candidates than the original
// 5 (which were tuned around the procedural rifle's known convention).
{ pos: [0.02, -0.02, 0.08], rot: [0, 0, Math.PI / 2] },
{ pos: [0.02, -0.02, 0.08], rot: [0, Math.PI, Math.PI / 2] },
{ pos: [0.02, -0.02, 0.08], rot: [Math.PI / 2, Math.PI / 2, 0] },
{ pos: [0.02, -0.02, 0.08], rot: [-Math.PI / 2, Math.PI / 2, 0] },
{ pos: [0.02, -0.02, 0.08], rot: [0, -Math.PI / 2, 0] },
];
let gunGripIndex = 0;
new GLTFLoader().load('assets/zombie_walker.glb', (gltf) => {
const obj = gltf.scene;
const box0 = new THREE.Box3().setFromObject(obj);
const size = new THREE.Vector3(); box0.getSize(size);
playerBaseScale = THREE.MathUtils.clamp(PLAYER_TARGET_HEIGHT / Math.max(size.y, 0.2), 0.05, 2.8);
obj.rotation.y = PLAYER_RIG_YAW_OFFSET;
obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
playerVis.proceduralBody.visible = false;
playerVis.group.add(obj);
playerVis.rigged = true;
playerVis.rigObj = obj;
playerRigObjRef = obj;
applyPlayerScale();
playerVis.footBoneL = obj.getObjectByName('foot_l') || null;
playerVis.footBoneR = obj.getObjectByName('foot_r') || null;
// The gun is tracked to the hand bone's WORLD transform every frame
// (position + rotation only — see syncHandGun) rather than reparented
// as an actual child of the bone. Reparenting into a scaled rig
// hierarchy is exactly what caused the earlier "gun inherits the rig's
// scale-up and renders huge" bug with the zombie rig; tracking the
// world transform gets the same visual result (gun follows the hand
// through every animation) without ever inheriting that scale.
const handBone = obj.getObjectByName('hand_r');
if (handBone) {
playerVis.handBone = handBone;
playerVis.gunOnHand = true;
playerVis.group.remove(playerVis.gunPivot);
scene.add(playerVis.gunPivot);
}
// Using the exact clip names confirmed to be in this file, instead of
// guessed names — "Sprint" existed in the file but apparently isn't a
// real running gait; Run_Anime is the one that actually is. Idle now
// uses Pistol_Idle (a real standing/aiming stance) instead of the
// earlier hack of holding the Walk clip paused on its first frame.
if (gltf.animations && gltf.animations.length) {
playerVis.mixer = new THREE.AnimationMixer(obj);
const findClip = (name) => THREE.AnimationClip.findByName(gltf.animations, name);
const walkClip = findClip('Walk');
const runClip = findClip('Run_Anime') || walkClip;
const jumpClip = findClip('Jump_2');
const shootClip = findClip('Pistol_Shoot');
const idleClip = findClip('Pistol_Idle') || walkClip;
const found = { Walk: !!walkClip, Run_Anime: !!runClip, Jump_2: !!jumpClip, Pistol_Shoot: !!shootClip, Pistol_Idle: !!findClip('Pistol_Idle') };
pushKillFeed('Anim clips: ' + Object.entries(found).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' '));
playerVis.actions = {};
if (walkClip) playerVis.actions.walk = playerVis.mixer.clipAction(walkClip);
if (runClip) playerVis.actions.sprint = playerVis.mixer.clipAction(runClip);
if (idleClip) playerVis.actions.idle = playerVis.mixer.clipAction(idleClip); // a real standing/aiming stance now, not a paused wa
if (jumpClip) {
// Jump goes into the SAME exclusive actions dict as idle/walk/sprint,
// not a separately-layered one-shot — this mixer plays every active
// action's influence on the same bones simultaneously with no
// automatic blend logic of its own, so layering a full-body jump
// pose on top of an already-playing walk pose would just fight it
// rather than blend cleanly. Routing it through setPlayerAction
// keeps exactly one action driving the body at a time. A short lock
// timer (playerActionLock, see updatePlayerMovement) stops the
// per-frame locomotion check from immediately overriding it back to
// walk/idle the very next frame.
playerVis.actions.jump = playerVis.mixer.clipAction(jumpClip);
playerVis.actions.jump.setLoop(THREE.LoopOnce);
playerVis.actions.jump.clampWhenFinished = true;
playerVis.jumpDuration = jumpClip.duration;
}
// Pistol_Shoot is layered as an ADDITIVE clip on top of whichever
// locomotion action (idle/walk/sprint) is currently playing, using
// three.js's built-in additive-blend support — this is the standard
// way to play an upper-body "fire" pose over a full-body walk/idle
// cycle without a real bone mask, and needs no external tooling.
// makeClipAdditive() converts the clip in place to be relative to its
// own first frame, and AdditiveAnimationBlendMode makes the mixer sum
// it on top of the base action instead of overriding it.
if (shootClip) {
const additiveShoot = THREE.AnimationUtils.makeClipAdditive(shootClip);
playerVis.shootAction = playerVis.mixer.clipAction(additiveShoot);
playerVis.shootAction.blendMode = THREE.AdditiveAnimationBlendMode;
playerVis.shootAction.setLoop(THREE.LoopOnce);
playerVis.shootAction.clampWhenFinished = true;
playerVis.shootAction.enabled = true;
playerVis.shootAction.setEffectiveWeight(1);
}
// Deliberately NOT using crossfade (fadeIn/fadeOut weight blending)
// this pass — "does not walk, just slides" points at something wrong
// in how actions were being started, and weight-blend logic is one
// more moving part that could be the culprit. Plain stop/play, one
// action active at a time, is the simplest possible thing that could
// work; once confirmed animating at all, blending can come back.
if (playerVis.actions.idle) {
playerVis.actions.idle.play();
playerVis.currentActionName = 'idle';
}
}
loadFlags.player = true;
maybeReady();
}, undefined, (err) => {
console.error('Player model failed to load:', err);
pushKillFeed('Player model failed to load — using fallback body');
loadFlags.player = true; maybeReady();
});
function setPlayerAction(name) {
if (!playerVis.actions || playerVis.currentActionName === name) return;
const to = playerVis.actions[name];
if (!to) return;
Object.values(playerVis.actions).forEach((a) => { a.paused = false; a.stop(); });
to.reset().play();
playerVis.currentActionName = name;
}
function triggerOneShot(action) {
if (!action) return;
action.reset().setEffectiveWeight(1).play();
}
// Plays the gun-fire pose layered on top of whatever locomotion is
// currently active, without disturbing it (see the additive setup where
// shootAction is built). Restarting it on every shot at full-auto rates
// is intentional — a snappy re-trigger reads better than letting a long
// clip play out and get cut mid-pose by the next shot.
function triggerShootAnim() {
if (!playerVis.shootAction) return;
playerVis.shootAction.reset();
playerVis.shootAction.play();
}
// Reused across frames instead of allocated fresh each call — this ran every
// single frame, and allocating throwaway Vector3/Quaternion/Euler objects
// 60 times a second is unnecessary garbage-collection pressure. Small on
// its own, but consistent with tightening up anything in the hot path
// while performance is already under scrutiny.
const _gunSyncPos = new THREE.Vector3();
const _gunSyncQuat = new THREE.Quaternion();
const _gunGripQuat = new THREE.Quaternion();
const _gunGripEuler = new THREE.Euler();
function syncHandGun() {
if (!playerVis.gunOnHand || !playerVis.handBone || inVehicle) return;
playerVis.handBone.getWorldPosition(_gunSyncPos);
playerVis.handBone.getWorldQuaternion(_gunSyncQuat);
const preset = GUN_GRIP_PRESETS[gunGripIndex];
playerVis.gunPivot.position.copy(_gunSyncPos);
playerVis.gunPivot.quaternion.copy(_gunSyncQuat);
_gunGripEuler.set(...preset.rot);
_gunGripQuat.setFromEuler(_gunGripEuler);
playerVis.gunPivot.quaternion.multiply(_gunGripQuat);
playerVis.gunPivot.translateX(preset.pos[0]);
playerVis.gunPivot.translateY(preset.pos[1]);
playerVis.gunPivot.translateZ(preset.pos[2]);
}
let playerHealth = 100;
let playerMaxHealth = 100;
let playerStamina = 100;
let isDead = false;
let walkCycle = 0;
let footTimer = 0;
let crouching = false;
let isSprinting = false; // shared with updateCameraOnFoot for the sprint FOV kick
let playerActionLock = 0; // seconds remaining before locomotion animation
// (idle/walk/sprint) is allowed to take back over
// from a one-shot action like jump
let meleeTimer = 0;
let bobPhase = 0;
/* ---------------------------------------------------------------------
7. VEHICLE
--------------------------------------------------------------------- */
const carSpawn = new THREE.Vector3(-1.8, 0.85, 22);
const CAR_MAX_FUEL = 100;
let carFuel = CAR_MAX_FUEL; // topped up by "petrol" powerup drops; drains while driving
function buildCarMesh() {
const g = new THREE.Group();
const bodyRoot = new THREE.Group();
g.add(bodyRoot);
const paint = new THREE.MeshStandardMaterial({ color: 0xb3151f, metalness: 0.62, roughness: 0.22 });
const glass = new THREE.MeshStandardMaterial({ color: 0x141a1e, metalness: 0.2, roughness: 0.08, transparent: true, opacity: 0.72 })
;
const dark = new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0.4, roughness: 0.5 });
const lower = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.5, 4.35), paint);
lower.position.y = 0.48; lower.castShadow = true; lower.receiveShadow = true;
bodyRoot.add(lower);
const hood = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 1.45), paint);
hood.position.set(0, 0.72, -1.5); hood.castShadow = true;
bodyRoot.add(hood);
const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 1.85), glass);
cabin.position.set(0, 0.98, 0.15); cabin.castShadow = true;
bodyRoot.add(cabin);
const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.26, 0.95), paint);
trunk.position.set(0, 0.74, 1.78);
bodyRoot.add(trunk);
const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.26, 0.22), dark);
bumperF.position.set(0, 0.36, -2.28);
bodyRoot.add(bumperF);
const bumperR = bumperF.clone(); bumperR.position.z = 2.28; bodyRoot.add(bumperR);
const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 2.4 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0808, emissive: 0xff1a1a, emissiveIntensity: 1.8 });
[-0.65, 0.65].forEach((x) => {
const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.06), headMat);
hl.position.set(x, 0.5, -2.36); bodyRoot.add(hl);
const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.06), tailMat);
tl.position.set(x, 0.55, 2.36); bodyRoot.add(tl);
});
const headlightSpot1 = new THREE.SpotLight(0xfff1c8, 5.5, 46, Math.PI / 7, 0.45, 1.1);
headlightSpot1.position.set(-0.55, 0.52, -2.2);
const target1 = new THREE.Object3D(); target1.position.set(-0.55, 0.1, -22); g.add(target1);
headlightSpot1.target = target1;
g.add(headlightSpot1);
const headlightSpot2 = new THREE.SpotLight(0xfff1c8, 5.5, 46, Math.PI / 7, 0.45, 1.1);
headlightSpot2.position.set(0.55, 0.52, -2.2);
const target2 = new THREE.Object3D(); target2.position.set(0.55, 0.1, -22); g.add(target2);
headlightSpot2.target = target2;
g.add(headlightSpot2);
g.position.copy(carSpawn);
scene.add(g);
const wheelMeshes = [];
const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.34, 18);
// Baked into the GEOMETRY itself, not the mesh's .rotation — this wheel
// mesh's quaternion gets overwritten wholesale every frame from the
// physics engine's wheel transform (see the per-frame update: `.quaternion
// .copy(wt.quaternion)`), which silently discarded a mesh-level rotation
// set here. A cylinder's default orientation has its flat circular caps
// facing up/down (along local Y) — exactly "lying flat like a coin"
// instead of standing up like a wheel. Rotating the geometry's actual
// vertex data once, up front, means the correction survives having an
// entirely different quaternion applied to the mesh later.
wheelGeo.rotateZ(Math.PI / 2);
const rimMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.4, metalness: 0.7 });
for (let i = 0; i < 4; i++) {
const wm = new THREE.Mesh(wheelGeo, rimMat);
wm.castShadow = true;
scene.add(wm);
wheelMeshes.push(wm);
}
return { group: g, bodyRoot, wheelMeshes, headlightSpot1, headlightSpot2, wheelBones: null };
}
const carVis = buildCarMesh();
// Real measured scale for zombie_pickup_truck.glb: 462.34 units long ->
// real ~5.2m (a bit longer than a stock pickup, matching a "survival
// truck" with front add-ons). Same auto-normalize approach as before
// (target length ÷ measured length) rather than a hardcoded factor, so
// it's self-correcting regardless of the exact source units.
const TRUCK_TARGET_LENGTH = 5.2;
new GLTFLoader().load('assets/zombie_pickup_truck.glb', (gltf) => {
const obj = gltf.scene;
obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
const box = new THREE.Box3().setFromObject(obj);
const size = new THREE.Vector3(); box.getSize(size);
const scale = TRUCK_TARGET_LENGTH / Math.max(size.x, size.z, 0.01);
obj.scale.setScalar(scale);
const box2 = new THREE.Box3().setFromObject(obj);
const center = new THREE.Vector3(); box2.getCenter(center);
obj.position.set(-center.x, -box2.min.y - 0.02, -center.z);
while (carVis.bodyRoot.children.length) carVis.bodyRoot.remove(carVis.bodyRoot.children[0]);
carVis.bodyRoot.add(obj);
carVis.bodyRoot.rotation.y = CAR_RIG_YAW_OFFSET;
carVis.loadedCar = obj;
// This model has no wheel-rotation rig (it's a single static mesh, no
// skin/bones) unlike the old car — carVis.wheelBones stays null, which
// the per-frame update already treats as "use the procedural cylinder
// wheels instead" (see the wheelBones-is-null branch). That means the
// truck's own baked-in wheel geometry stays static while the separate
// rotating cylinders spin next to it — not perfect, but the visible
// rotation cue matters more than avoiding a minor visual overlap, and
// there's no way to split wheels out of a single static mesh without
// 3D editing tools I don't have here.
loadFlags.car = true;
maybeReady();
}, undefined, () => { loadFlags.car = true; maybeReady(); });
const chassisShape = new CANNON.Box(new CANNON.Vec3(1.05, 0.5, 2.6)); // widened/lengthened
// for the truck (was
// 0.9/0.38/2.1, sized
// for the old sedan)
const chassisBody = new CANNON.Body({ mass: 1650, material: matChassis, linearDamping: 0.12, angularDamping: 0.35 });
chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.5, 0));
chassisBody.position.set(carSpawn.x, 1.05, carSpawn.z);
chassisBody.angularVelocity.set(0, 0, 0);
const vehicle = new CANNON.RaycastVehicle({
chassisBody,
indexForwardAxis: 2,
indexRightAxis: 0,
indexUpAxis: 1,
});
const wheelOptions = {
radius: 0.46, // was 0.38, matched to the bigger visible wheel cylinders
directionLocal: new CANNON.Vec3(0, -1, 0),
suspensionStiffness: 46,
suspensionRestLength: 0.32,
frictionSlip: 3.6,
dampingRelaxation: 2.9,
dampingCompression: 5.2,
maxSuspensionForce: 240000,
rollInfluence: 0.1,
axleLocal: new CANNON.Vec3(1, 0, 0),
chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
maxSuspensionTravel: 0.24,
customSlidingRotationalSpeed: -28,
useCustomSlidingRotationalSpeed: true,
};
wheelOptions.chassisConnectionPointLocal.set(-1.05, 0.1, -1.95); vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: wheelOptions.chassisConnectionPointLocal.clone() });
wheelOptions.chassisConnectionPointLocal.set(1.05, 0.1, -1.95); vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: wheelOptions.chassisConnectionPointLocal.clone() });
wheelOptions.chassisConnectionPointLocal.set(-1.05, 0.1, 1.95); vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: wheelOptions.chassisConnectionPointLocal.clone() });
wheelOptions.chassisConnectionPointLocal.set(1.05, 0.1, 1.95); vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: wheelOptions.chassisConnectionPointLocal.clone() });
vehicle.addToWorld(world);
const FRONT_WHEELS = [0, 1];
const REAR_WHEELS = [2, 3];
const MAX_STEER = 0.5;
const MAX_ENGINE_FORCE = 5600; // bumped up from 4200 to match the truck's
// heavier mass (1650kg vs the old 1150kg)
// so power-to-weight feel isn't sluggish
const MAX_BRAKE_FORCE = 65;
const HANDBRAKE_FORCE = 95;
let inVehicle = false;
let carSteer = 0;
let carThrottle = 0;
let rolloverTimer = 0;
function checkVehicleRollover(dt) {
// Same class of bug as the player's velocity lerp: carSteer/carThrottle
// are also self-referential lerps, and speedKph (which feeds into them)
// is derived from chassisBody.velocity — so if that ever goes non-finite
// from a rough physics event, it poisons steering/throttle permanently
// AND silently disables the recovery below (isUpsideDown && speed<1.5 is
// always false when speed is NaN, so rolloverTimer never accumulates).
// Self-heal before that can happen.
if (!Number.isFinite(chassisBody.velocity.x) || !Number.isFinite(chassisBody.velocity.y) || !Number.isFinite(chassisBody.velocity.z)
|| !Number.isFinite(chassisBody.position.x) || !Number.isFinite(chassisBody.position.y) || !Number.isFinite(chassisBody.position.z
)) {
chassisBody.position.set(carSpawn.x, carSpawn.y + 1, carSpawn.z);
chassisBody.quaternion.set(0, 0, 0, 1);
chassisBody.velocity.set(0, 0, 0);
chassisBody.angularVelocity.set(0, 0, 0);
carSteer = 0;
carThrottle = 0;
rolloverTimer = 0;
return;
}
const worldUp = new CANNON.Vec3();
chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0), worldUp);
const speed = chassisBody.velocity.length();
const isUpsideDown = worldUp.y < -0.15;
rolloverTimer = (isUpsideDown && speed < 1.5) ? rolloverTimer + dt : 0;
if (rolloverTimer > 1.5) {
const q = new THREE.Quaternion(chassisBody.quaternion.x, chassisBody.quaternion.y, chassisBody.quaternion.z, chassisBody.quaternion.w);
const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
const uprightQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
chassisBody.quaternion.set(uprightQ.x, uprightQ.y, uprightQ.z, uprightQ.w);
chassisBody.position.y += 1.15;
chassisBody.velocity.set(0, 0, 0);
chassisBody.angularVelocity.set(0, 0, 0);
rolloverTimer = 0;
pushKillFeed('Vehicle righted itself');
}
}
/* ---------------------------------------------------------------------
8. ZOMBIES
--------------------------------------------------------------------- */
const zombieMat1 = new THREE.MeshStandardMaterial({ color: 0x5c6b4c, roughness: 0.95 });
const zombieMat2 = new THREE.MeshStandardMaterial({ color: 0x3f4a38, roughness: 0.95 });
const woundMat = new THREE.MeshStandardMaterial({ color: 0x5c1414, roughness: 1 });
function buildZombieMesh() {
const g = new THREE.Group();
const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.6, 4, 8), zombieMat1);
torso.position.y = 1.0; torso.castShadow = true;
g.add(torso);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), zombieMat2);
head.position.y = 1.5; head.castShadow = true;
g.add(head);
const wound = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), woundMat);
wound.position.set(0.15, 1.05, 0.18);
g.add(wound);
const hip = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.15, 4, 8), zombieMat1);
hip.position.y = 0.58;
g.add(hip);
function limb(mat, len, r) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat); m.castShadow = true; return m;
}
const legL = limb(zombieMat2, 0.65, 0.1); legL.position.set(-0.12, 0.33, 0);
const legR = limb(zombieMat2, 0.65, 0.1); legR.position.set(0.12, 0.33, 0);
const armL = limb(zombieMat1, 0.5, 0.08); armL.position.set(-0.38, 0.95, 0);
const armR = limb(zombieMat1, 0.5, 0.08); armR.position.set(0.38, 0.95, 0);
g.add(legL, legR, armL, armR);
g.traverse((o) => { if (o.isMesh) o.userData.isZombiePart = true; });
return { group: g, legL, legR, armL, armR, head };
}
function avoidObstacles(pos, move, extra = []) {
const push = new THREE.Vector3();
const list = obstacles.concat(extra);
for (let i = 0; i < list.length; i++) {
const o = list[i];
const dx = pos.x - o.x, dz = pos.z - o.z;
const d = Math.hypot(dx, dz) || 0.0001;
const minD = o.r + 0.55;
if (d < minD) {
const str = (minD - d) / minD;
push.x += (dx / d) * str;
push.z += (dz / d) * str;
}
}
move.add(push);
if (move.lengthSq() > 0.0001) move.normalize();
return move;
}
class Zombie {
constructor(pos) {
this.mesh = new THREE.Group();
const template = zombieTemplates.length ? zombieTemplates[Math.floor(Math.random() * zombieTemplates.length)] : null;
this.rigged = !!template;
this.hasAnim = false;
if (this.rigged) {
const rigInstance = skeletonClone(template.scene);
rigInstance.position.y = template.footOffset;
rigInstance.rotation.y = ZOMBIE_RIG_YAW_OFFSET;
this.mesh.add(rigInstance);
this.rigObj = rigInstance;
// Both zombie GLBs are Mixamo rigs — one keeps the "mixamorig:" bone
// prefix, the other doesn't — so this looks up feet by substring
// (see findBoneLike) rather than one fixed exact name, and matches
// Mixamo's actual bone names ("LeftFoot"/"RightFoot") instead of the
// old rig's "L_Ankle"/"R_Ankle" convention.
this.footBoneL = findBoneLike(rigInstance, 'LeftFoot') || null;
this.footBoneR = findBoneLike(rigInstance, 'RightFoot') || null;
if (template.animations.length) {
this.hasAnim = true;
this.mixer = new THREE.AnimationMixer(rigInstance);
// Each file ships exactly one clip — a genuine running loop
// ("mixamo.com" / "Animation") — so animations[0] is always the
// run cycle now, not a walk that then had to be sped up.
this.action = this.mixer.clipAction(template.animations[0]);
this.action.play();
this.mixer.timeScale = 0.4; // idle shuffle rate; ramped up toward a
// real run rate in playWalk() once chasing
}
} else {
const built = buildZombieMesh();
this.mesh.add(built.group);
this.limbs = built;
}
const hitbox = new THREE.Mesh(
new THREE.CapsuleGeometry(0.35, 1.0, 4, 8),
// side: DoubleSide matters here — a raycast whose origin ends up
// INSIDE a convex mesh only registers a hit against back-facing
// triangles (you're looking at their inside surface), which the
// default FrontSide culls out entirely. If the player and a zombie
// ever end up overlapping (exactly the "goes through me" case),
// the camera/raycast origin can land inside the hitbox capsule —
// and with FrontSide-only, that zombie becomes unshootable until
// you separate again. This is very likely the direct cause of
// "then I can't shoot them after that."
new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
);
hitbox.position.y = 1.0;
hitbox.userData.owner = this;
this.hitbox = hitbox;
this.mesh.add(hitbox);
this.mesh.position.copy(pos);
this.mesh.userData.owner = this;
// Raycasts now target the real rendered geometry (see tryShoot), not
// just the hitbox capsule — tag every visible mesh so a hit anywhere
// on the model resolves back to this zombie. The capsule stays as a
// fallback/minimum target for the low-poly procedural fallback build.
this.mesh.traverse((o) => {
if (!o.isMesh) return;
o.userData.owner = this;
// GLTF-imported materials default to FrontSide. The hitbox capsule
// was already DoubleSide for exactly this reason (see its own
// comment above), but now that shots raycast against the real
// model too, its materials need the same treatment: at close range
// the camera/ray origin can end up very near or inside the mesh,
// and FrontSide-only geometry doesn't register hits against
// back-facing triangles seen from the inside. This is almost
// certainly the direct cause of "shooting doesn't kill at close
// range" — point-blank shots are exactly where this matters most.
const mats = Array.isArray(o.material) ? o.material : [o.material];
mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
});
scene.add(this.mesh);
this.health = 50 + Math.floor(Math.random() * 20);
this.maxHealth = this.health;
this.state = 'idle';
this.countedKill = false;
// Zombies now use real running animations, so their actual movement
// speed was bumped to match a running gait instead of the previous
// toned-down shamble-to-jog range (1.0-2.0) — that range looked wrong
// (legs cycling in a run pose while barely covering ground) once the
// walk-cycle rig was swapped for an actual run-loop GLB.
this.speed = 2.6 + Math.random() * 1.6;
this.attackCooldown = 0;
this.deathTimer = 0;
this.idleDir = Math.random() * Math.PI * 2;
this.idleTimer = 2 + Math.random() * 3;
this.wobble = Math.random() * 10;
this.groanTimer = 2 + Math.random() * 6;
this.alive = true;
}
takeDamage(dmg, headshot) {
if (!this.alive) return;
// EASY LEVEL: one successful hit permanently kills the zombie.
// Keep the normal hit effects, loot, coin drop and kill-streak system
// by sending the zombie straight to the permanent-kill path.
this.health = 0;
spawnHitSpark(this.mesh.position.clone().add(new THREE.Vector3(0, headshot ? 1.55 : 1.15, 0)));
spawnBlood(this.mesh.position);
sfx.hit();
shake = Math.max(shake, headshot ? 0.18 : 0.1);
this.confirmedKill(headshot);
}
goDown() {
this.state = 'downed';
this.downedTimer = 8 + Math.random() * 7;
this.mesh.rotation.x = Math.PI / 2;
this.mesh.position.y = 0.12;
pushKillFeed('Infected down');
}
reanimate() {
this.health = Math.round(this.maxHealth * 0.55);
this.state = 'idle';
this.mesh.rotation.x = 0;
this.mesh.position.y = 0;
this.idleTimer = 0; // repick a direction immediately
sfx.groan();
pushKillFeed('An infected is back up — watch your six');
}
confirmedKill(headshot) {
if (!this.alive) return;
this.alive = false;
this.state = 'dead';
this.deathTimer = 6;
// Count the kill when it becomes permanent. This also makes Easy
// one-hit kills update the objective immediately.
if (!this.countedKill) {
this.countedKill = true;
kills++;
updateObjectiveHUD();
}
pushKillFeed(headshot ? 'Headshot — down for good' : 'Down for good');
if (Math.random() < 0.5) spawnPickup(this.mesh.position, Math.random() < 0.3 ? 'health' : 'ammo');
// Coin drop: every confirmed (permanent) kill drops a coin the player
// has to walk over to collect — separate from the ammo/health drop
// above, so a kill can award both.
spawnCoin(this.mesh.position);
// Kill-streak powerup: every 3rd confirmed kill in a row (reset by a
// player death, see doDeath) drops one random powerup on top of the
// normal loot.
registerKillstreak(this.mesh.position);
}
update(dt, playerPos) {
if (!this.alive) {
this.deathTimer -= dt;
if (this.deathTimer <= 0) this.remove();
return;
}
if (this.state === 'downed') {
this.downedTimer -= dt;
if (this.downedTimer <= 0) this.reanimate();
return; // no movement/attack while stabilized
}
this.wobble += dt;
this.groanTimer -= dt;
if (this.groanTimer <= 0) {
this.groanTimer = 4 + Math.random() * 7;
if (this.mesh.position.distanceTo(playerPos) < 18) sfx.groan();
}
const toPlayer = new THREE.Vector3().subVectors(playerPos, this.mesh.position);
toPlayer.y = 0;
const dist = toPlayer.length();
if (dist < 26) this.state = dist < 1.55 ? 'attack' : 'chase';
else if (this.state !== 'idle') this.state = 'idle';
const others = zombies.filter((z) => z !== this && z.alive).map((z) => ({
x: z.mesh.position.x, z: z.mesh.position.z, r: 0.7,
}));
if (this.state === 'chase') {
const move = toPlayer.clone().normalize();
avoidObstacles(this.mesh.position, move, others);
// Zombies are Three.js meshes rather than Cannon bodies, so Cannon
// cannot prevent them from entering the player's body. Test the
// proposed next position before moving and stop at the combined
// player/zombie radius.
const PLAYER_RADIUS = 0.32;
const ZOMBIE_RADIUS = 0.65;
const MIN_DISTANCE = PLAYER_RADIUS + ZOMBIE_RADIUS;
const nextX = this.mesh.position.x + move.x * this.speed * dt;
const nextZ = this.mesh.position.z + move.z * this.speed * dt;
const nextDist = Math.hypot(playerPos.x - nextX, playerPos.z - nextZ);
if (nextDist > MIN_DISTANCE) {
this.mesh.position.x = nextX;
this.mesh.position.z = nextZ;
}
this.mesh.position.x = clampZombieX(this.mesh.position.x, this.mesh.position.z);
const targetAngle = Math.atan2(move.x, move.z);
this.mesh.rotation.y = lerpAngle(this.mesh.rotation.y, targetAngle, dt * 5);
// Animation playback rate tracks actual movement speed, tuned so a
// zombie at the new running speed (~2.6-4.2) plays its run-loop clip
// close to its natural 1.0x rate instead of racing far ahead of it —
// at the old shamble speeds this same formula was tuned around a
// slower walk cycle, so it needed re-deriving for the run clips.
this.playWalk(dt, 8, 0.55 + this.speed * 0.2);
} else if (this.state === 'attack') {
const targetAngle = Math.atan2(toPlayer.x, toPlayer.z);
this.mesh.rotation.y = lerpAngle(this.mesh.rotation.y, targetAngle, dt * 8);
this.attackCooldown -= dt;
this.playWalk(dt, 3, 0.7);
if (this.attackCooldown <= 0 && !inVehicle) {
this.attackCooldown = 0.95;
// Shield blocks all incoming attacks entirely — no damage, no
// knockback, no screen flash — while it's active.
if (!shieldActive) {
damagePlayer(8 + Math.random() * 5);
flashDamage();
// toPlayer already points FROM the zombie TO the player (away from
// it) — the negation here flipped it to point back TOWARD the
// zombie, so every attack was pulling the player INTO the attacker
// instead of knocking them back. That's a direct contributor to
// "zombies go through me": each hit was yanking the player closer,
// and with several zombies attacking at once, could drag the
// player right through/into the crowd.
const push = toPlayer.clone().normalize().multiplyScalar(0.12);
playerBody.position.x += push.x;
playerBody.position.z += push.z;
}
}
} else {
this.idleTimer -= dt;
if (this.idleTimer <= 0) { this.idleDir = Math.random() * Math.PI * 2; this.idleTimer = 2 + Math.random() * 3; }
const move = new THREE.Vector3(Math.sin(this.idleDir), 0, Math.cos(this.idleDir));
avoidObstacles(this.mesh.position, move, others);
this.mesh.position.x += move.x * 0.4 * dt;
this.mesh.position.z += move.z * 0.4 * dt;
this.mesh.position.x = clampZombieX(this.mesh.position.x, this.mesh.position.z);
this.mesh.rotation.y = lerpAngle(this.mesh.rotation.y, this.idleDir, dt * 2);
this.playWalk(dt, 2, 0.35);
}
if (inVehicle) {
const carPos = carVis.group.position;
const d2 = carPos.distanceTo(this.mesh.position);
if (d2 < 2.15) {
const speed = chassisBody.velocity.length();
if (speed > 3.8) {
this.takeDamage(40 + speed * 12, false);
const push = new THREE.Vector3().subVectors(this.mesh.position, carPos).normalize().multiplyScalar(0.8 + speed * 0.12);
this.mesh.position.add(push);
if (!this.alive) pushKillFeed('Run over');
}
}
}
}
playWalk(dt, rate, timeScale) {
if (this.rigged && this.hasAnim) {
this.mixer.timeScale = THREE.MathUtils.lerp(this.mixer.timeScale, timeScale, dt * 3);
this.mixer.update(dt);
} else if (!this.rigged) {
this.animateWalk(dt, rate);
}
if (this.rigged) groundClampRig(this.rigObj, this.footBoneL, this.footBoneR, dt);
}
animateWalk(dt, rate) {
this.wobble += dt * rate * 0.35;
const swing = Math.sin(this.wobble * 4) * 0.5;
this.limbs.legL.rotation.x = swing;
this.limbs.legR.rotation.x = -swing;
this.limbs.armL.rotation.x = -swing * 0.8 + 0.3;
this.limbs.armR.rotation.x = swing * 0.8 + 0.3;
}
remove() {
scene.remove(this.mesh);
const idx = zombies.indexOf(this);
if (idx >= 0) zombies.splice(idx, 1);
}
}
// Widens the zombie roaming bound near the depot yard's z-range so guards
// (and anyone chasing the player out there) aren't snapped back onto the
// narrow main-street corridor. Everywhere else keeps the original bound.
function clampZombieX(x, z) {
if (Math.abs(z - DEPOT_POS.z) < 18) return x; // inside the depot yard's z-band: no street clamp
if (Math.abs(z - WEST_POCKET_Z) < 14) return x; // inside the west supply-pocket's z-band
return THREE.MathUtils.clamp(x, -STREET_HALF_W - 2.5, STREET_HALF_W + 2.5);
}
function lerpAngle(a, b, t) {
let diff = b - a;
while (diff > Math.PI) diff -= Math.PI * 2;
while (diff < -Math.PI) diff += Math.PI * 2;
return a + diff * Math.min(t, 1);
}
const ANKLE_TO_SOLE = 0.09;
const _groundClampTmp = new THREE.Vector3();
function groundClampRig(rigObj, boneL, boneR, dt, rate = 10) {
if (!rigObj || (!boneL && !boneR)) return;
let lowY = Infinity;
if (boneL) { boneL.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
if (boneR) { boneR.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
const soleY = lowY - ANKLE_TO_SOLE;
const idealY = rigObj.position.y - soleY;
rigObj.position.y = THREE.MathUtils.lerp(rigObj.position.y, idealY, Math.min(1, dt * rate));
}
const zombies = [];
let kills = 0;
/* ---------------------------------------------------------------------
EXPLOSIVE BARRELS — shoot one, it detonates, kills zombies in the
blast radius. Explosion VFX uses timeframe_explosion.glb (66k tris,
has a real "Explosion" animation) rather than explosion_as_solid.glb
(870k triangles, no animation) — the latter would be a serious
performance regression if it ever needs to play more than once, which
multiple barrels going off could easily trigger.
--------------------------------------------------------------------- */
const BARREL_SCALE = 0.274; // measured height 3.209 units -> real ~0.88m oil drum —
// this asset didn't come through the same FBX pipeline
// as the other new models (no .fbx-named node in its
// hierarchy), so it needed its own scale calibration
// rather than the ~0.01 factor that fit the others.
const EXPLOSION_SCALE = 0.6;
const EXPLOSION_RADIUS = 6.5;
const explosiveBarrels = [];
const activeExplosions = [];
let barrelTemplate = null;
let explosionTemplate = null;
class Barrel {
constructor(pos) {
this.isBarrel = true;
this.exploded = false;
this.mesh = barrelTemplate.clone(true);
this.mesh.scale.setScalar(BARREL_SCALE);
this.mesh.position.copy(pos);
this.mesh.traverse((o) => {
if (!o.isMesh) return;
o.castShadow = true; o.receiveShadow = true;
o.userData.owner = this;
const mats = Array.isArray(o.material) ? o.material : [o.material];
mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; }); // same close-range fix as zombies
});
scene.add(this.mesh);
this.collisionBody = addStaticBox(0.36, 0.44, 0.36, pos.x, 0.44, pos.z);
explosiveBarrels.push(this);
}
takeDamage() {
if (this.exploded) return;
this.explode();
}
explode() {
this.exploded = true;
const pos = this.mesh.position.clone();
scene.remove(this.mesh);
const idx = explosiveBarrels.indexOf(this);
if (idx >= 0) explosiveBarrels.splice(idx, 1);
if (this.collisionBody) { world.removeBody(this.collisionBody); }
spawnExplosionEffect(pos);
sfx.explosion();
shake = Math.max(shake, 0.4);
// AoE kill: goDown() first (this is what counts the kill toward the
// objective, same as a gunshot knockdown), then confirmedKill()
// immediately after to make it permanent — an explosion shouldn't
// leave a "stabilized" zombie that gets back up later the way a
// regular gunshot does.
zombies.forEach((z) => {
if (!z.alive) return;
if (z.mesh.position.distanceTo(pos) < EXPLOSION_RADIUS) {
z.health = 0;
z.goDown();
z.confirmedKill(false);
}
});
// Chain reaction: any OTHER barrel caught in the blast radius also
// goes off, on a tiny delay so it reads as a chain rather than one
// instant flash. Routed through takeDamage() rather than calling
// explode() directly so the `exploded` guard still applies — without
// it, two barrels within range of each other could each schedule the
// same third barrel's explosion and double-fire it.
explosiveBarrels.slice().forEach((b) => {
if (b !== this && b.mesh.position.distanceTo(pos) < EXPLOSION_RADIUS) {
setTimeout(() => b.takeDamage(), 120);
}
});
}
}
function spawnExplosionEffect(pos) {
const light = new THREE.PointLight(0xff8a33, 7, 16, 2);
light.position.copy(pos).setY(pos.y + 1.2);
scene.add(light);
if (!explosionTemplate) {
// VFX model not loaded yet (or failed) — the kill/damage logic above
// already happened regardless, this just skips the visual. Still
// fade out the light so there's at least a flash.
activeExplosions.push({ mixer: null, obj: null, light, duration: 0.4, elapsed: 0 });
return;
}
const obj = explosionTemplate.scene.clone(true);
obj.scale.setScalar(EXPLOSION_SCALE);
obj.position.copy(pos);
scene.add(obj);
const mixer = new THREE.AnimationMixer(obj);
const clip = explosionTemplate.animations[0];
const action = mixer.clipAction(clip);
action.setLoop(THREE.LoopOnce);
action.clampWhenFinished = true;
action.play();
activeExplosions.push({ mixer, obj, light, duration: clip.duration, elapsed: 0 });
}
function updateExplosions(dt) {
for (let i = activeExplosions.length - 1; i >= 0; i--) {
const e = activeExplosions[i];
if (e.mixer) e.mixer.update(dt);
e.elapsed += dt;
if (e.light) e.light.intensity = Math.max(0, 7 * (1 - e.elapsed / Math.max(e.duration, 0.01)));
if (e.elapsed >= e.duration + 0.3) {
if (e.obj) scene.remove(e.obj);
if (e.light) scene.remove(e.light);
activeExplosions.splice(i, 1);
}
}
}
new GLTFLoader().load('assets/barrel.glb', (gltf) => {
barrelTemplate = gltf.scene;
const BARREL_SPOTS = [
[STREET_HALF_W - 2.2, -18],
[-(STREET_HALF_W - 2.2), -62],
[STREET_HALF_W - 2.4, -132],
[-(STREET_HALF_W - 2.2), -178],
[DEPOT_POS.x - 9, DEPOT_POS.z + 6],
[DEPOT_POS.x + 7, DEPOT_POS.z - 7],
[-(rowX + 15) - 6, WEST_POCKET_Z + 5],
];
BARREL_SPOTS.forEach(([x, z]) => new Barrel(new THREE.Vector3(x, 0, z)));
}, undefined, () => { pushKillFeed('Barrel model failed to load'); });
new GLTFLoader().load('assets/timeframe_explosion.glb', (gltf) => {
explosionTemplate = gltf;
}, undefined, () => { pushKillFeed('Explosion VFX failed to load — barrels still work, just silent-visual'); });
let spawnTimer = 1.2;
let spawnedTotal = 0;
function spawnDepotGuards() {
// A handful of tougher "guards" planted at the depot before the player
// ever gets there, instead of relying on the roaming spawner to wander
// one over eventually. This is what makes stage 2 read as a defended
// objective rather than an empty room with a glowing crate in it.
const spots = [
[DEPOT_POS.x - 4, DEPOT_POS.z + 3], [DEPOT_POS.x + 5, DEPOT_POS.z - 2],
[DEPOT_POS.x - 2, DEPOT_POS.z - 6], [DEPOT_POS.x + 3, DEPOT_POS.z + 6],
];
spots.forEach((p) => {
const z = new Zombie(new THREE.Vector3(p[0], 0, p[1]));
z.health = z.maxHealth = 95 + Math.floor(Math.random() * 25);
z.speed *= 1.15;
z.mesh.scale.setScalar(1.08);
zombies.push(z);
spawnedTotal++;
});
}
function spawnZombie() {
if (zombies.length >= ZOMBIE_MAX_ALIVE || spawnedTotal >= KILL_TARGET + 10) return;
const around = playerVis.group.position;
const ang = Math.random() * Math.PI * 2;
const dist = 16 + Math.random() * 24;
let x = around.x + Math.sin(ang) * dist;
let z = around.z - Math.abs(Math.cos(ang) * dist);
x = THREE.MathUtils.clamp(x, -STREET_HALF_W + 0.8, STREET_HALF_W - 0.8);
z = THREE.MathUtils.clamp(z, -STREET_LENGTH + 16, 28);
if (Math.hypot(x - around.x, z - around.z) < 10) z -= 12;
const zom = new Zombie(new THREE.Vector3(x, 0, z));
zombies.push(zom);
spawnedTotal++;
}
function spawnPickup(pos, type) {
const color = type === 'health' ? 0x44dd66 : 0xe0b030;
const mesh = new THREE.Mesh(
new THREE.OctahedronGeometry(0.18),
new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.35 })
);
mesh.position.set(pos.x, 0.45, pos.z);
scene.add(mesh);
pickups.push({ mesh, type, life: 22 });
}
function spawnBlood(pos) {
const decal = new THREE.Mesh(
new THREE.CircleGeometry(0.35 + Math.random() * 0.25, 10),
new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, depthWrite: false, opacity: 0.85 })
);
decal.rotation.x = -Math.PI / 2;
decal.position.set(pos.x, 0.04, pos.z);
scene.add(decal);
setTimeout(() => scene.remove(decal), 20000);
}
/* ---------------------------------------------------------------------
9. COMBAT
--------------------------------------------------------------------- */
let ammoMag = 30, ammoReserve = 90;
const MAG_SIZE = 30; // was 12 — read as an underpowered pistol, not a combat weapon
let reloading = false, reloadTimer = 0;
let fireCooldown = 0;
const FIRE_RATE = 0.11; // was 0.19 (~5.3rps) — now ~9rps, an actual automatic weapon
const GUN_DAMAGE = 26;
const MELEE_DAMAGE = 42;
const MELEE_RANGE = 2.15;
const KNIFE_DAMAGE = 38;
const KNIFE_RANGE = 1.9;
const raycaster = new THREE.Raycaster();
const sparkGeo = new THREE.SphereGeometry(0.05, 6, 6);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc55 });
const activeSparks = [];
function spawnHitSpark(pos) {
for (let i = 0; i < 6; i++) {
const s = new THREE.Mesh(sparkGeo, sparkMat.clone());
s.position.copy(pos);
s.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3);
s.userData.life = 0.4;
scene.add(s);
activeSparks.push(s);
}
}
function activeGunMesh() {
return firstPerson ? viewmodelGun : playerVis.gunPivot;
}
function spawnMuzzleFlash() {
const flash = new THREE.PointLight(0xffcc66, 8, 7, 2);
const gunWorldPos = new THREE.Vector3();
activeGunMesh().getWorldPosition(gunWorldPos);
flash.position.copy(gunWorldPos);
scene.add(flash);
setTimeout(() => scene.remove(flash), 50);
}
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff4c2, transparent: true, opacity: 0.95 });
const activeTracers = [];
function spawnTracer(from, to) {
const dir = new THREE.Vector3().subVectors(to, from);
const len = dir.length();
if (len < 0.05) return;
const geo = new THREE.CylinderGeometry(0.01, 0.01, len, 5, 1, true);
const mesh = new THREE.Mesh(geo, tracerMat.clone());
mesh.position.copy(from).addScaledVector(dir, 0.5);
mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
mesh.userData.life = 0.07;
mesh.userData.maxLife = 0.07;
scene.add(mesh);
activeTracers.push(mesh);
}
/* -----------------------------------------------------------------
WEAPON SWITCHING — gun vs. knife.
The player always starts with a full magazine (ammoMag = MAG_SIZE
below). Once BOTH the magazine and the reserve are empty, there is
nothing left to reload, so the gun is holstered automatically and
the knife becomes the only option until an ammo pickup/powerup
arrives. Otherwise the player can freely toggle with Q.
----------------------------------------------------------------- */
let currentWeapon = 'gun'; // 'gun' | 'knife'
function hasAnyAmmo() { return ammoMag > 0 || ammoReserve > 0; }
function updateWeaponHUD() {
if (!dom.weaponLabel) return;
dom.weaponLabel.textContent = currentWeapon === 'gun' ? 'PISTOL' : 'KNIFE';
dom.weaponLabel.style.color = currentWeapon === 'gun' ? '#fff4c2' : '#ffd8a8';
}
function setWeaponVisualsVisible() {
const showGun = currentWeapon === 'gun';
if (playerVis.gun) playerVis.gun.visible = showGun;
if (knifeThirdPerson) knifeThirdPerson.visible = !showGun;
if (viewmodelGun.children[0]) viewmodelGun.children[0].visible = showGun;
if (knifeViewModel) knifeViewModel.visible = !showGun;
}
function switchWeapon(weapon) {
if (weapon === 'gun' && !hasAnyAmmo()) {
pushKillFeed('No ammo left — knife only');
weapon = 'knife';
}
if (weapon === currentWeapon) return;
currentWeapon = weapon;
setWeaponVisualsVisible();
updateWeaponHUD();
pushKillFeed(currentWeapon === 'gun' ? 'Switched to pistol' : 'Switched to knife');
}
// Forces the knife if ammo has fully run out (both mag and reserve empty).
// Called after every shot and after reload attempts/failures.
function enforceAmmoWeaponRule() {
if (!hasAnyAmmo() && currentWeapon !== 'knife') {
currentWeapon = 'knife';
setWeaponVisualsVisible();
updateWeaponHUD();
pushKillFeed('Out of ammo — switched to knife');
}
}
function tryShoot() {
if (currentWeapon !== 'gun') { tryKnife(); return; }
if (inVehicle || isDead || reloading || fireCooldown > 0) return;
if (ammoMag <= 0) { startReload(); return; }
fireCooldown = FIRE_RATE;
ammoMag--;
updateAmmoHUD();
spawnMuzzleFlash();
sfx.shoot();
shake = Math.max(shake, 0.08);
triggerShootAnim();
// Was: `pitch += 0.018;` with no clamp — sustained fire without moving the
// mouse (the mousemove handler is the only place pitch got clamped) would
// walk the view unbounded, which then sends the third-person camera math
// (built on sin/cos of pitch) to increasingly broken angles the longer
// you hold the trigger. Recoil is now a separate, capped, decaying value
// instead of a permanent addition to the actual aim pitch.
recoilPitch = Math.min(recoilPitch + 0.02, 0.3);
raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
// Raycast against each alive zombie's actual mesh group (recursive), not
// just the abstract hitbox capsule. The capsule's fixed size/offset could
// easily miss-align with whichever rigged model variant a given zombie
// happened to load, so a visually-on-target shot could silently whiff —
// this is the direct fix for "shooting the zombie does nothing." The
// hitbox mesh is still inside each group as a fallback minimum target.
const targets = [];
zombies.forEach((z) => { if (z.alive) targets.push(z.mesh); });
explosiveBarrels.forEach((b) => { if (!b.exploded) targets.push(b.mesh); });
const hits = raycaster.intersectObjects(targets, true);
const muzzlePos = new THREE.Vector3();
activeGunMesh().getWorldPosition(muzzlePos);
const tracerEnd = hits.length
? hits[0].point
: raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, 70);
spawnTracer(muzzlePos, tracerEnd);
if (hits.length) {
const owner = hits[0].object.userData.owner;
if (owner && owner.isBarrel) {
owner.takeDamage();
showHitmarker();
} else if (owner) {
const headshot = hits[0].point.y > owner.mesh.position.y + 1.42;
owner.takeDamage(headshot ? GUN_DAMAGE * 1.85 : GUN_DAMAGE, headshot);
showHitmarker();
}
}
if (ammoMag <= 0) startReload();
enforceAmmoWeaponRule();
}
function tryMelee() {
if (inVehicle || isDead || meleeTimer > 0) return;
meleeTimer = 0.38;
sfx.melee();
const playerPos = playerVis.group.position;
const forward = forwardFromYaw(yaw);
let hitAny = false;
zombies.forEach((z) => {
if (!z.alive) return;
const toZ = new THREE.Vector3().subVectors(z.mesh.position, playerPos);
const dist = toZ.length();
if (dist < MELEE_RANGE) {
const angle = forward.angleTo(toZ.clone().normalize());
if (angle < Math.PI / 2.1) { z.takeDamage(MELEE_DAMAGE, false); hitAny = true; }
}
});
if (hitAny) showHitmarker();
}
// The dedicated knife attack used as the PRIMARY (left-click) action
// whenever the knife is the equipped weapon (either by choice or because
// ammo ran out). Kept separate from tryMelee (which stays bound to the
// right-click quick-bash regardless of equipped weapon) so the two don't
// fight over meleeTimer in confusing ways, though they share the same
// cooldown field since only one melee action makes sense at a time.
function tryKnife() {
if (inVehicle || isDead || meleeTimer > 0) return;
meleeTimer = 0.32;
sfx.melee();
const playerPos = playerVis.group.position;
const forward = forwardFromYaw(yaw);
let hitAny = false;
zombies.forEach((z) => {
if (!z.alive) return;
const toZ = new THREE.Vector3().subVectors(z.mesh.position, playerPos);
const dist = toZ.length();
if (dist < KNIFE_RANGE) {
const angle = forward.angleTo(toZ.clone().normalize());
if (angle < Math.PI / 2.1) { z.takeDamage(KNIFE_DAMAGE, false); hitAny = true; }
}
});
if (hitAny) showHitmarker();
}
function startReload() {
if (currentWeapon !== 'gun') return;
if (reloading || ammoMag === MAG_SIZE || ammoReserve <= 0 || inVehicle) {
enforceAmmoWeaponRule();
return;
}
reloading = true; reloadTimer = 1.55;
dom.reloadText.classList.remove('hidden');
}
function showHitmarker() {
dom.hitmarker.classList.remove('show'); void dom.hitmarker.offsetWidth;
dom.hitmarker.classList.add('show');
}
/* -----------------------------------------------------------------
KNIFE VISUALS — a small procedural blade, shown in the same hand
slot as the gun (gunPivot in third person, camera-attached
viewmodelGun sibling in first person), toggled by switchWeapon().
----------------------------------------------------------------- */
function buildKnifeMesh() {
const g = new THREE.Group();
const bladeMat = new THREE.MeshStandardMaterial({ color: 0xd8dde0, metalness: 0.85, roughness: 0.22 });
const handleMat = new THREE.MeshStandardMaterial({ color: 0x2a211a, roughness: 0.8 });
const guardMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.7, roughness: 0.35 });
const blade = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.19), bladeMat);
blade.position.z = -0.13;
g.add(blade);
const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.05, 4), bladeMat);
tip.rotation.x = -Math.PI / 2;
tip.position.z = -0.245;
g.add(tip);
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.014), guardMat);
guard.position.z = -0.028;
g.add(guard);
const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.11, 8), handleMat);
handle.rotation.x = Math.PI / 2;
handle.position.z = 0.05;
g.add(handle);
g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
return g;
}
// Third-person knife, parented into the shared gunPivot so it inherits
// the same hand-tracking (syncHandGun) as the gun.
const knifeThirdPerson = buildKnifeMesh();
knifeThirdPerson.visible = false;
playerVis.gunPivot.add(knifeThirdPerson);
// First-person knife, a sibling of the viewmodel gun on the camera.
const knifeViewModel = buildKnifeMesh();
knifeViewModel.scale.setScalar(1.4);
knifeViewModel.position.set(0.22, -0.18, -0.32);
knifeViewModel.visible = false;
camera.add(knifeViewModel);
/* ---------------------------------------------------------------------
10. INPUT
--------------------------------------------------------------------- */
const keys = {};
let pointerLocked = false;
let yaw = 0; // 0 = facing -Z, i.e. into the street (was Math.PI, which faced the player
// straight out of the level — forwardFromYaw(0) = (0,0,-1), forwardFromYaw(PI) = (0,0,1))
let pitch = -0.08;
let recoilPitch = 0; // temporary kick from firing, decays back to 0 — kept separate from
// the player's actual mouse-aim `pitch` so recoil recovers instead
// of permanently accumulating (and can never push the view unclamped)
let firstPerson = false;
function forwardFromYaw(yawAngle) {
return new THREE.Vector3(-Math.sin(yawAngle), 0, -Math.cos(yawAngle));
}
function rightFromYaw(yawAngle) {
return new THREE.Vector3(Math.cos(yawAngle), 0, -Math.sin(yawAngle));
}
let sprintToggle = false;
let lastWTapTime = 0;
window.addEventListener('keydown', (e) => {
keys[e.code] = true;
// Double-tap W toggles sprint on/off directly — completely independent
// of Shift-key detection. Shift+W should already work (verify with the
// debug readout in the corner), but this exists as a guaranteed-to-work
// fallback in case something environment-specific (browser, OS,
// keyboard) is interfering with Shift specifically, which held-modifier
// keys are more prone to than a plain letter key.
if (e.code === 'KeyW' && !e.repeat) {
const now = performance.now();
if (now - lastWTapTime < 300) {
sprintToggle = !sprintToggle;
pushKillFeed(sprintToggle ? 'Sprint toggle ON (double-tap W)' : 'Sprint toggle OFF');
}
lastWTapTime = now;
}
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
dom.canvas.addEventListener('mousemove', (e) => {
if (!pointerLocked) return;
yaw -= e.movementX * 0.002;
pitch -= e.movementY * 0.002;
pitch = THREE.MathUtils.clamp(pitch, -1.05, 0.72);
});
dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
pointerLocked = document.pointerLockElement === dom.canvas;
});
dom.enterBtn.addEventListener('click', () => {
sfx.init();
if (sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
dom.start.classList.add('hidden');
dom.hud.classList.remove('hidden');
dom.canvas.requestPointerLock();
spawnDepotGuards();
updateObjectiveHUD();
updateWeaponHUD();
updateCoinHUD();
updateFuelHUD();
});
dom.canvas.addEventListener('click', () => {
const gameActive = !dom.hud.classList.contains('hidden') && dom.death.classList.contains('hidden') && dom.win.classList.contains('hidden');
if (gameActive && !pointerLocked) {
sfx.init();
dom.canvas.requestPointerLock();
}
});
let firePressed = false;
window.addEventListener('mousedown', (e) => {
if (!pointerLocked) return;
if (e.button === 0) { firePressed = true; tryShoot(); }
if (e.button === 2) tryMelee();
});
window.addEventListener('mouseup', (e) => {
if (e.button === 0) firePressed = false;
});
function cycleOffset(cur) {
const steps = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const i = steps.findIndex((v) => Math.abs(v - cur) < 0.01);
return steps[(i + 1) % steps.length];
}
window.addEventListener('keydown', (e) => {
if (e.code === 'KeyR') startReload();
if (e.code === 'KeyF') toggleVehicle();
if (e.code === 'KeyV' && !inVehicle) firstPerson = !firstPerson;
if (e.code === 'KeyQ') switchWeapon(currentWeapon === 'gun' ? 'knife' : 'gun');
if (e.code === 'KeyI') {
PLAYER_RIG_YAW_OFFSET = cycleOffset(PLAYER_RIG_YAW_OFFSET);
if (playerVis.rigObj) playerVis.rigObj.rotation.y = PLAYER_RIG_YAW_OFFSET;
pushKillFeed('Player facing adjusted');
}
if (e.code === 'KeyO') {
ZOMBIE_RIG_YAW_OFFSET = cycleOffset(ZOMBIE_RIG_YAW_OFFSET);
zombies.forEach((z) => { if (z.rigObj) z.rigObj.rotation.y = ZOMBIE_RIG_YAW_OFFSET; });
pushKillFeed('Zombie facing adjusted');
}
if (e.code === 'KeyP') {
CAR_RIG_YAW_OFFSET = cycleOffset(CAR_RIG_YAW_OFFSET);
carVis.bodyRoot.rotation.y = CAR_RIG_YAW_OFFSET;
pushKillFeed('Car facing adjusted');
}
if (e.code === 'KeyU') {
gunGripIndex = (gunGripIndex + 1) % GUN_GRIP_PRESETS.length;
applyGunOrientation();
pushKillFeed(`Gun grip preset ${gunGripIndex}`);
}
if (e.code === 'BracketLeft' && playerRigObjRef) {
playerScaleOverride *= 0.95;
applyPlayerScale();
}
if (e.code === 'BracketRight' && playerRigObjRef) {
playerScaleOverride *= 1.05;
applyPlayerScale();
}
});
/* ---------------------------------------------------------------------
11. VEHICLE ENTER / EXIT
--------------------------------------------------------------------- */
function toggleVehicle() {
if (isDead) return;
if (!inVehicle) {
const dist = playerVis.group.position.distanceTo(carVis.group.position);
if (dist < 3.4) {
inVehicle = true;
playerVis.group.visible = false;
if (playerVis.gunOnHand) playerVis.gunPivot.visible = false;
playerBody.position.set(-1000, -50, -1000);
playerBody.velocity.set(0, 0, 0);
const eu = new THREE.Euler().setFromQuaternion(carVis.group.quaternion, 'YXZ');
yaw = eu.y + Math.PI;
pitch = -0.12;
dom.speedo.classList.remove('hidden');
}
} else {
inVehicle = false;
carSteer = 0;
vehicle.setSteeringValue(0, 0); vehicle.setSteeringValue(0, 1);
vehicle.applyEngineForce(0, 2); vehicle.applyEngineForce(0, 3);
const right = new THREE.Vector3(1, 0, 0).applyQuaternion(carVis.group.quaternion);
let exitPos = carVis.group.position.clone().addScaledVector(right, 2.3);
exitPos.x = THREE.MathUtils.clamp(exitPos.x, -STREET_HALF_W + 0.6, STREET_HALF_W - 0.6);
playerBody.position.set(exitPos.x, 1.2, exitPos.z);
playerBody.velocity.set(0, 0, 0);
yaw = Math.atan2(right.x, right.z) + Math.PI / 2;
dom.speedo.classList.add('hidden');
sfx.setEngine(0, false);
}
}
/* ---------------------------------------------------------------------
11b. POWERUPS — dropped every 3rd confirmed kill in a streak (reset on
player death). Four kinds: petrol (tops up carFuel), health (heals),
ammo (refills reserve so the player can reload), and shield (15s of
full attack immunity with a glowing shader bubble around the player).
--------------------------------------------------------------------- */
let killStreak = 0;
const POWERUP_TYPES = ['petrol', 'health', 'ammo', 'shield'];
const powerups = []; // { mesh, type, life }
function registerKillstreak(pos) {
killStreak++;
if (killStreak % 3 === 0) {
const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
spawnPowerup(pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)), type);
pushKillFeed(`3-kill streak — ${type.toUpperCase()} powerup dropped`);
}
}
const POWERUP_COLORS = { petrol: 0xff8a1a, health: 0x44dd66, ammo: 0xe0b030, shield: 0x37c8ff };
function spawnPowerup(pos, type) {
const color = POWERUP_COLORS[type];
const group = new THREE.Group();
const core = new THREE.Mesh(
new THREE.IcosahedronGeometry(0.24, 0),
new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1, roughness: 0.25, metalness: 0.3 })
);
group.add(core);
const ring = new THREE.Mesh(
new THREE.TorusGeometry(0.36, 0.02, 8, 24),
new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 })
);
ring.rotation.x = Math.PI / 2;
group.add(ring);
const light = new THREE.PointLight(color, 1.6, 5, 2);
group.add(light);
group.position.set(pos.x, 0.55, pos.z);
scene.add(group);
powerups.push({ mesh: group, type, life: 26 });
}
function applyPowerup(type) {
switch (type) {
case 'petrol':
carFuel = Math.min(CAR_MAX_FUEL, carFuel + 40);
pushKillFeed('+40 fuel');
updateFuelHUD();
break;
case 'health':
playerHealth = Math.min(playerMaxHealth, playerHealth + 40);
dom.healthFill.style.width = (playerHealth / playerMaxHealth) * 100 + '%';
if (dom.bloodVig) dom.bloodVig.style.opacity = String(1 - playerHealth / playerMaxHealth);
pushKillFeed('+40 health');
break;
case 'ammo':
ammoReserve += MAG_SIZE;
pushKillFeed(`+${MAG_SIZE} reserve ammo`);
updateAmmoHUD();
// Ammo arriving no longer forces the knife — but it doesn't
// auto-switch back to the gun either; that's still the player's
// call via Q, same as any other moment they have ammo again.
break;
case 'shield':
activateShield(15);
break;
}
sfx.pickup();
}
function updatePowerups(dt, pos) {
for (let i = powerups.length - 1; i >= 0; i--) {
const p = powerups[i];
p.life -= dt;
p.mesh.rotation.y += dt * 1.6;
p.mesh.position.y = 0.55 + Math.sin(performance.now() * 0.003 + i) * 0.08;
if (p.life <= 0) { scene.remove(p.mesh); powerups.splice(i, 1); continue; }
if (p.mesh.position.distanceTo(pos) < 1.5) {
applyPowerup(p.type);
scene.remove(p.mesh);
powerups.splice(i, 1);
}
}
}
/* --- Coins: separate from powerups — every confirmed kill drops one. --- */
let coins = 0;
const coinPickups = []; // { mesh, life }
function spawnCoin(pos) {
const mesh = new THREE.Mesh(
new THREE.CylinderGeometry(0.16, 0.16, 0.035, 18),
new THREE.MeshStandardMaterial({ color: 0xffd94a, emissive: 0x996600, emissiveIntensity: 0.6, metalness: 0.75, roughness: 0.3 })
);
mesh.rotation.x = Math.PI / 2;
mesh.position.set(pos.x + (Math.random() - 0.5) * 0.4, 0.3, pos.z + (Math.random() - 0.5) * 0.4);
scene.add(mesh);
coinPickups.push({ mesh, life: 24 });
}
function updateCoins(dt, pos) {
for (let i = coinPickups.length - 1; i >= 0; i--) {
const c = coinPickups[i];
c.life -= dt;
c.mesh.rotation.z += dt * 3;
c.mesh.position.y = 0.3 + Math.sin(performance.now() * 0.005 + i) * 0.06;
if (c.life <= 0) { scene.remove(c.mesh); coinPickups.splice(i, 1); continue; }
if (c.mesh.position.distanceTo(pos) < 1.3) {
coins++;
updateCoinHUD();
sfx.pickup();
scene.remove(c.mesh);
coinPickups.splice(i, 1);
}
}
}
/* ---------------------------------------------------------------------
11c. SHIELD — 15s of full attack immunity, with a glowing bubble
shader around the player. Adapted from the bloom/glow look supplied
(the original was a Shadertoy full-screen post-process keyed off
iChannel0/iResolution, which only makes sense as a screen-space pass —
it can't literally wrap around a moving 3D character). This keeps the
same soft, gaussian-glow feel but as a proper mesh ShaderMaterial:
a Fresnel rim brightens the silhouette edge (the "bloom halo" look)
plus a soft pulsing scan line, additive-blended so it always reads as
light rather than a solid surface.
--------------------------------------------------------------------- */
let shieldActive = false;
let shieldTimer = 0;
let shieldDuration = 15;
const shieldUniforms = {
uTime: { value: 0 },
uColor: { value: new THREE.Color(0x37c8ff) },
};
const shieldMaterial = new THREE.ShaderMaterial({
uniforms: shieldUniforms,
transparent: true,
depthWrite: false,
side: THREE.DoubleSide,
blending: THREE.AdditiveBlending,
vertexShader: `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
vNormal = normalize(normalMatrix * normal);
vec4 mv = modelViewMatrix * vec4(position, 1.0);
vViewDir = normalize(-mv.xyz);
gl_Position = projectionMatrix * mv;
}
`,
fragmentShader: `
uniform float uTime;
uniform vec3 uColor;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
// Fresnel term — bright rim at grazing angles, dim facing the
// camera. This is the "glow around the silhouette" analogue of the
// supplied bloom pass, done per-pixel on the shield mesh instead of
// as a screen-space blur.
float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.2);
// Slow vertical scan pulse for a "energy bubble" feel.
float scan = 0.5 + 0.5 * sin(uTime * 2.2 + vNormal.y * 6.0);
float glow = fresnel * (0.65 + 0.35 * scan);
vec3 col = uColor * (0.6 + glow);
// Soft "tone-map" squash, echoing the bloom pass's col*col*(3-2*col)
// smoothstep — keeps the additive glow from blowing out to pure white.
col = col * col * (3.0 - 2.0 * col);
gl_FragColor = vec4(col, glow * 0.9);
}
`,
});
const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(1.05, 32, 24), shieldMaterial);
shieldMesh.visible = false;
playerVis.group.add(shieldMesh);
shieldMesh.position.set(0, 1.0, 0);
function activateShield(seconds) {
shieldActive = true;
shieldTimer = seconds;
shieldDuration = seconds;
shieldMesh.visible = true;
pushKillFeed('Shield active — 15s of full protection');
updateShieldHUD();
}
function updateShield(dt) {
if (!shieldActive) return;
shieldTimer -= dt;
shieldUniforms.uTime.value += dt;
shieldMesh.scale.setScalar(1 + Math.sin(shieldUniforms.uTime.value * 3) * 0.015);
updateShieldHUD();
if (shieldTimer <= 0) {
shieldActive = false;
shieldMesh.visible = false;
pushKillFeed('Shield down');
updateShieldHUD();
}
}
/* ---------------------------------------------------------------------
11d. DYNAMIC HUD ELEMENTS — coins, fuel, weapon and shield readouts
didn't exist in the original page markup, so they're created here at
runtime instead of requiring an HTML edit. Kept visually consistent
with the existing HUD (top-of-screen, simple pill/bar style) via
inline styles.
--------------------------------------------------------------------- */
function makeHudEl(id, styles) {
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
<div style="width:100%;height:10px;border:1px solid rgba(255,255,255,0.5);border-radius:4px;overflow:hidden;background:rgba(0,0,0,0.
35);">
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
function updateCoinHUD() {
dom.coinLabel.innerHTML = `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ffd94a;box-shadow:
0 0 4px #ffb400;"></span>${coins}`;
}
function updateFuelHUD() {
if (dom.fuelFill) dom.fuelFill.style.width = `${Math.max(0, (carFuel / CAR_MAX_FUEL) * 100)}%`;
}
function updateShieldHUD() {
if (!dom.shieldLabel) return;
if (shieldActive) {
dom.shieldLabel.style.display = 'block';
dom.shieldLabel.textContent = `SHIELD ${shieldTimer.toFixed(1)}s`;
} else {
dom.shieldLabel.style.display = 'none';
}
}
/* ---------------------------------------------------------------------
12. HUD
--------------------------------------------------------------------- */
function updateAmmoHUD() {
const low = ammoMag <= 3 ? ' id="low-ammo"' : '';
dom.ammo.innerHTML = `<span${low}>${ammoMag}</span><small> / ${ammoReserve}</small>`;
}
function updateObjectiveHUD() {
dom.killcount.textContent = kills;
if (kills >= KILL_TARGET && stage === 1) stage = 2;
if (stage === 1) {
dom.objective.innerHTML = `Objective: <b>Fight through to the depot</b> — neutralize <span id="obj-count">${Math.min(kills, KILL_TARGET)}/${KILL_TARGET}</span> infected. <i>(Look east for an amber glow above the rooftops — that's the depot, off the main road. A su
pply cache is hidden west too.)</i>`;
} else if (stage === 2) {
dom.objective.innerHTML = `Objective: <b>Recover the culture sample</b> — follow the amber marker east into the depot yard.`;
} else {
dom.objective.innerHTML = `Objective: <b>Get the sample to extraction</b> — head to the green marker.`;
}
}
function checkDepotObjective(pos) {
// No stage gate here on purpose: this is the open-world payoff. A player
// who breaks off toward the depot before finishing the street kill count
// should still be able to grab the sample — gating it behind stage===2
// would mean walking up to a lit, glowing marker and having nothing
// happen, which is worse than letting someone finish the level slightly
// out of the "intended" order.
if (ingredientCollected) return;
if (pos.distanceTo(DEPOT_POS) < 3) collectIngredient();
}
// A literal on-screen arrow + distance readout pointing at the current
// objective. The radar dot and the light beam were both "if you notice
// it" cues; this is impossible to miss because it's dead-center at the
// top of the screen at all times stage 1/2 are active, and it doesn't
// require the player to know where to look — it tells them.
function updateCompass(pos) {
const target = ingredientCollected ? extractPos : DEPOT_POS;
const label = ingredientCollected ? 'EXTRACTION' : 'DEPOT';
dom.compass.classList.remove('hidden');
const dx = target.x - pos.x, dz = target.z - pos.z;
const dist = Math.hypot(dx, dz);
const tx = dx / (dist || 1), tz = dz / (dist || 1);
const fwd = forwardFromYaw(yaw);
const cross = fwd.x * tz - fwd.z * tx;
const dot = fwd.x * tx + fwd.z * tz;
const angle = Math.atan2(cross, dot); // signed angle from facing direction to target
dom.compassArrow.style.transform = `rotate(${(-angle * 180) / Math.PI}deg)`;
dom.compassLabel.textContent = `${label} — ${Math.round(dist)}m`;
}
function pushKillFeed(text) {
const el = document.createElement('div');
el.className = 'kf-item';
el.textContent = text;
dom.killfeed.appendChild(el);
setTimeout(() => el.remove(), 3000);
}
function flashDamage() {
dom.flash.style.background = 'rgba(200,0,0,0.32)';
setTimeout(() => { dom.flash.style.background = 'rgba(200,0,0,0)'; }, 140);
}
function damagePlayer(dmg) {
if (isDead) return;
if (shieldActive) return; // shield blocks all attacks outright
playerHealth = Math.max(0, playerHealth - dmg);
dom.healthFill.style.width = (playerHealth / playerMaxHealth) * 100 + '%';
if (dom.bloodVig) dom.bloodVig.style.opacity = String(1 - playerHealth / playerMaxHealth);
sfx.hurt();
shake = Math.max(shake, 0.22);
if (playerHealth <= 0) doDeath();
}
function doDeath() {
isDead = true;
sfx.setEngine(0, false);
document.exitPointerLock();
killStreak = 0; // a death resets the streak toward the next powerup
dom.deathStats.textContent = `Infected eliminated: ${kills} · Coins: ${coins}`;
dom.death.classList.remove('hidden');
}
function doWin() {
isDead = true;
sfx.setEngine(0, false);
document.exitPointerLock();
dom.winStats.textContent = `Infected eliminated: ${kills} · Coins: ${coins} · Extraction successful.`;
dom.win.classList.remove('hidden');
}
const radarCtx = dom.radar.getContext('2d');
const RADAR_RANGE = 42;
function drawRadar(selfPos, selfYaw) {
const w = dom.radar.width, h = dom.radar.height, cx = w / 2, cy = h / 2;
radarCtx.clearRect(0, 0, w, h);
radarCtx.fillStyle = 'rgba(20,28,18,0.55)';
radarCtx.beginPath(); radarCtx.arc(cx, cy, w / 2, 0, Math.PI * 2); radarCtx.fill();
radarCtx.strokeStyle = 'rgba(80,120,70,0.35)';
radarCtx.beginPath(); radarCtx.arc(cx, cy, w * 0.25, 0, Math.PI * 2); radarCtx.stroke();
radarCtx.save();
radarCtx.translate(cx, cy);
radarCtx.rotate(-selfYaw);
zombies.forEach((z) => {
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
if (stage === 2 && !ingredientCollected) {
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
/* ---------------------------------------------------------------------
13. CAMERA — over-the-shoulder, aim matches crosshair
--------------------------------------------------------------------- */
const camRayHelper = new THREE.Raycaster();
const EYE_HEIGHT = 1.62; // above playerVis.group's origin, which sits at the feet
function updateCameraOnFoot(dt) {
// Recoil recovers over time instead of permanently accumulating; combined
// value is what the camera (and therefore the next shot's raycast, since
// it reads the camera's current orientation) actually uses — always
// clamped, so sustained fire can never push the view into broken angles.
recoilPitch = Math.max(0, recoilPitch - dt * 0.5);
const viewPitch = THREE.MathUtils.clamp(pitch + recoilPitch, -1.05, 0.85);
// Sprint FOV kick — a widened field of view is the classic, unmistakable
// "you are now running" cue used by pretty much every FPS/TPS, and it
// works even if the speed increase itself is hard to judge in the
// moment. Smoothly lerped so it doesn't snap.
const targetFov = isSprinting ? 74 : 62;
if (Math.abs(camera.fov - targetFov) > 0.05) {
camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, Math.min(1, dt * 8));
camera.updateProjectionMatrix();
}
if (firstPerson) {
// Camera IS the head here — no lag, no shoulder offset, no occlusion
// smoothing. Rotation comes straight from yaw/pitch using Euler order
// 'YXZ' (yaw applied outside pitch), which reproduces forwardFromYaw()
// exactly at pitch=0 and avoids gimbal issues looking straight up/down.
const eyePos = playerVis.group.position.clone().add(new THREE.Vector3(0, EYE_HEIGHT - (crouching ? 0.42 : 0), 0));
camera.position.copy(eyePos);
// Subtle head-bob while moving — purely cosmetic (camera-only, doesn't
// touch physics), scaled by actual current speed so it settles to zero
// when you stop rather than looping at a fixed rate.
const horizSpeed = Math.hypot(playerBody.velocity.x, playerBody.velocity.z);
if (horizSpeed > 0.4) bobPhase += dt * horizSpeed * 1.8;
const bobAmt = Math.min(horizSpeed, 6.5) * 0.007;
camera.position.y += Math.sin(bobPhase) * bobAmt;
camera.position.x += Math.cos(bobPhase * 0.5) * bobAmt * 0.6;
if (shake > 0.002) {
camera.position.x += (Math.random() - 0.5) * shake;
camera.position.y += (Math.random() - 0.5) * shake;
}
camera.rotation.order = 'YXZ';
camera.rotation.set(viewPitch, yaw, 0);
if (meleeTimer > 0) viewmodelGun.rotation.x = -Math.sin(meleeTimer * 14) * 0.9;
else viewmodelGun.rotation.x = 0;
if (knifeViewModel) knifeViewModel.rotation.x = viewmodelGun.rotation.x;
return;
}
playerVis.group.rotation.y = lerpAngle(playerVis.group.rotation.y, yaw, dt * 10);
const origin = playerVis.group.position.clone().add(new THREE.Vector3(0, 1.52 - (crouching ? 0.42 : 0), 0));
const fwd = forwardFromYaw(yaw);
const right = rightFromYaw(yaw);
const cp = Math.cos(viewPitch);
const sp = Math.sin(viewPitch);
const dist = 3.55;
const desired = origin.clone()
.addScaledVector(fwd, -dist * cp)
.addScaledVector(right, 0.62)
.add(new THREE.Vector3(0, 0.35 + sp * 1.6, 0));
const lookTarget = origin.clone()
.addScaledVector(fwd, 10 * cp)
.addScaledVector(right, 0.15)
.add(new THREE.Vector3(0, sp * 10, 0));
camRayHelper.set(origin, desired.clone().sub(origin).normalize());
camRayHelper.far = origin.distanceTo(desired);
const hits = camRayHelper.intersectObjects(occluders, false);
let finalPos = desired;
if (hits.length && hits[0].distance > 0.9) {
finalPos = origin.clone().add(desired.clone().sub(origin).normalize().multiplyScalar(Math.max(1.15, hits[0].distance * 0.88)));
}
camera.position.lerp(finalPos, 0.28);
if (shake > 0.002) {
camera.position.x += (Math.random() - 0.5) * shake;
camera.position.y += (Math.random() - 0.5) * shake;
}
camera.lookAt(lookTarget);
camera.rotation.order = 'XYZ'; // lookAt() sets the quaternion directly; restore default order after
if (meleeTimer > 0) {
playerVis.gunPivot.rotation.x = -Math.sin(meleeTimer * 14) * 0.9;
}
}
function updateCameraInCar() {
const carPos = carVis.group.position;
const fwd = forwardFromYaw(yaw);
const right = rightFromYaw(yaw);
const cp = Math.cos(pitch * 0.85);
const sp = Math.sin(pitch * 0.85);
const desired = carPos.clone()
.addScaledVector(fwd, -7.2 * cp)
.addScaledVector(right, 0.2)
.add(new THREE.Vector3(0, 2.4 + sp * 2.2, 0));
camera.position.lerp(desired, 0.12);
if (shake > 0.002) {
camera.position.x += (Math.random() - 0.5) * shake * 0.6;
camera.position.y += (Math.random() - 0.5) * shake * 0.6;
}
camera.lookAt(carPos.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(fwd, 6));
}
/* ---------------------------------------------------------------------
14. MAIN LOOP
--------------------------------------------------------------------- */
const clock = new THREE.Clock();
let stepAccumulator = 0;
const FIXED_STEP = 1 / 60;
function updatePlayerMovement(dt) {
const forwardInput = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
const strafeInput = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
// Crouch: no collider change (that's the risky part with a physics capsule
// mid-game), just a slower, quieter stance — camera drops to match in
// updateCameraOnFoot. Can't sprint while crouched.
crouching = !!(keys['ControlLeft'] || keys['ControlRight'] || keys['KeyC']);
const sprinting = !crouching && (sprintToggle || keys['ShiftLeft'] || keys['ShiftRight']) && forwardInput > 0 && playerStamina > 2;
isSprinting = sprinting;
const speed = sprinting ? 8.4 : (crouching ? 2.1 : 3.7); // sprint bumped from 6.6 — the old
// gap between walk (3.7) and sprint (6.6) was real but subtle enough, combined with no other
// sprint cue (no FOV change, no camera feedback), that it could read as "still just walking."
// FOV kick added below in updateCameraOnFoot makes the state unmistakable regardless of speed.
const fwd = forwardFromYaw(yaw);
const right = rightFromYaw(yaw);
const move = new THREE.Vector3()
.addScaledVector(fwd, forwardInput)
.addScaledVector(right, strafeInput);
if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
// Direct assignment, not eased/lerped toward the previous velocity.
// A lerp here is self-referential (new value depends on the previous
// frame's value), which has a nasty failure mode: if playerBody.velocity
// ever becomes NaN even once — a rough collision, an edge case in
// cannon-es's contact solver, clipping the car/a zombie/a wall at a bad
// angle — lerp(NaN, target, t) is always NaN, forever, with no way to
// recover (verified this directly: it doesn't decay or reset, it just
// stays NaN every frame after). That reads exactly as "movement suddenly
// and permanently stops." Direct assignment has no such failure mode: it
// never reads back its own previous output, so a bad frame can't
// compound — worst case is a single glitchy frame, not a permanent lock.
playerBody.velocity.x = move.x;
playerBody.velocity.z = move.z;
// Defensive net regardless: if anything upstream (physics glitch, a
// future change, etc.) ever does leave the body in a non-finite state,
// self-heal instead of staying stuck forever.
if (!Number.isFinite(playerBody.velocity.x) || !Number.isFinite(playerBody.velocity.y) || !Number.isFinite(playerBody.velocity.z)) {
playerBody.velocity.set(0, 0, 0);
}
if (!Number.isFinite(playerBody.position.x) || !Number.isFinite(playerBody.position.y) || !Number.isFinite(playerBody.position.z)) {
playerBody.position.set(1.5, playerHeight / 2 + 0.25, 30);
playerBody.velocity.set(0, 0, 0);
}
const from = new CANNON.Vec3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
const to = new CANNON.Vec3(playerBody.position.x, playerBody.position.y - playerHeight / 2 - 0.18, playerBody.position.z);
const ray = new CANNON.Ray(from, to);
ray.mode = CANNON.Ray.CLOSEST;
ray.skipBackfaces = true;
const result = new CANNON.RaycastResult();
ray.intersectWorld(world, { result, collisionFilterMask: -1 });
const grounded = result.hasHit || playerBody.position.y < playerHeight / 2 + 0.35;
if (keys['Space'] && grounded && playerBody.velocity.y < 1) {
playerBody.velocity.y = 5.6;
if (playerVis.actions && playerVis.actions.jump) {
setPlayerAction('jump');
playerActionLock = playerVis.jumpDuration || 0.5;
}
}
// Drain slowed / regen sped up: at the old rates (20 drain, 16 regen) a
// sustained sprint cut out after ~5s and took ~6s to refill — held
// continuously (the natural way to test "can I run"), that reads as
// "sprint stopped working" rather than "temporarily depleted."
if (sprinting) playerStamina = Math.max(0, playerStamina - dt * 11);
else playerStamina = Math.min(100, playerStamina + dt * 22);
dom.staminaFill.style.width = playerStamina + '%';
playerVis.group.position.set(playerBody.position.x, playerBody.position.y - playerHeight / 2, playerBody.position.z);
const moving = move.lengthSq() > 0.01;
if (playerVis.rigged && playerVis.mixer && playerVis.actions) {
if (playerActionLock > 0) {
playerActionLock -= dt;
} else {
setPlayerAction(!moving ? 'idle' : (sprinting ? 'sprint' : 'walk'));
}
playerVis.mixer.update(dt);
groundClampRig(playerVis.rigObj, playerVis.footBoneL, playerVis.footBoneR, dt);
syncHandGun();
} else if (moving) {
walkCycle += dt * (sprinting ? 12 : 6);
// Frequency alone (a faster version of the same small arc) reads as
// a fast shuffle, not a run — real running has a visibly wider leg
// swing, more forward-and-back arm counter-swing, and a forward lean
// of the torso. All three now scale with sprint, not just cycle speed.
const amp = sprinting ? 0.78 : 0.5;
const swing = Math.sin(walkCycle) * amp;
playerVis.legL.rotation.x = swing; playerVis.legR.rotation.x = -swing;
playerVis.armL.rotation.x = -swing * (sprinting ? 1.0 : 0.6);
playerVis.armR.rotation.x = swing * (sprinting ? 1.0 : 0.6);
playerVis.proceduralBody.rotation.x = THREE.MathUtils.lerp(
playerVis.proceduralBody.rotation.x, sprinting ? 0.16 : 0, dt * 8
);
} else {
playerVis.legL.rotation.x = THREE.MathUtils.lerp(playerVis.legL.rotation.x, 0, dt * 6);
playerVis.legR.rotation.x = THREE.MathUtils.lerp(playerVis.legR.rotation.x, 0, dt * 6);
playerVis.proceduralBody.rotation.x = THREE.MathUtils.lerp(playerVis.proceduralBody.rotation.x, 0, dt * 6);
}
if (moving && grounded) {
footTimer -= dt;
if (footTimer <= 0) { sfx.foot(); footTimer = sprinting ? 0.28 : (crouching ? 0.6 : 0.42); }
}
if (dom.debugReadout) {
const rawShift = (keys['ShiftLeft'] ? 'L' : '') + (keys['ShiftRight'] ? 'R' : '') || 'none';
dom.debugReadout.textContent =
`Shift held: ${rawShift} | Toggle: ${sprintToggle} | Sprinting: ${sprinting} | Stamina: ${playerStamina.toFixed(0)}\n` +
`Rigged model: ${playerVis.rigged} | Anim state: ${playerVis.currentActionName || 'n/a'}\n` +
`Player height: ${playerCurrentHeight.toFixed(2)}m (zombies are ${ZOMBIE_TARGET_HEIGHT}m — match this) [ / ] to adjust\n` +
`Grip preset: ${gunGripIndex} (U to cycle) | Weapon: ${currentWeapon} | Coins: ${coins} | Fuel: ${carFuel.toFixed(0)}`;
}
zombies.forEach((z) => {
if (!z.alive) return;
const dx = playerVis.group.position.x - z.mesh.position.x;
const dz = playerVis.group.position.z - z.mesh.position.z;
const d = Math.hypot(dx, dz);
const SEP_RADIUS = 0.95;
if (d < SEP_RADIUS) {
// Was: skipped entirely when d <= 0.001 (push direction dx/d, dz/d is
// undefined at d=0) — meaning a zombie that ended up essentially on
// top of the player, which is exactly the "goes through me" case,
// got NO correction at all and could sit there stuck. Falls back to
// a random push direction when d is too small to normalize. Also now
// resolves the FULL overlap in one step instead of half — the old
// half-correction left a multi-frame window where the zombie (and
// its hitbox) still overlapped the player/camera, which is very
// likely why shooting stopped registering right after a pass-through
// (see the hitbox material fix below for the other half of that).
let nx, nz;
if (d > 0.001) { nx = dx / d; nz = dz / d; }
else { const a = Math.random() * Math.PI * 2; nx = Math.cos(a); nz = Math.sin(a); }
const n = SEP_RADIUS - d;
z.mesh.position.x -= nx * n;
z.mesh.position.z -= nz * n;
}
});
if (playerBody.position.y < -20) {
playerBody.position.set(1.5, 3, 30);
playerBody.velocity.set(0, 0, 0);
}
}
function chassisForward() {
// Rotates the chassis's local NOSE direction (-Z, per the wheel setup —
// front wheels sit at z=-1.55) into world space. The previous version
// rotated +Z instead (the tail), which is what led to the engine-force
// sign being negated below to "compensate" — two wrongs that didn't
// quite cancel out, since the brake-logic below also used this value.
// Now: positive forwardSpeed genuinely means "moving toward the nose."
const q = chassisBody.quaternion;
return new CANNON.Vec3(
-2 * (q.x * q.z + q.w * q.y),
-2 * (q.y * q.z - q.w * q.x),
-(1 - 2 * (q.x * q.x + q.y * q.y))
);
}
function updateVehicleControls(dt) {
const throttleInput = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
const steerInput = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);
const speedKph = Math.abs(chassisBody.velocity.length()) * 3.6;
const steerFalloff = THREE.MathUtils.clamp(1 - speedKph / 130, 0.32, 1);
const targetSteer = steerInput * MAX_STEER * steerFalloff;
carSteer = THREE.MathUtils.lerp(carSteer, targetSteer, dt * 6);
vehicle.setSteeringValue(carSteer, FRONT_WHEELS[0]);
vehicle.setSteeringValue(carSteer, FRONT_WHEELS[1]);
// Out of fuel: no engine force at all, regardless of throttle input —
// the truck coasts/brakes to a stop like a real vehicle running dry.
const hasFuel = carFuel > 0;
// cannon-es's RaycastVehicle applies a *positive* engineForce toward the
// wheel's local -Z (the nose, given this rig's directionLocal/axleLocal/
// front-wheel-at-z=-1.55 setup) — re-derived and verified directly
// against the cannon-es source. Positive = forward. (chassisForward()
// above is now fixed to match, so this no longer needs a sign flip.)
const forwardSpeed = chassisBody.velocity.dot(chassisForward());
const targetThrottle = (hasFuel && throttleInput > 0) ? 1 : (hasFuel && throttleInput < 0 ? -0.55 : 0);
carThrottle = THREE.MathUtils.lerp(carThrottle, targetThrottle, dt * 4.5);
const engineForce = carThrottle * MAX_ENGINE_FORCE;
REAR_WHEELS.forEach((i) => vehicle.applyEngineForce(engineForce, i));
FRONT_WHEELS.forEach((i) => vehicle.applyEngineForce(engineForce * 0.28, i));
// Fuel drains only while actually under power (throttle applied and
// moving), not just for sitting in the driver's seat.
if (hasFuel && Math.abs(throttleInput) > 0 && Math.abs(forwardSpeed) > 0.3) {
carFuel = Math.max(0, carFuel - dt * 1.6);
updateFuelHUD();
if (carFuel <= 0) pushKillFeed('Out of fuel — find a petrol powerup');
}
const handbrake = !!keys['Space'];
for (let i = 0; i < 4; i++) {
let b = 0;
if (throttleInput === 0 || !hasFuel) b = MAX_BRAKE_FORCE * 0.4;
if (throttleInput < 0 && forwardSpeed > 2) b = MAX_BRAKE_FORCE;
if (handbrake && REAR_WHEELS.includes(i)) b = HANDBRAKE_FORCE;
vehicle.setBrake(b, i);
}
carVis.group.position.copy(chassisBody.position);
carVis.group.quaternion.copy(chassisBody.quaternion);
carVis.group.position.y -= 0.08;
for (let i = 0; i < 4; i++) {
vehicle.updateWheelTransform(i);
const wt = vehicle.wheelInfos[i].worldTransform;
carVis.wheelMeshes[i].position.copy(wt.position);
carVis.wheelMeshes[i].quaternion.copy(wt.quaternion);
if (carVis.wheelBones && carVis.wheelBones[i]) {
carVis.wheelBones[i].rotation.x += vehicle.wheelInfos[i].deltaRotation || 0;
}
}
const kph = Math.abs(forwardSpeed) * 3.6;
dom.kph.textContent = Math.round(kph);
sfx.setEngine(Math.abs(forwardSpeed), true);
if (speedKph > 40) shake = Math.max(shake, 0.015);
if (chassisBody.position.y < -20) {
chassisBody.position.set(carSpawn.x, carSpawn.y + 1, carSpawn.z);
chassisBody.velocity.set(0, 0, 0);
chassisBody.angularVelocity.set(0, 0, 0);
chassisBody.quaternion.set(0, 0, 0, 1);
}
}
function updatePickups(dt, pos) {
for (let i = pickups.length - 1; i >= 0; i--) {
const p = pickups[i];
p.life -= dt;
p.mesh.rotation.y += dt * 2.2;
p.mesh.position.y = 0.42 + Math.sin(performance.now() * 0.004 + i) * 0.08;
if (p.life <= 0) { scene.remove(p.mesh); pickups.splice(i, 1); continue; }
if (p.mesh.position.distanceTo(pos) < 1.4) {
if (p.type === 'ammo') {
ammoReserve += 18;
pushKillFeed('+18 ammo');
} else {
playerHealth = Math.min(playerMaxHealth, playerHealth + 28);
dom.healthFill.style.width = (playerHealth / playerMaxHealth) * 100 + '%';
if (dom.bloodVig) dom.bloodVig.style.opacity = String(1 - playerHealth / playerMaxHealth);
pushKillFeed('+health');
}
sfx.pickup();
updateAmmoHUD();
scene.remove(p.mesh);
pickups.splice(i, 1);
}
}
}
function updateInteractionPrompt() {
if (isDead) { dom.prompt.classList.add('hidden'); return; }
if (!inVehicle) {
const dist = playerVis.group.position.distanceTo(carVis.group.position);
if (dist < 3.4) {
dom.prompt.classList.remove('hidden');
dom.promptText.textContent = 'Enter Vehicle';
} else {
dom.prompt.classList.add('hidden');
}
} else {
dom.prompt.classList.remove('hidden');
dom.promptText.textContent = 'Exit Vehicle';
}
}
function checkExtraction() {
if (!ingredientCollected) return;
const pos = inVehicle ? carVis.group.position : playerVis.group.position;
if (pos.distanceTo(extractPos) < 3.2) doWin();
}
function animate() {
requestAnimationFrame(animate);
const dt = Math.min(clock.getDelta(), 0.05);
shake = Math.max(0, shake - dt * 1.8);
meleeTimer = Math.max(0, meleeTimer - dt);
sky.position.copy(camera.position);
if (!isDead && dom.hud && !dom.hud.classList.contains('hidden')) {
stepAccumulator += dt;
while (stepAccumulator >= FIXED_STEP) {
world.step(FIXED_STEP);
stepAccumulator -= FIXED_STEP;
}
checkVehicleRollover(dt);
if (fireCooldown > 0) fireCooldown -= dt;
if (firePressed && !inVehicle && currentWeapon === 'gun') tryShoot();
if (reloading) {
reloadTimer -= dt;
if (reloadTimer <= 0) {
const need = MAG_SIZE - ammoMag;
const take = Math.min(need, ammoReserve);
ammoMag += take; ammoReserve -= take;
reloading = false;
dom.reloadText.classList.add('hidden');
updateAmmoHUD();
}
}
if (inVehicle) {
updateVehicleControls(dt);
updateCameraInCar();
playerVis.group.visible = false;
viewmodelGun.visible = false;
if (knifeViewModel) knifeViewModel.visible = false;
if (playerVis.gunOnHand) playerVis.gunPivot.visible = false;
} else {
updatePlayerMovement(dt);
updateCameraOnFoot(dt);
playerVis.group.visible = !firstPerson;
viewmodelGun.visible = firstPerson && currentWeapon === 'gun';
if (knifeViewModel) knifeViewModel.visible = firstPerson && currentWeapon === 'knife';
// gunPivot lives at scene level now when attached to the rig's hand
// bone (see syncHandGun's setup) instead of nested under
// playerVis.group, specifically to avoid inheriting the rig's
// scale — but that also means it's no longer covered by the
// playerVis.group.visible toggle above, so it needs its own here or
// it would stay visible (floating, misplaced) even in first person
// and even inside the vehicle.
if (playerVis.gunOnHand) playerVis.gunPivot.visible = !firstPerson;
sfx.setEngine(0, false);
}
const activePos = inVehicle ? carVis.group.position : playerVis.group.position;
zombies.forEach((z) => z.update(dt, activePos));
updateExplosions(dt);
updateShield(dt);
spawnTimer -= dt;
if (spawnTimer <= 0) { spawnTimer = ZOMBIE_SPAWN_INTERVAL; spawnZombie(); }
for (let i = activeSparks.length - 1; i >= 0; i--) {
const s = activeSparks[i];
s.userData.vel.y -= 9 * dt;
s.position.addScaledVector(s.userData.vel, dt);
s.userData.life -= dt;
s.material.opacity = Math.max(0, s.userData.life / 0.4);
s.material.transparent = true;
if (s.userData.life <= 0) { scene.remove(s); activeSparks.splice(i, 1); }
}
for (let i = activeTracers.length - 1; i >= 0; i--) {
const tr = activeTracers[i];
tr.userData.life -= dt;
tr.material.opacity = Math.max(0, tr.userData.life / tr.userData.maxLife) * 0.95;
if (tr.userData.life <= 0) { scene.remove(tr); tr.geometry.dispose(); tr.material.dispose(); activeTracers.splice(i, 1); }
}
smokeGroups.forEach((group) => {
group.children.forEach((sp) => {
sp.position.y += sp.userData.speed * dt * 0.32;
sp.material.rotation += dt * 0.12;
if (sp.position.y - sp.userData.baseY > 5) sp.position.y = sp.userData.baseY;
});
});
extractRing.rotation.z += dt * 0.4;
updatePickups(dt, activePos);
updatePowerups(dt, activePos);
updateCoins(dt, activePos);
updateInteractionPrompt();
checkDepotObjective(activePos);
updateCompass(activePos);
checkExtraction();
drawRadar(activePos, inVehicle ? new THREE.Euler().setFromQuaternion(carVis.group.quaternion, 'YXZ').y : yaw);
}
renderer.render(scene, camera);
}
updateAmmoHUD();
updateObjectiveHUD();
updateWeaponHUD();
updateCoinHUD();
updateFuelHUD();
animate();