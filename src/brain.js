// Adaptive boss brain.
// Tracks a frequency table: last-3-player-actions -> distribution over next action.
// Updates via EMA with learning rate alpha. Picks a counter action the player
// is statistically weak to, softened by exploration and a confidence cap.

export const ACTIONS = ['light', 'heavy', 'dodge', 'parry'];
export const BOSS_ACTIONS = ['slash', 'slam', 'charge', 'aoe'];

// If the player is likely to do X, boss plays Y.
export const COUNTERS = {
  light: 'slash',
  heavy: 'charge',
  dodge: 'aoe',
  parry: 'slam',
};

const UNIFORM = () => ({ light: 0.25, heavy: 0.25, dodge: 0.25, parry: 0.25 });

export function createBrain(opts = {}) {
  const alpha = opts.alpha ?? 0.15;
  const explore = opts.explore ?? 0.15;
  const cap = opts.cap ?? 0.70;
  const decay = opts.decay ?? 0.0004;

  const table = new Map();
  let history = [];
  let observations = 0;

  // Confusion matrix: confusion[predicted][actual] = count.
  // Built live as the game is played so we can report accuracy / precision / recall / F1.
  const confusion = {};
  for (const p of ACTIONS) confusion[p] = { light: 0, heavy: 0, dodge: 0, parry: 0 };

  // Spatial learning — EMA of "player is on the left half of the arena" probability.
  // 0.5 = no bias. Updated on every observation using the normalized playerX
  // passed in by the caller. The boss uses sideBias() to lead charges/AOE locks
  // toward the side you favor.
  const SIDE_ALPHA = opts.sideAlpha ?? 0.08;
  let leftBias = 0.5;
  let sideSamples = 0;

  function key(h) {
    const padded = ['_', '_', '_', ...h].slice(-3);
    return padded.join('|');
  }

  function getDist(k) {
    if (!table.has(k)) table.set(k, UNIFORM());
    return table.get(k);
  }

  function decayAll() {
    for (const dist of table.values()) {
      for (const a of ACTIONS) {
        dist[a] = dist[a] + decay * (0.25 - dist[a]);
      }
    }
  }

  function observe(playerAction, playerXPct) {
    // Record the prediction BEFORE we update — this is what the model thought
    // the player was about to do, now compared to what they actually did.
    const predicted = predict();
    confusion[predicted][playerAction]++;

    // Spatial EMA: where on the arena did the player act?
    if (typeof playerXPct === 'number' && isFinite(playerXPct)) {
      const onLeft = playerXPct < 0.5 ? 1 : 0;
      leftBias = leftBias + SIDE_ALPHA * (onLeft - leftBias);
      sideSamples++;
    }

    observations++;
    if (history.length === 3) {
      const k = key(history);
      const dist = getDist(k);
      for (const a of ACTIONS) {
        const target = a === playerAction ? 1 : 0;
        dist[a] = dist[a] + alpha * (target - dist[a]);
      }
      const maxA = ACTIONS.reduce((m, a) => (dist[a] > dist[m] ? a : m), 'light');
      if (dist[maxA] > cap) {
        const excess = dist[maxA] - cap;
        dist[maxA] = cap;
        for (const a of ACTIONS) if (a !== maxA) dist[a] += excess / 3;
      }
    }

    history = [...history, playerAction].slice(-3);
    decayAll();
  }

  function currentDist() {
    return { ...getDist(key(history)) };
  }

  function predict() {
    const dist = currentDist();
    return ACTIONS.reduce((m, a) => (dist[a] > dist[m] ? a : m), 'light');
  }

  function pick() {
    if (Math.random() < explore) {
      const idx = Math.floor(Math.random() * BOSS_ACTIONS.length);
      return { action: BOSS_ACTIONS[idx], reason: 'explore', predicted: predict() };
    }
    const predicted = predict();
    return { action: COUNTERS[predicted], reason: 'counter', predicted };
  }

  function dump() {
    const snap = {};
    for (const [k, v] of table.entries()) snap[k] = { ...v };
    return {
      alpha, explore, cap, decay,
      observations,
      history: [...history],
      currentDist: currentDist(),
      table: snap,
      metrics: metrics(),
      sideBias: sideBias(),
    };
  }

  function reset() {
    table.clear();
    history = [];
    observations = 0;
    for (const p of ACTIONS) confusion[p] = { light: 0, heavy: 0, dodge: 0, parry: 0 };
    leftBias = 0.5;
    sideSamples = 0;
  }

  // Spatial bias snapshot.
  //   lead ∈ [-1, 1] — negative = player favors LEFT (boss should aim left)
  //                    positive = player favors RIGHT
  //   strength ∈ [0, 1] — how off-center the belief is (0 = balanced, 1 = one-sided)
  //   confidence ∈ [0, 1] — ramps up with sample count; weak early, trusted later.
  function sideBias() {
    const lead = (0.5 - leftBias) * 2;
    const strength = Math.abs(lead);
    const confidence = Math.min(1, sideSamples / 10);
    return { leftBias, rightBias: 1 - leftBias, lead, strength, confidence, samples: sideSamples };
  }

  // Classification metrics (macro-averaged over the 4 action classes).
  // Baseline for a 4-class balanced problem is ~0.25 accuracy, so anything
  // materially above that means the model has learned something.
  function metrics() {
    let total = 0, correct = 0;
    for (const p of ACTIONS) {
      for (const a of ACTIONS) {
        total += confusion[p][a];
        if (p === a) correct += confusion[p][a];
      }
    }
    const perClass = { precision: {}, recall: {}, f1: {} };
    for (const c of ACTIONS) {
      const predictedAsC = ACTIONS.reduce((s, a) => s + confusion[c][a], 0);
      const actuallyC = ACTIONS.reduce((s, p) => s + confusion[p][c], 0);
      const tp = confusion[c][c];
      const prec = predictedAsC > 0 ? tp / predictedAsC : 0;
      const rec = actuallyC > 0 ? tp / actuallyC : 0;
      const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
      perClass.precision[c] = prec;
      perClass.recall[c] = rec;
      perClass.f1[c] = f1;
    }
    const macro = (obj) => ACTIONS.reduce((s, c) => s + obj[c], 0) / ACTIONS.length;
    return {
      total,
      accuracy: total > 0 ? correct / total : 0,
      precision: macro(perClass.precision),
      recall: macro(perClass.recall),
      f1: macro(perClass.f1),
      perClass,
      confusion: structuredClone(confusion),
    };
  }

  return {
    observe, predict, pick, currentDist, dump, reset, metrics, sideBias,
    get alpha() { return alpha; },
    get observations() { return observations; },
    get history() { return [...history]; },
  };
}
