(function () {
  'use strict';

  var N = 20;                 // 20 x 20 网格
  var CELL = 20;              // 每个格子的绘图单位
  var SIZE = N * CELL;
  var BASE_MS = 150;          // 初始每步间隔
  var MIN_MS = 80;            // 速度下限
  var SPEED_STEP = 12;        // 每档缩短
  var SPEEDUP_EVERY = 5;      // 每吃 5 个食物提速一档
  var BEST_KEY = 'games.snake.best';

  // mulberry32：可播种 PRNG，保证 setSeed 后序列可复现
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var seed = 1;
  var rng = mulberry32(seed);

  // localStorage 在 file:// 下可能抛 SecurityError，退化为内存变量
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

  var el = {
    app: document.getElementById('app'),
    stage: document.getElementById('stage'),
    canvas: document.getElementById('board'),
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    notice: document.getElementById('notice'),
    restart: document.getElementById('restart'),
    pause: document.getElementById('pause')
  };
  var ctx = el.canvas.getContext('2d');

  var snake = [];
  var dir = [1, 0];
  var queue = [];
  var food = [0, 0];
  var score = 0;
  var foods = 0;
  var over = false;
  var paused = false;
  var ready = true;

  var acc = 0;
  var last = 0;
  var dirty = true;
  var scale = 1;
  var lastWidth = 0;

  var DIRS = {
    ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1],
    a: [-1, 0], w: [0, -1], d: [1, 0], s: [0, 1]
  };

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
    dir = [1, 0];
    queue = [];
    score = 0;
    foods = 0;
    over = false;
    paused = false;
    ready = true;
    acc = 0;
    spawnFood();
    sync();
  }

  function start() {
    ready = false;
    paused = false;
    acc = 0;
    step();
  }

  function die() {
    over = true;
    paused = false;
    if (score > best) { best = score; saveBest(best); }
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

    snake.unshift(head);
    if (grow) {
      score += 10;
      foods += 1;
      if (score > best) { best = score; saveBest(best); }
      spawnFood();
    } else {
      snake.pop();
    }
    sync();
  }

  function togglePause() {
    if (over) return;
    if (ready) { start(); return; }
    paused = !paused;
    acc = 0;
    sync();
  }

  function restart() {
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

  function sync() {
    el.score.textContent = String(score);
    el.best.textContent = String(best);
    el.pause.textContent = paused ? '继续' : '暂停';
    var text = over ? '游戏结束 · 得分 ' + score + ' · 按 R 重新开始'
      : paused ? '已暂停 · 空格继续'
        : ready ? '按方向键 / WASD 开始'
          : '';
    if (text) el.notice.textContent = text;
    el.notice.classList.toggle('show', !!text);
    dirty = true;
  }

  function resize() {
    var w = el.canvas.clientWidth;
    if (!w || w === lastWidth) return;
    lastWidth = w;
    var px = Math.round(w * Math.min(2, window.devicePixelRatio || 1));
    el.canvas.width = px;
    el.canvas.height = px;
    el.canvas.style.height = w + 'px';
    scale = px / SIZE;
    dirty = true;
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

  function draw() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#1f2329';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 1; i < N; i++) {
      var p = i * CELL + 0.5;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, SIZE);
      ctx.moveTo(0, p);
      ctx.lineTo(SIZE, p);
    }
    ctx.stroke();

    for (var j = snake.length - 1; j >= 0; j--) {
      var c = snake[j];
      ctx.fillStyle = j === 0 ? '#7cc8ff' : (j % 2 ? '#49b1f5' : '#3f9fdd');
      roundRect(c[0] * CELL + 1.5, c[1] * CELL + 1.5, CELL - 3, CELL - 3, 6);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(food[0] * CELL + CELL / 2, food[1] * CELL + CELL / 2, CELL * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#f76e6e';
    ctx.fill();

    var h = snake[0];
    var ex = h[0] * CELL + CELL / 2 + dir[0] * 4.5;
    var ey = h[1] * CELL + CELL / 2 + dir[1] * 4.5;
    var ox = dir[0] ? 0 : 3.4;
    var oy = dir[0] ? 3.4 : 0;
    ctx.fillStyle = '#16181d';
    ctx.beginPath();
    ctx.arc(ex - ox, ey - oy, 2.1, 0, Math.PI * 2);
    ctx.arc(ex + ox, ey + oy, 2.1, 0, Math.PI * 2);
    ctx.fill();
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
        if (over || paused) { acc = 0; break; }
        iv = stepMs();
      }
      dirty = true;
    }

    if (dirty) {
      draw();
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  // ---- 输入绑定 ----
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
    el.app.focus();
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
      if (over) restart();
      else if (ready) start();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) press(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
    else press(dy > 0 ? 'ArrowDown' : 'ArrowUp');
  }, { passive: true });

  el.canvas.addEventListener('click', function () {
    el.app.focus();
    if (over) restart();
    else if (ready) start();
  });

  el.restart.addEventListener('click', function () {
    restart();
    el.app.focus();
  });

  el.pause.addEventListener('click', function () {
    togglePause();
    el.app.focus();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  reset();
  resize();
  draw();
  el.app.focus();
  requestAnimationFrame(frame);

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: setSeed
  };
})();
