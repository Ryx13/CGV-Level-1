// Level2.js — LEVEL 2 ENTRY POINT
//
// Level 1, Level 2, and Level 3 all currently load the exact same base
// scene (per the refactor request: "do not create three completely
// different scene systems... Level 1, Level 2, and Level 3 should all
// use the same base scene. Later, I will modify each level individually").
// This file is intentionally thin — it's the place future level-specific
// settings/gameplay changes for Level 2 will go, without touching the
// shared Scene/characters/Actions/PowerUps systems.
import './Scene.js';
import './characters.js';
import './PowerUps.js';
import './shaders.js';
import { bootLevel } from './Actions.js';

const LEVEL_CONFIG = {
  id: 2,
  name: 'Level 2',
};

export function startLevel() {
  bootLevel(LEVEL_CONFIG);
}
