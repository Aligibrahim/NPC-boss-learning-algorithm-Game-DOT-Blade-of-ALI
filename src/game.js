// Game state, update, render, combat, and boss action scheduling.

const W = 800, H = 600;
const PLAYER_R = 14;
const BOSS_R = 40;
const PLAYER_SPEED = 230;

const PLAYER_MAX_HP = 100;
const BOSS_MAX_HP = 300;

const DODGE_SPEED = 520;
const DODGE_DUR = 0.28;
const DODGE_COOLDOWN = 0.7;
const DODGE_IFRAMES = 0.22;

const LIGHT_WINDUP = 0.06;
const LIGHT_ACTIVE = 0.09;
const LIGHT_RECOVERY = 0.14;
const LIGHT_RANGE = 64;
const LIGHT_DMG = 8;

const HEAVY_WINDUP = 0.28;
const HEAVY_ACTIVE = 0.12;
const HEAVY_RECOVERY = 0.30;
const HEAVY_RANGE = 88;
const HEAVY_DMG = 22;

const BLOCK_REDUCTION = 0.25;
const BOSS_ACTION_GAP_MIN = 0.55;
const BOSS_ACTION_GAP_MAX = 1.1;

const BOSS_MOVES = {
  slash: { tell: 0.40, active: 0.10, reach: 130, dmg: 14, breaksBlock: false, label: 'SLASH' },
  slam:  { tell: 0.60, active: 0.14, reach: 110, dmg: 26, breaksBlock: true,  label: 'SLAM' },
  charge:{ tell: 0.50, active: 0.22, reach: 320, dmg: 20, breaksBlock: false, label: 'CHARGE' },
  aoe:   { tell: 0.90, active: 0.18, reach: 72,  dmg: 28, breaksBlock: false, label: 'AOE', trackTau: 0.45 },
};

export function createGame(canvas, brain, ui, audio) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  function fresh(x, y, hp, kind) {
    return {
      kind, x, y, hp, maxHp: hp,
      vx: 0, vy: 0,
      state: 'idle',
      attack: null,
      dodge: null,
      dodgeReadyAt: 0,
      blockHeld: false,
      invulnUntil: 0,
      facing: 1,
      flashUntil: 0,
    };
  }

  const state = {
    player: fresh(W * 0.3, H / 2, PLAYER_MAX_HP, 'player'),
    boss: {
      x: W / 2, y: H / 2,
      hp: BOSS_MAX_HP,
      action: null,
      nextActionAt: 0.8,
      facing: 1,
      enraged: false,
    },
    particles: [],
    shake: { mag: 0, until: 0 },
    hitstopUntil: 0,
    deaths: 0,
    wins: 0,
    time: 0,
    over: false,
    paused: false,
  };

  function resetArena(keepBrain = true) {
    state.player = fresh(W * 0.3, H / 2, PLAYER_MAX_HP, 'player');
    state.boss.x = W / 2;
    state.boss.y = H / 2;
    state.boss.hp = BOSS_MAX_HP;
    state.boss.action = null;
    state.boss.nextActionAt = state.time + 0.8;
    state.boss.enraged = false;
    state.particles = [];
    state.shake = { mag: 0, until: 0 };
    state.hitstopUntil = 0;
    state.over = false;
    if (!keepBrain) brain.reset();
  }

  function triggerPlayerAction(type) {
    if (state.over) return;
    const p = state.player;
    if (p.state === 'dodging') return;
    if (p.state === 'attacking') return;

    if (type === 'dodge') {
      if (state.time < p.dodgeReadyAt) return;
      let dx = p.vx, dy = p.vy;
      const mag = Math.hypot(dx, dy);
      if (mag < 0.001) { dx = p.facing; dy = 0; } else { dx /= mag; dy /= mag; }
      p.state = 'dodging';
      p.dodge = {
        dirX: dx, dirY: dy,
        endAt: state.time + DODGE_DUR,
        iframesEnd: state.time + DODGE_IFRAMES,
      };
      p.dodgeReadyAt = state.time + DODGE_COOLDOWN;
      brain.observe('dodge', state.player.x / W);
      ui.onPlayerAction('dodge', brain);
      audio.beep(520, 0.06, 'triangle', 0.08);
      return;
    }

    if (type === 'light') {
      p.state = 'attacking';
      p.attack = {
        type: 'light',
        windupEnd: state.time + LIGHT_WINDUP,
        activeEnd: state.time + LIGHT_WINDUP + LIGHT_ACTIVE,
        recoveryEnd: state.time + LIGHT_WINDUP + LIGHT_ACTIVE + LIGHT_RECOVERY,
        hitApplied: false,
      };
      brain.observe('light', state.player.x / W);
      ui.onPlayerAction('light', brain);
      audio.beep(880, 0.05, 'square', 0.06);
      return;
    }

    if (type === 'heavy') {
      p.state = 'attacking';
      p.attack = {
        type: 'heavy',
        windupEnd: state.time + HEAVY_WINDUP,
        activeEnd: state.time + HEAVY_WINDUP + HEAVY_ACTIVE,
        recoveryEnd: state.time + HEAVY_WINDUP + HEAVY_ACTIVE + HEAVY_RECOVERY,
        hitApplied: false,
      };
      brain.observe('heavy', state.player.x / W);
      ui.onPlayerAction('heavy', brain);
      audio.beep(240, 0.14, 'sawtooth', 0.1);
      return;
    }

    if (type === 'block') {
      if (p.blockHeld) return;
      p.blockHeld = true;
      brain.observe('block', state.player.x / W);
      ui.onPlayerAction('block', brain);
      audio.beep(160, 0.06, 'triangle', 0.05);
      return;
    }
  }

  function endBlock() {
    state.player.blockHeld = false;
  }

  function scheduleBossAction() {
    const pick = brain.pick();
    const move = BOSS_MOVES[pick.action];
    const now = state.time;
    const action = {
      type: pick.action,
      startedAt: now,
      tellEnd: now + move.tell,
      activeEnd: now + move.tell + move.active,
      reason: pick.reason,
      predicted: pick.predicted,
      hitApplied: false,
      params: {},
    };
    const dx = state.player.x - state.boss.x;
    const dy = state.player.y - state.boss.y;
    const ang = Math.atan2(dy, dx);
    action.params.angleAtStart = ang;
    state.boss.facing = Math.cos(ang) >= 0 ? 1 : -1;
    // Spatial lead: if brain has learned a side preference, bias the target
    // toward the favored half. Confidence ramps with sample count so early
    // on we don't over-commit. Max pull is ~80px.
    const side = brain.sideBias();
    const leadPx = -side.lead * 80 * side.confidence;

    if (pick.action === 'charge') {
      const tx = clamp(state.player.x + leadPx, BOSS_R, W - BOSS_R);
      action.params.lockedTargetX = tx;
      action.params.lockedTargetY = state.player.y;
      action.params.leadApplied = leadPx;
    }
    if (pick.action === 'aoe') {
      // Tracker starts at the boss and chases the player with a time constant,
      // so a fast/juking player can outpace or juke it. Locks on tracker pos
      // (not player pos) when the tell ends — reward last-second movement.
      action.params.trackX = state.boss.x;
      action.params.trackY = state.boss.y;
      action.params.leadPx = leadPx; // applied at lock-time below

      // Enraged delayed explosion: roll a random fuse 0–600ms AFTER lock,
      // during which the circle sits there glaring before detonating. This
      // blows up the "walk out at lock time" habit from the basic AOE.
      if (state.boss.enraged) {
        action.params.fuse = Math.random() * 0.6;
      } else {
        action.params.fuse = 0;
      }
      // Shift the damage window forward by the fuse.
      action.activeEnd = action.tellEnd + action.params.fuse + move.active;
      action.params.explodeAt = action.tellEnd + action.params.fuse;
    }
    state.boss.action = action;
    ui.onBossAction({
      ...pick,
      fuseMs: pick.action === 'aoe' ? Math.round((action.params.fuse ?? 0) * 1000) : 0,
      leadPx: Math.round(leadPx),
    });
  }

  function updateBoss(dt) {
    const b = state.boss;
    if (state.over) return;

    if (!b.action) {
      if (state.time >= b.nextActionAt) scheduleBossAction();
      return;
    }

    const action = b.action;
    const move = BOSS_MOVES[action.type];
    const p = state.player;

    if (action.type === 'charge' && state.time >= action.tellEnd && state.time < action.activeEnd) {
      const tx = action.params.lockedTargetX;
      const ty = action.params.lockedTargetY;
      const dx = tx - b.x, dy = ty - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const speed = 700;
      b.x += (dx / d) * Math.min(speed * dt, d);
      b.y += (dy / d) * Math.min(speed * dt, d);
    }

    if (action.type === 'aoe') {
      if (state.time < action.tellEnd) {
        // Exponential easing toward the player. Tracker lags normally, but
        // when boss drops below 25% HP it enrages and the tracker roughly
        // doubles speed — last-stand phase.
        const baseTau = move.trackTau ?? 0.45;
        const tau = state.boss.enraged ? baseTau * 0.48 : baseTau;
        const k = 1 - Math.exp(-dt / tau);
        action.params.trackX += (p.x - action.params.trackX) * k;
        action.params.trackY += (p.y - action.params.trackY) * k;
      } else if (!action.params.locked) {
        // Lock on tracker position (which lags), not player position.
        // Also apply any learned spatial lead.
        const leadPx = action.params.leadPx ?? 0;
        action.params.lockedX = clamp(action.params.trackX + leadPx, 20, W - 20);
        action.params.lockedY = action.params.trackY;
        action.params.locked = true;
      }
    }

    // AOE damage is gated by the fuse; other moves fire at tellEnd.
    const damageStart = action.type === 'aoe' ? (action.params.explodeAt ?? action.tellEnd) : action.tellEnd;
    if (!action.hitApplied && state.time >= damageStart && state.time < action.activeEnd) {
      if (hitsPlayer(action, move)) {
        applyBossHit(move);
        action.hitApplied = true;
      }
    }

    if (state.time >= action.activeEnd) {
      b.action = null;
      const gap = BOSS_ACTION_GAP_MIN + Math.random() * (BOSS_ACTION_GAP_MAX - BOSS_ACTION_GAP_MIN);
      b.nextActionAt = state.time + gap;
    }
  }

  function hitsPlayer(action, move) {
    const b = state.boss;
    const p = state.player;
    const inIFrames = state.time < p.invulnUntil || (p.state === 'dodging' && p.dodge && state.time < p.dodge.iframesEnd);
    if (inIFrames) return false;

    if (action.type === 'slash') {
      const ang = action.params.angleAtStart;
      const dx = p.x - b.x, dy = p.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d > move.reach) return false;
      const pAng = Math.atan2(dy, dx);
      const diff = Math.abs(wrapAngle(pAng - ang));
      return diff < Math.PI / 2.2;
    }
    if (action.type === 'slam') {
      return Math.hypot(p.x - b.x, p.y - b.y) < move.reach;
    }
    if (action.type === 'charge') {
      return Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_R + BOSS_R;
    }
    if (action.type === 'aoe') {
      const x = action.params.lockedX ?? action.params.trackX;
      const y = action.params.lockedY ?? action.params.trackY;
      return Math.hypot(p.x - x, p.y - y) < move.reach;
    }
    return false;
  }

  function applyBossHit(move) {
    const p = state.player;
    let dmg = move.dmg;
    if (p.blockHeld && !move.breaksBlock) dmg = Math.ceil(dmg * BLOCK_REDUCTION);
    p.hp = Math.max(0, p.hp - dmg);
    p.flashUntil = state.time + 0.15;
    state.shake = { mag: move.breaksBlock ? 8 : 5, until: state.time + 0.18 };
    state.hitstopUntil = state.time + 0.10;
    burst(p.x, p.y, p.blockHeld && !move.breaksBlock ? '#5aa6ff' : '#ff5470', p.blockHeld && !move.breaksBlock ? 6 : 14);
    audio.beep(120, 0.12, 'sawtooth', 0.18);

    if (p.hp <= 0) {
      state.deaths++;
      state.over = true;
      ui.onGameOver(false, state, brain);
    }
  }

  function updatePlayer(dt) {
    const p = state.player;
    if (state.over) return;

    if (p.state === 'dodging') {
      const d = p.dodge;
      p.x += d.dirX * DODGE_SPEED * dt;
      p.y += d.dirY * DODGE_SPEED * dt;
      if (state.time >= d.endAt) {
        p.state = 'idle';
        p.dodge = null;
      }
    } else if (p.state === 'attacking') {
      const a = p.attack;
      if (!a.hitApplied && state.time >= a.windupEnd && state.time < a.activeEnd) {
        const b = state.boss;
        const dx = b.x - p.x, dy = b.y - p.y;
        const range = a.type === 'heavy' ? HEAVY_RANGE : LIGHT_RANGE;
        if (Math.hypot(dx, dy) <= range + BOSS_R) {
          const dmg = a.type === 'heavy' ? HEAVY_DMG : LIGHT_DMG;
          b.hp = Math.max(0, b.hp - dmg);
          a.hitApplied = true;
          state.shake = { mag: a.type === 'heavy' ? 6 : 3, until: state.time + 0.15 };
          state.hitstopUntil = state.time + (a.type === 'heavy' ? 0.12 : 0.06);
          burst(b.x, b.y, '#7cf6c4', a.type === 'heavy' ? 14 : 8);
          audio.beep(a.type === 'heavy' ? 420 : 740, 0.08, 'square', 0.1);
          // Desperation phase: boss drops below 25% HP for the first time.
          if (!b.enraged && b.hp > 0 && b.hp / BOSS_MAX_HP <= 0.25) {
            b.enraged = true;
            state.shake = { mag: 12, until: state.time + 0.45 };
            state.hitstopUntil = state.time + 0.18;
            burst(b.x, b.y, '#ff5470', 28);
            audio.beep(70,  0.35, 'sawtooth', 0.22);
            audio.beep(140, 0.30, 'sawtooth', 0.18);
            audio.beep(220, 0.25, 'square',   0.14);
            ui.onBossAction({ action: 'enrage', reason: 'enrage', predicted: null });
          }
          if (b.hp <= 0) {
            state.wins++;
            state.over = true;
            ui.onGameOver(true, state, brain);
          }
        }
      }
      if (state.time >= a.recoveryEnd) {
        p.state = 'idle';
        p.attack = null;
      }
    } else {
      const speed = p.blockHeld ? PLAYER_SPEED * 0.35 : PLAYER_SPEED;
      p.x += p.vx * speed * dt;
      p.y += p.vy * speed * dt;
      if (p.vx !== 0) p.facing = p.vx > 0 ? 1 : -1;
    }

    p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));
  }

  function setMoveInput(vx, vy) {
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }
    state.player.vx = vx;
    state.player.vy = vy;
  }

  function updateParticles(dt) {
    for (const pt of state.particles) {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.92;
      pt.vy *= 0.92;
      pt.life -= dt;
    }
    state.particles = state.particles.filter(p => p.life > 0);
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 180;
      state.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.25 + Math.random() * 0.15, total: 0.4, color,
      });
    }
  }

  function tick(dt) {
    if (state.over || state.paused) return;
    state.time += dt;
    if (state.time < state.hitstopUntil) return;
    updatePlayer(dt);
    updateBoss(dt);
    updateParticles(dt);
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    let sx = 0, sy = 0;
    if (state.time < state.shake.until) {
      const t = (state.shake.until - state.time) * 6;
      sx = (Math.random() - 0.5) * state.shake.mag * Math.min(1, t);
      sy = (Math.random() - 0.5) * state.shake.mag * Math.min(1, t);
    }
    ctx.save();
    ctx.translate(sx, sy);

    drawArena();
    drawBossTelegraph();
    drawBoss();
    drawPlayer();
    drawPlayerAttack();
    drawParticles();
    drawHpBars();

    ctx.restore();
  }

  function drawArena() {
    ctx.strokeStyle = '#1a1d2a';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  function drawBoss() {
    const b = state.boss;
    const pulse = state.time < state.hitstopUntil ? 1.06 : 1;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(pulse, pulse);

    // Enraged: pulsing outer glow ring.
    if (b.enraged) {
      const beat = 0.6 + 0.4 * Math.sin(state.time * 10);
      ctx.beginPath();
      ctx.arc(0, 0, BOSS_R + 12, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 84, 112, ${0.18 * beat})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, BOSS_R + 6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 84, 112, ${0.55 + 0.25 * beat})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, BOSS_R, 0, Math.PI * 2);
    ctx.fillStyle = b.enraged ? '#3d1a24' : '#2b1e2e';
    ctx.fill();
    ctx.lineWidth = b.enraged ? 4 : 3;
    ctx.strokeStyle = b.enraged ? '#ff7a90' : '#ff5470';
    ctx.stroke();

    // Eye — glows yellow/white when enraged.
    ctx.beginPath();
    ctx.arc(b.facing * 12, -6, b.enraged ? 6 : 5, 0, Math.PI * 2);
    ctx.fillStyle = b.enraged ? '#fff1a8' : '#ffb84d';
    ctx.fill();
    ctx.restore();
  }

  function drawBossTelegraph() {
    const b = state.boss;
    if (!b.action) return;
    const a = b.action;
    const now = state.time;
    const move = BOSS_MOVES[a.type];

    const inTell = now < a.tellEnd;
    const inActive = now >= a.tellEnd && now < a.activeEnd;

    const progress = inTell
      ? (now - a.startedAt) / (a.tellEnd - a.startedAt)
      : 1;
    const pulse = 0.55 + 0.45 * Math.sin(now * 18);
    const alpha = inTell ? (0.25 + 0.55 * progress) * pulse : 0.9;

    ctx.save();
    ctx.fillStyle = `rgba(255, 84, 112, ${alpha * 0.35})`;
    ctx.strokeStyle = `rgba(255, 84, 112, ${alpha})`;
    ctx.lineWidth = 3;

    if (a.type === 'slash') {
      const ang = a.params.angleAtStart;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.arc(b.x, b.y, move.reach, ang - Math.PI / 2.2, ang + Math.PI / 2.2);
      ctx.closePath();
      ctx.fill();
      if (inActive) ctx.stroke();
    } else if (a.type === 'slam') {
      ctx.beginPath();
      ctx.arc(b.x, b.y, move.reach, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (a.type === 'charge') {
      const tx = a.params.lockedTargetX;
      const ty = a.params.lockedTargetY;
      const dx = tx - b.x, dy = ty - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d, ny = dy / d;
      const width = 40;
      const len = move.reach;
      const ex = b.x + nx * len, ey = b.y + ny * len;
      const px = -ny * width, py = nx * width;
      ctx.beginPath();
      ctx.moveTo(b.x + px, b.y + py);
      ctx.lineTo(ex + px, ey + py);
      ctx.lineTo(ex - px, ey - py);
      ctx.lineTo(b.x - px, b.y - py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 12, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.type === 'aoe') {
      const x = a.params.locked ? a.params.lockedX : a.params.trackX;
      const y = a.params.locked ? a.params.lockedY : a.params.trackY;
      const explodeAt = a.params.explodeAt ?? a.tellEnd;
      const fuseActive = a.params.locked && now < explodeAt;
      const fuseLen = Math.max(0.001, explodeAt - a.tellEnd);

      if (fuseActive) {
        // Locked but not yet exploded — amber/red burning fuse ring.
        const fuseProg = (now - a.tellEnd) / fuseLen;
        const fastBeat = 0.5 + 0.5 * Math.sin(now * 32);
        ctx.fillStyle = `rgba(255, 84, 112, ${0.35 + 0.25 * fastBeat})`;
        ctx.strokeStyle = `rgba(255, 220, 120, ${0.85 + 0.15 * fastBeat})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, move.reach, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Fuse ring shrinks from outer radius toward 0 as detonation nears.
        ctx.strokeStyle = `rgba(255, 220, 120, ${0.7 + 0.3 * fastBeat})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, move.reach * (1 - fuseProg), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, move.reach, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (inTell) {
          ctx.beginPath();
          ctx.arc(x, y, move.reach * progress, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawPlayer() {
    const p = state.player;
    const inIFrames = p.state === 'dodging' && p.dodge && state.time < p.dodge.iframesEnd;
    ctx.save();
    const flash = state.time < p.flashUntil;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = flash ? '#ff5470' : (inIFrames ? '#5aa6ff' : '#7cf6c4');
    ctx.globalAlpha = inIFrames ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (p.blockHeld) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R + 7, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#5aa6ff';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlayerAttack() {
    const p = state.player;
    if (p.state !== 'attacking') return;
    const a = p.attack;
    const now = state.time;
    const range = a.type === 'heavy' ? HEAVY_RANGE : LIGHT_RANGE;
    const active = now >= a.windupEnd && now < a.activeEnd;
    if (active) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, range, 0, Math.PI * 2);
      ctx.fillStyle = a.type === 'heavy' ? 'rgba(255, 184, 77, 0.25)' : 'rgba(124, 246, 196, 0.22)';
      ctx.fill();
      ctx.strokeStyle = a.type === 'heavy' ? '#ffb84d' : '#7cf6c4';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    } else if (now < a.windupEnd) {
      const w = a.type === 'heavy' ? HEAVY_WINDUP : LIGHT_WINDUP;
      const prog = 1 - (a.windupEnd - now) / w;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R + 4 + prog * 8, 0, Math.PI * 2);
      ctx.strokeStyle = a.type === 'heavy' ? 'rgba(255, 184, 77, 0.9)' : 'rgba(124, 246, 196, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.total);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawHpBars() {
    bar(16, 16, 220, 12, state.player.hp / state.player.maxHp, '#7cf6c4', 'TROLL');
    const w = 380;
    bar((W - w) / 2, 16, w, 14, state.boss.hp / BOSS_MAX_HP, '#ff5470', 'DOT — BLADE OF ALI');
  }

  function bar(x, y, w, h, pct, color, label) {
    ctx.save();
    ctx.fillStyle = '#0d0f15';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, pct)), h);
    ctx.strokeStyle = '#2a2e3d';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#e8e8ef';
    ctx.font = '10px Menlo, monospace';
    ctx.fillText(label, x, y - 4);
    ctx.restore();
  }

  return {
    state,
    tick, render,
    setMoveInput,
    triggerPlayerAction,
    endBlock,
    resetArena,
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
