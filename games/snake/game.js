/* 贪吃蛇 · 零依赖离线小游戏
 * 视觉与 2048 同族：灰外框 + 奶油棋盘 + 极淡格线；移动是格间插值，不再跳格。
 */
(function () {
  'use strict';

  var N = 20;                // 20 x 20 网格
  var CELL = 20;             // 每格的绘图单位
  var SIZE = N * CELL;       // 逻辑尺寸 400 x 400
  var BASE_MS = 150;         // 初始每步间隔
  var MIN_MS = 80;           // 速度下限
  var SPEED_STEP = 12;       // 每档提速
  var SPEEDUP_EVERY = 5;     // 每吃 5 个食物提速一档
  var BEST_KEY = 'games.snake.best';

  var TAU = Math.PI * 2;
  var FLASH_MS = 220;        // 吃到食物后蛇身加亮时长
  var SPARK_MS = 520;        // 粒子寿命
  var FADE_MS = 420;         // 死亡后蛇身褪色时长
  var OVER_DELAY = 380;      // 抖动 + 褪色之后再弹遮罩
  var FOOD_POP_MS = 160;     // 新食物弹入时长
  var SPARK_N = 14;

  // 与 base.css 的 token 同源：绿蛇（--c4）、玫红食物（--c2）、奶油棋盘（--cell）
  var COL = {
    cell: '#f8ffe5',
    grid: 'rgba(154, 154, 149, .2)',
    body: '#06d6a0',
    bodyHot: '#6deec4',
    head: '#05a47b',
    headHot: '#12c391',
    eye: '#f8ffe5',
    food: '#ef476f',
    halo: 'rgba(239, 71, 111, .16)',
    spark: ['#ef476f', '#ffc43d', '#06d6a0']
  };

  /* ---------- 可播种 PRNG（mulberry32），setSeed 后序列可复现 ---------- */
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

  /* ---------- localStorage：file:// 下可能抛 SecurityError，退化为内存变量 ---------- */
  var mem = {};
  function loadBest() {
    try { return Number(window.localStorage.getItem(BEST_KEY)) || 0; }
    catch (e) { return mem[BEST_KEY] || 0; }
  }
  function saveBest(v) {
    try { window.localStorage.setItem(BEST_KEY, String(v)); }
    catch (e) { mem[BEST_KEY] = v; }
  }
  var best = loadBest();

  /* ---------- DOM ---------- */
  var el = {
    frame: document.getElementById('frame'),
    stage: document.getElementById('stage'),
    board: document.getElementById('board'),
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    float: document.getElementById('float'),
    notice: document.getElementById('notice'),
    restart: document.getElementById('restart'),
    pause: document.getElementById('pause'),
    pad: document.getElementById('pad'),
    overlay: document.getElementById('overlay'),
    overSub: document.getElementById('over-sub'),
    again: document.getElementById('again')
  };
  var ctx = el.board.getContext('2d');
  var bg = document.createElement('canvas');   // 预渲染的棋盘底（奶油 + 格线）
  var bgCtx = bg.getContext('2d');

  /* ---------- 状态 ---------- */
  var snake = [];            // 头在前
  var prev = [];             // 上一步的逻辑状态，渲染插值的起点
  var dir = [1, 0];
  var queue = [];            // 待转向缓冲，最多 2 个
  var food = [0, 0];
  var score = 0;
  var foods = 0;
  var over = false;
  var paused = false;
  var ready = true;

  var acc = 0;               // 当前这一步已过去的时间
  var last = 0;
  var dirty = true;
  var scale = 1;
  var lastW = 0;

  var sparks = [];
  var flashUntil = 0;
  var fadeFrom = 0;
  var eatCell = null;        // 被吃掉的格子（给粒子爆发用）
  var eatFbAt = 0;           // 视觉上"咬到"的时刻
  var foodUpAt = 0;          // 新食物出现的时刻
  var overTimer = 0;

  var DIRS = {
    ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1],
    a: [-1, 0], w: [0, -1], d: [1, 0], s: [0, 1]
  };

  function nowMs() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
  }

  function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }

  function stepMs() {
    var level = Math.floor(foods / SPEEDUP_EVERY);
    return Math.max(MIN_MS, BASE_MS - level * SPEED_STEP);
  }

  function onSnake(x, y) {
    for (var i = 0; i < snake.length; i++) {
      if (snake[i][0] === x && snake[i][1] === y) return true;
    }
    return false;
  }

  // 食物只落在空格子里，取哪个格子完全由 PRNG 决定
  function spawnFood() {
    var free = [];
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        if (!onSnake(x, y)) free.push([x, y]);
      }
    }
    if (!free.length) return;
    food = free[Math.floor(rng() * free.length)];
  }

  function reset() {
    rng = mulberry32(seed);
    var cy = Math.floor(N / 2);
    var cx = Math.floor(N / 2) - 2;
    snake = [[cx, cy], [cx - 1, cy], [cx - 2, cy]];
    prev = snake.slice();
    dir = [1, 0];
    queue = [];
    score = 0;
    foods = 0;
    over = false;
    paused = false;
    ready = true;
    acc = 0;
    sparks = [];
    flashUntil = 0;
    fadeFrom = 0;
    eatCell = null;
    eatFbAt = 0;
    foodUpAt = 0;
    spawnFood();
    sync();
  }

  function start() {
    ready = false;
    paused = false;
    acc = 0;
    prev = snake.slice();
    step();                  // 首次按下方向键立刻走一格（与重构前一致）
  }

  function die() {
    over = true;
    paused = false;
    if (score > best) { best = score; saveBest(best); }
    prev = snake.slice();    // 视觉停在最后一格，别被插值拽回去
    acc = 0;
    fadeFrom = nowMs();
    el.frame.classList.add('shake');
    if (overTimer) clearTimeout(overTimer);
    overTimer = setTimeout(function () {
      overTimer = 0;
      el.overSub.textContent = '得分 ' + score + ' · 最高 ' + best;
      el.overlay.classList.add('on');
    }, OVER_DELAY);
    sync();
  }

  function step() {
    if (over || paused || ready) return;
    if (queue.length) dir = queue.shift();

    var head = [snake[0][0] + dir[0], snake[0][1] + dir[1]];
    if (head[0] < 0 || head[0] >= N || head[1] < 0 || head[1] >= N) { die(); return; }

    var grow = same(head, food);
    var limit = grow ? snake.length : snake.length - 1; // 不增长时尾巴会让位
    for (var i = 0; i < limit; i++) {
      if (snake[i][0] === head[0] && snake[i][1] === head[1]) { die(); return; }
    }

    prev = snake;
    snake = [head].concat(snake);
    if (grow) {
      score += 10;
      foods += 1;
      if (score > best) { best = score; saveBest(best); }
      eatCell = [food[0], food[1]];
      spawnFood();
      // 渲染慢一步：咬到的反馈等蛇头在画面上真正滑进那一格再放
      var wait = stepMs();
      eatFbAt = nowMs() + wait;
      foodUpAt = eatFbAt;
    } else {
      snake.pop();
    }
    sync();
  }

  function togglePause() {
    if (over) return;
    if (ready) { start(); return; }
    paused = !paused;        // acc / prev 不动，暂停时画面停在半格之间
    sync();
  }

  function restart() {
    if (overTimer) { clearTimeout(overTimer); overTimer = 0; }
    el.overlay.classList.remove('on');
    el.frame.classList.remove('shake');
    el.float.classList.remove('on');
    reset();
  }

  function setSeed(n) {
    seed = (typeof n === 'number' && isFinite(n)) ? Math.trunc(n) : 1;
    reset();
  }

  function snapshot() {
    return {
      score: score,
      over: over,
      paused: paused,
      ready: ready,
      foods: foods,
      stepMs: stepMs(),
      dir: [dir[0], dir[1]],
      snake: snake.map(function (c) { return [c[0], c[1]]; }),
      food: [food[0], food[1]],
      best: best,
      seed: seed
    };
  }

  // 键盘输入的统一入口：press('ArrowLeft') / press(' ') / press('r') …
  function press(key) {
    var k = typeof key === 'string' ? key : '';
    if (k.length === 1) k = k.toLowerCase();
    var d = DIRS[k];

    if (d) {
      if (over) return;
      var ref = queue.length ? queue[queue.length - 1] : dir;
      if (d[0] === -ref[0] && d[1] === -ref[1]) return; // 禁止 180° 反向
      if (ready) {
        if (!same(d, dir)) queue.push(d);
        start();
        return;
      }
      if (paused) return;
      if (!same(d, ref) && queue.length < 2) queue.push(d);
      return;
    }

    if (k === ' ' || k === 'Space' || k === 'Spacebar' || k === 'p') { togglePause(); return; }
    if (k === 'r') { restart(); return; }
    if (k === 'Enter') {
      if (over) restart();
      else if (ready) start();
      else togglePause();
    }
  }

  /* ---------- HUD ---------- */
  function sync() {
    el.score.textContent = String(score);
    el.best.textContent = String(best);
    el.pause.textContent = paused ? '继续' : '暂停';
    var text = over ? '' : paused ? '已暂停 · 空格继续' : ready ? '按方向键 / WASD 开始' : '';
    if (text) el.notice.textContent = text;
    el.notice.classList.toggle('show', !!text);
    dirty = true;
  }

  function floatScore(n) {
    el.float.textContent = '+' + n;
    el.float.classList.remove('on');
    void el.float.offsetWidth;   // 重排一次，动画才能重新播
    el.float.classList.add('on');
  }

  el.float.addEventListener('animationend', function () {
    el.float.classList.remove('on');
  });

  el.frame.addEventListener('animationend', function (e) {
    if (e.animationName === 'shake') el.frame.classList.remove('shake');
  });

  /* ---------- 画布 ---------- */
  function resize() {
    var w = el.board.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    var px = Math.round(w * Math.min(2, window.devicePixelRatio || 1));
    el.board.width = px;
    el.board.height = px;
    scale = px / SIZE;
    buildBg(px);
    dirty = true;
  }

  // 棋盘底：奶油格子 + 极淡格线，只在尺寸变化时重画一次
  function buildBg(px) {
    var s = px / SIZE;
    var lw = Math.max(1, Math.round(s));
    bg.width = px;
    bg.height = px;
    bgCtx.setTransform(1, 0, 0, 1, 0, 0);
    bgCtx.fillStyle = COL.cell;
    bgCtx.fillRect(0, 0, px, px);
    bgCtx.strokeStyle = COL.grid;
    bgCtx.lineWidth = lw;
    bgCtx.beginPath();
    for (var i = 1; i < N; i++) {
      var p = Math.round(i * CELL * s) + (lw % 2 ? 0.5 : 0);
      bgCtx.moveTo(p, 0);
      bgCtx.lineTo(p, px);
      bgCtx.moveTo(0, p);
      bgCtx.lineTo(px, p);
    }
    bgCtx.stroke();
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

  // 本步已走完的比例：0 = 还在上一格，1 = 已经进到当前格
  function progress() {
    var iv = stepMs();
    var p = iv > 0 ? acc / iv : 1;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function drawFood(t) {
    if (t < foodUpAt) return;                 // 等蛇头滑进那一格，新食物再冒出来
    var k = Math.min(1, (t - foodUpAt) / FOOD_POP_MS);
    var grow = 0.55 + 0.45 * k;
    var pulse = 1 + 0.09 * Math.sin(t / 300); // 缓慢脉动
    var x = food[0] * CELL + CELL / 2;
    var y = food[1] * CELL + CELL / 2;
    var r = CELL * 0.29 * pulse * grow;
    ctx.fillStyle = COL.halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.85, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COL.food;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function drawSnake(t) {
    var p = progress();
    var hot = t < flashUntil;
    var fade = over ? 1 - Math.min(1, (t - fadeFrom) / FADE_MS) : 1;
    if (fade <= 0) return;
    ctx.globalAlpha = 0.2 + 0.8 * fade;       // 死亡后整条蛇褪色
    ctx.fillStyle = hot ? COL.bodyHot : COL.body;

    var i, a, b, x, y, s, head;
    for (i = snake.length - 1; i >= 0; i--) {
      a = prev[i] || snake[i];                // 刚长出来的一节没有起点，就停在原地
      b = snake[i];
      x = (a[0] + (b[0] - a[0]) * p) * CELL + CELL / 2;
      y = (a[1] + (b[1] - a[1]) * p) * CELL + CELL / 2;
      head = i === 0;
      s = CELL * (head ? 0.98 : 0.94);
      if (head) ctx.fillStyle = hot ? COL.headHot : COL.head;
      else ctx.fillStyle = hot ? COL.bodyHot : COL.body;
      roundRect(x - s / 2, y - s / 2, s, s, s * 0.3);
      ctx.fill();
      if (head) drawEyes(x, y);
    }
    ctx.globalAlpha = 1;
  }

  // 眼睛朝向当前方向
  function drawEyes(x, y) {
    var fx = dir[0] * CELL * 0.19;
    var fy = dir[1] * CELL * 0.19;
    var sx = dir[0] ? 0 : CELL * 0.19;
    var sy = dir[0] ? CELL * 0.19 : 0;
    ctx.fillStyle = COL.eye;
    ctx.beginPath();
    ctx.arc(x + fx - sx, y + fy - sy, CELL * 0.11, 0, TAU);
    ctx.arc(x + fx + sx, y + fy + sy, CELL * 0.11, 0, TAU);
    ctx.fill();
  }

  function drawSparks(t) {
    if (!sparks.length) return;
    for (var i = 0; i < sparks.length; i++) {
      var p = sparks[i];
      var k = (t - p.born) / SPARK_MS;
      if (k >= 1) continue;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x + p.vx * (t - p.born), p.y + p.vy * (t - p.born), p.r * (1 - k * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 吃到食物的反馈：蛇身加亮 + 粒子迸发 + 飘 +10
  function eatFeedback(t) {
    flashUntil = t + FLASH_MS;
    if (eatCell) {
      var x = eatCell[0] * CELL + CELL / 2;
      var y = eatCell[1] * CELL + CELL / 2;
      for (var i = 0; i < SPARK_N; i++) {
        var a = (i / SPARK_N) * TAU + Math.random() * 0.6;
        var sp = 0.05 + Math.random() * 0.075;   // 单位 / 毫秒
        sparks.push({
          x: x,
          y: y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          r: 1.4 + Math.random() * 2.2,
          c: COL.spark[i % COL.spark.length],
          born: t
        });
      }
      eatCell = null;
    }
    floatScore(10);
  }

  function draw(t) {
    if (!lastW) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFood(t);
    drawSnake(t);
    drawSparks(t);
  }

  // 需要继续重绘吗（就绪时让食物脉动，暂停/结束后彻底停下省电）
  function animating(t) {
    return ready || (!over && !paused) || sparks.length > 0 ||
      t < flashUntil || t < fadeFrom + FADE_MS || t < eatFbAt;
  }

  function frame(t) {
    resize();
    var dt = last ? t - last : 0;
    last = t;
    if (dt > 100) dt = 100;

    if (!over && !paused && !ready) {
      acc += dt;
      var iv = stepMs();
      while (acc >= iv) {
        acc -= iv;
        step();
        if (over || paused) break;
        iv = stepMs();
      }
    }

    if (sparks.length) {
      var k = 0;
      for (var i = 0; i < sparks.length; i++) {
        if (t - sparks[i].born < SPARK_MS) sparks[k++] = sparks[i];
      }
      sparks.length = k;
    }

    if (eatFbAt && t >= eatFbAt) { eatFbAt = 0; eatFeedback(t); }

    if (dirty || animating(t)) {
      draw(t);
      dirty = false;
    }

    requestAnimationFrame(frame);
  }

  /* ---------- 输入绑定 ---------- */
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!DIRS[k] && k !== ' ' && k !== 'Spacebar' && k !== 'p' && k !== 'r' && k !== 'Enter') return;
    if (e.target && e.target.tagName === 'BUTTON' && (k === ' ' || k === 'Enter')) return;
    e.preventDefault();
    press(k);
  });

  var touchX = 0;
  var touchY = 0;
  el.stage.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    touchX = t.clientX;
    touchY = t.clientY;
  }, { passive: true });

  el.stage.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX;
    var dy = t.clientY - touchY;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
      if (over) restart();
      else if (ready) start();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) press(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
    else press(dy > 0 ? 'ArrowDown' : 'ArrowUp');
  }, { passive: true });

  el.board.addEventListener('click', function () {
    if (over) restart();
    else if (ready) start();
  });

  el.pad.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-dir]') : null;
    if (b) press(b.getAttribute('data-dir'));
  });

  el.restart.addEventListener('click', restart);
  el.pause.addEventListener('click', togglePause);
  el.again.addEventListener('click', restart);

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  reset();
  requestAnimationFrame(frame);

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: setSeed
  };
})();
