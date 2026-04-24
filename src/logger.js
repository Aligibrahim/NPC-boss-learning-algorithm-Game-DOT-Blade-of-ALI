// Per-event logger that POSTs to the Vite dev server plugin,
// which appends to session-log.txt on disk.

export function createLogger() {
  const startTime = performance.now();
  let buf = [];
  let flushTimer = null;

  function elapsed() {
    const s = (performance.now() - startTime) / 1000;
    return s.toFixed(2).padStart(6, ' ') + 's';
  }

  function pad(s, n) { return String(s).padEnd(n, ' '); }

  async function flush() {
    flushTimer = null;
    if (buf.length === 0) return;
    const batch = buf.join('\n');
    buf = [];
    try {
      await fetch('/log', { method: 'POST', body: batch });
    } catch {
      // dev server not running — silently drop
    }
  }

  function enqueue(line) {
    buf.push(line);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  }

  function playerAction(action, brain) {
    const predicted = brain.predict();
    const dist = brain.currentDist();
    const m = brain.metrics();
    const correct = predicted === action ? '✓' : '✗';
    const distStr =
      `L${Math.round(dist.light * 100)}/` +
      `H${Math.round(dist.heavy * 100)}/` +
      `D${Math.round(dist.dodge * 100)}/` +
      `B${Math.round(dist.block * 100)}`;
    const metricStr = m.total >= 3
      ? `acc=${(m.accuracy * 100).toFixed(1).padStart(5)}% f1=${(m.f1 * 100).toFixed(1).padStart(5)}%`
      : `acc=   —   f1=   —  `;
    const s = brain.sideBias ? brain.sideBias() : null;
    const sideStr = s
      ? `side=L${Math.round(s.leftBias * 100)}/R${Math.round((1 - s.leftBias) * 100)} lead=${s.lead.toFixed(2)}`
      : '';
    enqueue(
      `${elapsed()}  PLAYER  ${pad(action, 6)} predicted=${pad(predicted, 6)} ${correct}  ` +
      `dist=[${distStr}]  ${metricStr}  obs=${brain.observations}  ${sideStr}`
    );
  }

  function bossAction(pick) {
    if (pick.reason === 'enrage') {
      enqueue(`${elapsed()}  BOSS    ENRAGE  ≤25% HP — tracker speed doubled, delayed AOE unlocked`);
      return;
    }
    const reasonStr =
      pick.reason === 'counter'
        ? `counter pred=${pick.predicted}`
        : `explore  (random, ~15%)`;
    const extras = [];
    if (pick.fuseMs && pick.fuseMs > 0) extras.push(`fuse=${pick.fuseMs}ms`);
    if (pick.leadPx && Math.abs(pick.leadPx) >= 5) extras.push(`lead=${pick.leadPx > 0 ? '+' : ''}${pick.leadPx}px`);
    const extraStr = extras.length ? `  [${extras.join(', ')}]` : '';
    enqueue(
      `${elapsed()}  BOSS    ${pad(pick.action, 6)} ${reasonStr}${extraStr}`
    );
  }

  function gameOver(won, state, brain) {
    const m = brain.metrics();
    const hdr = won ? 'VICTORY' : 'Try again you MIGHT win LOOOLLL. LOSER ';
    enqueue(
      `${elapsed()}  ──────  ${hdr}  wins=${state.wins} deaths=${state.deaths} ` +
      `obs=${brain.observations} ` +
      (m.total >= 3
        ? `final acc=${(m.accuracy * 100).toFixed(1)}% f1=${(m.f1 * 100).toFixed(1)}%`
        : '') +
      `  ──────`
    );
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
  }

  function resetMark(reason) {
    enqueue(`${elapsed()}  ──────  RESET  (${reason})  ──────`);
  }

  async function sessionStart() {
    try { await fetch('/log-session', { method: 'POST' }); } catch {}
  }

  return { playerAction, bossAction, gameOver, resetMark, sessionStart, flush };
}
