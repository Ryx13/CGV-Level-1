// Level1.js — LEVEL 1 ENTRY POINT
//
// Level 1, Level 2, and Level 3 all currently load the exact same base
// scene (per the refactor request: "do not create three completely
// different scene systems... Level 1, Level 2, and Level 3 should all
// use the same base scene. Later, I will modify each level individually").
// This file is intentionally thin — it's the place future level-specific
// settings/gameplay changes for Level 1 will go, without touching the
// shared Scene/characters/Actions/PowerUps systems.
import './Scene.js';
import './characters.js';
import './PowerUps.js';
import './shaders.js';
import { bootLevel } from './Actions.js';

const LEVEL_CONFIG = {
  id: 1,
  name: 'Level 1',
};

export function startLevel(mode) {
  bootLevel({ ...LEVEL_CONFIG, mode });
}
