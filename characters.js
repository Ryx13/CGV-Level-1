import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import * as CANNON from 'cannon-es';
import { state } from './state.js';
import {
  scene, world, camera, dom, sfx,
  addStaticBox, addObstacle, pushKillFeed, flashDamage, markLoaded, updateObjectiveHUD,
  STREET_HALF_W, STREET_LENGTH, KILL_TARGET, ZOMBIE_MAX_ALIVE, DEPOT_POS, WEST_POCKET_Z, rowX,
  matPlayer, matChassis,
} from './Scene.js';
import { spawnPickup, spawnCoin, registerKillstreak } from './PowerUps.js';
import { damagePlayer, spawnHitSpark, spawnBlood } from './Actions.js';

/* ======================================================================
   characters.js — LOADING/CREATION OF CHARACTERS AND SCENE OBJECTS

   Despite the name this covers everything game.js used to build: the
   player, zombies, the drivable truck, decorative wrecked cars,
   buildings, obstacles, trash cans, and the textures they all share.
====================================================================== */

/* ---------------------------------------------------------------------
   RNG — deterministic world generation
--------------------------------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const rnd = mulberry32(0xDEAD01);

/* ---------------------------------------------------------------------
   TEXTURE HELPERS — shared by buildings, road, wrecks, etc.
--------------------------------------------------------------------- */
export function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}

export const asphaltTex = new THREE.CanvasTexture(makeCanvas(512, 512, (ctx, w, h) => {
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
  for (let i = 0; i < 6; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = 12 + Math.random() * 30;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(5,6,8,0.5)');
    grad.addColorStop(0.6, 'rgba(5,6,8,0.22)');
    grad.addColorStop(1, 'rgba(5,6,8,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
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

export const sidewalkTex = new THREE.CanvasTexture(makeCanvas(128, 128, (ctx, w, h) => {
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

export const laneTex = new THREE.CanvasTexture(makeCanvas(64, 512, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(220,190,80,0.8)';
  for (let y = 0; y < h; y += 90) ctx.fillRect(w / 2 - 3, y, 6, 42);
}));
laneTex.wrapS = laneTex.wrapT = THREE.RepeatWrapping;
laneTex.repeat.set(1, 18);
laneTex.transparent = true;

export const windowTex = new THREE.CanvasTexture(makeCanvas(128, 256, (ctx, w, h) => {
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

export const concreteTex = new THREE.CanvasTexture(makeCanvas(128, 128, (ctx, w, h) => {
  ctx.fillStyle = '#4d4a44'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 500; i++) {
    const v = 60 + Math.random() * 40;
    ctx.fillStyle = `rgba(${v},${v - 4},${v - 10},${Math.random() * 0.4})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}));
concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;

export const bloodTex = new THREE.CanvasTexture(makeCanvas(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(120,8,8,0.85)');
  g.addColorStop(0.5, 'rgba(70,4,4,0.45)');
  g.addColorStop(1, 'rgba(40,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}));

const smokeTex = new THREE.CanvasTexture(makeCanvas(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(70,68,64,0.55)'); g.addColorStop(1, 'rgba(70,68,64,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}));
export function spawnFireEffect(pos, scale = 1) {
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
  state.smokeGroups.push(group);
}

/* ---------------------------------------------------------------------
   STREET SURFACE (ground/road/sidewalks/curbs/lane markings)

   Lives here rather than in Scene.js because it needs the asphalt/
   sidewalk/lane textures defined above, and Scene.js cannot import this
   file (see the header comment in Scene.js for why that would be a
   circular-import crash). Everything about it — geometry, position,
   materials — is unchanged from the original game.js.
--------------------------------------------------------------------- */
export function loadStreetSurface() {
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
}

/* ---------------------------------------------------------------------
   BUILDINGS
--------------------------------------------------------------------- */
export function makeBuilding(x, z, w, h, d) {
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
  g.traverse((o) => { if (o.isMesh) state.occluders.push(o); });
  addStaticBox(w / 2, h / 2, d / 2, x, h / 2, z);
  return g;
}

export function loadBuildings() {
  for (let z = 30; z > -STREET_LENGTH + 10; z -= (15 + rnd() * 9)) {
    const h = 16 + rnd() * 28;
    const w = 11 + rnd() * 7;
    const d = 11 + rnd() * 7;
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
  const depotYard = buildDepotYard();
  return { depotYard };
}

/* ---------------------------------------------------------------------
   WRECKED CARS, DECOR CARS, BARRIERS, STREETLIGHTS
--------------------------------------------------------------------- */
export function makeWreck(x, z, ry, burning) {
  const g = new THREE.Group();
  const col = burning ? 0x2a2320 : [0x4a3a32, 0x3d4550, 0x5c4030, 0x2f3340, 0x8a1f1f, 0x1f3a52][Math.floor(rnd() * 6)];
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.75, metalness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0e1216, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.55,
  });
  const crushed = rnd() < 0.4;
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
  [1.98, -2.02].forEach((bz) => {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.22, 0.18), darkMat);
    bumper.position.set(0, 0.3, bz);
    g.add(bumper);
  });
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
  g.traverse((o) => { if (o.isMesh) state.occluders.push(o); });
  addStaticBox(1.05, 0.7, 2.15, x, 0.7, z, ry);
  if (burning) {
    const light = new THREE.PointLight(0xff6a1a, 3.4, 11, 2);
    light.position.set(x, 1.15, z);
    scene.add(light);
    spawnFireEffect(new THREE.Vector3(x, 0.9, z));
  }
  return g;
}

export function loadDecorCar(url, x, z, ry, targetLength) {
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
    wrap.traverse((o) => { if (o.isMesh) state.occluders.push(o); });
    const finalSize = box2.getSize(new THREE.Vector3());
    addStaticBox(finalSize.x / 2, finalSize.y / 2, finalSize.z / 2, x, finalSize.y / 2, z, ry);
  }, undefined, () => { /* if it fails to load, the spot is just empty — no crash */ });
}

export function makeBarrier(x, z, ry) {
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
  state.occluders.push(mesh);
  addStaticBox(1.2, 0.42, 0.28, x, 0.42, z, ry);
}

export function makeStreetlight(x, z) {
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

export function loadObstacles() {
  for (let z = 20; z > -STREET_LENGTH + 20; z -= (18 + rnd() * 16)) {
    const side = rnd() < 0.5 ? -1 : 1;
    const x = side * (STREET_HALF_W - 1.7 - rnd() * 2);
    makeWreck(x, z, (rnd() - 0.5) * 1.1 + (side < 0 ? Math.PI / 2 : -Math.PI / 2), rnd() < 0.32);
  }
  loadDecorCar('assets/old_rusty_car_2.glb', -(STREET_HALF_W + 3.5), -30, Math.PI / 2 + 0.15, 4.8);
  loadDecorCar('assets/old_rusty_car_2.glb', STREET_HALF_W + 4, -150, -Math.PI / 2 - 0.1, 4.8);
  loadDecorCar('assets/zombie_variant_b.glb', -(STREET_HALF_W + 3.2), -95, Math.PI / 2 - 0.2, 4.5);
  loadDecorCar('assets/zombie_variant_b.glb', DEPOT_POS.x + 10, DEPOT_POS.z - 4, 0.3, 4.5);
  for (let i = 0; i < 6; i++) {
    const z = -20 - i * 24;
    makeBarrier((i % 2 === 0 ? -2.4 : 2.4), z, Math.PI / 2 + (rnd() - 0.5) * 0.28);
  }
  for (let z = 24; z > -STREET_LENGTH + 20; z -= 42) {
    makeStreetlight(-STREET_HALF_W + 0.55, z);
    makeStreetlight(STREET_HALF_W - 0.55, z);
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
  loadCorpses();
}

/* ---------------------------------------------------------------------
   TRASH CANS
--------------------------------------------------------------------- */
export function makeDumpster(x, z) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 1.15, 0.85),
    new THREE.MeshStandardMaterial({ color: 0x2d4a32, roughness: 0.7, metalness: 0.25 })
  );
  mesh.position.set(x, 0.58, z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  state.occluders.push(mesh);
  addStaticBox(0.7, 0.58, 0.45, x, 0.58, z);
}

export function loadTrashCans() {
  for (let i = 0; i < 8; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    makeDumpster(side * (STREET_HALF_W + 1.6), 8 - i * 22 - rnd() * 6);
  }
}

/* ---------------------------------------------------------------------
   WEST SUPPLY POCKET + DEPOT YARD (side-street compound)
--------------------------------------------------------------------- */
function buildWestPocket() {
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
  state.pickups[state.pickups.length - 1].life = Infinity; // a placed cache, doesn't despawn
}

let crateModelTemplate = null;
function buildDepotYard() {
  const cx = DEPOT_POS.x, cz = DEPOT_POS.z;
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
  const yard = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 30),
    new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 })
  );
  yard.rotation.x = -Math.PI / 2;
  yard.position.set(cx, 0.02, cz);
  yard.receiveShadow = true;
  scene.add(yard);
  makeBuilding(cx - 12, cz - 8, 12, 10, 14);
  makeBuilding(cx + 11, cz + 7, 10, 8, 12);
  addObstacle(cx - 12, cz - 8, 8);
  addObstacle(cx + 11, cz + 7, 7);
  const fencePts = [
    [cx - 16, cz + 12, 0], [cx - 8, cz + 12, 0],
    [cx + 4, cz + 12, 0], [cx + 12, cz + 12, 0],
    [cx - 16, cz - 12, 0], [cx - 8, cz - 12, 0], [cx, cz - 12, 0],
    [cx + 8, cz - 12, 0], [cx + 16, cz - 12, 0],
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
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 2.2, 34, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffaa22, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.set(cx, 17, cz);
  scene.add(beam);
  const beamLight = { intensity: 0 };
  const crateGroup = new THREE.Group();
  crateGroup.position.set(cx, 0, cz);
  const cratePlaceholder = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xffcc55, emissive: 0xaa6600, emissiveIntensity: 0.6, roughness: 0.5 })
  );
  cratePlaceholder.position.y = 0.35;
  crateGroup.add(cratePlaceholder);
  scene.add(crateGroup);
  const CRATE_SCALE = 0.01;
  new GLTFLoader().load('assets/crate_box.glb', (gltf) => {
    crateModelTemplate = gltf.scene;
    const model = crateModelTemplate.clone(true);
    model.scale.setScalar(CRATE_SCALE);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    crateGroup.remove(cratePlaceholder);
    crateGroup.add(model);
    [[cx - 5, cz - 9, 0.4], [cx - 4.4, cz - 9, 0.9], [cx + 8, cz + 8, -0.3]].forEach(([dx, dz, ry]) => {
      const c = crateModelTemplate.clone(true);
      c.scale.setScalar(CRATE_SCALE);
      c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      c.position.set(dx, 0, dz);
      c.rotation.y = ry;
      scene.add(c);
      c.traverse((o) => { if (o.isMesh) state.occluders.push(o); });
      addStaticBox(0.3, 0.3, 0.3, dx, 0.3, dz);
    });
  }, undefined, () => { /* keep the placeholder box if this fails to load */ });
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

/* ---------------------------------------------------------------------
   CORPSES (decorative)
--------------------------------------------------------------------- */
let corpseTemplate = null;
function loadCorpses() {
  new GLTFLoader().load('assets\\zombie_running_on_metel_maniac.glb', (gltf) => {
    const obj = gltf.scene;
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const longest = Math.max(size.x, size.y, size.z) || 1;
    obj.scale.setScalar(1.8 / longest);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    corpseTemplate = obj;
    scatterCorpses();
  }, undefined, () => {});
}
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

/* ---------------------------------------------------------------------
   MAIN CHARACTER (player)
--------------------------------------------------------------------- */
export const playerHeight = 1.9;
export const playerBody = new CANNON.Body({
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
  const torsoTop = 1.0 + 0.29 + 0.23;
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

export function buildRifleMesh() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.65, roughness: 0.38 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.1, roughness: 0.75 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.8, roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.62), dark);
  body.position.z = -0.08;
  g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.26, 8), metal);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.5;
  g.add(barrel);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.06, 0.24), dark);
  handguard.position.z = -0.42;
  g.add(handguard);
  const foreSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.012), metal);
  foreSight.position.set(0, 0.07, -0.62);
  g.add(foreSight);
  const gripMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.19, 0.075), grip);
  gripMesh.position.set(0, -0.13, 0.1);
  gripMesh.rotation.x = -0.28;
  g.add(gripMesh);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.24, 0.06), dark);
  mag.position.set(0, -0.22, -0.02);
  mag.rotation.x = 0.18;
  g.add(mag);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.24), dark);
  stock.position.set(0, -0.01, 0.28);
  g.add(stock);
  const stockPad = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.03), grip);
  stockPad.position.set(0, -0.01, 0.4);
  g.add(stockPad);
  const optic = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.045, 0.11), metal);
  optic.position.set(0, 0.075, -0.1);
  g.add(optic);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 10, Math.PI), metal);
  guard.rotation.x = Math.PI / 2;
  guard.position.set(0, -0.06, 0.06);
  g.add(guard);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

export const playerVis = buildPlayerMesh();
scene.add(playerVis.group);

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
export function applyGunOrientation() {
  const preset = GUN_GRIP_PRESETS[state.gunGripIndex];
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
  newViewGun.scale.multiplyScalar(0.7);
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

export const viewmodelGun = new THREE.Group();
const viewmodelGunMesh = buildRifleMesh();
viewmodelGunMesh.scale.setScalar(0.5);
viewmodelGun.add(viewmodelGunMesh);
viewmodelGun.position.set(0.22, -0.2, -0.42);
viewmodelGun.visible = false;
camera.add(viewmodelGun);

const PLAYER_TARGET_HEIGHT = 1.9;
const PLAYER_FOOT_ADJUST = 1.0;
let playerRigObjRef = null;
export const ZOMBIE_TARGET_HEIGHT = 1.8;

export function applyPlayerScale() {
  if (!playerRigObjRef) return;
  const finalScale = state.playerBaseScale * state.playerScaleOverride;
  // Zero the offset BEFORE measuring, every time. Previously the box was
  // measured at whatever position.y this function last left the rig at,
  // so each [ / ] press re-derived its offset from an already-offset box
  // and stacked a new adjustment on top of the old one — a few presses
  // and the model drifts up into the air ("walking mid-air"). Resetting
  // first makes every call measure from the same neutral baseline, so
  // repeated presses adjust scale only, not accumulate vertical drift.
  playerRigObjRef.position.y = 0;
  playerRigObjRef.scale.setScalar(finalScale);
  const box = new THREE.Box3().setFromObject(playerRigObjRef);
  playerRigObjRef.position.y = -box.min.y + PLAYER_FOOT_ADJUST;
  const height = box.max.y - box.min.y;
  state.playerCurrentHeight = height;
  pushKillFeed(`Player scale ×${finalScale.toFixed(3)} — height ${height.toFixed(2)}m (zombies are ~${ZOMBIE_TARGET_HEIGHT}m)`);
}
export function adjustPlayerScale(factor) {
  if (!playerRigObjRef) return;
  state.playerScaleOverride *= factor;
  applyPlayerScale();
}

export const GUN_GRIP_PRESETS = [
  { pos: [0.04, -0.02, 0.09], rot: [-Math.PI / 2, 0, 0] },
  { pos: [0.04, -0.02, 0.09], rot: [-Math.PI / 2, 0, Math.PI / 2] },
  { pos: [0.02, 0.03, 0.06], rot: [0, Math.PI / 2, 0] },
  { pos: [0.02, 0.03, 0.06], rot: [Math.PI / 2, 0, Math.PI / 2] },
  { pos: [0, -0.05, 0.1], rot: [0, 0, 0] },
  { pos: [0.02, -0.02, 0.08], rot: [0, 0, Math.PI / 2] },
  { pos: [0.02, -0.02, 0.08], rot: [0, Math.PI, Math.PI / 2] },
  { pos: [0.02, -0.02, 0.08], rot: [Math.PI / 2, Math.PI / 2, 0] },
  { pos: [0.02, -0.02, 0.08], rot: [-Math.PI / 2, Math.PI / 2, 0] },
  { pos: [0.02, -0.02, 0.08], rot: [0, -Math.PI / 2, 0] },
];
export function cycleGunGrip() {
  state.gunGripIndex = (state.gunGripIndex + 1) % GUN_GRIP_PRESETS.length;
  applyGunOrientation();
  pushKillFeed(`Gun grip preset ${state.gunGripIndex}`);
}

function findBoneLike(root, substr) {
  let found = null;
  root.traverse((o) => {
    if (!found && o.name && o.name.includes(substr)) found = o;
  });
  return found;
}

export function setPlayerAction(name) {
  if (!playerVis.actions || playerVis.currentActionName === name) return;
  const to = playerVis.actions[name];
  if (!to) return;
  Object.values(playerVis.actions).forEach((a) => { a.paused = false; a.stop(); });
  to.reset().play();
  playerVis.currentActionName = name;
}
export function triggerOneShot(action) {
  if (!action) return;
  action.reset().setEffectiveWeight(1).play();
}
export function triggerShootAnim() {
  if (!playerVis.shootAction) return;
  playerVis.shootAction.reset();
  playerVis.shootAction.play();
}

export function loadMainCharacter() {
  new GLTFLoader().load('assets/zombie_walker.glb', (gltf) => {
    const obj = gltf.scene;
    const box0 = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box0.getSize(size);
    state.playerBaseScale = THREE.MathUtils.clamp(PLAYER_TARGET_HEIGHT / Math.max(size.y, 0.2), 0.05, 2.8);
    obj.rotation.y = state.PLAYER_RIG_YAW_OFFSET;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    playerVis.proceduralBody.visible = false;
    playerVis.group.add(obj);
    playerVis.rigged = true;
    playerVis.rigObj = obj;
    playerRigObjRef = obj;
    applyPlayerScale();
    playerVis.footBoneL = obj.getObjectByName('foot_l') || findBoneLike(obj, 'foot_l') || findBoneLike(obj, 'LeftFoot') || null;
    playerVis.footBoneR = obj.getObjectByName('foot_r') || findBoneLike(obj, 'foot_r') || findBoneLike(obj, 'RightFoot') || null;
    if (!playerVis.footBoneL && !playerVis.footBoneR) {
      // Without a foot bone, groundClampRig() silently no-ops every frame
      // and the player's height is whatever applyPlayerScale set once at
      // load — nothing corrects it afterward. Flagged loudly rather than
      // failing silently, since this is the #1 cause of "floating" reports.
      pushKillFeed('WARNING: no player foot bone found — ground clamp disabled, model may float');
    } else {
      playerVis.ankleToSole = measureAnkleToSole(obj, playerVis.footBoneL, playerVis.footBoneR);
    }
    const handBone = obj.getObjectByName('hand_r');
    if (handBone) {
      playerVis.handBone = handBone;
      playerVis.gunOnHand = true;
      playerVis.group.remove(playerVis.gunPivot);
      scene.add(playerVis.gunPivot);
    }
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
      if (idleClip) playerVis.actions.idle = playerVis.mixer.clipAction(idleClip);
      if (jumpClip) {
        playerVis.actions.jump = playerVis.mixer.clipAction(jumpClip);
        playerVis.actions.jump.setLoop(THREE.LoopOnce);
        playerVis.actions.jump.clampWhenFinished = true;
        playerVis.jumpDuration = jumpClip.duration;
      }
      if (shootClip) {
        const additiveShoot = THREE.AnimationUtils.makeClipAdditive(shootClip);
        playerVis.shootAction = playerVis.mixer.clipAction(additiveShoot);
        playerVis.shootAction.blendMode = THREE.AdditiveAnimationBlendMode;
        playerVis.shootAction.setLoop(THREE.LoopOnce);
        playerVis.shootAction.clampWhenFinished = true;
        playerVis.shootAction.enabled = true;
        playerVis.shootAction.setEffectiveWeight(1);
      }
      if (playerVis.actions.idle) {
        playerVis.actions.idle.play();
        playerVis.currentActionName = 'idle';
      }
    } else {
      // No baked-in animations on this model at all — still stand up a
      // mixer + actions table so loadShooterPack() below has somewhere
      // to attach the Shooter_Pack clips once they finish loading.
      playerVis.mixer = new THREE.AnimationMixer(obj);
      playerVis.actions = {};
    }
    state.loadFlags.player = true;
    markLoaded('player');
    // Shooter_Pack — a set of per-animation FBX exports made for this
    // same rifle-carrying rig (walk/run/strafe/jump/fire in each
    // direction). Loaded last so it can layer on top of / replace
    // whatever the base model already provided above.
    loadShooterPack();
  }, undefined, (err) => {
    console.error('Player model failed to load:', err);
    pushKillFeed('Player model failed to load — using fallback body');
    markLoaded('player');
  });
}

/* -----------------------------------------------------------------
   SHOOTER PACK — per-animation FBX exports for the rifle-carrying
   player rig (walking.fbx, "rifle run.fbx", strafe.fbx x2, "firing
   rifle.fbx", "rifle aiming idle.fbx", backward variants, jump
   forward/backward, and a death clip). Expected on disk at
   assets/<original filename>.fbx — unzip Shooter_Pack.zip
   there, keeping the original filenames (spaces included) so the paths
   below match exactly.

   THREE's AnimationMixer binds a clip's tracks to the target skeleton
   purely by bone name, so a clip loaded from a completely different FBX
   file will drive the player's actual rig correctly as long as both
   were exported from the same underlying skeleton, which is the case
   here. If a file is missing or the rig doesn't line up for some
   reason, that one animation is simply skipped (falls back to whatever
   was baked into the base model, or to 'idle') — nothing else breaks.
--------------------------------------------------------------------- */
const SHOOTER_ANIM_FILES = {
  idle: 'assets/rifle aiming idle.glb',
  walk: 'assets/walking.glb',
  sprint: 'assets/rifle run.glb',
  walkBack: 'assets/walking backwards.glb',
  runBack: 'assets/run backwards.glb',
  strafeL: 'assets/strafe.glb',
  strafeR: 'assets/strafe (2).glb',
  jump: 'assets/jump forward.glb',
  jumpBack: 'assets/jump backward.glb',
  startWalk: 'assets/start walking.glb',
  stopWalk: 'assets/stop walking.glb',
  startWalkBack: 'assets/start walking backwards.glb',
  stopWalkBack: 'assets/walk backwards stop.glb',
  shoot: 'assets/firing rifle.glb',
  die: 'assets/walking to dying.glb',
};
const ONE_SHOT_KEYS = new Set(['jump', 'jumpBack', 'startWalk', 'stopWalk', 'startWalkBack', 'stopWalkBack', 'die']);

export function loadShooterPack() {
  if (!playerVis.mixer || !playerVis.rigObj) return; // nothing to attach clips to yet
  if (!playerVis.actions) playerVis.actions = {};
  Object.entries(SHOOTER_ANIM_FILES).forEach(([key, path]) => {
    new GLTFLoader().load(path, (gltf) => {
      const clip = gltf.animations && gltf.animations[0];
      if (!clip) return;
      if (key === 'shoot') {
        const additive = THREE.AnimationUtils.makeClipAdditive(clip);
        const shootAction = playerVis.mixer.clipAction(additive, playerVis.rigObj);
        shootAction.blendMode = THREE.AdditiveAnimationBlendMode;
        shootAction.setLoop(THREE.LoopOnce);
        shootAction.clampWhenFinished = true;
        shootAction.enabled = true;
        shootAction.setEffectiveWeight(1);
        playerVis.shootAction = shootAction; // takes over from the baked-in Pistol_Shoot, if any
        return;
      }
      const action = playerVis.mixer.clipAction(clip, playerVis.rigObj);
      if (ONE_SHOT_KEYS.has(key)) {
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
      }
      if (key === 'jump') playerVis.jumpDuration = clip.duration;
      if (key === 'jumpBack') playerVis.jumpBackDuration = clip.duration;
      if (key === 'die') playerVis.dieDuration = clip.duration;
      playerVis.actions[key] = action;
      if (key === 'idle' && !playerVis.currentActionName) {
        action.play();
        playerVis.currentActionName = 'idle';
      }
    }, undefined, () => {
      pushKillFeed(`Shooter pack: "${key}" clip failed to load`);
    });
  });
}

const _gunSyncPos = new THREE.Vector3();
const _gunSyncQuat = new THREE.Quaternion();
const _gunGripQuat = new THREE.Quaternion();
const _gunGripEuler = new THREE.Euler();
export function syncHandGun() {
  if (!playerVis.gunOnHand || !playerVis.handBone || state.inVehicle) return;
  playerVis.handBone.getWorldPosition(_gunSyncPos);
  playerVis.handBone.getWorldQuaternion(_gunSyncQuat);
  const preset = GUN_GRIP_PRESETS[state.gunGripIndex];
  playerVis.gunPivot.position.copy(_gunSyncPos);
  playerVis.gunPivot.quaternion.copy(_gunSyncQuat);
  _gunGripEuler.set(...preset.rot);
  _gunGripQuat.setFromEuler(_gunGripEuler);
  playerVis.gunPivot.quaternion.multiply(_gunGripQuat);
  playerVis.gunPivot.translateX(preset.pos[0]);
  playerVis.gunPivot.translateY(preset.pos[1]);
  playerVis.gunPivot.translateZ(preset.pos[2]);
}

export function cyclePlayerRigYaw() {
  state.PLAYER_RIG_YAW_OFFSET = cycleOffset(state.PLAYER_RIG_YAW_OFFSET);
  if (playerVis.rigObj) playerVis.rigObj.rotation.y = state.PLAYER_RIG_YAW_OFFSET;
  pushKillFeed('Player facing adjusted');
}
export function cycleZombieRigYaw() {
  state.ZOMBIE_RIG_YAW_OFFSET = cycleOffset(state.ZOMBIE_RIG_YAW_OFFSET);
  state.zombies.forEach((z) => { if (z.rigObj) z.rigObj.rotation.y = state.ZOMBIE_RIG_YAW_OFFSET; });
  pushKillFeed('Zombie facing adjusted');
}
export function cycleCarRigYaw() {
  state.CAR_RIG_YAW_OFFSET = cycleOffset(state.CAR_RIG_YAW_OFFSET);
  carVis.bodyRoot.rotation.y = state.CAR_RIG_YAW_OFFSET;
  pushKillFeed('Car facing adjusted');
}
function cycleOffset(cur) {
  const steps = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const i = steps.findIndex((v) => Math.abs(v - cur) < 0.01);
  return steps[(i + 1) % steps.length];
}

/* ---------------------------------------------------------------------
   KNIFE VISUALS
--------------------------------------------------------------------- */
export function buildKnifeMesh() {
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
export const knifeThirdPerson = buildKnifeMesh();
knifeThirdPerson.visible = false;
playerVis.gunPivot.add(knifeThirdPerson);
export const knifeViewModel = buildKnifeMesh();
knifeViewModel.scale.setScalar(1.4);
knifeViewModel.position.set(0.22, -0.18, -0.32);
knifeViewModel.visible = false;
camera.add(knifeViewModel);

/* ---------------------------------------------------------------------
   VEHICLE (drivable truck)
--------------------------------------------------------------------- */
export const carSpawn = new THREE.Vector3(-1.8, 0.85, 22);
export const CAR_MAX_FUEL = 100;
state.carFuel = CAR_MAX_FUEL;

function buildCarMesh() {
  const g = new THREE.Group();
  const bodyRoot = new THREE.Group();
  g.add(bodyRoot);
  const paint = new THREE.MeshStandardMaterial({ color: 0xb3151f, metalness: 0.62, roughness: 0.22 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x141a1e, metalness: 0.2, roughness: 0.08, transparent: true, opacity: 0.72 });
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

export const carVis = buildCarMesh();
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
  carVis.bodyRoot.rotation.y = state.CAR_RIG_YAW_OFFSET;
  carVis.loadedCar = obj;
  state.loadFlags.car = true;
  markLoaded('car');
}, undefined, () => { state.loadFlags.car = true; markLoaded('car'); });

const chassisShape = new CANNON.Box(new CANNON.Vec3(1.05, 0.5, 2.6));
export const chassisBody = new CANNON.Body({ mass: 1650, material: matChassis, linearDamping: 0.12, angularDamping: 0.35 });
chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.5, 0));
chassisBody.position.set(carSpawn.x, 1.05, carSpawn.z);
chassisBody.angularVelocity.set(0, 0, 0);
export const vehicle = new CANNON.RaycastVehicle({
  chassisBody,
  indexForwardAxis: 2,
  indexRightAxis: 0,
  indexUpAxis: 1,
});
const wheelOptions = {
  radius: 0.46,
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
export const FRONT_WHEELS = [0, 1];
export const REAR_WHEELS = [2, 3];
export const MAX_STEER = 0.5;
export const MAX_ENGINE_FORCE = 5600;
export const MAX_BRAKE_FORCE = 65;
export const HANDBRAKE_FORCE = 95;

export function loadCars() {
  // Drivable vehicle is already constructed above (module init); this
  // function loads the purely decorative parked/wrecked cars using real
  // GLB models, same as loadObstacles' decor cars call — kept here too
  // as the "loadCars" entry point per the requested file structure.
}

export function checkVehicleRollover(dt) {
  if (!Number.isFinite(chassisBody.velocity.x) || !Number.isFinite(chassisBody.velocity.y) || !Number.isFinite(chassisBody.velocity.z)
    || !Number.isFinite(chassisBody.position.x) || !Number.isFinite(chassisBody.position.y) || !Number.isFinite(chassisBody.position.z)) {
    chassisBody.position.set(carSpawn.x, carSpawn.y + 1, carSpawn.z);
    chassisBody.quaternion.set(0, 0, 0, 1);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    state.carSteer = 0;
    state.carThrottle = 0;
    state.rolloverTimer = 0;
    return;
  }
  const worldUp = new CANNON.Vec3();
  chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0), worldUp);
  const speed = chassisBody.velocity.length();
  const isUpsideDown = worldUp.y < -0.15;
  state.rolloverTimer = (isUpsideDown && speed < 1.5) ? state.rolloverTimer + dt : 0;
  if (state.rolloverTimer > 1.5) {
    const q = new THREE.Quaternion(chassisBody.quaternion.x, chassisBody.quaternion.y, chassisBody.quaternion.z, chassisBody.quaternion.w);
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const uprightQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
    chassisBody.quaternion.set(uprightQ.x, uprightQ.y, uprightQ.z, uprightQ.w);
    chassisBody.position.y += 1.15;
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    state.rolloverTimer = 0;
    pushKillFeed('Vehicle righted itself');
  }
}

/* ---------------------------------------------------------------------
   ZOMBIES
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
  function limb(mat, len, r) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat); m.castShadow = true; return m; }
  const legL = limb(zombieMat2, 0.65, 0.1); legL.position.set(-0.12, 0.33, 0);
  const legR = limb(zombieMat2, 0.65, 0.1); legR.position.set(0.12, 0.33, 0);
  const armL = limb(zombieMat1, 0.5, 0.08); armL.position.set(-0.38, 0.95, 0);
  const armR = limb(zombieMat1, 0.5, 0.08); armR.position.set(0.38, 0.95, 0);
  g.add(legL, legR, armL, armR);
  g.traverse((o) => { if (o.isMesh) o.userData.isZombiePart = true; });
  return { group: g, legL, legR, armL, armR, head };
}

export function avoidObstacles(pos, move, extra = []) {
  const push = new THREE.Vector3();
  const list = state.obstacles.concat(extra);
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

export function clampZombieX(x, z) {
  if (Math.abs(z - DEPOT_POS.z) < 18) return x;
  if (Math.abs(z - WEST_POCKET_Z) < 14) return x;
  return THREE.MathUtils.clamp(x, -STREET_HALF_W - 2.5, STREET_HALF_W + 2.5);
}
export function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * Math.min(t, 1);
}
// Fallback only — used when a rig has no per-model measurement (see
// measureAnkleToSole below). This was previously the ONLY value, applied
// to every rig regardless of its actual proportions: fine for whichever
// model it was originally tuned against, wrong for any other model whose
// ankle-bone-to-sole distance differs (e.g. model-rigged.glb's feet sink
// into the ground because its real ankle bone sits higher/lower above its
// sole than 0.09 units).
const ANKLE_TO_SOLE = 0.09;
const _groundClampTmp = new THREE.Vector3();
export function groundClampRig(rigObj, boneL, boneR, dt, rate = 10, ankleToSole = ANKLE_TO_SOLE) {
  if (!rigObj || (!boneL && !boneR)) return;
  let lowY = Infinity;
  if (boneL) { boneL.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
  if (boneR) { boneR.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
  const soleY = lowY - ankleToSole;
  const idealY = rigObj.position.y - soleY;
  rigObj.position.y = THREE.MathUtils.lerp(rigObj.position.y, idealY, Math.min(1, dt * rate));
}

// Measures the TRUE ankle-bone-to-sole distance for a specific rig
// instance, in its own bind pose, instead of assuming every model shares
// the same proportions. Call once, right after the rig is built and
// before any animation has advanced its pose.
function measureAnkleToSole(rigObj, boneL, boneR) {
  if (!boneL && !boneR) return ANKLE_TO_SOLE;
  rigObj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(rigObj);
  let lowY = Infinity;
  if (boneL) { boneL.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
  if (boneR) { boneR.getWorldPosition(_groundClampTmp); lowY = Math.min(lowY, _groundClampTmp.y); }
  if (!isFinite(lowY) || !isFinite(box.min.y)) return ANKLE_TO_SOLE;
  return lowY - box.min.y;
}

/* ---------------------------------------------------------------------
   DEATH SPARKLES — replaces the old lingering corpse. A confirmed kill
   (gunshot, melee, knife, or explosion) blows the zombie apart into a
   burst of glowing sparkle particles instead of leaving a body behind;
   the coin spawned right after is the only thing left on the ground.
   Reuses state.activeSparks (already updated/faded/removed every frame
   by Actions.js's animation loop, same as the smaller gunshot hit-spark
   burst) rather than adding a second particle system.
--------------------------------------------------------------------- */
const deathSparkGeo = new THREE.IcosahedronGeometry(0.07, 0);
const DEATH_SPARK_COLORS = [0xfff4c2, 0xffe37a, 0x9ff7ff, 0xffffff];
export function spawnDeathSparkles(pos) {
  const center = pos.clone().add(new THREE.Vector3(0, 0.9, 0));
  const flash = new THREE.PointLight(0xbfe9ff, 6, 6, 2);
  flash.position.copy(center);
  scene.add(flash);
  setTimeout(() => scene.remove(flash), 120);
  for (let i = 0; i < 22; i++) {
    const color = DEATH_SPARK_COLORS[Math.floor(Math.random() * DEATH_SPARK_COLORS.length)];
    const s = new THREE.Mesh(deathSparkGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    s.position.copy(center);
    s.scale.setScalar(0.6 + Math.random() * 0.9);
    const angle = Math.random() * Math.PI * 2;
    const outSpeed = 1.4 + Math.random() * 2.6;
    const upSpeed = 2.2 + Math.random() * 2.8;
    s.userData.vel = new THREE.Vector3(Math.cos(angle) * outSpeed, upSpeed, Math.sin(angle) * outSpeed);
    s.userData.life = 0.55 + Math.random() * 0.35;
    s.userData.maxLife = s.userData.life;
    scene.add(s);
    state.activeSparks.push(s);
  }
}

const zombieTemplates = [];
let zombieTemplateResolved = false;
function loadZombieTemplate(path, opts = {}) {
  new GLTFLoader().load(path, (gltf) => {
    const obj = gltf.scene;
    let box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const scale = THREE.MathUtils.clamp(ZOMBIE_TARGET_HEIGHT / Math.max(size.y, 0.2), 0.15, 2.8);
    obj.scale.setScalar(scale);
    box = new THREE.Box3().setFromObject(obj);
    const footOffset = -box.min.y + 0.05;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    zombieTemplates.push({ scene: obj, animations: gltf.animations || [], footOffset, runs: !!opts.runs });
    state.loadFlags.zombie = true;
    markLoaded('zombie');
    if (!zombieTemplateResolved) {
      zombieTemplateResolved = true;
      for (let i = 0; i < 6; i++) spawnZombie();
    }
  }, undefined, () => {
    state.loadFlags.zombie = true;
    markLoaded('zombie');
    if (!zombieTemplateResolved) {
      zombieTemplateResolved = true;
      for (let i = 0; i < 6; i++) spawnZombie();
    }
  });
}

export function loadZombies() {
  loadZombieTemplate('assets/zombie_running_on_metel_maniac.glb');
  // model-rigged.glb is the fast "runner" variant — `runs: true` makes the
  // Zombie constructor below prefer a run-named clip (at full animation
  // speed, not the shambling 0.4x timeScale) and move noticeably faster.
  loadZombieTemplate('assets/model-rigged.glb', { runs: true });
}

export class Zombie {
  constructor(pos) {
    this.mesh = new THREE.Group();
    const template = zombieTemplates.length ? zombieTemplates[Math.floor(Math.random() * zombieTemplates.length)] : null;
    this.rigged = !!template;
    this.hasAnim = false;
    if (this.rigged) {
      const rigInstance = skeletonClone(template.scene);
      rigInstance.position.y = template.footOffset;
      rigInstance.rotation.y = state.ZOMBIE_RIG_YAW_OFFSET;
      this.mesh.add(rigInstance);
      this.rigObj = rigInstance;
      this.footBoneL = findBoneLike(rigInstance, 'LeftFoot') || null;
      this.footBoneR = findBoneLike(rigInstance, 'RightFoot') || null;
      // Measured per-instance rather than assuming the shared ANKLE_TO_SOLE
      // constant fits this rig — model-rigged.glb's proportions differ from
      // the other zombie template, which is why its feet were sinking.
      this.ankleToSole = measureAnkleToSole(rigInstance, this.footBoneL, this.footBoneR);
      if (template.animations.length) {
        this.hasAnim = true;
        this.mixer = new THREE.AnimationMixer(rigInstance);
        // Runner variant (model-rigged.glb, opts.runs=true): prefer a
        // clip whose name actually says "run"; play it at full speed
        // instead of the shambling 0.4x timeScale everything else uses.
        let clip = template.animations[0];
        if (template.runs) {
          const runClip = template.animations.find((c) => /run/i.test(c.name));
          if (runClip) clip = runClip;
        }
        this.action = this.mixer.clipAction(clip);
        this.action.play();
        this.mixer.timeScale = template.runs ? 1.15 : 0.4;
      }
    } else {
      const built = buildZombieMesh();
      this.mesh.add(built.group);
      this.limbs = built;
    }
    const hitbox = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.0, 4, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
    );
    hitbox.position.y = 1.0;
    hitbox.userData.owner = this;
    this.hitbox = hitbox;
    this.mesh.add(hitbox);
    this.mesh.position.copy(pos);
    this.mesh.userData.owner = this;
    this.mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.owner = this;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
    });
    scene.add(this.mesh);
    this.health = 50 + Math.floor(Math.random() * 20);
    this.maxHealth = this.health;
    this.state = 'idle';
    this.countedKill = false;
    // Runners (model-rigged.glb) move noticeably faster than the
    // standard shamblers — that's the whole point of a "runner" variant.
    this.speed = (template && template.runs)
      ? 4.4 + Math.random() * 1.8
      : 2.6 + Math.random() * 1.6;
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
    this.health = 0;
    spawnHitSpark(this.mesh.position.clone().add(new THREE.Vector3(0, headshot ? 1.55 : 1.15, 0)));
    spawnBlood(this.mesh.position);
    sfx.hit();
    state.shake = Math.max(state.shake, headshot ? 0.18 : 0.1);
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
    this.idleTimer = 0;
    sfx.groan();
    pushKillFeed('An infected is back up — watch your six');
  }
  confirmedKill(headshot) {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    if (!this.countedKill) {
      this.countedKill = true;
      state.kills++;
      updateObjectiveHUD();
    }
    pushKillFeed(headshot ? 'Headshot — vaporized' : 'Vaporized');
    // Blown apart into sparkles instead of leaving a corpse behind — the
    // coin (spawned right after) is the only thing left on the ground.
    spawnDeathSparkles(this.mesh.position);
    spawnCoin(this.mesh.position);
    registerKillstreak(this.mesh.position);
    scene.remove(this.mesh);
    // Deferred to a macrotask so a kill that happens *during* the
    // state.zombies.forEach(z => z.update(...)) pass (e.g. running a
    // zombie over with the car) doesn't splice the array out from under
    // that same in-progress iteration.
    setTimeout(() => this.remove(), 0);
  }
  update(dt, playerPos) {
    if (!this.alive) return; // already exploded — waiting to be spliced out
    if (this.state === 'downed') {
      this.downedTimer -= dt;
      if (this.downedTimer <= 0) this.reanimate();
      return;
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
    const others = state.zombies.filter((z) => z !== this && z.alive).map((z) => ({
      x: z.mesh.position.x, z: z.mesh.position.z, r: 0.7,
    }));
    if (this.state === 'chase') {
      const move = toPlayer.clone().normalize();
      avoidObstacles(this.mesh.position, move, others);
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
      this.playWalk(dt, 8, 0.55 + this.speed * 0.2);
    } else if (this.state === 'attack') {
      const targetAngle = Math.atan2(toPlayer.x, toPlayer.z);
      this.mesh.rotation.y = lerpAngle(this.mesh.rotation.y, targetAngle, dt * 8);
      this.attackCooldown -= dt;
      this.playWalk(dt, 3, 0.7);
      if (this.attackCooldown <= 0 && !state.inVehicle) {
        this.attackCooldown = 0.95;
        if (!state.shieldActive) {
          damagePlayer(8 + Math.random() * 5);
          flashDamage();
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
    if (state.inVehicle) {
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
    if (this.rigged) groundClampRig(this.rigObj, this.footBoneL, this.footBoneR, dt, 10, this.ankleToSole);
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
    const idx = state.zombies.indexOf(this);
    if (idx >= 0) state.zombies.splice(idx, 1);
  }
}

export function spawnDepotGuards() {
  const spots = [
    [DEPOT_POS.x - 4, DEPOT_POS.z + 3], [DEPOT_POS.x + 5, DEPOT_POS.z - 2],
    [DEPOT_POS.x - 2, DEPOT_POS.z - 6], [DEPOT_POS.x + 3, DEPOT_POS.z + 6],
  ];
  spots.forEach((p) => {
    const z = new Zombie(new THREE.Vector3(p[0], 0, p[1]));
    z.health = z.maxHealth = 95 + Math.floor(Math.random() * 25);
    z.speed *= 1.15;
    z.mesh.scale.setScalar(1.08);
    state.zombies.push(z);
    state.spawnedTotal++;
  });
}

export function spawnZombie() {
  if (state.zombies.length >= ZOMBIE_MAX_ALIVE || state.spawnedTotal >= KILL_TARGET + 10) return;
  const around = playerVis.group.position;
  const ang = Math.random() * Math.PI * 2;
  const dist = 16 + Math.random() * 24;
  let x = around.x + Math.sin(ang) * dist;
  let z = around.z - Math.abs(Math.cos(ang) * dist);
  x = THREE.MathUtils.clamp(x, -STREET_HALF_W + 0.8, STREET_HALF_W - 0.8);
  z = THREE.MathUtils.clamp(z, -STREET_LENGTH + 16, 28);
  if (Math.hypot(x - around.x, z - around.z) < 10) z -= 12;
  const zom = new Zombie(new THREE.Vector3(x, 0, z));
  state.zombies.push(zom);
  state.spawnedTotal++;
}