/* ======================================================================
   state.js — SHARED GAME STATE

   The original game.js was a single script where every variable lived in
   one shared top-level scope. Splitting that into separate files while
   keeping the exact same behavior means these cross-cutting, frequently
   mutated values need one shared home that every module can read AND
   write. This file is that shared mechanism (see refactor notes, section
   15: "if a shared state/system is needed by multiple modules, create an
   appropriate shared mechanism rather than creating duplicate versions of
   the state").

   Every other module imports `state` and reads/writes its properties
   directly, e.g. `state.playerHealth -= 10`. Nothing here changes any
   gameplay value — it's purely a container.
====================================================================== */

export const state = {
  // Live-tunable facing offsets (I / O / P in-game cycle these 90°).
  ZOMBIE_RIG_YAW_OFFSET: 0,
  PLAYER_RIG_YAW_OFFSET: Math.PI,
  CAR_RIG_YAW_OFFSET: Math.PI,

  // Mission / objective state
  stage: 1, // 1 = clear the route, 2 = recover the sample, 3 = extract
  ingredientCollected: false,

  // Day / Night — chosen on the mode-select screen (main.js) right after
  // a level is picked. 'night' is the original look the game already
  // had; 'day' is the new alternative. Scene.js reads this to drive
  // lighting/sky/fog, and to decide whether rain + puddles are active.
  timeOfDay: 'night',

  // Score / progress
  kills: 0,
  coins: 0,
  killStreak: 0,
  spawnedTotal: 0,
  spawnTimer: 1.2,

  // Player state
  playerHealth: 100,
  playerMaxHealth: 100,
  playerStamina: 100,
  isDead: false,
  paused: false,
  walkCycle: 0,
  footTimer: 0,
  crouching: false,
  isSprinting: false,
  playerMoving: false,
  playerFacingAngle: 0,
  playerActionLock: 0,
  meleeTimer: 0,
  bobPhase: 0,
  sprintToggle: false,
  lastWTapTime: 0,
  playerScaleOverride: 0.5, // was 0.55 — measured "a little too big" now that
                            // ground-clamping actually works (previously this
                            // number was being judged against a floating,
                            // wrongly-modeled character, so it wasn't a
                            // reliable data point). Still live-adjustable
                            // with [ / ] against the debug readout's meters
                            // display.
  playerBaseScale: 1,
  playerCurrentHeight: 0,

  // Weapon / combat state
  currentWeapon: 'gun', // 'gun' | 'knife'
  ammoMag: 30,
  ammoReserve: 90,
  reloading: false,
  reloadTimer: 0,
  fireCooldown: 0,
  gunGripIndex: 0,

  // Input state
  keys: {},
  pointerLocked: false,
  yaw: 0,
  pitch: -0.08,
  recoilPitch: 0,
  firstPerson: false,

  // Vehicle state
  inVehicle: false,
  carSteer: 0,
  carThrottle: 0,
  rolloverTimer: 0,
  carFuel: 100, // topped up to CAR_MAX_FUEL in characters.js

  // Shield state
  shieldActive: false,
  shieldTimer: 0,
  shieldDuration: 15,
  shieldRadius: 0, // set fresh each activation (PowerUps.js) — also used by
                    // characters.js to keep zombies from walking through it

  // Misc scene feel
  shake: 0,

  // Collections shared across modules (mutated in place — push/splice —
  // never reassigned, so importing modules always see the live contents)
  zombies: [],
  obstacles: [], // {x, z, r} for zombie avoidance
  occluders: [], // meshes the third-person camera raycasts against
  pickups: [], // {mesh, type, life}
  powerups: [], // {mesh, type, life}
  coinPickups: [], // {mesh, life}
  explosiveBarrels: [],
  activeExplosions: [],
  activeSparks: [],
  activeTracers: [],
  smokeGroups: [],

  // Asset loading progress
  loadFlags: { player: false, zombie: false, car: false },
  readyShown: false,
};