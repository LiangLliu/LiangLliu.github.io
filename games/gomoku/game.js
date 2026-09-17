'use strict';

// 五子棋：玩家执黑先行，点击 / 触摸落子；AI 执白，按「成五 / 活四 / 冲四 / 活三 / 活二」启发式评分选点。
(function () {
  const SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1; // 玩家
  const WHITE = 2; // AI
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const BEST_KEY = 'games.gomoku.best';
  const AI_DELAY = 120; // 稍微延迟，让玩家先看到自己的落子
  const CENTER = 7;

  // ---- 可播种 PRNG（mulberry32）：AI 同分时用它随机挑点 ----
  let seed = 20260917;
  let rngState = seed >>> 0;
  function rand() {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  }

  // ---- DOM ----
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const app = document.getElementById('app');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const statusEl = document.getElementById('status');
  const undoBtn = document.getElementById('undo');

  // ---- 状态 ----
  let board = [];
  let bestScore = 0;
  let timer = 0;
  const state = {
    turn: 'player',
    over: false,
    winner: null,
    moves: 0,
    score: 0,
    last: null,
    winLine: null,
    thinking: false,
    history: [],
    cursor: { x: CENTER, y: CENTER },
    showCursor: true,
    hover: null,
  };

  try {
    bestScore = Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch (e) {
    bestScore = 0; // file:// 或隐私模式下不可用，退化为内存记录
  }
  function saveBest() {
    try {
      localStorage.setItem(BEST_KEY, String(bestScore));
    } catch (e) { /* 忽略，内存里已经记着 */ }
  }

  function inside(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

  // ---- 规则 ----
  function winLineAt(x, y, color) {
    for (let d = 0; d < DIRS.length; d++) {
      const dx = DIRS[d][0];
      const dy = DIRS[d][1];
      const cells = [[x, y]];
      let nx = x + dx;
      let ny = y + dy;
      while (inside(nx, ny) && board[ny][nx] === color) { cells.push([nx, ny]); nx += dx; ny += dy; }
      nx = x - dx;
      ny = y - dy;
      while (inside(nx, ny) && board[ny][nx] === color) { cells.unshift([nx, ny]); nx -= dx; ny -= dy; }
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  function placeStone(x, y, color) {
    board[y][x] = color;
    state.moves += 1;
    state.last = { x: x, y: y, color: color };
    state.history.push({ x: x, y: y, color: color });
    if (color === BLACK) {
      state.score += 1;
      if (state.score > bestScore) { bestScore = state.score; saveBest(); }
    }
    const line = winLineAt(x, y, color);
    if (line) {
      state.over = true;
      state.winner = color === BLACK ? 'player' : 'ai';
      state.winLine = line;
    } else if (state.moves >= SIZE * SIZE) {
      state.over = true;
      state.winner = 'draw';
    }
  }

  function playerMove(x, y) {
    if (state.over || state.thinking || state.turn !== 'player') return false;
    if (!inside(x, y) || board[y][x] !== EMPTY) return false;
    placeStone(x, y, BLACK);
    if (!state.over) {
      state.turn = 'ai';
      state.thinking = true;
      timer = setTimeout(aiMove, AI_DELAY);
    }
    render();
    return true;
  }

  function aiMove() {
    timer = 0;
    if (state.over || state.turn !== 'ai') { state.thinking = false; render(); return; }
    const spot = aiChoose();
    state.thinking = false;
    state.turn = 'player';
    if (spot) placeStone(spot.x, spot.y, WHITE);
    render();
  }

  // ---- 悔棋：撤销一回合（玩家 + AI 各一手）----
  function undo() {
    if (timer) { clearTimeout(timer); timer = 0; }
    state.thinking = false;
    let removed = 0;
    while (state.history.length && removed < 2) {
      const m = state.history.pop();
      board[m.y][m.x] = EMPTY;
      removed += 1;
      if (m.color === BLACK) break;
    }
    if (!removed) return false;
    state.over = false;
    state.winner = null;
    state.winLine = null;
    state.turn = 'player';
    state.moves = state.history.length;
    state.score = 0;
    for (let i = 0; i < state.history.length; i++) {
      if (state.history[i].color === BLACK) state.score += 1;
    }
    state.last = state.history.length ? state.history[state.history.length - 1] : null;
    render();
    return true;
  }

  function restart() {
    if (timer) { clearTimeout(timer); timer = 0; }
    board = [];
    for (let y = 0; y < SIZE; y++) board.push(new Array(SIZE).fill(EMPTY));
    state.turn = 'player';
    state.over = false;
    state.winner = null;
    state.moves = 0;
    state.score = 0;
    state.last = null;
    state.winLine = null;
    state.thinking = false;
    state.history = [];
    state.cursor = { x: CENTER, y: CENTER };
    state.hover = null;
    rngState = seed >>> 0;
    render();
  }

  // ---- AI：对每个候选空点按形状打分，取最高；同分由 PRNG 打乱后取先出现的 ----
  function shapeScore(count, open) {
    if (count >= 5) return 10000000;                       // 成五
    if (open === 0) return 0;
    if (count === 4) return open === 2 ? 1000000 : 100000; // 活四 / 冲四
    if (count === 3) return open === 2 ? 10000 : 1000;     // 活三 / 眠三
    if (count === 2) return open === 2 ? 800 : 80;         // 活二 / 眠二
    return open === 2 ? 60 : 6;                            // 单子
  }

  function evalPoint(x, y, color) {
    let total = 0;
    for (let d = 0; d < DIRS.length; d++) {
      const dx = DIRS[d][0];
      const dy = DIRS[d][1];
      let count = 1; // 假设候选点已经落子
      let open = 0;
      let nx = x + dx;
      let ny = y + dy;
      while (inside(nx, ny) && board[ny][nx] === color) { count += 1; nx += dx; ny += dy; }
      if (inside(nx, ny) && board[ny][nx] === EMPTY) open += 1;
      nx = x - dx;
      ny = y - dy;
      while (inside(nx, ny) && board[ny][nx] === color) { count += 1; nx -= dx; ny -= dy; }
      if (inside(nx, ny) && board[ny][nx] === EMPTY) open += 1;
      total += shapeScore(count, open);
    }
    return total;
  }

  function candidateCells() {
    const near = [];
    for (let y = 0; y < SIZE; y++) near.push(new Array(SIZE).fill(false));
    let stones = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!board[y][x]) continue;
        stones += 1;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (inside(nx, ny) && !board[ny][nx]) near[ny][nx] = true;
          }
        }
      }
    }
    const list = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (near[y][x]) list.push({ x: x, y: y });
      }
    }
    if (!list.length && !stones) list.push({ x: CENTER, y: CENTER });
    return list;
  }

  function aiChoose() {
    const list = shuffle(candidateCells());
    let best = null;
    let bestVal = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const val = evalPoint(c.x, c.y, WHITE) + evalPoint(c.x, c.y, BLACK) * 0.9;
      if (val > bestVal) { bestVal = val; best = c; }
    }
    return best;
  }

  // ---- 绘制 ----
  function drawStone(x, y, color, alpha) {
    const cell = canvas.width / SIZE;
    const px = cell / 2 + x * cell;
    const py = cell / 2 + y * cell;
    const r = cell * 0.42;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    if (color === BLACK) {
      ctx.fillStyle = '#0c0e12';
      ctx.fill();
      ctx.lineWidth = Math.max(1, cell * 0.035);
      ctx.strokeStyle = 'rgba(230,232,235,0.35)';
      ctx.stroke();
    } else {
      ctx.fillStyle = '#e6e8eb';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    const w = canvas.width;
    const cell = w / SIZE;
    const half = cell / 2;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#20242c';
    ctx.fillRect(0, 0, w, w);

    ctx.beginPath();
    for (let i = 0; i < SIZE; i++) {
      const p = half + i * cell;
      ctx.moveTo(half, p);
      ctx.lineTo(w - half, p);
      ctx.moveTo(p, half);
      ctx.lineTo(p, w - half);
    }
    ctx.lineWidth = Math.max(1, cell * 0.025);
    ctx.strokeStyle = 'rgba(154,164,178,0.32)';
    ctx.stroke();

    const stars = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
    ctx.fillStyle = 'rgba(154,164,178,0.75)';
    for (let i = 0; i < stars.length; i++) {
      ctx.beginPath();
      ctx.arc(half + stars[i][0] * cell, half + stars[i][1] * cell, Math.max(1.5, cell * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }

    const hover = state.hover;
    if (hover && !state.over && !state.thinking && state.turn === 'player' && board[hover.y][hover.x] === EMPTY) {
      drawStone(hover.x, hover.y, BLACK, 0.35);
    }

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[y][x]) drawStone(x, y, board[y][x], 1);
      }
    }

    if (state.last) {
      ctx.beginPath();
      ctx.arc(half + state.last.x * cell, half + state.last.y * cell, Math.max(2, cell * 0.11), 0, Math.PI * 2);
      ctx.fillStyle = '#49b1f5';
      ctx.fill();
    }

    if (state.winLine && state.winLine.length > 1) {
      const a = state.winLine[0];
      const b = state.winLine[state.winLine.length - 1];
      ctx.beginPath();
      ctx.moveTo(half + a[0] * cell, half + a[1] * cell);
      ctx.lineTo(half + b[0] * cell, half + b[1] * cell);
      ctx.lineWidth = Math.max(2, cell * 0.13);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(73,177,245,0.85)';
      ctx.stroke();
    }

    if (state.showCursor && !state.over) {
      ctx.strokeStyle = 'rgba(73,177,245,0.9)';
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.strokeRect(half + state.cursor.x * cell - cell / 2 + 2,
                     half + state.cursor.y * cell - cell / 2 + 2,
                     cell - 4, cell - 4);
    }
  }

  function render() {
    draw();
    scoreEl.textContent = String(state.score);
    bestEl.textContent = String(bestScore);
    statusEl.textContent = statusText();
    statusEl.classList.toggle('over', state.over);
    undoBtn.disabled = state.history.length === 0;
  }

  function statusText() {
    if (state.over) {
      if (state.winner === 'player') return '你赢了';
      if (state.winner === 'ai') return 'AI 赢了';
      return '平局';
    }
    return state.thinking ? 'AI 思考中…' : '轮到你落子（黑）';
  }

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = canvas.clientWidth || 320;
    const px = Math.max(150, Math.round(cssW * dpr));
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    draw();
  }

  // ---- 输入 ----
  function cellFromPointer(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * SIZE);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * SIZE);
    return inside(x, y) ? { x: x, y: y } : null;
  }

  function onPointerDown(e) {
    e.preventDefault();
    app.focus();
    state.showCursor = false;
    state.hover = null;
    const c = cellFromPointer(e);
    if (c) {
      state.cursor.x = c.x;
      state.cursor.y = c.y;
      playerMove(c.x, c.y);
    } else {
      draw();
    }
  }

  function onPointerMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const c = cellFromPointer(e);
    const cur = state.hover;
    if ((!c && !cur) || (c && cur && c.x === cur.x && c.y === cur.y)) return;
    state.hover = c;
    draw();
  }

  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const KEYS = { r: 1, R: 1, u: 1, U: 1, Enter: 1, ' ': 1 };

  function handleKey(key) {
    if (key === 'r' || key === 'R') { restart(); return; }
    if (key === 'u' || key === 'U') { undo(); return; }
    const dir = ARROWS[key];
    if (dir) {
      state.showCursor = true;
      state.hover = null;
      state.cursor.x = Math.min(SIZE - 1, Math.max(0, state.cursor.x + dir[0]));
      state.cursor.y = Math.min(SIZE - 1, Math.max(0, state.cursor.y + dir[1]));
      draw();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      state.showCursor = true;
      playerMove(state.cursor.x, state.cursor.y);
    }
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (ARROWS[e.key] || KEYS[e.key]) e.preventDefault();
    handleKey(e.key);
  }

  // ---- 测试钩子 ----
  function snapshot() {
    return {
      score: state.score,
      over: state.over,
      winner: state.winner,
      turn: state.turn,
      moves: state.moves,
      board: board.map(function (row) { return row.slice(); }),
      last: state.last ? { x: state.last.x, y: state.last.y, color: state.last.color } : null,
      winLine: state.winLine ? state.winLine.map(function (c) { return [c[0], c[1]]; }) : null,
      thinking: state.thinking,
      cursor: { x: state.cursor.x, y: state.cursor.y },
    };
  }

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: function (key) { handleKey(String(key)); },
    setSeed: function (n) { seed = Number(n) >>> 0; rngState = seed; },
  };

  document.getElementById('restart').addEventListener('click', function () { restart(); app.focus(); });
  undoBtn.addEventListener('click', function () { undo(); app.focus(); });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', function () {
    if (state.hover) { state.hover = null; draw(); }
  });
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', fit);

  restart();
  fit();
  app.focus();
})();
