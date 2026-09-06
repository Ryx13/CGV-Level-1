// main.js — ENTRY POINT
//
// Runs before any of Scene/characters/Actions/PowerUps are ever loaded,
// so it's responsible for two things those files used to handle: (1)
// setting the intro screen's splash background — Scene.js used to do
// this at its own top level, but Scene.js now only loads once a level
// is picked, well after the intro screen has already been shown — and
// (2) advancing from the intro screen to the level-select screen.
// Level selection itself dynamically imports only the chosen level's
// module, rather than eagerly loading all three (and therefore all of
// Scene/characters/Actions/PowerUps/shaders) up front. It also drives
// the single reusable loading screen: shown the instant a level is
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

function initLevelSelect() {
  const levelSelect = document.getElementById('level-select');
  const loading = document.getElementById('loading');
  const buttons = document.querySelectorAll('#level-select [data-level]');

  let levelChosen = false;

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (levelChosen) return; // ignore double-clicks / double-selection
      levelChosen = true;

      const levelId = btn.getAttribute('data-level');
      const loadLevel = LEVEL_LOADERS[levelId];
      if (!loadLevel) {
        console.error(`No level module registered for id "${levelId}"`);
        levelChosen = false;
        return;
      }

      if (levelSelect) levelSelect.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');

      try {
        const levelModule = await loadLevel();
        levelModule.startLevel();
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
  });
} else {
  initIntroScreen();
  initLevelSelect();
}
