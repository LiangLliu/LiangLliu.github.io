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
  var ROW_COLORS = ['#49b1f5', '#4fd1c5', '#7bd88f', '#f2c94c', '#eb5757'];

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

  var STORE_KEY = 'games.breakout.best';
  var COLOR_BG = '#16181d';
  var COLOR_PADDLE = '#49b1f5';
  var COLOR_BALL = '#e6e8eb';

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var livesEl = document.getElementById('lives');
  var levelEl = document.getElementById('level');
  var overlayEl = document.getElementById('overlay');
  var overlayTitleEl = document.getElementById('overlay-title');
  var overlaySubEl = document.getElementById('overlay-sub');
  var restartBtn = document.getElementById('restart');

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
    buildLevel();
    resetBall();
    syncDom(true);
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
    syncDom(true);
  }

  function clearLevel() {
    addScore(50);
    if (level >= MAX_LEVEL) {
      won = true;
      over = true;
    } else {
      level += 1;
      buildLevel();
      resetBall();
    }
    syncDom(true);
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
    if (over || paused) return;

    var dir = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    if (dir !== 0) {
      paddleX += dir * PADDLE_SPEED * dt;
      clampPaddle();
    }
    if (!served) {
      parkBall();
      return;
    }
    moveBall(dt);
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

  function render() {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < bricks.length; i++) {
      var b = bricks[i];
      if (!b.alive) continue;
      ctx.fillStyle = ROW_COLORS[b.row % ROW_COLORS.length];
      fillRound(b.x, b.y, BW, BH, 4);
    }

    ctx.fillStyle = COLOR_PADDLE;
    fillRound(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H, PADDLE_H / 2);

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_BALL;
    ctx.fill();
  }

  var domCache = { score: null, best: null, lives: null, level: null, overlay: null };

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
      livesEl.textContent = String(lives);
      domCache.lives = lives;
    }
    if (force || domCache.level !== level) {
      levelEl.textContent = String(level);
      domCache.level = level;
    }

    var key = over ? (won ? 'win' : 'lose') : (paused ? 'pause' : (served ? 'play' : 'ready'));
    if (force || domCache.overlay !== key) {
      domCache.overlay = key;
      if (key === 'play') {
        overlayEl.hidden = true;
      } else {
        overlayEl.hidden = false;
        if (key === 'win') {
          overlayTitleEl.textContent = '全部通关！';
          overlaySubEl.textContent = '最终得分 ' + score + ' · 按 R 再来一局';
        } else if (key === 'lose') {
          overlayTitleEl.textContent = '游戏结束';
          overlaySubEl.textContent = '最终得分 ' + score + ' · 按 R 再来一局';
        } else if (key === 'pause') {
          overlayTitleEl.textContent = '已暂停';
          overlaySubEl.textContent = '按空格继续';
        } else {
          overlayTitleEl.textContent = '第 ' + level + ' 关';
          overlaySubEl.textContent = '按空格或点击画面发球';
        }
      }
    } else if (over) {
      overlaySubEl.textContent = '最终得分 ' + score + ' · 按 R 再来一局';
    }
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

  function toggleServePause() {
    if (over) {
      restart();
      return;
    }
    if (!served) {
      serve();
    } else {
      paused = !paused;
      syncDom(true);
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
        if (!over) {
          paused = !paused;
          syncDom(true);
        }
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
      paused = false;
      syncDom(true);
      return;
    }
    setPaddleCenter(pointerToCanvasX(e));
    if (!served) serve();
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
  restartBtn.addEventListener('click', function () {
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
