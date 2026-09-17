/* 2048 · 零依赖离线小游戏 */
(function () {
  'use strict';

  const N = 4;
  const CELLS = N * N;
  const ANIM_MS = 120;
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';
  const BEST_KEY = 'games.2048.best';

  /* ---------- 可播种 PRNG（mulberry32） ---------- */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rnd = mulberry32(20260917);

  /* ---------- 状态 ---------- */
  let board = new Array(CELLS).fill(0); // 行优先，0 为空
  let score = 0;
  let moves = 0;
  let over = false;
  let won = false;
  let keepPlaying = false;
  let memBest = 0;
  const anims = new Map(); // 索引 -> { type: 'spawn' | 'merge', t0 }

  const TILE_COLORS = {
    2: ['#2e3641', '#e6e8eb'],
    4: ['#3a4453', '#e6e8eb'],
    8: ['#38618c', '#e6e8eb'],
    16: ['#3d7ebb', '#ffffff'],
    32: ['#49b1f5', '#10141a'],
    64: ['#4fd1c5', '#10141a'],
    128: ['#8bd450', '#10141a'],
    256: ['#e0c14b', '#10141a'],
    512: ['#f0a03c', '#10141a'],
    1024: ['#f27544', '#10141a'],
    2048: ['#ef5350', '#ffffff'],
    4096: ['#b06cf5', '#ffffff'],
    8192: ['#7c4dd4', '#ffffff'],
  };
  const FALLBACK_COLORS = ['#4a5461', '#ffffff'];

  /* ---------- 最高分持久化（file:// 下 localStorage 可能抛错） ---------- */
  function readBest() {
    try {
      const v = Number(localStorage.getItem(BEST_KEY));
      return v > 0 ? v : 0;
    } catch (e) {
      return memBest;
    }
  }
  function writeBest(v) {
    memBest = v;
    try {
      localStorage.setItem(BEST_KEY, String(v));
    } catch (e) {
      /* 忽略：内存值兜底 */
    }
  }
  let best = readBest();

  /* ---------- 每行的索引序列（从移动方向的“最前”开始） ---------- */
  const LINES = (function () {
    const out = {};
    ['left', 'up', 'right', 'down'].forEach(function (dir) {
      const lines = [];
      for (let i = 0; i < N; i++) {
        const line = [];
        for (let j = 0; j < N; j++) {
          const r = dir === 'up' ? j : dir === 'down' ? N - 1 - j : i;
          const c = dir === 'left' ? j : dir === 'right' ? N - 1 - j : i;
          line.push(r * N + c);
        }
        lines.push(line);
      }
      out[dir] = lines;
    });
    return out;
  })();

  /* ---------- 核心逻辑 ---------- */
  function spawn() {
    const empty = [];
    for (let i = 0; i < CELLS; i++) if (board[i] === 0) empty.push(i);
    if (empty.length === 0) return -1;
    const idx = empty[Math.floor(rnd() * empty.length)];
    board[idx] = rnd() < 0.9 ? 2 : 4;
    return idx;
  }

  function canMove() {
    for (let i = 0; i < CELLS; i++) if (board[i] === 0) return true;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = board[r * N + c];
        if (c + 1 < N && v === board[r * N + c + 1]) return true;
        if (r + 1 < N && v === board[(r + 1) * N + c]) return true;
      }
    }
    return false;
  }

  function move(dir) {
    if (over || (won && !keepPlaying)) return false;
    const before = board.slice();
    const merged = [];
    let gained = 0;

    for (const line of LINES[dir]) {
      const vals = [];
      for (const idx of line) if (board[idx] !== 0) vals.push(board[idx]);
      const out = [];
      for (let k = 0; k < vals.length; k++) {
        if (k + 1 < vals.length && vals[k] === vals[k + 1]) {
          const v = vals[k] * 2;
          out.push(v);
          gained += v;
          merged.push(line[out.length - 1]);
          k++; // 每个格子每步只合并一次
        } else {
          out.push(vals[k]);
        }
      }
      for (let k = 0; k < N; k++) {
        board[line[k]] = k < out.length ? out[k] : 0;
      }
    }

    let changed = false;
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== before[i]) { changed = true; break; }
    }
    if (!changed) return false;

    moves++;
    if (gained > 0) {
      score += gained;
      if (score > best) { best = score; writeBest(best); }
    }

    anims.clear();
    const t = performance.now();
    for (const idx of merged) anims.set(idx, { type: 'merge', t0: t });
    const at = spawn();
    if (at >= 0) anims.set(at, { type: 'spawn', t0: t });

    if (!won && has2048()) {
      won = true;
      keepPlaying = false;
      showOverlay('达成 2048！得分 ' + score, '继续挑战');
    } else if (!canMove()) {
      over = true;
      showOverlay('无处可走 · 得分 ' + score, '再来一局');
    }

    syncHud();
    draw();
    return true;
  }

  function has2048() {
    for (let i = 0; i < CELLS; i++) if (board[i] >= 2048) return true;
    return false;
  }

  function restart() {
    board = new Array(CELLS).fill(0);
    score = 0;
    moves = 0;
    over = false;
    won = false;
    keepPlaying = false;
    anims.clear();
    hideOverlay();

    const a = spawn();
    const b = spawn();
    const t = performance.now();
    if (a >= 0) anims.set(a, { type: 'spawn', t0: t });
    if (b >= 0) anims.set(b, { type: 'spawn', t0: t });

    syncHud();
    draw();
  }

  /* ---------- 覆盖层 ---------- */
  function showOverlay(msg, btnText) {
    overlayMsgEl.textContent = msg;
    overlayBtn.textContent = btnText;
    overlayEl.hidden = false;
  }
  function hideOverlay() {
    overlayEl.hidden = true;
  }
  function overlayAction() {
    if (over) { restart(); return; }
    if (won && !keepPlaying) {
      keepPlaying = true;
      hideOverlay();
      if (!canMove()) {
        over = true;
        showOverlay('无处可走 · 得分 ' + score, '再来一局');
      }
    }
  }

  /* ---------- 输入 ---------- */
  const KEYS = {
    arrowleft: 'left', a: 'left',
    arrowright: 'right', d: 'right',
    arrowup: 'up', w: 'up',
    arrowdown: 'down', s: 'down',
    r: 'restart',
    ' ': 'action', space: 'action', spacebar: 'action', enter: 'action',
  };

  function press(key) {
    if (typeof key !== 'string') return false;
    const act = KEYS[key.toLowerCase()];
    if (act === 'restart') { restart(); return true; }
    if (act === 'action') { overlayAction(); return true; }
    if (act === 'left' || act === 'right' || act === 'up' || act === 'down') return move(act);
    return false;
  }

  /* ---------- 渲染 ---------- */
  const app = document.querySelector('.app');
  const boardEl = document.getElementById('board');
  const canvas = document.getElementById('cv');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const overlayEl = document.getElementById('overlay');
  const overlayMsgEl = document.getElementById('overlayMsg');
  const overlayBtn = document.getElementById('overlayBtn');

  if (typeof ctx.roundRect !== 'function') {
    ctx.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }

  let size = 0;
  let gap = 0;
  let cell = 0;
  let radius = 12;

  function resize() {
    const rect = boardEl.getBoundingClientRect();
    const px = Math.round(rect.width);
    if (px <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(px * dpr);
    canvas.height = Math.round(px * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = px;
    gap = Math.max(6, size * 0.025);
    cell = (size - gap * (N + 1)) / N;
    radius = Math.max(6, cell * 0.12);
    draw();
  }

  function pos(i) {
    const c = i % N;
    const r = (i - c) / N;
    return { x: gap + c * (cell + gap), y: gap + r * (cell + gap) };
  }

  function draw() {
    if (size <= 0) return;
    const now = performance.now();
    ctx.clearRect(0, 0, size, size);

    for (let i = 0; i < CELLS; i++) {
      const p = pos(i);
      ctx.beginPath();
      ctx.fillStyle = '#262b33';
      ctx.roundRect(p.x, p.y, cell, cell, radius);
      ctx.fill();
    }

    for (let i = 0; i < CELLS; i++) {
      const v = board[i];
      if (v === 0) continue;
      let scale = 1;
      const a = anims.get(i);
      if (a) {
        const p = Math.min(1, (now - a.t0) / ANIM_MS);
        scale = a.type === 'spawn'
          ? 0.4 + 0.6 * (1 - (1 - p) * (1 - p))
          : 1 + 0.22 * (1 - p);
        if (p >= 1) anims.delete(i);
      }
      drawTile(i, v, scale);
    }
  }

  function drawTile(i, v, scale) {
    const p = pos(i);
    const colors = TILE_COLORS[v] || FALLBACK_COLORS;
    const w = cell * scale;
    const h = cell * scale;
    const cx = p.x + cell / 2;
    const cy = p.y + cell / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.fillStyle = colors[0];
    ctx.roundRect(-w / 2, -h / 2, w, h, radius * scale);
    ctx.fill();

    const digits = String(v).length;
    const fs = cell * (digits <= 2 ? 0.44 : digits === 3 ? 0.36 : digits === 4 ? 0.3 : 0.24);
    ctx.fillStyle = colors[1];
    ctx.font = '700 ' + fs + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), 0, fs * 0.04);
    ctx.restore();
  }

  function syncHud() {
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
  }

  function frame() {
    if (anims.size > 0) draw();
    requestAnimationFrame(frame);
  }

  /* ---------- 事件 ---------- */
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' ||
        k === 'ArrowDown' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
    }
    press(k);
  });

  boardEl.addEventListener('pointerdown', function () {
    app.focus({ preventScroll: true });
  });

  document.getElementById('restart').addEventListener('click', restart);
  overlayBtn.addEventListener('click', overlayAction);

  let touchX = 0;
  let touchY = 0;
  let touching = false;

  canvas.addEventListener('touchstart', function (e) {
    const t = e.changedTouches[0];
    touchX = t.clientX;
    touchY = t.clientY;
    touching = true;
  }, { passive: true });

  canvas.addEventListener('touchcancel', function () { touching = false; }, { passive: true });

  canvas.addEventListener('touchend', function (e) {
    if (!touching) return;
    touching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  window.addEventListener('resize', resize);

  /* ---------- 测试钩子 ---------- */
  window.__game = {
    snapshot: function () {
      return {
        score: score,
        best: best,
        over: over,
        won: won,
        keepPlaying: keepPlaying,
        moves: moves,
        board: board.slice(),
      };
    },
    restart: restart,
    press: press,
    setSeed: function (n) { rnd = mulberry32(n | 0); },
  };

  /* ---------- 启动 ---------- */
  restart();
  resize();
  requestAnimationFrame(frame);
  app.focus({ preventScroll: true });
})();
