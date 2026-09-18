/* 贪吃蛇 · 零依赖离线小游戏
 * 结构参照 shooter/：模式 → 关卡地图 → 道具 → 连锁计分 → 反馈（命中停顿 / 屏震 / 粒子 /
 * 飘分 / 合成音效）分层；帧内零分配（蛇走环形 Int16Array，粒子走预分配结构数组，DOM 只在值
 * 变化时写）。视觉与 2048 同族：灰外框 + 奶油棋盘 + 极淡格线。
 */
(function () {
  'use strict';

  /* ═════════════ 1. 常量与调色板 ═════════════ */

  var N = 20;                 // 20 x 20 网格
  var CELL = 20;              // 每格绘图单位
  var SIZE = N * CELL;        // 逻辑尺寸 400 x 400
  var CAP = N * N;            // 环形缓冲容量
  var TAU = Math.PI * 2;
  var MIN_LEN = 3;            // 最短长度（缩短道具不能把蛇吃没）

  var CHAIN_MS = 2600;        // 连吃窗口：这个时间内吃下一个就续连锁
  var CHAIN_MAX = 5;          // 连锁倍率上限 ×5
  var QUEUE_MAX = 3;          // 输入缓冲深度：一帧内连按两个方向不丢
  var HITSTOP_EAT = 70;       // 命中停顿（吃水果）
  var HITSTOP_GOLD = 110;     // 金苹果重量级
  var HITSTOP_GUARD = 150;    // 护盾碎裂
  var FLASH_MS = 230;         // 吃到后蛇身加亮
  var SPARK_MS = 560;         // 粒子寿命
  var FADE_MS = 480;          // 死亡褪色
  var OVER_DELAY = 620;       // 定格 + 褪色之后再弹结算面板
  var POP_MS = 180;           // 食物弹入
  var ITEM_POP_MS = 240;      // 道具弹入
  var GOLD_MS = 7000;         // 金苹果存在时长（Snake II 的限时 bonus）
  var PW_TTL = 9000;          // 道具在场上待这么久不捡就消失
  var GOLD_BASE = 60;         // 金苹果满分（越早吃越高，见 goldPoints）
  var GOLD_MIN = 15;
  var SPARK_N = 14;
  var MAX_SPARKS = 240;
  var SPRINT_MS = 60000;      // 冲刺模式总时长
  var SPRINT_FOOD_ADD = 2000; // 吃水果加时
  var SPRINT_GOLD_ADD = 5000;
  var TAPER = 5;              // 尾部渐细覆盖的节数
  var WALL_SAFE = 3;          // 生长之墙离蛇头的 taxicab 安全距离（照抄 Google Wall Mode）

  var STORE_BEST = 'games.snake.best';        // 兼容旧版键（单一总最佳）
  var STORE_BEST2 = 'games.snake.best.mode';  // 新：每模式最佳
  var STORE_MUTED = 'games.snake.muted';

  // 与 base.css 的 token 同源：绿蛇（--c4）、玫红食物（--c2）、奶油棋盘（--cell）
  var COL = {
    cell: '#f8ffe5',
    grid: 'rgba(154, 154, 149, .2)',
    wall: '#8794a1',
    wallTop: '#b8c4d0',
    wallEdge: '#6b7885',
    body: '#06d6a0',
    bodyHot: '#7defc7',
    head: '#059a74',
    headHot: '#12c391',
    eye: '#f8ffe5',
    pupil: '#083b2e',
    food: '#ef476f',
    foodHalo: 'rgba(239, 71, 111, .16)',
    gold: '#ffc43d',
    goldDark: '#d98c00',
    goldHalo: 'rgba(255, 196, 61, .24)',
    crash: '#ef476f',
    spark: ['#ef476f', '#ffc43d', '#06d6a0', '#22c2d6']
  };

  /* ═════════════ 2. 模式表 ═════════════ */

  // goldEvery / pwEvery：每吃 N 个水果出现一次金苹果 / 道具
  // wallsEvery：每吃 N 个水果长出一面 1x1 墙（0 = 不长墙）
  var MODES = [
    { id: 'classic', name: '经典无尽', desc: '穿墙边界 · 无墙 · 越吃越快（1998 3310 的规则）', wrap: true, goldEvery: 5, pwEvery: 5, wallsEvery: 0, limit: 0, levels: false },
    { id: 'levels', name: '关卡远征', desc: '8 张地图 · 每关目标 · 逐关引入新结构', wrap: false, goldEvery: 4, pwEvery: 4, wallsEvery: 0, limit: 0, levels: true },
    { id: 'walls', name: '生长之墙', desc: '每吃 2 个水果长出一面墙 · 路越走越窄', wrap: false, goldEvery: 4, pwEvery: 3, wallsEvery: 2, limit: 0, levels: false },
    { id: 'sprint', name: '60 秒冲刺', desc: '限时 60 秒 · 吃一口加 2 秒 · 金苹果加 5 秒', wrap: false, goldEvery: 3, pwEvery: 3, wallsEvery: 0, limit: SPRINT_MS, levels: false }
  ];

  /* ═════════════ 3. 关卡地图（矩形块数据 → 编译成 solid 网格） ═════════════
   * 地块用 [row, col, h, w] 描述。全部地图共用一条空走廊（第 9-11 行）——
   * 出生点固定在第 10 行第 6-8 列，保证每关开局都能直着走两步。
   * 数据由 /tmp 脚本做过连通性校验：自由格 100% 互相可达。
   */
  var LEVELS = [
    { name: '空旷平原', ms: 170, goal: 5, tip: '先熟悉转弯与连锁', rects: [] },
    { name: '四角亭', ms: 164, goal: 6, tip: '亭子的四条腿会咬人', rects: [[3, 2, 1, 4], [4, 2, 3, 1], [4, 5, 3, 1], [3, 14, 1, 4], [4, 14, 3, 1], [4, 17, 3, 1], [16, 2, 1, 4], [13, 2, 3, 1], [13, 5, 3, 1], [16, 14, 1, 4], [13, 14, 3, 1], [13, 17, 3, 1]] },
    { name: '柱阵', ms: 158, goal: 6, tip: '两根柱子之间别贪', rects: [[3, 3, 2, 2], [3, 9, 2, 2], [3, 15, 2, 2], [7, 3, 2, 2], [7, 9, 2, 2], [7, 15, 2, 2], [13, 3, 2, 2], [13, 9, 2, 2], [13, 15, 2, 2], [17, 3, 2, 2], [17, 9, 2, 2], [17, 15, 2, 2]] },
    { name: '回字迷宫', ms: 150, goal: 7, tip: '内圈的门在上下两侧', rects: [[2, 4, 1, 5], [2, 11, 1, 5], [17, 4, 1, 5], [17, 11, 1, 5], [3, 4, 6, 1], [12, 4, 6, 1], [3, 15, 6, 1], [12, 15, 6, 1], [6, 8, 1, 1], [6, 11, 1, 1], [13, 8, 1, 1], [13, 11, 1, 1], [7, 8, 2, 1], [12, 8, 2, 1], [7, 11, 2, 1], [12, 11, 2, 1]] },
    { name: '断墙阵', ms: 143, goal: 7, tip: '缺口每次都在另一侧', rects: [[3, 2, 1, 10], [3, 15, 1, 5], [5, 8, 1, 11], [7, 0, 1, 6], [7, 14, 1, 6], [12, 0, 1, 12], [14, 8, 1, 11], [16, 2, 1, 10], [16, 15, 1, 5]] },
    { name: '棋盘格', ms: 136, goal: 8, tip: '方格之间留出转身的余量', rects: [[2, 2, 2, 2], [2, 6, 2, 2], [2, 10, 2, 2], [2, 14, 2, 2], [2, 18, 2, 2], [6, 2, 2, 2], [6, 6, 2, 2], [6, 10, 2, 2], [6, 14, 2, 2], [6, 18, 2, 2], [14, 2, 2, 2], [14, 6, 2, 2], [14, 10, 2, 2], [14, 14, 2, 2], [14, 18, 2, 2], [18, 2, 2, 2], [18, 6, 2, 2], [18, 10, 2, 2], [18, 14, 2, 2], [18, 18, 2, 2]] },
    { name: '蜂巢门', ms: 128, goal: 8, tip: '三道门开的高度不一样', rects: [[3, 4, 5, 1], [12, 4, 5, 1], [3, 9, 6, 1], [12, 9, 7, 1], [3, 14, 5, 1], [12, 14, 5, 1], [6, 5, 1, 4], [13, 10, 1, 4]] },
    { name: '十字牢笼', ms: 120, goal: 10, tip: '最后一关，稳住', rects: [[3, 9, 6, 2], [13, 9, 6, 2], [5, 2, 1, 4], [5, 15, 1, 4], [14, 2, 1, 4], [14, 15, 1, 4], [2, 2, 1, 3], [2, 16, 1, 3], [17, 2, 1, 3], [17, 16, 1, 3]] }
  ];
  var SPRINT_RECTS = [[3, 3, 1, 6], [3, 12, 1, 5], [6, 0, 1, 6], [6, 14, 1, 6], [12, 0, 1, 6], [12, 14, 1, 6], [16, 3, 1, 6], [16, 12, 1, 5], [5, 9, 2, 2], [14, 9, 2, 2]];

  /* ═════════════ 4. 道具表 ═════════════ */

  // ms = 0 表示立刻生效型（缩短）
  var PW = [
    { k: 'shield', name: '护盾', col: '#22c2d6', ms: 15000, desc: '挡一次致命撞击' },
    { k: 'magnet', name: '磁铁', col: '#ef476f', ms: 8000, desc: '8 秒内水果会朝你走' },
    { k: 'slow', name: '减速', col: '#5c7cfa', ms: 6000, desc: '6 秒内慢下来' },
    { k: 'fast', name: '加速', col: '#ff9f1c', ms: 6000, desc: '6 秒内更快、得分翻倍' },
    { k: 'double', name: '双倍', col: '#d9a017', ms: 10000, desc: '10 秒内得分翻倍' },
    { k: 'shrink', name: '缩短', col: '#9a9a95', ms: 0, desc: '立刻短 3 节' }
  ];
  var PW_MS_MAX = [15000, 8000, 6000, 6000, 10000, 1];

  /* ═════════════ 5. 可播种 PRNG（mulberry32） ═════════════ */

  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var seed = 1;
  var rng = mulberry32(seed);

  /* ═════════════ 6. 存档（file:// 下 localStorage 可能抛异常） ═════════════ */

  var mem = {};
  function storeGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return mem[k] === undefined ? null : mem[k]; }
  }
  function storeSet(k, v) {
    try { window.localStorage.setItem(k, String(v)); } catch (e) { mem[k] = String(v); }
  }
  var bestByMode = [0, 0, 0, 0];
  var best = 0;

  function loadBest() {
    var raw = storeGet(STORE_BEST2);
    if (raw) {
      var parts = String(raw).split(',');
      for (var i = 0; i < 4 && i < parts.length; i++) bestByMode[i] = Number(parts[i]) || 0;
    } else {
      var old = Number(storeGet(STORE_BEST)) || 0;   // 迁移旧版单一总最佳到经典模式
      if (old > 0) bestByMode[0] = old;
    }
    best = bestByMode[0];
  }
  function saveBest() {
    bestByMode[modeIdx] = bestByMode[modeIdx] > best ? bestByMode[modeIdx] : best;
    best = bestByMode[modeIdx];
    storeSet(STORE_BEST2, bestByMode.join(','));
  }

  /* ═════════════ 7. DOM ═════════════ */

  var el = {
    frame: document.getElementById('frame'),
    stage: document.getElementById('stage'),
    board: document.getElementById('board'),
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    len: document.getElementById('len'),
    chain: document.getElementById('chain'),
    chainWrap: document.getElementById('chainWrap'),
    float: document.getElementById('float'),
    lenFloat: document.getElementById('lenFloat'),
    notice: document.getElementById('notice'),
    restart: document.getElementById('restart'),
    pause: document.getElementById('pause'),
    mute: document.getElementById('mute'),
    modes: document.getElementById('modes'),
    bar: document.getElementById('bar'),
    barLabel: document.getElementById('barLabel'),
    barVal: document.getElementById('barVal'),
    barFill: document.getElementById('barFill'),
    buffs: document.getElementById('buffs'),
    pad: document.getElementById('pad'),
    overlay: document.getElementById('overlay'),
    ovEmoji: document.getElementById('ovEmoji'),
    ovTitle: document.getElementById('ovTitle'),
    ovSub: document.getElementById('ovSub'),
    ovA: document.getElementById('ovA'),
    ovB: document.getElementById('ovB'),
    ovC: document.getElementById('ovC'),
    again: document.getElementById('again')
  };
  var ctx = el.board.getContext('2d');
  var bg = document.createElement('canvas');   // 预渲染底：奶油格线 + 墙
  var bgCtx = bg.getContext('2d');
  var chipEls = [];
  (function () {
    var list = el.buffs.getElementsByTagName('i');
    for (var i = 0; i < list.length; i++) chipEls.push({ k: list[i].getAttribute('data-k'), el: list[i], bar: list[i].getElementsByTagName('u')[0], last: -1 });
  })();

  /* ═════════════ 8. 网格 / 蛇（环形缓冲，帧内零分配） ═════════════ */

  var sx = new Int16Array(CAP);
  var sy = new Int16Array(CAP);
  var head = 0;              // 蛇头在环形缓冲里的下标
  var slen = 0;              // 长度
  var grew = 0;              // 上一步是否长了身体（决定尾节插值的起点）
  var dirX = 1, dirY = 0;
  var qx = new Int8Array(QUEUE_MAX), qy = new Int8Array(QUEUE_MAX), qN = 0;

  var solid = new Uint8Array(CAP);   // 静态地图墙
  var dyn = new Uint8Array(CAP);     // 动态墙（生长之墙）
  var dynList = new Int16Array(CAP);
  var dynN = 0;

  // BFS 复用缓冲（生成墙时校验食物仍可达，避免刷出必死局）
  var bfsSeen = new Uint8Array(CAP);
  var bfsQ = new Int16Array(CAP);
  var bfsMark = 0;

  function ring(i) { var k = head - i; while (k < 0) k += CAP; return k; }   // 第 i 节（0 = 头）
  function segX(i) { return sx[ring(i)]; }
  function segY(i) { return sy[ring(i)]; }
  function headP() { return sy[head] * N + sx[head]; }

  function onBody(x, y, skipTail) {
    var n = skipTail && slen > 1 ? slen - 1 : slen;
    var k = head;
    for (var i = 0; i < n; i++) {
      if (sx[k] === x && sy[k] === y) return true;
      k--; if (k < 0) k += CAP;
    }
    return false;
  }

  function isBlocked(p) { return solid[p] === 1 || dyn[p] === 1; }

  // 这一步的目标格能不能进：返回 0 = 可以，1 = 墙/障碍，2 = 自己
  function checkCell(x, y, growing) {
    if (isBlocked(y * N + x)) return 1;
    if (onBody(x, y, !growing)) return 2;
    return 0;
  }

  /* ═════════════ 9. 状态 ═════════════ */

  var modeIdx = 0;
  var MODE = MODES[0];
  var score = 0, foods = 0, inLevel = 0, level = 0;
  var chain = 0, chainLeft = 0, mult = 1;
  var bestChain = 0, bestChainMult = 1;
  var foodP = -1, foodUpAt = 0;
  var goldP = -1, goldLeft = 0, goldUpAt = 0;
  var pwP = -1, pwKind = -1, pwLeft = 0, pwUpAt = 0, lastPwKind = -1;
  var fx = { shield: 0, magnet: 0, slow: 0, fast: 0, double: 0 };
  var over = false, won = false, paused = false, ready = true, hold = false;
  var cause = '', winText = '', holdCause = '';
  var timeLeft = 0, playMs = 0;
  var gtime = 0;             // 游戏内时间（暂停/结算时不走）
  var nowT = 0;              // rAF 时间（视觉动画用，不受暂停影响）
  var acc = 0, stepN = 0, hitStop = 0;
  var flashUntil = -1e9, fadeFrom = -1e9, crashT = -1e9, crashP = -1;
  var last = 0, dirty = true;
  var scale = 1, lastW = 0;
  var overTimer = 0, noticeTimer = 0;
  var testStepMs = 0;
  var growthPulse = 0;

  var pathX = new Float32Array(CAP + 4);
  var pathY = new Float32Array(CAP + 4);
  var pathN = 0;

  var spX = new Float32Array(MAX_SPARKS), spY = new Float32Array(MAX_SPARKS);
  var spVX = new Float32Array(MAX_SPARKS), spVY = new Float32Array(MAX_SPARKS);
  var spR = new Float32Array(MAX_SPARKS), spBorn = new Float32Array(MAX_SPARKS);
  var spC = new Uint8Array(MAX_SPARKS);
  var spN = 0;

  var DIRS = {
    ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1],
    a: [-1, 0], w: [0, -1], d: [1, 0], s: [0, 1]
  };

  function nowMs() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
  }

  /* ═════════════ 10. 音效（WebAudio 合成，零外部文件） ═════════════ */

  var sfx = (function () {
    var ac = null, master = null, muted = storeGet(STORE_MUTED) === '1', armed = false;
    function ensure() {
      if (muted || !armed) return null;
      try {
        if (!ac) {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return null;
          ac = new Ctor();
          master = ac.createGain();
          master.gain.value = 0.16;
          master.connect(ac.destination);
        }
        if (ac.state === 'suspended' && ac.resume) ac.resume();
        return ac;
      } catch (e) { ac = null; return null; }
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
        osc.connect(g); g.connect(master);
        osc.start(t0); osc.stop(t0 + dur + 0.03);
      } catch (e) { /* 音频异常不影响游戏 */ }
    }
    return {
      arm: function (trusted) { if (!trusted) return; armed = true; ensure(); },
      muted: function () { return muted; },
      setMuted: function (m) { muted = !!m; storeSet(STORE_MUTED, muted ? '1' : '0'); if (!muted) { armed = true; ensure(); } },
      eat: function (n) { tone(420 + Math.min(6, n) * 70, 0.055, 'square', 0.2, 0, 640 + n * 60); },
      gold: function () { tone(880, 0.07, 'triangle', 0.24, 0); tone(1320, 0.12, 'triangle', 0.2, 0.07); },
      power: function (k) { tone(k === 'shrink' ? 300 : 660, 0.09, 'sine', 0.24, 0, k === 'shrink' ? 180 : 990); },
      guard: function () { tone(220, 0.14, 'sawtooth', 0.22, 0, 120); },
      die: function () { tone(180, 0.18, 'square', 0.24, 0, 90); tone(90, 0.34, 'sine', 0.26, 0.1, 46); },
      level: function () { tone(523, 0.1, 'square', 0.22, 0); tone(659, 0.1, 'square', 0.22, 0.09); tone(784, 0.16, 'square', 0.22, 0.18); },
      win: function () { tone(523, 0.12, 'square', 0.22, 0); tone(659, 0.12, 'square', 0.22, 0.1); tone(784, 0.12, 'square', 0.22, 0.2); tone(1046, 0.3, 'square', 0.22, 0.3); },
      tick: function () { tone(1200, 0.03, 'square', 0.12); }
    };
  })();

  /* ═════════════ 11. 粒子池 ═════════════ */

  function burst(x, y, colors, n) {
    var cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
    for (var i = 0; i < n; i++) {
      if (spN >= MAX_SPARKS) break;
      var a = (i / n) * TAU + rng() * 0.7;
      var sp = 0.045 + rng() * 0.085;
      spX[spN] = cx; spY[spN] = cy;
      spVX[spN] = Math.cos(a) * sp; spVY[spN] = Math.sin(a) * sp;
      spR[spN] = 1.3 + rng() * 2.4;
      spC[spN] = i % colors.length;
      spBorn[spN] = nowT;
      spN++;
    }
  }
  function pruneSparks(t) {
    var k = 0;
    for (var i = 0; i < spN; i++) {
      if (t - spBorn[i] < SPARK_MS) {
        if (k !== i) {
          spX[k] = spX[i]; spY[k] = spY[i]; spVX[k] = spVX[i]; spVY[k] = spVY[i];
          spR[k] = spR[i]; spC[k] = spC[i]; spBorn[k] = spBorn[i];
        }
        k++;
      }
    }
    spN = k;
  }

  /* ═════════════ 12. 速度 / 倍率 / 计分公式 ═════════════ */

  function stepMs() {
    if (testStepMs > 0) return testStepMs;
    var ms;
    if (MODE.levels) ms = LEVELS[level].ms - Math.min(16, inLevel * 2);
    else if (MODE.id === 'walls') ms = 155 - Math.min(76, (foods * 5) >> 1);
    else if (MODE.id === 'sprint') ms = 118 - Math.min(38, foods * 2);
    else ms = 150 - Math.min(82, foods * 3);
    if (fx.slow > 0) ms *= 1.7;
    if (fx.fast > 0) ms *= 0.58;
    if (ms < 60) ms = 60;
    if (ms > 420) ms = 420;
    return Math.round(ms);
  }

  function chainMult() {
    var m = 1 + ((chain - 1) >> 1);
    return m > CHAIN_MAX ? CHAIN_MAX : m;
  }
  function scoreMul() {
    var m = 1;
    if (fx.double > 0) m *= 2;
    if (fx.fast > 0) m *= 2;
    return m;
  }
  function goldPoints() {
    var p = Math.round(GOLD_BASE * (goldLeft / GOLD_MS));
    return p < GOLD_MIN ? GOLD_MIN : p;
  }

  /* ═════════════ 13. 地图编译 / 底图预渲染 ═════════════ */

  function clearBoard() {
    for (var i = 0; i < CAP; i++) { solid[i] = 0; dyn[i] = 0; }
    dynN = 0;
  }

  function stampRects(rects, keepSnake) {
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i][0], c = rects[i][1], h = rects[i][2], w = rects[i][3];
      for (var y = r; y < r + h; y++) {
        if (y < 0 || y >= N) continue;
        for (var x = c; x < c + w; x++) {
          if (x < 0 || x >= N) continue;
          if (keepSnake && onBody(x, y, false)) continue;   // 换关时不把墙压在蛇身上
          solid[y * N + x] = 1;
        }
      }
    }
  }

  function wallBlock(c, x, y) {
    var m = 0.6, w = CELL - m * 2;
    c.fillStyle = COL.wallEdge;
    c.fillRect(x + m, y + m, w, w);
    c.fillStyle = COL.wall;
    c.fillRect(x + m, y + m, w, w - 2.5);
    c.fillStyle = COL.wallTop;
    c.fillRect(x + m, y + m, w, 2.5);
  }

  function rebuildBg() {
    if (!lastW) return;
    var px = el.board.width;
    bg.width = px; bg.height = px;
    var b = bgCtx;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.fillStyle = COL.cell;
    b.fillRect(0, 0, px, px);
    var lw = Math.max(1, Math.round(scale));
    b.strokeStyle = COL.grid;
    b.lineWidth = lw;
    b.beginPath();
    for (var i = 1; i < N; i++) {
      var q = Math.round(i * CELL * scale) + (lw % 2 ? 0.5 : 0);
      b.moveTo(q, 0); b.lineTo(q, px);
      b.moveTo(0, q); b.lineTo(px, q);
    }
    b.stroke();
    b.setTransform(scale, 0, 0, scale, 0, 0);
    for (var p = 0; p < CAP; p++) {
      if (solid[p] || dyn[p]) wallBlock(b, (p % N) * CELL, ((p / N) | 0) * CELL);
    }
    b.setTransform(1, 0, 0, 1, 0, 0);
  }

  // 生长之墙：把新墙直接画进预渲染底图（帧内零成本）
  function paintWall(p) {
    if (!lastW) return;
    bgCtx.setTransform(scale, 0, 0, scale, 0, 0);
    wallBlock(bgCtx, (p % N) * CELL, ((p / N) | 0) * CELL);
    bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* 食物/道具落点：拒绝采样 + 兜底两趟扫描（零分配） */
  function cellOccupied(p) {
    if (isBlocked(p)) return true;
    if (p === foodP || p === goldP || p === pwP) return true;
    return onBody(p % N, (p / N) | 0, false);
  }
  function randFree() {
    for (var t = 0; t < 60; t++) {
      var p = (rng() * CAP) | 0;
      if (!cellOccupied(p)) return p;
    }
    var total = 0, q;
    for (q = 0; q < CAP; q++) if (!cellOccupied(q)) total++;
    if (!total) return -1;
    var pick = (rng() * total) | 0;
    for (q = 0; q < CAP; q++) {
      if (!cellOccupied(q)) {
        if (pick === 0) return q;
        pick--;
      }
    }
    return -1;
  }

  // 静态障碍之外的可达性检查（生成墙用；不考虑蛇身，蛇会自己让位）
  function pathExists(fromP, toP) {
    if (toP < 0) return true;
    bfsMark++;
    var qh = 0, qt = 0;
    bfsSeen[fromP] = bfsMark;
    bfsQ[qt++] = fromP;
    while (qh < qt) {
      var p = bfsQ[qh++];
      if (p === toP) return true;
      var x = p % N, y = (p / N) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        var ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        var np = ny * N + nx;
        if (bfsSeen[np] === bfsMark || isBlocked(np)) continue;
        bfsSeen[np] = bfsMark;
        bfsQ[qt++] = np;
      }
    }
    return false;
  }

  /* ═════════════ 14. 道具生成 / 生效 ═════════════ */

  function spawnGold() {
    var p = randFree();
    if (p < 0) return false;
    goldP = p; goldLeft = GOLD_MS; goldUpAt = gtime;
    return true;
  }

  function spawnPower() {
    var p = randFree();
    if (p < 0) return false;
    var k = (rng() * PW.length) | 0;
    if (k === lastPwKind) k = (k + 1) % PW.length;    // 别连着刷同一种
    lastPwKind = k;
    pwP = p; pwKind = k; pwLeft = PW_TTL; pwUpAt = gtime;
    return true;
  }

  function spawnWall() {
    var tries, p, x, y;
    for (tries = 0; tries < 90; tries++) {
      p = (rng() * CAP) | 0;
      x = p % N; y = (p / N) | 0;
      if (isBlocked(p)) continue;
      if (p === foodP || p === goldP || p === pwP) continue;
      if (onBody(x, y, false)) continue;
      var dx = Math.abs(x - sx[head]), dy = Math.abs(y - sy[head]);
      if (dx + dy < WALL_SAFE) continue;                               // 离头太近，会阴人
      if (nearWall(x, y)) continue;                                    // 不跟别的墙贴边
      dyn[p] = 1;
      if (!pathExists(headP(), foodP)) { dyn[p] = 0; continue; }        // 别把食物封死
      dynList[dynN++] = p;
      paintWall(p);
      burst(x, y, COL.spark, 6);
      dirty = true;
      return p;
    }
    return -1;
  }
  function nearWall(x, y) {
    if (x > 0 && isBlocked(y * N + x - 1)) return true;
    if (x < N - 1 && isBlocked(y * N + x + 1)) return true;
    if (y > 0 && isBlocked((y - 1) * N + x)) return true;
    if (y < N - 1 && isBlocked((y + 1) * N + x)) return true;
    return false;
  }

  function applyPower(ki) {
    var kind = PW[ki].k;
    if (kind === 'shrink') {
      var cut = slen - MIN_LEN;
      if (cut > 3) cut = 3;
      if (cut > 0) {
        slen -= cut;
        pulseHud(el.lenFloat, '-' + cut);
        burst(segX(slen - 1), segY(slen - 1), COL.spark, 8);
      }
    } else {
      fx[kind] = PW[ki].ms;
    }
    notice(PW[ki].name + '：' + PW[ki].desc, 1600);
  }

  /* 磁铁：每个游戏步把食物往蛇头拉一格（被身体/墙挡住就停，照 Google Magnet Mode） */
  function magnetPull() {
    if (goldP >= 0) goldP = pullOne(goldP, foodP, pwP);
    if (foodP >= 0) foodP = pullOne(foodP, goldP, pwP);
  }
  function pullOne(p, other1, other2) {
    var x = p % N, y = (p / N) | 0;
    var hx = sx[head], hy = sy[head];
    var dx = hx - x, dy = hy - y;
    if (dx === 0 && dy === 0) return p;
    var stepX = 0, stepY = 0;
    if (Math.abs(dx) >= Math.abs(dy)) stepX = dx > 0 ? 1 : -1;
    else stepY = dy > 0 ? 1 : -1;
    var nx = x + stepX, ny = y + stepY;
    if (nx < 0 || nx >= N || ny < 0 || ny >= N) return p;
    var np = ny * N + nx;
    if (isBlocked(np) || np === other1 || np === other2) return p;
    if (onBody(nx, ny, false)) return p;
    return np;
  }

  /* ═════════════ 15. 吃 / 计分 ═════════════ */

  function eatFood() {
    var x = sx[head], y = sy[head];
    foods++; inLevel++;
    chain++; if (chain > 99) chain = 99;
    chainLeft = CHAIN_MS;
    mult = chainMult();
    if (mult > bestChainMult) bestChainMult = mult;
    if (chain > bestChain) bestChain = chain;
    var gain = 10 * mult * scoreMul();
    score += gain;
    scoreFloat(gain);
    hitStop = hitStop > HITSTOP_EAT ? hitStop : HITSTOP_EAT;
    flashUntil = gtime + FLASH_MS;
    burst(x, y, COL.spark, SPARK_N);
    shake('sm');
    sfx.eat(chain);
    foodP = randFree();
    foodUpAt = gtime + stepMs();
    if (MODE.levels) {
      if (inLevel >= LEVELS[level].goal) { levelClear(); return; }
    } else if (MODE.limit) {
      timeLeft += SPRINT_FOOD_ADD;
      if (timeLeft > MODE.limit * 2) timeLeft = MODE.limit * 2;
    }
    if (foodP < 0) { finishWin('全场填满'); return; }
    if (foods > 0 && MODE.goldEvery && goldP < 0 && foods % MODE.goldEvery === 0) spawnGold();
    if (foods > 0 && MODE.pwEvery && pwP < 0 && foods % MODE.pwEvery === 0) spawnPower();
    if (MODE.wallsEvery && foods % MODE.wallsEvery === 0) spawnWall();
    if (score > best) { best = score; saveBest(); }
  }

  function eatGold() {
    var x = goldP % N, y = (goldP / N) | 0;
    chain++; chainLeft = CHAIN_MS;
    mult = chainMult();
    if (mult > bestChainMult) bestChainMult = mult;
    if (chain > bestChain) bestChain = chain;
    var gain = goldPoints() * mult * scoreMul();
    score += gain;
    scoreFloat(gain);
    hitStop = hitStop > HITSTOP_GOLD ? hitStop : HITSTOP_GOLD;
    flashUntil = gtime + FLASH_MS + 80;
    burst(x, y, COL.spark, SPARK_N + 6);
    burst(x, y, COL.spark, 6);
    shake('sm');
    sfx.gold();
    if (MODE.limit) { timeLeft += SPRINT_GOLD_ADD; if (timeLeft > MODE.limit * 2) timeLeft = MODE.limit * 2; }
    goldP = -1; goldLeft = 0;
    if (score > best) { best = score; saveBest(); }
  }

  function eatPower() {
    var k = pwKind;
    var x = pwP % N, y = (pwP / N) | 0;
    burst(x, y, COL.spark, 10);
    sfx.power(PW[k].k);
    applyPower(k);
    pwP = -1; pwLeft = 0;
  }

  /* ═════════════ 16. 死亡 / 结算 ═════════════ */

  function shake(kind) {
    var c = el.frame;
    c.classList.remove('shake', 'shake-sm');
    void c.offsetWidth;               // 重排一次让动画能重播
    c.classList.add(kind === 'sm' ? 'shake-sm' : 'shake');
  }

  function fatal(c, x, y) {
    crashP = (y >= 0 && y < N && x >= 0 && x < N) ? y * N + x : headP();
    crashT = nowT;
    if (fx.shield > 0) {                    // 护盾挡一次：原地停住，等一个安全方向
      fx.shield = 0;
      hold = true;
      holdCause = c;
      hitStop = HITSTOP_GUARD;
      shake('sm');
      sfx.guard();
      notice('护盾挡住了 · 换个方向', 1800);
      sync();
      return;
    }
    over = true;
    paused = false;
    hold = false;
    cause = c;
    fadeFrom = nowT;
    if (score > best) { best = score; saveBest(); }
    sfx.die();
    shake('shake');
    if (overTimer) clearTimeout(overTimer);
    overTimer = setTimeout(function () {
      overTimer = 0;
      showOverlay('over');
    }, OVER_DELAY);
    sync();
  }

  function finishWin(text) {
    over = true; won = true; paused = false; hold = false; cause = 'full';
    winText = text;
    fadeFrom = nowT - FADE_MS;   // 通关不褪色
    if (score > best) { best = score; saveBest(); }
    sfx.win();
    if (overTimer) clearTimeout(overTimer);
    overTimer = setTimeout(function () { overTimer = 0; showOverlay('win'); }, 300);
    sync();
  }

  function finishTime() {
    over = true; paused = false; hold = false; cause = 'time';
    if (score > best) { best = score; saveBest(); }
    sfx.level();
    showOverlay('over');
    sync();
  }

  function levelClear() {
    var bonus = 100 + level * 60;
    score += bonus;
    scoreFloat(bonus);
    sfx.level();
    burst(sx[head], sy[head], COL.spark, 18);
    shake('sm');
    // 注意：先判通关再自增 —— 否则 level 会越界到 LEVELS.length，
    // 之后 sync() 读 LEVELS[level].goal 会直接抛异常（整局卡死）。
    if (level + 1 >= LEVELS.length) {
      finishWin('八关通关');
      return;
    }
    level++;
    inLevel = 0;
    clearBoard();
    stampRects(LEVELS[level].rects, true);   // 换关：保留蛇身，与蛇重叠的格子不落墙
    rebuildBg();                             // 必须重画底图，否则新地图的墙不可见（只剩碰撞）
    goldP = -1; pwP = -1;
    foodP = randFree();
    foodUpAt = 0;
    ready = true;
    acc = 0;
    // 新图里如果头正对着墙，先进入待转向状态，避免一开局就撞死
    var nx = sx[head] + dirX, ny = sy[head] + dirY;
    if (nx < 0 || nx >= N || ny < 0 || ny >= N || isBlocked(ny * N + nx)) {
      hold = true;
      holdCause = 'obstacle';
      notice('前方是墙 · 换个方向继续', 2600);
    }
    dirty = true;
    showOverlay('ready');
    sync();
  }

  /* ═════════════ 17. 一步 ═════════════ */

  function popQ() {
    for (var i = 1; i < qN; i++) { qx[i - 1] = qx[i]; qy[i - 1] = qy[i]; }
    qN--;
  }

  function step() {
    if (over || paused || ready) return;

    if (hold) {
      if (qN === 0) {
        // 停住等方向的时候如果四邻全是死路，那本来就没救，直接按原死因结算（避免卡死）
        if (!anySafeExit()) { fatal(holdCause || 'obstacle', sx[head] + dirX, sy[head] + dirY); }
        return;
      }
      var tx = sx[head] + qx[0], ty = sy[head] + qy[0];
      if (fatalAt(tx, ty)) { popQ(); return; }
      dirX = qx[0]; dirY = qy[0]; popQ();
      hold = false;
      flashUntil = gtime + 120;
    } else if (qN > 0) {
      dirX = qx[0]; dirY = qy[0]; popQ();
    }

    var hx = sx[head] + dirX, hy = sy[head] + dirY;
    var out = hx < 0 || hx >= N || hy < 0 || hy >= N;
    if (out && MODE.wrap) { hx = (hx + N) % N; hy = (hy + N) % N; out = false; }
    if (out) { fatal('wall', hx, hy); return; }

    var p = hy * N + hx;
    var eating = p === foodP;
    var blocked = checkCell(hx, hy, eating);
    if (blocked === 1) { fatal('obstacle', hx, hy); return; }
    if (blocked === 2) { fatal('self', hx, hy); return; }

    head = head + 1; if (head >= CAP) head = 0;
    sx[head] = hx; sy[head] = hy;
    if (eating) { slen++; grew = 1; }
    else grew = 0;
    stepN++;
    playMs += stepMs();

    if (eating) { eatFood(); if (over) { sync(); return; } }
    if (goldP >= 0 && p === goldP) eatGold();
    if (pwP >= 0 && p === pwP) eatPower();
    if (fx.magnet > 0) magnetPull();
    sync();
  }

  function fatalAt(x, y) {
    if (x < 0 || x >= N || y < 0 || y >= N) return !MODE.wrap;
    var p = y * N + x;
    if (isBlocked(p)) return true;
    return onBody(x, y, p !== foodP);   // 落点是食物时会变长，尾格不算安全
  }

  // 停住等方向时用：四个方向里还有没有一个能走
  function anySafeExit() {
    var hx = sx[head], hy = sy[head];
    for (var d = 0; d < 4; d++) {
      var tx = hx + (d === 0 ? 1 : d === 1 ? -1 : 0);
      var ty = hy + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (!fatalAt(tx, ty)) return true;
    }
    return false;
  }

  /* ═════════════ 18. 游戏时钟（暂停不计时） ═════════════ */

  function advance(dt) {
    var i, k, before;
    gtime += dt;
    if (chainLeft > 0) {
      chainLeft -= dt;
      if (chainLeft <= 0) { chainLeft = 0; chain = 0; mult = 1; }
    }
    for (i = 0; i < chipEls.length; i++) {
      k = chipEls[i].k;
      before = fx[k];
      if (before > 0) {
        fx[k] = before - dt;
        if (fx[k] < 0) fx[k] = 0;
      }
    }
    if (goldP >= 0) {
      goldLeft -= dt;
      if (goldLeft <= 0) { goldP = -1; goldLeft = 0; dirty = true; }
    }
    if (pwP >= 0) {
      pwLeft -= dt;
      if (pwLeft <= 0) { pwP = -1; pwLeft = 0; }
    }
    if (MODE.limit) {
      timeLeft -= dt;
      if (timeLeft <= 0) { timeLeft = 0; finishTime(); return; }
      if (timeLeft < 10000) {
        var sec = Math.ceil(timeLeft / 1000);
        if (sec !== lastTick) { lastTick = sec; sfx.tick(); }
      }
    }
  }
  var lastTick = -1;

  /* ═════════════ 19. HUD / 遮罩 / 提示 ═════════════ */

  var lastScore = -1, lastBest = -1, lastLen = -1, lastChain = -1, lastBarPct = -1, lastBarTxt = '';

  function sync() {
    if (score !== lastScore) { lastScore = score; el.score.textContent = String(score); }
    var bv = score > best ? score : best;
    if (bv !== lastBest) { lastBest = bv; el.best.textContent = String(bv); }
    if (slen !== lastLen) { lastLen = slen; el.len.textContent = String(slen); }
    if (mult !== lastChain) {
      lastChain = mult;
      el.chain.textContent = '×' + mult;
      el.chainWrap.classList.toggle('off', mult <= 1);
    }
    el.pause.textContent = paused ? '继续' : '暂停';

    // 关卡 / 限时进度条
    var pct = 0;
    if (MODE.levels) {
      el.bar.classList.remove('off');
      pct = Math.round(inLevel / LEVELS[level].goal * 100);
      var txt = inLevel + '/' + LEVELS[level].goal;
      if (txt !== lastBarTxt) {
        lastBarTxt = txt;
        el.barVal.textContent = txt;
        el.barLabel.textContent = '第 ' + (level + 1) + ' 关 · ' + LEVELS[level].name;
      }
    } else if (MODE.limit) {
      el.bar.classList.remove('off');
      pct = Math.round(timeLeft / MODE.limit * 100);
      if (pct > 100) pct = 100;
      var dec = Math.ceil(timeLeft / 100);          // 只按 0.1s 粒度改 DOM（避免每步拼字符串）
      if (dec !== lastBarTxt) {
        lastBarTxt = dec;
        el.barVal.textContent = (timeLeft / 1000).toFixed(1) + 's';
        el.barLabel.textContent = '剩余时间 · 吃一口 +2s';
      }
    } else {
      el.bar.classList.add('off');
    }
    el.bar.classList.toggle('urgent', MODE.limit ? timeLeft < 10000 : false);
    if (pct !== lastBarPct) { lastBarPct = pct; el.barFill.style.width = pct + '%'; }
    syncFx();
    dirty = true;
  }

  // 道具计时条：只在整数百分比变化时写 DOM
  function syncFx() {
    for (var i = 0; i < chipEls.length; i++) {
      var c = chipEls[i], v = fx[c.k];
      var pct = v <= 0 ? 0 : Math.max(1, Math.round(v / PW_MS_MAX[i] * 100));
      if (pct === c.last) continue;
      c.last = pct;
      c.el.classList.toggle('on', pct > 0);
      if (pct > 0) c.bar.style.width = pct + '%';
    }
  }

  function scoreFloat(n) {
    el.float.textContent = '+' + n;
    el.float.classList.remove('on');
    void el.float.offsetWidth;
    el.float.classList.add('on');
  }
  function pulseHud(node, text) {
    node.textContent = text;
    node.classList.remove('on');
    void node.offsetWidth;
    node.classList.add('on');
  }

  function notice(text, ms) {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = 0; }
    el.notice.textContent = text;
    el.notice.classList.add('show');
    noticeTimer = setTimeout(function () {
      noticeTimer = 0;
      el.notice.classList.remove('show');
    }, ms || 2600);
  }

  function showOverlay(kind) {
    var lite = kind === 'ready';
    el.overlay.classList.toggle('lite', lite);
    el.overlay.classList.add('on');
    if (kind === 'ready') {
      el.ovEmoji.textContent = '🐍';
      if (MODE.levels) {
        el.ovTitle.textContent = '第 ' + (level + 1) + ' 关 · ' + LEVELS[level].name;
        el.ovSub.textContent = '目标：吃 ' + LEVELS[level].goal + ' 个水果 · ' + LEVELS[level].tip;
      } else if (MODE.id === 'walls') {
        el.ovTitle.textContent = MODE.name;
        el.ovSub.textContent = '每吃 2 个水果长出一面墙 · 墙不会贴到你的头';
      } else if (MODE.limit) {
        el.ovTitle.textContent = MODE.name;
        el.ovSub.textContent = '60 秒 · 吃水果 +2s · 金苹果 +5s';
      } else {
        el.ovTitle.textContent = MODE.name;
        el.ovSub.textContent = '边界是穿墙的 · 只有咬到自己才算死';
      }
      el.ovA.textContent = '模式最佳 ' + bestByMode[modeIdx];
      el.ovB.textContent = '长度 ' + slen + (foods ? ' · 已吃 ' + foods : '');
      el.ovC.textContent = '方向键 / 滑动开始';
      el.again.textContent = '开始';
    } else if (kind === 'pause') {
      el.ovEmoji.textContent = '⏸';
      el.ovTitle.textContent = '已暂停';
      el.ovSub.textContent = MODE.name;
      el.ovA.textContent = '当前分数 ' + score;
      el.ovB.textContent = '长度 ' + slen + ' · 连吃 ×' + mult;
      el.ovC.textContent = '空格 / 点继续';
      el.again.textContent = '继续';
    } else if (kind === 'win') {
      el.ovEmoji.textContent = '🏆';
      el.ovTitle.textContent = '通关！';
      el.ovSub.textContent = winText || '全部目标完成';
      el.ovA.textContent = '最终得分 ' + score + ' · 最高 ' + best;
      el.ovB.textContent = '长度 ' + slen + ' · 最长连锁 ×' + bestChainMult;
      el.ovC.textContent = '模式最佳 ' + bestByMode[modeIdx];
      el.again.textContent = '再来一次';
    } else {
      el.ovEmoji.textContent = cause === 'wall' ? '🧱' : cause === 'self' ? '🌀' : cause === 'time' ? '⏰' : '🪨';
      el.ovTitle.textContent = cause === 'wall' ? '撞墙了' : cause === 'self' ? '咬到自己' : cause === 'time' ? '时间到' : '撞上障碍';
      el.ovSub.textContent = MODE.name + (MODE.levels ? ' · 第 ' + (level + 1) + ' 关' : '');
      el.ovA.textContent = '得分 ' + score + ' · 最高 ' + best;
      el.ovB.textContent = '长度 ' + slen + ' · 最长连锁 ×' + bestChainMult + ' · ' + (playMs / 1000).toFixed(1) + 's';
      el.ovC.textContent = '模式最佳 ' + bestByMode[modeIdx];
      el.again.textContent = '再来一次';
    }
  }
  function hideOverlay() { el.overlay.classList.remove('on'); }

  /* ═════════════ 20. 输入 ═════════════ */

  function pushQ(dx, dy) {
    if (qN >= QUEUE_MAX) return;
    qx[qN] = dx; qy[qN] = dy; qN++;
  }

  function press(key) {
    var k = typeof key === 'string' ? key : '';
    if (k.length === 1) k = k.toLowerCase();
    var d = DIRS[k];

    if (d) {
      if (over) return;
      var rX = qN ? qx[qN - 1] : dirX, rY = qN ? qy[qN - 1] : dirY;
      if (d[0] === -rX && d[1] === -rY) return;             // 禁止 180° 反向
      if (ready) {
        if (!(d[0] === dirX && d[1] === dirY)) pushQ(d[0], d[1]);
        start();
        return;
      }
      if (paused) return;
      if (!(d[0] === rX && d[1] === rY) && qN < QUEUE_MAX) pushQ(d[0], d[1]);
      return;
    }
    if (k >= '1' && k <= '4') { setMode(+k - 1); return; }
    if (k === ' ' || k === 'Space' || k === 'Spacebar' || k === 'p') { togglePause(); return; }
    if (k === 'r') { restart(); return; }
    if (k === 'm') { setMuted(!sfx.muted()); return; }
    if (k === 'Enter') {
      if (over) restart();
      else if (paused) togglePause();
      else if (ready) start();
      else togglePause();
    }
  }

  function start() {
    if (!ready) return;
    ready = false;
    paused = false;
    acc = 0;
    hideOverlay();
    step();                       // 立即走一格（和旧版一致的手感）
  }

  function togglePause() {
    if (over) return;
    if (ready) { start(); return; }
    paused = !paused;
    if (paused) showOverlay('pause');
    else hideOverlay();
    sync();
  }

  function setMode(i) {
    if (i < 0 || i >= MODES.length) return false;
    modeIdx = i;
    MODE = MODES[i];
    syncModeButtons();
    restart();
    return true;
  }
  function syncModeButtons() {
    var list = el.modes.getElementsByTagName('button');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('on', Number(list[i].getAttribute('data-mode')) === modeIdx);
    }
  }

  function setMuted(m) {
    sfx.setMuted(m);
    setMutedLabel();
  }
  // 开局只改按钮外观，不创建 AudioContext（否则浏览器会在控制台警告自动播放）
  function setMutedLabel() {
    var m = sfx.muted();
    el.mute.textContent = m ? '🔇 静音' : '🔊 音效';
    el.mute.setAttribute('aria-pressed', m ? 'true' : 'false');
  }

  /* ═════════════ 21. 重置 / 开局 ═════════════ */

  function placeSnake(len, cx, cy, dx, dy) {
    slen = 0; head = 0; qN = 0;
    var i;
    for (i = 0; i < len; i++) {
      var k = head - i; while (k < 0) k += CAP;
      sx[k] = cx - i * dx; sy[k] = cy - i * dy;
    }
    slen = len; grew = 1;
    dirX = dx; dirY = dy;
  }

  function reset() {
    rng = mulberry32(seed);
    MODE = MODES[modeIdx];
    score = 0; foods = 0; inLevel = 0; level = 0;
    chain = 0; chainLeft = 0; mult = 1; bestChain = 0; bestChainMult = 1;
    over = false; won = false; paused = false; ready = true; hold = false;
    cause = ''; winText = ''; holdCause = ''; acc = 0; stepN = 0; playMs = 0; gtime = 0; hitStop = 0;
    flashUntil = -1e9; fadeFrom = -1e9; crashT = -1e9; crashP = -1; spN = 0;
    goldP = -1; goldLeft = 0; pwP = -1; pwKind = -1; pwLeft = 0; lastPwKind = -1;
    fx.shield = fx.magnet = fx.slow = fx.fast = fx.double = 0;
    for (var c = 0; c < chipEls.length; c++) { chipEls[c].last = -1; chipEls[c].el.classList.remove('on'); }
    timeLeft = MODE.limit || 0;
    lastTick = -1;
    lastScore = lastBest = lastLen = lastChain = lastBarPct = -1; lastBarTxt = '';
    best = bestByMode[modeIdx];

    clearBoard();
    placeSnake(MIN_LEN, 8, N >> 1, 1, 0);
    if (MODE.levels) stampRects(LEVELS[0].rects, false);
    else if (MODE.id === 'sprint') stampRects(SPRINT_RECTS, false);
    foodP = randFree();
    foodUpAt = 0;
    if (overTimer) { clearTimeout(overTimer); overTimer = 0; }
    el.frame.classList.remove('shake', 'shake-sm');
    rebuildBg();
    showOverlay('ready');
    sync();
  }

  function restart() {
    el.float.classList.remove('on');
    reset();
  }

  function setSeed(n) {
    seed = (typeof n === 'number' && isFinite(n)) ? Math.trunc(n) : 1;
    reset();
  }

  /* ═════════════ 22. 渲染 ═════════════ */

  function resize() {
    var w = el.board.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    var px = Math.round(w * Math.min(2, window.devicePixelRatio || 1));
    el.board.width = px;
    el.board.height = px;
    scale = px / SIZE;
    rebuildBg();
    dirty = true;
  }

  function progress() {
    var iv = stepMs();
    var p = iv > 0 ? acc / iv : 1;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  // 蛇的中心线：段 i 从"上一步它所在的格子"插值到"现在所在的格子"
  function buildPath() {
    var n = slen;
    if (n > CAP) n = CAP;
    var t = progress();
    var stationary = ready || over;
    var limit = n - 1;
    for (var i = 0; i < n; i++) {
      var hidx = head - i; while (hidx < 0) hidx += CAP;
      var cxp = sx[hidx], cyp = sy[hidx];
      var pidx;
      if (stationary) pidx = hidx;
      else if (i === limit && grew) pidx = hidx;      // 刚长出来的尾节原地不动
      else { pidx = hidx - 1; if (pidx < 0) pidx += CAP; }
      pathX[i] = (sx[pidx] + (cxp - sx[pidx]) * t) * CELL + CELL / 2;
      pathY[i] = (sy[pidx] + (cyp - sy[pidx]) * t) * CELL + CELL / 2;
    }
    pathN = n;
  }

  function drawFood() {
    if (foodP < 0) return;
    if (gtime < foodUpAt) return;
    var k = Math.min(1, (gtime - foodUpAt) / POP_MS);
    var x = (foodP % N) * CELL + CELL / 2;
    var y = ((foodP / N) | 0) * CELL + CELL / 2;
    var r = CELL * 0.29 * (0.55 + 0.45 * k) * (1 + 0.09 * Math.sin(nowT / 300));
    ctx.fillStyle = COL.foodHalo;
    ctx.beginPath(); ctx.arc(x, y, r * 1.85, 0, TAU); ctx.fill();
    ctx.fillStyle = COL.food;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.26, 0, TAU); ctx.fill();
  }

  function drawGold() {
    if (goldP < 0) return;
    if (gtime < goldUpAt) return;
    var k = Math.min(1, (gtime - goldUpAt) / ITEM_POP_MS);
    var x = (goldP % N) * CELL + CELL / 2;
    var y = ((goldP / N) | 0) * CELL + CELL / 2;
    var r = CELL * 0.34 * (0.5 + 0.5 * k);
    var spin = nowT / 420;
    ctx.fillStyle = COL.goldHalo;
    ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, TAU); ctx.fill();
    // 剩余时间环：越快吃分越高，环就是"倒计时"
    ctx.strokeStyle = 'rgba(217, 140, 0, .55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.45, -Math.PI / 2, -Math.PI / 2 + TAU * (goldLeft / GOLD_MS));
    ctx.stroke();
    ctx.fillStyle = COL.gold;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = spin + i * Math.PI / 5;
      var rr = i % 2 ? r * 0.48 : r;
      var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COL.goldDark;
    ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, TAU); ctx.fill();
  }

  function drawPower() {
    if (pwP < 0) return;
    if (gtime < pwUpAt) return;
    var k = Math.min(1, (gtime - pwUpAt) / ITEM_POP_MS);
    var d = PW[pwKind];
    var x = (pwP % N) * CELL + CELL / 2;
    var y = ((pwP / N) | 0) * CELL + CELL / 2;
    var s = CELL * 0.78 * (0.55 + 0.45 * k);
    var a = s / 2;
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = d.col;
    roundRect(x - a * 1.5, y - a * 1.5, s * 1.5, s * 1.5, a);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = d.col;
    roundRect(x - a, y - a, s, s, 4);
    ctx.fill();
    ctx.fillStyle = '#fffdf2';
    ctx.strokeStyle = '#fffdf2';
    glyph(pwKind, x, y, s);
    ctx.globalAlpha = 1;
  }

  // 每种道具一个可区分的白色图形（不依赖字体）
  function glyph(kind, x, y, s) {
    var r = s * 0.5;
    switch (PW[kind].k) {
      case 'shield':
        ctx.beginPath();
        ctx.moveTo(x - r * 0.62, y - r * 0.7);
        ctx.lineTo(x + r * 0.62, y - r * 0.7);
        ctx.lineTo(x + r * 0.62, y + r * 0.05);
        ctx.quadraticCurveTo(x + r * 0.62, y + r * 0.72, x, y + r * 0.88);
        ctx.quadraticCurveTo(x - r * 0.62, y + r * 0.72, x - r * 0.62, y + r * 0.05);
        ctx.closePath();
        ctx.fill();
        break;
      case 'magnet':
        ctx.lineWidth = s * 0.2;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(x, y + r * 0.1, r * 0.5, Math.PI, 0, true);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - r * 0.5, y + r * 0.1); ctx.lineTo(x - r * 0.5, y + r * 0.62);
        ctx.moveTo(x + r * 0.5, y + r * 0.1); ctx.lineTo(x + r * 0.5, y + r * 0.62);
        ctx.stroke();
        ctx.lineCap = 'round';
        break;
      case 'slow':      // 沙漏
        ctx.beginPath();
        ctx.moveTo(x - r * 0.55, y - r * 0.66); ctx.lineTo(x + r * 0.55, y - r * 0.66);
        ctx.lineTo(x - r * 0.34, y); ctx.lineTo(x + r * 0.55, y + r * 0.66);
        ctx.lineTo(x - r * 0.55, y + r * 0.66); ctx.lineTo(x + r * 0.34, y);
        ctx.closePath();
        ctx.fill();
        break;
      case 'fast':      // 双箭头 》》
        ctx.beginPath();
        ctx.moveTo(x - r * 0.7, y - r * 0.6); ctx.lineTo(x - r * 0.1, y); ctx.lineTo(x - r * 0.7, y + r * 0.6);
        ctx.lineTo(x - r * 0.6, y); ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + r * 0.1, y - r * 0.6); ctx.lineTo(x + r * 0.7, y); ctx.lineTo(x + r * 0.1, y + r * 0.6);
        ctx.lineTo(x + r * 0.2, y); ctx.closePath();
        ctx.fill();
        break;
      case 'double':    // 同心双环
        ctx.lineWidth = s * 0.13;
        ctx.beginPath(); ctx.arc(x, y, r * 0.6, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, r * 0.26, 0, TAU); ctx.stroke();
        break;
      default:          // 缩短：内向双箭头 ⇒⇐
        ctx.beginPath();
        ctx.moveTo(x - r * 0.72, y - r * 0.5); ctx.lineTo(x - r * 0.16, y); ctx.lineTo(x - r * 0.72, y + r * 0.5);
        ctx.lineTo(x - r * 0.42, y); ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + r * 0.72, y - r * 0.5); ctx.lineTo(x + r * 0.16, y); ctx.lineTo(x + r * 0.72, y + r * 0.5);
        ctx.lineTo(x + r * 0.42, y); ctx.closePath();
        ctx.fill();
        break;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSnake() {
    buildPath();
    if (!pathN) return;
    var hot = gtime < flashUntil;
    var fade = over && !won ? 1 - Math.min(1, (nowT - fadeFrom) / FADE_MS) : 1;
    if (fade <= 0) return;
    ctx.globalAlpha = 0.22 + 0.78 * fade;

    var full = CELL * 0.84;
    var body = hot ? COL.bodyHot : COL.body;
    var tail = pathN - TAPER > 1 ? pathN - TAPER : 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = body;

    // 躯干：一次描边（round join 让转角自然变圆）
    if (pathN > 1) {
      ctx.lineWidth = full;
      ctx.beginPath();
      ctx.moveTo(pathX[0], pathY[0]);
      var i;
      for (i = 1; i < tail - 1; i++) {
        ctx.quadraticCurveTo(pathX[i], pathY[i], (pathX[i] + pathX[i + 1]) / 2, (pathY[i] + pathY[i + 1]) / 2);
      }
      ctx.lineTo(pathX[tail - 1], pathY[tail - 1]);
      ctx.stroke();
      // 尾巴：逐段变细（round cap 保证接缝看不出）
      for (i = tail - 1; i < pathN - 1; i++) {
        var tt = (i - (tail - 1) + 1) / TAPER;
        ctx.lineWidth = full * (1 - 0.62 * tt);
        ctx.beginPath();
        ctx.moveTo(pathX[i], pathY[i]);
        ctx.lineTo(pathX[i + 1], pathY[i + 1]);
        ctx.stroke();
      }
    }

    // 头：比身体略宽的圆头 + 眼睛
    var hx = pathX[0], hy = pathY[0];
    var hr = CELL * 0.47;
    ctx.fillStyle = hot ? COL.headHot : COL.head;
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, TAU);
    ctx.fill();
    drawEyes(hx, hy, hot);
    if (hold) {                       // 待转向：头顶转一圈提示
      ctx.strokeStyle = 'rgba(27, 154, 170, .85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, CELL * 0.62 + 1.6 * Math.sin(nowT / 160), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawEyes(x, y, hot) {
    var fx2 = dirX * CELL * 0.2, fy2 = dirY * CELL * 0.2;
    var sx2 = dirX ? 0 : CELL * 0.19, sy2 = dirX ? CELL * 0.19 : 0;
    var ex, ey;
    ex = x + fx2 - sx2; ey = y + fy2 - sy2;
    ctx.fillStyle = COL.eye;
    ctx.beginPath(); ctx.arc(ex, ey, CELL * 0.12, 0, TAU); ctx.fill();
    ex = x + fx2 + sx2; ey = y + fy2 + sy2;
    ctx.beginPath(); ctx.arc(ex, ey, CELL * 0.12, 0, TAU); ctx.fill();
    ctx.fillStyle = COL.pupil;
    var px = x + dirX * CELL * 0.26, py = y + dirY * CELL * 0.26;
    ctx.beginPath();
    ctx.arc(px - sx2 * 0.9, py - sy2 * 0.9, CELL * 0.055, 0, TAU);
    ctx.arc(px + sx2 * 0.9, py + sy2 * 0.9, CELL * 0.055, 0, TAU);
    ctx.fill();
  }

  function drawSparks(t) {
    for (var i = 0; i < spN; i++) {
      var k = (t - spBorn[i]) / SPARK_MS;
      if (k >= 1) continue;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = COL.spark[spC[i]];
      ctx.beginPath();
      ctx.arc(spX[i] + spVX[i] * (t - spBorn[i]), spY[i] + spVY[i] * (t - spBorn[i]), spR[i] * (1 - k * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawCrash(t) {
    var k = (t - crashT) / 520;
    if (k < 0 || k >= 1 || crashP < 0) return;
    var x = (crashP % N) * CELL + CELL / 2;
    var y = ((crashP / N) | 0) * CELL + CELL / 2;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = COL.crash;
    ctx.lineWidth = 3 * (1 - k);
    ctx.beginPath();
    ctx.arc(x, y, CELL * (0.3 + k * 1.6), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!lastW) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFood();
    drawGold();
    drawPower();
    drawSnake();
    drawSparks(nowT);
    drawCrash(nowT);
  }

  function animating(t) {
    return ready || (!over && !paused) || spN > 0 || t < fadeFrom + FADE_MS || t < crashT + 520 ||
      gtime < flashUntil || gtime < foodUpAt || (goldP >= 0) || (pwP >= 0);
  }

  /* ═════════════ 23. 主循环 ═════════════ */

  function frame(t) {
    nowT = t;
    resize();
    var dt = last ? t - last : 0;
    last = t;
    if (dt > 100) dt = 100;

    if (!over && !paused && !ready) {
      if (hitStop > 0) {
        hitStop -= dt;
        if (hitStop < 0) hitStop = 0;
      } else {
        advance(dt);
        if (!over && !hold) {
          acc += dt;
          var iv = stepMs();
          while (acc >= iv) {
            acc -= iv;
            step();
            if (over || paused || hold) break;
            iv = stepMs();
          }
        }
      }
    }

    if (spN) pruneSparks(t);
    if (gtime < flashUntil || gtime < foodUpAt) { /* 保持重绘 */ }
    if (dirty || animating(t)) {
      draw();
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  /* ═════════════ 24. 测试钩子 ═════════════ */

  function snapshot() {
    var cells = [], i;
    for (i = 0; i < slen; i++) cells.push([segX(i), segY(i)]);
    var items = [];
    if (goldP >= 0) items.push({ kind: 'gold', x: goldP % N, y: (goldP / N) | 0, left: Math.round(goldLeft) });
    if (pwP >= 0) items.push({ kind: PW[pwKind].k, x: pwP % N, y: (pwP / N) | 0, left: Math.round(pwLeft) });
    var walls = [];
    for (i = 0; i < dynN; i++) walls.push([dynList[i] % N, (dynList[i] / N) | 0]);
    return {
      // —— 旧契约字段（一个都不能少 / 不能改名）——
      score: score,
      over: over,
      paused: paused,
      ready: ready,
      foods: foods,
      stepMs: stepMs(),
      dir: [dirX, dirY],
      snake: cells,
      food: foodP >= 0 ? [foodP % N, (foodP / N) | 0] : [-1, -1],
      best: best,
      seed: seed,
      // —— 扩展 ——
      mode: MODE.id,
      modeName: MODE.name,
      modeBest: bestByMode.slice(),
      level: level,
      levelName: MODE.levels ? LEVELS[level].name : '',
      goal: MODE.levels ? LEVELS[level].goal : 0,
      goalProgress: inLevel,
      len: slen,
      chain: chain,
      mult: mult,
      bestChainMult: bestChainMult,
      scoreMul: scoreMul(),
      items: items,
      effects: {
        shield: Math.round(fx.shield), magnet: Math.round(fx.magnet),
        slow: Math.round(fx.slow), fast: Math.round(fx.fast), double: Math.round(fx.double)
      },
      hold: hold,
      won: won,
      cause: cause,
      timeLeft: MODE.limit ? Math.round(timeLeft) : 0,
      walls: walls,
      wallCount: dynN,
      obstacleCount: countSolid(),
      sparks: spN,
      playMs: Math.round(playMs),
      gtime: Math.round(gtime),
      steps: stepN,
      queue: qN
    };
  }

  function countSolid() {
    var n = 0;
    for (var i = 0; i < CAP; i++) if (solid[i]) n++;
    return n;
  }

  function hookModeSet(i) { return setMode(i | 0); }

  function hookSpawnItem(kind, x, y) {
    var p;
    if (typeof x === 'number' && typeof y === 'number' && x >= 0 && x < N && y >= 0 && y < N) p = y * N + x;
    else p = randFree();
    if (p < 0) return false;
    if (kind === 'gold') { goldP = p; goldLeft = GOLD_MS; goldUpAt = gtime; dirty = true; return true; }
    if (kind === 'food') { foodP = p; foodUpAt = 0; dirty = true; return true; }
    if (kind === 'wall') { dyn[p] = 1; dynList[dynN++] = p; paintWall(p); dirty = true; return true; }
    for (var i = 0; i < PW.length; i++) {
      if (PW[i].k === kind) { pwP = p; pwKind = i; pwLeft = PW_TTL; pwUpAt = gtime; dirty = true; return true; }
    }
    return false;
  }

  function hookGrant(kind, ms) {
    for (var i = 0; i < chipEls.length; i++) {
      if (chipEls[i].k === kind) {
        fx[kind] = ms === undefined
          ? (kind === 'shield' ? 15000 : kind === 'magnet' ? 8000 : kind === 'slow' ? 6000 : kind === 'fast' ? 6000 : 10000)
          : ms;
        chipEls[i].last = -1;
        syncFx();
        return fx[kind];
      }
    }
    return -1;
  }

  function hookSetFood(x, y) {
    x = x | 0; y = y | 0;
    if (x < 0 || x >= N || y < 0 || y >= N) return false;
    foodP = y * N + x; foodUpAt = 0;
    return true;
  }

  function hookSetSnake(cells, d) {
    if (!cells || !cells.length) return false;
    var n = Math.min(cells.length, CAP - 1);
    head = 0;
    for (var i = 0; i < n; i++) {
      var k = head - i; while (k < 0) k += CAP;
      sx[k] = cells[i][0] | 0; sy[k] = cells[i][1] | 0;
    }
    slen = n; grew = 0; qN = 0; hold = false;
    if (d && d.length === 2) { dirX = d[0]; dirY = d[1]; }
    return true;
  }

  function hookForceLevel(n) {
    n = n | 0;
    if (n < 0 || n >= LEVELS.length) return false;
    level = n; inLevel = 0;
    clearBoard();
    stampRects(LEVELS[n].rects, true);
    rebuildBg();
    foodP = randFree();
    goldP = -1; pwP = -1;
    ready = true; over = false; won = false; acc = 0; hold = false;
    dirty = true;
    showOverlay('ready');
    sync();
    return true;
  }

  function hookStep() { step(); return stepN; }

  function hookAdvance(ms) {
    ms = Math.max(0, Math.min(120000, ms | 0));
    var left = ms;
    while (left > 0) {
      var d = left > 100 ? 100 : left;
      advance(d);
      if (over) break;
      left -= d;
    }
    sync();
    return { gtime: Math.round(gtime), goldLeft: Math.round(goldLeft), pwLeft: Math.round(pwLeft), timeLeft: Math.round(timeLeft) };
  }

  function hookSetStep(ms) { testStepMs = ms > 0 ? ms : 0; return testStepMs; }

  function hookPools() {
    return {
      sparks: spN, sparksMax: MAX_SPARKS,
      snakeCap: CAP, len: slen,
      pathCap: pathX.length,
      dynWalls: dynN, dynCap: CAP,
      domNodes: document.getElementsByTagName('*').length,
      items: (goldP >= 0 ? 1 : 0) + (pwP >= 0 ? 1 : 0) + 1
    };
  }

  // 逐张地图体检：尺寸、走廊、自由格连通性、墙体数量
  function hookMapCheck() {
    var out = [];
    var all = [];
    for (var i = 0; i < LEVELS.length; i++) all.push(LEVELS[i]);
    for (var m = 0; m < all.length + 1; m++) {
      var rec = m < all.length ? all[m] : { name: '60 秒冲刺', rects: SPRINT_RECTS };
      var g = new Uint8Array(CAP);
      var rects = rec.rects, r, c, h, w, y, x, p;
      for (var t = 0; t < rects.length; t++) {
        r = rects[t][0]; c = rects[t][1]; h = rects[t][2]; w = rects[t][3];
        for (y = r; y < r + h; y++) for (x = c; x < c + w; x++) g[y * N + x] = 1;
      }
      var walls = 0, free = 0;
      for (p = 0; p < CAP; p++) { if (g[p]) walls++; else free++; }
      // 走廊 + 出生点
      var spawnOk = !g[(N >> 1) * N + 6] && !g[(N >> 1) * N + 8] && !g[(N >> 1) * N + 7];
      var corridor = true;
      for (y = 9; y <= 11; y++) for (x = 0; x < N; x++) if (g[y * N + x]) corridor = false;
      // BFS
      bfsMark++;
      var qh = 0, qt = 0, start = (N >> 1) * N + 8;
      bfsSeen[start] = bfsMark; bfsQ[qt++] = start;
      var seen = 1;
      while (qh < qt) {
        p = bfsQ[qh++];
        x = p % N; y = (p / N) | 0;
        for (var d2 = 0; d2 < 4; d2++) {
          var nx = x + (d2 === 0 ? 1 : d2 === 1 ? -1 : 0);
          var ny = y + (d2 === 2 ? 1 : d2 === 3 ? -1 : 0);
          if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
          var np = ny * N + nx;
          if (g[np] || bfsSeen[np] === bfsMark) continue;
          bfsSeen[np] = bfsMark; bfsQ[qt++] = np; seen++;
        }
      }
      out.push({ name: rec.name, walls: walls, free: free, reachable: seen, spawnOk: spawnOk, corridor: corridor, connected: seen === free });
    }
    return out;
  }

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: setSeed,
    // 扩展钩子（供独立验证脚本驱动）
    setMode: hookModeSet,
    spawnItem: hookSpawnItem,
    grant: hookGrant,
    setFood: hookSetFood,
    setSnake: hookSetSnake,
    forceLevel: hookForceLevel,
    step: hookStep,
    advance: hookAdvance,
    setStep: hookSetStep,
    pools: hookPools,
    mapCheck: hookMapCheck
  };

  /* ═════════════ 25. 事件绑定 / 启动 ═════════════ */

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var known = !!DIRS[k] || k === ' ' || k === 'Spacebar' || k === 'p' || k === 'r' || k === 'm' || k === 'Enter' || (k >= '1' && k <= '4');
    if (!known) return;
    if (e.target && e.target.tagName === 'BUTTON' && (k === ' ' || k === 'Enter')) return;
    e.preventDefault();
    sfx.arm(e.isTrusted !== false);
    press(k);
  });

  var touchX = 0, touchY = 0;
  el.stage.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });

  el.stage.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX, dy = t.clientY - touchY;
    sfx.arm(true);
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
      if (over) restart();
      else if (ready) start();
      else togglePause();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) press(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
    else press(dy > 0 ? 'ArrowDown' : 'ArrowUp');
  }, { passive: true });

  el.board.addEventListener('click', function () {
    sfx.arm(true);
    if (over) restart();
    else if (ready) start();
    else if (paused) togglePause();
  });

  el.pad.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-dir]') : null;
    if (b) { sfx.arm(true); press(b.getAttribute('data-dir')); }
  });

  el.modes.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
    if (!b) return;
    sfx.arm(true);
    setMode(Number(b.getAttribute('data-mode')));
  });

  el.restart.addEventListener('click', function () { sfx.arm(true); restart(); });
  el.pause.addEventListener('click', function () { sfx.arm(true); togglePause(); });
  el.mute.addEventListener('click', function () { setMuted(!sfx.muted()); });
  el.again.addEventListener('click', function () {
    sfx.arm(true);
    if (paused && !over) togglePause();
    else if (ready) start();
    else restart();
  });

  el.float.addEventListener('animationend', function () { el.float.classList.remove('on'); });
  el.lenFloat.addEventListener('animationend', function () { el.lenFloat.classList.remove('on'); });
  el.frame.addEventListener('animationend', function (e) {
    if (e.animationName === 'shake' || e.animationName === 'shake-sm') el.frame.classList.remove('shake', 'shake-sm');
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  loadBest();
  setMutedLabel();
  syncModeButtons();
  reset();
  requestAnimationFrame(frame);
})();
