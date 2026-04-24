// Entry point: wires DOM, brain, game, UI, and input.

import { createBrain } from './brain.js';
import { createGame } from './game.js';
import { createUI } from './ui.js';
import { createLogger } from './logger.js';

const canvas = document.getElementById('arena');
const dom = {
  predictAction: document.getElementById('predict-action'),
  'bar-light': document.getElementById('bar-light'),
  'bar-heavy': document.getElementById('bar-heavy'),
  'bar-dodge': document.getElementById('bar-dodge'),
  'bar-block': document.getElementById('bar-block'),
  'val-light': document.getElementById('val-light'),
  'val-heavy': document.getElementById('val-heavy'),
  'val-dodge': document.getElementById('val-dodge'),
  'val-block': document.getElementById('val-block'),
  historyList: document.getElementById('history-list'),
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
  telegraphLabel: document.getElementById('telegraph-label'),
};

const audio = createAudio();

const logger = createLogger();
logger.sessionStart();

const brain = createBrain();
const ui = createUI(dom, logger);
const game = createGame(canvas, brain, ui, audio);

ui.refreshBars(brain);
ui.hookReset(() => {
  logger.resetMark('fight again');
  game.resetArena(true);
  ui.resetHistoryDisplay();
});

// --- Keyboard ---
const keys = { w: false, a: false, s: false, d: false };

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') keys[k] = true;
  else if (k === 'arrowup') keys.w = true;
  else if (k === 'arrowdown') keys.s = true;
  else if (k === 'arrowleft') keys.a = true;
  else if (k === 'arrowright') keys.d = true;

  if (k === ' ') { e.preventDefault(); game.triggerPlayerAction('dodge'); }
  else if (k === 'f') game.triggerPlayerAction('block');
  else if (k === 'b') console.log('[BRAIN]', brain.dump());
  else if (k === 'r') {
    logger.resetMark('R key — brain wiped');
    game.resetArena(false);
    ui.resetHistoryDisplay();
    ui.refreshBars(brain);
    ui.hideOverlay();
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') keys[k] = false;
  else if (k === 'arrowup') keys.w = false;
  else if (k === 'arrowdown') keys.s = false;
  else if (k === 'arrowleft') keys.a = false;
  else if (k === 'arrowright') keys.d = false;
  else if (k === 'f') game.endBlock();
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    e.preventDefault();
    game.triggerPlayerAction('light');
  } else if (e.button === 2) {
    e.preventDefault();
    game.triggerPlayerAction('heavy');
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
  if (action === 'block') {
    btn.addEventListener('pointerup', () => game.endBlock());
    btn.addEventListener('pointercancel', () => game.endBlock());
    btn.addEventListener('pointerleave', () => game.endBlock());
  }
});

const panelToggle = document.getElementById('panel-toggle');
const panel = document.getElementById('brain-panel');
panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
});

// --- Main loop ---
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let vx = 0, vy = 0;
  if (keys.a) vx -= 1;
  if (keys.d) vx += 1;
  if (keys.w) vy -= 1;
  if (keys.s) vy += 1;
  if (touchState.active) {
    vx += touchState.dx;
    vy += touchState.dy;
  }
  game.setMoveInput(vx, vy);

  game.tick(dt);
  game.render();

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

window.__brain = brain;
window.__game = game;
