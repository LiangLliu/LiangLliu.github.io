/* 俄罗斯方块 · Tetris Guideline（现代标准）深度重写
 *
 * 规则来源（tetris.wiki）：
 *   [1] Tetris Guideline   → 10×20 场地、SRS、7-bag、Hold、0.5s 锁定延迟、幽灵、预览、马拉松曲线
 *   [2] Super Rotation System → JLSTZ 与 I 各一套踢墙表（此处 y 轴已翻转为屏幕坐标：下为正）
 *   [3] T-Spin             → 3-corner 判定：前角 2 + 后角 ≥1 = 完整 T-spin；前角 1 + 后角 2 = mini，
 *                            若最后一次旋转用的是第 5 次踢墙（SRS 最后一项，中心位移 1×2）则升级为完整
 *   [4] Scoring            → Single/Double/Triple/Tetris、T-spin 各档、B2B ×1.5、Combo 50n×L、
 *                            Perfect Clear 表、软降 1/格、硬降 2/格
 *   [5] Marathon           → 固定目标（每级 10 行，上限 15 级）；速度 t=(0.8-0.007(L-1))^(L-1) 秒/格
 *   [6] 40 lines / Ultra   → 冲刺计时终点 / 限时计分终点
 *
 * 与 NES·Game Boy 原版的差异（刻意采纳现代版）：
 *   原版无硬降、无 Hold、无踢墙（旋转会失败）、纯随机（可能连续同块）、触底即锁（无锁定延迟）。
 *   本作全部采用 Guideline 现代规则：把原版"纯反应"的压力换成现代"规划 + 速度"的压力。
 */
(function () {
  'use strict';

  /* ═══════════════ 1. 常量 ═══════════════ */

  var COLS = 10, ROWS = 20, CELL = 22;
  var BOARD_W = COLS * CELL, BOARD_H = ROWS * CELL;

  var HOLD_CELL = 11, HOLD_W = HOLD_CELL * 4, HOLD_H = HOLD_CELL * 2 + 8;
  var PRE_CELL = 9, PRE_W = PRE_CELL * 4, PRE_SLOT = PRE_CELL * 2 + 8, PREVIEWS = 5;
  var PRE_H = PRE_SLOT * PREVIEWS;

  /* 手感：Guideline 推荐 DAS 10 帧@120Hz ≈ 167ms、ARR 2 帧 ≈ 33ms */
  var DAS_MS = 167, ARR_MS = 33, SOFT_MS = 33;
  var LOCK_MS = 500, LOCK_RESET_MAX = 15;
  var LEVEL_CAP = 15;

  /* 消行动画时间轴：冻结（命中停顿）→ 闪白 → 逐列塌陷 */
  var FREEZE_BASE = 30, FREEZE_PER_LINE = 20, FLASH_MS = 70;
  var COLLAPSE_STAGGER = 8, COLLAPSE_FALL = 120;
  var SQUASH_MS = 130, TRAIL_MS = 160, SHAKE_MS = 190, LEVEL_FLASH_MS = 420;

  var MODE_LIST = ['marathon', 'sprint', 'ultra'];
  var MODE_NAME = { marathon: '马拉松', sprint: '40 行冲刺', ultra: '2 分钟限时' };
  var MARATHON_GOAL = 150, SPRINT_GOAL = 40, ULTRA_MS = 120000;

  /* Guideline 分数表（× 消行前等级）；索引 = 消行数 */
  var SCORE_NORMAL = [0, 100, 300, 500, 800];
  var SCORE_MINI = [100, 200, 400, 0, 0];
  var SCORE_TSPIN = [400, 800, 1200, 1600, 0];
  var SCORE_PC = [0, 800, 1200, 1800, 2000];
  var PC_B2B_TETRIS = 3200;
  var CLEAR_NAME = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];

  var HANDLED = {
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, ' ': 1, Space: 1, Spacebar: 1,
    x: 1, X: 1, z: 1, Z: 1, c: 1, C: 1, Shift: 1, p: 1, P: 1, r: 1, R: 1, m: 1, M: 1,
    Enter: 1, w: 1, W: 1, a: 1, A: 1, s: 1, S: 1, d: 1, D: 1, '1': 1, '2': 1, '3': 1
  };

  /* ═══════════════ 2. 存档（file:// 下 localStorage 会抛 SecurityError） ═══════════════ */

  var store = (function () {
    try {
      var probe = '__tetris_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (e) {
      var mem = Object.create(null);
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  })();

  var KEY_BEST = { marathon: 'tetris.best.marathon.v2', sprint: 'tetris.best.sprint.v2', ultra: 'tetris.best.ultra.v2' };
  var KEY_LEGACY = 'tetris.best.v1';
  var KEY_MUTED = 'tetris.muted.v1';

  function readBest(mode) {
    var v = Number(store.getItem(KEY_BEST[mode]));
    if (!(v > 0) && mode === 'marathon') v = Number(store.getItem(KEY_LEGACY)) || 0;
    return v > 0 ? v : 0;
  }

  function writeBest(mode, v) {
    try { store.setItem(KEY_BEST[mode], String(Math.round(v))); } catch (e) { /* 忽略写失败 */ }
  }

  /* ═══════════════ 3. 随机源 ═══════════════ */

  /* 方块序列用可播种 PRNG（setSeed 可复现）；视觉特效另用一个独立 PRNG，
     避免屏震/粒子消耗 rng() 而改变后续出块顺序。 */
  var seed = 1;
  var seedPinned = false;   /* setSeed 之后锁住：测试要可复现，玩家每局要换牌 */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(seed);
  var vrng = mulberry32(0x9E3779B9);

  /* ═══════════════ 4. 方块几何 + SRS 踢墙表 ═══════════════ */

  var BASE = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]]
  };
  var TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  var ID = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };   /* 棋盘存值，沿用旧档 1..7 */
  var BY_ID = ['', 'I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  var COLOR = {
    I: '#22c2d6', J: '#4a7fd4', L: '#ff9f1c', O: '#ffc43d',
    S: '#06d6a0', Z: '#ef476f', T: '#a06cd5'
  };
  var BY_ID_COLOR = ['#000000', COLOR.I, COLOR.O, COLOR.T, COLOR.S, COLOR.Z, COLOR.J, COLOR.L];

  function rotateCW(m) {
    var n = m.length, out = [], i, j, row;
    for (i = 0; i < n; i++) {
      row = [];
      for (j = 0; j < n; j++) row.push(m[n - 1 - j][i]);
      out.push(row);
    }
    return out;
  }

  /* ROT[type][rot] = { cells: 扁平 [dx,dy,…], mat: 矩阵（供 snapshot）, minX/minY/maxX/maxY } */
  var ROT = {};
  (function () {
    for (var k = 0; k < TYPES.length; k++) {
      var t = TYPES[k], states = [], m = BASE[t];
      for (var r = 0; r < 4; r++) {
        var flat = [], minX = 8, minY = 8, maxX = -1, maxY = -1;
        for (var i = 0; i < m.length; i++) {
          for (var j = 0; j < m.length; j++) {
            if (!m[i][j]) continue;
            flat.push(j, i);
            if (j < minX) minX = j;
            if (j > maxX) maxX = j;
            if (i < minY) minY = i;
            if (i > maxY) maxY = i;
          }
        }
        states.push({
          cells: Int8Array.from(flat), mat: m,
          minX: minX, minY: minY, maxX: maxX, maxY: maxY
        });
        m = rotateCW(m);
      }
      ROT[t] = states;
    }
  })();

  /* 生成点：3 格宽方块居中偏左（x=3），O 在 x=4，I 占 3..6；顶行对齐可见区第 0 行 */
  var SPAWN_X = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
  var SPAWN_Y = {};
  (function () {
    for (var k = 0; k < TYPES.length; k++) SPAWN_Y[TYPES[k]] = -ROT[TYPES[k]][0].minY;
  })();

  /* SRS 踢墙表。来源 tetris.wiki/Super_Rotation_System；dx 右为正、dy 下为正（原表 y 向上，此处取反）。
     每行：[起始态, 目标态, 5 次测试 × (dx,dy)]。0=spawn 1=R 2=2 3=L。 */
  var KICK_SRC = {
    JLSTZ: [
      [0, 1, 0, 0, -1, 0, -1, -1, 0, 2, -1, 2],
      [1, 0, 0, 0, 1, 0, 1, 1, 0, -2, 1, -2],
      [1, 2, 0, 0, 1, 0, 1, 1, 0, -2, 1, -2],
      [2, 1, 0, 0, -1, 0, -1, -1, 0, 2, -1, 2],
      [2, 3, 0, 0, 1, 0, 1, -1, 0, 2, 1, 2],
      [3, 2, 0, 0, -1, 0, -1, 1, 0, -2, -1, -2],
      [3, 0, 0, 0, -1, 0, -1, 1, 0, -2, -1, -2],
      [0, 3, 0, 0, 1, 0, 1, -1, 0, 2, 1, 2]
    ],
    I: [
      [0, 1, 0, 0, -2, 0, 1, 0, -2, 1, 1, -2],
      [1, 0, 0, 0, 2, 0, -1, 0, 2, -1, -1, 2],
      [1, 2, 0, 0, -1, 0, 2, 0, -1, -2, 2, 1],
      [2, 1, 0, 0, 1, 0, -2, 0, 1, 2, -2, -1],
      [2, 3, 0, 0, 2, 0, -1, 0, 2, -1, -1, 2],
      [3, 2, 0, 0, -2, 0, 1, 0, -2, 1, 1, -2],
      [3, 0, 0, 0, 1, 0, -2, 0, 1, 2, -2, -1],
      [0, 3, 0, 0, -1, 0, 2, 0, -1, -2, 2, 1]
    ]
  };

  function buildKicks(src) {
    var table = new Array(16);
    for (var i = 0; i < src.length; i++) {
      var row = src[i];
      table[row[0] * 4 + row[1]] = Int8Array.from(row.slice(2));
    }
    return table;
  }
  var KICK_L = buildKicks(KICK_SRC.JLSTZ);
  var KICK_I = buildKicks(KICK_SRC.I);

  /* ═══════════════ 5. DOM ═══════════════ */

  function $(id) { return document.getElementById(id); }
  var el = {
    board: $('board'), next: $('next'), hold: $('hold'),
    score: $('score'), best: $('best'), lines: $('lines'), level: $('level'),
    bestLabel: $('best-label'), status: $('status'),
    float: $('float'), levelFloat: $('level-float'),
    callout: $('callout'), calloutMain: $('callout-main'), calloutSub: $('callout-sub'),
    overlay: $('overlay'), overlayEmoji: $('overlay-emoji'),
    overlayTitle: $('overlay-title'), overlaySub: $('overlay-sub'),
    again: $('again'), restartBtn: $('restart'), muteBtn: $('mute'), frame: $('frame'),
    rLines: $('r-lines'), rTime: $('r-time'), rPps: $('r-pps'), rCombo: $('r-combo'),
    rTspin: $('r-tspin'), rTetris: $('r-tetris'), rBest: $('r-best'), rBestLabel: $('r-best-label')
  };

  var px = Math.min(window.devicePixelRatio || 1, 2);

  function setupCanvas(canvas, w, h) {
    canvas.width = Math.round(w * px);
    canvas.height = Math.round(h * px);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    var c = canvas.getContext('2d');
    c.setTransform(px, 0, 0, px, 0, 0);
    return c;
  }
  var ctx = setupCanvas(el.board, BOARD_W, BOARD_H);
  var nctx = setupCanvas(el.next, PRE_W, PRE_H);
  var hctx = setupCanvas(el.hold, HOLD_W, HOLD_H);

  /* ═══════════════ 6. 音效（WebAudio 合成，零外部文件） ═══════════════ */

  var sfx = (function () {
    var ac = null, master = null, muted = store.getItem(KEY_MUTED) === '1';
    var activated = false;

    /* 只在真实用户手势后创建 AudioContext：避免自动播放策略在控制台留下告警 */
    function ensure() {
      if (muted || !activated) return null;
      try {
        if (!ac) {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return null;
          ac = new Ctor();
          master = ac.createGain();
          master.gain.value = 0.17;
          master.connect(ac.destination);
        }
        if (ac.state === 'suspended' && ac.resume) ac.resume();
        return ac;
      } catch (e) {
        ac = null;
        return null;
      }
    }

    function tone(freq, dur, wave, gain, delay, endFreq) {
      var c = ensure();
      if (!c) return;
      try {
        var t0 = c.currentTime + (delay || 0);
        var osc = c.createOscillator(), g = c.createGain();
        osc.type = wave || 'square';
        osc.frequency.setValueAtTime(freq, t0);
        if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
      } catch (e) { /* 音频异常不影响游戏 */ }
    }

    function arp(notes, step, dur, wave, gain) {
      for (var i = 0; i < notes.length; i++) tone(notes[i], dur, wave, gain, i * step);
    }

    return {
      unlock: function (trusted) {
        if (!trusted) return;
        activated = true;
        ensure();
      },
      isMuted: function () { return muted; },
      setMuted: function (m) {
        muted = !!m;
        try { store.setItem(KEY_MUTED, muted ? '1' : '0'); } catch (e) { /* 忽略 */ }
      },
      move: function () { tone(200, 0.03, 'square', 0.22, 0, 160); },
      rotate: function () { tone(340, 0.045, 'triangle', 0.26, 0, 460); },
      hold: function () { tone(520, 0.07, 'sine', 0.3, 0, 680); },
      deny: function () { tone(140, 0.05, 'sawtooth', 0.14, 0, 110); },
      lock: function () { tone(130, 0.09, 'sine', 0.36, 0, 72); },
      drop: function () { tone(90, 0.11, 'sine', 0.38, 0, 55); },
      clear: function (n) {
        var base = 523;
        arp([base, base * 1.26, base * 1.5, base * 2], 0.055, 0.11, 'triangle', 0.3);
        if (n >= 4) {
          tone(131, 0.34, 'sine', 0.38, 0, 65);
          tone(1046, 0.3, 'triangle', 0.2, 0.22, 1568);
        }
      },
      tspin: function () { arp([784, 1046, 1318, 1568], 0.05, 0.12, 'square', 0.22); },
      b2b: function () { tone(1568, 0.14, 'triangle', 0.2, 0.16, 2093); },
      combo: function (n) {
        var f = 480 + Math.min(n, 12) * 70;
        tone(f, 0.07, 'square', 0.24, 0, f * 1.5);
      },
      perfect: function () { arp([1046, 1318, 1568, 2093], 0.06, 0.22, 'triangle', 0.24); },
      levelup: function () { arp([659, 784, 988, 1318], 0.07, 0.16, 'triangle', 0.24); },
      over: function () { arp([440, 370, 294, 220], 0.13, 0.26, 'sine', 0.28); },
      win: function () { arp([523, 659, 784, 1046, 1318], 0.1, 0.28, 'triangle', 0.28); },
      pause: function () { tone(300, 0.06, 'sine', 0.18, 0, 220); }
    };
  })();

  /* ═══════════════ 7. 状态 ═══════════════ */

  var board = new Uint8Array(COLS * ROWS);
  var cur = null;                       /* { type, rot, x, y } */
  var bag = [], queue = new Array(PREVIEWS);
  var holdType = null, holdUsed = false;

  var score = 0, lines = 0, level = 1, comboChain = 0, b2b = false;
  var over = false, paused = false;
  var mode = 'marathon', elapsed = 0, timeLeft = ULTRA_MS;
  var bests = { marathon: readBest('marathon'), sprint: readBest('sprint'), ultra: readBest('ultra') };
  var bestBeaten = false;   /* 本局是否刷新过纪录（updateBest 边玩边写 bests，结算时查不出来了） */

  var pieces = 0, tetrises = 0, tspinClears = 0, maxCombo = 0, holds = 0;
  var gravAcc = 0, gravMs = 1000;
  var lockTimer = 0, lockResets = 0, grounded = false, lowestY = 0;
  var dasAcc = 0, arrAcc = 0, softAcc = 0, heldDir = 0;
  var lastRot = false, lastKick = -1, lastClear = null;
  var keys = { left: false, right: false, down: false };

  var clearAnim = null;
  var rowMask = new Uint8Array(ROWS);     /* 本次消行标记 */
  var rowShift = new Int8Array(ROWS);     /* 每行塌陷格数（该行下方被消的行数） */
  var clearRowsN = 0, bottomCleared = -1;
  var freezeMs = 0, flashMs = 0, collapseMs = 0;
  var squashMask = new Uint8Array(COLS * ROWS);
  var levelFlash = 0, dangerT = 0, hudAcc = 0, elapsedHud = -1;
  var hudDirty = true;
  var last = 0;

  /* ═══════════════ 8. 特效池（预分配，帧内零分配） ═══════════════ */

  var PARTS = [];
  for (var pi = 0; pi < 110; pi++) PARTS.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, dur: 1, c: '#000000', s: 2 });
  var partIdx = 0;

  var SQUASH = [];
  for (var si = 0; si < 4; si++) SQUASH.push({ on: false, x: 0, y: 0 });
  var squashN = 0, squashT = 0;

  var TRAIL = [];
  for (var ti = 0; ti < 4; ti++) TRAIL.push({ on: false, x: 0, from: 0, to: 0 });
  var trailN = 0, trailT = 0;

  var shakeT = 0, shakeMag = 0;

  function spawnParts(x, y, count, spread, up, color) {
    for (var i = 0; i < count; i++) {
      var p = PARTS[partIdx];
      partIdx = (partIdx + 1) % PARTS.length;
      p.on = true;
      p.x = x + (vrng() - 0.5) * spread;
      p.y = y + (vrng() - 0.5) * spread * 0.5;
      p.vx = (vrng() - 0.5) * 0.16;
      p.vy = -up * (0.08 + vrng() * 0.18);
      p.t = 0;
      p.dur = 320 + vrng() * 260;
      p.c = color;
      p.s = 2 + vrng() * 3;
    }
  }

  function clearSquash() {
    for (var i = 0; i < squashN; i++) {
      var s = SQUASH[i];
      squashMask[s.y * COLS + s.x] = 0;
      s.on = false;
    }
    squashN = 0;
    squashT = 0;
  }

  /* ═══════════════ 9. 棋盘 / 碰撞 ═══════════════ */

  function collides(type, rot, x0, y0) {
    var cells = ROT[type][rot].cells;
    for (var i = 0; i < cells.length; i += 2) {
      var x = x0 + cells[i], y = y0 + cells[i + 1];
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && board[y * COLS + x]) return true;
    }
    return false;
  }

  function rowFull(y) {
    var off = y * COLS;
    for (var x = 0; x < COLS; x++) if (!board[off + x]) return false;
    return true;
  }

  function stackTop() {
    for (var y = 0; y < ROWS; y++) {
      var off = y * COLS;
      for (var x = 0; x < COLS; x++) if (board[off + x]) return y;
    }
    return ROWS;
  }

  function boardClearedEmpty() {
    for (var y = 0; y < ROWS; y++) {
      if (rowMask[y]) continue;
      var off = y * COLS;
      for (var x = 0; x < COLS; x++) if (board[off + x]) return false;
    }
    return true;
  }

  /* ═══════════════ 10. 7-bag 随机器 ═══════════════ */

  function refillBag() {
    /* 整袋洗牌：一袋 7 块，天然保证"14 连抽内每块恰好 2 次"与首包完整 */
    bag.length = 0;
    for (var i = 0; i < TYPES.length; i++) bag.push(TYPES[i]);
    for (i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
  }

  function refillQueue() {
    for (var i = 0; i < PREVIEWS; i++) {
      if (queue[i]) continue;
      if (!bag.length) refillBag();
      queue[i] = bag.pop();
    }
  }

  function shiftQueue() {
    var head = queue[0], i;
    for (i = 0; i < PREVIEWS - 1; i++) queue[i] = queue[i + 1];
    queue[PREVIEWS - 1] = null;
    refillQueue();
    return head;
  }

  /* ═══════════════ 11. 生成 / 暂存 ═══════════════ */

  function spawnP(type, fromHold) {
    cur = { type: type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y[type] };
    grounded = false;
    lockTimer = 0; lockResets = 0; lowestY = cur.y;
    gravAcc = 0; lastRot = false; lastKick = -1;
    if (!fromHold) pieces++;   /* 暂存换回的方块是同一块，重复计数会虚高 PPS */
    hudDirty = true;
    if (collides(type, 0, cur.x, cur.y)) {   /* 生成即重叠 → 顶死 */
      cur = null;
      endGame('topout');
      return false;
    }
    return true;
  }

  function spawnNext(force) {
    refillQueue();
    var type = force || shiftQueue();
    refillQueue();
    return spawnP(type);
  }

  function doHold() {
    if (!cur || over || paused || clearAnim) return;
    if (holdUsed) { sfx.deny(); return; }    /* 一次一块：交换后必须本块锁定才能再暂存 */
    var outgoing = cur.type;
    holdUsed = true;
    holds++;
    sfx.hold();
    el.hold.classList.remove('empty');
    if (holdType) {
      var incoming = holdType;
      holdType = outgoing;
      spawnP(incoming, true);                /* 换出的方块回到生成点（旋转态复位、锁定延迟重置） */
    } else {
      holdType = outgoing;
      cur = null;
      spawnNext();
    }
    hudDirty = true;
  }

  /* ═══════════════ 12. 旋转（SRS） ═══════════════ */

  function rotate(dir) {
    if (!cur || over || paused || clearAnim) return false;
    var from = cur.rot;
    var to = (from + (dir > 0 ? 1 : 3)) & 3;
    var table = cur.type === 'I' ? KICK_I : (cur.type === 'O' ? null : KICK_L);
    var kicks = table ? table[from * 4 + to] : null;
    var tries = kicks ? 5 : 1;
    for (var i = 0; i < tries; i++) {
      var dx = kicks ? kicks[i * 2] : 0;
      var dy = kicks ? kicks[i * 2 + 1] : 0;
      if (!collides(cur.type, to, cur.x + dx, cur.y + dy)) {
        cur.rot = to; cur.x += dx; cur.y += dy;
        lastRot = true; lastKick = kicks ? i : -1;
        if (cur.y > lowestY) { lowestY = cur.y; lockResets = 0; }
        afterAction(true);
        return true;
      }
    }
    return false;
  }

  /* 移动/旋转/下落之后统一刷新接地状态与锁定延迟（move reset，上限 15 次） */
  function afterAction(isActive) {
    if (!cur) return;
    var g = collides(cur.type, cur.rot, cur.x, cur.y + 1);
    if (g) {
      if (!grounded) { grounded = true; lockTimer = 0; lockResets = 0; }
      else if (isActive && lockResets < LOCK_RESET_MAX) { lockTimer = 0; lockResets++; }
    } else {
      grounded = false;
      lockTimer = 0;
    }
  }

  /* ═══════════════ 13. T-spin 判定（3-corner） ═══════════════ */

  function occ(x, y) {
    if (x < 0 || x >= COLS || y >= ROWS) return 1;   /* 墙与地板视作已占用 */
    if (y < 0) return 0;                             /* 顶部缓冲不算 */
    return board[y * COLS + x] ? 1 : 0;
  }

  /* 返回 0=无 1=mini 2=完整；必须在写入棋盘之前调用 */
  function detectTSpin() {
    if (!cur || cur.type !== 'T' || !lastRot) return 0;
    var x = cur.x, y = cur.y, rot = cur.rot;
    var a = occ(x, y), b = occ(x + 2, y), c = occ(x, y + 2), d = occ(x + 2, y + 2);
    if (a + b + c + d < 3) return 0;
    var front, back;
    if (rot === 0) { front = a + b; back = c + d; }        /* 尖朝上：前 = 上方两角 */
    else if (rot === 1) { front = b + d; back = a + c; }   /* 朝右 */
    else if (rot === 2) { front = c + d; back = a + b; }   /* 朝下 */
    else { front = a + c; back = b + d; }                  /* 朝左 */
    if (front === 2 && back >= 1) return 2;
    if (front === 1 && back === 2) return lastKick === 4 ? 2 : 1;   /* 第 5 次踢墙 → 升级为完整 */
    return 0;
  }

  /* ═══════════════ 14. 锁定 / 消行 / 计分 ═══════════════ */

  function lock() {
    if (!cur) return;
    var type = cur.type, rot = cur.rot, cx = cur.x, cy = cur.y;
    var cells = ROT[type][rot].cells;
    var i, x, y;

    var tspin = detectTSpin();

    clearSquash();
    for (i = 0; i < cells.length; i += 2) {
      x = cx + cells[i]; y = cy + cells[i + 1];
      if (y < 0) continue;
      board[y * COLS + x] = ID[type];
      if (squashN < 4) {
        var sq = SQUASH[squashN++];
        sq.on = true; sq.x = x; sq.y = y;
        squashMask[y * COLS + x] = 1;
      }
    }
    squashT = SQUASH_MS;
    sfx.lock();

    /* 满行扫描 */
    clearRowsN = 0;
    bottomCleared = -1;
    for (y = 0; y < ROWS; y++) rowMask[y] = 0;
    for (y = ROWS - 1; y >= 0; y--) {
      if (rowFull(y)) { rowMask[y] = 1; clearRowsN++; if (y > bottomCleared) bottomCleared = y; }
    }
    /* 每行塌陷格数 = 该行下方被消的行数 */
    var below = 0;
    for (y = ROWS - 1; y >= 0; y--) {
      rowShift[y] = below;
      if (rowMask[y]) below++;
    }

    var lvl = level;
    /* 计分索引钳到 4：真实对局中一块最多补满 4 行，但 setBoard 这类
       测试钩子可以直接造出十几行满行（此时按 Tetris 档计分，避免 NaN） */
    var scoreN = clearRowsN > 4 ? 4 : clearRowsN;
    var base = tspin === 2 ? SCORE_TSPIN[scoreN] : (tspin === 1 ? SCORE_MINI[scoreN] : SCORE_NORMAL[scoreN]);
    base *= lvl;

    var difficult = clearRowsN > 0 && (clearRowsN >= 4 || tspin > 0);
    var b2bHit = difficult && b2b;
    if (b2bHit) base = Math.floor(base * 1.5);

    var comboBonus = 0;
    if (clearRowsN > 0) {
      comboChain++;
      if (comboChain > 1) comboBonus = 50 * (comboChain - 1) * lvl;
      if (comboChain > maxCombo) maxCombo = comboChain;
    } else {
      comboChain = 0;   /* 只有 Single/Double/Triple 断连；T-spin 无消行不断连 */
    }

    var perfect = false, pcBonus = 0;
    if (clearRowsN > 0 && boardClearedEmpty()) {
      perfect = true;
      pcBonus = (b2bHit && clearRowsN >= 4) ? PC_B2B_TETRIS : SCORE_PC[scoreN];
    }

    var gained = base + comboBonus + pcBonus;
    score += gained;

    if (clearRowsN > 0) {
      lines += clearRowsN;
      if (clearRowsN >= 4) tetrises++;
      if (tspin > 0) tspinClears++;
      b2b = difficult;
    }

    lastClear = {
      lines: clearRowsN, tspin: tspin, points: gained, b2b: b2bHit,
      combo: comboChain, perfect: perfect, difficult: difficult
    };

    var leveled = false;
    if (mode !== 'sprint') {
      var nl = Math.min(LEVEL_CAP, Math.floor(lines / 10) + 1);
      if (nl !== level) { level = nl; applyLevel(true); leveled = true; }
    }

    cur = null;
    holdUsed = false;
    grounded = false;
    lockTimer = 0;
    lockResets = 0;
    hudDirty = true;

    if (clearRowsN > 0) {
      startClearFx(clearRowsN, tspin, b2bHit, perfect, gained, leveled, difficult);
    } else {
      if (tspin > 0) {
        sfx.tspin();
        callout(tspin === 2 ? 'T-SPIN' : 'T-SPIN MINI', comboChain > 1 ? 'COMBO ×' + comboChain : '', 'tspin');
      }
      if (gained > 0) flashFloat('+' + gained);
      updateBest();
      if (!checkGoal()) spawnNext();
    }
  }

  function startClearFx(n, tspin, b2bHit, perfect, gained, leveled, difficult) {
    var x, y;
    for (y = 0; y < ROWS; y++) {
      if (!rowMask[y]) continue;
      for (x = 0; x < COLS; x += 2) {
        spawnParts(x * CELL + CELL / 2, y * CELL + CELL / 2, 2, CELL * 0.9, 1, BY_ID_COLOR[board[y * COLS + x]]);
      }
    }

    freezeMs = FREEZE_BASE + FREEZE_PER_LINE * n;
    flashMs = FLASH_MS;
    collapseMs = (COLS - 1) * COLLAPSE_STAGGER + COLLAPSE_FALL;
    clearAnim = { t: 0, n: n, gain: gained };

    shakeT = SHAKE_MS;
    shakeMag = n >= 4 ? 5 : (n >= 2 || tspin > 0 ? 3 : 1.5);
    if (n >= 3 || tspin > 0 || perfect) triggerClass(el.frame, 'shake');

    if (tspin > 0) sfx.tspin();
    sfx.clear(n);
    if (difficult && b2bHit) sfx.b2b();
    if (perfect) sfx.perfect();
    if (leveled) sfx.levelup();

    var main, bits = [];
    var nameN = n > 4 ? 4 : n;
    if (perfect) main = 'PERFECT CLEAR';
    else if (tspin > 0) main = (tspin === 2 ? 'T-SPIN ' : 'T-SPIN MINI ') + (nameN > 0 ? CLEAR_NAME[nameN] : '');
    else main = nameN > 0 ? CLEAR_NAME[nameN] : '';
    if (difficult && b2bHit) bits.push('BACK-TO-BACK');
    if (comboChain > 1) { bits.push('COMBO ×' + comboChain); sfx.combo(comboChain); }
    callout(main, bits.join(' · '), perfect ? 'perfect' : (tspin > 0 ? 'tspin' : (n >= 4 ? 'tetris' : '')));

    flashFloat('+' + gained);
    if (leveled) showLevel();
    updateBest();
    hudDirty = true;
  }

  /* 真正的行删除：写指针压实（一次遍历，无 splice / 无分配，支持非相邻消行）。
     动画中途被打断（限时结束 / 顶死）时也要调用，否则已消的行会留在结算画面里。 */
  function compactCleared() {
    var write = ROWS - 1, read, x, y;
    if (clearRowsN > 0) {
      for (read = ROWS - 1; read >= 0; read--) {
        if (rowMask[read]) continue;
        if (write !== read) {
          var src = read * COLS, dst = write * COLS;
          for (x = 0; x < COLS; x++) board[dst + x] = board[src + x];
        }
        write--;
      }
      for (y = write; y >= 0; y--) {
        var off = y * COLS;
        for (x = 0; x < COLS; x++) board[off + x] = 0;
      }
    }
    for (y = 0; y < ROWS; y++) rowMask[y] = 0;
    clearRowsN = 0;
    bottomCleared = -1;
  }

  function finishClear() {
    clearAnim = null;
    compactCleared();
    hudDirty = true;
    if (!checkGoal()) spawnNext();
  }

  function checkGoal() {
    if (mode === 'marathon' && lines >= MARATHON_GOAL) { endGame('goal'); return true; }
    if (mode === 'sprint' && lines >= SPRINT_GOAL) { endGame('goal'); return true; }
    return false;
  }

  /* ═══════════════ 15. 速度曲线 / 等级 ═══════════════ */

  /* Tetris Worlds 马拉松曲线：单格下落时间 t = (0.8 - 0.007*(L-1))^(L-1) 秒 */
  function gravityOf(lv) {
    var t = Math.pow(0.8 - (lv - 1) * 0.007, lv - 1) * 1000;
    if (t < 0.6) t = 0.6;
    if (t > 2000) t = 2000;
    return t;
  }

  function applyLevel(flash) {
    gravMs = mode === 'sprint' ? 1000 : gravityOf(level);
    if (flash) levelFlash = LEVEL_FLASH_MS;
  }

  /* ═══════════════ 16. 操作 ═══════════════ */

  function moveStep(dx) {
    if (!cur || over || paused || clearAnim) return false;
    if (collides(cur.type, cur.rot, cur.x + dx, cur.y)) return false;
    cur.x += dx;
    lastRot = false;
    afterAction(true);
    return true;
  }

  function softDrop() {
    if (!cur || over || paused || clearAnim) return false;
    if (collides(cur.type, cur.rot, cur.x, cur.y + 1)) {
      if (!grounded) { grounded = true; lockTimer = 0; lockResets = 0; }
      return false;
    }
    cur.y++;
    score += 1;
    if (cur.y > lowestY) { lowestY = cur.y; lockResets = 0; }
    lastRot = false;
    afterAction(false);
    hudDirty = true;
    return true;
  }

  function hardDrop() {
    if (!cur || over || paused || clearAnim) return false;
    var y0 = cur.y, dist = 0;
    while (!collides(cur.type, cur.rot, cur.x, cur.y + 1)) { cur.y++; dist++; }
    score += dist * 2;
    /* 硬降拖影：按列记录起始/结束行 */
    trailN = 0;
    var cells = ROT[cur.type][cur.rot].cells;
    for (var i = 0; i < cells.length; i += 2) {
      if (trailN >= 4) break;
      var t = TRAIL[trailN++];
      t.on = true;
      t.x = cur.x + cells[i];
      t.from = y0 + cells[i + 1];
      t.to = cur.y + cells[i + 1];
    }
    trailT = TRAIL_MS;
    /* 硬降距离为 0 时不改变"最后一次操作是旋转"标记：
       否则"旋转进洞 + 空格秒锁"的 T-spin 永远判定不出来 */
    if (dist > 0) { sfx.drop(); lastRot = false; }
    hudDirty = true;
    lock();
    return true;
  }

  /* ═══════════════ 17. 模式 / 结算 ═══════════════ */

  function setMode(m) {
    if (MODE_LIST.indexOf(m) === -1 || m === mode) return;
    mode = m;
    for (var i = 0; i < modeBtns.length; i++) {
      var btn = modeBtns[i], on = btn.getAttribute('data-mode') === m;
      btn.classList[on ? 'add' : 'remove']('on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    restart();
  }

  function bestLabelText() { return mode === 'sprint' ? '最快时间' : '历史最佳'; }

  function fmtBest(v) {
    if (mode === 'sprint') return v > 0 ? (v / 1000).toFixed(2) + 's' : '—';   /* 没成绩时不要显示 0.00s */
    return String(v);
  }

  function updateBest() {
    if (mode === 'sprint') return;   /* 冲刺的最佳只在结算时写 */
    if (!isFinite(score)) return;    /* 防守：任何异常分数都不入库 */
    if (score > bests[mode]) { bests[mode] = score; writeBest(mode, score); hudDirty = true; bestBeaten = true; }
  }

  function buildResult() {
    var secs = elapsed / 1000;
    var pps = secs > 0 ? pieces / secs : 0;
    el.rLines.textContent = String(lines);
    el.rTime.textContent = secs.toFixed(mode === 'sprint' ? 2 : 1) + 's';
    el.rPps.textContent = pps.toFixed(2);
    el.rCombo.textContent = maxCombo > 1 ? String(maxCombo - 1) : '0';
    el.rTspin.textContent = String(tspinClears);
    el.rTetris.textContent = String(tetrises);
    el.rBestLabel.textContent = bestLabelText();
    el.rBest.textContent = fmtBest(bests[mode]);
  }

  function endGame(reason) {
    if (over) return;
    over = true;
    paused = false;
    cur = null;
    if (clearAnim) { clearAnim = null; compactCleared(); }   /* 动画被打断也要压实棋盘 */
    heldKeysClear();

    var secs = elapsed / 1000;
    var emoji = '🙈', title = '游戏结束', sub = '', newBest = bestBeaten;

    if (reason === 'goal' && mode === 'sprint') {
      if (!bests.sprint || elapsed < bests.sprint) { bests.sprint = elapsed; writeBest('sprint', elapsed); newBest = true; }
      emoji = '⏱'; title = '40 行完成'; sub = '用时 ' + secs.toFixed(2) + 's';
      sfx.win();
    } else if (reason === 'goal') {
      if (score > bests.marathon) { bests.marathon = score; writeBest('marathon', score); newBest = true; }
      emoji = '🏆'; title = '150 行通关'; sub = '得分 ' + score;
      sfx.win();
    } else if (reason === 'timeout') {
      if (score > bests.ultra) { bests.ultra = score; writeBest('ultra', score); newBest = true; }
      emoji = '⏰'; title = '时间到'; sub = '得分 ' + score;
      sfx.over();
    } else {
      if (mode !== 'sprint' && score > bests[mode]) { bests[mode] = score; writeBest(mode, score); newBest = true; }
      emoji = '🙈'; title = '游戏结束'; sub = '得分 ' + score;
      sfx.over();
    }

    buildResult();
    el.overlayEmoji.textContent = emoji;
    el.overlayTitle.textContent = title;
    el.overlaySub.textContent = sub + (newBest ? ' · 新纪录！' : '');
    el.again.textContent = '再试一次';
    el.overlay.classList.add('on');
    triggerClass(el.frame, 'shake');
    hudDirty = true;
    renderHud();          /* over 后 update() 会提前返回，这里直接刷新，保证 HUD 显示新纪录 */
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) {
      heldKeysClear();
      el.overlayEmoji.textContent = '⏸';
      el.overlayTitle.textContent = '已暂停';
      el.overlaySub.textContent = MODE_NAME[mode] + ' · 分数 ' + score + ' · 消行 ' + lines;
      el.again.textContent = '继续';
      el.overlay.classList.add('on');
      sfx.pause();
    } else {
      el.overlay.classList.remove('on');
    }
    hudDirty = true;
  }

  function heldKeysClear() {
    keys.left = false; keys.right = false; keys.down = false;
    heldDir = 0; dasAcc = 0; arrAcc = 0; softAcc = 0;
  }

  function restart() {
    /* 每局换一副新牌：seed 固定不变时，第二局的方块序列会和第一局完全一样。
       setSeed 之后不再自动换，测试仍可复现。 */
    if (!seedPinned) seed = (Math.random() * 4294967296) >>> 0;
    rng = mulberry32(seed);
    bag.length = 0;
    for (var i = 0; i < PREVIEWS; i++) queue[i] = null;
    board = new Uint8Array(COLS * ROWS);
    cur = null;
    holdType = null;
    holdUsed = false;
    el.hold.classList.add('empty');
    score = 0; lines = 0; level = 1; comboChain = 0; b2b = false;
    over = false; paused = false; bestBeaten = false;
    elapsed = 0; timeLeft = ULTRA_MS;
    pieces = 0; tetrises = 0; tspinClears = 0; maxCombo = 0; holds = 0;
    gravAcc = 0; lockTimer = 0; lockResets = 0; grounded = false; lowestY = 0;
    dasAcc = 0; arrAcc = 0; softAcc = 0;
    lastRot = false; lastKick = -1; lastClear = null;
    clearAnim = null; clearRowsN = 0; bottomCleared = -1;
    levelFlash = 0; shakeT = 0; trailT = 0;
    clearSquash();
    trailN = 0;
    for (i = 0; i < TRAIL.length; i++) TRAIL[i].on = false;
    for (i = 0; i < PARTS.length; i++) PARTS[i].on = false;
    for (i = 0; i < ROWS; i++) { rowMask[i] = 0; rowShift[i] = 0; }
    hudAcc = 0; elapsedHud = -1;
    el.overlay.classList.remove('on');
    applyLevel(false);
    heldKeysClear();
    hudDirty = true;
    spawnNext();
    hudDirty = true;
    draw();
  }

  /* ═══════════════ 18. 渲染 ═══════════════ */

  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawCell(c, x, y, size, color, alpha, ghost) {
    var m = Math.max(1, Math.round(size * 0.06));
    var s = size - m * 2;
    var r = Math.max(2, Math.round(s * 0.18));
    c.globalAlpha = alpha;
    c.fillStyle = color;
    rrect(c, x + m, y + m, s, s, r);
    c.fill();
    if (!ghost) {
      c.globalAlpha = alpha * 0.4;
      c.fillStyle = '#ffffff';
      rrect(c, x + m + s * 0.14, y + m + s * 0.1, s * 0.72, s * 0.26, r * 0.6);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(154, 154, 149, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 1; x < COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, BOARD_H); }
    for (var y = 1; y < ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(BOARD_W, y * CELL + 0.5); }
    ctx.stroke();
  }

  function drawBoardBase() {
    ctx.fillStyle = '#f8ffe5';
    ctx.fillRect(-12, -12, BOARD_W + 24, BOARD_H + 24);
    drawGrid();
    /* 危险区：堆到顶部 4 行时泛红呼吸 */
    if (!over && stackTop() <= 4) {
      ctx.globalAlpha = 0.09 + 0.05 * Math.sin(dangerT / 220);
      ctx.fillStyle = '#ef476f';
      ctx.fillRect(0, 0, BOARD_W, 4 * CELL);
      ctx.globalAlpha = 1;
    }
  }

  function drawSettled() {
    for (var y = 0; y < ROWS; y++) {
      var off = y * COLS;
      for (var x = 0; x < COLS; x++) {
        var v = board[off + x];
        if (!v) continue;
        if (squashT > 0 && squashMask[off + x]) continue;   /* 由挤压特效单独绘制 */
        drawCell(ctx, x * CELL, y * CELL, CELL, BY_ID_COLOR[v], 1, false);
      }
    }
  }

  function drawSquash() {
    if (squashT <= 0) return;
    var p = 1 - squashT / SQUASH_MS;
    var k = p < 0.35 ? p / 0.35 : 1 - (p - 0.35) / 0.65 * 0.7;   /* 压扁 → 回弹 */
    for (var i = 0; i < squashN; i++) {
      var s = SQUASH[i];
      var v = board[s.y * COLS + s.x];
      if (!v) continue;
      var h = CELL * (1 - 0.16 * k);
      var w = CELL * (1 + 0.07 * k);
      drawCell(ctx, s.x * CELL + (CELL - w) / 2, s.y * CELL + (CELL - h), w, BY_ID_COLOR[v], 1, false);
    }
  }

  function drawTrail() {
    if (trailT <= 0) return;
    ctx.globalAlpha = (trailT / TRAIL_MS) * 0.28;
    ctx.fillStyle = '#ffffff';
    for (var i = 0; i < trailN; i++) {
      var t = TRAIL[i];
      var y0 = Math.min(t.from, t.to) * CELL;
      var h = (Math.abs(t.to - t.from) + 1) * CELL;
      if (h <= CELL) continue;
      ctx.fillRect(t.x * CELL + CELL * 0.28, y0, CELL * 0.44, h);
    }
    ctx.globalAlpha = 1;
  }

  function drawActive() {
    if (!cur || over) return;
    var color = COLOR[cur.type];
    var st = ROT[cur.type][cur.rot];
    var i, cxx, cyy;

    /* 列高亮（当前方块覆盖的列） */
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = color;
    ctx.fillRect((cur.x + st.minX) * CELL, 0, (st.maxX - st.minX + 1) * CELL, BOARD_H);
    ctx.globalAlpha = 1;

    /* 幽灵落点 */
    var gy = cur.y;
    while (!collides(cur.type, cur.rot, cur.x, gy + 1)) gy++;
    if (gy > cur.y) {
      for (i = 0; i < st.cells.length; i += 2) {
        cyy = gy + st.cells[i + 1];
        if (cyy < 0) continue;
        drawCell(ctx, (cur.x + st.cells[i]) * CELL, cyy * CELL, CELL, color, 0.16, true);
      }
    }
    for (i = 0; i < st.cells.length; i += 2) {
      cxx = cur.x + st.cells[i];
      cyy = cur.y + st.cells[i + 1];
      if (cyy < 0) continue;
      drawCell(ctx, cxx * CELL, cyy * CELL, CELL, color, 1, false);
    }
  }

  function drawClearPhase() {
    var inFreeze = clearAnim.t < freezeMs;
    var inFlash = !inFreeze && clearAnim.t < freezeMs + flashMs;
    var p = clearAnim.t - freezeMs - flashMs;
    var x, y, v;

    drawGrid();
    for (y = 0; y < ROWS; y++) {
      if (rowMask[y]) continue;
      var moving = rowShift[y] > 0;
      for (x = 0; x < COLS; x++) {
        v = board[y * COLS + x];
        if (!v) continue;
        if (moving && !inFreeze && !inFlash) continue;   /* 塌陷格单独绘制 */
        drawCell(ctx, x * CELL, y * CELL, CELL, BY_ID_COLOR[v], 1, false);
      }
    }
    if (inFlash) {
      var k = (clearAnim.t - freezeMs) / flashMs;
      ctx.globalAlpha = 0.55 + 0.4 * (1 - k);
      ctx.fillStyle = '#ffffff';
      for (y = 0; y < ROWS; y++) {
        if (!rowMask[y]) continue;
        var w = BOARD_W * Math.min(1, k * 1.6);
        ctx.fillRect((BOARD_W - w) / 2, y * CELL + 1, w, CELL - 2);
      }
      ctx.globalAlpha = 1;
    }
    if (!inFreeze && !inFlash) {
      for (x = 0; x < COLS; x++) {
        var delay = x * COLLAPSE_STAGGER;
        var t = (p - delay) / COLLAPSE_FALL;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        var e = t * t * t;
        for (y = 0; y < ROWS; y++) {
          if (rowShift[y] <= 0) continue;
          v = board[y * COLS + x];
          if (!v) continue;
          drawCell(ctx, x * CELL, (y + rowShift[y] * e) * CELL, CELL, BY_ID_COLOR[v], 1, false);
        }
      }
    }
  }

  function drawParts() {
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i];
      if (!p.on) continue;
      var k = 1 - p.t / p.dur;
      ctx.globalAlpha = k < 0 ? 0 : k * 0.9;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;
  }

  function drawPieceCentered(c, type, cw, ch, cell, ox, oy) {
    var st = ROT[type][0];
    var w = (st.maxX - st.minX + 1) * cell;
    var h = (st.maxY - st.minY + 1) * cell;
    var x0 = ox + (cw - w) / 2 - st.minX * cell;
    var y0 = oy + (ch - h) / 2 - st.minY * cell;
    for (var i = 0; i < st.cells.length; i += 2) {
      drawCell(c, x0 + st.cells[i] * cell, y0 + st.cells[i + 1] * cell, cell, COLOR[type], 1, false);
    }
  }

  function drawPreviews() {
    nctx.clearRect(0, 0, PRE_W, PRE_H);
    nctx.strokeStyle = 'rgba(154, 154, 149, 0.25)';
    nctx.lineWidth = 1;
    for (var i = 0; i < PREVIEWS; i++) {
      var t = queue[i];
      if (t) drawPieceCentered(nctx, t, PRE_W, PRE_SLOT, PRE_CELL, 0, i * PRE_SLOT);
      if (i < PREVIEWS - 1) {
        nctx.beginPath();
        nctx.moveTo(2, (i + 1) * PRE_SLOT + 0.5);
        nctx.lineTo(PRE_W - 2, (i + 1) * PRE_SLOT + 0.5);
        nctx.stroke();
      }
    }
    hctx.clearRect(0, 0, HOLD_W, HOLD_H);
    if (holdType) drawPieceCentered(hctx, holdType, HOLD_W, HOLD_H, HOLD_CELL, 0, 0);
  }

  function draw() {
    var sx = 0, sy = 0;
    if (shakeT > 0) {
      var k = shakeT / SHAKE_MS;
      sx = (vrng() - 0.5) * shakeMag * k * 2;
      sy = (vrng() - 0.5) * shakeMag * k * 2;
    }
    ctx.setTransform(px, 0, 0, px, sx * px, sy * px);
    drawBoardBase();
    if (clearAnim) drawClearPhase();
    else { drawSettled(); drawSquash(); }
    drawTrail();
    drawActive();
    if (levelFlash > 0) {
      ctx.globalAlpha = 0.45 * (levelFlash / LEVEL_FLASH_MS);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, BOARD_W, BOARD_H);
      ctx.globalAlpha = 1;
    }
    drawParts();
    ctx.setTransform(px, 0, 0, px, 0, 0);
    drawPreviews();
  }

  /* ═══════════════ 19. HUD / 呼叫 / 结算面板 ═══════════════ */

  var hudCache = { score: -1, best: -1, lines: -1, level: -1, status: '', bestLabel: '' };

  function renderHud() {
    if (hudCache.score !== score) { el.score.textContent = String(score); hudCache.score = score; }
    var bv = bests[mode];
    if (hudCache.best !== bv) { el.best.textContent = fmtBest(bv); hudCache.best = bv; }
    if (hudCache.lines !== lines) { el.lines.textContent = String(lines); hudCache.lines = lines; }
    if (hudCache.level !== level) { el.level.textContent = String(level); hudCache.level = level; }
    var s;
    if (mode === 'sprint') s = '40 行冲刺 · ' + lines + '/' + SPRINT_GOAL + ' 行 · ' + (elapsed / 1000).toFixed(1) + 's';
    else if (mode === 'ultra') s = '2 分钟限时 · 剩余 ' + Math.max(0, timeLeft / 1000).toFixed(1) + 's · 分数 ' + score;
    else s = '马拉松 · 目标 ' + lines + '/' + MARATHON_GOAL + ' 行 · ' + (elapsed / 1000).toFixed(1) + 's';
    if (hudCache.status !== s) { el.status.textContent = s; hudCache.status = s; }
    var bl = bestLabelText();
    if (hudCache.bestLabel !== bl) { el.bestLabel.textContent = bl; hudCache.bestLabel = bl; }
  }

  function triggerClass(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;   /* 强制重排以重启动画 */
    node.classList.add(cls);
  }

  function flashFloat(text) {
    el.float.textContent = text;
    triggerClass(el.float, 'on');
  }

  function showLevel() {
    el.levelFloat.textContent = 'Level ' + level;
    triggerClass(el.levelFloat, 'on');
  }

  function callout(main, sub, cls) {
    el.calloutMain.textContent = main;
    el.calloutSub.textContent = sub || '';
    el.callout.classList.remove('tspin', 'tetris', 'perfect');
    if (cls) el.callout.classList.add(cls);
    triggerClass(el.callout, 'on');
  }

  /* ═══════════════ 20. 主循环 ═══════════════ */

  function update(dt, realDt) {
    var i, p;

    if (levelFlash > 0) levelFlash -= dt;
    if (squashT > 0) { squashT -= dt; if (squashT <= 0) clearSquash(); }
    if (trailT > 0) {
      trailT -= dt;
      if (trailT <= 0) { for (i = 0; i < trailN; i++) TRAIL[i].on = false; trailN = 0; }
    }
    if (shakeT > 0) shakeT -= dt;
    for (i = 0; i < PARTS.length; i++) {
      p = PARTS[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.dur) { p.on = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.00075 * dt;
    }
    dangerT += dt;

    if (over) return;

    /* 计时：暂停不走；用真实 dt（未截断）保证限时的公平 */
    if (!paused) {
      elapsed += realDt;
      if (mode === 'ultra') {
        timeLeft -= realDt;
        if (timeLeft <= 0) { timeLeft = 0; endGame('timeout'); return; }
      }
    }
    if (paused) return;

    hudAcc += dt;
    if (hudAcc > 120) {
      hudAcc = 0;
      var shown = Math.round(elapsed / 100);
      if (shown !== elapsedHud) { elapsedHud = shown; hudDirty = true; }
    }
    if (hudDirty) { hudDirty = false; renderHud(); }

    if (clearAnim) {
      clearAnim.t += dt;
      if (clearAnim.t >= freezeMs + flashMs + collapseMs) finishClear();
      return;
    }

    if (cur) {
      /* 重力 */
      gravAcc += dt;
      var steps = 0;
      while (gravAcc >= gravMs && steps < 40 && !grounded && cur && !clearAnim) {
        gravAcc -= gravMs;
        steps++;
        if (!collides(cur.type, cur.rot, cur.x, cur.y + 1)) {
          cur.y++;
          if (cur.y > lowestY) { lowestY = cur.y; lockResets = 0; }
          lastRot = false;
          afterAction(false);
        }
      }
      if (gravAcc > gravMs * 4) gravAcc = gravMs * 4;

      /* 锁定延迟（move reset，上限 15 次） */
      if (grounded) {
        lockTimer += dt;
        if (lockTimer >= LOCK_MS) { lock(); }
      }
    }

    if (over || clearAnim || !cur) return;

    /* DAS / ARR */
    if (heldDir !== 0) {
      dasAcc += dt;
      if (dasAcc >= DAS_MS) {
        arrAcc += dt;
        var guard = 0;
        while (arrAcc >= ARR_MS && guard < 20) {
          arrAcc -= ARR_MS;
          guard++;
          if (!moveStep(heldDir)) break;
        }
        if (arrAcc > ARR_MS * 4) arrAcc = 0;
      }
    }
    /* 软降（不低于当前重力速度） */
    if (keys.down) {
      var softMs = gravMs < SOFT_MS ? gravMs : SOFT_MS;
      softAcc += dt;
      var sg = 0;
      while (softAcc >= softMs && sg < 40) {
        softAcc -= softMs;
        sg++;
        if (!softDrop()) break;
      }
      if (softAcc > softMs * 4) softAcc = 0;
    }
  }

  function frame(t) {
    requestAnimationFrame(frame);
    var raw = last ? t - last : 0;
    last = t;
    if (raw < 0) raw = 0;
    update(raw > 100 ? 100 : raw, raw > 250 ? 250 : raw);
    draw();
  }

  /* ═══════════════ 21. 输入 ═══════════════ */

  function normKey(k) {
    switch (k) {
      case 'w': case 'W': return 'ArrowUp';
      case 'a': case 'A': return 'ArrowLeft';
      case 's': case 'S': return 'ArrowDown';
      case 'd': case 'D': return 'ArrowRight';
    }
    return k;
  }

  function toggleMute() {
    sfx.setMuted(!sfx.isMuted());
    el.muteBtn.textContent = '音效：' + (sfx.isMuted() ? '关' : '开');
  }

  function handleKey(raw) {
    var key = normKey(raw);
    if (over) {
      /* 只有明确的重新开始键才重开：空格是硬降键，手机上的「硬降」按钮
         会在结算面板上误触，导致成绩面板瞬间被清掉 */
      if (key === 'Enter' || key === 'r' || key === 'R') restart();
      return;
    }
    switch (key) {
      case 'ArrowLeft':
        keys.left = true; heldDir = -1; dasAcc = 0; arrAcc = 0;
        if (moveStep(-1)) sfx.move();
        break;
      case 'ArrowRight':
        keys.right = true; heldDir = 1; dasAcc = 0; arrAcc = 0;
        if (moveStep(1)) sfx.move();
        break;
      case 'ArrowDown':
        keys.down = true; softAcc = 0; softDrop();
        break;
      case 'ArrowUp': case 'x': case 'X':
        if (rotate(1)) sfx.rotate();
        break;
      case 'z': case 'Z':
        if (rotate(-1)) sfx.rotate();
        break;
      case ' ':
        hardDrop();
        break;
      case 'c': case 'C': case 'Shift':
        doHold();
        break;
      case 'p': case 'P':
        togglePause();
        break;
      case 'm': case 'M':
        toggleMute();
        break;
      case 'r': case 'R':
        restart();
        break;
      case '1': setMode('marathon'); break;
      case '2': setMode('sprint'); break;
      case '3': setMode('ultra'); break;
      default: break;
    }
  }

  function releaseKey(raw) {
    var key = normKey(raw);
    if (key === 'ArrowLeft') { keys.left = false; heldDir = keys.right ? 1 : 0; dasAcc = 0; arrAcc = 0; }
    else if (key === 'ArrowRight') { keys.right = false; heldDir = keys.left ? -1 : 0; dasAcc = 0; arrAcc = 0; }
    else if (key === 'ArrowDown') { keys.down = false; }
  }

  window.addEventListener('keydown', function (e) {
    sfx.unlock(e.isTrusted === true);
    if (!HANDLED[e.key]) return;
    e.preventDefault();
    if (e.repeat) return;   /* 长按交给 DAS/ARR */
    handleKey(e.key);
  }, { passive: false });

  window.addEventListener('keyup', function (e) { releaseKey(e.key); });
  window.addEventListener('blur', heldKeysClear);

  el.restartBtn.addEventListener('click', function () { restart(); });
  el.again.addEventListener('click', function () { if (over) restart(); else togglePause(); });
  el.muteBtn.addEventListener('click', function () { sfx.unlock(true); toggleMute(); });

  var ACTION_KEY = { left: 'ArrowLeft', rotate: 'ArrowUp', ccw: 'z', right: 'ArrowRight', down: 'ArrowDown', drop: ' ', hold: 'c' };
  Array.prototype.forEach.call(document.querySelectorAll('.pad button'), function (btn) {
    var key = ACTION_KEY[btn.getAttribute('data-action')];
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      sfx.unlock(e.isTrusted === true);
      handleKey(key);
    });
    var release = function () { releaseKey(key); };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  var modeBtns = document.querySelectorAll('.mode-btn');
  Array.prototype.forEach.call(modeBtns, function (btn) {
    btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
  });

  /* 切走标签页自动暂停：限时模式不会在后台被白嫖 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && !over && !paused) togglePause();
  });

  /* ═══════════════ 22. 测试钩子 ═══════════════ */

  function snapshot() {
    var rows = [], y, x, off;
    for (y = 0; y < ROWS; y++) {
      off = y * COLS;
      var row = [];
      for (x = 0; x < COLS; x++) row.push(board[off + x]);
      rows.push(row);
    }
    var curOut = null;
    if (cur) {
      var st = ROT[cur.type][cur.rot];
      curOut = {
        type: cur.type, id: ID[cur.type], x: cur.x, y: cur.y, rot: cur.rot,
        cells: st.mat.map(function (r) { return r.slice(); })
      };
    }
    var secs = elapsed / 1000;
    return {
      /* —— 既有字段（不得删改名） —— */
      score: score, best: bests[mode], over: over, paused: paused,
      lines: lines, level: level, seed: seed, board: rows,
      next: queue[0] || null, current: curOut,
      /* —— 新增 —— */
      mode: mode, phase: over ? 'over' : (paused ? 'paused' : 'playing'),
      queue: queue.slice(0), hold: holdType, holdUsed: holdUsed,
      combo: comboChain, b2b: b2b, elapsed: elapsed,
      timeLeft: mode === 'ultra' ? timeLeft : 0,
      pieces: pieces, pps: secs > 0 ? pieces / secs : 0,
      tetrises: tetrises, tspins: tspinClears, maxCombo: maxCombo, holds: holds,
      gravityMs: gravMs, lockResets: lockResets,
      lockLeftMs: grounded ? Math.max(0, LOCK_MS - lockTimer) : LOCK_MS,
      lastRot: lastRot, lastKick: lastKick,
      lastClear: lastClear ? {
        lines: lastClear.lines, tspin: lastClear.tspin, points: lastClear.points,
        b2b: lastClear.b2b, combo: lastClear.combo, perfect: lastClear.perfect
      } : null,
      animating: !!clearAnim, squash: squashT > 0, trail: trailT > 0,
      clearingRows: clearRowsN,
      stackTop: stackTop(),
      bests: { marathon: bests.marathon, sprint: bests.sprint, ultra: bests.ultra },
      muted: sfx.isMuted()
    };
  }

  function setBoard(rows) {
    var src = Array.isArray(rows) ? rows : [];
    var next = new Uint8Array(COLS * ROWS);
    var y, x;
    for (y = 0; y < ROWS; y++) {
      var row = src[y];
      if (!row) continue;
      for (x = 0; x < COLS; x++) {
        var raw = typeof row === 'string' ? row.charAt(x) : row[x];
        if (raw === '.' || raw === undefined || raw === null || raw === '') continue;
        var v = Number(raw);
        if (!(v >= 1 && v <= 7)) v = 1;   /* 'X' / '#' 等任意非空标记都按实心块处理 */
        next[y * COLS + x] = v;
      }
    }
    board = next;
    over = false; paused = false;
    grounded = false; lockTimer = 0; lockResets = 0; gravAcc = 0;
    clearAnim = null; clearRowsN = 0; bottomCleared = -1;
    for (y = 0; y < ROWS; y++) { rowMask[y] = 0; rowShift[y] = 0; }
    clearSquash();
    trailT = 0; trailN = 0;
    for (var i = 0; i < TRAIL.length; i++) TRAIL[i].on = false;
    el.overlay.classList.remove('on');
    if (cur && collides(cur.type, cur.rot, cur.x, cur.y)) cur = null;
    if (!cur) spawnNext();
    afterAction(false);
    hudDirty = true;
    draw();
    return snapshot().board;
  }

  function setPiece(type, rot, x, y) {
    if (TYPES.indexOf(type) === -1) return false;
    rot = ((Math.floor(Number(rot) || 0) % 4) + 4) % 4;
    cur = { type: type, rot: rot, x: Math.floor(Number(x) || 0), y: Math.floor(Number(y) || 0) };
    grounded = false; lockTimer = 0; lockResets = 0; gravAcc = 0;
    lowestY = cur.y; lastRot = false; lastKick = -1;
    afterAction(false);
    draw();
    return true;
  }

  function tick(stepMs, times) {
    var step = Number(stepMs) > 0 ? Number(stepMs) : 16.6667;
    var n = Number(times) > 0 ? Math.floor(Number(times)) : 1;
    for (var i = 0; i < n; i++) update(step, step);
    draw();
    return snapshot();
  }

  window.__game = {
    /* —— 契约四件套 —— */
    snapshot: snapshot,
    restart: restart,
    press: function (key) { handleKey(key); releaseKey(key); },
    setSeed: function (n) {
      seed = (Number(n) || 0) >>> 0;
      seedPinned = true;
      rng = mulberry32(seed);
    },
    /* —— 扩展钩子 —— */
    setMode: setMode,
    getMode: function () { return mode; },
    setBoard: setBoard,
    setPiece: setPiece,
    spawn: function (type) {
      if (TYPES.indexOf(type) === -1) return false;
      return spawnP(type);
    },
    setHold: function (type) {
      holdType = TYPES.indexOf(type) === -1 ? null : type;
      if (holdType) el.hold.classList.remove('empty'); else el.hold.classList.add('empty');
      return holdType;
    },
    setHoldUsed: function (v) { holdUsed = !!v; return holdUsed; },
    forceLevel: function (n) {
      level = Math.max(1, Math.min(LEVEL_CAP + 5, Math.floor(Number(n) || 1)));
      applyLevel(false);
      hudDirty = true;
      return level;
    },
    setLines: function (n) {
      lines = Math.max(0, Math.floor(Number(n) || 0));
      if (mode !== 'sprint') { level = Math.min(LEVEL_CAP, Math.floor(lines / 10) + 1); applyLevel(false); }
      hudDirty = true;
      return lines;
    },
    tick: tick,
    kickTable: function (piece) {
      var table = piece === 'I' ? KICK_I : KICK_L;
      var out = {};
      for (var f = 0; f < 4; f++) {
        for (var t = 0; t < 4; t++) {
          var k = table[f * 4 + t];
          if (!k) continue;
          var arr = [];
          for (var i = 0; i < 5; i++) arr.push([k[i * 2], k[i * 2 + 1]]);
          out[f + '>' + t] = arr;
        }
      }
      return out;
    },
    stats: function () {
      var secs = elapsed / 1000;
      return {
        mode: mode, seconds: secs, pieces: pieces, lines: lines, score: score,
        pps: secs > 0 ? pieces / secs : 0, lpm: secs > 0 ? lines / secs * 60 : 0,
        maxCombo: maxCombo, holds: holds, tspins: tspinClears, tetrises: tetrises,
        gravityMs: gravMs, level: level
      };
    }
  };

  /* ═══════════════ 23. 启动 ═══════════════ */

  applyLevel(false);
  el.muteBtn.textContent = '音效：' + (sfx.isMuted() ? '关' : '开');
  el.hold.classList.add('empty');
  restart();
  renderHud();
  requestAnimationFrame(frame);
})();
