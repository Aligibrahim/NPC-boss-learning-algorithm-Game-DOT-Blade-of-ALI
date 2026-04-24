// UI: visibility panel, overlay, telegraph label.

const LABELS = { light: 'LIGHT', heavy: 'HEAVY', dodge: 'DODGE', block: 'BLOCK' };
const BOSS_LABELS = { slash: 'SLASH', slam: 'SLAM', charge: 'CHARGE', aoe: 'AOE' };
const SHORT = { light: 'L', heavy: 'H', dodge: 'D', block: 'B' };

export function createUI(dom) {
  let history = [];
  let onReset = () => {};

  function refreshBars(brain) {
    const dist = brain.currentDist();
    const keys = ['light', 'heavy', 'dodge', 'block'];
    keys.forEach(k => {
      const pct = Math.round(dist[k] * 100);
      dom['bar-' + k].style.width = pct + '%';
      dom['val-' + k].textContent = pct + '%';
    });
    dom.predictAction.textContent = LABELS[brain.predict()];
    dom.statAlpha.textContent = brain.alpha.toFixed(2);
    dom.statObs.textContent = brain.observations;
  }

  function pushHistory(action) {
    history = [...history, action].slice(-5);
    dom.historyList.innerHTML = '';
    for (const a of history) {
      const chip = document.createElement('div');
      chip.className = `move-chip ${SHORT[a]}`;
      chip.textContent = SHORT[a];
      dom.historyList.appendChild(chip);
    }
  }

  function onPlayerAction(type, brain) {
    pushHistory(type);
    refreshBars(brain);
  }

  function onBossAction(pick) {
    const label = dom.telegraphLabel;
    const playerPredicted = pick.predicted ? LABELS[pick.predicted] : '—';
    const bossMoveName = BOSS_LABELS[pick.action] || pick.action.toUpperCase();
    label.textContent = pick.reason === 'counter'
      ? `COUNTERING ${playerPredicted} → ${bossMoveName}`
      : `${bossMoveName}`;
    label.classList.add('show');
    clearTimeout(label._hideTimer);
    label._hideTimer = setTimeout(() => label.classList.remove('show'), 750);
  }

  function onGameOver(won, state) {
    dom.statDeaths.textContent = state.deaths;
    dom.overlayTitle.textContent = won ? 'VICTORY' : 'DEFEATED';
    dom.overlayTitle.className = won ? 'win' : 'loss';
    dom.overlaySub.textContent = won
      ? `You beat it. The boss keeps its memory — next fight it hunts you harder.`
      : `The boss learned your patterns. Break rhythm. Mix moves. It's watching.`;
    dom.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    dom.overlay.classList.add('hidden');
  }

  function hookReset(fn) {
    onReset = fn;
    dom.overlayBtn.addEventListener('click', () => {
      hideOverlay();
      onReset();
    });
  }

  function resetHistoryDisplay() {
    history = [];
    dom.historyList.innerHTML = '';
  }

  return {
    onPlayerAction,
    onBossAction,
    onGameOver,
    hideOverlay,
    hookReset,
    refreshBars,
    resetHistoryDisplay,
  };
}
