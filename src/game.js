// MK-style side-view boss fight. State, update, render, combat, brain hookup.

const W = 960, H = 540;
const GROUND_Y = H * 0.78;            // floor line where fighters stand
const PLAYER_HALF_W = 18, PLAYER_H = 86;
const BOSS_HALF_W = 34, BOSS_H = 130;
const PLAYER_SPEED = 280;
const GRAVITY = 1900;
const JUMP_VEL = 720;

const PLAYER_MAX_HP = 100;
const BOSS_MAX_HP = 300;
const PLAYER_MAX_STAM = 100;
const STAM_REGEN = 22;
const STAM_DODGE = 28;
const STAM_PARRY = 14;
const STAM_HEAVY = 18;

const DODGE_SPEED = 600;
const DODGE_DUR = 0.26;
const DODGE_COOLDOWN = 0.55;
const DODGE_IFRAMES = 0.20;

const LIGHT_WINDUP = 0.08;
const LIGHT_ACTIVE = 0.10;
const LIGHT_RECOVERY = 0.16;
const LIGHT_RANGE = 90;
const LIGHT_DMG = 8;

const HEAVY_WINDUP = 0.30;
const HEAVY_ACTIVE = 0.14;
const HEAVY_RECOVERY = 0.32;
const HEAVY_RANGE = 130;
const HEAVY_DMG = 22;

const PARRY_WINDOW = 0.18;            // active anti-attack window
const PARRY_RECOVERY = 0.32;          // whiff penalty if mistimed
const PARRY_COOLDOWN = 0.45;
const PARRY_STAGGER = 0.85;           // boss stagger duration on success
const PARRY_RIPOSTE_DMG = 30;         // bonus damage if you hit during stagger

const BLOCK_DMG_MULT = 0.30;          // 70% damage reduction while blocking
const BLOCK_STAM_DRAIN = 14;          // /sec while blocking
const BLOCK_BREAK_HITSTUN = 0.45;     // freeze when block breaks (no stam)

const ROUNDS_TO_WIN = 2;              // best-of-3
const ROUND_INTRO_DUR = 1.6;          // "ROUND X — FIGHT" overlay seconds

const BOSS_ACTION_GAP_MIN = 0.55;
const BOSS_ACTION_GAP_MAX = 1.05;

const PARTICLE_POOL = 240;
const FPS_DEGRADE_THRESHOLD = 50;

// Boss moves are 1D in side-view: each has a reach measured horizontally
// from the boss along the facing direction. Vertical hitbox is the full
// stage height for 'slam'/'aoe' (ground hazard) and player-height for
// horizontal swings.
//   parryable:   if true, a successful parry within window negates damage
//                and staggers the boss → free riposte.
//   shape:       'arc' = swing in front (like slash), 'overhead' = vertical
//                slam (must be jumped over), 'rush' = horizontal dash,
//                'ground' = floor shockwave (must be jumped over).
const BOSS_MOVES = {
  slash: { tell: 0.42, active: 0.12, reach: 170, dmg: 14, parryable: true,  shape: 'arc',      label: 'SLASH' },
  slam:  { tell: 0.62, active: 0.16, reach: 130, dmg: 26, parryable: false, shape: 'overhead', label: 'SLAM'  },
  charge:{ tell: 0.50, active: 0.26, reach: 520, dmg: 20, parryable: false, shape: 'rush',     label: 'CHARGE'},
  aoe:   { tell: 0.85, active: 0.22, reach: 200, dmg: 28, parryable: false, shape: 'ground',   label: 'AOE'   },
};

export function createGame(canvas, brain, ui, audio, sprites = {}) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // --- Pre-rendered background. Use sprite if available, else procedural. ---
  const bg = document.createElement('canvas');
  bg.width = W; bg.height = H;
  const bgCtx = bg.getContext('2d');
  if (sprites && sprites.arena) {
    // Stretch the arena art across the full backdrop.
    bgCtx.imageSmoothingEnabled = false;
    bgCtx.drawImage(sprites.arena, 0, 0, W, H);
  } else {
    paintBackground(bgCtx);
  }

  // --- Particle pool (no per-frame allocations) ---
  const particles = new Array(PARTICLE_POOL);
  for (let i = 0; i < PARTICLE_POOL; i++) {
    particles[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, total: 1, color: '#fff', alive: false };
  }
  let particleCap = PARTICLE_POOL;

  function freshPlayer() {
    return {
      kind: 'player',
      x: W * 0.28, y: GROUND_Y,
      vx: 0, vy: 0,
      onGround: true,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      stam: PLAYER_MAX_STAM, maxStam: PLAYER_MAX_STAM,
      state: 'idle',         // 'idle' | 'attacking' | 'dodging' | 'parrying'
      attack: null,
      dodge: null,
      parry: null,
      parryReadyAt: 0,
      dodgeReadyAt: 0,
      jumpHeld: false,
      moveDir: 0,            // -1, 0, 1 from input
      facing: 1,
      flashUntil: 0,
      blockHeld: false,      // hold-S
      blockBroken: 0,        // time until hitstun lifts after block break
      wasOnGround: true,     // for landing-puff edge detect
      dustAt: 0,             // throttle for walk-dust spawning
    };
  }

  function freshBoss() {
    return {
      kind: 'boss',
      x: W * 0.72, y: GROUND_Y,
      hp: BOSS_MAX_HP,
      action: null,
      nextActionAt: 0.8,
      facing: -1,
      enraged: false,
      staggerUntil: 0,
      flashUntil: 0,
    };
  }

  const state = {
    player: freshPlayer(),
    boss: freshBoss(),
    shake: { mag: 0, until: 0 },
    hitstopUntil: 0,
    deaths: 0,
    wins: 0,
    time: 0,
    over: false,
    paused: false,
    fps: 60,
    fpsAccum: 0,
    fpsFrames: 0,
    fpsUpdatedAt: 0,
    // --- Round system (best-of-3) ---
    round: 1,
    playerRoundsWon: 0,
    bossRoundsWon: 0,
    roundIntroUntil: ROUND_INTRO_DUR,    // overlay shows during this window
    roundOverAt: 0,                      // when current round ended (0 = ongoing)
    roundAdvanceAt: 0,                   // game-time transition to the next round
    roundOutcome: null,                  // 'player' | 'boss' | null
    matchOver: false,
    // --- Hit-feedback layers ---
    flashUntil: 0,         // full-screen white flash (impact frame)
    flashIntensity: 0,
    floatTexts: [],        // damage numbers + HIT/BLOCK/PARRY popups
    playerHpFlashUntil: 0,
    bossHpFlashUntil: 0,
    dangerUntil: 0,        // red border while boss is in active hit frame
  };

  function resetArena(keepBrain = true) {
    state.player = freshPlayer();
    state.boss = freshBoss();
    state.boss.nextActionAt = state.time + 0.8;
    for (let i = 0; i < particles.length; i++) particles[i].alive = false;
    state.shake = { mag: 0, until: 0 };
    state.hitstopUntil = 0;
    state.flashUntil = 0;
    state.dangerUntil = 0;
    state.playerHpFlashUntil = 0;
    state.bossHpFlashUntil = 0;
    state.floatTexts.length = 0;
    state.over = false;
    // Full match reset on brain wipe; otherwise treat as starting a new match too
    // (the overlay's "fight again" button always starts a fresh best-of-3).
    state.round = 1;
    state.playerRoundsWon = 0;
    state.bossRoundsWon = 0;
    state.roundIntroUntil = state.time + ROUND_INTRO_DUR;
    state.roundOverAt = 0;
    state.roundAdvanceAt = 0;
    state.roundOutcome = null;
    state.matchOver = false;
    if (!keepBrain) brain.reset();
  }

  // Start the next round in the same match. Brain memory persists across rounds.
  function nextRound() {
    state.player = freshPlayer();
    state.boss = freshBoss();
    state.boss.nextActionAt = state.time + 0.8;
    for (let i = 0; i < particles.length; i++) particles[i].alive = false;
    state.shake = { mag: 0, until: 0 };
    state.hitstopUntil = 0;
    state.over = false;
    state.round++;
    state.roundIntroUntil = state.time + ROUND_INTRO_DUR;
    state.roundOverAt = 0;
    state.roundAdvanceAt = 0;
    state.roundOutcome = null;
  }

  function setBlock(held) {
    const p = state.player;
    p.blockHeld = !!held;
  }

  function triggerPlayerAction(type) {
    if (state.over || state.paused) return;
    if (state.time < state.roundIntroUntil) return;     // intro lockout
    const p = state.player;
    if (p.blockBroken && state.time < p.blockBroken) return;
    // Most actions are blocked while busy; jump is special-cased below.
    const busy = p.state === 'dodging' || p.state === 'attacking' || p.state === 'parrying';

    if (type === 'jump') {
      // Jump is a movement input, allowed even while idle attacking-windup is brief.
      if (p.onGround && p.state !== 'dodging' && p.state !== 'parrying') {
        p.vy = -JUMP_VEL;
        p.onGround = false;
        audio.beep(520, 0.05, 'triangle', 0.04);
      }
      return;
    }

    if (busy) return;

    if (type === 'dodge') {
      if (state.time < p.dodgeReadyAt) return;
      if (p.stam < STAM_DODGE) return;
      const dir = p.moveDir !== 0 ? p.moveDir : -p.facing; // backstep by default
      p.state = 'dodging';
      p.dodge = {
        dirX: dir,
        endAt: state.time + DODGE_DUR,
        iframesEnd: state.time + DODGE_IFRAMES,
      };
      p.stam = Math.max(0, p.stam - STAM_DODGE);
      p.dodgeReadyAt = state.time + DODGE_COOLDOWN;
      brain.observe('dodge', state.player.x / W);
      ui.onPlayerAction('dodge', brain);
      audio.beep(520, 0.06, 'triangle', 0.08);
      return;
    }

    if (type === 'parry') {
      if (state.time < p.parryReadyAt) return;
      if (p.stam < STAM_PARRY) return;
      p.state = 'parrying';
      p.parry = {
        startedAt: state.time,
        windowEnd: state.time + PARRY_WINDOW,
        recoveryEnd: state.time + PARRY_WINDOW + PARRY_RECOVERY,
        success: false,
      };
      p.stam = Math.max(0, p.stam - STAM_PARRY);
      p.parryReadyAt = state.time + PARRY_COOLDOWN;
      brain.observe('parry', state.player.x / W);
      ui.onPlayerAction('parry', brain);
      audio.beep(660, 0.04, 'square', 0.05);
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
      if (p.stam < STAM_HEAVY) return;
      p.state = 'attacking';
      p.attack = {
        type: 'heavy',
        windupEnd: state.time + HEAVY_WINDUP,
        activeEnd: state.time + HEAVY_WINDUP + HEAVY_ACTIVE,
        recoveryEnd: state.time + HEAVY_WINDUP + HEAVY_ACTIVE + HEAVY_RECOVERY,
        hitApplied: false,
      };
      p.stam = Math.max(0, p.stam - STAM_HEAVY);
      brain.observe('heavy', state.player.x / W);
      ui.onPlayerAction('heavy', brain);
      audio.beep(240, 0.14, 'sawtooth', 0.1);
      return;
    }
  }

  function scheduleBossAction() {
    const b = state.boss;
    if (state.time < b.staggerUntil) return;       // wait out stagger
    const pick = brain.pick();
    const move = BOSS_MOVES[pick.action];
    const now = state.time;
    // Face the player when committing to an action.
    b.facing = state.player.x >= b.x ? 1 : -1;
    const action = {
      type: pick.action,
      startedAt: now,
      tellEnd: now + move.tell,
      activeEnd: now + move.tell + move.active,
      reason: pick.reason,
      predicted: pick.predicted,
      hitApplied: false,
      facing: b.facing,
      params: {},
    };
    // Spatial lead: bias the lock toward the side the player prefers.
    const side = brain.sideBias();
    const leadPx = -side.lead * 80 * side.confidence;

    if (pick.action === 'charge') {
      const tx = clamp(state.player.x + leadPx * b.facing, BOSS_HALF_W, W - BOSS_HALF_W);
      action.params.lockedTargetX = tx;
    }
    if (pick.action === 'aoe') {
      // Ground shockwave centered on player's predicted x (with lead).
      action.params.trackX = b.x;
      action.params.leadPx = leadPx;
      // Enraged: short random fuse after lock so "walk out at lock" stops working.
      action.params.fuse = b.enraged ? Math.random() * 0.5 : 0;
      action.activeEnd = action.tellEnd + action.params.fuse + move.active;
      action.params.explodeAt = action.tellEnd + action.params.fuse;
    }
    if (pick.action === 'slam') {
      // Overhead lands at the player's current x; jumping over avoids it.
      action.params.lockX = state.player.x;
    }
    if (pick.action === 'slash') {
      action.params.startX = b.x + b.facing * BOSS_HALF_W;
    }
    b.action = action;
    ui.onBossAction({
      ...pick,
      fuseMs: pick.action === 'aoe' ? Math.round((action.params.fuse ?? 0) * 1000) : 0,
      leadPx: Math.round(leadPx),
    });
  }

  function updateBoss(dt) {
    const b = state.boss;
    if (state.over) return;
    if (state.time < state.roundIntroUntil) return;
    if (state.roundOverAt) return;

    // Stagger: boss is locked out (parry success put them here).
    if (state.time < b.staggerUntil) {
      b.action = null;
      return;
    }

    if (!b.action) {
      if (state.time >= b.nextActionAt) scheduleBossAction();
      return;
    }

    const action = b.action;
    const move = BOSS_MOVES[action.type];
    const p = state.player;

    if (action.type === 'charge' && state.time >= action.tellEnd && state.time < action.activeEnd) {
      const tx = action.params.lockedTargetX;
      const dx = tx - b.x;
      const speed = state.boss.enraged ? 820 : 700;
      const step = Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
      b.x += step;
    }

    if (action.type === 'aoe') {
      if (state.time < action.tellEnd) {
        const tau = state.boss.enraged ? 0.22 : 0.45;
        const k = 1 - Math.exp(-dt / tau);
        action.params.trackX += (p.x - action.params.trackX) * k;
      } else if (!action.params.locked) {
        action.params.lockedX = clamp(action.params.trackX + (action.params.leadPx ?? 0), 40, W - 40);
        action.params.locked = true;
      }
    }

    const damageStart = action.type === 'aoe' ? (action.params.explodeAt ?? action.tellEnd) : action.tellEnd;
    // Active-frame danger pulse: red border around the canvas any time the
    // boss's attack is in its damage window, hit or miss.
    if (state.time >= damageStart && state.time < action.activeEnd) {
      state.dangerUntil = Math.max(state.dangerUntil, action.activeEnd);
    }
    if (!action.hitApplied && state.time >= damageStart && state.time < action.activeEnd) {
      // Parry intercept: only if the move is parryable AND player parry window is active.
      if (move.parryable && p.state === 'parrying' && p.parry && state.time < p.parry.windowEnd && playerInRange(action, move)) {
        onParrySuccess();
        action.hitApplied = true;
      } else if (playerInRange(action, move) && !playerInIFrames()) {
        applyBossHit(move);
        action.hitApplied = true;
      }
    }

    if (state.time >= action.activeEnd) {
      b.action = null;
      const gap = BOSS_ACTION_GAP_MIN + Math.random() * (BOSS_ACTION_GAP_MAX - BOSS_ACTION_GAP_MIN);
      b.nextActionAt = state.time + gap * (state.boss.enraged ? 0.7 : 1);
    }
  }

  function playerInIFrames() {
    const p = state.player;
    return p.state === 'dodging' && p.dodge && state.time < p.dodge.iframesEnd;
  }

  function playerInRange(action, move) {
    const b = state.boss;
    const p = state.player;
    const dx = p.x - b.x;
    if (action.type === 'slash') {
      // Horizontal arc in front of the boss; player must be on facing side and within reach.
      if (Math.sign(dx) !== action.facing) return false;
      const horiz = Math.abs(dx) <= move.reach;
      const vert = Math.abs(p.y - b.y) <= PLAYER_H * 0.7;
      return horiz && vert;
    }
    if (action.type === 'slam') {
      // Vertical overhead: hits if player is on the ground near lockX.
      const lockX = action.params.lockX ?? p.x;
      const horiz = Math.abs(p.x - lockX) <= move.reach * 0.5;
      const grounded = p.onGround;
      return horiz && grounded;
    }
    if (action.type === 'charge') {
      // Body-slam: collision while running through.
      return Math.abs(p.x - b.x) <= (PLAYER_HALF_W + BOSS_HALF_W);
    }
    if (action.type === 'aoe') {
      // Ground shockwave: hits grounded player within radius.
      const x = action.params.lockedX ?? action.params.trackX;
      return Math.abs(p.x - x) <= move.reach && p.onGround;
    }
    return false;
  }

  function applyBossHit(move) {
    const p = state.player;
    const blocking = p.blockHeld && p.onGround && p.stam > 0 &&
                     p.state !== 'attacking' && p.state !== 'dodging';
    const contactX = (p.x + state.boss.x) / 2;
    const contactY = p.y - PLAYER_H * 0.55;
    let dmg = move.dmg;
    if (blocking) {
      dmg = Math.round(dmg * BLOCK_DMG_MULT);
      const stamCost = dmg * 0.6 + 8;
      if (p.stam < stamCost) {
        p.blockBroken = state.time + BLOCK_BREAK_HITSTUN;
        p.stam = 0;
        floatText('BLOCK BROKEN!', p.x, p.y - PLAYER_H * 0.7, '#ff5470', 22);
      } else {
        p.stam = Math.max(0, p.stam - stamCost);
      }
      audio.beep(280, 0.06, 'square', 0.08);
      audio.beep(380, 0.04, 'square', 0.06);
      hitConfirm('block', contactX, contactY, dmg);
    } else {
      audio.beep(120, 0.14, 'sawtooth', 0.22);
      audio.beep(60,  0.18, 'sawtooth', 0.18);
      const isHeavyMove = move.dmg >= 22;
      hitConfirm('player_hit', contactX, contactY, dmg, isHeavyMove ? 1.4 : 1);
    }
    p.hp = Math.max(0, p.hp - dmg);
    const dir = Math.sign(p.x - state.boss.x) || 1;
    p.vx = dir * (blocking ? 140 : 380);

    if (p.hp <= 0) endRound('boss');
  }

  function onParrySuccess() {
    const p = state.player;
    const b = state.boss;
    p.parry.success = true;
    b.staggerUntil = state.time + PARRY_STAGGER;
    b.action = null;
    hitConfirm('parry', p.x + p.facing * 30, p.y - PLAYER_H * 0.55, 0);
    audio.beep(1100, 0.06, 'square', 0.10);
    audio.beep(740, 0.10, 'triangle', 0.06);
    audio.beep(1500, 0.08, 'square', 0.08);
  }

  function updatePlayer(dt) {
    const p = state.player;
    if (state.over) return;

    // --- Movement integration (always runs, even mid-attack so dodge/jump physics still work) ---
    // Auto-face the boss when idle.
    if (p.state === 'idle') p.facing = state.boss.x >= p.x ? 1 : -1;

    if (p.state === 'dodging') {
      const d = p.dodge;
      p.x += d.dirX * DODGE_SPEED * dt;
      if (state.time >= d.endAt) {
        p.state = 'idle';
        p.dodge = null;
      }
    } else if (p.state === 'attacking') {
      const a = p.attack;
      if (!a.hitApplied && state.time >= a.windupEnd && state.time < a.activeEnd) {
        tryHitBoss(a);
      }
      if (state.time >= a.recoveryEnd) {
        p.state = 'idle';
        p.attack = null;
      }
    } else if (p.state === 'parrying') {
      if (state.time >= p.parry.recoveryEnd) {
        p.state = 'idle';
        p.parry = null;
      }
    } else {
      // Idle / running: horizontal control, but slowed while in air a bit.
      const introLock = state.time < state.roundIntroUntil;
      const broken = p.blockBroken && state.time < p.blockBroken;
      const blocking = p.blockHeld && p.onGround && !broken;
      const accelControl = p.onGround ? (blocking ? 0 : 1) : 0.55;
      const moveDir = (introLock || broken) ? 0 : p.moveDir;
      p.vx = moveDir * PLAYER_SPEED * accelControl;
      p.x += p.vx * dt;
      if (blocking) p.stam = Math.max(0, p.stam - BLOCK_STAM_DRAIN * dt);
    }

    // Gravity & ground collision (always).
    p.vy += GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y >= GROUND_Y) {
      p.y = GROUND_Y;
      p.vy = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    // Landing puff (rising edge from airborne -> grounded).
    if (p.onGround && !p.wasOnGround) {
      burst(p.x - 6, GROUND_Y - 2, '#9a8470', 8);
      burst(p.x + 6, GROUND_Y - 2, '#9a8470', 8);
    }
    p.wasOnGround = p.onGround;

    // Walking dust kick — every ~140ms while moving on ground.
    if (p.onGround && Math.abs(p.vx) > 60 && state.time - p.dustAt > 0.14) {
      p.dustAt = state.time;
      const back = -Math.sign(p.vx);
      const pt = findFreeParticle();
      if (pt) {
        pt.x = p.x + back * 6;
        pt.y = GROUND_Y - 2;
        pt.vx = back * (40 + Math.random() * 30);
        pt.vy = -30 - Math.random() * 40;
        pt.life = 0.32;
        pt.total = pt.life;
        pt.color = '#a89880';
        pt.alive = true;
      }
    }

    // Bounds.
    p.x = clamp(p.x, PLAYER_HALF_W, W - PLAYER_HALF_W);

    // Stamina regen when not actively spending or blocking.
    if (p.state !== 'dodging' && !(p.blockHeld && p.onGround)) {
      p.stam = Math.min(p.maxStam, p.stam + STAM_REGEN * dt);
    }
  }

  function findFreeParticle() {
    for (let i = 0; i < particles.length; i++) {
      if (!particles[i].alive) return particles[i];
    }
    return null;
  }

  function tryHitBoss(attack) {
    const p = state.player;
    const b = state.boss;
    const range = attack.type === 'heavy' ? HEAVY_RANGE : LIGHT_RANGE;
    const dx = b.x - p.x;
    if (Math.sign(dx) !== p.facing && dx !== 0) return;
    const horiz = Math.abs(dx) <= range + BOSS_HALF_W;
    const vert = Math.abs(p.y - b.y) <= BOSS_H * 0.85;
    if (!horiz || !vert) return;

    let dmg = attack.type === 'heavy' ? HEAVY_DMG : LIGHT_DMG;
    const riposting = state.time < b.staggerUntil;
    if (riposting) dmg += PARRY_RIPOSTE_DMG;
    b.hp = Math.max(0, b.hp - dmg);
    attack.hitApplied = true;
    const contactX = b.x - p.facing * BOSS_HALF_W * 0.5;
    const contactY = b.y - BOSS_H * 0.55;
    const mag = (attack.type === 'heavy' ? 1.3 : 0.9) + (riposting ? 0.6 : 0);
    hitConfirm('boss_hit', contactX, contactY, dmg, mag);
    audio.beep(attack.type === 'heavy' ? 420 : 740, 0.08, 'square', 0.10);
    if (attack.type === 'heavy') audio.beep(160, 0.10, 'sawtooth', 0.12);

    if (!b.enraged && b.hp > 0 && b.hp / BOSS_MAX_HP <= 0.25) {
      b.enraged = true;
      state.shake = { mag: 12, until: state.time + 0.45 };
      state.hitstopUntil = state.time + 0.18;
      burst(b.x, b.y - BOSS_H * 0.5, '#ff5470', 28);
      audio.beep(70,  0.35, 'sawtooth', 0.22);
      audio.beep(140, 0.30, 'sawtooth', 0.18);
      audio.beep(220, 0.25, 'square',   0.14);
      ui.onBossAction({ action: 'enrage', reason: 'enrage', predicted: null });
    }
    if (b.hp <= 0) endRound('player');
  }

  function endRound(winner) {
    if (state.roundOverAt) return;
    state.roundOverAt = state.time;
    state.roundOutcome = winner;
    if (winner === 'player') state.playerRoundsWon++;
    else state.bossRoundsWon++;

    const matchWinner =
      state.playerRoundsWon >= ROUNDS_TO_WIN ? 'player' :
      state.bossRoundsWon >= ROUNDS_TO_WIN ? 'boss' : null;

    if (matchWinner) {
      state.matchOver = true;
      state.over = true;
      state.roundAdvanceAt = 0;
      if (matchWinner === 'player') state.wins++;
      else state.deaths++;
      ui.onGameOver(matchWinner === 'player', state, brain);
    } else {
      // Schedule using game time so pause/reset cannot advance a stale round.
      state.roundAdvanceAt = state.time + 1.4;
    }
  }

  function setMoveInput(dir) {
    state.player.moveDir = dir < 0 ? -1 : dir > 0 ? 1 : 0;
  }

  function updateParticles(dt) {
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      if (!pt.alive) continue;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy += 600 * dt;          // gravity on particles
      pt.vx *= 0.94;
      pt.life -= dt;
      if (pt.life <= 0) pt.alive = false;
    }
  }

  // Spawn a floating text (damage numbers, "HIT!", "BLOCK", "PARRY!").
  function floatText(text, x, y, color = '#ffd84a', size = 22, vy = -90) {
    state.floatTexts.push({
      text, x, y, color, size, vy,
      vx: (Math.random() - 0.5) * 30,
      life: 0.85, total: 0.85,
    });
    if (state.floatTexts.length > 12) state.floatTexts.shift();
  }

  // Big readable hit-confirm: hitstop + flash + shake + spark + numbers.
  // kind: 'player_hit' | 'boss_hit' | 'block' | 'parry'
  function hitConfirm(kind, x, y, dmg, magnitude = 1) {
    const big = magnitude >= 1.3;
    if (kind === 'player_hit') {
      // Player took damage — make it LOUD so they know.
      state.flashUntil = state.time + 0.10;
      state.flashIntensity = big ? 0.55 : 0.40;
      state.shake = { mag: big ? 14 : 10, until: state.time + 0.30 };
      state.hitstopUntil = state.time + (big ? 0.22 : 0.15);
      state.playerHpFlashUntil = state.time + 0.45;
      state.player.flashUntil = state.time + 0.30;
      // Bright white-yellow hit spark + red blood-style burst.
      burst(x, y, '#fff1a8', big ? 22 : 16);
      burst(x, y, '#ff5470', big ? 18 : 12);
      floatText('-' + dmg, x, y - 20, '#ff5470', big ? 30 : 24);
      floatText(big ? 'HIT!' : 'OUCH', x + 18, y - 4, '#ffd84a', big ? 24 : 18);
    } else if (kind === 'boss_hit') {
      state.flashUntil = state.time + 0.08;
      state.flashIntensity = big ? 0.45 : 0.30;
      state.shake = { mag: big ? 10 : 6, until: state.time + 0.22 };
      state.hitstopUntil = state.time + (big ? 0.18 : 0.10);
      state.bossHpFlashUntil = state.time + 0.40;
      state.boss.flashUntil = state.time + 0.22;
      burst(x, y, '#fff1a8', big ? 18 : 12);
      burst(x, y, '#7cf6c4', big ? 14 : 8);
      floatText('-' + dmg, x, y - 20, '#7cf6c4', big ? 30 : 22);
      if (big) floatText('CRIT!', x - 14, y - 8, '#ffd84a', 22);
    } else if (kind === 'block') {
      state.shake = { mag: 4, until: state.time + 0.12 };
      state.hitstopUntil = state.time + 0.06;
      burst(x, y, '#5aa6ff', 10);
      floatText('BLOCK', x, y - 14, '#5aa6ff', 18);
    } else if (kind === 'parry') {
      state.flashUntil = state.time + 0.14;
      state.flashIntensity = 0.6;
      state.shake = { mag: 8, until: state.time + 0.25 };
      state.hitstopUntil = state.time + 0.18;
      burst(x, y, '#ffe28a', 22);
      floatText('PARRY!', x, y - 16, '#ffe28a', 28);
    }
  }

  function burst(x, y, color, n) {
    let spawned = 0;
    for (let i = 0; i < particles.length && spawned < n && spawned < particleCap; i++) {
      const pt = particles[i];
      if (pt.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 180;
      pt.x = x; pt.y = y;
      pt.vx = Math.cos(a) * s; pt.vy = Math.sin(a) * s - 120;
      pt.life = 0.25 + Math.random() * 0.15;
      pt.total = pt.life;
      pt.color = color;
      pt.alive = true;
      spawned++;
    }
  }

  function tick(dt) {
    if (state.over || state.paused) return;
    state.time += dt;
    // Float-texts always advance (so they animate even during hitstop).
    updateFloatTexts(dt);
    if (state.roundAdvanceAt && state.time >= state.roundAdvanceAt && !state.matchOver) {
      nextRound();
      return;
    }
    if (state.time < state.hitstopUntil) return;
    updatePlayer(dt);
    updateBoss(dt);
    updateParticles(dt);
  }

  function updateFloatTexts(dt) {
    for (let i = state.floatTexts.length - 1; i >= 0; i--) {
      const ft = state.floatTexts[i];
      ft.x += ft.vx * dt;
      ft.y += ft.vy * dt;
      ft.vy += 60 * dt;     // gentle gravity so they arc
      ft.life -= dt;
      if (ft.life <= 0) state.floatTexts.splice(i, 1);
    }
  }

  function render(now) {
    // Track FPS, auto-degrade if struggling.
    if (typeof now === 'number') {
      if (state.fpsUpdatedAt) {
        const dt = now - state.fpsUpdatedAt;
        state.fpsAccum += dt;
        state.fpsFrames++;
        if (state.fpsAccum >= 500) {
          state.fps = Math.round(1000 * state.fpsFrames / state.fpsAccum);
          state.fpsAccum = 0;
          state.fpsFrames = 0;
          // Auto-degrade if struggling.
          if (state.fps < FPS_DEGRADE_THRESHOLD && particleCap > 60) {
            particleCap = 60;
          } else if (state.fps > 58 && particleCap < PARTICLE_POOL) {
            particleCap = PARTICLE_POOL;
          }
        }
      }
      state.fpsUpdatedAt = now;
    }

    // Screen-shake offset.
    let sx = 0, sy = 0;
    if (state.time < state.shake.until) {
      const t = (state.shake.until - state.time) * 6;
      sx = (Math.random() - 0.5) * state.shake.mag * Math.min(1, t);
      sy = (Math.random() - 0.5) * state.shake.mag * Math.min(1, t);
    }

    // Blit pre-rendered background.
    ctx.drawImage(bg, sx | 0, sy | 0);

    ctx.save();
    ctx.translate(sx | 0, sy | 0);

    drawBossTelegraph();
    drawFighter(state.boss, true);
    drawFighter(state.player, false);
    drawPlayerAttack();
    drawParryEffect();
    drawParticles();
    drawFloatTexts();
    drawHud();
    drawDangerBorder();
    drawScreenFlash();

    ctx.restore();
  }

  function drawFloatTexts() {
    if (!state.floatTexts.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    for (const ft of state.floatTexts) {
      const life = Math.max(0, ft.life / ft.total);
      ctx.globalAlpha = Math.min(1, life * 1.4);
      ctx.font = `bold ${ft.size | 0}px 'Press Start 2P', Menlo, monospace`;
      ctx.strokeStyle = '#000';
      ctx.strokeText(ft.text, ft.x | 0, ft.y | 0);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x | 0, ft.y | 0);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
    ctx.restore();
  }

  function drawDangerBorder() {
    if (state.time >= state.dangerUntil) return;
    const tt = state.dangerUntil - state.time;
    const pulse = 0.5 + 0.5 * Math.sin(state.time * 30);
    const alpha = Math.min(1, tt * 4) * (0.4 + 0.5 * pulse);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 84, 112, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.restore();
  }

  function drawScreenFlash() {
    if (state.time >= state.flashUntil) return;
    const tt = state.flashUntil - state.time;
    const dur = 0.10;
    const alpha = state.flashIntensity * (tt / dur);
    if (alpha <= 0) return;
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawFighter(f, isBoss) {
    const flash = state.time < f.flashUntil;
    const inIFrames = !isBoss && playerInIFrames();
    const isParry = !isBoss && state.player.state === 'parrying';
    const inWindow = isParry && state.time < state.player.parry.windowEnd;
    const halfW = isBoss ? BOSS_HALF_W : PLAYER_HALF_W;
    const fullH = isBoss ? BOSS_H : PLAYER_H;

    ctx.save();
    // Boss enrage glow (cheap radial-ish layered ellipses).
    if (isBoss && f.enraged) {
      const beat = 0.6 + 0.4 * Math.sin(state.time * 10);
      ctx.fillStyle = `rgba(255, 84, 112, ${0.10 + 0.08 * beat})`;
      ellipse(f.x, f.y - fullH * 0.5, halfW + 24, fullH * 0.6 + 14);
    }

    // Stagger glow when boss is parry-staggered.
    if (isBoss && state.time < f.staggerUntil) {
      ctx.fillStyle = `rgba(255, 226, 138, 0.18)`;
      ellipse(f.x, f.y - fullH * 0.5, halfW + 18, fullH * 0.55);
    }

    // Ground shadow under fighter.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const shadowSquish = f.onGround !== false ? 1 : 0.55;
    ellipse(f.x, GROUND_Y + 4, halfW * shadowSquish, 6 * shadowSquish);

    // Sprite path — use bitmap when present, fall back to rect silhouette.
    const spriteKey = isBoss ? 'boss_idle' : 'player_idle';
    const sprite = sprites && sprites[spriteKey];
    const torsoX = f.x - halfW;
    const torsoY = f.y - fullH;
    const torsoW = halfW * 2;
    const torsoH = fullH;

    if (sprite) {
      // Both Gemini source PNGs face right after our cleanup pass — flip
      // horizontally when this fighter's facing is -1.
      const drawFlipped = f.facing === -1;

      // Use the CROPPED sprite's actual aspect ratio so the figure isn't
      // squished. Draw bigger than the hitbox (1.6x) so it reads MK-scale.
      const drawScale = isBoss ? 1.65 : 1.55;
      const dh = fullH * drawScale;
      const ratio = (sprite.naturalWidth || sprite.width) /
                    (sprite.naturalHeight || sprite.height);
      const dw = dh * ratio;

      // Motion offsets (single-frame "animation"):
      //   walkBobY  : vertical sine while moving on ground
      //   lungeX    : forward push during attack active window
      //   recoilX   : backward push for ~150ms after a hit lands
      //   lean      : horizontal skew (air, lunge, telegraph windup)
      let walkBobY = 0, lungeX = 0, recoilX = 0, lean = 0;
      if (!isBoss && f.onGround && Math.abs(f.vx) > 30) {
        walkBobY = -Math.abs(Math.sin(state.time * 16)) * 3;
      }
      if (!isBoss && f.state === 'attacking' && f.attack) {
        const a = f.attack;
        const active = state.time >= a.windupEnd && state.time < a.activeEnd;
        const windup = state.time < a.windupEnd;
        if (active) lungeX = f.facing * (a.type === 'heavy' ? 16 : 10);
        if (windup) lean = -f.facing * 0.06;       // wind back
        else if (active) lean = f.facing * 0.10;   // lunge forward
      }
      if (!isBoss && flash) recoilX = -f.facing * 6;
      if (!isBoss && !f.onGround) lean = f.facing * 0.08;

      if (isBoss && f.action) {
        const a = f.action;
        const tellLeft = a.tellEnd - state.time;
        if (tellLeft > 0) {
          // Wind-up lean: stronger as the tell ends.
          const k = 1 - Math.min(1, tellLeft / Math.max(0.001, a.tellEnd - a.startedAt));
          lean = -f.facing * 0.04 * k;
        } else if (state.time < a.activeEnd) {
          lean = f.facing * 0.10;
        }
      }
      if (isBoss && f.enraged) {
        walkBobY = Math.sin(state.time * 6) * 1.5;
      }

      // Feet anchor: f.y is the foot position. Drop the sprite's bottom
      // exactly there + bob.
      const footY = f.y + walkBobY;
      const dy = footY - dh;
      const dx = f.x - dw / 2 + lungeX + recoilX;

      ctx.save();
      if (lean !== 0) {
        // Pivot the skew at the feet so the head moves and feet stay planted.
        ctx.translate(f.x, footY);
        ctx.transform(1, 0, lean, 1, 0, 0);
        ctx.translate(-f.x, -footY);
      }
      if (drawFlipped) {
        ctx.translate(f.x, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(sprite, (-dw / 2 + lungeX + recoilX) | 0, dy | 0, dw | 0, dh | 0);
      } else {
        ctx.drawImage(sprite, dx | 0, dy | 0, dw | 0, dh | 0);
      }
      ctx.restore();

      // Hit-flash overlay sized to the actual draw box, not the hitbox.
      if (flash) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = '#ff5470';
        ctx.fillRect(dx | 0, dy | 0, dw | 0, dh | 0);
        ctx.restore();
      }
      if (inIFrames) {
        ctx.save();
        ctx.globalAlpha = 0.30;
        ctx.fillStyle = '#5aa6ff';
        ctx.fillRect(dx | 0, dy | 0, dw | 0, dh | 0);
        ctx.restore();
      }
    } else {
      // Fallback vector silhouette.
      const baseColor = isBoss
        ? (f.enraged ? '#3a1424' : '#1a1018')
        : (flash ? '#ff5470' : (inIFrames ? '#3d6280' : '#102019'));
      const rim = isBoss
        ? (f.enraged ? '#ff7a90' : '#ff5470')
        : (inWindow ? '#ffe28a' : '#7cf6c4');
      ctx.fillStyle = baseColor;
      ctx.fillRect(torsoX | 0, torsoY | 0, torsoW | 0, torsoH | 0);
      const headW = halfW * 1.2;
      const headH = fullH * 0.22;
      ctx.fillRect((f.x - headW * 0.5) | 0, (torsoY - headH * 0.65) | 0, headW | 0, headH | 0);
      ctx.lineWidth = isBoss ? 3 : 2;
      ctx.strokeStyle = rim;
      ctx.strokeRect((torsoX + 0.5) | 0, (torsoY + 0.5) | 0, (torsoW - 1) | 0, (torsoH - 1) | 0);
      ctx.strokeRect(((f.x - headW * 0.5) + 0.5) | 0, ((torsoY - headH * 0.65) + 0.5) | 0, (headW - 1) | 0, (headH - 1) | 0);
      ctx.fillStyle = isBoss ? (f.enraged ? '#fff1a8' : '#ffb84d') : '#7cf6c4';
      const eyeR = isBoss ? 5 : 3;
      const eyeX = f.x + f.facing * (headW * 0.18);
      const eyeY = torsoY - headH * 0.3;
      ctx.beginPath();
      ctx.arc(eyeX | 0, eyeY | 0, eyeR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Block stance shield arc (player only, while holding block).
    if (!isBoss && f.blockHeld && f.onGround && !(f.blockBroken && state.time < f.blockBroken)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(90, 166, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x + f.facing * 14, f.y - fullH * 0.55, 24, -Math.PI * 0.7, Math.PI * 0.7);
      ctx.stroke();
      ctx.restore();
    }

    // Weapon hint: small forward-facing rectangle while attacking.
    if (!isBoss && f.state === 'attacking' && f.attack) {
      const a = f.attack;
      const reach = a.type === 'heavy' ? HEAVY_RANGE : LIGHT_RANGE;
      const swing = state.time >= a.windupEnd && state.time < a.activeEnd;
      const wx = f.x + f.facing * (halfW + (swing ? reach * 0.55 : 8));
      const wy = f.y - fullH * 0.55;
      const wlen = swing ? reach * 0.6 : 18;
      ctx.fillStyle = a.type === 'heavy' ? '#ffb84d' : '#7cf6c4';
      ctx.fillRect((wx - wlen * 0.5) | 0, (wy - 3) | 0, wlen | 0, 6);
    }

    // Parry guard glint while window is open.
    if (!isBoss && inWindow) {
      ctx.strokeStyle = '#ffe28a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x + f.facing * (halfW + 6), f.y - fullH * 0.55, 14, -Math.PI * 0.6, Math.PI * 0.6);
      ctx.stroke();
    }

    ctx.restore();
  }

  function ellipse(x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x | 0, y | 0, rx | 0, ry | 0, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBossTelegraph() {
    const b = state.boss;
    if (!b.action) return;
    const a = b.action;
    const now = state.time;
    const move = BOSS_MOVES[a.type];

    const inTell = now < a.tellEnd;
    const inActive = now >= a.tellEnd && now < a.activeEnd;

    const progress = inTell ? (now - a.startedAt) / (a.tellEnd - a.startedAt) : 1;
    const pulse = 0.55 + 0.45 * Math.sin(now * 18);
    const alpha = inTell ? (0.25 + 0.55 * progress) * pulse : 0.9;

    // Parryable moves get a yellow tell, unparryable red.
    const baseR = move.parryable ? 255 : 255;
    const baseG = move.parryable ? 200 : 84;
    const baseB = move.parryable ? 80  : 112;
    const fillCol = `rgba(${baseR}, ${baseG}, ${baseB}, ${alpha * 0.30})`;
    const strokeCol = `rgba(${baseR}, ${baseG}, ${baseB}, ${alpha})`;

    ctx.save();
    ctx.fillStyle = fillCol;
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 3;

    if (a.type === 'slash') {
      // Horizontal swath in front of the boss along ground level.
      const x0 = b.x;
      const x1 = b.x + a.facing * move.reach;
      const top = b.y - PLAYER_H * 0.7;
      const bot = b.y - 6;
      const lo = Math.min(x0, x1) | 0;
      const hi = Math.max(x0, x1) | 0;
      ctx.fillRect(lo, top | 0, (hi - lo) | 0, (bot - top) | 0);
      if (inActive) ctx.strokeRect(lo + 0.5, (top + 0.5) | 0, (hi - lo - 1) | 0, (bot - top - 1) | 0);
    } else if (a.type === 'slam') {
      // Overhead column landing on lockX.
      const lockX = a.params.lockX ?? b.x;
      const halfReach = move.reach * 0.5;
      const top = 40;
      const bot = GROUND_Y;
      ctx.fillRect((lockX - halfReach) | 0, top | 0, (halfReach * 2) | 0, (bot - top) | 0);
      if (inActive) {
        ctx.strokeStyle = '#ff5470';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo((lockX - halfReach) | 0, GROUND_Y);
        ctx.lineTo((lockX + halfReach) | 0, GROUND_Y);
        ctx.stroke();
      }
      // "JUMP" warning text during tell.
      if (inTell && progress > 0.3) {
        ctx.fillStyle = '#ff5470';
        ctx.font = 'bold 14px Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('▲ JUMP', lockX, top - 6);
        ctx.textAlign = 'start';
      }
    } else if (a.type === 'charge') {
      // Horizontal lane the boss will rush along.
      const tx = a.params.lockedTargetX ?? (b.x + a.facing * move.reach);
      const top = b.y - BOSS_H * 0.7;
      const bot = b.y - 6;
      const lo = Math.min(b.x, tx) | 0;
      const hi = Math.max(b.x, tx) | 0;
      ctx.fillRect(lo, top | 0, (hi - lo) | 0, (bot - top) | 0);
      if (inActive) ctx.strokeRect(lo + 0.5, (top + 0.5) | 0, (hi - lo - 1) | 0, (bot - top - 1) | 0);
    } else if (a.type === 'aoe') {
      // Ground shockwave centered on tracked/locked X.
      const x = a.params.locked ? a.params.lockedX : a.params.trackX;
      const explodeAt = a.params.explodeAt ?? a.tellEnd;
      const fuseActive = a.params.locked && now < explodeAt;
      const fuseLen = Math.max(0.001, explodeAt - a.tellEnd);
      const halfReach = move.reach;
      const top = GROUND_Y - 30;
      const bot = GROUND_Y;

      if (fuseActive) {
        const fastBeat = 0.5 + 0.5 * Math.sin(now * 32);
        ctx.fillStyle = `rgba(255, 84, 112, ${0.35 + 0.25 * fastBeat})`;
        ctx.strokeStyle = `rgba(255, 220, 120, ${0.85 + 0.15 * fastBeat})`;
      }
      ctx.fillRect((x - halfReach) | 0, top | 0, (halfReach * 2) | 0, (bot - top) | 0);
      if (inActive || fuseActive) {
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo((x - halfReach) | 0, bot);
        ctx.lineTo((x + halfReach) | 0, bot);
        ctx.stroke();
      }
      if (inTell && !fuseActive) {
        ctx.lineWidth = 2;
        ctx.strokeRect(((x - halfReach * progress) + 0.5) | 0, (top + 0.5) | 0, (halfReach * 2 * progress) | 0, (bot - top - 1) | 0);
      }
      if (inTell && progress > 0.3) {
        ctx.fillStyle = '#ffb84d';
        ctx.font = 'bold 13px Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('▲ JUMP', x, top - 4);
        ctx.textAlign = 'start';
      }
    }
    ctx.restore();
  }

  function drawPlayerAttack() {
    const p = state.player;
    if (p.state !== 'attacking') return;
    const a = p.attack;
    const now = state.time;
    if (now < a.windupEnd) {
      // Charge ring at feet.
      const w = a.type === 'heavy' ? HEAVY_WINDUP : LIGHT_WINDUP;
      const prog = 1 - (a.windupEnd - now) / w;
      ctx.save();
      ctx.strokeStyle = a.type === 'heavy' ? 'rgba(255, 184, 77, 0.85)' : 'rgba(124, 246, 196, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x | 0, GROUND_Y + 2, (PLAYER_HALF_W + 4 + prog * 14) | 0, 5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParryEffect() {
    const p = state.player;
    if (p.state !== 'parrying' || !p.parry) return;
    const inWindow = state.time < p.parry.windowEnd;
    if (!inWindow) return;
    const t = (state.time - p.parry.startedAt) / PARRY_WINDOW;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 226, 138, ${1 - t * 0.6})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x + p.facing * 22, p.y - PLAYER_H * 0.55, 22 + t * 6, -Math.PI * 0.7, Math.PI * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      if (!pt.alive) continue;
      ctx.globalAlpha = Math.max(0, pt.life / pt.total);
      ctx.fillStyle = pt.color;
      ctx.fillRect((pt.x - 2) | 0, (pt.y - 2) | 0, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  function drawHud() {
    // MK-style facing-inward bars with pulse-flash on damage.
    const pPulse = state.time < state.playerHpFlashUntil;
    const bPulse = state.time < state.bossHpFlashUntil;
    drawHpBar(20, 24, 380, 16, state.player.hp / state.player.maxHp, '#ffd84a', 'TROLL', false, pPulse);
    drawHpBar(W - 400, 24, 380, 16, state.boss.hp / BOSS_MAX_HP, '#ffd84a', 'DOT — BLADE OF ALI', true, bPulse);
    // Player stamina under the HP bar.
    drawStamBar(20, 46, 220, 6, state.player.stam / state.player.maxStam);
    // Round-wins pips (player on left, boss on right of center).
    drawRoundPips();
    // Phase-2 marker.
    if (state.boss.enraged) {
      ctx.save();
      ctx.fillStyle = '#ff7a90';
      ctx.font = 'bold 14px Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PHASE 2 — ENRAGED', W / 2, 80);
      ctx.textAlign = 'start';
      ctx.restore();
    }
    drawRoundOverlay();
  }

  function drawRoundPips() {
    const cx = W / 2;
    const y = 32;
    ctx.save();
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      const lit = i < state.playerRoundsWon;
      ctx.fillStyle = lit ? '#ffd84a' : '#2a2e3d';
      ctx.beginPath();
      ctx.arc(cx - 14 - i * 14, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      const lit = i < state.bossRoundsWon;
      ctx.fillStyle = lit ? '#ff5470' : '#2a2e3d';
      ctx.beginPath();
      ctx.arc(cx + 14 + i * 14, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffd84a';
    ctx.font = 'bold 11px Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ROUND ' + state.round, cx, y + 4);
    ctx.textAlign = 'start';
    ctx.restore();
  }

  function drawRoundOverlay() {
    ctx.save();
    ctx.font = 'bold 56px Menlo, monospace';
    ctx.textAlign = 'center';
    if (state.time < state.roundIntroUntil && !state.matchOver) {
      const t = (state.roundIntroUntil - state.time) / ROUND_INTRO_DUR;
      const flash = Math.sin(state.time * 14) * 0.5 + 0.5;
      const showFight = t < 0.4;
      ctx.fillStyle = showFight ? `rgba(255, 84, 112, ${0.7 + 0.3 * flash})`
                                 : `rgba(255, 216, 74, ${0.85 + 0.15 * flash})`;
      ctx.fillText(showFight ? 'FIGHT!' : 'ROUND ' + state.round, W / 2, H / 2);
    } else if (state.roundOverAt && !state.matchOver) {
      const elapsed = state.time - state.roundOverAt;
      if (elapsed < 1.4) {
        ctx.fillStyle = 'rgba(255, 84, 112, 0.92)';
        ctx.fillText(state.roundOutcome === 'player' ? 'KO' : 'YOU LOSE', W / 2, H / 2);
      }
    }
    ctx.textAlign = 'start';
    ctx.restore();
  }

  function drawHpBar(x, y, w, h, pct, color, label, rightToLeft, pulse = false) {
    ctx.save();
    // Damage-pulse: red wash + white border flash for 0.45s.
    const pulseAmt = pulse ? (0.5 + 0.5 * Math.sin(state.time * 28)) : 0;
    ctx.fillStyle = pulse ? '#440a14' : '#0d0f15';
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    ctx.fillStyle = pulse ? '#ff5470' : color;
    const fillW = w * Math.max(0, Math.min(1, pct));
    if (rightToLeft) {
      ctx.fillRect(((x + w) - fillW) | 0, y | 0, fillW | 0, h | 0);
    } else {
      ctx.fillRect(x | 0, y | 0, fillW | 0, h | 0);
    }
    ctx.strokeStyle = pulse ? `rgba(255, 255, 255, ${0.5 + 0.5 * pulseAmt})` : '#2a2e3d';
    ctx.lineWidth = pulse ? 2 : 1;
    ctx.strokeRect((x + 0.5) | 0, (y + 0.5) | 0, (w - 1) | 0, (h - 1) | 0);
    ctx.fillStyle = '#e8e8ef';
    ctx.font = '10px Menlo, monospace';
    if (rightToLeft) {
      ctx.textAlign = 'right';
      ctx.fillText(label, x + w, y - 4);
      ctx.textAlign = 'start';
    } else {
      ctx.fillText(label, x, y - 4);
    }
    ctx.restore();
  }

  function drawStamBar(x, y, w, h, pct) {
    ctx.save();
    ctx.fillStyle = '#0d0f15';
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    ctx.fillStyle = '#5aa6ff';
    ctx.fillRect(x | 0, y | 0, (w * Math.max(0, Math.min(1, pct))) | 0, h | 0);
    ctx.strokeStyle = '#2a2e3d';
    ctx.strokeRect((x + 0.5) | 0, (y + 0.5) | 0, (w - 1) | 0, (h - 1) | 0);
    ctx.restore();
  }

  return {
    state,
    tick, render,
    setMoveInput,
    setBlock,
    triggerPlayerAction,
    resetArena,
  };
}

// --- Background painter (called once at boot) ---
function paintBackground(c) {
  // Sky gradient.
  const sky = c.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#0a0a14');
  sky.addColorStop(0.6, '#1a1024');
  sky.addColorStop(1, '#2a1a30');
  c.fillStyle = sky;
  c.fillRect(0, 0, W, GROUND_Y);

  // Distant silhouettes (single layer of mountains/spires).
  c.fillStyle = '#08060d';
  c.beginPath();
  c.moveTo(0, GROUND_Y);
  for (let x = 0; x <= W; x += 40) {
    const noise = Math.sin(x * 0.013) * 30 + Math.sin(x * 0.04) * 14;
    c.lineTo(x, GROUND_Y - 90 - noise);
  }
  c.lineTo(W, GROUND_Y);
  c.closePath();
  c.fill();

  // Mid pillars.
  for (let i = 0; i < 5; i++) {
    const x = 80 + i * 180 + (i % 2 ? 10 : -10);
    const h = 120 + (i % 3) * 30;
    c.fillStyle = '#0e0a18';
    c.fillRect(x, GROUND_Y - h, 26, h);
    c.fillStyle = '#1a1224';
    c.fillRect(x, GROUND_Y - h, 26, 8);
  }

  // Floor.
  const floor = c.createLinearGradient(0, GROUND_Y, 0, H);
  floor.addColorStop(0, '#1f1424');
  floor.addColorStop(1, '#08060c');
  c.fillStyle = floor;
  c.fillRect(0, GROUND_Y, W, H - GROUND_Y);

  // Ground line.
  c.strokeStyle = '#3a2540';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, GROUND_Y + 0.5);
  c.lineTo(W, GROUND_Y + 0.5);
  c.stroke();

  // Subtle floor stripes for depth (every 60px).
  c.strokeStyle = 'rgba(124, 100, 140, 0.08)';
  for (let x = -W; x < W * 2; x += 60) {
    c.beginPath();
    c.moveTo(x, GROUND_Y);
    c.lineTo(x + 80, H);
    c.stroke();
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
