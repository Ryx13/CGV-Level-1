import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state } from './state.js';
import {
  scene, world, camera, renderer, dom, sfx, sky,
  pushKillFeed, doDeath, doWin, checkExtraction, updateExtractRing,
  updateAmmoHUD, updateObjectiveHUD, updateWeaponHUD, updateCoinHUD,
  updateCompass, drawRadar, createMissionTracker, loadWorldBounds, onAssetsReady,
  forwardFromYaw, rightFromYaw,
  STREET_HALF_W, ZOMBIE_SPAWN_INTERVAL,
  updateFuelHUD as updateFuelHUDBase,
} from './Scene.js';
// Actions.js and characters.js import from each other (characters.js needs
// damagePlayer/spawnHitSpark/spawnBlood for zombie hits; Actions.js needs
// the player rig, the vehicle, and their tuning constants). This is safe
// circularity: every cross-reference below is only ever touched from
// inside a function body (called later, once the whole module graph has
// finished loading), never at either file's own top level — the same
// deferred pattern documented in PowerUps.js and Scene.js.
import {
  playerVis, playerBody, playerHeight, bloodTex,
  carVis, chassisBody, vehicle, carSpawn, CAR_MAX_FUEL,
  FRONT_WHEELS, REAR_WHEELS, MAX_STEER, MAX_ENGINE_FORCE, MAX_BRAKE_FORCE, HANDBRAKE_FORCE,
  viewmodelGun, knifeThirdPerson, knifeViewModel,
  syncHandGun, setPlayerAction, groundClampRig, lerpAngle, checkVehicleRollover,
  ZOMBIE_TARGET_HEIGHT,
  loadMainCharacter, loadZombies, loadCars, loadBuildings, loadTrashCans, loadObstacles,
  loadStreetSurface, spawnDepotGuards, spawnZombie,
  adjustPlayerScale,
} from './characters.js';
import {
  loadBarrels, initShield,
  updatePickups, updatePowerups, updateCoins, updateExplosions, updateShield,
} from './PowerUps.js';

/* ======================================================================
   Actions.js — PLAYER ACTIONS: MOVEMENT, CAMERA, SHOOTING, BULLETS,
   VEHICLE CONTROLS, AND THE LEVEL BOOTSTRAP/GAME LOOP

   Every tunable value below (fire rate, damage, movement speed, bullet/
   melee range, brake/engine forces) is copied verbatim from the original
   game.js — nothing here changes gameplay, only where the code lives.
====================================================================== */

/* ---------------------------------------------------------------------
   COMBAT — weapon tuning, hit VFX, gun/melee/knife logic
--------------------------------------------------------------------- */
export const MAG_SIZE = 30; // was 12 — read as an underpowered pistol, not a combat weapon
const FIRE_RATE = 0.11; // was 0.19 (~5.3rps) — now ~9rps, an actual automatic weapon
const GUN_DAMAGE = 26;
const MELEE_DAMAGE = 42;
const MELEE_RANGE = 2.15;
const KNIFE_DAMAGE = 38;
const KNIFE_RANGE = 1.9;

// The real DOM update lives in Scene.js (which can't import CAR_MAX_FUEL
// from characters.js at its own top level). Actions.js re-exposes it with
// CAR_MAX_FUEL defaulted in, so PowerUps.js can import "updateFuelHUD"
// from here and call it either with an explicit maxFuel (as it does) or
// with no argument at all (matching the original zero-arg call site).
export function updateFuelHUD(maxFuel = CAR_MAX_FUEL) {
  updateFuelHUDBase(maxFuel);
}

const raycaster = new THREE.Raycaster();
const sparkGeo = new THREE.SphereGeometry(0.05, 6, 6);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc55 });

export function spawnHitSpark(pos) {
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(sparkGeo, sparkMat.clone());
    s.position.copy(pos);
    s.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3);
    s.userData.life = 0.4;
    s.userData.maxLife = 0.4;
    scene.add(s);
    state.activeSparks.push(s);
  }
}

export function spawnBlood(pos) {
  const decal = new THREE.Mesh(
    new THREE.CircleGeometry(0.35 + Math.random() * 0.25, 10),
    new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, depthWrite: false, opacity: 0.85 })
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(pos.x, 0.04, pos.z);
  scene.add(decal);
  setTimeout(() => scene.remove(decal), 20000);
}

function activeGunMesh() {
  return state.firstPerson ? viewmodelGun : playerVis.gunPivot;
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
  state.activeTracers.push(mesh);
}

/* -----------------------------------------------------------------
   WEAPON SWITCHING — gun vs. knife.
   The player always starts with a full magazine (state.ammoMag =
   MAG_SIZE). Once BOTH the magazine and the reserve are empty, there is
   nothing left to reload, so the gun is holstered automatically and the
   knife becomes the only option until an ammo pickup/powerup arrives.
   Otherwise the player can freely toggle with Q.
----------------------------------------------------------------- */
function hasAnyAmmo() { return state.ammoMag > 0 || state.ammoReserve > 0; }
function setWeaponVisualsVisible() {
  const showGun = state.currentWeapon === 'gun';
  if (playerVis.gun) playerVis.gun.visible = showGun;
  if (knifeThirdPerson) knifeThirdPerson.visible = !showGun;
  if (viewmodelGun.children[0]) viewmodelGun.children[0].visible = showGun;
  if (knifeViewModel) knifeViewModel.visible = !showGun;
}
export function switchWeapon(weapon) {
  if (weapon === 'gun' && !hasAnyAmmo()) {
    pushKillFeed('No ammo left — knife only');
    weapon = 'knife';
  }
  if (weapon === state.currentWeapon) return;
  state.currentWeapon = weapon;
  setWeaponVisualsVisible();
  updateWeaponHUD();
  pushKillFeed(state.currentWeapon === 'gun' ? 'Switched to pistol' : 'Switched to knife');
}
// Forces the knife if ammo has fully run out (both mag and reserve empty).
// Called after every shot and after reload attempts/failures.
function enforceAmmoWeaponRule() {
  if (!hasAnyAmmo() && state.currentWeapon !== 'knife') {
    state.currentWeapon = 'knife';
    setWeaponVisualsVisible();
    updateWeaponHUD();
    pushKillFeed('Out of ammo — switched to knife');
  }
}

export function togglePause() {
  if (state.isDead) return; // don't let pause interfere with the death/win screens
  if (!dom.hud || dom.hud.classList.contains('hidden')) return; // no pausing before the level has even started
  state.paused = !state.paused;
  if (state.paused) {
    if (dom.pauseOverlay) dom.pauseOverlay.classList.remove('hidden');
    // Pointer lock has to go — otherwise the mouse stays trapped and
    // invisible, and clicking the on-screen Resume button becomes
    // impossible. Exiting it here also frees the cursor for anyone using
    // the mouse instead of Tab to resume.
    document.exitPointerLock();
    sfx.setEngine(0, false);
  } else {
    if (dom.pauseOverlay) dom.pauseOverlay.classList.add('hidden');
    // Re-lock automatically on resume so play continues immediately
    // instead of requiring an extra click just to get mouse-look back —
    // browsers allow this since the Tab press / button click that got us
    // here counts as the required direct user gesture.
    dom.canvas.requestPointerLock();
  }
}

export function showHitmarker() {
  dom.hitmarker.classList.remove('show'); void dom.hitmarker.offsetWidth;
  dom.hitmarker.classList.add('show');
}

export function tryShoot() {
  if (state.currentWeapon !== 'gun') { tryKnife(); return; }
  if (state.inVehicle || state.isDead || state.reloading || state.fireCooldown > 0) return;
  if (state.ammoMag <= 0) { startReload(); return; }
  state.fireCooldown = FIRE_RATE;
  state.ammoMag--;
  updateAmmoHUD();
  spawnMuzzleFlash();
  sfx.shoot();
  state.shake = Math.max(state.shake, 0.08);
  triggerShootAnimSafe();
  // Recoil is a separate, capped, decaying value instead of a permanent
  // addition to the actual aim pitch — sustained fire can never push the
  // view (and therefore the next shot's raycast) into broken angles.
  state.recoilPitch = Math.min(state.recoilPitch + 0.02, 0.3);
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  // Raycast against each alive zombie's actual mesh group (recursive), not
  // just the abstract hitbox capsule, so a visually-on-target shot can't
  // silently miss due to hitbox/model misalignment.
  const targets = [];
  state.zombies.forEach((z) => { if (z.alive) targets.push(z.mesh); });
  state.explosiveBarrels.forEach((b) => { if (!b.exploded) targets.push(b.mesh); });
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
  if (state.ammoMag <= 0) startReload();
  enforceAmmoWeaponRule();
}
function triggerShootAnimSafe() {
  if (!playerVis.shootAction) return;
  playerVis.shootAction.reset();
  playerVis.shootAction.play();
}

export function tryMelee() {
  if (state.inVehicle || state.isDead || state.meleeTimer > 0) return;
  state.meleeTimer = 0.38;
  sfx.melee();
  const playerPos = playerVis.group.position;
  const forward = forwardFromYaw(state.yaw);
  let hitAny = false;
  state.zombies.forEach((z) => {
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
export function tryKnife() {
  if (state.inVehicle || state.isDead || state.meleeTimer > 0) return;
  state.meleeTimer = 0.32;
  sfx.melee();
  const playerPos = playerVis.group.position;
  const forward = forwardFromYaw(state.yaw);
  let hitAny = false;
  state.zombies.forEach((z) => {
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
export function startReload() {
  if (state.currentWeapon !== 'gun') return;
  if (state.reloading || state.ammoMag === MAG_SIZE || state.ammoReserve <= 0 || state.inVehicle) {
    enforceAmmoWeaponRule();
    return;
  }
  state.reloading = true; state.reloadTimer = 1.55;
  dom.reloadText.classList.remove('hidden');
}

/* ---------------------------------------------------------------------
   PLAYER DAMAGE / DEATH
--------------------------------------------------------------------- */
export function damagePlayer(dmg) {
  if (state.isDead) return;
  if (state.shieldActive) return; // shield blocks all attacks outright
  state.playerHealth = Math.max(0, state.playerHealth - dmg);
  dom.healthFill.style.width = (state.playerHealth / state.playerMaxHealth) * 100 + '%';
  if (dom.bloodVig) dom.bloodVig.style.opacity = String(1 - state.playerHealth / state.playerMaxHealth);
  sfx.hurt();
  state.shake = Math.max(state.shake, 0.22);
  if (state.playerHealth <= 0) {
    // Play the Shooter_Pack death clip (if loaded) before handing off to
    // Scene.js's doDeath() for the game-over UI/logic. The lock keeps
    // updatePlayerMovement's normal idle/walk selection from stomping on
    // it on the very next frame.
    if (playerVis.actions && playerVis.actions.die) {
      setPlayerAction('die');
      state.playerActionLock = playerVis.dieDuration || 2;
    }
    doDeath();
  }
}

/* ---------------------------------------------------------------------
   VEHICLE ENTER / EXIT
--------------------------------------------------------------------- */
export function toggleVehicle() {
  if (state.isDead) return;
  if (!state.inVehicle) {
    const dist = playerVis.group.position.distanceTo(carVis.group.position);
    if (dist < 3.4) {
      state.inVehicle = true;
      playerVis.group.visible = false;
      if (playerVis.gunOnHand) playerVis.gunPivot.visible = false;
      playerBody.position.set(-1000, -50, -1000);
      playerBody.velocity.set(0, 0, 0);
      const eu = new THREE.Euler().setFromQuaternion(carVis.group.quaternion, 'YXZ');
      state.yaw = eu.y + Math.PI;
      state.pitch = -0.12;
      dom.speedo.classList.remove('hidden');
    }
  } else {
    state.inVehicle = false;
    state.carSteer = 0;
    vehicle.setSteeringValue(0, 0); vehicle.setSteeringValue(0, 1);
    vehicle.applyEngineForce(0, 2); vehicle.applyEngineForce(0, 3);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(carVis.group.quaternion);
    let exitPos = carVis.group.position.clone().addScaledVector(right, 2.3);
    exitPos.x = THREE.MathUtils.clamp(exitPos.x, -STREET_HALF_W + 0.6, STREET_HALF_W - 0.6);
    playerBody.position.set(exitPos.x, 1.2, exitPos.z);
    playerBody.velocity.set(0, 0, 0);
    state.yaw = Math.atan2(right.x, right.z) + Math.PI / 2;
    dom.speedo.classList.add('hidden');
    sfx.setEngine(0, false);
  }
}

export function updateInteractionPrompt() {
  if (state.isDead) { dom.prompt.classList.add('hidden'); return; }
  if (!state.inVehicle) {
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

/* ---------------------------------------------------------------------
   CAMERA
--------------------------------------------------------------------- */
const camRayHelper = new THREE.Raycaster();
const EYE_HEIGHT = 1.62; // above playerVis.group's origin, which sits at the feet

export function updateCameraOnFoot(dt) {
  // Recoil recovers over time instead of permanently accumulating.
  state.recoilPitch = Math.max(0, state.recoilPitch - dt * 0.5);
  const viewPitch = THREE.MathUtils.clamp(state.pitch + state.recoilPitch, -1.05, 0.85);
  // Sprint FOV kick — a widened field of view is the classic "you are now
  // running" cue, works even if the speed increase itself is hard to judge.
  const targetFov = state.isSprinting ? 74 : 62;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, Math.min(1, dt * 8));
    camera.updateProjectionMatrix();
  }
  if (state.firstPerson) {
    const eyePos = playerVis.group.position.clone().add(new THREE.Vector3(0, EYE_HEIGHT - (state.crouching ? 0.42 : 0), 0));
    camera.position.copy(eyePos);
    const horizSpeed = Math.hypot(playerBody.velocity.x, playerBody.velocity.z);
    if (horizSpeed > 0.4) state.bobPhase += dt * horizSpeed * 1.8;
    const bobAmt = Math.min(horizSpeed, 6.5) * 0.007;
    camera.position.y += Math.sin(state.bobPhase) * bobAmt;
    camera.position.x += Math.cos(state.bobPhase * 0.5) * bobAmt * 0.6;
    if (state.shake > 0.002) {
      camera.position.x += (Math.random() - 0.5) * state.shake;
      camera.position.y += (Math.random() - 0.5) * state.shake;
    }
    camera.rotation.order = 'YXZ';
    camera.rotation.set(viewPitch, state.yaw, 0);
    if (state.meleeTimer > 0) viewmodelGun.rotation.x = -Math.sin(state.meleeTimer * 14) * 0.9;
    else viewmodelGun.rotation.x = 0;
    if (knifeViewModel) knifeViewModel.rotation.x = viewmodelGun.rotation.x;
    return;
  }
  playerVis.group.rotation.y = lerpAngle(
    playerVis.group.rotation.y,
    state.playerMoving ? state.playerFacingAngle : state.yaw,
    dt * 10
  );
  const origin = playerVis.group.position.clone().add(new THREE.Vector3(0, 1.52 - (state.crouching ? 0.42 : 0), 0));
  const fwd = forwardFromYaw(state.yaw);
  const right = rightFromYaw(state.yaw);
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
  const hits = camRayHelper.intersectObjects(state.occluders, false);
  let finalPos = desired;
  if (hits.length && hits[0].distance > 0.9) {
    finalPos = origin.clone().add(desired.clone().sub(origin).normalize().multiplyScalar(Math.max(1.15, hits[0].distance * 0.88)));
  }
  camera.position.lerp(finalPos, 0.28);
  if (state.shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * state.shake;
    camera.position.y += (Math.random() - 0.5) * state.shake;
  }
  camera.lookAt(lookTarget);
  camera.rotation.order = 'XYZ'; // lookAt() sets the quaternion directly; restore default order after
  if (state.meleeTimer > 0) {
    playerVis.gunPivot.rotation.x = -Math.sin(state.meleeTimer * 14) * 0.9;
  }
}
export function updateCameraInCar() {
  const carPos = carVis.group.position;
  const fwd = forwardFromYaw(state.yaw);
  const right = rightFromYaw(state.yaw);
  const cp = Math.cos(state.pitch * 0.85);
  const sp = Math.sin(state.pitch * 0.85);
  const desired = carPos.clone()
    .addScaledVector(fwd, -7.2 * cp)
    .addScaledVector(right, 0.2)
    .add(new THREE.Vector3(0, 2.4 + sp * 2.2, 0));
  camera.position.lerp(desired, 0.12);
  if (state.shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * state.shake * 0.6;
    camera.position.y += (Math.random() - 0.5) * state.shake * 0.6;
  }
  camera.lookAt(carPos.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(fwd, 6));
}

/* ---------------------------------------------------------------------
   MOVEMENT + VEHICLE CONTROLS
--------------------------------------------------------------------- */
// Picks which Shooter_Pack (or baked-in fallback) action name to play
// for the current input, preferring the most specific clip that's
// actually loaded and falling back a step at a time so a slow-loading
// or missing Shooter_Pack file never leaves the player animation-less.
function pickLocomotionAction(forwardInput, strafeInput, sprinting, moving) {
  const has = (k) => playerVis.actions && playerVis.actions[k];
  if (!moving) return 'idle';
  if (forwardInput > 0) {
    if (sprinting && has('sprint')) return 'sprint';
    return has('walk') ? 'walk' : 'idle';
  }
  if (forwardInput < 0) {
    if (sprinting && has('runBack')) return 'runBack';
    if (has('walkBack')) return 'walkBack';
    return has('walk') ? 'walk' : 'idle'; // no backward clip loaded yet — still communicates motion
  }
  if (strafeInput > 0) return has('strafeR') ? 'strafeR' : (has('walk') ? 'walk' : 'idle');
  if (strafeInput < 0) return has('strafeL') ? 'strafeL' : (has('walk') ? 'walk' : 'idle');
  return 'idle';
}

export function updatePlayerMovement(dt) {
  const forwardInput = (state.keys['KeyW'] ? 1 : 0) - (state.keys['KeyS'] ? 1 : 0);
  const strafeInput = (state.keys['KeyD'] ? 1 : 0) - (state.keys['KeyA'] ? 1 : 0);
  // Crouch: no collider change, just a slower, quieter stance — camera
  // drops to match in updateCameraOnFoot. Can't sprint while crouched.
  state.crouching = !!(state.keys['ControlLeft'] || state.keys['ControlRight'] || state.keys['KeyC']);
  const sprinting = !state.crouching && (state.sprintToggle || state.keys['ShiftLeft'] || state.keys['ShiftRight']) && forwardInput > 0 && state.playerStamina > 2;
  state.isSprinting = sprinting;
  const speed = sprinting ? 8.4 : (state.crouching ? 2.1 : 3.7);
  const fwd = forwardFromYaw(state.yaw);
  const right = rightFromYaw(state.yaw);
  const move = new THREE.Vector3()
    .addScaledVector(fwd, forwardInput)
    .addScaledVector(right, strafeInput);
  // Facing direction while moving — previously the body's rotation was
  // tied directly to camera yaw regardless of movement, so strafing or
  // walking backward still showed the character facing straight ahead
  // instead of the direction they were actually headed. atan2(x,z)
  // matches the same forward/right convention used everywhere else
  // (forwardFromYaw, zombie facing, etc.), so a movement vector of pure
  // "strafe right" correctly resolves to facing right, "backward" to
  // facing back, and diagonals to the blended angle in between. Read
  // before normalizing below — atan2 only cares about direction, not
  // magnitude, so this doesn't need its own separate vector.
  state.playerMoving = forwardInput !== 0 || strafeInput !== 0;
  if (state.playerMoving) state.playerFacingAngle = Math.atan2(-move.x, -move.z);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
  // Direct assignment, not eased/lerped toward the previous velocity — a
  // self-referential lerp can get stuck at NaN forever if the body's
  // velocity is ever NaN even once; direct assignment can't compound that.
  playerBody.velocity.x = move.x;
  playerBody.velocity.z = move.z;
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
  if (state.keys['Space'] && grounded && playerBody.velocity.y < 1) {
    playerBody.velocity.y = 5.6;
    // If the player is moving backward when they jump, use the
    // Shooter_Pack's backward jump clip instead of the forward one, when
    // it's loaded; otherwise fall back to the regular jump.
    const jumpKey = (forwardInput < 0 && playerVis.actions && playerVis.actions.jumpBack) ? 'jumpBack' : 'jump';
    if (playerVis.actions && playerVis.actions[jumpKey]) {
      setPlayerAction(jumpKey);
      state.playerActionLock = (jumpKey === 'jumpBack' ? playerVis.jumpBackDuration : playerVis.jumpDuration) || 0.5;
    }
  }
  // Drain slowed / regen sped up so a sustained sprint doesn't read as
  // "sprint stopped working."
  if (sprinting) state.playerStamina = Math.max(0, state.playerStamina - dt * 11);
  else state.playerStamina = Math.min(100, state.playerStamina + dt * 22);
  dom.staminaFill.style.width = state.playerStamina + '%';
  playerVis.group.position.set(playerBody.position.x, playerBody.position.y - playerHeight / 2, playerBody.position.z);
  const moving = move.lengthSq() > 0.01;
  if (playerVis.rigged && playerVis.mixer && playerVis.actions) {
    if (state.playerActionLock > 0) {
      state.playerActionLock -= dt;
    } else {
      setPlayerAction(pickLocomotionAction(forwardInput, strafeInput, sprinting, moving));
    }
    playerVis.mixer.update(dt);
    groundClampRig(playerVis.rigObj, playerVis.footBoneL, playerVis.footBoneR, dt, 10, playerVis.ankleToSole);
    syncHandGun();
  } else if (moving) {
    state.walkCycle += dt * (sprinting ? 12 : 6);
    const amp = sprinting ? 0.78 : 0.5;
    const swing = Math.sin(state.walkCycle) * amp;
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
    state.footTimer -= dt;
    if (state.footTimer <= 0) { sfx.foot(); state.footTimer = sprinting ? 0.28 : (state.crouching ? 0.6 : 0.42); }
  }
  if (dom.debugReadout) {
    const rawShift = (state.keys['ShiftLeft'] ? 'L' : '') + (state.keys['ShiftRight'] ? 'R' : '') || 'none';
    dom.debugReadout.textContent =
      `Shift held: ${rawShift} | Toggle: ${state.sprintToggle} | Sprinting: ${sprinting} | Stamina: ${state.playerStamina.toFixed(0)}\n` +
      `Rigged model: ${playerVis.rigged} | Anim state: ${playerVis.currentActionName || 'n/a'}\n` +
      `Player height: ${state.playerCurrentHeight.toFixed(2)}m (zombies are ${ZOMBIE_TARGET_HEIGHT}m) [ / ] to adjust\n` +
      `Grip preset: ${state.gunGripIndex} (U to cycle) | Weapon: ${state.currentWeapon} | Coins: ${state.coins} | Fuel: ${state.carFuel.toFixed(0)}`;
  }
  state.zombies.forEach((z) => {
    if (!z.alive) return;
    const dx = playerVis.group.position.x - z.mesh.position.x;
    const dz = playerVis.group.position.z - z.mesh.position.z;
    const d = Math.hypot(dx, dz);
    const SEP_RADIUS = 0.95;
    if (d < SEP_RADIUS) {
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
  // front wheels sit at z=-1.55) into world space. Positive forwardSpeed
  // genuinely means "moving toward the nose."
  const q = chassisBody.quaternion;
  return new CANNON.Vec3(
    -2 * (q.x * q.z + q.w * q.y),
    -2 * (q.y * q.z - q.w * q.x),
    -(1 - 2 * (q.x * q.x + q.y * q.y))
  );
}
export function updateVehicleControls(dt) {
  const throttleInput = (state.keys['KeyW'] ? 1 : 0) - (state.keys['KeyS'] ? 1 : 0);
  const steerInput = (state.keys['KeyA'] ? 1 : 0) - (state.keys['KeyD'] ? 1 : 0);
  const speedKph = Math.abs(chassisBody.velocity.length()) * 3.6;
  const steerFalloff = THREE.MathUtils.clamp(1 - speedKph / 130, 0.32, 1);
  const targetSteer = steerInput * MAX_STEER * steerFalloff;
  state.carSteer = THREE.MathUtils.lerp(state.carSteer, targetSteer, dt * 6);
  vehicle.setSteeringValue(state.carSteer, FRONT_WHEELS[0]);
  vehicle.setSteeringValue(state.carSteer, FRONT_WHEELS[1]);
  // Out of fuel: no engine force at all — the truck coasts/brakes to a
  // stop like a real vehicle running dry.
  const hasFuel = state.carFuel > 0;
  const forwardSpeed = chassisBody.velocity.dot(chassisForward());
  const targetThrottle = (hasFuel && throttleInput > 0) ? 1 : (hasFuel && throttleInput < 0 ? -0.55 : 0);
  state.carThrottle = THREE.MathUtils.lerp(state.carThrottle, targetThrottle, dt * 4.5);
  const engineForce = state.carThrottle * MAX_ENGINE_FORCE;
  REAR_WHEELS.forEach((i) => vehicle.applyEngineForce(engineForce, i));
  FRONT_WHEELS.forEach((i) => vehicle.applyEngineForce(engineForce * 0.28, i));
  // Fuel drains only while actually under power (throttle applied and
  // moving), not just for sitting in the driver's seat.
  if (hasFuel && Math.abs(throttleInput) > 0 && Math.abs(forwardSpeed) > 0.3) {
    state.carFuel = Math.max(0, state.carFuel - dt * 1.6);
    updateFuelHUD();
    if (state.carFuel <= 0) pushKillFeed('Out of fuel — find a petrol powerup');
  }
  const handbrake = !!state.keys['Space'];
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
  if (speedKph > 40) state.shake = Math.max(state.shake, 0.015);
  if (chassisBody.position.y < -20) {
    chassisBody.position.set(carSpawn.x, carSpawn.y + 1, carSpawn.z);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);
  }
}

/* ---------------------------------------------------------------------
   INPUT WIRING
--------------------------------------------------------------------- */
function initInputHandlers() {
  window.addEventListener('keydown', (e) => {
    state.keys[e.code] = true;
    // Double-tap W toggles sprint on/off — independent of Shift detection,
    // as a guaranteed fallback in case a held modifier key is getting
    // swallowed by the browser/OS.
    if (e.code === 'KeyW' && !e.repeat) {
      const now = performance.now();
      if (now - state.lastWTapTime < 300) {
        state.sprintToggle = !state.sprintToggle;
        pushKillFeed(state.sprintToggle ? 'Sprint toggle ON (double-tap W)' : 'Sprint toggle OFF');
      }
      state.lastWTapTime = now;
    }
    // Live player-scale tuning — dropped during the Actions.js/characters.js
    // split (it used to live inline in the old game.js keydown handler);
    // adjustPlayerScale() itself survived the split fine, it just had no
    // caller left. Re-wired here so [ / ] work again as the HUD hint claims.
    // e.repeat guard: holding the key down (even briefly) would otherwise
    // fire the browser's key-repeat dozens of times per second, each one
    // compounding another 5% shrink/grow — more than enough to silently
    // drift the player down to a fraction of their intended size (this is
    // almost certainly what happened to produce a reported height of
    // 0.78m instead of ~1.8m). One press now means exactly one 5% step.
    if (e.code === 'BracketLeft' && !e.repeat) adjustPlayerScale(0.95);
    if (e.code === 'BracketRight' && !e.repeat) adjustPlayerScale(1.05);
  });
  window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });
  dom.canvas.addEventListener('mousemove', (e) => {
    if (!state.pointerLocked) return;
    state.yaw -= e.movementX * 0.002;
    state.pitch -= e.movementY * 0.002;
    state.pitch = THREE.MathUtils.clamp(state.pitch, -1.05, 0.72);
  });
  dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked = document.pointerLockElement === dom.canvas;
  });
  dom.canvas.addEventListener('click', () => {
    const gameActive = !dom.hud.classList.contains('hidden') && dom.death.classList.contains('hidden') && dom.win.classList.contains('hidden');
    if (gameActive && !state.pointerLocked) {
      sfx.init();
      dom.canvas.requestPointerLock();
    }
  });
  window.addEventListener('mousedown', (e) => {
    if (!state.pointerLocked) return;
    if (e.button === 0) { state.firePressed = true; tryShoot(); }
    if (e.button === 2) tryMelee();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firePressed = false;
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyF') toggleVehicle();
    if (e.code === 'KeyV' && !state.inVehicle) state.firstPerson = !state.firstPerson;
    if (e.code === 'KeyQ') switchWeapon(state.currentWeapon === 'gun' ? 'knife' : 'gun');
    if (e.code === 'Tab') {
      e.preventDefault(); // Tab normally shifts browser focus — stop that
      togglePause();
    }
  });
  if (dom.pauseBtn) dom.pauseBtn.addEventListener('click', () => togglePause());
  if (dom.resumeBtn) dom.resumeBtn.addEventListener('click', () => togglePause());
}

/* ---------------------------------------------------------------------
   LEVEL BOOTSTRAP — asset loading + world population, input wiring, and
   the main render/physics loop. Called once by each Level file. Levels
   are identical for now; `levelConfig` exists so Level1/2/3 have a place
   to diverge later without touching this shared logic.
--------------------------------------------------------------------- */
let missionTracker = null;

export function bootLevel(levelConfig = {}) {
  // The intro screen and level-select screen (main.js) already ran before
  // this function was even called, so there's no further click to gate
  // gameplay-start behind — as soon as assets are ready, jump straight
  // into the HUD/game. Registered up front, before any of the loaders
  // below fire, in case something somehow resolved synchronously.
  onAssetsReady(() => {
    sfx.init();
    if (sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
    // Pointer lock requires a direct user gesture in most browsers, and
    // by the time assets finish loading that gesture (the level-select
    // click) is long stale, so this attempt may be silently ignored —
    // that's fine, the canvas click handler wired below is the fallback
    // the player uses to lock in.
    dom.canvas.requestPointerLock();
    spawnDepotGuards();
    updateObjectiveHUD();
    updateWeaponHUD();
    updateCoinHUD();
    updateFuelHUD();
  });

  // World population — mirrors the exact order the original monolithic
  // game.js ran this in at module load time.
  loadWorldBounds();
  loadStreetSurface();
  const { depotYard } = loadBuildings();
  loadObstacles();
  loadTrashCans();
  loadCars();
  loadMainCharacter();
  loadZombies();
  loadBarrels();
  initShield();
  missionTracker = createMissionTracker(depotYard);

  initInputHandlers();

  // Initial HUD paint, matching the bottom of the original game.js.
  updateAmmoHUD();
  updateObjectiveHUD();
  updateWeaponHUD();
  updateCoinHUD();
  updateFuelHUD();

  startAnimationLoop();

  if (levelConfig.name) pushKillFeed(`${levelConfig.name} loaded`);
}

const clock = new THREE.Clock();
let stepAccumulator = 0;
const FIXED_STEP = 1 / 60;

function startAnimationLoop() {
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    state.shake = Math.max(0, state.shake - dt * 1.8);
    state.meleeTimer = Math.max(0, state.meleeTimer - dt);
    sky.position.copy(camera.position);
    if (!state.isDead && !state.paused && dom.hud && !dom.hud.classList.contains('hidden')) {
      stepAccumulator += dt;
      while (stepAccumulator >= FIXED_STEP) {
        world.step(FIXED_STEP);
        stepAccumulator -= FIXED_STEP;
      }
      checkVehicleRollover(dt);
      if (state.fireCooldown > 0) state.fireCooldown -= dt;
      if (state.firePressed && !state.inVehicle && state.currentWeapon === 'gun') tryShoot();
      if (state.reloading) {
        state.reloadTimer -= dt;
        if (state.reloadTimer <= 0) {
          const need = MAG_SIZE - state.ammoMag;
          const take = Math.min(need, state.ammoReserve);
          state.ammoMag += take; state.ammoReserve -= take;
          state.reloading = false;
          dom.reloadText.classList.add('hidden');
          updateAmmoHUD();
        }
      }
      if (state.inVehicle) {
        updateVehicleControls(dt);
        updateCameraInCar();
        playerVis.group.visible = false;
        viewmodelGun.visible = false;
        if (knifeViewModel) knifeViewModel.visible = false;
        if (playerVis.gunOnHand) playerVis.gunPivot.visible = false;
      } else {
        updatePlayerMovement(dt);
        updateCameraOnFoot(dt);
        playerVis.group.visible = !state.firstPerson;
        viewmodelGun.visible = state.firstPerson && state.currentWeapon === 'gun';
        if (knifeViewModel) knifeViewModel.visible = state.firstPerson && state.currentWeapon === 'knife';
        if (playerVis.gunOnHand) playerVis.gunPivot.visible = !state.firstPerson;
        sfx.setEngine(0, false);
      }
      const activePos = state.inVehicle ? carVis.group.position : playerVis.group.position;
      state.zombies.forEach((z) => z.update(dt, activePos));
      updateExplosions(dt);
      updateShield(dt);
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) { state.spawnTimer = ZOMBIE_SPAWN_INTERVAL; spawnZombie(); }
      for (let i = state.activeSparks.length - 1; i >= 0; i--) {
        const s = state.activeSparks[i];
        s.userData.vel.y -= 9 * dt;
        s.position.addScaledVector(s.userData.vel, dt);
        s.userData.life -= dt;
        s.material.opacity = Math.max(0, s.userData.life / (s.userData.maxLife || 0.4));
        s.material.transparent = true;
        if (s.userData.life <= 0) { scene.remove(s); state.activeSparks.splice(i, 1); }
      }
      for (let i = state.activeTracers.length - 1; i >= 0; i--) {
        const tr = state.activeTracers[i];
        tr.userData.life -= dt;
        tr.material.opacity = Math.max(0, tr.userData.life / tr.userData.maxLife) * 0.95;
        if (tr.userData.life <= 0) { scene.remove(tr); tr.geometry.dispose(); tr.material.dispose(); state.activeTracers.splice(i, 1); }
      }
      state.smokeGroups.forEach((group) => {
        group.children.forEach((sp) => {
          sp.position.y += sp.userData.speed * dt * 0.32;
          sp.material.rotation += dt * 0.12;
          if (sp.position.y - sp.userData.baseY > 5) sp.position.y = sp.userData.baseY;
        });
      });
      updateExtractRing(dt);
      updatePickups(dt, activePos);
      updatePowerups(dt, activePos, CAR_MAX_FUEL);
      updateCoins(dt, activePos);
      updateInteractionPrompt();
      if (missionTracker) missionTracker.checkDepotObjective(activePos);
      updateCompass(activePos, forwardFromYaw(state.yaw));
      checkExtraction(activePos, doWin);
      drawRadar(activePos, state.inVehicle ? new THREE.Euler().setFromQuaternion(carVis.group.quaternion, 'YXZ').y : state.yaw);
    }
    renderer.render(scene, camera);
  }
  animate();
}