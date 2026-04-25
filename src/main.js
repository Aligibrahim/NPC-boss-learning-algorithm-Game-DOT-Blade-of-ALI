// Entry point: wires DOM, brain, game, UI, and input.

import { createBrain } from './brain.js';
import { createGame } from './game.js';
import { createUI } from './ui.js';
import { createLogger } from './logger.js';
import { loadSprites } from './sprites.js';

const canvas = document.getElementById('arena');
const LEARNING_MODES = {
  slow: {
    label: 'Slow Learner',
    alpha: 0.07,
    description: 'DOT learns gradually, so repeated habits take longer to punish.',
  },
  fast: {
    label: 'Fast Learner',
    alpha: 0.30,
    description: 'DOT updates quickly, so repeated habits get countered sooner.',
  },
};

const dom = {
  predictAction: document.getElementById('predict-action'),
  'bar-light': document.getElementById('bar-light'),
  'bar-heavy': document.getElementById('bar-heavy'),
  'bar-dodge': document.getElementById('bar-dodge'),
  'bar-parry': document.getElementById('bar-parry'),
  'val-light': document.getElementById('val-light'),
  'val-heavy': document.getElementById('val-heavy'),
  'val-dodge': document.getElementById('val-dodge'),
  'val-parry': document.getElementById('val-parry'),
  historyList: document.getElementById('history-list'),
  statMode: document.getElementById('stat-mode'),
  statAlpha: document.getElementById('stat-alpha'),
  statObs: document.getElementById('stat-obs'),
  statDeaths: document.getElementById('stat-deaths'),
  metAcc: document.getElementById('met-acc'),
  metPrec: document.getElementById('met-prec'),
  metRec: document.getElementById('met-rec'),
  metF1: document.getElementById('met-f1'),
  sideMarker: document.getElementById('side-marker'),
  sideLabel: document.getElementById('side-label'),
  sideLead: document.getElementById('side-lead'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlaySub: document.getElementById('overlay-sub'),
  overlayBtn: document.getElementById('overlay-btn'),
  modePicker: document.getElementById('mode-picker'),
  modeCopy: document.getElementById('mode-copy'),
  modeButtons: document.querySelectorAll('.mode-btn'),
  telegraphLabel: document.getElementById('telegraph-label'),
  pauseBtn: document.getElementById('pause-btn'),
  pauseOverlay: document.getElementById('pause-overlay'),
  resumeBtn: document.getElementById('resume-btn'),
};

const audio = createAudio();

const logger = createLogger();
logger.sessionStart();

let currentModeId = 'slow';
let waitingForMode = true;
let manualPaused = false;
let tabPaused = false;
let brain = createBrain({ alpha: LEARNING_MODES[currentModeId].alpha });
const ui = createUI(dom, logger);
const sprites = await loadSprites();
let game = createGame(canvas, brain, ui, audio, sprites);

syncModeDisplay();
ui.refreshBars(brain);
ui.hookReset(() => {
  logger.resetMark('fight again');
  game.resetArena(true);
  ui.resetHistoryDisplay();
  syncPausedState();
});

showModePicker();

dom.modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectMode(btn.dataset.mode);
  });
});

dom.pauseBtn.addEventListener('click', () => togglePause());
dom.resumeBtn.addEventListener('click', () => setManualPause(false));

function selectMode(modeId) {
  const mode = LEARNING_MODES[modeId] ?? LEARNING_MODES.slow;
  currentModeId = LEARNING_MODES[modeId] ? modeId : 'slow';
  brain = createBrain({ alpha: mode.alpha });
  game = createGame(canvas, brain, ui, audio, sprites);
  window.__brain = brain;
  window.__game = game;
  waitingForMode = false;
  manualPaused = false;
  ui.resetHistoryDisplay();
  ui.refreshBars(brain);
  syncModeDisplay();
  ui.hideOverlay();
  syncPausedState();
  logger.resetMark(`${mode.label} selected`);
}

function showModePicker() {
  waitingForMode = true;
  manualPaused = false;
  dom.overlayTitle.textContent = 'CHOOSE BOSS BRAIN';
  dom.overlayTitle.className = '';
  dom.overlaySub.textContent = 'Pick how fast DOT learns from your repeated moves.';
  dom.modePicker.classList.remove('hidden');
  dom.modeCopy.classList.remove('hidden');
  dom.overlayBtn.classList.add('hidden');
  dom.overlay.classList.remove('hidden');
  syncPausedState();
}

function syncModeDisplay() {
  const mode = LEARNING_MODES[currentModeId];
  if (dom.statMode) dom.statMode.textContent = mode.label;
  dom.modeButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === currentModeId);
    const modeForButton = LEARNING_MODES[btn.dataset.mode];
    if (modeForButton) {
      btn.setAttribute('title', `${modeForButton.description} alpha=${modeForButton.alpha}`);
    }
  });
}

function setManualPause(paused) {
  if (waitingForMode || game.state.over) return;
  manualPaused = paused;
  syncPausedState();
}

function togglePause() {
  setManualPause(!manualPaused);
}

function syncPausedState() {
  game.state.paused = waitingForMode || manualPaused || tabPaused;
  const showManualPause = manualPaused && !waitingForMode && !game.state.over;
  dom.pauseOverlay.classList.toggle('hidden', !showManualPause);
  dom.pauseBtn.textContent = manualPaused ? 'Resume' : 'Pause';
  dom.pauseBtn.disabled = waitingForMode || game.state.over;
}

function canApplyGameplayInput() {
  return !waitingForMode && !game.state.paused && !game.state.over;
}

// --- Keyboard ---
const keys = { a: false, d: false, s: false };

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft') {
    if (canApplyGameplayInput()) keys.a = true;
  }
  else if (k === 'd' || k === 'arrowright') {
    if (canApplyGameplayInput()) keys.d = true;
  }
  else if (k === 's' || k === 'arrowdown') {
    if (canApplyGameplayInput()) {
      keys.s = true;
      game.setBlock(true);
    }
  }
  else if (k === 'w' || k === 'arrowup') { e.preventDefault(); game.triggerPlayerAction('jump'); }
  else if (k === ' ') { e.preventDefault(); game.triggerPlayerAction('dodge'); }
  else if (k === 'e') game.triggerPlayerAction('parry');
  else if (k === 'p' || k === 'escape') { e.preventDefault(); togglePause(); }
  else if (k === 'b') console.log('[BRAIN]', brain.dump());
  else if (k === 'r') {
    if (waitingForMode) {
      showModePicker();
      return;
    }
    logger.resetMark('R key — brain wiped');
    game.resetArena(false);
    ui.resetHistoryDisplay();
    ui.refreshBars(brain);
    ui.hideOverlay();
    manualPaused = false;
    syncPausedState();
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft')  keys.a = false;
  else if (k === 'd' || k === 'arrowright') keys.d = false;
  else if (k === 's' || k === 'arrowdown') {
    keys.s = false;
    if (canApplyGameplayInput()) game.setBlock(false);
  }
});

// MK-style: LMB = heavy, RMB = light.
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    e.preventDefault();
    game.triggerPlayerAction('heavy');
  } else if (e.button === 2) {
    e.preventDefault();
    game.triggerPlayerAction('light');
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Touch joystick & buttons ---
const joystick = document.getElementById('joystick');
const knob = document.getElementById('joystick-knob');
const touchState = { active: false, baseX: 0, baseY: 0, pointerId: null, dx: 0, dy: 0 };
const JOY_RADIUS = 46;

joystick.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  joystick.setPointerCapture(e.pointerId);
  const rect = joystick.getBoundingClientRect();
  touchState.active = true;
  touchState.baseX = rect.left + rect.width / 2;
  touchState.baseY = rect.top + rect.height / 2;
  touchState.pointerId = e.pointerId;
  updateJoy(e.clientX, e.clientY);
});
joystick.addEventListener('pointermove', (e) => {
  if (!touchState.active || e.pointerId !== touchState.pointerId) return;
  updateJoy(e.clientX, e.clientY);
});
function endJoy() {
  touchState.active = false;
  touchState.dx = 0; touchState.dy = 0;
  knob.style.transform = 'translate(0, 0)';
}
joystick.addEventListener('pointerup', endJoy);
joystick.addEventListener('pointercancel', endJoy);
joystick.addEventListener('pointerleave', endJoy);

function updateJoy(cx, cy) {
  let dx = cx - touchState.baseX;
  let dy = cy - touchState.baseY;
  const d = Math.hypot(dx, dy);
  if (d > JOY_RADIUS) { dx = dx / d * JOY_RADIUS; dy = dy / d * JOY_RADIUS; }
  touchState.dx = dx / JOY_RADIUS;
  touchState.dy = dy / JOY_RADIUS;
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
}

document.querySelectorAll('.act-btn').forEach(btn => {
  const action = btn.getAttribute('data-action');
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    game.triggerPlayerAction(action);
  });
});

const panelToggle = document.getElementById('panel-toggle');
const panel = document.getElementById('brain-panel');
panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
});

// --- Main loop ---
let last = performance.now();
const fpsEl = document.getElementById('fps-counter');
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const acceptingGameplayInput = canApplyGameplayInput();
  let dir = 0;
  if (acceptingGameplayInput) {
    if (keys.a) dir -= 1;
    if (keys.d) dir += 1;
    if (touchState.active) dir += touchState.dx;
    // Joystick up = jump trigger (rising edge).
    if (touchState.active && touchState.dy < -0.6 && !touchState.jumpedThisStroke) {
      touchState.jumpedThisStroke = true;
      game.triggerPlayerAction('jump');
    } else if (!touchState.active) {
      touchState.jumpedThisStroke = false;
    }
    game.setBlock(keys.s);
  } else {
    touchState.jumpedThisStroke = false;
  }
  game.setMoveInput(dir);

  game.tick(dt);
  game.render(now);
  if (game.state.over && (manualPaused || !dom.pauseBtn.disabled)) {
    manualPaused = false;
    syncPausedState();
  }

  if (fpsEl && game.state.fps) {
    fpsEl.textContent = game.state.fps + ' FPS';
    fpsEl.className = game.state.fps < 40 ? 'crit' : game.state.fps < 55 ? 'low' : '';
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- Tiny Web Audio helper (no files) ---
function createAudio() {
  let ctx = null;
  function ensure() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  window.addEventListener('pointerdown', ensure, { once: true });
  window.addEventListener('keydown', ensure, { once: true });

  return {
    beep(freq, dur, type = 'square', gain = 0.1) {
      const c = ensure();
      if (!c) return;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g).connect(c.destination);
      const t0 = c.currentTime;
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    },
  };
}

// Pause on tab hide so we don't burn cycles offscreen.
document.addEventListener('visibilitychange', () => {
  tabPaused = document.hidden;
  syncPausedState();
  // Reset the dt clock when coming back so we don't get a giant catch-up step.
  if (!document.hidden) last = performance.now();
});

window.__brain = brain;
window.__game = game;
