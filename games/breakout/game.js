/* 打砖块 — 经典 Breakout / Arkanoid 完整核心循环（纯原生、零依赖、可离线运行）
   =====================================================================
   经典要素落点：
     · 拍面位置决定出射角 + 拍面摩擦      aim / hitPaddle（±58°，拍速传给球）
     · 发球前瞄准 + 黏球 Catch            aim / catchT / releaseHeld
     · 球速 = 关卡基准 × 回合微加速 × 道具  targetSpeed / rallyBonus / speedMul
     · 最小水平·竖直分量 + 卡死看门狗      enforceMin / stuckT
     · 8 种砖：普通/多段/钢/炸弹/再生/移动/幽灵/金/普通  BRICK / damageBrick
     · 10 种胶囊（含 2 种负面，一次只掉一颗）rollCapsule / applyCapsule
     · 10 关脚本布局 + DOH BOSS + 无尽模式  LEVELS / genTile
     · 连击倍率 / 过关奖励 / 剩余生命奖励    comboMult / clearLevel / gameOver
     · 命中停顿 / 屏震 / 多层粒子 / 飘分      hitStop / shakeMag / 对象池
     · WebAudio 合成音效（开机预建声部池，零新增节点） SFX
   实体一律固定容量对象池，主循环内零分配。
   ===================================================================== */
(function () {
  'use strict';

  /* ───────────────── 1. 随机源（三路独立流，无闭包分配） ───────────────── */

  var G_SEED = 1;
  var gs = 1;             /* 玩法流：发球角度等 */
  var fs = 0x9E3779B9;    /* 特效流：不干扰玩法序列 */
  var ds = 0x2545F491;    /* 掉落流：每次掉落用当前分数重播种（Arkanoid 原版做法） */

  function mix(a) {
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function adv(a) { return (a + 0x6D2B79F5) | 0; }
  function rndG() { gs = adv(gs); return mix(gs); }
  function rndF() { fs = adv(fs); return mix(fs); }
  function rndD() { ds = adv(ds); return mix(ds); }

  /* ───────────────── 2. 最高分存档（file:// 下 localStorage 抛错则退内存） ───────────────── */

  var useLS = false;
  var memBest = 0;
  try {
    window.localStorage.setItem('__bk_probe', '1');
    window.localStorage.removeItem('__bk_probe');
    useLS = true;
  } catch (err) { useLS = false; }

  function readStore(key, dflt) {
    try {
      var v = useLS ? window.localStorage.getItem(key) : null;
      return v === null ? dflt : v;
    } catch (err) { return dflt; }
  }
  function writeStore(key, val) {
    try { if (useLS) window.localStorage.setItem(key, val); } catch (err) { /* 忽略 */ }
  }

  var STORE_BEST = 'games.breakout.best';
  var STORE_MUTE = 'games.breakout.mute';
  var best = (function () {
    var v = parseInt(readStore(STORE_BEST, '0'), 10);
    if (isFinite(v) && v > 0) { memBest = v; return v; }
    return memBest;
  })();

  function saveBest(v) {
    memBest = v;
    writeStore(STORE_BEST, String(v));
  }

  /* ───────────────── 3. 常量与几何 ───────────────── */

  var W = 440, H = 600;
  var COLS = 13, MAX_ROWS = 11;
  var BW = 30, BH = 16, GX = 2, GY = 3;
  var GRID_LEFT = (W - (COLS * BW + (COLS - 1) * GX)) / 2;   /* 13 */
  var GRID_TOP = 54;

  var PADDLE_Y = H - 46;
  var PADDLE_H = 11;
  var PAD_SHORT = 56, PAD_NORMAL = 76, PAD_WIDE = 104;
  var PADDLE_SPEED = 470;
  var PADDLE_FRICTION = 0.30;   /* 拍面摩擦：拍的水平速度传给球的比例 */
  var PADDLE_EASE = 12;

  var BALL_R = 5.6;
  var BASE_SPEED = 282;
  var LEVEL_SPEED_STEP = 0.055;  /* 每关 +5.5% */
  var RALLY_STEP = 0.012;        /* 每次接球 +1.2% */
  var RALLY_MAX = 0.36;
  var MAX_BALL_SPEED = 700;
  var MIN_VX_RATIO = 0.16;       /* 最小水平分量（防垂直死循环） */
  var MIN_VY_RATIO = 0.20;       /* 最小竖直分量（防横向通道里无限平飞） */
  var STUCK_LIMIT = 1.1;         /* 竖直分量长期过小的看门狗时限 */
  var PIERCE_LOCK = 0.35;        /* 穿透球对同一块砖的重复结算间隔 */
  var MAX_BOUNCE_ANGLE = 1.02;   /* 拍边缘出射角 ≈ 58° */
  var STEP_MAX = 3;              /* 子步长（< 球半径，保证不穿砖） */
  var MAX_DT = 1 / 30;

  var START_LIVES = 3, MAX_LIVES = 8;
  var MAX_LEVEL = 10;

  var MAX_BALLS = 8, MAX_BRICKS = 160, MAX_CAPS = 8, MAX_LASERS = 6;
  var MAX_PART = 300, MAX_RING = 8;
  var TRAIL_N = 8;

  var CAP_FALL = 108;
  var LASER_SPEED = 660, LASER_GAP = 0.4;
  var SHIELD_Y = H - 9, SHIELD_CHARGES = 3;
  var CATCH_HOLD = 5;
  var COMBO_WINDOW = 1.5;
  var DROP_MIN = 5, DROP_SPAN = 5;

  var HITSTOP_BRICK = 0.055, HITSTOP_BOMB = 0.10, HITSTOP_LIFE = 0.16, HITSTOP_WIN = 0.3;
  var SHAKE_BRICK = 1.1, SHAKE_SOLID = 1.4, SHAKE_BOMB = 5.5, SHAKE_LIFE = 4.5;

  var FRAG_GRAVITY = 880;

  /* 砖种 */
  var T_NORMAL = 0, T_HP1 = 1, T_HP2 = 2, T_HP3 = 3, T_SOLID = 4;
  var T_BOMB = 5, T_REGEN = 6, T_MOVER = 7, T_INVIS = 8, T_GOLD = 9, T_DOH = 10;
  var BRICK_NAME = ['normal', 'hp1', 'hp2', 'hp3', 'solid', 'bomb', 'regen', 'mover', 'invis', 'gold', 'doh'];
  var BRICK_SCORE = [10, 15, 25, 40, 0, 45, 35, 35, 45, 500, 150];
  var BRICK_HP = [1, 1, 2, 3, 1, 1, 1, 1, 1, 1, 16];
  var T_BREAKABLE = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1];
  var REGEN_DELAY = 4.5;
  var MOV_AMP = 18, MOV_SPEED = 1.15;
  var INVIS_PULSE = 8.5, INVIS_REVEAL = 1.1, INVIS_HIT_REVEAL = 2.2;
  var CHAIN_RADIUS = 1.75;   /* 炸弹连锁半径（格） */
  var CHAIN_LIMIT = 48;

  /* 胶囊 */
  var C_EXPAND = 0, C_REDUCE = 1, C_DISRUPT = 2, C_LASER = 3, C_CATCH = 4;
  var C_SLOW = 5, C_FAST = 6, C_LIFE = 7, C_PIERCE = 8, C_SHIELD = 9;
  var CAP_N = 10;
  var CAP_CH = ['E', 'R', 'D', 'L', 'C', 'S', 'F', 'P', 'B', 'G'];
  var CAP_NAME = ['扩拍', '缩拍', '三分球', '激光', '黏附', '慢速', '加速', '加命', '穿透', '护盾'];
  var CAP_COLOR = ['#06d6a0', '#ef476f', '#22c2d6', '#ffc43d', '#f37694', '#1b9aaa', '#e07a5f', '#ef476f', '#8e7dbe', '#2bb673'];
  var CAP_BAD = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0];
  var CAP_WEIGHT = [16, 10, 14, 12, 11, 9, 9, 4, 8, 7];
  var CAP_DUR = [22, 15, 0, 18, 20, 16, 16, 0, 14, 20];
  var CAP_SCORE = 100;       /* 拾取即得分（原版胶囊 1000 分，这里按分数尺度等比缩小） */

  var SPR_SCALE = 2, CAP_SPR_W = 24, CAP_SPR_H = 15;

  /* ───────────────── 4. 设计令牌（取自 /games/assets/base.css） ───────────────── */

  function token(name, fallback) {
    try {
      var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (err) { /* 用字面量兜底 */ }
    return fallback;
  }

  var COLOR_COURT = token('--surface', '#fffdf2');
  var COLOR_LINE = token('--muted', '#9a9a95');
  var COLOR_PADDLE = token('--c2', '#ef476f');
  var COLOR_PADDLE_TOP = token('--c5', '#f37694');
  var C1 = token('--c1', '#ffc43d'), C2 = token('--c2', '#ef476f'), C3 = token('--c3', '#1b9aaa');
  var C4 = token('--c4', '#06d6a0'), C5 = token('--c5', '#f37694'), C6 = token('--c6', '#22c2d6');
  var C7 = token('--c7', '#ffd470'), C8 = token('--c8', '#14727e');

  /* 关卡主题色板（每关换一套；同一套内相邻行刻意拉开色相，方便读行） */
  var THEMES = [
    [C2, C1, C4, C6, C5],
    [C3, C7, C2, C6, C1],
    [C1, C6, C5, C4, C2],
    [C4, C2, C6, C1, C3]
  ];
  var BRICK_COLORS = (function () {
    var a = [];
    a[T_NORMAL] = C1;
    a[T_HP1] = '#06d6a0';
    a[T_HP2] = '#ffc43d';
    a[T_HP3] = '#ef476f';
    a[T_SOLID] = '#8d9299';
    a[T_BOMB] = '#4a4458';
    a[T_REGEN] = '#7fc8a9';
    a[T_MOVER] = '#5c9ead';
    a[T_INVIS] = '#9aa7c7';
    a[T_GOLD] = '#f0b429';
    a[T_DOH] = '#5b3a70';
    return a;
  })();
  var BALL_COLOR = [C8, C2, C3, C4, C1, '#8e7dbe', '#e07a5f', C6];

  /* ───────────────── 5. 关卡数据（脚本布局，逐关只引入一个新机制） ───────────────── */

  /* 图例： . 空  n 普通  1/2/3 多段砖  # 钢砖  b 炸弹  r 再生  m 移动  i 幽灵  g 金砖  D BOSS */
  var LEVELS = [
    {
      name: '新手上路', tip: '空格或点按发球 · 拍边缘出射角更大', theme: 0,
      rows: [
        'nnnnnnnnnnnnn',
        'nnnnnnnnnnnnn',
        'nnnnnnnnnnnnn',
        '.nnnnnnnnnnn.'
      ]
    },
    {
      name: '立柱回廊', tip: '砖阵有空隙 · 球会从缝里穿上去', theme: 1,
      rows: [
        '.n.n.n.n.n.n.',
        '.n.n.n.n.n.n.',
        '.n.n.n.n.n.n.',
        'nnn.nnn.nnn.n'
      ]
    },
    {
      name: '双层装甲', tip: '多段砖要打多次 · 颜色越暖血越厚', theme: 2,
      rows: [
        '.22222222222.',
        '..111111111..',
        '..111111111..',
        '...1111111...'
      ]
    },
    {
      name: '钢梁', tip: '灰色钢砖打不掉 · 只能绕开或从侧面清', theme: 3,
      rows: [
        '###.......###',
        '..#1111111#..',
        '..#1111111#..',
        '..#1111111#..',
        '###.......###'
      ]
    },
    {
      name: '火药库', tip: '炸弹砖会连锁引燃一整片 · 连击分翻倍', theme: 2,
      rows: [
        '...bb...bb...',
        '..111111111..',
        '.11b1111b111.',
        '..111111111..',
        '...bb...bb...'
      ]
    },
    {
      name: '流沙', tip: '移动砖会横着滑 · 再生砖 4.5 秒后长回来（剩 2 块以下就不再长）', theme: 1,
      rows: [
        '.m.m.m.m.m.m.',
        '..r.r.r.r.r..',
        '..r.r.r.r.r..',
        '.m.m.m.m.m.m.',
        '..111111111..'
      ]
    },
    {
      name: '幻影', tip: '幽灵砖几乎看不见 · 打中会亮一下，全场每 8.5 秒闪一次', theme: 0,
      rows: [
        '.iiiiiiiiiii.',
        '..n.......n..',
        '..i.i.i.i.i..',
        '..n.......n..',
        '...iiiiiii...'
      ]
    },
    {
      name: '金库', tip: '金砖必掉胶囊 · 一颗 500 分', theme: 3,
      rows: [
        '..333333333..',
        '.1g1.....1g1.',
        '.11111111111.',
        '..1.1.1.1.1..'
      ]
    },
    {
      name: '要塞', tip: '中央钢墙把球场切成两半 · 先凿开通道', theme: 1,
      rows: [
        '##.........##',
        '#.222222222.#',
        '#..1111111..#',
        '#..11bbb11..#',
        '#..1111111..#',
        '#.222222222.#',
        '##.........##',
        '.....###.....'
      ]
    },
    {
      name: 'DOH', tip: 'BOSS 16 血 · 会横向冲撞 + 定期掉胶囊 · 半血狂暴', theme: 2,
      rows: [
        '....DDDDD....',
        '.............',
        '#...........#',
        '#...gg.gg...#',
        '#...........#',
        '#...........#'
      ]
    }
  ];

  /* 无尽模式：模板生成（wall / columns / mesh / cavern），强度随层级上升 */
  var GEN_TEMPLATE = ['wall', 'columns', 'mesh', 'cavern'];

  function genTile(r, c, tier, salt) {
    var tmpl = (salt + tier) % 4;
    var h = tileHash(r, c, tier, salt);
    var inside = false;

    if (tmpl === 0) {                      /* wall：顶部几行实心墙 */
      inside = r >= 1 && r <= 2 + Math.min(4, (tier >> 1) + 1) && !(c === 0 && r % 3 === 0);
    } else if (tmpl === 1) {               /* columns：竖柱 */
      inside = (c % 3 !== 2) && r >= 1 && r <= 4 + Math.min(3, tier >> 1);
    } else if (tmpl === 2) {               /* mesh：网格（带洞） */
      inside = ((r + c) % 2 === 0) && r >= 1 && r <= 5 + Math.min(3, tier >> 1);
    } else {                               /* cavern：凹形包围 */
      inside = (r <= 2 + Math.min(3, tier >> 1)) || (c <= 1) || (c >= COLS - 2);
      if (r > 6 && c > 2 && c < COLS - 3) inside = false;
    }
    if (!inside) return 46;                /* '.' */

    /* 类型混合：层级越高越多硬砖 / 特殊砖；钢砖占比封顶 12% 保证一定可清 */
    if (h > 0.955) return 35;              /* '#' */
    if (h > 0.90) return 98;               /* 'b' */
    if (h > 0.86 && tier >= 2) return 114; /* 'r' */
    if (h > 0.81 && tier >= 2) return 109; /* 'm' */
    if (h > 0.775 && tier >= 4) return 105;/* 'i' */
    if (h > 0.755 && tier >= 3) return 103;/* 'g' */
    var tough = Math.min(3, 1 + ((tier / 3) | 0) + (h > 0.6 ? 1 : 0));
    return 48 + tough;                     /* '1' / '2' / '3' */
  }

  function tileHash(r, c, t, salt) {
    var h = (r * 92837111) ^ (c * 689287499) ^ (t * 283923481) ^ ((salt + G_SEED) * 2654435761);
    h = Math.imul(h ^ (h >>> 15), 1 | h);
    h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  }

  /* ───────────────── 6. DOM ───────────────── */

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var stageEl = document.getElementById('stage');
  var flashEl = document.getElementById('flash');
  var comboBadgeEl = document.getElementById('combo-badge');
  var toastEl = document.getElementById('toast');
  var toastMainEl = document.getElementById('toast-main');
  var toastSubEl = document.getElementById('toast-sub');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var levelEl = document.getElementById('level');
  var lnameEl = document.getElementById('lname');
  var ballsEl = document.getElementById('balls');
  var comboEl = document.getElementById('combo');
  var floatEl = document.getElementById('float');
  var heartEls = document.querySelectorAll('#lives i');
  var overlayEl = document.getElementById('overlay');
  var overlayEmojiEl = document.getElementById('overlay-emoji');
  var overlayTitleEl = document.getElementById('overlay-title');
  var ovScoreEl = document.getElementById('ovScore');
  var ovLevelEl = document.getElementById('ovLevel');
  var ovBricksEl = document.getElementById('ovBricks');
  var ovComboEl = document.getElementById('ovCombo');
  var ovCapsEl = document.getElementById('ovCaps');
  var ovLifeLabelEl = document.getElementById('ovLifeLabel');
  var ovLifeEl = document.getElementById('ovLife');
  var ovBestEl = document.getElementById('ovBest');
  var overlayBtn = document.getElementById('again');
  var overlayBtn2 = document.getElementById('again2');
  var restartBtn = document.getElementById('restart');
  var muteBtn = document.getElementById('pad-mute');

  var paddleGrad = ctx.createLinearGradient(0, PADDLE_Y, 0, PADDLE_Y + PADDLE_H);
  paddleGrad.addColorStop(0, COLOR_PADDLE_TOP);
  paddleGrad.addColorStop(1, COLOR_PADDLE);
  var courtGrad = ctx.createLinearGradient(0, 0, 0, H);
  courtGrad.addColorStop(0, COLOR_COURT);
  courtGrad.addColorStop(1, '#fdf7e3');

  /* ───────────────── 7. 胶囊精灵（开机预渲染，帧内不写字、不建对象） ───────────────── */

  var capSprites = (function () {
    var out = [];
    for (var i = 0; i < CAP_N; i++) {
      var cv = document.createElement('canvas');
      cv.width = CAP_SPR_W * SPR_SCALE;
      cv.height = CAP_SPR_H * SPR_SCALE;
      var g = cv.getContext('2d');
      g.scale(SPR_SCALE, SPR_SCALE);
      g.fillStyle = CAP_BAD[i] ? '#3c3c46' : '#fffdf2';
      g.beginPath();
      if (g.roundRect) g.roundRect(0.5, 0.5, CAP_SPR_W - 1, CAP_SPR_H - 1, 7);
      else g.rect(0.5, 0.5, CAP_SPR_W - 1, CAP_SPR_H - 1);
      g.fill();
      g.strokeStyle = CAP_COLOR[i];
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = CAP_COLOR[i];
      g.beginPath();
      if (g.roundRect) g.roundRect(2.5, 2.5, CAP_SPR_W - 5, 3, 1.5);
      else g.rect(2.5, 2.5, CAP_SPR_W - 5, 3);
      g.fill();
      g.fillStyle = CAP_BAD[i] ? CAP_COLOR[i] : '#3c3c46';
      g.font = '700 11px -apple-system, "PingFang SC", Helvetica, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(CAP_CH[i], CAP_SPR_W / 2, CAP_SPR_H / 2 + 2.5);
      out.push(cv);
    }
    return out;
  })();

  /* ───────────────── 8. 音效（WebAudio 合成；声部池开机建好，永不新建节点） ───────────────── */

  var SFX = (function () {
    var actx = null;
    var master = null;
    var voices = [];        /* { osc, gain, until } */
    var noiseGain = null;
    var muted = readStore(STORE_MUTE, '0') === '1';
    var ready = false;
    var lastPlay = -1;
    var plays = 0;

    function build() {
      if (ready) return true;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      try { actx = new Ctor(); } catch (err) { actx = null; return false; }
      try {
        master = actx.createGain();
        master.gain.value = muted ? 0 : 0.5;
        master.connect(actx.destination);

        var kinds = ['square', 'square', 'square', 'triangle', 'triangle', 'sawtooth', 'sawtooth', 'sine'];
        var kindIdx = [0, 0, 0, 1, 1, 2, 2, 3];
        for (var i = 0; i < kinds.length; i++) {
          var o = actx.createOscillator();
          var g = actx.createGain();
          o.type = kinds[i];
          o.frequency.value = 440;
          g.gain.value = 0;
          o.connect(g);
          g.connect(master);
          o.start();
          voices.push({ idx: i, kind: kindIdx[i], osc: o, gain: g, until: 0 });
        }
        /* 噪声声部：一次生成 1 秒白噪缓冲，循环播放，用增益当包络 */
        var len = (actx.sampleRate || 44100) | 0;
        var buf = actx.createBuffer(1, len, actx.sampleRate || 44100);
        var ch = buf.getChannelData(0);
        for (var n = 0; n < len; n++) ch[n] = (rndF() * 2 - 1) * 0.6;
        var src = actx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        var ng = actx.createGain();
        ng.gain.value = 0;
        var flt = actx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.value = 1200;
        src.connect(flt);
        flt.connect(ng);
        ng.connect(master);
        src.start();
        noiseGain = ng;
        ready = true;
      } catch (err) { ready = false; }
      return ready;
    }

    function resume() {
      if (!build()) return;
      if (actx.state === 'suspended') { try { actx.resume(); } catch (err) { /* 忽略 */ } }
    }

    function setMuted(m) {
      muted = !!m;
      if (master) master.gain.value = muted ? 0 : 0.5;
      writeStore(STORE_MUTE, muted ? '1' : '0');
    }

    /* wave: 0 方波 1 三角 2 锯齿 3 正弦；slide: 目标频率（0 表示不滑） */
    function tone(freq, dur, wave, vol, slide) {
      if (!ready || muted) return -1;
      var now = actx.currentTime;
      /* lastPlay 初值 -1：新建的 AudioContext 里 currentTime 从 0 起，
         若也把 0 当成"上次播放时间"，开机的第一声会被无条件节流掉 */
      if (lastPlay >= 0 && now - lastPlay < 0.012) return -1;
      lastPlay = now;
      var v = null;
      for (var k = 0; k < voices.length; k++) {
        var c = voices[k];
        if (c.kind !== wave || c.until > now) continue;
        v = c; break;
      }
      if (!v) {
        for (var q = 0; q < voices.length; q++) if (voices[q].kind === wave && (v === null || voices[q].until < v.until)) v = voices[q];
      }
      if (!v) {
        for (var z = 0; z < voices.length; z++) if (v === null || voices[z].until < v.until) v = voices[z];
      }
      if (!v) return -1;
      v.until = now + dur + 0.02;
      plays++;
      var f = v.osc.frequency;
      f.cancelScheduledValues(now);
      f.setValueAtTime(freq, now);
      if (slide > 0) f.exponentialRampToValueAtTime(slide, now + dur);
      var g = v.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0.0001, now);
      g.linearRampToValueAtTime(vol, now + 0.006);
      g.exponentialRampToValueAtTime(0.0001, now + dur);
      return v.idx;
    }

    function noise(dur, vol, cutoff) {
      if (!ready || muted || !noiseGain) return;
      var now = actx.currentTime;
      plays++;
      var g = noiseGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(vol, now + 0.005);
      g.exponentialRampToValueAtTime(0.0001, now + dur);
    }

    return {
      resume: resume,
      isMuted: function () { return muted; },
      setMuted: setMuted,
      toggle: function () { setMuted(!muted); return muted; },
      ready: function () { return ready; },
      voices: function () { return voices.length; },
      plays: function () { return plays; },
      brick: function (row) { tone(300 + row * 42, 0.07, 0, 0.20); },
      tough: function () { tone(190, 0.09, 2, 0.20); },
      solid: function () { tone(110, 0.07, 2, 0.16, 80); },
      paddle: function (rel) { tone(220 + Math.abs(rel) * 90, 0.09, 1, 0.26, 150); },
      wall: function () { tone(160, 0.05, 1, 0.12); },
      boom: function () { noise(0.34, 0.5, 900); tone(90, 0.28, 2, 0.26, 40); },
      pick: function (bad) { if (bad) { tone(300, 0.16, 2, 0.24, 130); } else { tone(660, 0.1, 0, 0.22); tone(990, 0.14, 0, 0.18, 1180); } },
      laser: function () { tone(1200, 0.06, 2, 0.14, 500); },
      shield: function () { tone(520, 0.18, 1, 0.26, 260); },
      life: function () { tone(150, 0.5, 1, 0.3, 60); noise(0.4, 0.3, 500); },
      clear: function () { tone(660, 0.12, 0, 0.24); tone(880, 0.16, 0, 0.22, 1320); },
      over: function () { tone(330, 0.5, 2, 0.28, 110); },
      serve: function () { tone(440, 0.08, 1, 0.2, 620); }
    };
  })();

  /* ───────────────── 9. 对象池 ───────────────── */

  var balls = [];
  var bricks = [];
  var caps = [];
  var lasers = [];
  var parts = [];
  var rings = [];
  var i;

  (function allocPools() {
    for (i = 0; i < MAX_BALLS; i++) {
      balls.push({
        alive: false, x: 0, y: 0, vx: 0, vy: 0, r: BALL_R, ci: 0,
        held: false, holdX: 0, holdT: 0, stuckT: 0, squash: 0,
        tx: new Float32Array(TRAIL_N), ty: new Float32Array(TRAIL_N), tHead: 0, tN: 0
      });
    }
    for (i = 0; i < MAX_BRICKS; i++) {
      bricks.push({
        alive: false, type: T_NORMAL, hp: 1, hpMax: 1,
        x: 0, y: 0, w: BW, h: BH, row: 0, col: 0,
        baseX: 0, amp: 0, phase: 0, respawn: 0, reveal: 0, hitFlash: 0, born: 0, lock: 0
      });
    }
    for (i = 0; i < MAX_CAPS; i++) caps.push({ alive: false, kind: 0, x: 0, y: 0, spin: 0 });
    for (i = 0; i < MAX_LASERS; i++) lasers.push({ alive: false, x: 0, y: 0, vy: 0 });
    for (i = 0; i < MAX_PART; i++) {
      parts.push({ alive: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, life0: 1, size: 2, color: '#fff', rot: 0, spin: 0 });
    }
    for (i = 0; i < MAX_RING; i++) rings.push({ alive: false, x: 0, y: 0, r: 0, r1: 60, life: 0, life0: 1, color: '#fff', w: 3 });
  })();

  var ballN = 0;            /* 活跃球数（= 需要画/更新的数量，池紧凑存放） */
  var brickN = 0;           /* 池里被占用的砖槽数 */
  var laserN = 0;
  var partCursor = 0;
  var ringCursor = 0;
  var capN = 0;             /* 场上正在下落的胶囊数（经典规则：至多 1） */

  function spawnPart(kind, x, y, vx, vy, life, size, color, spin) {
    var p = parts[partCursor];
    partCursor = (partCursor + 1) % MAX_PART;
    p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.life0 = life; p.size = size; p.color = color; p.rot = 0; p.spin = spin;
  }
  function spawnRing(x, y, r1, life, color, w) {
    var g = rings[ringCursor];
    ringCursor = (ringCursor + 1) % MAX_RING;
    g.alive = true; g.x = x; g.y = y; g.r = 2; g.r1 = r1; g.life = life; g.life0 = life; g.color = color; g.w = w;
  }
  function spawnChips(cx, cy, w, h, color, count, power) {
    for (var k = 0; k < count; k++) {
      var ang = -Math.PI / 2 + (k - (count - 1) / 2) * (0.5 / count * 3) + (rndF() - 0.5) * 0.5;
      var sp = 90 + rndF() * 150 * power;
      spawnPart(0, cx + (rndF() - 0.5) * w * 0.7, cy + (rndF() - 0.5) * h * 0.6,
        Math.cos(ang) * sp, Math.sin(ang) * sp, 0.34 + rndF() * 0.22,
        2.5 + rndF() * 3, color, (rndF() - 0.5) * 14);
    }
  }
  function spawnSparks(x, y, color, count, power) {
    for (var k = 0; k < count; k++) {
      var ang = rndF() * Math.PI * 2;
      var sp = (60 + rndF() * 190) * power;
      spawnPart(1, x, y, Math.cos(ang) * sp, Math.sin(ang) * sp,
        0.18 + rndF() * 0.2, 1.6 + rndF() * 1.6, color, 0);
    }
  }

  /* ───────────────── 10. 状态 ───────────────── */

  var score = 0, lives = START_LIVES, level = 1;
  var over = false, won = false, paused = false, served = false, endless = false;
  var continueUsed = false, lifeGiven = false, endBonus = 0, endBonusLabel = '剩余生命奖励';
  var bricksRemaining = 0, brickTotal = 0, layoutSig = 0, levelKinds = 0, kindsSeen = 0;
  var bricksDestroyed = 0, capsCollected = 0;
  var comboCount = 0, comboT = 0, bestCombo = 0, comboMult2 = 1;
  var paddleX = (W - PAD_NORMAL) / 2, paddleW = PAD_NORMAL, paddleTarget = PAD_NORMAL;
  var paddleVX = 0, paddleSquash = 0;
  var held = { left: false, right: false, aimL: false, aimR: false };
  var dragging = false;
  var aim = 0, AIM_MAX = 1.05, AIM_STEP = 0.085;
  var levelTime = 0, shakeMag = 0, shakeT = 0, hitStop = 0, levelEpoch = 0;
  var dropCounter = 0, dropNeed = 6, lastCapsule = -1;
  var expandT = 0, reduceT = 0, laserT = 0, catchT = 0, slowT = 0, fastT = 0, pierceT = 0, shieldT = 0;
  var shieldCharges = 0, laserGap = 0, dohIdx = -1, dohDropT = 5, invisPulse = INVIS_PULSE;
  var curName = '', curTip = '', palette = THEMES[0];
  var levelRows = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var rallyBonus = 0;

  function baseSpeedFor(lv) {
    return BASE_SPEED * (1 + (lv - 1) * LEVEL_SPEED_STEP);
  }
  function speedMulNow() {
    if (fastT > 0) return 1.35;
    if (slowT > 0) return 0.72;
    return 1;
  }
  function targetSpeed() {
    var sp = baseSpeedFor(level) * (1 + rallyBonus) * speedMulNow();
    return sp > MAX_BALL_SPEED ? MAX_BALL_SPEED : sp;
  }

  function ballSpeed(b) { return Math.sqrt(b.vx * b.vx + b.vy * b.vy); }

  function comboMult() {
    var m = 1 + ((comboCount - comboCount % 2) >> 1);
    return m > 8 ? 8 : m;
  }

  /* ───────────────── 11. 关卡装载 ───────────────── */

  function clearBricks() {
    for (i = 0; i < MAX_BRICKS; i++) {
      bricks[i].alive = false;
      bricks[i].respawn = 0;
      bricks[i].reveal = 0;
    }
    brickN = 0;
    dohIdx = -1;
  }

  function levelDef(lv) {
    if (lv <= MAX_LEVEL) return LEVELS[lv - 1];
    return { name: '无尽 ' + (lv - MAX_LEVEL), tip: '', theme: (lv) % 4, rows: null, tier: lv - MAX_LEVEL };
  }

  function buildLevel(lv) {
    clearBricks();
    var def = levelDef(lv);
    curName = def.name;
    curTip = def.tip;
    palette = THEMES[def.theme % THEMES.length];
    levelRows = def.rows ? def.rows.length : Math.min(MAX_ROWS, 4 + Math.min(6, ((def.tier || 0) >> 1) + 2));
    var chainSalt = (lv * 7919) | 0;

    bricksRemaining = 0; brickTotal = 0; layoutSig = 0; levelKinds = 0;
    for (var r = 0; r < levelRows; r++) {
      for (var c = 0; c < COLS; c++) {
        var code = def.rows ? def.rows[r].charCodeAt(c) : genTile(r, c, def.tier || 0, chainSalt);
        if (code === 46) continue;                       /* '.' */
        if (code === 68) {                               /* 'D' BOSS：占 5×2 格，只建一次 */
          if (dohIdx >= 0) continue;
          var db = allocBrick();
          if (db < 0) continue;
          var bd = bricks[db];
          bd.type = T_DOH; bd.hp = BRICK_HP[T_DOH]; bd.hpMax = bd.hp;
          bd.w = 5 * BW + 4 * GX; bd.h = 2 * BH + GY;
          bd.x = GRID_LEFT + c * (BW + GX); bd.baseX = bd.x;
          bd.y = GRID_TOP + r * (BH + GY);
          bd.row = r; bd.col = c; bd.amp = 62; bd.phase = 0; bd.born = 1;
          dohIdx = db;
          bricksRemaining++; brickTotal++;
          levelKinds |= (1 << T_DOH);
          continue;
        }
        var t = tileType(code);
        if (t < 0) continue;
        var bi = allocBrick();
        if (bi < 0) continue;
        var b = bricks[bi];
        b.type = t;
        b.hp = BRICK_HP[t]; b.hpMax = b.hp;
        b.w = BW; b.h = BH;
        b.x = GRID_LEFT + c * (BW + GX);
        b.y = GRID_TOP + r * (BH + GY);
        b.baseX = b.x; b.row = r; b.col = c; b.amp = 0; b.phase = 0;
        b.born = 1;
        if (t === T_MOVER) { b.amp = MOV_AMP; b.phase = (c * 1.1 + r * 0.7); }
        brickTotal++;
        if (T_BREAKABLE[t]) bricksRemaining++;
        levelKinds |= (1 << t);
        layoutSig = (layoutSig * 31 + (r * 13 + c + 1) * (t + 2)) | 0;
      }
    }
    kindsSeen |= levelKinds;
    levelEpoch++;
  }

  function tileType(code) {
    switch (code) {
      case 110: return T_NORMAL;
      case 49: return T_HP1;
      case 50: return T_HP2;
      case 51: return T_HP3;
      case 35: return T_SOLID;
      case 98: return T_BOMB;
      case 114: return T_REGEN;
      case 109: return T_MOVER;
      case 105: return T_INVIS;
      case 103: return T_GOLD;
      default: return -1;
    }
  }

  function allocBrick() {
    for (var k = 0; k < MAX_BRICKS; k++) {
      if (!bricks[k].alive && bricks[k].respawn <= 0) {
        var b = bricks[k];
        b.alive = true; b.reveal = 0; b.hitFlash = 0; b.respawn = 0; b.born = 0; b.lock = 0;
        if (k + 1 > brickN) brickN = k + 1;
        return k;
      }
    }
    return -1;
  }

  function aliveBreakableCount() {
    var c = 0;
    for (var k = 0; k < brickN; k++) if (bricks[k].alive && T_BREAKABLE[bricks[k].type]) c++;
    return c;
  }

  /* ───────────────── 12. 球与拍 ───────────────── */

  var ball0 = balls[0];

  function parkBall(b) {
    b.x = paddleX + paddleW / 2;
    b.y = PADDLE_Y - b.r - 1;
    b.vx = 0; b.vy = 0;
    b.tN = 0; b.tHead = 0;
    b.held = false;
  }

  function pushTrail(b) {
    b.tx[b.tHead] = b.x;
    b.ty[b.tHead] = b.y;
    b.tHead = (b.tHead + 1) % TRAIL_N;
    if (b.tN < TRAIL_N) b.tN++;
  }

  function clearBalls() {
    for (i = 0; i < MAX_BALLS; i++) balls[i].alive = false;
    ballN = 0;
  }

  function spawnBall(x, y, vx, vy, ci) {
    for (var k = 0; k < MAX_BALLS; k++) {
      if (balls[k].alive) continue;
      var b = balls[k];
      b.alive = true; b.x = x; b.y = y; b.vx = vx; b.vy = vy;
      b.r = BALL_R; b.ci = ci % BALL_COLOR.length;
      b.held = false; b.squash = 0; b.stuckT = 0;
      b.tN = 0; b.tHead = 0;
      pushTrail(b);
      if (k + 1 > ballN) ballN = k + 1;
      return b;
    }
    return null;
  }

  function killBall(b) {
    b.alive = false;
    var idx = balls.indexOf(b);
    if (idx >= 0 && idx === ballN - 1) { while (ballN > 0 && !balls[ballN - 1].alive) ballN--; }
  }

  function aliveBalls() {
    var c = 0;
    for (var k = 0; k < ballN; k++) if (balls[k].alive) c++;
    return c;
  }

  function enforceMin(b) {
    var m = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (m < 0.001) { b.vy = -targetSpeed(); m = Math.abs(b.vy); }
    var minVx = m * MIN_VX_RATIO, minVy = m * MIN_VY_RATIO;
    if (b.vx < minVx && b.vx > -minVx) {
      /* 恰好垂直时朝场地中心那侧破平（不偏向某一边） */
      b.vx = (b.vx !== 0 ? (b.vx < 0 ? -minVx : minVx) : (b.x < W / 2 ? minVx : -minVx));
    }
    if (b.vy < minVy && b.vy > -minVy) b.vy = b.vy < 0 ? -minVy : minVy;
    var m2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (m2 > MAX_BALL_SPEED) { var k = MAX_BALL_SPEED / m2; b.vx *= k; b.vy *= k; }
  }

  function setDir(b, ang, sp) {
    b.vx = Math.sin(ang) * sp;
    b.vy = -Math.cos(ang) * sp;
  }

  /* 把当前球速缩放到目标速度（保持方向，方向由调用方给） */
  function normalizeTo(b, sp) {
    var m = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (m < 0.001) return;
    var k = sp / m;
    b.vx *= k; b.vy *= k;
  }

  function paddleCenter() { return paddleX + paddleW / 2; }

  /* 拍面命中：位置决定角度，拍速决定摩擦增量（经典 English） */
  function hitPaddle(b) {
    if (b.vy <= 0 || b.held) return false;
    if (!circleHitsRect(b.x, b.y, paddleX, PADDLE_Y, paddleW, PADDLE_H)) return false;

    var rel = clamp((b.x - paddleCenter()) / (paddleW / 2), -1, 1);
    var ar = rel < 0 ? -rel : rel;
    var ang = (ar < 0.0001 ? 0 : (rel < 0 ? -1 : 1) * Math.pow(ar, 0.86) * MAX_BOUNCE_ANGLE);
    var sp = targetSpeed();

    setDir(b, ang, sp);
    if (paddleVX !== 0) {
      b.vx += paddleVX * PADDLE_FRICTION;
      normalizeTo(b, sp);
    }
    enforceMin(b);
    b.y = PADDLE_Y - b.r - 0.6;
    b.squash = 1;
    paddleSquash = 1;

    rallyBonus += RALLY_STEP;
    if (rallyBonus > RALLY_MAX) rallyBonus = RALLY_MAX;

    if (catchT > 0) {
      b.held = true;
      b.holdT = CATCH_HOLD;
      b.holdX = clamp(b.x - paddleX, 10, paddleW - 10);
      b.vx = 0; b.vy = 0;
      b.tN = 0;
    }
    SFX.paddle(rel);
    spawnSparks(b.x, PADDLE_Y, COLOR_PADDLE_TOP, 3, 0.7);
    return true;
  }

  function releaseHeld() {
    var any = false;
    for (var k = 0; k < ballN; k++) {
      var b = balls[k];
      if (b.alive && b.held) {
        var sp = targetSpeed();
        setDir(b, aim, sp);
        enforceMin(b);
        b.held = false;
        b.holdT = 0;
        any = true;
      }
    }
    if (any) SFX.serve();
    return any;
  }

  function serve() {
    if (served || over || paused) return false;
    var sp = targetSpeed();
    setDir(ball0, aim, sp);
    served = true;
    ball0.tN = 0;
    pushTrail(ball0);
    SFX.serve();
    syncDom(true);
    return true;
  }

  function splitBalls() {
    var snapshotN = ballN;
    for (var k = 0; k < snapshotN; k++) {
      var b = balls[k];
      if (!b.alive) continue;
      var sp = ballSpeed(b) || targetSpeed();
      var base = Math.atan2(b.vx, -b.vy);
      for (var d = -1; d <= 1; d += 2) {
        var ang = clamp(base + d * 0.55, -1.35, 1.35);
        var nb = spawnBall(b.x, b.y, 0, 0, (b.ci + (d > 0 ? 1 : 2)) % BALL_COLOR.length);
        if (!nb) return;
        setDir(nb, ang, sp);
        enforceMin(nb);
      }
    }
  }

  /* ───────────────── 13. 胶囊 ───────────────── */

  function rollCapsule() {
    ds = ((score * 2654435761) ^ G_SEED) | 0;    /* 原版：用当前分数播撒随机器 */
    var t = rndD() * 100, acc = 0, k = C_EXPAND;
    for (var q = 0; q < CAP_N; q++) {
      acc += CAP_WEIGHT[q];
      if (t < acc) { k = q; break; }
    }
    if (k === lastCapsule) k = C_DISRUPT;        /* 原版：连续同款 → 替换为三分球 */
    if (k === C_LIFE) {
      if (lifeGiven) k = C_DISRUPT;
      else lifeGiven = true;
    }
    lastCapsule = k;
    return k;
  }

  function spawnCapsule(x, y, kind) {
    if (capN >= MAX_CAPS) return false;
    for (var k = 0; k < MAX_CAPS; k++) {
      if (caps[k].alive) continue;
      var cp = caps[k];
      cp.alive = true; cp.kind = kind;
      cp.x = clamp(x, 14, W - 14);
      cp.y = y; cp.spin = 0;
      capN++;
      return true;
    }
    return false;
  }

  function maybeDrop(x, y, forced) {
    if (!forced) {
      dropCounter++;
      if (dropCounter < dropNeed) return false;
    }
    if (capN > 0) return false;                  /* 经典规则：场上只允许一颗 */
    if (!spawnCapsule(x, y, rollCapsule())) return false;
    dropCounter = 0;
    dropNeed = DROP_MIN + ((rndG() * DROP_SPAN) | 0);
    return true;
  }

  function applyCapsule(kind) {
    capsCollected++;
    addScore(CAP_SCORE);
    floatScore(CAP_SCORE);
    spawnRing(clamp(paddleX + paddleW / 2, 20, W - 20), PADDLE_Y - 10, 46, 0.4, CAP_COLOR[kind], 3);
    SFX.pick(CAP_BAD[kind] === 1);
    var bad = CAP_BAD[kind] === 1;
    switch (kind) {
      case C_EXPAND: expandT = CAP_DUR[kind]; reduceT = 0; break;
      case C_REDUCE: reduceT = CAP_DUR[kind]; expandT = 0; break;
      case C_DISRUPT: splitBalls(); break;
      case C_LASER: laserT = CAP_DUR[kind]; break;
      case C_CATCH: catchT = CAP_DUR[kind]; break;
      case C_SLOW: slowT = CAP_DUR[kind]; fastT = 0; break;
      case C_FAST: fastT = CAP_DUR[kind]; slowT = 0; break;
      case C_PIERCE: pierceT = CAP_DUR[kind]; break;
      case C_SHIELD: shieldT = CAP_DUR[kind]; shieldCharges = SHIELD_CHARGES; break;
      case C_LIFE:
        if (lives < MAX_LIVES) { lives++; } else { addScore(1000); }
        break;
      default: break;
    }
    if (kind === C_EXPAND || kind === C_REDUCE) recomputePaddleTarget();
    if (kind === C_SLOW || kind === C_FAST) {
      var sp = targetSpeed();
      for (var k = 0; k < ballN; k++) if (balls[k].alive && !balls[k].held) normalizeTo(balls[k], sp);
    }
    showToast('胶囊 · ' + CAP_NAME[kind] + (bad ? '（负面）' : ''), '拾取 +' + CAP_SCORE + ' 分', false);
    syncDom(true);
    return kind;
  }

  /* 同类道具互相顶替：缩拍优先于扩拍（负面优先） */
  function recomputePaddleTarget() {
    if (reduceT > 0) paddleTarget = PAD_SHORT;
    else if (expandT > 0) paddleTarget = PAD_WIDE;
    else paddleTarget = PAD_NORMAL;
  }

  function clearPowers(keepShield) {
    expandT = 0; reduceT = 0; laserT = 0; catchT = 0; slowT = 0; fastT = 0; pierceT = 0;
    if (!keepShield) { shieldT = 0; shieldCharges = 0; }
    recomputePaddleTarget();
    for (var k = 0; k < ballN; k++) if (balls[k].alive) { balls[k].held = false; balls[k].holdT = 0; }
  }

  function updateCapsules(dt) {
    for (var k = 0; k < MAX_CAPS; k++) {
      var cp = caps[k];
      if (!cp.alive) continue;
      cp.y += CAP_FALL * dt;
      cp.spin += dt * 6;
      /* 拾取判定：拍面矩形 */
      if (cp.y + 7 >= PADDLE_Y && cp.y - 7 <= PADDLE_Y + PADDLE_H &&
        cp.x + 12 >= paddleX && cp.x - 12 <= paddleX + paddleW) {
        cp.alive = false;
        capN--;
        applyCapsule(cp.kind);
        continue;
      }
      if (cp.y - 10 > H) { cp.alive = false; capN--; }
    }
  }

  /* ───────────────── 14. 激光 ───────────────── */

  function fireLaser() {
    var y = PADDLE_Y - 4;
    var xs = [paddleX + 4, paddleX + paddleW - 4];
    for (var s = 0; s < 2; s++) {
      for (var k = 0; k < MAX_LASERS; k++) {
        if (lasers[k].alive) continue;
        lasers[k].alive = true; lasers[k].x = xs[s]; lasers[k].y = y; lasers[k].vy = -LASER_SPEED;
        if (k + 1 > laserN) laserN = k + 1;
        break;
      }
    }
    SFX.laser();
    spawnSparks(xs[0], y, CAP_COLOR[C_LASER], 2, 0.6);
  }

  function damageLaserAt(x, y, r) {
    for (var k = 0; k < brickN; k++) {
      var b = bricks[k];
      if (!b.alive) continue;
      var hw = b.w / 2, hh = b.h / 2;
      var cx = b.x + hw, cy = b.y + hh;
      if (x < cx - hw - r || x > cx + hw + r || y < cy - hh - r || y > cy + hh + r) continue;
      return k;
    }
    return -1;
  }

  function updateLasers(dt) {
    for (var k = 0; k < laserN; k++) {
      var L = lasers[k];
      if (!L.alive) continue;
      L.y += L.vy * dt;
      if (L.y < 8) { L.alive = false; continue; }
      var bi = damageLaserAt(L.x, L.y, 3);
      if (bi >= 0) {
        L.alive = false;
        var b = bricks[bi];
        if (b.type === T_SOLID) { SFX.solid(); spawnSparks(L.x, L.y, '#cfd4da', 4, 0.8); }
        else { damageBrick(b, L.x, L.y); }
      }
    }
  }

  /* ───────────────── 15. 砖块行为 ───────────────── */

  function updateBricks(dt) {
    invisPulse -= dt;
    if (invisPulse <= 0) {
      invisPulse = INVIS_PULSE;
      for (var q = 0; q < brickN; q++) {
        var ib = bricks[q];
        if (ib.alive && ib.type === T_INVIS) ib.reveal = INVIS_REVEAL;
      }
    }
    for (var k = 0; k < brickN; k++) {
      var b = bricks[k];
      if (!b.alive) {
        if (b.respawn > 0) {
          b.respawn -= dt;
          if (b.respawn <= 0) {
            b.alive = true; b.hp = b.hpMax; b.born = 1; b.reveal = 0;
            bricksRemaining++;
            spawnRing(b.x + b.w / 2, b.y + b.h / 2, 20, 0.35, '#7fc8a9', 2);
          }
        }
        continue;
      }
      if (b.hitFlash > 0) b.hitFlash -= dt * 5;
      if (b.lock > 0) b.lock -= dt;
      if (b.reveal > 0) b.reveal -= dt;
      if (b.born > 0) b.born -= dt * 2.4;
      if (b.amp !== 0) {
        var mv = (b.type === T_DOH && b.hp * 2 < b.hpMax) ? MOV_SPEED * 1.7 : MOV_SPEED;
        b.x = clamp(b.baseX + Math.sin(levelTime * mv + b.phase) * b.amp, 4, W - 4 - b.w);
      }
    }
    if (dohIdx >= 0 && bricks[dohIdx].alive) {
      dohDropT -= dt;
      if (dohDropT <= 0) { dohDropT = 6; maybeDrop(bricks[dohIdx].x + bricks[dohIdx].w / 2, bricks[dohIdx].y + bricks[dohIdx].h, true); }
    }
  }

  function revealNeighbors(cx, cy) {
    var rr = (CHAIN_RADIUS + 0.6) * (BW + GX);
    for (var k = 0; k < brickN; k++) {
      var b = bricks[k];
      if (!b.alive || b.type !== T_INVIS) continue;
      var dx = (b.x + b.w / 2) - cx, dy = (b.y + b.h / 2) - cy;
      if (dx * dx + dy * dy <= rr * rr) b.reveal = INVIS_HIT_REVEAL;
    }
  }

  /* ───────────────── 16. 计分 / 连击 / 损伤 ───────────────── */

  function addScore(v) {
    score += v;
    if (score > best) { best = score; saveBest(best); }
  }

  function addCombo() {
    comboCount++;
    comboT = COMBO_WINDOW;
    if (comboCount > bestCombo) bestCombo = comboCount;
    comboMult2 = comboMult();
  }

  function killBrick(b, chainHit) {
    b.alive = false;
    b.reveal = 0;
    bricksRemaining--;
    bricksDestroyed++;
    addCombo();
    var mult = comboMult2;
    var gain = BRICK_SCORE[b.type] * mult;
    addScore(gain);
    floatScore(gain);
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var col = b.type === T_NORMAL ? palette[b.row % palette.length] : BRICK_COLORS[b.type];
    if (b.type === T_GOLD) {
      spawnChips(cx, cy, b.w, b.h, BRICK_COLORS[T_GOLD], 12, 1.4);
      spawnRing(cx, cy, 40, 0.4, BRICK_COLORS[T_GOLD], 3);
      maybeDrop(cx, cy, true);
      SFX.pick(false);
    } else {
      spawnChips(cx, cy, b.w, b.h, col, chainHit ? 4 : 7, 1);
      SFX.brick(b.row);
      if (!chainHit) maybeDrop(cx, cy, false);
    }
    revealNeighbors(cx, cy);
    if (!chainHit) {
      hitStop = Math.max(hitStop, HITSTOP_BRICK);
      addShake(SHAKE_BRICK);
    }
    if (b.type === T_REGEN && bricksRemaining > 2) b.respawn = REGEN_DELAY;
    if (b.type === T_DOH) { winRun(); return true; }
    if (bricksRemaining <= 0) { clearLevel(); return true; }
    return false;
  }

  /* 炸弹：以格距为半径连环引燃；递归深度与总量都有上限（不会一帧炸穿全屏） */
  var chainUsed = 0;

  function detonate(bomb) {
    var cx = bomb.x + bomb.w / 2, cy = bomb.y + bomb.h / 2;
    spawnRing(cx, cy, 96, 0.42, '#ff8a3d', 4);
    spawnChips(cx, cy, bomb.w, bomb.h, '#ff8a3d', 14, 1.6);
    spawnSparks(cx, cy, '#ffd470', 14, 1.5);
    SFX.boom();
    hitStop = Math.max(hitStop, HITSTOP_BOMB);
    addShake(SHAKE_BOMB);
    bomb.alive = false;
    bricksRemaining--;
    bricksDestroyed++;
    addCombo();
    addScore(BRICK_SCORE[T_BOMB] * comboMult2);

    chainUsed = 0;
    chainBlast(cx, cy, 0);
    if (over || !served) return true;
    if (bricksRemaining <= 0) { clearLevel(); return true; }
    return true;
  }

  function chainBlast(x, y, depth) {
    var rr = CHAIN_RADIUS * (BW + GX);
    var rr2 = rr * rr;
    for (var k = 0; k < brickN && chainUsed < CHAIN_LIMIT; k++) {
      var b = bricks[k];
      if (!b.alive || b.type === T_SOLID) continue;
      var bx = b.x + b.w / 2, by = b.y + b.h / 2;
      var dx = bx - x, dy = by - y;
      if (dx * dx + dy * dy > rr2) continue;
      var wasBomb = b.type === T_BOMB;
      var t = b.type;
      chainUsed++;
      addCombo();
      addScore(BRICK_SCORE[t] * comboMult2);
      spawnChips(bx, by, b.w, b.h, wasBomb ? '#ff8a3d' : BRICK_COLORS[t], wasBomb ? 8 : 4, 1.3);
      if (wasBomb) spawnRing(bx, by, 70, 0.36, '#ff8a3d', 3);
      b.alive = false;
      bricksRemaining--;
      bricksDestroyed++;
      if (t === T_REGEN && bricksRemaining > 2) b.respawn = REGEN_DELAY;
      if (t === T_DOH) { winRun(); return; }
      if (wasBomb && depth < 3) {
        chainBlast(bx, by, depth + 1);
        if (over) return;
      }
    }
    if (chainUsed >= CHAIN_LIMIT) addShake(SHAKE_BOMB);
  }

  function damageBrick(b, hx, hy) {
    if (b.type === T_SOLID) {
      b.hitFlash = 1;
      spawnSparks(hx, hy, '#cfd4da', 4, 1);
      SFX.solid();
      hitStop = Math.max(hitStop, HITSTOP_BRICK * 0.7);
      addShake(SHAKE_SOLID);
      return false;
    }
    b.hitFlash = 1;
    if (b.type === T_BOMB) { detonate(b); return true; }
    b.hp--;
    if (b.hp > 0) {
      addScore(6 * comboMult2);
      spawnSparks(hx, hy, BRICK_COLORS[b.type], 5, 1);
      SFX.tough();
      hitStop = Math.max(hitStop, HITSTOP_BRICK * 0.6);
      return false;
    }
    if (b.type === T_INVIS) b.reveal = INVIS_HIT_REVEAL;
    killBrick(b, false);
    return true;
  }

  /* ───────────────── 17. 球物理 ───────────────── */

  function circleHitsRect(x, y, rx, ry, rw, rh) {
    var cx = clamp(x, rx, rx + rw);
    var cy = clamp(y, ry, ry + rh);
    var dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= BALL_R * BALL_R;
  }

  function reflectOffRect(b, rx, ry, rw, rh) {
    var cx = b.x < rx ? rx : (b.x > rx + rw ? rx + rw : b.x);
    var cy = b.y < ry ? ry : (b.y > ry + rh ? ry + rh : b.y);
    var dx = b.x - cx, dy = b.y - cy;
    var ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
    if (ax > ay) {
      b.vx = dx < 0 ? -Math.abs(b.vx) : Math.abs(b.vx);
      b.x = dx < 0 ? rx - b.r - 0.1 : rx + rw + b.r + 0.1;
    } else if (ay > ax) {
      b.vy = dy < 0 ? -Math.abs(b.vy) : Math.abs(b.vy);
      b.y = dy < 0 ? ry - b.r - 0.1 : ry + rh + b.r + 0.1;
    } else {
      b.vx = -b.vx; b.vy = -b.vy;
    }
  }

  /* 单次子步：撞砖 → 撞拍 → 撞墙 → 掉出 */
  function bounceBricks(b) {
    for (var k = 0; k < brickN; k++) {
      var br = bricks[k];
      if (!br.alive) continue;
      if (b.x + BALL_R < br.x || b.x - BALL_R > br.x + br.w) continue;
      if (b.y + BALL_R < br.y || b.y - BALL_R > br.y + br.h) continue;
      if (!circleHitsRect(b.x, b.y, br.x, br.y, br.w, br.h)) continue;

      var pierce = pierceT > 0 && br.type !== T_SOLID;
      /* 穿透球不能对同一块砖反复结算：每块砖被打中后锁 0.35s。
         否则 158px 宽的 BOSS 一次穿越就被穿掉 30 血（实测 1.9 秒击杀）。 */
      if (pierce && br.lock > 0) continue;
      if (br.type === T_SOLID) {
        reflectOffRect(b, br.x, br.y, br.w, br.h);
        damageBrick(br, b.x, b.y);
        b.squash = 1;
      } else if (pierce) {
        br.lock = PIERCE_LOCK;
        damageBrick(br, b.x, b.y);
        b.squash = 0.6;
      } else {
        reflectOffRect(b, br.x, br.y, br.w, br.h);
        damageBrick(br, b.x, b.y);
        b.squash = 1;
      }
      enforceMin(b);
      return false;
    }
    return false;
  }

  /* 返回值：0 正常 · 1 掉球 · 2 关卡已切换（球已被重新安置，调用方不要杀球） */
  function moveBall(b, dt) {
    var dx = b.vx * dt, dy = b.vy * dt;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.ceil(dist / STEP_MAX);
    if (steps < 1) steps = 1;
    if (steps > 32) steps = 32;
    var sx = dx / steps, sy = dy / steps;
    var epoch = levelEpoch;

    for (var s = 0; s < steps; s++) {
      b.x += sx;
      b.y += sy;

      if (b.x - b.r < 2) { b.x = 2 + b.r; b.vx = Math.abs(b.vx); SFX.wall(); }
      else if (b.x + b.r > W - 2) { b.x = W - 2 - b.r; b.vx = -Math.abs(b.vx); SFX.wall(); }
      if (b.y - b.r < 2) { b.y = 2 + b.r; b.vy = Math.abs(b.vy); SFX.wall(); }

      if (bounceBricks(b)) return 2;
      /* 关卡已切换（清关/进下一关）：砖块池已被重建，立刻停止推进这颗球 */
      if (levelEpoch !== epoch) return 2;

      if (b.vy > 0 && circleHitsRect(b.x, b.y, paddleX, PADDLE_Y, paddleW, PADDLE_H)) {
        hitPaddle(b);
        if (b.held) return 0;
      }

      enforceMin(b);
      if (b.y - b.r > H + 6) return 1;

      /* 护盾：底部护栏，按次数抵挡 */
      if (shieldT > 0 && shieldCharges > 0 && b.vy > 0 && b.y + b.r >= SHIELD_Y) {
        b.y = SHIELD_Y - b.r - 1;
        b.vy = -Math.abs(b.vy);
        shieldCharges--;
        addShake(2.4);
        spawnChips(b.x, SHIELD_Y, 18, 4, CAP_COLOR[C_SHIELD], 8, 1.1);
        SFX.shield();
        if (shieldCharges <= 0) shieldT = 0;
      }
    }
    return 0;
  }

  /* ───────────────── 18. 进程 / 关卡流转 ───────────────── */

  function resetBall() {
    served = false;
    clearBalls();
    ball0.alive = true;
    ball0.ci = 0;
    ball0.r = BALL_R;
    ball0.held = false;
    ball0.squash = 0;
    ball0.stuckT = 0;
    ballN = 1;
    parkBall(ball0);
    rallyBonus = 0;
  }

  function loseLife() {
    lives--;
    clearPowers(false);
    clearField();
    shakeMag = SHAKE_LIFE;
    shakeT = 1;
    hitStop = Math.max(hitStop, HITSTOP_LIFE);
    edgeFlash();
    SFX.life();
    spawnRing(ball0.x, H - 20, 120, 0.5, COLOR_PADDLE, 4);
    if (lives <= 0) {
      lives = 0;
      gameOver();
    } else {
      resetBall();
    }
    syncDom(true);
  }

  /* 场上的胶囊与激光归零（换关/掉命/重开时调用，避免旧场掉落物飘进新场） */
  function clearField() {
    for (var k = 0; k < MAX_CAPS; k++) caps[k].alive = false;
    for (var l = 0; l < MAX_LASERS; l++) lasers[l].alive = false;
    capN = 0;
    laserN = 0;
    dropCounter = 0;
    laserGap = 0;
  }

  function clearLevel() {
    var bonus = 50 + level * 20;
    addScore(bonus);
    floatScore(bonus);
    spawnRing(W / 2, H / 2, 200, 0.6, C4, 5);
    SFX.clear();
    clearField();
    if (level >= MAX_LEVEL && !endless) {
      won = true;
      over = true;
      hitStop = Math.max(hitStop, HITSTOP_WIN);
      syncDom(true);
      return;
    }
    level++;
    buildLevel(level);
    resetBall();
    showToast('第 ' + level + ' 关 · ' + curName, curTip || '', false);
    syncDom(true);
  }

  function winRun() {
    addScore(3000);
    floatScore(3000);
    won = true;
    over = true;
    clearField();
    endBonus = lives > 0 ? lives * 400 : 0;
    endBonusLabel = '剩余生命奖励';
    addScore(endBonus);
    hitStop = Math.max(hitStop, HITSTOP_WIN);
    addShake(8);
    SFX.clear();
    SFX.over();
    for (var q = 0; q < 5; q++) spawnRing(W / 2, H / 2 - 40 + q * 20, 120 + q * 60, 0.5 + q * 0.12, q % 2 ? C1 : C2, 4);
    syncDom(true);
  }

  function gameOver() {
    over = true;
    /* 命都掉光了就没有"剩余生命"；改成按已通过关卡给进度奖励 */
    endBonus = (level - 1) * 120;
    endBonusLabel = '进度奖励';
    if (endBonus > 0) addScore(endBonus);
    addShake(6);
    SFX.over();
    syncDom(true);
  }

  function restart() {
    score = 0; lives = START_LIVES; level = 1;
    over = false; won = false; paused = false; served = false;
    endless = false;
    continueUsed = false; lifeGiven = false; endBonus = 0; endBonusLabel = '剩余生命奖励';
    bricksDestroyed = 0; capsCollected = 0; comboCount = 0; comboT = 0; bestCombo = 0; comboMult2 = 1;
    kindsSeen = 0;
    paddleX = (W - PAD_NORMAL) / 2; paddleW = PAD_NORMAL; paddleTarget = PAD_NORMAL; paddleSquash = 0;
    held.left = false; held.right = false; held.aimL = false; held.aimR = false;
    dragging = false; aim = 0;
    hitStop = 0; shakeMag = 0; shakeT = 0;
    dropCounter = 0; dropNeed = 6; lastCapsule = -1;
    clearPowers(false);
    clearField();
    for (i = 0; i < MAX_PART; i++) parts[i].alive = false;
    for (i = 0; i < MAX_RING; i++) rings[i].alive = false;
    levelTime = 0; invisPulse = INVIS_PULSE; dohDropT = 6;
    gs = G_SEED; fs = 0x9E3779B9; ds = 0x2545F491;
    buildLevel(level);
    resetBall();
    hideToast();
    syncDom(true);
    showToast('第 1 关 · ' + curName, curTip || '空格或点按发球', false);
    render();
  }

  function continueRun() {
    if (!over || won || continueUsed) return false;
    score = Math.floor(score / 2);
    lives = START_LIVES;
    over = false; won = false; paused = false;
    continueUsed = true;
    clearPowers(false);
    clearField();
    buildLevel(level);
    resetBall();
    syncDom(true);
    showToast('续关 · 分数减半', '第 ' + level + ' 关 · ' + curName, false);
    return true;
  }

  function startEndless() {
    endless = true;
    over = false; won = false; paused = false;
    level = MAX_LEVEL + 1;
    clearPowers(false);
    clearField();
    buildLevel(level);
    resetBall();
    syncDom(true);
    showToast('无尽模式', '第 11 关起布局随机 · 越深越硬', false);
    return true;
  }

  /* ───────────────── 19. 反馈：屏震 / 粒子 ───────────────── */

  function addShake(m) { shakeMag = shakeMag > m ? shakeMag : m; shakeT = 1; }

  function updateFx(dt) {
    for (var k = 0; k < MAX_PART; k++) {
      var p = parts[k];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      if (p.kind === 0) p.vy += FRAG_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 0) p.vx *= (1 - 1.6 * dt);
      p.rot += p.spin * dt;
    }
    for (var g = 0; g < MAX_RING; g++) {
      var r = rings[g];
      if (!r.alive) continue;
      r.life -= dt;
      if (r.life <= 0) { r.alive = false; continue; }
      r.r = r.r1 * (1 - r.life / r.life0);
    }
    if (shakeT > 0) {
      shakeT -= dt * 3.4;
      if (shakeT <= 0) { shakeT = 0; shakeMag = 0; }
      else shakeMag *= (1 - 2.6 * dt);
    }
    if (paddleSquash > 0) paddleSquash -= dt * 4.2; else paddleSquash = 0;
    for (var b = 0; b < ballN; b++) if (balls[b].squash > 0) { balls[b].squash -= dt * 5; if (balls[b].squash < 0) balls[b].squash = 0; }
  }

  /* ───────────────── 20. 主循环 ───────────────── */

  function updateTimers(dt) {
    if (expandT > 0) expandT -= dt;
    if (reduceT > 0) reduceT -= dt;
    if (laserT > 0) laserT -= dt;
    if (catchT > 0) catchT -= dt;
    if (slowT > 0) slowT -= dt;
    if (fastT > 0) fastT -= dt;
    if (pierceT > 0) pierceT -= dt;
    if (shieldT > 0) { shieldT -= dt; if (shieldT <= 0) shieldCharges = 0; }
    if (expandT < 0) expandT = 0;
    if (reduceT < 0) reduceT = 0;
    if (laserT < 0) laserT = 0;
    if (catchT < 0) catchT = 0;
    if (slowT < 0) slowT = 0;
    if (fastT < 0) fastT = 0;
    if (pierceT < 0) pierceT = 0;
    if (comboT > 0) { comboT -= dt; if (comboT <= 0) { comboT = 0; comboCount = 0; comboMult2 = 1; } }
    var t = reduceT > 0 ? PAD_SHORT : (expandT > 0 ? PAD_WIDE : PAD_NORMAL);
    if (t !== paddleTarget) paddleTarget = t;
  }

  function update(dt) {
    if (paused) return;
    if (over) { updateFx(dt); return; }
    if (hitStop > 0) { hitStop -= dt; if (hitStop < 0) hitStop = 0; updateFx(dt); return; }

    levelTime += dt;
    updateFx(dt);
    updateTimers(dt);
    updateBricks(dt);

    var prevX = paddleX;
    var dir = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    if (dir !== 0) paddleX += dir * PADDLE_SPEED * dt;
    if (held.aimL) aim = clamp(aim - AIM_STEP * 4 * dt, -AIM_MAX, AIM_MAX);
    if (held.aimR) aim = clamp(aim + AIM_STEP * 4 * dt, -AIM_MAX, AIM_MAX);
    if (paddleW !== paddleTarget) {
      paddleW += (paddleTarget - paddleW) * Math.min(1, PADDLE_EASE * dt);
      if (Math.abs(paddleTarget - paddleW) < 0.4) paddleW = paddleTarget;
    }
    paddleX = clamp(paddleX, 2, W - 2 - paddleW);
    paddleVX = dt > 0 ? (paddleX - prevX) / dt : 0;
    if (paddleVX > 2600) paddleVX = 2600;
    if (paddleVX < -2600) paddleVX = -2600;

    if (laserT > 0) {
      laserGap -= dt;
      if (laserGap <= 0) { laserGap = LASER_GAP; fireLaser(); }
    } else laserGap = 0;

    if (!served) {
      parkBall(ball0);
      return;
    }

    updateCapsules(dt);
    updateLasers(dt);

    for (var k = 0; k < ballN; k++) {
      var b = balls[k];
      if (!b.alive) continue;
      if (b.held) {
        b.x = paddleX + b.holdX;
        b.y = PADDLE_Y - b.r - 1;
        b.holdT -= dt;
        if (b.holdT <= 0) releaseHeld();
        pushTrail(b);
        continue;
      }
      /* 竖直分量长期过小 → 看门狗踢一脚，防止在横向通道里无限平飞 */
      var m = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (m > 0.001 && Math.abs(b.vy) < m * 0.25) {
        b.stuckT += dt;
        if (b.stuckT > STUCK_LIMIT) {
          b.stuckT = 0;
          b.vy = (b.vy >= 0 ? 1 : -1) * m * 0.4;
          enforceMin(b);
        }
      } else b.stuckT = 0;

      var res = moveBall(b, dt);
      if (res === 2) { if (over) return; continue; }
      if (res === 1) { killBall(b); continue; }
      pushTrail(b);
    }

    if (served && aliveBalls() === 0 && !over) loseLife();
  }

  /* ───────────────── 21. 渲染 ───────────────── */

  var HAS_ELLIPSE = typeof ctx.ellipse === 'function';

  function fillRound(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
    else ctx.fillRect(x, y, w, h);
  }

  function strokeRound(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.stroke();
  }

  function drawBrick(b) {
    var col = b.type === T_NORMAL ? palette[b.row % palette.length] : BRICK_COLORS[b.type];
    var alpha = 1;
    if (b.type === T_INVIS) alpha = b.reveal > 0 ? 1 : 0.1;
    if (b.born > 0) alpha *= 1 - b.born * 0.6;
    var w = b.w, h = b.h;
    if (b.born > 0) { w = b.w * (1 + b.born * 0.18); }

    ctx.globalAlpha = alpha < 0 ? 0 : alpha;
    ctx.fillStyle = col;
    fillRound(b.x, b.y, w, h, 4);

    /* 顶部高光 */
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    fillRound(b.x + 3, b.y + 2.2, w - 6, 2.4, 1.2);

    if (b.type === T_SOLID) {
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 1.5;
      for (var s = 0; s < 3; s++) {
        ctx.beginPath();
        ctx.moveTo(b.x + 4 + s * 9, b.y + h - 3);
        ctx.lineTo(b.x + 9 + s * 9, b.y + 3);
        ctx.stroke();
      }
    } else if (b.type === T_BOMB) {
      ctx.fillStyle = '#ff8a3d';
      var pl = 0.55 + 0.45 * Math.sin(levelTime * 9 + b.col);
      ctx.globalAlpha = alpha * pl;
      ctx.beginPath();
      ctx.arc(b.x + w / 2, b.y + h / 2, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
    } else if (b.type === T_MOVER) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      var mx = b.x + w / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 8, b.y + h / 2);
      ctx.lineTo(mx - 4, b.y + h / 2 - 4);
      ctx.lineTo(mx - 4, b.y + h / 2 + 4);
      ctx.closePath();
      ctx.moveTo(mx + 8, b.y + h / 2);
      ctx.lineTo(mx + 4, b.y + h / 2 - 4);
      ctx.lineTo(mx + 4, b.y + h / 2 + 4);
      ctx.closePath();
      ctx.fill();
    } else if (b.type === T_GOLD) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      var gx = 8 + 6 * Math.sin(levelTime * 2.6 + b.col);
      fillRound(b.x + gx, b.y + 4, 3, 3, 1.5);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      strokeRound(b.x + 1.2, b.y + 1.2, w - 2.4, h - 2.4, 3);
    } else if (b.type === T_DOH) {
      drawDohFace(b, alpha);
    } else if (b.hpMax > 1) {
      /* 血量点：还剩几点血就画几格 */
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      var pw = (w - 10) / b.hpMax;
      for (var q = 0; q < b.hp; q++) fillRound(b.x + 5 + q * pw, b.y + h - 4.4, pw - 2, 2.2, 1);
    }

    if (b.reveal > 0 && b.type === T_INVIS) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      strokeRound(b.x + 0.8, b.y + 0.8, w - 1.6, h - 1.6, 4);
    }
    if (b.hitFlash > 0) {
      ctx.globalAlpha = alpha * b.hitFlash * 0.85;
      ctx.fillStyle = '#fff';
      fillRound(b.x, b.y, w, h, 4);
      ctx.globalAlpha = alpha;
    }
    ctx.globalAlpha = 1;
  }

  function drawDohFace(b, alpha) {
    ctx.fillStyle = '#3a2547';
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var frac = b.hp / b.hpMax;
    var ew = 26, eh = 9 + (1 - frac) * 5;
    ctx.beginPath();
    if (HAS_ELLIPSE) {
      ctx.ellipse(cx - 36, cy - 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 36, cy - 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(cx - 36, cy - 2, ew / 2, 0, Math.PI * 2);
      ctx.arc(cx + 36, cy - 2, ew / 2, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = frac > 0.5 ? '#ffd470' : '#ef476f';
    var px = clamp((paddleCenter() - cx) / 60, -1, 1) * 5;
    ctx.beginPath();
    ctx.arc(cx - 36 + px, cy - 2, 3.4, 0, Math.PI * 2);
    ctx.arc(cx + 36 + px, cy - 2, 3.4, 0, Math.PI * 2);
    ctx.fill();
    /* 嘴：血量越低越下弯 */
    ctx.strokeStyle = '#3a2547';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy + 2, 22, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();
  }

  function drawDohBar() {
    var b = bricks[dohIdx];
    var x = GRID_LEFT, y = 26, w = W - GRID_LEFT * 2, h = 9;
    ctx.fillStyle = 'rgba(85,85,85,0.18)';
    fillRound(x, y, w, h, 4);
    var frac = b.hp / b.hpMax;
    ctx.fillStyle = frac > 0.5 ? '#ef476f' : '#ffc43d';
    fillRound(x + 1, y + 1, (w - 2) * frac, h - 2, 3);
    ctx.strokeStyle = 'rgba(85,85,85,0.55)';
    ctx.lineWidth = 1;
    strokeRound(x, y, w, h, 4);
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    if (shakeMag > 0.05) {
      var sx = Math.sin(shakeT * 61) * shakeMag;
      var sy = Math.cos(shakeT * 47) * shakeMag * 0.8;
      ctx.translate(sx, sy);
    }

    /* 场地 */
    ctx.fillStyle = courtGrad;
    ctx.fillRect(-8, -8, W + 16, H + 16);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = COLOR_LINE;
    ctx.lineWidth = 2;
    strokeRound(1, 1, W - 2, H - 2, 6);
    ctx.globalAlpha = 1;

    if (dohIdx >= 0 && bricks[dohIdx].alive) drawDohBar();

    /* 砖块 */
    for (var k = 0; k < brickN; k++) if (bricks[k].alive) drawBrick(bricks[k]);

    /* 护盾 */
    if (shieldT > 0 && shieldCharges > 0) {
      var pulse = 0.55 + 0.45 * Math.sin(levelTime * 7);
      ctx.globalAlpha = 0.35 + 0.35 * pulse;
      ctx.fillStyle = CAP_COLOR[C_SHIELD];
      var seg = (W - 24) / SHIELD_CHARGES;
      for (var s = 0; s < shieldCharges; s++) fillRound(12 + s * seg, SHIELD_Y, seg - 4, 5, 2.5);
      ctx.globalAlpha = 1;
    }

    /* 胶囊 */
    for (var c = 0; c < MAX_CAPS; c++) {
      var cp = caps[c];
      if (!cp.alive) continue;
      ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(cp.spin));
      ctx.drawImage(capSprites[cp.kind], cp.x - CAP_SPR_W / 2, cp.y - CAP_SPR_H / 2, CAP_SPR_W, CAP_SPR_H);
      ctx.globalAlpha = 1;
    }

    /* 激光 */
    ctx.fillStyle = CAP_COLOR[C_LASER];
    for (var l = 0; l < laserN; l++) {
      var L = lasers[l];
      if (!L.alive) continue;
      fillRound(L.x - 1.4, L.y - 9, 2.8, 14, 1.4);
    }

    /* 粒子：碎块 */
    for (var p = 0; p < MAX_PART; p++) {
      var pt = parts[p];
      if (!pt.alive || pt.kind !== 0) continue;
      ctx.globalAlpha = Math.max(0, pt.life / pt.life0);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.rot);
      ctx.fillStyle = pt.color;
      fillRound(-pt.size / 2, -pt.size * 0.7, pt.size, pt.size * 1.4, 1.2);
      ctx.restore();
    }
    /* 粒子：火花 */
    for (var s2 = 0; s2 < MAX_PART; s2++) {
      var sp2 = parts[s2];
      if (!sp2.alive || sp2.kind !== 1) continue;
      ctx.globalAlpha = Math.max(0, sp2.life / sp2.life0) * 0.9;
      ctx.fillStyle = sp2.color;
      ctx.beginPath();
      ctx.arc(sp2.x, sp2.y, sp2.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 环 */
    for (var g = 0; g < MAX_RING; g++) {
      var rg = rings[g];
      if (!rg.alive) continue;
      ctx.globalAlpha = Math.max(0, rg.life / rg.life0) * 0.8;
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = rg.w;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* 球 + 拖尾 */
    for (var bk = 0; bk < ballN; bk++) {
      var b = balls[bk];
      if (!b.alive) continue;
      var bcol = BALL_COLOR[b.ci];
      for (var t = 0; t < b.tN; t++) {
        var idx = (b.tHead - b.tN + t + TRAIL_N) % TRAIL_N;
        var ratio = (t + 1) / b.tN;
        ctx.globalAlpha = 0.05 + 0.28 * ratio * ratio;
        ctx.fillStyle = bcol;
        ctx.beginPath();
        ctx.arc(b.tx[idx], b.ty[idx], b.r * (0.28 + 0.5 * ratio), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      var sq = b.squash > 0 ? 1 - b.squash * 0.3 : 1;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(1 + (1 - sq) * 0.6, sq);
      ctx.beginPath();
      ctx.arc(0, 0, b.r, 0, Math.PI * 2);
      ctx.fillStyle = bcol;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-b.r * 0.32, -b.r * 0.34, b.r * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fill();
      ctx.restore();
      if (ballN > 1) { ctx.globalAlpha = 1; }
    }

    /* 瞄准虚线 */
    if (!served || anyHeld()) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = COLOR_PADDLE;
      for (var d = 1; d <= 5; d++) {
        var dd = d * 22;
        ctx.beginPath();
        ctx.arc(ball0.x + Math.sin(aim) * dd, ball0.y - Math.cos(aim) * dd, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* 球拍 */
    var ph = PADDLE_H * (1 - paddleSquash * 0.32);
    var pw = paddleW + paddleSquash * 6;
    ctx.fillStyle = paddleGrad;
    fillRound(paddleX, PADDLE_Y + (PADDLE_H - ph), pw, ph, ph / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    fillRound(paddleX + 5, PADDLE_Y + 2, pw - 10, 3, 1.5);
    if (catchT > 0) {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = CAP_COLOR[C_CATCH];
      ctx.lineWidth = 2;
      strokeRound(paddleX - 2, PADDLE_Y - 2, pw + 4, ph + 4, (ph + 4) / 2);
      ctx.globalAlpha = 1;
    }
    if (laserT > 0) {
      ctx.fillStyle = CAP_COLOR[C_LASER];
      fillRound(paddleX + 3, PADDLE_Y - 6, 6, 9, 2);
      fillRound(paddleX + pw - 9, PADDLE_Y - 6, 6, 9, 2);
    }
    if (pierceT > 0) {
      ctx.globalAlpha = 0.4 + 0.3 * Math.sin(levelTime * 9);
      ctx.strokeStyle = CAP_COLOR[C_PIERCE];
      ctx.lineWidth = 2;
      strokeRound(paddleX + 1, PADDLE_Y + 1, pw - 2, ph - 2, ph / 2);
      ctx.globalAlpha = 1;
    }

    /* 暂停遮罩：压暗画面 + 两条竖线组成的「暂停」符号（不写字，零分配） */
    if (paused) {
      ctx.fillStyle = 'rgba(85,85,85,0.42)';
      ctx.fillRect(-10, -10, W + 20, H + 20);
      ctx.fillStyle = 'rgba(255,253,242,0.92)';
      fillRound(W / 2 - 15, H / 2 - 26, 11, 52, 3);
      fillRound(W / 2 + 4, H / 2 - 26, 11, 52, 3);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function anyHeld() {
    for (var k = 0; k < ballN; k++) if (balls[k].alive && balls[k].held) return true;
    return false;
  }

  /* ───────────────── 22. HUD / DOM 反馈（改值才写 DOM） ───────────────── */

  var domCache = { score: -1, best: -1, lives: -1, level: -1, balls: -1, combo: -1, lname: '', overlay: '@' };

  /* 心形：初始 3 颗常显，加命后追加；掉命的那颗做个收束动画 */
  function renderLives(animate) {
    var showMax = lives > 3 ? lives : 3;
    for (var k = 0; k < heartEls.length; k++) {
      var el = heartEls[k];
      var off = k >= lives;
      el.style.display = k < showMax ? '' : 'none';
      el.classList.toggle('off', off);
      el.classList.toggle('hit', animate && off && k < showMax);
    }
  }

  function syncDom(force) {
    if (force || domCache.score !== score) { scoreEl.textContent = String(score); domCache.score = score; }
    if (force || domCache.best !== best) { bestEl.textContent = String(best); domCache.best = best; }
    if (force || domCache.lives !== lives) { renderLives(force); domCache.lives = lives; }
    if (force || domCache.level !== level) { levelEl.textContent = String(level); domCache.level = level; }
    if (force || domCache.lname !== curName) { lnameEl.textContent = curName; domCache.lname = curName; }
    var live = aliveBalls();
    if (force || domCache.balls !== live) { ballsEl.textContent = String(live || 0); domCache.balls = live; }
    if (force || domCache.combo !== comboMult2) {
      comboEl.textContent = '×' + comboMult2;
      comboBadgeEl.textContent = '×' + comboMult2;
      comboBadgeEl.classList.toggle('on', comboMult2 > 1);
      domCache.combo = comboMult2;
    }

    var key = over ? (won ? 'win' : (endless ? 'endless-over' : 'lose')) : '';
    if (force || domCache.overlay !== key) {
      domCache.overlay = key;
      if (key) {
        ovScoreEl.textContent = String(score);
        ovLevelEl.textContent = String(level) + ' · ' + curName;
        ovBricksEl.textContent = String(bricksDestroyed);
        ovComboEl.textContent = '×' + bestCombo;
        ovCapsEl.textContent = String(capsCollected);
        ovLifeLabelEl.textContent = endBonusLabel;
        ovLifeEl.textContent = '+' + endBonus;
        ovBestEl.textContent = String(best);
        if (key === 'win') {
          overlayEmojiEl.textContent = '🎉';
          overlayTitleEl.textContent = '全部通关！';
          overlayBtn2.hidden = false;
          overlayBtn2.textContent = '进入无尽模式';
        } else {
          overlayEmojiEl.textContent = '🙈';
          overlayTitleEl.textContent = endless ? '无尽挑战结束' : '游戏结束';
          overlayBtn2.hidden = continueUsed;
          overlayBtn2.textContent = '续关（分数减半）';
        }
        overlayEl.classList.add('on');
      } else {
        overlayEl.classList.remove('on');
      }
    }
  }

  function floatScore(v) {
    floatEl.textContent = '+' + v;
    floatEl.classList.remove('on');
    void floatEl.offsetWidth;
    floatEl.classList.add('on');
  }

  function showToast(main, sub, hold) {
    toastMainEl.textContent = main;
    toastSubEl.textContent = sub;
    toastEl.classList.remove('on', 'hold');
    void toastEl.offsetWidth;
    if (hold) toastEl.classList.add('hold');
    toastEl.classList.add('on');
  }

  function hideToast() { toastEl.classList.remove('on', 'hold'); }

  function edgeFlash() {
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');
  }

  /* ───────────────── 23. 输入 ───────────────── */

  function movePaddle(d) {
    if (over) return;
    paddleX = clamp(paddleX + d, 2, W - 2 - paddleW);
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) showToast('已暂停', '空格或点按画面继续', true);
    else hideToast();
    syncDom(true);
  }

  function toggleServePause() {
    if (over) { restart(); return; }
    if (releaseHeld()) return;
    if (!served) { hideToast(); serve(); }
    else togglePause();
  }

  function tapAction(key) {
    switch (key) {
      case 'ArrowLeft': case 'a': case 'A': movePaddle(-14); return true;
      case 'ArrowRight': case 'd': case 'D': movePaddle(14); return true;
      case 'ArrowUp': case 'q': case 'Q':
        if (!served || anyHeld()) { aim = clamp(aim - AIM_STEP, -AIM_MAX, AIM_MAX); return true; }
        movePaddle(-14); return true;
      case 'ArrowDown': case 'e': case 'E':
        if (!served || anyHeld()) { aim = clamp(aim + AIM_STEP, -AIM_MAX, AIM_MAX); return true; }
        movePaddle(14); return true;
      case ' ': case 'Space': case 'Spacebar': case 'Enter':
        toggleServePause(); return true;
      case 'p': case 'P': togglePause(); return true;
      case 'r': case 'R': restart(); return true;
      case 'm': case 'M': setMute(!SFX.isMuted()); return true;
      default: return false;
    }
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.isTrusted) SFX.resume();
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === ' ' || k === 'Spacebar') e.preventDefault();
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = true;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = true;
    if (k === 'ArrowUp' || k === 'q' || k === 'Q') held.aimL = true;
    if (k === 'ArrowDown' || k === 'e' || k === 'E') held.aimR = true;
    if (e.repeat) return;
    tapAction(k);
  }

  function onKeyUp(e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = false;
    if (k === 'ArrowUp' || k === 'q' || k === 'Q') held.aimL = false;
    if (k === 'ArrowDown' || k === 'e' || k === 'E') held.aimR = false;
  }

  function pointerToCanvasX(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) * (W / rect.width);
  }

  function setPaddleCenter(x) {
    paddleX = clamp(x - paddleW / 2, 2, W - 2 - paddleW);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (e.isTrusted) SFX.resume();
    canvas.focus();
    dragging = true;
    if (over) return;
    if (paused) { togglePause(); return; }
    setPaddleCenter(pointerToCanvasX(e));
    if (releaseHeld()) return;
    if (!served) { hideToast(); serve(); }
  }

  function onPointerMove(e) {
    var mouseHover = e.pointerType === 'mouse' && e.buttons === 0;
    if (!dragging && !mouseHover) return;
    if (over || paused) return;
    e.preventDefault();
    setPaddleCenter(pointerToCanvasX(e));
  }

  function onPointerUp() { dragging = false; }

  function onBlur() {
    held.left = false; held.right = false;
    held.aimL = false; held.aimR = false;
    dragging = false;
  }

  function bindHold(btn, key) {
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); held[key] = true; });
    var rel = function () { held[key] = false; };
    btn.addEventListener('pointerup', rel);
    btn.addEventListener('pointercancel', rel);
    btn.addEventListener('pointerleave', rel);
  }

  function bindAim(btn, key) {
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); held[key] = true; });
    var rel = function () { held[key] = false; };
    btn.addEventListener('pointerup', rel);
    btn.addEventListener('pointercancel', rel);
    btn.addEventListener('pointerleave', rel);
  }

  /* ───────────────── 24. 尺寸 / 启动 ───────────────── */

  var dpr = 1;

  function setupCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setMute(m) {
    SFX.setMuted(m);
    if (muteBtn) muteBtn.textContent = m ? '🔇' : '🔊';
    syncDom(false);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', setupCanvas);

  flashEl.addEventListener('animationend', function () { flashEl.classList.remove('on'); });

  bindHold(document.getElementById('pad-left'), 'left');
  bindHold(document.getElementById('pad-right'), 'right');
  bindAim(document.getElementById('pad-aim-l'), 'aimL');
  bindAim(document.getElementById('pad-aim-r'), 'aimR');
  document.getElementById('pad-serve').addEventListener('click', function (e) { if (e.isTrusted) SFX.resume(); toggleServePause(); });
  document.getElementById('pad-pause').addEventListener('click', function (e) { e.preventDefault(); togglePause(); });
  if (muteBtn) muteBtn.addEventListener('click', function (e) { e.preventDefault(); setMute(!SFX.isMuted()); });
  ['pad-serve', 'pad-pause', 'pad-mute'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  });

  restartBtn.addEventListener('click', function (e) { if (e.isTrusted) SFX.resume(); restart(); canvas.focus(); });
  overlayBtn.addEventListener('click', function (e) {
    if (e.isTrusted) SFX.resume();
    if (paused && !over) togglePause(); else restart();
    canvas.focus();
  });
  overlayBtn2.addEventListener('click', function (e) {
    if (e.isTrusted) SFX.resume();
    if (won) startEndless(); else continueRun();
    canvas.focus();
  });

  /* ───────────────── 25. 主循环 ───────────────── */

  var lastTime = 0;

  function frame(t) {
    if (!lastTime) lastTime = t;
    var dt = (t - lastTime) / 1000;
    lastTime = t;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;
    update(dt);
    render();
    syncDom(false);
    requestAnimationFrame(frame);
  }

  /* ───────────────── 26. 测试钩子 ───────────────── */

  function snapshot() {
    var bxs = [], bys = [], bsp = [], bangs = [], bh = [];
    for (var k = 0; k < ballN; k++) {
      var b = balls[k];
      if (!b.alive) continue;
      bxs.push(Math.round(b.x));
      bys.push(Math.round(b.y));
      bsp.push(Math.round(ballSpeed(b)));
      bangs.push(Math.round(Math.atan2(b.vx, -b.vy) * 1000) / 1000);
      bh.push(b.held ? 1 : 0);
    }
    var cks = [], cxs = [];
    for (var c = 0; c < MAX_CAPS; c++) {
      if (!caps[c].alive) continue;
      cks.push(CAP_CH[caps[c].kind]);
      cxs.push(Math.round(caps[c].x));
    }
    var aliveKinds = [], aliveCount = 0;
    for (var q = 0; q < brickN; q++) {
      if (!bricks[q].alive) continue;
      aliveCount++;
      if (aliveKinds.indexOf(BRICK_NAME[bricks[q].type]) < 0) aliveKinds.push(BRICK_NAME[bricks[q].type]);
    }
    return {
      /* —— 既有字段（不得改名/删除）—— */
      score: score,
      over: over,
      won: won,
      lives: lives,
      level: level,
      paddleX: paddleX,
      ball: { x: ball0.x, y: ball0.y, vx: ball0.vx, vy: ball0.vy },
      bricksRemaining: bricksRemaining,
      brickTotal: brickTotal,
      served: served,
      paused: paused,
      best: best,
      maxLevel: MAX_LEVEL,
      width: W,
      height: H,
      paddle: { x: paddleX, y: PADDLE_Y, w: paddleW, h: PADDLE_H },
      /* —— 扩展（逐系统可验证）—— */
      balls: bxs.length,
      ballCount: ballN,
      ballXs: bxs,
      ballYs: bys,
      ballSpeeds: bsp,
      ballAngles: bangs,
      ballHeld: bh,
      ballSpeed: Math.round(ballSpeed(ball0)),
      baseSpeed: Math.round(baseSpeedFor(level)),
      speedMul: speedMulNow(),
      rallyBonus: Math.round(rallyBonus * 1000) / 1000,
      aim: Math.round(aim * 1000) / 1000,
      capsules: capN,
      capsuleKinds: cks,
      capsuleXs: cxs,
      capsulesCollected: capsCollected,
      dropCounter: dropCounter,
      dropNeed: dropNeed,
      powers: {
        expand: Math.round(expandT * 100) / 100,
        reduce: Math.round(reduceT * 100) / 100,
        laser: Math.round(laserT * 100) / 100,
        catch: Math.round(catchT * 100) / 100,
        slow: Math.round(slowT * 100) / 100,
        fast: Math.round(fastT * 100) / 100,
        pierce: Math.round(pierceT * 100) / 100,
        shield: Math.round(shieldT * 100) / 100,
        shieldCharges: shieldCharges
      },
      laserShots: laserN,
      combo: comboCount,
      multiplier: comboMult2,
      comboTimer: Math.round(comboT * 100) / 100,
      bestCombo: bestCombo,
      bricksDestroyed: bricksDestroyed,
      bricksAlive: aliveCount,
      brickKindsAlive: aliveKinds,
      levelKinds: levelKinds,
      kindsSeen: kindsSeen,
      levelName: curName,
      levelSig: layoutSig,
      endless: endless,
      continueUsed: continueUsed,
      endBonus: endBonus,
      endBonusLabel: endBonusLabel,
      hitStop: Math.round(hitStop * 1000) / 1000,
      shake: Math.round(shakeMag * 100) / 100,
      levelTime: Math.round(levelTime * 100) / 100,
      seed: G_SEED,
      muted: SFX.isMuted()
    };
  }

  function hookSpawnCapsule(kind, x, y) {
    var k = kind;
    if (typeof k === 'string') {
      var idx = CAP_CH.indexOf(k.toUpperCase());
      if (idx < 0) { for (var q = 0; q < CAP_N; q++) if (CAP_NAME[q] === kind) { idx = q; break; } }
      k = idx;
    }
    k = k | 0;
    if (k < 0 || k >= CAP_N) return false;
    return spawnCapsule(x === undefined ? W / 2 : x, y === undefined ? 120 : y, k);
  }

  function hookGrant(kind) {
    var k = kind;
    if (typeof k === 'string') {
      var idx = CAP_CH.indexOf(k.toUpperCase());
      if (idx < 0) { for (var q = 0; q < CAP_N; q++) if (CAP_NAME[q] === kind) { idx = q; break; } }
      k = idx;
    }
    k = k | 0;
    if (k < 0 || k >= CAP_N) return -1;
    applyCapsule(k);
    return k;
  }

  function hookForceLevel(lv) {
    lv = clamp(lv | 0, 1, 9999);
    over = false; won = false; paused = false;
    level = lv;
    if (lv > MAX_LEVEL) endless = true;
    buildLevel(lv);
    resetBall();
    syncDom(true);
    showToast('第 ' + lv + ' 关 · ' + curName, curTip || '', false);
    return level;
  }

  window.__game = {
    snapshot: snapshot,
    restart: function () { restart(); },
    press: function (key) { return tapAction(key); },
    setSeed: function (n) {
      G_SEED = ((n | 0) >>> 0) || 1;
      gs = G_SEED; fs = 0x9E3779B9; ds = 0x2545F491;
      for (i = 0; i < MAX_BRICKS; i++) if (bricks[i].amp !== 0) bricks[i].phase = (bricks[i].col * 1.1 + bricks[i].row * 0.7);
    },
    /* 机制钩子 */
    spawnCapsule: hookSpawnCapsule,
    grant: hookGrant,
    clearPowers: function () { clearPowers(false); return true; },
    forceLevel: hookForceLevel,
    setBall: function (x, y, vx, vy, ci) {
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      served = true;
      clearBalls();
      ballN = 0;
      var b = spawnBall(x, y, vx || 0, vy || 0, ci || 0);
      if (!b) return null;
      return { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
    },
    setPaddle: function (x) {
      paddleX = clamp(x, 2, W - 2 - paddleW);
      if (!served) parkBall(ball0);
      return paddleX;
    },
    setAim: function (a) { aim = clamp(a, -AIM_MAX, AIM_MAX); return aim; },
    setPaused: function (p) { paused = !!p; syncDom(true); return paused; },
    setLives: function (n) { lives = clamp(n | 0, 1, MAX_LIVES); syncDom(true); return lives; },
    addScore: function (n) { addScore(n | 0); syncDom(true); return score; },
    setRally: function (n) { rallyBonus = clamp(n, 0, RALLY_MAX); return rallyBonus; },
    step: function (dt, count) {
      var d = typeof dt === 'number' && dt > 0 ? dt : 1 / 60;
      var c = typeof count === 'number' && count > 0 ? count : 1;
      for (var q = 0; q < c; q++) update(d);
      render();
      syncDom(false);
      return c;
    },
    levelInfo: function () {
      var kinds = [];
      for (var t = 0; t < BRICK_NAME.length; t++) if ((levelKinds >> t) & 1) kinds.push(BRICK_NAME[t]);
      return {
        level: level, name: curName, tip: curTip, sig: layoutSig,
        rows: levelRows, total: brickTotal, remaining: bricksRemaining,
        kinds: kinds, theme: palette
      };
    },
    bricks: function () {
      var out = [];
      for (var k = 0; k < brickN; k++) {
        var b = bricks[k];
        if (!b.alive) continue;
        out.push({
          i: k, type: BRICK_NAME[b.type], hp: b.hp, hpMax: b.hpMax,
          x: Math.round(b.x), y: Math.round(b.y), w: b.w, h: b.h, row: b.row, col: b.col,
          reveal: Math.round(b.reveal * 100) / 100, amp: b.amp,
          respawn: Math.round(b.respawn * 100) / 100
        });
      }
      return out;
    },
    pools: function () {
      var partAlive = 0, ringAlive = 0, brickAlive = 0;
      for (var k = 0; k < MAX_PART; k++) if (parts[k].alive) partAlive++;
      for (var g = 0; g < MAX_RING; g++) if (rings[g].alive) ringAlive++;
      for (var b = 0; b < MAX_BRICKS; b++) if (bricks[b].alive) brickAlive++;
      return {
        balls: aliveBalls(), ballsMax: MAX_BALLS,
        bricks: brickAlive, bricksSlots: brickN, bricksMax: MAX_BRICKS,
        capsules: capN, capsulesMax: MAX_CAPS,
        lasers: laserN, lasersMax: MAX_LASERS,
        particles: partAlive, particlesMax: MAX_PART,
        rings: ringAlive, ringsMax: MAX_RING,
        audioVoices: SFX.voices(),
        audioReady: SFX.ready(),
        audioPlays: SFX.plays(),
        domNodes: document.getElementsByTagName('*').length
      };
    },
    startEndless: startEndless,
    continueRun: continueRun,
    setMute: function (m) { setMute(!!m); return SFX.isMuted(); },
    audioReady: function () { return SFX.ready(); },
    sound: function () { SFX.resume(); return true; }
  };

  /* ───────────────── 27. 启动 ───────────────── */

  setupCanvas();
  setMute(SFX.isMuted());
  restart();
  canvas.focus();
  requestAnimationFrame(frame);
})();
