// Adaptive boss brain.
// Tracks a frequency table: last-3-player-actions -> distribution over next action.
// Updates via EMA with learning rate alpha. Picks a counter action the player
// is statistically weak to, softened by exploration and a confidence cap.

export const ACTIONS = ['light', 'heavy', 'dodge', 'block'];
export const BOSS_ACTIONS = ['slash', 'slam', 'charge', 'aoe'];

// If the player is likely to do X, boss plays Y.
export const COUNTERS = {
  light: 'slash',
  heavy: 'charge',
  dodge: 'aoe',
  block: 'slam',
};

const UNIFORM = () => ({ light: 0.25, heavy: 0.25, dodge: 0.25, block: 0.25 });

export function createBrain(opts = {}) {
  const alpha = opts.alpha ?? 0.15;
  const explore = opts.explore ?? 0.15;
  const cap = opts.cap ?? 0.70;
  const decay = opts.decay ?? 0.0004;

  const table = new Map();
  let history = [];
  let observations = 0;

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

  function observe(playerAction) {
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
    };
  }

  function reset() {
    table.clear();
    history = [];
    observations = 0;
  }

  return {
    observe, predict, pick, currentDist, dump, reset,
    get alpha() { return alpha; },
    get observations() { return observations; },
    get history() { return [...history]; },
  };
}
