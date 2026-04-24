// UI: visibility panel, overlay, telegraph label.

const LABELS = { light: 'LIGHT', heavy: 'HEAVY', dodge: 'DODGE', block: 'BLOCK' };
const BOSS_LABELS = { slash: 'SLASH', slam: 'SLAM', charge: 'CHARGE', aoe: 'AOE' };
const SHORT = { light: 'L', heavy: 'H', dodge: 'D', block: 'B' };

export function createUI(dom, logger = null) {
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
    refreshMetrics(brain);
    refreshSide(brain);
  }

  function refreshSide(brain) {
    if (!dom.sideMarker || !brain.sideBias) return;
    const s = brain.sideBias();
    // leftBias 0..1 → marker position 0%..100% left-to-right on the bar.
    // leftBias=1 (always left) → marker at 0%. Right => 100%.
    const markerPct = (1 - s.leftBias) * 100;
    dom.sideMarker.style.left = markerPct + '%';
    const absLead = Math.abs(s.lead);
    let lbl = 'balanced';
    if (s.confidence < 0.3) lbl = 'learning…';
    else if (absLead >= 0.5) lbl = s.lead < 0 ? 'favors ◀ LEFT' : 'favors RIGHT ▶';
    else if (absLead >= 0.2) lbl = s.lead < 0 ? 'leans left' : 'leans right';
    dom.sideLabel.textContent = lbl;
    dom.sideLead.textContent = (s.leftBias * 100).toFixed(0) + '%L / ' + ((1 - s.leftBias) * 100).toFixed(0) + '%R';
    // Color: tinted accent if biased, muted if balanced or low-confidence
    if (s.confidence < 0.3) dom.sideMarker.style.background = 'var(--muted)';
    else if (s.lead < -0.3) dom.sideMarker.style.background = 'var(--blue)';
    else if (s.lead > 0.3) dom.sideMarker.style.background = 'var(--danger)';
    else dom.sideMarker.style.background = 'var(--accent)';
  }

  function refreshMetrics(brain) {
    const m = brain.metrics();
    setMetric(dom.metAcc, m.accuracy, m.total);
    setMetric(dom.metPrec, m.precision, m.total);
    setMetric(dom.metRec, m.recall, m.total);
    setMetric(dom.metF1, m.f1, m.total);
  }

  function setMetric(el, value, total) {
    if (!el) return;
    if (total < 3) {
      el.textContent = '—';
      el.className = 'low';
      return;
    }
    el.textContent = (value * 100).toFixed(1) + '%';
    el.className = value >= 0.5 ? 'high' : value >= 0.3 ? 'mid' : 'low';
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
    logger?.playerAction(type, brain);
    pushHistory(type);
    refreshBars(brain);
  }

  function onBossAction(pick) {
    const label = dom.telegraphLabel;
    let text;
    if (pick.reason === 'enrage') {
      text = '▲ ENRAGED — 25% HP';
    } else {
      const playerPredicted = pick.predicted ? LABELS[pick.predicted] : '—';
      const bossMoveName = BOSS_LABELS[pick.action] || pick.action.toUpperCase();
      text = pick.reason === 'counter'
        ? `COUNTERING ${playerPredicted} → ${bossMoveName}`
        : `${bossMoveName}`;
    }
    label.textContent = text;
    label.classList.add('show');
    clearTimeout(label._hideTimer);
    label._hideTimer = setTimeout(() => label.classList.remove('show'),
      pick.reason === 'enrage' ? 1400 : 750);
    logger?.bossAction(pick);
  }

  function onGameOver(won, state, brain) {
    dom.statDeaths.textContent = state.deaths;
    dom.overlayTitle.textContent = won ? 'VICTORY' : 'Try again you MIGHT win LOOOLLL. LOSER';
    dom.overlayTitle.className = won ? 'win' : 'loss';
    dom.overlaySub.textContent = won
      ? `Troll beats DOT — Blade of Ali. DOT keeps its memory. Next fight it hunts you harder.`
      : `DOT — Blade of Ali learned Troll's patterns. Break rhythm. Mix moves. It's watching.`;
    dom.overlay.classList.remove('hidden');
    if (brain) logger?.gameOver(won, state, brain);
  }

  function hideOverlay() {
    dom.overlay.classList.add('hidden');
  }

  function hookReset(fn) {
    onReset = fn;
    dom.overlayBtn.addEventListener('click', () => {
      dom.overlayBtn.blur();
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
