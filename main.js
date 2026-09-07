// main.js — ENTRY POINT
//
// Runs before any of Scene/characters/Actions/PowerUps are ever loaded,
// so it's responsible for two things those files used to handle: (1)
// setting the intro screen's splash background — Scene.js used to do
// this at its own top level, but Scene.js now only loads once a level
// is picked, well after the intro screen has already been shown — and
// (2) advancing from the intro screen to the level-select screen, then
// the level-select screen to the new mode-select screen (Day/Night).
// Level selection itself dynamically imports only the chosen level's
// module, rather than eagerly loading all three (and therefore all of
// Scene/characters/Actions/PowerUps/shaders) up front. It also drives
// the single reusable loading screen: shown the instant a mode is
// chosen, hidden again once that level's player+zombie assets are ready
// (Scene.js's maybeReady(), unchanged in spirit, handles the hide/reveal
// and hands off to Actions.js's onAssetsReady() callback for the rest).

const introScreen = document.getElementById('start-screen');
if (introScreen) introScreen.style.backgroundImage = "url('assets/splash1.jpg')";

const LEVEL_LOADERS = {
  1: () => import('./Level1.js'),
  2: () => import('./Level2.js'),
  3: () => import('./Level3.js'),
};

function initIntroScreen() {
  const enterBtn = document.getElementById('enter-btn');
  const levelSelect = document.getElementById('level-select');
  if (!enterBtn || !introScreen || !levelSelect) return;
  enterBtn.addEventListener('click', () => {
    introScreen.classList.add('hidden');
    levelSelect.classList.remove('hidden');
  });
}

// LEVEL SELECT — now just picks which level and hands off to the new
// mode-select screen, rather than loading the level directly.
function initLevelSelect() {
  const levelSelect = document.getElementById('level-select');
  const modeSelect = document.getElementById('mode-select');
  const buttons = document.querySelectorAll('#level-select [data-level]');
  if (!levelSelect || !modeSelect) return;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const levelId = btn.getAttribute('data-level');
      if (!LEVEL_LOADERS[levelId]) {
        console.error(`No level module registered for id "${levelId}"`);
        return;
      }
      levelSelect.classList.add('hidden');
      modeSelect.classList.remove('hidden');
      modeSelect.dataset.pendingLevel = levelId;
    });
  });
}

// MODE SELECT — Day / Night, shown right after a level is chosen. Only
// once a mode is picked here does the level module actually load.
function initModeSelect() {
  const modeSelect = document.getElementById('mode-select');
  const loading = document.getElementById('loading');
  const buttons = document.querySelectorAll('#mode-select [data-mode]');
  if (!modeSelect) return;

  let modeChosen = false;

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (modeChosen) return; // ignore double-clicks / double-selection
      modeChosen = true;

      const levelId = modeSelect.dataset.pendingLevel;
      const mode = btn.getAttribute('data-mode');
      const loadLevel = LEVEL_LOADERS[levelId];
      if (!loadLevel) {
        console.error(`No level module registered for id "${levelId}"`);
        modeChosen = false;
        return;
      }

      modeSelect.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');

      try {
        const levelModule = await loadLevel();
        levelModule.startLevel(mode);
      } catch (err) {
        console.error(`Level ${levelId} failed to load:`, err);
        if (loading) {
          const status = document.getElementById('load-status');
          if (status) status.textContent = 'FAILED TO LOAD — see console';
        }
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initIntroScreen();
    initLevelSelect();
    initModeSelect();
  });
} else {
  initIntroScreen();
  initLevelSelect();
  initModeSelect();
}
