/* 打砖块 — 纯原生实现，零依赖、可离线运行 */
(function () {
  'use strict';

  /* ---------- 画布逻辑坐标与几何 ---------- */
  var W = 440;
  var H = 600;
  var COLS = 8;
  var ROWS = 5;
  var BW = 48;
  var BH = 18;
  var GAP_X = 5;
  var GAP_Y = 8;
  var BRICK_TOP = 64;
  var BRICK_LEFT = (W - (COLS * BW + (COLS - 1) * GAP_X)) / 2;

  var PADDLE_W = 84;
  var PADDLE_H = 12;
  var PADDLE_Y = H - 36;
  var PADDLE_SPEED = 430;

  var BALL_R = 6.5;
  var BASE_SPEED = 300;
  var SPEED_STEP = 0.08;
  var MAX_LEVEL = 5;
  var START_LIVES = 3;
  var NUDGE = 12;
  var STEP_MAX = 4;
  var MAX_DT = 1 / 30;

  /* 特效全部走固定长度池，运行期不再分配 */
  var TRAIL_N = 9;
  var FRAG_MAX = 60;
  var FRAG_PER_HIT = 5;
  var FRAG_LIFE = 0.34;
  var FLASH_MAX = 8;
  var FLASH_LIFE = 0.09;
  var FRAG_GRAVITY = 900;

  var STORE_KEY = 'games.breakout.best';

  /* ---------- 设计令牌（取自 /games/assets/base.css） ---------- */
  function token(name, fallback) {
    try {
      var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (err) {
      /* 忽略：用字面量兜底 */
    }
    return fallback;
  }

  var COLOR_COURT = token('--surface', '#fffdf2');
  var COLOR_LINE = token('--muted', '#9a9a95');
  var COLOR_BALL = token('--accent-press', '#0d4a52');
  var COLOR_PADDLE = token('--c2', '#ef476f');
  var COLOR_PADDLE_TOP = token('--c5', '#f37694');
  var ROW_COLORS = [
    token('--c1', '#ffc43d'),
    token('--c7', '#ffd470'),
    token('--c4', '#06d6a0'),
    token('--c6', '#22c2d6'),
    token('--c2', '#ef476f')
  ];

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var stageEl = document.getElementById('stage');
  var flashEl = document.getElementById('flash');
  var toastEl = document.getElementById('toast');
  var toastMainEl = document.getElementById('toast-main');
  var toastSubEl = document.getElementById('toast-sub');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var levelEl = document.getElementById('level');
  var floatEl = document.getElementById('float');
  var heartEls = document.querySelectorAll('#lives i');
  var overlayEl = document.getElementById('overlay');
  var overlayEmojiEl = document.getElementById('overlay-emoji');
  var overlayTitleEl = document.getElementById('overlay-title');
  var overlaySubEl = document.getElementById('overlay-sub');
  var overlayBtn = document.getElementById('again');
  var restartBtn = document.getElementById('restart');

  /* 球拍渐变只建一次（用户空间坐标与 DPR 无关） */
  var paddleGrad = ctx.createLinearGradient(0, PADDLE_Y, 0, PADDLE_Y + PADDLE_H);
  paddleGrad.addColorStop(0, COLOR_PADDLE_TOP);
  paddleGrad.addColorStop(1, COLOR_PADDLE);

  /* ---------- 可播种 PRNG（mulberry32） ---------- */
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
  /* 特效专用流：不干扰发球角度的随机序列，保证同种子同输入结果一致 */
  var fxRnd = mulberry32(0x9E3779B9);

  /* ---------- 最高分（file:// 下 localStorage 会抛错，退回内存变量） ---------- */
  var memBest = 0;

  function readBest() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var v = raw === null ? 0 : parseInt(raw, 10);
      if (isFinite(v) && v > 0) return v;
    } catch (err) {
      /* SecurityError 等：忽略，用内存值 */
    }
    return memBest;
  }

  function writeBest(v) {
    memBest = v;
    try {
      window.localStorage.setItem(STORE_KEY, String(v));
    } catch (err) {
      /* 忽略 */
    }
  }

  var best = readBest();

  /* ---------- 状态 ---------- */
  var bricks = [];
  var bricksRemaining = 0;
  var score = 0;
  var lives = START_LIVES;
  var level = 1;
  var over = false;
  var won = false;
  var paused = false;
  var served = false;
  var paddleX = (W - PADDLE_W) / 2;
  var ball = { x: W / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0 };
  var held = { left: false, right: false };
  var dragging = false;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function speedFor(lv) {
    return BASE_SPEED * (1 + (lv - 1) * SPEED_STEP);
  }

  function clampPaddle() {
    paddleX = clamp(paddleX, 0, W - PADDLE_W);
  }

  function parkBall() {
    ball.x = paddleX + PADDLE_W / 2;
    ball.y = PADDLE_Y - BALL_R - 1;
  }

  function buildLevel() {
    bricks = [];
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        bricks.push({
          x: BRICK_LEFT + c * (BW + GAP_X),
          y: BRICK_TOP + r * (BH + GAP_Y),
          row: r,
          alive: true
        });
      }
    }
    bricksRemaining = bricks.length;
  }

  function resetBall() {
    served = false;
    ball.vx = 0;
    ball.vy = 0;
    parkBall();
    trailCount = 0;
  }

  function restart() {
    rng = mulberry32(seed);
    score = 0;
    lives = START_LIVES;
    level = 1;
    over = false;
    won = false;
    paused = false;
    paddleX = (W - PADDLE_W) / 2;
    held.left = false;
    held.right = false;
    dragging = false;
    clearFx();
    buildLevel();
    resetBall();
    hideToast();
    syncDom(true);
    showToast('第 ' + level + ' 关', '空格或点按画面发球', false);
    render();
  }

  function serve() {
    if (served || over || paused) return;
    var sp = speedFor(level);
    var mag = 0.15 + rng() * 0.3;
    var ang = rng() < 0.5 ? -mag : mag;
    ball.vx = Math.sin(ang) * sp;
    ball.vy = -Math.cos(ang) * sp;
    served = true;
    trailCount = 0;
    pushTrail(ball.x, ball.y);
    syncDom(true);
  }

  function addScore(n) {
    score += n;
    if (score > best) {
      best = score;
      writeBest(best);
    }
  }

  function loseLife() {
    lives -= 1;
    if (lives <= 0) {
      lives = 0;
      over = true;
      if (score > best) {
        best = score;
        writeBest(best);
      }
    } else {
      resetBall();
    }
    edgeFlash();
    syncDom(true);
  }

  function clearLevel() {
    addScore(50);
    floatScore(50);
    if (level >= MAX_LEVEL) {
      won = true;
      over = true;
    } else {
      level += 1;
      buildLevel();
      resetBall();
      showToast('第 ' + level + ' 关', '球更快了 · 空格或点按发球', false);
    }
    syncDom(true);
  }

  /* ---------- 特效池（固定长度，按游标复用最旧的槽位） ---------- */
  var frags = [];
  for (var fi = 0; fi < FRAG_MAX; fi++) {
    frags.push({ live: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, rot: 0, spin: 0, w: 0, h: 0, color: '' });
  }
  var fragCursor = 0;

  var flashes = [];
  for (var fl = 0; fl < FLASH_MAX; fl++) {
    flashes.push({ live: false, life: 0, x: 0, y: 0, w: 0, h: 0 });
  }
  var flashCursor = 0;

  var trail = [];
  for (var ti = 0; ti < TRAIL_N; ti++) trail.push({ x: 0, y: 0 });
  var trailCount = 0;
  var trailHead = 0;

  function pushTrail(x, y) {
    trail[trailHead].x = x;
    trail[trailHead].y = y;
    trailHead = (trailHead + 1) % TRAIL_N;
    if (trailCount < TRAIL_N) trailCount += 1;
  }

  function clearFx() {
    for (var a = 0; a < FRAG_MAX; a++) frags[a].live = false;
    for (var b = 0; b < FLASH_MAX; b++) flashes[b].live = false;
    trailCount = 0;
  }

  function spawnFlash(brick) {
    var f = flashes[flashCursor];
    flashCursor = (flashCursor + 1) % FLASH_MAX;
    f.live = true;
    f.life = FLASH_LIFE;
    f.x = brick.x;
    f.y = brick.y;
    f.w = BW;
    f.h = BH;
  }

  function spawnFragments(brick) {
    var color = ROW_COLORS[brick.row % ROW_COLORS.length];
    var fw = (BW - (FRAG_PER_HIT - 1) * 1.5) / FRAG_PER_HIT;
    for (var n = 0; n < FRAG_PER_HIT; n++) {
      var p = frags[fragCursor];
      fragCursor = (fragCursor + 1) % FRAG_MAX;
      p.live = true;
      p.life = FRAG_LIFE;
      p.x = brick.x + n * (fw + 1.5) + fw / 2;
      p.y = brick.y + BH / 2;
      var ang = -Math.PI / 2 + (n - (FRAG_PER_HIT - 1) / 2) * 0.42 + (fxRnd() - 0.5) * 0.36;
      var sp = 100 + fxRnd() * 130;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.w = fw;
      p.h = BH * 0.72;
      p.rot = 0;
      p.spin = (fxRnd() - 0.5) * 12;
      p.color = color;
    }
  }

  function updateFx(dt) {
    for (var a = 0; a < FRAG_MAX; a++) {
      var p = frags[a];
      if (!p.live) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.live = false;
        continue;
      }
      p.vy += FRAG_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (var b = 0; b < FLASH_MAX; b++) {
      var f = flashes[b];
      if (!f.live) continue;
      f.life -= dt;
      if (f.life <= 0) f.live = false;
    }
  }

  /* ---------- 碰撞 ---------- */
  function circleHitsRect(x, y, rx, ry, rw, rh) {
    var cx = clamp(x, rx, rx + rw);
    var cy = clamp(y, ry, ry + rh);
    var dx = x - cx;
    var dy = y - cy;
    return dx * dx + dy * dy <= BALL_R * BALL_R;
  }

  function hitPaddle() {
    if (ball.vy <= 0) return;
    if (!circleHitsRect(ball.x, ball.y, paddleX, PADDLE_Y, PADDLE_W, PADDLE_H)) return;
    var rel = clamp((ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2), -1, 1);
    var ang = rel * 1.05; /* 中间近乎垂直，边缘约 60° */
    var sp = Math.max(speedFor(level), Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy));
    ball.vx = Math.sin(ang) * sp;
    ball.vy = -Math.cos(ang) * sp;
    ball.y = PADDLE_Y - BALL_R - 0.5;
  }

  /* 每次子步最多处理一块砖，避免同一帧连撞导致卡砖 */
  function hitBricks() {
    for (var i = 0; i < bricks.length; i++) {
      var b = bricks[i];
      if (!b.alive) continue;
      if (!circleHitsRect(ball.x, ball.y, b.x, b.y, BW, BH)) continue;

      b.alive = false;
      bricksRemaining -= 1;
      addScore(10);
      floatScore(10);
      spawnFlash(b);
      spawnFragments(b);

      var bcx = b.x + BW / 2;
      var bcy = b.y + BH / 2;
      var ox = (BALL_R + BW / 2) - Math.abs(ball.x - bcx);
      var oy = (BALL_R + BH / 2) - Math.abs(ball.y - bcy);
      if (ox < oy) {
        ball.vx = -ball.vx;
        ball.x += ball.x < bcx ? -ox : ox;
      } else {
        ball.vy = -ball.vy;
        ball.y += ball.y < bcy ? -oy : oy;
      }

      if (bricksRemaining <= 0) {
        clearLevel();
        return true;
      }
      return false;
    }
    return false;
  }

  /* 返回 true 表示球已被重置（掉球或过关），应终止本帧剩余子步 */
  function resolveCollisions() {
    if (ball.x - BALL_R < 0) {
      ball.x = BALL_R;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x + BALL_R > W) {
      ball.x = W - BALL_R;
      ball.vx = -Math.abs(ball.vx);
    }
    if (ball.y - BALL_R < 0) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    }

    hitPaddle();
    if (hitBricks()) return true;
    if (ball.y - BALL_R > H) {
      loseLife();
      return true;
    }
    return false;
  }

  function moveBall(dt) {
    var dx = ball.vx * dt;
    var dy = ball.vy * dt;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(dist / STEP_MAX));
    dx /= steps;
    dy /= steps;
    for (var i = 0; i < steps; i++) {
      ball.x += dx;
      ball.y += dy;
      if (resolveCollisions()) return;
    }
  }

  function update(dt) {
    updateFx(dt);
    if (over || paused) return;

    var dir = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    if (dir !== 0) {
      paddleX += dir * PADDLE_SPEED * dt;
      clampPaddle();
    }
    if (!served) {
      parkBall();
      trailCount = 0;
      return;
    }
    moveBall(dt);
    if (served) pushTrail(ball.x, ball.y);
  }

  /* ---------- 渲染 ---------- */
  function fillRound(x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  function strokeRound(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.stroke();
  }

  function render() {
    /* 奶油田地 */
    ctx.fillStyle = COLOR_COURT;
    ctx.fillRect(0, 0, W, H);

    /* 球台内框（浅灰细线） */
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = COLOR_LINE;
    ctx.lineWidth = 2;
    strokeRound(1, 1, W - 2, H - 2, 6);
    ctx.globalAlpha = 1;

    /* 砖块：圆角 + 顶部高光 + 内侧暗边 */
    for (var i = 0; i < bricks.length; i++) {
      var b = bricks[i];
      if (!b.alive) continue;
      ctx.fillStyle = ROW_COLORS[b.row % ROW_COLORS.length];
      fillRound(b.x, b.y, BW, BH, 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      fillRound(b.x + 3, b.y + 2.5, BW - 6, 2.5, 1.25);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 2;
      strokeRound(b.x + 1, b.y + 1, BW - 2, BH - 2, 3);
    }

    /* 命中闪白 */
    ctx.fillStyle = '#fff';
    for (var m = 0; m < FLASH_MAX; m++) {
      var fl = flashes[m];
      if (!fl.live) continue;
      ctx.globalAlpha = (fl.life / FLASH_LIFE) * 0.9;
      fillRound(fl.x, fl.y, fl.w, fl.h, 4);
    }

    /* 碎裂的圆角碎块 */
    for (var n = 0; n < FRAG_MAX; n++) {
      var p = frags[n];
      if (!p.live) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / FRAG_LIFE);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      fillRound(-p.w / 2, -p.h / 2, p.w, p.h, 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    /* 球的拖尾（越新越亮） */
    for (var t = 0; t < trailCount; t++) {
      var idx = (trailHead - trailCount + t + TRAIL_N) % TRAIL_N;
      var ratio = (t + 1) / trailCount;
      ctx.globalAlpha = 0.05 + 0.3 * ratio * ratio;
      ctx.beginPath();
      ctx.arc(trail[idx].x, trail[idx].y, BALL_R * (0.3 + 0.5 * ratio), 0, Math.PI * 2);
      ctx.fillStyle = COLOR_BALL;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 球 + 高光 */
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_BALL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ball.x - BALL_R * 0.32, ball.y - BALL_R * 0.34, BALL_R * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fill();

    /* 球拍：圆角矩形 + 高光条 */
    ctx.fillStyle = paddleGrad;
    fillRound(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H, PADDLE_H / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    fillRound(paddleX + 5, PADDLE_Y + 2, PADDLE_W - 10, 3, 1.5);
  }

  /* ---------- DOM 同步 ---------- */
  var domCache = { score: null, best: null, lives: null, level: null, overlay: null };

  function renderLives() {
    for (var i = 0; i < heartEls.length; i++) {
      var el = heartEls[i];
      var off = i >= lives;
      if (off === el.classList.contains('off')) continue;
      el.classList.toggle('off', off);
      el.classList.remove('hit');
      if (off) {
        void el.offsetWidth; /* 重排一次，让动画能重新播放 */
        el.classList.add('hit');
      }
    }
  }

  function syncDom(force) {
    if (force || domCache.score !== score) {
      scoreEl.textContent = String(score);
      domCache.score = score;
    }
    if (force || domCache.best !== best) {
      bestEl.textContent = String(best);
      domCache.best = best;
    }
    if (force || domCache.lives !== lives) {
      renderLives();
      domCache.lives = lives;
    }
    if (force || domCache.level !== level) {
      levelEl.textContent = String(level);
      domCache.level = level;
    }

    var key = over ? (won ? 'win' : 'lose') : '';
    if (force || domCache.overlay !== key) {
      domCache.overlay = key;
      if (key === 'win') {
        overlayEmojiEl.textContent = '🎉';
        overlayTitleEl.textContent = '全部通关！';
        overlaySubEl.textContent = '最终得分 ' + score + ' · 共 ' + MAX_LEVEL + ' 关';
        overlayEl.classList.add('on');
      } else if (key === 'lose') {
        overlayEmojiEl.textContent = '🙈';
        overlayTitleEl.textContent = '游戏结束';
        overlaySubEl.textContent = '得分 ' + score;
        overlayEl.classList.add('on');
      } else {
        overlayEl.classList.remove('on');
      }
    }
  }

  function floatScore(n) {
    floatEl.textContent = '+' + n;
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

  function hideToast() {
    toastEl.classList.remove('on', 'hold');
  }

  function edgeFlash() {
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');
    stageEl.classList.remove('shake');
    void stageEl.offsetWidth;
    stageEl.classList.add('shake');
  }

  /* ---------- 主循环 ---------- */
  var lastTime = 0;

  function frame(t) {
    if (!lastTime) lastTime = t;
    var dt = Math.min((t - lastTime) / 1000, MAX_DT);
    lastTime = t;
    update(dt);
    render();
    syncDom(false);
    requestAnimationFrame(frame);
  }

  /* ---------- 输入 ---------- */
  function movePaddle(delta) {
    if (over) return;
    paddleX += delta;
    clampPaddle();
    if (!served) parkBall();
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) showToast('已暂停', '空格或点按画面继续', true);
    else hideToast();
    syncDom(true);
  }

  function toggleServePause() {
    if (over) {
      restart();
      return;
    }
    if (!served) {
      hideToast();
      serve();
    } else {
      togglePause();
    }
  }

  function tapAction(key) {
    switch (key) {
      case 'ArrowLeft': case 'a': case 'A':
        movePaddle(-NUDGE);
        return true;
      case 'ArrowRight': case 'd': case 'D':
        movePaddle(NUDGE);
        return true;
      case ' ': case 'Space': case 'Spacebar': case 'Enter':
        toggleServePause();
        return true;
      case 'p': case 'P':
        togglePause();
        return true;
      case 'r': case 'R':
        restart();
        return true;
      default:
        return false;
    }
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
    }
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = true;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = true;
    if (e.repeat) return;
    tapAction(k);
  }

  function onKeyUp(e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = false;
  }

  function pointerToCanvasX(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) * (W / rect.width);
  }

  function setPaddleCenter(x) {
    paddleX = clamp(x - PADDLE_W / 2, 0, W - PADDLE_W);
    if (!served) parkBall();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvas.focus();
    dragging = true;
    if (over) return;
    if (paused) {
      togglePause();
      return;
    }
    setPaddleCenter(pointerToCanvasX(e));
    if (!served) {
      hideToast();
      serve();
    }
  }

  function onPointerMove(e) {
    var mouseHover = e.pointerType === 'mouse' && e.buttons === 0;
    if (!dragging && !mouseHover) return;
    if (over || paused) return;
    e.preventDefault();
    setPaddleCenter(pointerToCanvasX(e));
  }

  function onPointerUp() {
    dragging = false;
  }

  function onBlur() {
    held.left = false;
    held.right = false;
    dragging = false;
  }

  /* 触屏方向键：按住持续移动 */
  function bindHold(btn, key) {
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      held[key] = true;
    });
    var release = function () { held[key] = false; };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  }

  /* ---------- 初始化 ---------- */
  function setupCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  flashEl.addEventListener('animationend', function () {
    flashEl.classList.remove('on');
  });
  stageEl.addEventListener('animationend', function (e) {
    if (e.target === stageEl) stageEl.classList.remove('shake');
  });

  bindHold(document.getElementById('pad-left'), 'left');
  bindHold(document.getElementById('pad-right'), 'right');
  document.getElementById('pad-serve').addEventListener('click', function () {
    toggleServePause();
  });

  restartBtn.addEventListener('click', function () {
    restart();
    canvas.focus();
  });
  overlayBtn.addEventListener('click', function () {
    restart();
    canvas.focus();
  });

  setupCanvas();
  restart();
  canvas.focus();
  requestAnimationFrame(frame);

  /* ---------- 测试钩子 ---------- */
  window.__game = {
    snapshot: function () {
      return {
        score: score,
        over: over,
        won: won,
        lives: lives,
        level: level,
        paddleX: paddleX,
        ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
        bricksRemaining: bricksRemaining,
        brickTotal: bricks.length,
        served: served,
        paused: paused,
        best: best,
        maxLevel: MAX_LEVEL,
        width: W,
        height: H,
        paddle: { x: paddleX, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H }
      };
    },
    restart: function () {
      restart();
    },
    press: function (key) {
      tapAction(key);
    },
    setSeed: function (n) {
      seed = (n >>> 0) || 1;
      rng = mulberry32(seed);
    }
  };
})();
