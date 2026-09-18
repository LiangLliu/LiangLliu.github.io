(function () {
  'use strict';

  /* =====================================================================
     飞机大战 · 经典竖版射击（单文件）
     经典要素落点：
       · 脚本化波次编队       buildWave / FORM_*（横排·V 字·斜线·绕圈·正弦·两侧包夹）
       · 四类敌机 + 弹幕      ENEMY_DEF / updateEnemies / fireFan / fireRing
       · 每 5 波 Boss         spawnBoss / bossFire（三阶段·两个可破坏炮台）
       · 火力 5 级 + 死亡掉级  WPN 表 / updatePlayerFire / hitPlayer
       · 炸弹（清屏消弹）      useBomb
       · 小判定点 + 擦弹       HIT_R / GRAZE_R / updateEnemyBullets
       · 连击倍率             mult() / killEnemy
       · 三层视差蓝天          initClouds / drawClouds
       · DOM HUD + Boss 血条   updateHud / updateBossBar
     实体一律固定容量对象池 + swap-remove，主循环内零分配。
     ===================================================================== */

  /* ───────────────── 1. 随机源（mulberry32） ───────────────── */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let seed = 1;
  let seedLocked = false;    // setSeed() 指定过种子后不复掷，保证可复现
  let rng = mulberry32(seed);
  const fxRng = mulberry32(0xBEEF);      // 特效专用流，不干扰玩法序列
  const bgRng = mulberry32(0x5EED);      // 云朵专用流

  /* ───────────────── 2. 最高分存档（try/catch 退内存） ───────────────── */

  let useLS = false;
  let memBest = '0';
  try { localStorage.setItem('__sh_probe', '1'); localStorage.removeItem('__sh_probe'); useLS = true; }
  catch (e) { useLS = false; }

  function loadBest() {
    try {
      const v = useLS ? localStorage.getItem('shooter-best') : memBest;
      return v ? (Number(v) || 0) : 0;
    } catch (e) { return 0; }
  }
  function saveBest(v) {
    if (useLS) { try { localStorage.setItem('shooter-best', String(v)); } catch (e) { /* ignore */ } }
    else memBest = String(v);
  }

  /* ───────────────── 3. 常量 ───────────────── */

  const W = 360, H = 640, TAU = Math.PI * 2;

  const MAX_PB = 200;   // 我方子弹池
  const MAX_EB = 300;   // 敌方子弹池（也是屏上敌弹硬上限）
  const MAX_EN = 64;    // 敌机池
  const MAX_PW = 16;    // 道具池
  const MAX_PT = 320;   // 粒子池

  const HIT_R = 4;      // 判定半径（机体视觉宽 34px）
  const GRAZE_R = 20;   // 擦弹半径
  const P_SPEED = 5.4;  // 键盘速度
  const INVULN = 120;   // 复活无敌 2s
  const COMBO_T = 72;   // 连击窗口 1.2s
  const MAX_LIVES = 3, MAX_BOMBS = 5, MAX_WEAPON = 5;

  const PB_W = 4, PB_H = 14, PB_SPEED = 10;
  const EB_SPEED = 2.1; // 敌弹基准速度（×难度）

  const S_SMALL = 10, S_FAST = 15, S_MED = 50, S_HEAVY = 120;
  const S_BOSS = 1000, S_BOMB_LEFT = 200, S_PICK = 5, S_STAR = 100;
  const GRAZE_STEP = 100, GRAZE_SCORE = 500;

  const E_SMALL = 0, E_FAST = 1, E_MED = 2, E_HEAVY = 3;
  const ENEMY_DEF = [
    { hw: 13, hh: 12, hp: 1,  score: S_SMALL, name: 'small' },
    { hw: 12, hh: 15, hp: 1,  score: S_FAST,  name: 'fast' },
    { hw: 22, hh: 18, hp: 6,  score: S_MED,   name: 'medium' },
    { hw: 32, hh: 24, hp: 12, score: S_HEAVY, name: 'heavy' }
  ];

  const M_LINE = 0, M_SINE = 1, M_DIAG = 2, M_ARC = 3, M_STRAFE = 4, M_DESCEND = 5;

  const PW_POWER = 0, PW_BOMB = 1, PW_HEAL = 2, PW_STAR = 3;
  const PW_COLOR = ['#ef476f', '#1b9aaa', '#06d6a0', '#ffc43d'];
  const PW_LABEL = ['P', 'B', 'H', ''];

  const CB_ROSE = 0, CB_PLUM = 1;
  const EB_R = 4.4;

  /* ───────────────── 4. DOM ───────────────── */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const bestEl = document.getElementById('best');
  const scoreEl = document.getElementById('score');
  const floatEl = document.getElementById('float');
  const livesEl = document.getElementById('lives');
  const bombsEl = document.getElementById('bombs');
  const bombFloatEl = document.getElementById('bombFloat');
  const weaponEl = document.getElementById('weapon');
  const weaponFloatEl = document.getElementById('weaponFloat');
  const waveEl = document.getElementById('wave');
  const waveFloatEl = document.getElementById('waveFloat');
  const comboEl = document.getElementById('combo');
  const bossBarEl = document.getElementById('bossbar');
  const bossFillEl = document.getElementById('bossfill');
  const partEls = [document.getElementById('part0'), document.getElementById('part1')];
  const overlay = document.getElementById('overlay');
  const ovEmoji = document.getElementById('ovEmoji');
  const ovTitle = document.getElementById('ovTitle');
  const ovScore = document.getElementById('ovScore');
  const ovWave = document.getElementById('ovWave');
  const ovBest = document.getElementById('ovBest');
  const ovBomb = document.getElementById('ovBomb');
  const againBtn = document.getElementById('again');
  const restartBtn = document.getElementById('restart');
  const pauseBtn = document.getElementById('pauseBtn');
  const bombBtn = document.getElementById('bombBtn');

  /* ───────────────── 5. 天空 / 三层视差云 ───────────────── */

  let skyGrad = null;
  const CLOUD_LAYERS = [];

  (function initClouds() {
    // 层序：远（慢·淡）→ 近（快·浓），难度提升时整层加速
    const defs = [
      { n: 4, sp: 0.16, alpha: 0.26, puffs: 3 },
      { n: 3, sp: 0.32, alpha: 0.38, puffs: 4 },
      { n: 2, sp: 0.58, alpha: 0.52, puffs: 5 }
    ];
    for (let L = 0; L < defs.length; L++) {
      const d = defs[L];
      const items = [];
      for (let i = 0; i < d.n; i++) {
        const puffs = [];
        for (let k = 0; k < d.puffs; k++) {
          puffs.push({
            ox: (bgRng() - 0.5) * 84,
            oy: (bgRng() - 0.5) * 22,
            rx: 20 + bgRng() * 24,
            ry: 11 + bgRng() * 11
          });
        }
        items.push({ x: bgRng() * W, y: -80 + bgRng() * (H + 160), puffs: puffs });
      }
      CLOUD_LAYERS.push({ sp: d.sp, alpha: d.alpha, items: items });
    }
  })();

  /* ───────────────── 6. 对象池 ───────────────── */

  function makePool(n, factory) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(factory());
    return a;
  }

  const pb = makePool(MAX_PB, function () { return { x: 0, y: 0, vx: 0, vy: 0 }; });
  const eb = makePool(MAX_EB, function () { return { x: 0, y: 0, vx: 0, vy: 0, r: EB_R, ang: 0, shape: 0, col: 0, t: 0, gz: 0 }; });
  const en = makePool(MAX_EN, function () {
    return {
      x: 0, y: 0, vx: 0, vy: 0, hw: 12, hh: 12, hp: 1, maxHp: 1, kind: 0, mv: 0, t: 0,
      flash: 0, bx: 0, amp: 0, fr: 0, ph: 0, turn: 0, holdA: 0, holdB: 0, exitV: 0,
      fireT: 0, ringT: 0, aimT: 0, canFire: 0, wave: 0
    };
  });
  const pw = makePool(MAX_PW, function () { return { x: 0, y: 0, bx: 0, vy: 0, kind: 0, t: 0, sway: 0 }; });
  const pt = makePool(MAX_PT, function () { return { x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, shape: 0, col: '', grav: 0 }; });

  let pbN = 0, ebN = 0, enN = 0, pwN = 0, ptN = 0;

  function swapRemove(arr, n, i) {
    const last = n - 1;
    if (i !== last) { const t = arr[i]; arr[i] = arr[last]; arr[last] = t; }
    return last;
  }

  /* ───────────────── 7. 火力表（开机预计算，发射时零三角函数） ───────────────── */

  const WPN = [];
  (function initWeapons() {
    // [横向偏移, 纵向偏移, 角度(度)]
    const tables = [
      [[0, -6, 0]],
      [[-8, 0, 0], [8, 0, 0]],
      [[0, -8, 0], [-10, 4, -9], [10, 4, 9]],
      [[0, -8, 0], [-7, 3, -11], [-14, 7, -22], [7, 3, 11], [14, 7, 22]],
      [[0, -8, 0], [-7, 3, -9], [-14, 6, -18], [7, 3, 9], [14, 6, 18], [-16, 10, -30], [16, 10, 30], [-18, 12, -48], [18, 12, 48]]
    ];
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const o = { n: t.length, ox: [], oy: [], vx: [], vy: [] };
      for (let k = 0; k < t.length; k++) {
        const a = t[k][2] * Math.PI / 180;
        o.ox.push(t[k][0]); o.oy.push(t[k][1]);
        o.vx.push(Math.sin(a)); o.vy.push(-Math.cos(a));
      }
      WPN.push(o);
    }
  })();

  // 五角星单位顶点（道具 S 用）
  const STAR = [];
  (function initStar() {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const r = (i % 2 === 0) ? 1 : 0.45;
      STAR.push(Math.cos(a) * r, Math.sin(a) * r);
    }
  })();

  /* ───────────────── 8. 状态 ───────────────── */

  const player = { x: W / 2, y: H - 80, tilt: 0, flame: 0 };
  let pointerOn = false, ptrX = W / 2, ptrY = H - 80;
  let kL = false, kR = false, kU = false, kD = false;

  let score = 0, best = 0, lives = MAX_LIVES, bombs = 2, weapon = 1;
  let wave = 1, diff = 1, tick = 0;
  let over = false, paused = false;
  let invuln = 0, combo = 0, comboT = 0, graze = 0, grazeNext = GRAZE_STEP;
  let fireT = 0, bombCd = 0, flashA = 0, flashFill = '#ffffff';
  let dropCount = 0, dropHash = 0;   // 掉落序列指纹（复现性验证用，零分配）
  let waveAlive = 0, waveSpawnLeft = 0, waveSpawnIdx = 0, waveSpawnT = 0, waveT = 0, waveGapT = 0;
  let waveCadence = 13, seenMask = 0;
  let dpr = 1;

  const seenNames = [];
  const ORDER = [0, 1, 2, 3, 4, 5];
  const FORM_NAMES = ['line', 'vee', 'diag', 'circle', 'sine', 'flank'];

  // 波次槽位（开机分配，装填时不新建对象）
  const waveSlots = makePool(24, function () {
    return { x: 0, y: 0, vx: 0, vy: 0, kind: 0, mv: 0, bx: 0, amp: 0, fr: 0, ph: 0, turn: 0, tx: 0, ty: 0 };
  });

  /* ───────────────── 9. Boss ───────────────── */

  const boss = {
    on: false, x: W / 2, y: -120, hw: 54, hh: 38,
    hp: 0, maxHp: 0, phase: 1, t: 0, entry: 0, inv: 0, dying: 0,
    ringT: 0, spiralT: 0, spiralA: 0, flash: 0
  };
  const turrets = [
    { alive: false, hp: 0, maxHp: 8, ox: -48, oy: 6, hw: 18, hh: 16, t: 0 },
    { alive: false, hp: 0, maxHp: 8, ox: 48, oy: 6, hw: 18, hh: 16, t: 0 }
  ];

  /* ───────────────── 10. 工具 ───────────────── */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rnd() { return rng(); }
  function rndi(n) { return (rng() * n) | 0; }
  function ebSpeed() { return EB_SPEED + diff * 0.16; }
  function mult() { return 1 + Math.min(combo / 10, 2); }

  /* ───────────────── 11. 粒子 ───────────────── */

  function addSpark(x, y, vx, vy, life, size, col) {
    if (ptN >= MAX_PT) return;
    const p = pt[ptN++];
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life; p.size = size; p.shape = 0; p.col = col; p.grav = 0.05;
  }

  function addRing(x, y, size, col) {
    if (ptN >= MAX_PT) return;
    const p = pt[ptN++];
    p.x = x; p.y = y; p.vx = 0; p.vy = 0;
    p.life = 18; p.maxLife = 18; p.size = size; p.shape = 1; p.col = col; p.grav = 0;
  }

  function explodeAt(x, y, col) {
    addRing(x, y, 46, col);
    for (let i = 0; i < 9; i++) {
      const a = fxRng() * TAU;
      const s = 1 + fxRng() * 3.4;
      addSpark(x, y, Math.cos(a) * s, Math.sin(a) * s, 18 + (fxRng() * 16 | 0), 2 + fxRng() * 3, col);
    }
    for (let i = 0; i < 4; i++) {
      const a = fxRng() * TAU;
      addSpark(x, y, Math.cos(a) * 1.4, Math.sin(a) * 1.4, 12 + (fxRng() * 10 | 0), 2, '#fffdf2');
    }
  }

  function updateParticles() {
    for (let i = 0; i < ptN; i++) {
      const p = pt[i];
      p.x += p.vx; p.y += p.vy; p.vy += p.grav;
      if (--p.life <= 0) { ptN = swapRemove(pt, ptN, i); i--; }
    }
  }

  /* ───────────────── 12. 反馈（DOM 事件级，不在帧循环里拼字符串） ───────────────── */

  function doFlash(fill, a) { flashFill = fill; flashA = a; }

  function shakeStage() {
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
  }

  function showFloat(el, text) {
    el.textContent = text;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  /* ───────────────── 13. 敌机生成 ───────────────── */

  function scaledHp(kind) {
    const base = ENEMY_DEF[kind].hp;
    if (kind < E_MED) return base;
    return Math.round(base * (1 + (diff - 1) * 0.14));
  }

  function spawnEnemy(kind, x, y, mv, vx, vy) {
    if (enN >= MAX_EN) return -1;
    const d = ENEMY_DEF[kind];
    const e = en[enN++];
    e.kind = kind;
    e.x = x; e.y = y; e.vx = vx; e.vy = vy;
    e.hw = d.hw; e.hh = d.hh;
    e.hp = e.maxHp = scaledHp(kind);
    e.mv = mv; e.t = 0; e.flash = 0;
    e.bx = x; e.amp = 0; e.fr = 0.04; e.ph = 0; e.turn = 0;
    e.holdA = 0; e.holdB = 0; e.exitV = 0;
    e.fireT = 60 + rndi(70);
    e.ringT = 90 + rndi(60);
    e.aimT = 60 + rndi(40);
    e.canFire = (kind === E_SMALL && rnd() < 0.22) ? 1 : 0;
    e.wave = wave;
    waveAlive++;
    return enN - 1;
  }

  /* ───────────────── 14. 弹幕 ───────────────── */

  function spawnEB(x, y, vx, vy, col, shape) {
    if (ebN >= MAX_EB) return -1;
    const b = eb[ebN++];
    b.x = x; b.y = y; b.vx = vx; b.vy = vy;
    b.r = shape === 1 ? 3.9 : EB_R;
    b.ang = Math.atan2(vy, vx) + Math.PI / 2;
    b.shape = shape; b.col = col; b.t = 0; b.gz = 0;
    return ebN - 1;
  }

  // 自机狙：发射瞬间锁定玩家位置
  function fireFan(x, y, n, spread, speed, col, shape) {
    const base = Math.atan2(player.y - y, player.x - x);
    const k0 = (n - 1) * 0.5;
    for (let k = 0; k < n; k++) {
      const a = base + (k - k0) * spread;
      spawnEB(x, y, Math.cos(a) * speed, Math.sin(a) * speed, col, shape);
    }
  }

  // 环形弹
  function fireRing(cx, cy, n, speed, phase, col) {
    for (let k = 0; k < n; k++) {
      const a = phase + k * TAU / n;
      spawnEB(cx, cy, Math.cos(a) * speed, Math.sin(a) * speed, col, 0);
    }
  }

  /* ───────────────── 15. 波次 / 编队 ───────────────── */

  function shuffleOrder() {
    for (let i = ORDER.length - 1; i > 0; i--) {
      const j = rndi(i + 1);
      const t = ORDER[i]; ORDER[i] = ORDER[j]; ORDER[j] = t;
    }
  }

  function buildWave(f, d) {
    const S = waveSlots;
    const extra = Math.min(3, d - 1);
    let n = 0, i, s;

    // 编队之外的“压阵”单位：中级机横切停留、重装机下压驻留
    // 编队 f 和波次槽位是随机绑定的：压阵单位只按 f 给，会有约七成开局整局见不到
    // 中级/重装机（实测 2000 个种子：71% 无中级机、70% 无重装机）。因此补一条
    // 只跟难度挂钩的保底（d>=3 出中级、d>=4 出重装），保证两种机都能玩到。
    const medN = f === 1 ? (d >= 4 ? 2 : 1) : (f === 5 && d >= 2 ? 2 : (d >= 3 ? 1 : 0));
    for (i = 0; i < medN; i++) {
      s = S[n++];
      const fromLeft = (i & 1) === 0;
      s.kind = E_MED; s.mv = M_STRAFE;
      s.x = fromLeft ? -44 : W + 44;
      s.y = 100 + i * 56;
      s.tx = fromLeft ? W * 0.32 + i * 20 : W * 0.68 - i * 20;
      s.vx = fromLeft ? 2.4 : -2.4;
      s.vy = 0;
    }
    const heavyN = (d >= 4 || (f === 5 && d >= 3)) ? 1 : 0;
    for (i = 0; i < heavyN; i++) {
      s = S[n++];
      s.kind = E_HEAVY; s.mv = M_DESCEND;
      s.x = f === 0 ? W * 0.5 : W * (0.34 + i * 0.32);
      s.y = -46;
      s.vy = 0.62 + d * 0.03;
      s.ty = 122 + i * 44;
    }

    if (f === 0) {                       // 横排
      const m = 6 + extra;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = E_SMALL; s.mv = M_LINE;
        s.x = 34 + i * ((W - 68) / (m - 1));
        s.y = -30 - (i % 2) * 24;
        s.vx = 0; s.vy = 1.7 + d * 0.09;
      }
      if (d >= 3) {                      // 两翼换快攻
        S[n - m].kind = E_FAST; S[n - 1].kind = E_FAST;
        S[n - m].vy = 2.6 + d * 0.12; S[n - 1].vy = 2.6 + d * 0.12;
      }

    } else if (f === 1) {                // V 字
      const m = 7 + (extra > 0 ? 2 : 0);
      const mid = (m - 1) / 2;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = E_SMALL; s.mv = M_LINE;
        s.x = W / 2 + (i - mid) * 40;
        s.y = -28 - Math.abs(i - mid) * 26;
        s.vx = 0; s.vy = 1.55 + d * 0.09;
      }

    } else if (f === 2) {                // 斜线（从侧上方切入）
      const m = 6 + extra;
      const dir = rnd() < 0.5 ? -1 : 1;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = (i % 3 === 2 && d >= 2) ? E_FAST : E_SMALL;
        s.mv = M_DIAG;
        s.x = dir > 0 ? (-34 - i * 22) : (W + 34 + i * 22);
        s.y = -26 - i * 32;
        s.vx = dir * (1.7 + d * 0.09);
        s.vy = 2.0 + d * 0.1;
      }

    } else if (f === 3) {                // 绕圈（弧线入场后离场）
      const m = 5 + (extra > 1 ? 1 : 0);
      const dir = rnd() < 0.5 ? -1 : 1;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = E_SMALL; s.mv = M_ARC;
        s.x = W / 2 - dir * (6 + i * 16);
        s.y = -34 - i * 14;
        s.vx = dir * (0.45 + i * 0.12);
        s.vy = 2.3 + d * 0.08;
        s.turn = dir * 0.020;
      }

    } else if (f === 4) {                // 正弦波
      const m = 6 + extra;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = (i === m - 1 && d >= 3) ? E_FAST : E_SMALL;
        s.mv = M_SINE;
        s.x = 44 + i * ((W - 88) / (m - 1));
        s.y = -28 - i * 10;
        s.bx = s.x;
        s.vx = 0; s.vy = 1.35 + d * 0.07;
        s.amp = 32 + (i % 3) * 12;
        s.fr = 0.045 + (i % 2) * 0.012;
        s.ph = i * 0.9;
      }

    } else {                             // 两侧包夹
      const half = 2 + (extra > 1 ? 1 : 0);
      for (i = 0; i < half * 2; i++) {
        s = S[n++];
        const side = i < half ? -1 : 1;
        const k = i % half;
        s.kind = E_FAST; s.mv = M_DIAG;
        s.x = side < 0 ? (-36 - k * 32) : (W + 36 + k * 32);
        s.y = 108 + k * 46;
        s.vx = side * (2.5 + d * 0.12);
        s.vy = 0.35;
      }
      const m = 4 + extra;
      for (i = 0; i < m; i++) {
        s = S[n++];
        s.kind = E_SMALL; s.mv = M_SINE;
        s.x = 50 + i * ((W - 100) / (m - 1));
        s.y = -30 - i * 12;
        s.bx = s.x;
        s.vx = 0; s.vy = 1.5 + d * 0.08;
        s.amp = 26 + (i % 2) * 14;
        s.fr = 0.05;
        s.ph = i * 1.1;
      }
    }
    return n;
  }

  function spawnSlot(i) {
    const s = waveSlots[i];
    const k = spawnEnemy(s.kind, s.x, s.y, s.mv, s.vx, s.vy);
    if (k < 0) return;
    const e = en[k];
    e.bx = s.bx; e.amp = s.amp; e.fr = s.fr; e.ph = s.ph; e.turn = s.turn;

    if (s.mv === M_STRAFE) {             // 中级：横切入场 → 停留开火 → 离场
      e.holdA = Math.max(1, Math.round(Math.abs(s.tx - s.x) / Math.max(0.4, Math.abs(s.vx))));
      e.holdB = e.holdA + 150 + rndi(70);
      e.bx = s.tx;
    } else if (s.mv === M_DESCEND) {     // 重装：下压到指定高度后驻留
      e.holdA = Math.max(1, Math.round((s.ty - s.y) / Math.max(0.2, s.vy)));
      e.holdB = e.holdA + 420;
      e.exitV = 1.7;
    }
  }

  function startWave() {
    waveAlive = 0; waveSpawnLeft = 0; waveSpawnIdx = 0; waveT = 0;
    diff = Math.min(10, 1 + ((wave - 1) >> 1));
    if (wave % 5 === 0) { spawnBoss(); return; }

    const f = ORDER[(wave - 1) % 6];
    const n = buildWave(f, diff);
    seenMask |= (1 << f);
    waveSpawnLeft = n;
    waveCadence = f === 5 ? 7 : (f === 2 ? 10 : (f === 3 ? 11 : 13));
    waveSpawnT = 30;
    showFloat(waveFloatEl, 'WAVE ' + wave);
  }

  function endWave() {
    wave++;
    waveGapT = 54;
    diff = Math.min(10, 1 + ((wave - 1) >> 1));
  }

  function updateWave() {
    if (boss.on) return;
    if (waveGapT > 0) {
      if (--waveGapT === 0) startWave();
      return;
    }
    if (waveSpawnLeft > 0) {
      if (--waveSpawnT <= 0) {
        spawnSlot(waveSpawnIdx++);
        waveSpawnLeft--;
        waveSpawnT = waveCadence;
      }
      return;
    }
    if (waveAlive <= 0 || waveT > 1100) endWave();
  }

  /* ───────────────── 16. Boss ───────────────── */

  function spawnBoss() {
    boss.on = true;
    boss.x = W / 2;
    boss.y = -120;
    boss.maxHp = 90 + diff * 45;
    boss.hp = boss.maxHp;
    boss.phase = 1; boss.t = 0; boss.entry = 110; boss.inv = 0; boss.dying = 0;
    boss.ringT = 120; boss.spiralT = 0; boss.spiralA = 0; boss.flash = 0;
    for (let i = 0; i < 2; i++) {
      turrets[i].alive = true;
      turrets[i].maxHp = 8;
      turrets[i].hp = 8;
      turrets[i].t = 60 + i * 30;
    }
    showFloat(waveFloatEl, 'BOSS');
    updateBossBar(true);
  }

  function bossPhaseCheck() {
    const np = boss.hp > boss.maxHp * 2 / 3 ? 1 : (boss.hp > boss.maxHp / 3 ? 2 : 3);
    if (np > boss.phase) {
      boss.phase = np;
      boss.inv = 60;                       // 阶段切换短暂无敌 + 全屏闪白
      boss.flash = 8;
      doFlash('#ffffff', 0.6);
      fireRing(boss.x, boss.y, 18, ebSpeed() * 0.9, boss.t * 0.04, CB_PLUM);
    }
  }

  function bossDefeat() {
    boss.dying = 84;
    boss.inv = 0;
    ebN = 0;
    score += S_BOSS;
    doFlash('#ffffff', 0.5);
    shakeStage();
    for (let i = 0; i < 3; i++) {
      spawnPowerup(boss.x + (i - 1) * 46, boss.y + 10, i === 0 ? PW_POWER : (i === 1 ? PW_BOMB : PW_STAR));
    }
  }

  function damageBoss(n, part, force) {
    if (!boss.on || boss.dying > 0 || boss.entry > 0) return false;
    if (part === 0 || part === 1) {
      const t = turrets[part];
      if (!t.alive) return false;
      t.hp -= n;
      if (t.hp <= 0) {
        t.hp = 0; t.alive = false;
        explodeAt(boss.x + t.ox, boss.y + t.oy, '#ffd470');
        score += 200;
      }
      updateBossBar(true);
      return true;
    }
    if (boss.inv > 0 && !force) { boss.flash = 4; return false; }
    boss.hp -= n;
    boss.flash = 4;
    if (boss.hp <= 0) { boss.hp = 0; bossDefeat(); return true; }
    bossPhaseCheck();
    updateBossBar(true);
    return true;
  }

  function bossFire() {
    const b = boss, sp = ebSpeed();
    // 两个炮台：打掉后对应弹幕消失
    if (turrets[0].alive && --turrets[0].t <= 0) {
      turrets[0].t = Math.max(46, 84 - diff * 4);
      fireFan(b.x + turrets[0].ox, b.y + turrets[0].oy, b.phase >= 3 ? 5 : 4, 0.24, sp, CB_ROSE, 1);
    }
    if (turrets[1].alive && --turrets[1].t <= 0) {
      turrets[1].t = Math.max(52, 96 - diff * 4);
      fireFan(b.x + turrets[1].ox, b.y + turrets[1].oy, b.phase >= 2 ? 3 : 2, 0.30, sp * 1.1, CB_PLUM, 1);
    }

    if (b.phase === 1) {                   // 试探：慢速浮动弹
      if (--b.ringT <= 0) {
        b.ringT = 96;
        for (let k = 0; k < 3; k++) {
          const a = -0.5 + k * 0.5;
          spawnEB(b.x + (k - 1) * 34, b.y + 30, Math.sin(a) * 1.0, 1.05, CB_PLUM, 2);
        }
      }
    } else if (b.phase === 2) {            // 暴走：环形 + 更密
      if (--b.ringT <= 0) {
        b.ringT = Math.max(70, 104 - diff * 4);
        fireRing(b.x, b.y + 10, 10 + Math.min(4, diff), sp * 0.85, b.t * 0.05, CB_PLUM);
      }
    } else {                               // 绝招：旋转螺旋 + 环形
      if (--b.spiralT <= 0) {
        b.spiralT = 3;
        b.spiralA += 0.27;
        spawnEB(b.x, b.y + 12, Math.cos(b.spiralA) * sp * 0.9, Math.sin(b.spiralA) * sp * 0.9, CB_ROSE, 0);
        spawnEB(b.x, b.y + 12, -Math.cos(b.spiralA) * sp * 0.9, -Math.sin(b.spiralA) * sp * 0.9, CB_PLUM, 0);
      }
      if (--b.ringT <= 0) {
        b.ringT = 120;
        fireRing(b.x, b.y + 10, 14, sp * 0.8, b.t * 0.07, CB_ROSE);
      }
    }
  }

  function updateBossFight() {
    const b = boss;
    b.t++;
    if (b.flash > 0) b.flash--;
    if (b.entry > 0) {
      b.entry--;
      b.y += 1.85;
      if (b.y >= 96) { b.y = 96; b.entry = 0; }
      return;
    }
    if (b.dying > 0) {
      b.dying--;
      if ((b.dying & 3) === 0) explodeAt(b.x + (fxRng() - 0.5) * 110, b.y + (fxRng() - 0.5) * 70, fxRng() < 0.5 ? '#ef476f' : '#ffc43d');
      if (b.dying === 0) {
        boss.on = false;
        updateBossBar(false);
        endWave();
      }
      return;
    }
    if (b.inv > 0) { b.inv--; return; }
    bossFire();
  }

  /* ───────────────── 17. 敌机行为 ───────────────── */

  function onScreen(e) { return e.y > 8 && e.y < H - 70; }

  function medFire(e) {
    if (--e.fireT > 0) return;
    e.fireT = Math.max(48, 96 - diff * 4) + rndi(40);
    if (!onScreen(e)) return;
    fireFan(e.x, e.y + e.hh, 3 + (diff >= 4 ? 2 : 0), 0.28, ebSpeed(), CB_ROSE, 1);
  }

  function heavyFire(e) {
    if (--e.ringT <= 0) {
      e.ringT = Math.max(84, 150 - diff * 7);
      if (e.y > 20 && e.y < H - 110) {
        fireRing(e.x, e.y, 8 + Math.min(4, (diff >> 1) * 2), ebSpeed() * 0.8, e.t * 0.05, CB_PLUM);
      }
    }
    if (--e.aimT <= 0) {
      e.aimT = Math.max(70, 120 - diff * 5);
      if (e.y > 20 && e.y < H - 70) fireFan(e.x, e.y + e.hh, 1, 0, ebSpeed() * 1.05, CB_ROSE, 1);
    }
  }

  function moveEnemy(e) {
    if (e.mv === M_LINE) {
      e.y += e.vy;
    } else if (e.mv === M_SINE) {
      e.y += e.vy;
      e.x = e.bx + Math.sin(e.t * e.fr + e.ph) * e.amp;
    } else if (e.mv === M_DIAG) {
      e.x += e.vx; e.y += e.vy;
    } else if (e.mv === M_ARC) {
      if (e.t < 90) {                     // 画弧入场
        const c = Math.cos(e.turn), s = Math.sin(e.turn);
        const vx = e.vx * c - e.vy * s;
        const vy = e.vx * s + e.vy * c;
        e.vx = vx; e.vy = vy;
      } else {                            // 弧线走完 → 俯冲离场
        e.vy += 0.05;
      }
      e.x += e.vx; e.y += e.vy;
    } else if (e.mv === M_STRAFE) {        // 中级机：横切→停留→离场
      if (e.t < e.holdA) e.x += e.vx;
      else if (e.t > e.holdB) e.x += e.vx * 1.3;
    } else {                              // M_DESCEND：重装机下压→驻留→离场
      if (e.t < e.holdA) e.y += e.vy;
      else if (e.t > e.holdB) e.y += e.exitV;
    }
  }

  function killEnemy(idx, byBomb) {
    const e = en[idx];
    /* 只有本波敌机才减计数：上一波超时残留下来的敌机（e.wave < wave）被算进来
       会把本波计数减成负数，导致本波提前结束、场上还留着敌机 */
    if (e.wave === wave) waveAlive--;
    const base = ENEMY_DEF[e.kind].score;
    combo = comboT > 0 ? combo + 1 : 1;
    comboT = COMBO_T;
    score += Math.round(base * mult());
    explodeAt(e.x, e.y, e.kind === E_SMALL ? '#ef476f' : (e.kind === E_FAST ? '#ffc43d' : '#ffd470'));
    showFloat(floatEl, '+' + Math.round(base * mult()));
    if (!byBomb) {
      if (e.kind === E_MED && rnd() < 0.36) dropRandom(e.x, e.y);
      else if (e.kind === E_HEAVY) dropRandom(e.x, e.y);
    }
    enN = swapRemove(en, enN, idx);
  }

  function dropRandom(x, y) {
    const r = rnd();
    const k = r < 0.44 ? PW_POWER : (r < 0.72 ? PW_STAR : (r < 0.88 ? PW_BOMB : PW_HEAL));
    spawnPowerup(x, y, k);
  }

  function updateEnemies() {
    for (let i = 0; i < enN; i++) {
      const e = en[i];
      e.t++;
      if (e.flash > 0) e.flash--;
      moveEnemy(e);

      if (e.kind === E_SMALL) {
        if (e.canFire === 1 && --e.fireT <= 0) {
          e.canFire = 0;
          if (onScreen(e)) spawnEB(e.x, e.y + e.hh, 0, ebSpeed() * 0.85, CB_ROSE, 1);
        }
      } else if (e.kind === E_MED) {
        medFire(e);
      } else if (e.kind === E_HEAVY) {
        heavyFire(e);
      }

      if (e.y > H + 70 || e.x < -100 || e.x > W + 100 || e.y < -280) {
        if (e.wave === wave) waveAlive--;
        enN = swapRemove(en, enN, i); i--;
        continue;
      }

      // 撞机
      if (invuln <= 0 && !over &&
          Math.abs(e.x - player.x) < e.hw + HIT_R &&
          Math.abs(e.y - player.y) < e.hh + HIT_R) {
        explodeAt(e.x, e.y, '#ffc43d');
        if (e.wave === wave) waveAlive--;
        enN = swapRemove(en, enN, i); i--;
        hitPlayer();
      }
    }
  }

  /* ───────────────── 18. 道具 ───────────────── */

  function spawnPowerup(x, y, kind) {
    if (pwN >= MAX_PW) return;
    const p = pw[pwN++];
    p.x = x; p.y = y; p.bx = x;
    p.vy = 0.9 + rnd() * 0.5;
    p.kind = kind; p.t = 0; p.sway = 0.06 + rnd() * 0.05;
    dropCount++;
    dropHash = (dropHash * 31 + kind + 1) | 0;
  }

  function updatePowerups() {
    for (let i = 0; i < pwN; i++) {
      const p = pw[i];
      p.t++;
      p.y += p.vy;
      p.x = p.bx + Math.sin(p.t * p.sway) * 7;
      if (p.y > H + 24) { pwN = swapRemove(pw, pwN, i); i--; continue; }
      if (!over &&
          Math.abs(p.x - player.x) < 22 && Math.abs(p.y - player.y) < 22) {
        pickPowerup(p.kind);
        pwN = swapRemove(pw, pwN, i); i--;
      }
    }
  }

  function pickPowerup(kind) {
    score += S_PICK;
    if (kind === PW_POWER) {
      if (weapon < MAX_WEAPON) { weapon++; showFloat(weaponFloatEl, '火力 ' + weapon); }
      else { score += 300; showFloat(weaponFloatEl, '+300'); }
    } else if (kind === PW_BOMB) {
      if (bombs < MAX_BOMBS) { bombs++; showFloat(bombFloatEl, '炸弹 ' + bombs); }
      else { score += 300; showFloat(bombFloatEl, '+300'); }
    } else if (kind === PW_HEAL) {
      if (lives < MAX_LIVES) { lives++; showFloat(floatEl, '+1 命'); }
      else { score += 300; showFloat(floatEl, '+300'); }
    } else {
      score += S_STAR;
      showFloat(floatEl, '+' + S_STAR);
    }
    updateHud();
  }

  /* ───────────────── 19. 炸弹 ───────────────── */

  function useBomb() {
    if (bombs <= 0 || over || paused || bombCd > 0 || !player) return;
    bombs--;
    bombCd = 30;
    if (invuln < INVULN) invuln = INVULN;
    doFlash('#ffffff', 0.85);
    shakeStage();
    addRing(player.x, player.y, 300, '#ffffff');
    ebN = 0;                                   // 消弹：清空屏上所有敌弹
    for (let i = 0; i < enN; i++) {            // 秒杀小兵 / 快攻，重装固定伤害
      const e = en[i];
      if (e.kind <= E_FAST) { killEnemy(i, true); i--; }
      else if (e.kind === E_HEAVY) { e.hp -= 6; e.flash = 6; if (e.hp <= 0) { killEnemy(i, true); i--; } }
    }
    if (boss.on && boss.dying === 0 && boss.entry === 0) damageBoss(40, -1, true);
    updateHud();
  }

  /* ───────────────── 20. 命中 / 掉命 / 结束 ───────────────── */

  function hitPlayer() {
    if (invuln > 0 || over) return;
    lives--;
    if (weapon > 1) weapon--;
    combo = 0; comboT = 0;
    invuln = INVULN;
    doFlash('#ffc0d0', 0.55);
    shakeStage();
    // 复活窗口：清掉贴脸敌弹，避免无敌结束时被原地秒
    for (let i = 0; i < ebN; i++) {
      const b = eb[i];
      const dx = b.x - player.x, dy = b.y - player.y;
      if (dx * dx + dy * dy < 4900) { ebN = swapRemove(eb, ebN, i); i--; }
    }
    updateHud();
    if (lives <= 0) { lives = 0; gameOver(); }
  }

  function gameOver() {
    over = true;
    const bonus = bombs * S_BOMB_LEFT;
    score += bonus;
    best = Math.max(best, score);
    saveBest(best);
    ovEmoji.textContent = '💥';
    ovTitle.textContent = '游戏结束';
    ovScore.textContent = String(score);
    ovWave.textContent = String(wave);
    ovBest.textContent = String(best);
    ovBomb.textContent = '+' + bonus;
    againBtn.textContent = '再试一次';
    overlay.classList.add('on');
    updateHud();
  }

  /* ───────────────── 21. 玩家 ───────────────── */

  function updatePlayer() {
    let dx = 0, dy = 0;
    if (kL) dx--;
    if (kR) dx++;
    if (kU) dy--;
    if (kD) dy++;
    if (dx !== 0 || dy !== 0) {
      if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
      player.x += dx * P_SPEED;
      player.y += dy * P_SPEED;
    }
    if (pointerOn) {
      player.x += (ptrX - player.x) * 0.34;   // 轻微平滑
      player.y += (ptrY - player.y) * 0.34;
    }
    player.x = clamp(player.x, 16, W - 16);
    player.y = clamp(player.y, 30, H - 18);

    let tilt = (kL ? -0.28 : 0) + (kR ? 0.28 : 0);
    if (pointerOn) tilt += clamp((ptrX - player.x) * 0.014, -0.22, 0.22);
    player.tilt += (clamp(tilt, -0.34, 0.34) - player.tilt) * 0.2;
  }

  function updatePlayerFire() {
    if (--fireT > 0) return;
    const pat = WPN[weapon - 1];
    fireT = weapon >= 4 ? 8 : 7;
    for (let i = 0; i < pat.n; i++) {
      if (pbN >= MAX_PB) return;
      const b = pb[pbN++];
      b.x = player.x + pat.ox[i];
      b.y = player.y + pat.oy[i];
      b.vx = pat.vx[i] * PB_SPEED;
      b.vy = pat.vy[i] * PB_SPEED;
    }
  }

  function updatePlayerBullets() {
    for (let i = 0; i < pbN; i++) {
      const b = pb[i];
      b.x += b.vx; b.y += b.vy;
      if (b.y < -24 || b.x < -24 || b.x > W + 24) { pbN = swapRemove(pb, pbN, i); i--; continue; }
      let hit = false;

      for (let j = 0; j < enN; j++) {
        const e = en[j];
        if (Math.abs(b.x - e.x) < e.hw + 3 && Math.abs(b.y - e.y) < e.hh + 8) {
          e.hp--; e.flash = 5;
          hit = true;
          addSpark(b.x, b.y - 4, 0, -1.2, 8, 3, '#fffdf2');
          if (e.hp <= 0) killEnemy(j, false);
          break;
        }
      }

      if (!hit && boss.on && boss.entry === 0 && boss.dying === 0) {
        let done = false;
        for (let k = 0; k < 2; k++) {
          const t = turrets[k];
          if (!t.alive) continue;
          if (Math.abs(b.x - (boss.x + t.ox)) < t.hw + 3 && Math.abs(b.y - (boss.y + t.oy)) < t.hh + 8) {
            damageBoss(1, k, false);
            hit = true; done = true;
            break;
          }
        }
        if (!done && Math.abs(b.x - boss.x) < boss.hw + 3 && Math.abs(b.y - boss.y) < boss.hh + 8) {
          if (boss.inv > 0) { boss.flash = 3; hit = true; }
          else { damageBoss(1, -1, false); hit = true; }
        }
      }

      if (hit) { pbN = swapRemove(pb, pbN, i); i--; }
    }
  }

  /* ───────────────── 22. 敌弹 / 擦弹 ───────────────── */

  function updateEnemyBullets() {
    for (let i = 0; i < ebN; i++) {
      const b = eb[i];
      b.x += b.vx; b.y += b.vy;
      if (b.shape === 2) {                                              // 慢速浮动弹
        b.t++;
        b.x += Math.sin(b.t * 0.06) * 0.8;
      }
      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) { ebN = swapRemove(eb, ebN, i); i--; continue; }

      if (!over) {
        const dx = b.x - player.x, dy = b.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (invuln <= 0) {
          const rr = b.r + HIT_R;
          if (d2 < rr * rr) { ebN = swapRemove(eb, ebN, i); i--; hitPlayer(); continue; }
        }
        if (b.gz === 0) {
          const gr = b.r + GRAZE_R;
          if (d2 < gr * gr) {
            b.gz = 1;
            graze++;
            if (graze >= grazeNext) {
              grazeNext += GRAZE_STEP;
              score += GRAZE_SCORE;
              showFloat(floatEl, '+500 擦弹');
            }
          }
        }
      }
    }
  }

  /* ───────────────── 23. 主循环 ───────────────── */

  function step() {
    tick++;
    player.flame = (tick & 3) + 6;
    if (flashA > 0) { flashA -= 0.03; if (flashA < 0) flashA = 0; }
    if (bombCd > 0) bombCd--;
    updateClouds();

    if (paused) return;
    if (over) { updateParticles(); return; }

    if (invuln > 0) invuln--;
    if (comboT > 0) { comboT--; if (comboT === 0) combo = 0; }
    waveT++;

    updatePlayer();
    updatePlayerFire();
    updatePlayerBullets();
    updateEnemies();
    if (boss.on) updateBossFight();
    updateEnemyBullets();
    updatePowerups();
    updateParticles();
    updateWave();
    updateHud();
    updateBossBar(false);
  }

  /* ───────────────── 24. 背景推进 ───────────────── */

  function updateClouds() {
    const mul = 1 + (diff - 1) * 0.16;
    for (let L = 0; L < CLOUD_LAYERS.length; L++) {
      const layer = CLOUD_LAYERS[L];
      const sp = layer.sp * mul;
      for (let i = 0; i < layer.items.length; i++) {
        const c = layer.items[i];
        c.y += sp;
        if (c.y > H + 90) { c.y = -90; c.x = bgRng() * W; }
      }
    }
  }

  /* ───────────────── 25. 渲染 ───────────────── */

  function drawClouds() {
    for (let L = 0; L < CLOUD_LAYERS.length; L++) {
      const layer = CLOUD_LAYERS[L];
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < layer.items.length; i++) {
        const c = layer.items[i];
        ctx.beginPath();
        for (let k = 0; k < c.puffs.length; k++) {
          const p = c.puffs[k];
          ctx.moveTo(c.x + p.ox + p.rx, c.y + p.oy);
          ctx.ellipse(c.x + p.ox, c.y + p.oy, p.rx, p.ry, 0, 0, TAU);
        }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayerBullets() {
    ctx.fillStyle = '#ffc43d';
    ctx.beginPath();
    for (let i = 0; i < pbN; i++) {
      const b = pb[i];
      ctx.rect(b.x - PB_W / 2, b.y - PB_H / 2, PB_W, PB_H);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (let i = 0; i < pbN; i++) {
      const b = pb[i];
      ctx.rect(b.x - 0.5, b.y - PB_H / 2, 1, PB_H * 0.7);
    }
    ctx.fill();
  }

  function drawPlayer() {
    const blink = invuln > 0 && ((tick >> 2) & 1) === 0;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.tilt);

    // 尾焰
    const fl = player.flame + (kU || pointerOn ? 4 : 0);
    ctx.fillStyle = 'rgba(255,196,61,0.9)';
    ctx.beginPath();
    ctx.moveTo(-5, 13);
    ctx.quadraticCurveTo(0, 13 + fl, 5, 13);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(-2.5, 13);
    ctx.quadraticCurveTo(0, 13 + fl * 0.55, 2.5, 13);
    ctx.closePath();
    ctx.fill();

    // 机身（青绿）
    ctx.fillStyle = blink ? '#bfeee1' : '#06d6a0';
    ctx.strokeStyle = '#14727e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -17);
    ctx.quadraticCurveTo(7, -12, 8.5, 2);
    ctx.quadraticCurveTo(9, 12, 14, 15);
    ctx.quadraticCurveTo(0, 12, -14, 15);
    ctx.quadraticCurveTo(-9, 12, -8.5, 2);
    ctx.quadraticCurveTo(-7, -12, 0, -17);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 主翼
    ctx.fillStyle = '#1b9aaa';
    ctx.beginPath();
    ctx.moveTo(-14, 15);
    ctx.lineTo(-6, -1);
    ctx.lineTo(6, -1);
    ctx.lineTo(14, 15);
    ctx.lineTo(6, 11);
    ctx.lineTo(-6, 11);
    ctx.closePath();
    ctx.fill();

    // 高光 + 座舱
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(-3.5, -6, 2.2, 6, 0.35, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fffdf2';
    ctx.beginPath();
    ctx.arc(0, -6, 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1b9aaa';
    ctx.beginPath();
    ctx.arc(0, -6, 1.3, 0, TAU);
    ctx.fill();

    // 判定点（经典小判定提示）
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ef476f';
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawEnemy(e) {
    const f = e.flash > 0;
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.kind === E_SMALL) {
      ctx.fillStyle = f ? '#fff' : '#ef476f';
      ctx.strokeStyle = '#b02c4f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 12);
      ctx.lineTo(-9, -2);
      ctx.lineTo(-13, -11);
      ctx.lineTo(-4, -7);
      ctx.lineTo(4, -7);
      ctx.lineTo(13, -11);
      ctx.lineTo(9, -2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = f ? '#b02c4f' : '#fffdf2';
      ctx.beginPath(); ctx.arc(0, -1, 2.6, 0, TAU); ctx.fill();
    } else if (e.kind === E_FAST) {
      ctx.fillStyle = f ? '#fff' : '#ffc43d';
      ctx.strokeStyle = '#c98a00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 15);
      ctx.lineTo(-6, 2);
      ctx.lineTo(-11, -13);
      ctx.lineTo(0, -6);
      ctx.lineTo(11, -13);
      ctx.lineTo(6, 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = f ? '#c98a00' : '#fffdf2';
      ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, TAU); ctx.fill();
    } else if (e.kind === E_MED) {
      ctx.fillStyle = f ? '#fff' : '#ffd470';
      ctx.strokeStyle = '#c98a00';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, 18);
      ctx.lineTo(-22, 4);
      ctx.lineTo(-13, -12);
      ctx.lineTo(13, -12);
      ctx.lineTo(22, 4);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // 引擎舱
      ctx.fillStyle = f ? '#c98a00' : '#e8a33d';
      ctx.fillRect(-22, -6, 7, 14);
      ctx.fillRect(15, -6, 7, 14);
      // 座舱
      ctx.fillStyle = f ? '#a8761f' : '#14727e';
      ctx.beginPath(); ctx.ellipse(0, 2, 7, 9, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.ellipse(-2, 0, 2.6, 4.4, 0, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = f ? '#fff' : '#14727e';
      ctx.strokeStyle = '#0b4750';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 24);
      ctx.lineTo(-24, 14);
      ctx.lineTo(-32, -8);
      ctx.lineTo(-16, -18);
      ctx.lineTo(16, -18);
      ctx.lineTo(32, -8);
      ctx.lineTo(24, 14);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // 装甲板
      ctx.fillStyle = f ? '#d8f2ef' : '#22c2d6';
      ctx.fillRect(-24, -10, 48, 6);
      ctx.fillRect(-30, -6, 8, 16);
      ctx.fillRect(22, -6, 8, 16);
      // 炮口
      ctx.fillStyle = '#0b4750';
      ctx.fillRect(-16, 14, 6, 9);
      ctx.fillRect(10, 14, 6, 9);
      // 舰桥
      ctx.fillStyle = f ? '#a8e6dd' : '#06d6a0';
      ctx.beginPath(); ctx.ellipse(0, 6, 9, 8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.ellipse(-2.5, 4, 3, 4, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function drawBoss() {
    const b = boss;
    const f = b.flash > 0 || (b.inv > 0 && ((tick >> 2) & 1));
    ctx.save();
    ctx.translate(b.x, b.y);

    // 可破坏炮台
    for (let k = 0; k < 2; k++) {
      const t = turrets[k];
      if (!t.alive) {
        ctx.fillStyle = '#8b8b86';
        ctx.beginPath();
        ctx.rect(t.ox - t.hw, t.oy - t.hh, t.hw * 2, t.hh * 2);
        ctx.fill();
        ctx.fillStyle = '#6f6f6a';
        ctx.fillRect(t.ox - 6, t.oy - 3, 12, 6);
        continue;
      }
      ctx.fillStyle = f ? '#fff' : '#ffc43d';
      ctx.strokeStyle = '#a8761f';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(t.ox - t.hw, t.oy - t.hh + 5);
      ctx.lineTo(t.ox + t.hw, t.oy - t.hh + 5);
      ctx.lineTo(t.ox + t.hw - 3, t.oy + t.hh);
      ctx.lineTo(t.ox - t.hw + 3, t.oy + t.hh);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#a8761f';
      ctx.fillRect(t.ox - 3, t.oy + t.hh - 3, 6, 7);
    }

    // 本体：深玫红 + 金属灰
    ctx.fillStyle = f ? '#fff' : '#a01b45';
    ctx.strokeStyle = '#5f1029';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-44, -20);
    ctx.lineTo(-54, 8);
    ctx.lineTo(-30, 30);
    ctx.lineTo(30, 30);
    ctx.lineTo(54, 8);
    ctx.lineTo(44, -20);
    ctx.lineTo(20, -38);
    ctx.lineTo(-20, -38);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = f ? '#e8e8e4' : '#9aa5a8';
    ctx.fillRect(-42, -14, 84, 8);
    ctx.fillRect(-30, 16, 60, 7);

    // 舰桥 / 核心
    ctx.fillStyle = f ? '#ffd9e2' : '#ef476f';
    ctx.beginPath(); ctx.ellipse(0, -6, 17, 13, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.ellipse(-4, -9, 5, 6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#5f1029';
    ctx.beginPath(); ctx.arc(0, 4, 4, 0, TAU); ctx.fill();

    // 阶段标记
    ctx.fillStyle = '#ffc43d';
    for (let k = 0; k < boss.phase; k++) ctx.fillRect(-12 + k * 10, 26, 7, 4);
    ctx.restore();
  }

  function drawEnemyBullets() {
    // 分色批绘：玫红 / 紫红
    for (let c = 0; c < 2; c++) {
      const fill = c === CB_ROSE ? '#ef476f' : '#c73e8f';
      const line = c === CB_ROSE ? '#7d1436' : '#6a1450';
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let i = 0; i < ebN; i++) {
        const b = eb[i];
        if (b.col !== c) continue;
        if (b.shape === 1) {
          ctx.moveTo(b.x + b.r * 1.5, b.y);
          ctx.ellipse(b.x, b.y, b.r, b.r * 1.5, b.ang, 0, TAU);
        } else {
          ctx.moveTo(b.x + b.r, b.y);
          ctx.arc(b.x, b.y, b.r, 0, TAU);
        }
      }
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.fillStyle = '#fffdf2';
    ctx.beginPath();
    for (let i = 0; i < ebN; i++) {
      const b = eb[i];
      ctx.moveTo(b.x + 1.4, b.y - 1.2);
      ctx.arc(b.x - 0.6, b.y - 1.4, 1.4, 0, TAU);
    }
    ctx.fill();
  }

  function drawPowerups() {
    for (let i = 0; i < pwN; i++) {
      const p = pw[i];
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.kind === PW_STAR) {
        ctx.fillStyle = '#ffc43d';
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const sx = STAR[k * 2] * 10, sy = STAR[k * 2 + 1] * 10;
          if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }
      ctx.fillStyle = PW_COLOR[p.kind];
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(-3, -3.5, 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fffdf2';
      ctx.font = '700 13px -apple-system, "PingFang SC", Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(PW_LABEL[p.kind], 0, 1);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (let i = 0; i < ptN; i++) {
      const p = pt[i];
      const t = p.life / p.maxLife;
      if (p.shape === 1) {
        ctx.globalAlpha = t * 0.9;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (1 - t) * p.size, 0, TAU);
        ctx.stroke();
      } else {
        ctx.globalAlpha = t;
        ctx.fillStyle = p.col;
        const s = p.size * (0.4 + t * 0.6);
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);
    drawClouds();
    drawPowerups();
    drawPlayerBullets();
    for (let i = 0; i < enN; i++) drawEnemy(en[i]);
    if (boss.on) drawBoss();
    if (!over) drawPlayer();
    drawEnemyBullets();
    drawParticles();
    if (flashA > 0) {
      ctx.globalAlpha = flashA;
      ctx.fillStyle = flashFill;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  let acc = 0, last = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (!last) last = ts;
    acc += ts - last;
    last = ts;
    if (acc > 200) acc = 200;
    let guard = 0;
    while (acc >= 16.6667 && guard < 5) { step(); acc -= 16.6667; guard++; }
    if (guard === 0) return;
    render();
  }

  /* ───────────────── 26. HUD（改值才写 DOM） ───────────────── */

  let lastScore = -1, lastBest = -1, lastLives = -1, lastBombs = -1;
  let lastWeapon = -1, lastWave = -1, lastCombo = -1, lastBossHp = -1, lastPhase = -1;
  let barShown = false;
  const lastPartHp = [-1, -1];

  function updateHud() {
    if (score !== lastScore) { lastScore = score; scoreEl.textContent = String(score); }
    const bv = score > best ? score : best;
    if (bv !== lastBest) { lastBest = bv; bestEl.textContent = String(bv); }
    if (lives !== lastLives) { lastLives = lives; livesEl.dataset.lives = String(lives); }
    if (bombs !== lastBombs) { lastBombs = bombs; bombsEl.textContent = String(bombs); }
    if (weapon !== lastWeapon) { lastWeapon = weapon; weaponEl.textContent = String(weapon); }
    if (wave !== lastWave) { lastWave = wave; waveEl.textContent = String(wave); }
    if (combo !== lastCombo) {
      lastCombo = combo;
      if (combo >= 2) {
        comboEl.textContent = combo + ' 连击 ×' + mult().toFixed(1);
        comboEl.classList.add('on');
      } else {
        comboEl.classList.remove('on');
      }
    }
  }

  function updateBossBar(force) {
    if (!boss.on) {
      if (barShown) { barShown = false; bossBarEl.classList.remove('on'); }
      return;
    }
    if (!barShown) { barShown = true; bossBarEl.classList.add('on'); }
    const pct = Math.max(0, Math.round(boss.hp / boss.maxHp * 100));
    if (force || pct !== lastBossHp) { lastBossHp = pct; bossFillEl.style.width = pct + '%'; }
    if (force || boss.phase !== lastPhase) {
      lastPhase = boss.phase;
      bossBarEl.dataset.phase = String(boss.phase);
    }
    for (let k = 0; k < 2; k++) {
      const t = turrets[k];
      const hp = t.alive ? t.hp : -1;
      if (force || hp !== lastPartHp[k]) {
        lastPartHp[k] = hp;
        if (t.alive) {
          partEls[k].classList.remove('dead');
          partEls[k].style.width = Math.round(t.hp / t.maxHp * 22) + 'px';
        } else {
          partEls[k].classList.add('dead');
          partEls[k].style.width = '22px';
        }
      }
    }
  }

  /* ───────────────── 27. 开局 / 重开 ───────────────── */

  function hideOverlay() { overlay.classList.remove('on'); }

  function initState() {
    /* 每局重掷种子。否则波次编队顺序（ORDER）、敌机开火时机、掉落全部走同一串
       随机数：第二局和第一局完全一样。setSeed() 指定过种子时保持复现。 */
    if (!seedLocked) seed = (Math.random() * 0x100000000) >>> 0;
    rng = mulberry32(seed);
    for (let i = 0; i < ORDER.length; i++) ORDER[i] = i;
    shuffleOrder();

    pbN = ebN = enN = pwN = ptN = 0;
    player.x = W / 2; player.y = H - 80; player.tilt = 0;
    ptrX = player.x; ptrY = player.y; pointerOn = false;
    kL = kR = kU = kD = false;

    score = 0; lives = MAX_LIVES; bombs = 2; weapon = 1;
    wave = 1; diff = 1; tick = 0;
    over = false; paused = false;
    invuln = 0; combo = 0; comboT = 0; graze = 0; grazeNext = GRAZE_STEP;
    fireT = 0; bombCd = 0; flashA = 0; flashFill = '#ffffff';
    dropCount = 0; dropHash = 0;
    waveAlive = 0; waveSpawnLeft = 0; waveSpawnIdx = 0; waveSpawnT = 0; waveT = 0; waveGapT = 0;
    seenMask = 0;

    boss.on = false; boss.dying = 0; boss.entry = 0; boss.hp = 0; boss.phase = 1;
    turrets[0].alive = false; turrets[1].alive = false;

    lastScore = lastBest = lastLives = lastBombs = lastWeapon = lastWave = -1;
    lastCombo = lastBossHp = lastPhase = -1;
    lastPartHp[0] = lastPartHp[1] = -1;
    bossBarEl.classList.remove('on');
    barShown = false;
    comboEl.classList.remove('on');

    startWave();
    updateHud();
    updateBossBar(true);
  }

  function restart() {
    initState();
    hideOverlay();
    canvas.focus();
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) {
      ovEmoji.textContent = '⏸';
      ovTitle.textContent = '已暂停';
      ovScore.textContent = String(score);
      ovWave.textContent = String(wave);
      ovBest.textContent = String(Math.max(best, score));
      ovBomb.textContent = '+' + (bombs * S_BOMB_LEFT);
      againBtn.textContent = '继续';
      overlay.classList.add('on');
    } else {
      hideOverlay();
    }
  }

  /* ───────────────── 28. 输入 ───────────────── */

  function normDir(k) {
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') return 0;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') return 1;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') return 2;
    if (k === 'ArrowDown' || k === 's' || k === 'S') return 3;
    return -1;
  }

  function setDir(d, on) {
    if (d === 0) kL = on;
    else if (d === 1) kR = on;
    else if (d === 2) kU = on;
    else if (d === 3) kD = on;
  }

  function nudge(d) {
    if (d === 0) player.x -= P_SPEED;
    else if (d === 1) player.x += P_SPEED;
    else if (d === 2) player.y -= P_SPEED;
    else if (d === 3) player.y += P_SPEED;
    player.x = clamp(player.x, 16, W - 16);
    player.y = clamp(player.y, 30, H - 18);
  }

  function press(key) {
    const d = normDir(key);
    if (d >= 0) { setDir(d, true); nudge(d); setDir(d, false); return true; }
    if (key === ' ' || key === 'Space' || key === 'Spacebar') { useBomb(); return true; }
    if (key === 'p' || key === 'P' || key === 'Escape') { togglePause(); return true; }
    if (key === 'r' || key === 'R') { restart(); return true; }
    if (key === 'Enter') {
      if (paused && !over) togglePause();
      else if (over) restart();
      return true;
    }
    return false;
  }

  /* 点过按钮后立刻移走焦点：焦点留在按钮上时，再按空格会被浏览器解释成
     “再按一次那个按钮”（重新开始 / 继续 / 再放一颗炸弹）。画布不受影响。 */
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.tagName === 'BUTTON' && t.blur) setTimeout(function () { t.blur(); }, 0);
  });

  window.addEventListener('keydown', function (ev) {
    const d = normDir(ev.key);
    if (d >= 0) { ev.preventDefault(); setDir(d, true); return; }
    if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); useBomb(); return; }
    if (ev.key === 'p' || ev.key === 'P' || ev.key === 'Escape') { ev.preventDefault(); togglePause(); return; }
    if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); restart(); return; }
    if (ev.key === 'Enter' && over) { ev.preventDefault(); restart(); }
  });

  window.addEventListener('keyup', function (ev) {
    const d = normDir(ev.key);
    if (d >= 0) setDir(d, false);
  });

  /* 失焦 / 切后台时收不到 keyup 与 pointerup：不清状态，机体会一直朝那个方向漂 */
  function releaseInput() {
    kL = kR = kU = kD = false;
    pointerOn = false;
  }
  window.addEventListener('blur', releaseInput);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseInput();
  });

  function localPos(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp((ev.clientX - r.left) * (W / r.width), 16, W - 16),
      y: clamp((ev.clientY - r.top) * (H / r.height), 30, H - 18)
    };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    const p = localPos(ev);
    ptrX = p.x; ptrY = p.y;
    pointerOn = true;
    canvas.focus();
    if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!pointerOn) return;
    const p = localPos(ev);
    ptrX = p.x; ptrY = p.y;
    ev.preventDefault();
  });

  canvas.addEventListener('pointerup', function () { pointerOn = false; });
  canvas.addEventListener('pointercancel', function () { pointerOn = false; });

  /* ───────────────── 29. 测试钩子 ───────────────── */

  function snapshot() {
    const exs = [], eys = [], eks = [], bx = [], by = [], pks = [];
    for (let i = 0; i < enN; i++) { exs.push(Math.round(en[i].x)); eys.push(Math.round(en[i].y)); eks.push(ENEMY_DEF[en[i].kind].name); }
    for (let i = 0; i < ebN; i++) { bx.push(Math.round(eb[i].x)); by.push(Math.round(eb[i].y)); }
    for (let i = 0; i < pwN; i++) pks.push(PW_LABEL[pw[i].kind] || 'S');
    const parts = [];
    for (let i = 0; i < 2; i++) parts.push({ hp: turrets[i].hp, maxHp: turrets[i].maxHp, alive: turrets[i].alive });
    return {
      score: score,
      best: best,
      over: over,
      paused: paused,
      lives: lives,
      player: { x: Math.round(player.x), y: Math.round(player.y) },
      bullets: pbN,
      enemyBullets: ebN,
      enemies: enN,
      powerups: pwN,
      weapon: weapon,
      bombs: bombs,
      wave: wave,
      difficulty: diff,
      boss: boss.on ? { hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase, parts: parts } : null,
      combo: combo,
      graze: graze,
      level: diff,
      // 扩展（便于验证器逐系统检查）
      formation: (boss.on || wave % 5 === 0) ? 'boss' : FORM_NAMES[ORDER[(wave - 1) % 6]],
      formationsSeen: FORM_NAMES.filter(function (nm, i) { return (seenMask >> i) & 1; }),
      enemyXs: exs, enemyYs: eys, enemyKinds: eks,
      enemyBulletXs: bx, enemyBulletYs: by,
      powerupKinds: pks,
      invuln: invuln,
      tick: tick, drops: dropCount, dropHash: dropHash
    };
  }

  function hookSpawn(kind, x, y) {
    let k = kind;
    if (typeof k === 'string') {
      if (k === 'P' || k === 'power') { spawnPowerup(x === undefined ? W / 2 : x, y === undefined ? 160 : y, PW_POWER); return true; }
      if (k === 'B' || k === 'bombItem') { spawnPowerup(x === undefined ? W / 2 : x, y === undefined ? 160 : y, PW_BOMB); return true; }
      if (k === 'H' || k === 'heal') { spawnPowerup(x === undefined ? W / 2 : x, y === undefined ? 160 : y, PW_HEAL); return true; }
      if (k === 'S' || k === 'star') { spawnPowerup(x === undefined ? W / 2 : x, y === undefined ? 160 : y, PW_STAR); return true; }
      k = -1;
      for (let i = 0; i < ENEMY_DEF.length; i++) if (ENEMY_DEF[i].name === kind) { k = i; break; }
      if (k < 0) return false;
    }
    if (k < 0 || k >= ENEMY_DEF.length) return false;
    const idx = spawnEnemy(k, x === undefined ? W / 2 : x, y === undefined ? 120 : y, M_LINE, 0, 0.6);
    return idx >= 0;
  }

  function hookGrant(n) {
    n = n | 0;
    weapon = clamp(n, 1, MAX_WEAPON);
    updateHud();
    return weapon;
  }

  function hookBombAdd(n) {
    bombs = clamp(bombs + (n | 0), 0, MAX_BOMBS);
    updateHud();
    return bombs;
  }

  function hookDamageBoss(n, part) {
    return damageBoss(n | 0, part === undefined ? -1 : part, true);
  }

  function hookForceBoss() {
    if (boss.on) return false;
    ebN = 0;
    waveSpawnLeft = 0; waveSpawnIdx = 0; waveGapT = 0;
    waveAlive = 0;
    wave = Math.max(wave, Math.ceil(wave / 5) * 5);
    diff = Math.min(10, 1 + ((wave - 1) >> 1));
    spawnBoss();
    updateHud();
    return true;
  }

  function hookSetPlayer(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
    player.x = clamp(x, 16, W - 16);
    player.y = clamp(y, 30, H - 18);
    ptrX = player.x; ptrY = player.y;
    pointerOn = false;
    return { x: Math.round(player.x), y: Math.round(player.y) };
  }

  function hookPools() {
    return {
      bullets: pbN, bulletsMax: MAX_PB,
      enemyBullets: ebN, enemyBulletsMax: MAX_EB,
      enemies: enN, enemiesMax: MAX_EN,
      powerups: pwN, powerupsMax: MAX_PW,
      particles: ptN, particlesMax: MAX_PT,
      domNodes: document.getElementsByTagName('*').length
    };
  }

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: function (n) { seed = n >>> 0; seedLocked = true; },
    spawn: hookSpawn,
    grantWeapon: hookGrant,
    addBomb: hookBombAdd,
    damageBoss: hookDamageBoss,
    forceBoss: hookForceBoss,
    setPlayer: hookSetPlayer,
    pools: hookPools,
    useBomb: useBomb
  };

  /* ───────────────── 30. 尺寸 / 启动 ───────────────── */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, '#bfe8f5');
    skyGrad.addColorStop(0.62, '#dcf1f9');
    skyGrad.addColorStop(1, '#eaf7fb');
  }

  bombBtn.addEventListener('click', function (ev) { ev.preventDefault(); useBomb(); });
  pauseBtn.addEventListener('click', function (ev) { ev.preventDefault(); togglePause(); });
  pauseBtn.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
  restartBtn.addEventListener('click', restart);
  againBtn.addEventListener('click', function () {
    if (paused && !over) togglePause();
    else restart();
  });

  best = loadBest();
  initState();
  resize();
  window.addEventListener('resize', resize);
  canvas.focus();
  requestAnimationFrame(loop);
})();
