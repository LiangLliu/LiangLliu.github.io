/* 俄罗斯方块 — 零依赖 · 可离线 · 可播种 */
(function () {
  'use strict';

  const ROWS = 20;
  const COLS = 10;
  const CELL = 30;
  const NEXT_CELL = 16;
  const BOARD_W = COLS * CELL;
  const BOARD_H = ROWS * CELL;
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';
  const BEST_KEY = 'tetris.best.v1';
  const LINE_SCORE = [0, 100, 300, 500, 800];

  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]]
  };
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const COLORS = { I: '#49b1f5', O: '#f2c14e', T: '#b48ead', S: '#7ec699', Z: '#e06c75', J: '#6f8ff7', L: '#e8a87c' };
  const ID = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
  const BY_ID = ['', 'I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const KICKS = [0, -1, 1, -2, 2];
  const HANDLED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Space', 'Spacebar', 'x', 'X', 'z', 'Z', 'p', 'P', 'r', 'R', 'Enter'];

  /* ---------- 存储：file:// 下 localStorage 会抛 SecurityError ---------- */
  const store = (function () {
    try {
      const probe = '__tetris_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (e) {
      const mem = Object.create(null);
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); }
      };
    }
  })();

  /* ---------- 可播种 PRNG ---------- */
  let seed = 1;
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(seed);

  /* ---------- DOM ---------- */
  const el = {
    stage: document.getElementById('stage'),
    board: document.getElementById('board'),
    next: document.getElementById('next'),
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    lines: document.getElementById('lines'),
    level: document.getElementById('level'),
    restart: document.getElementById('btn-restart'),
    pause: document.getElementById('btn-pause')
  };

  function setupCanvas(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }
  const ctx = setupCanvas(el.board, BOARD_W, BOARD_H);
  const nctx = setupCanvas(el.next, NEXT_CELL * 4, NEXT_CELL * 4);

  /* ---------- 状态 ---------- */
  let board = emptyBoard();
  let current = null;
  let nextPiece = null;
  let bag = [];
  let score = 0;
  let lines = 0;
  let level = 1;
  let over = false;
  let paused = false;
  let best = Number(store.getItem(BEST_KEY)) || 0;
  let last = 0;
  let acc = 0;

  function emptyBoard() {
    const rows = [];
    for (let y = 0; y < ROWS; y++) rows.push(new Array(COLS).fill(0));
    return rows;
  }

  function eachCell(cells, fn) {
    for (let i = 0; i < cells.length; i++) {
      for (let j = 0; j < cells[i].length; j++) {
        if (cells[i][j]) fn(i, j);
      }
    }
  }

  function rotateCW(m) {
    const n = m.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) row.push(m[n - 1 - j][i]);
      out.push(row);
    }
    return out;
  }

  function nextType() {
    if (!bag.length) {
      bag = TYPES.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = bag[i];
        bag[i] = bag[j];
        bag[j] = t;
      }
    }
    return bag.pop();
  }

  function collide(cells, px, py) {
    for (let i = 0; i < cells.length; i++) {
      for (let j = 0; j < cells[i].length; j++) {
        if (!cells[i][j]) continue;
        const x = px + j;
        const y = py + i;
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y >= 0 && board[y][x]) return true;
      }
    }
    return false;
  }

  function spawn() {
    const type = nextPiece || nextType();
    nextPiece = nextType();
    const x = type === 'O' ? 4 : 3;
    current = { type: type, id: ID[type], x: x, y: 0, cells: SHAPES[type].map(function (r) { return r.slice(); }) };
    if (collide(current.cells, current.x, current.y)) {
      over = true;
      paused = false;
      updateBest();
    }
  }

  function updateBest() {
    if (score > best) {
      best = score;
      try { store.setItem(BEST_KEY, String(best)); } catch (e) { /* 忽略写入失败 */ }
    }
  }

  function clearLines() {
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      let full = true;
      for (let x = 0; x < COLS; x++) {
        if (!board[y][x]) { full = false; break; }
      }
      if (full) {
        board.splice(y, 1);
        board.unshift(new Array(COLS).fill(0));
        cleared++;
        y++;
      }
    }
    return cleared;
  }

  function lock() {
    const cells = current.cells;
    eachCell(cells, function (i, j) {
      const y = current.y + i;
      if (y >= 0) board[y][current.x + j] = current.id;
    });
    const cleared = clearLines();
    if (cleared > 0) {
      lines += cleared;
      score += LINE_SCORE[cleared] * level;
      level = Math.floor(lines / 10) + 1;
    }
    updateBest();
    renderHud();
    spawn();
  }

  function move(dx) {
    if (over || paused) return;
    if (!collide(current.cells, current.x + dx, current.y)) current.x += dx;
  }

  function rotate(dir) {
    if (over || paused) return;
    let cells = current.cells;
    const times = dir > 0 ? 1 : 3;
    for (let k = 0; k < times; k++) cells = rotateCW(cells);
    for (let k = 0; k < KICKS.length; k++) {
      const dx = KICKS[k];
      if (!collide(cells, current.x + dx, current.y)) {
        current.cells = cells;
        current.x += dx;
        return;
      }
    }
  }

  function softDrop() {
    if (over || paused) return;
    if (!collide(current.cells, current.x, current.y + 1)) {
      current.y++;
      score += 1;
      renderHud();
    } else {
      lock();
    }
  }

  function hardDrop() {
    if (over || paused) return;
    let dist = 0;
    while (!collide(current.cells, current.x, current.y + 1)) {
      current.y++;
      dist++;
    }
    score += dist * 2;
    lock();
    acc = 0;
  }

  function step() {
    if (!collide(current.cells, current.x, current.y + 1)) current.y++;
    else lock();
  }

  function dropInterval() {
    return Math.max(80, 800 - (level - 1) * 70);
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    last = 0;
    acc = 0;
    el.pause.textContent = paused ? '继续' : '暂停';
  }

  function restart() {
    rng = mulberry32(seed);
    bag = [];
    nextPiece = null;
    board = emptyBoard();
    score = 0;
    lines = 0;
    level = 1;
    over = false;
    paused = false;
    acc = 0;
    last = 0;
    el.pause.textContent = '暂停';
    spawn();
    renderHud();
    draw();
  }

  function handleKey(key) {
    switch (key) {
      case 'ArrowLeft': move(-1); break;
      case 'ArrowRight': move(1); break;
      case 'ArrowDown': softDrop(); break;
      case 'ArrowUp': case 'x': case 'X': rotate(1); break;
      case 'z': case 'Z': rotate(-1); break;
      case ' ': case 'Space': case 'Spacebar': hardDrop(); break;
      case 'p': case 'P': togglePause(); break;
      case 'r': case 'R': restart(); return;
      case 'Enter': if (over) restart(); return;
      default: return;
    }
    draw();
  }

  /* ---------- 渲染 ---------- */
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawCell(c, px, py, size, color, alpha) {
    c.globalAlpha = alpha;
    c.fillStyle = color;
    rrect(c, px + 1, py + 1, size - 2, size - 2, Math.max(2, size * 0.16));
    c.fill();
    c.globalAlpha = 1;
  }

  function draw() {
    ctx.clearRect(0, 0, BOARD_W, BOARD_H);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, BOARD_H);
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(BOARD_W, y * CELL + 0.5);
    }
    ctx.stroke();

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = board[y][x];
        if (v) drawCell(ctx, x * CELL, y * CELL, CELL, COLORS[BY_ID[v]], 1);
      }
    }

    if (current && !over) {
      const color = COLORS[current.type];
      let gy = current.y;
      while (!collide(current.cells, current.x, gy + 1)) gy++;
      if (gy > current.y) {
        eachCell(current.cells, function (i, j) {
          if (gy + i >= 0) drawCell(ctx, (current.x + j) * CELL, (gy + i) * CELL, CELL, color, 0.16);
        });
      }
      eachCell(current.cells, function (i, j) {
        if (current.y + i >= 0) drawCell(ctx, (current.x + j) * CELL, (current.y + i) * CELL, CELL, color, 1);
      });
    }

    if (paused || over) {
      ctx.fillStyle = 'rgba(22,24,29,0.72)';
      ctx.fillRect(0, 0, BOARD_W, BOARD_H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e6e8eb';
      ctx.font = '600 20px ' + FONT;
      ctx.fillText(over ? '游戏结束' : '已暂停', BOARD_W / 2, BOARD_H / 2 - 12);
      ctx.fillStyle = '#9aa4b2';
      ctx.font = '13px ' + FONT;
      ctx.fillText(over ? '按 R 重新开始' : '按 P 继续', BOARD_W / 2, BOARD_H / 2 + 16);
    }

    drawNext();
  }

  function drawNext() {
    const size = NEXT_CELL * 4;
    nctx.clearRect(0, 0, size, size);
    if (!nextPiece) return;
    const m = SHAPES[nextPiece];
    let minI = 9, maxI = -1, minJ = 9, maxJ = -1;
    eachCell(m, function (i, j) {
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
    });
    const ox = (size - (maxJ - minJ + 1) * NEXT_CELL) / 2 - minJ * NEXT_CELL;
    const oy = (size - (maxI - minI + 1) * NEXT_CELL) / 2 - minI * NEXT_CELL;
    eachCell(m, function (i, j) {
      drawCell(nctx, ox + j * NEXT_CELL, oy + i * NEXT_CELL, NEXT_CELL, COLORS[nextPiece], 1);
    });
  }

  function renderHud() {
    el.score.textContent = String(score);
    el.best.textContent = String(best);
    el.lines.textContent = String(lines);
    el.level.textContent = String(level);
  }

  /* ---------- 主循环 ---------- */
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(t - last, 100) : 0;
    last = t;
    if (!over && !paused) {
      acc += dt;
      const interval = dropInterval();
      while (acc >= interval) {
        acc -= interval;
        step();
        if (over) break;
      }
    }
    draw();
  }

  /* ---------- 输入 ---------- */
  window.addEventListener('keydown', function (e) {
    if (HANDLED.indexOf(e.key) === -1) return;
    e.preventDefault();
    handleKey(e.key);
  }, { passive: false });

  function focusStage() {
    try { el.stage.focus({ preventScroll: true }); } catch (e) { el.stage.focus(); }
  }

  el.board.addEventListener('pointerdown', focusStage);
  el.stage.addEventListener('pointerdown', focusStage);

  el.restart.addEventListener('click', function () {
    restart();
    focusStage();
  });
  el.pause.addEventListener('click', function () {
    togglePause();
    draw();
    focusStage();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.pad-btn'), function (btn) {
    const key = btn.getAttribute('data-key');
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      handleKey(key);
      btn.classList.add('is-down');
      focusStage();
    });
    const release = function () { btn.classList.remove('is-down'); };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  /* ---------- 测试钩子 ---------- */
  window.__game = {
    snapshot: function () {
      return {
        score: score,
        best: best,
        over: over,
        paused: paused,
        lines: lines,
        level: level,
        seed: seed,
        board: board.map(function (r) { return r.slice(); }),
        next: nextPiece,
        current: current ? {
          type: current.type,
          id: current.id,
          x: current.x,
          y: current.y,
          cells: current.cells.map(function (r) { return r.slice(); })
        } : null
      };
    },
    restart: restart,
    press: function (key) { handleKey(key); },
    setSeed: function (n) {
      seed = (Number(n) || 0) >>> 0;
      rng = mulberry32(seed);
    },
    setBoard: function (rows) {
      const src = Array.isArray(rows) ? rows : [];
      const next = emptyBoard();
      for (let y = 0; y < ROWS; y++) {
        const row = src[y];
        if (!row) continue;
        for (let x = 0; x < COLS; x++) {
          const raw = typeof row === 'string' ? row.charAt(x) : row[x];
          const v = (raw === '.' || raw === undefined || raw === null || raw === '') ? 0 : Number(raw);
          if (v >= 1 && v <= 7) next[y][x] = v;
        }
      }
      board = next;
      over = false;
      paused = false;
      draw();
      return board.map(function (r) { return r.slice(); });
    }
  };

  /* ---------- 启动 ---------- */
  el.best.textContent = String(best);
  restart();
  focusStage();
  requestAnimationFrame(frame);
})();
