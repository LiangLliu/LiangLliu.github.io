/* 五子棋 · 零依赖离线小游戏 */
(function () {
  'use strict';

  const SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1; // 玩家
  const WHITE = 2; // AI
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const STARS = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  const BEST_KEY = 'games.gomoku.best';
  const CENTER = 7;
  const NEAR = 2;         // 候选点：距已有棋子的切比雪夫距离 ≤ 2
  const AI_DELAY = 200;   // 让「AI 思考中…」看得见
  const POP_MS = 260;     // 落子缩放动画
  const WIN_MS = 420;     // 五连描线生长
  const OVERLAY_MS = 620; // 先看连珠，再弹结果浮层
  const TAP_TOL = 12;     // 触屏落子的位移容错（CSS px）
  const S = SIZE * SIZE;

  /* ---------- 可播种 PRNG（mulberry32）：AI 同分时用它挑点 ---------- */
  /* 默认种子每次加载 / 每局都换，避免"刷新、重开都是同一局"；
     调过 setSeed() 之后固定下来，方便复现整局。 */
  function newSeed() { return (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0 || 1; }
  let seed = newSeed();
  let autoSeed = true;
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

  /* ---------- DOM ---------- */
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const floatEl = document.getElementById('float');
  const statusEl = document.getElementById('status');
  const undoBtn = document.getElementById('undo');
  const overlayEl = document.getElementById('overlay');
  const overlayEmojiEl = document.getElementById('overlayEmoji');
  const overlayTitleEl = document.getElementById('overlayTitle');
  const overlaySubEl = document.getElementById('overlaySub');

  /* ---------- 状态 ---------- */
  function newBoard() {
    const b = [];
    for (let y = 0; y < SIZE; y++) b.push(new Array(SIZE).fill(EMPTY));
    return b;
  }
  let board = newBoard();
  let bestScore = 0;
  let aiTimer = 0;
  let overTimer = 0;
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

  let memBest = 0;
  function readBest() {
    try {
      const v = Number(localStorage.getItem(BEST_KEY));
      return v > 0 ? v : 0;
    } catch (e) {
      return memBest; // 隐私模式 / file:// 下退化为内存值
    }
  }
  function writeBest(v) {
    memBest = v;
    try {
      localStorage.setItem(BEST_KEY, String(v));
    } catch (e) { /* 忽略：内存里已经记着 */ }
  }
  bestScore = readBest();

  function inside(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

  /* ---------- 规则 ---------- */
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
    pops.set(y * SIZE + x, performance.now());
    if (color === BLACK) {
      state.score += 1;
      if (state.score > bestScore) { bestScore = state.score; writeBest(bestScore); }
    }
    const line = winLineAt(x, y, color);
    if (line) {
      state.over = true;
      state.winner = color === BLACK ? 'player' : 'ai';
      state.winLine = line;
      winT0 = performance.now();
    } else if (state.moves >= S) {
      state.over = true;
      state.winner = 'draw';
    }
  }

  function playerMove(x, y) {
    if (state.over || state.thinking || state.turn !== 'player') return false;
    if (!inside(x, y) || board[y][x] !== EMPTY) return false;
    placeStone(x, y, BLACK);
    floatScore();
    if (!state.over) {
      state.turn = 'ai';
      state.thinking = true;
      aiTimer = setTimeout(aiMove, AI_DELAY);
    } else {
      endScreen();
    }
    render();
    return true;
  }

  function aiMove() {
    aiTimer = 0;
    if (state.over || state.turn !== 'ai') { state.thinking = false; render(); return; }
    const spot = aiChoose();
    state.thinking = false;
    state.turn = 'player';
    if (spot && board[spot.y][spot.x] === EMPTY) placeStone(spot.x, spot.y, WHITE);
    if (state.over) endScreen();
    render();
  }

  /* ---------- 悔棋：一次撤回 AI 与玩家各一手，并恢复状态 ---------- */
  function undo() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = 0; }
    state.thinking = false;
    let removed = 0;
    while (state.history.length && removed < 2) {
      const m = state.history.pop();
      board[m.y][m.x] = EMPTY;
      pops.delete(m.y * SIZE + m.x);
      removed += 1;
      if (m.color === BLACK) break; // 撤到玩家自己那手为止
    }
    if (!removed) return false;
    state.over = false;
    state.winner = null;
    state.winLine = null;
    winT0 = 0;
    state.turn = 'player';
    state.moves = state.history.length;
    state.score = 0;
    for (let i = 0; i < state.history.length; i++) {
      if (state.history[i].color === BLACK) state.score += 1;
    }
    state.last = state.history.length ? state.history[state.history.length - 1] : null;
    hideOverlay();
    render();
    return true;
  }

  function restart() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = 0; }
    hideOverlay();
    board = newBoard();
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
    state.showCursor = true;
    state.hover = null;
    pops.clear();
    winT0 = 0;
    if (autoSeed) seed = newSeed();   // 每局换一副牌；setSeed() 之后不再自动换
    rngState = seed >>> 0;
    render();
  }

  /* ---------- AI ----------
   * 先按威胁优先级扫一遍（成五 → 堵五 → 活四 → 堵四 → 活三 → 堵三），
   * 都没命中再对候选点做形状评分；候选点只取已有棋子周围 2 格内的空点。
   * analyze() 同时也是「双威胁」检测：一手同时造出两个四 / 四 + 活三 / 两个活三时大幅加分。
   */
  function analyze(x, y, color) {
    const foe = color === BLACK ? WHITE : BLACK;
    let score = 0;
    let five = false;
    let openFour = 0;
    let four = 0;
    let openThree = 0;

    // 连续连子 + 活端
    for (let d = 0; d < DIRS.length; d++) {
      const dx = DIRS[d][0];
      const dy = DIRS[d][1];
      let n = 1;
      let open = 0;
      let nx = x + dx;
      let ny = y + dy;
      while (inside(nx, ny) && board[ny][nx] === color) { n += 1; nx += dx; ny += dy; }
      if (inside(nx, ny) && board[ny][nx] === EMPTY) open += 1;
      nx = x - dx;
      ny = y - dy;
      while (inside(nx, ny) && board[ny][nx] === color) { n += 1; nx -= dx; ny -= dy; }
      if (inside(nx, ny) && board[ny][nx] === EMPTY) open += 1;

      if (n >= 5) { five = true; score += 10000000; }
      else if (n === 4 && open === 2) { openFour += 1; score += 600000; }
      else if (n === 4 && open === 1) { four += 1; score += 60000; }
      else if (n === 3 && open === 2) { openThree += 1; score += 9000; }
      else if (n === 3 && open === 1) { score += 900; }
      else if (n === 2 && open === 2) { score += 420; }
      else if (n === 2 && open === 1) { score += 80; }
      else if (open === 2) { score += 18; }
      else { score += 2; }
    }

    // 带空隙的形状（XX_XX、X_XX_X…）：连续连子数看不到，用 5 格滑窗补一刀
    let ways4 = 0;
    for (let d = 0; d < DIRS.length; d++) {
      const dx = DIRS[d][0];
      const dy = DIRS[d][1];
      for (let s = -4; s <= 0; s++) {
        let mine = 0;
        let ok = true;
        for (let k = 0; k < 5; k++) {
          const px = x + (s + k) * dx;
          const py = y + (s + k) * dy;
          if (!inside(px, py)) { ok = false; break; }
          const v = board[py][px];
          if (v === foe) { ok = false; break; }
          if (v === color || (px === x && py === y)) mine += 1;
        }
        if (!ok) continue;
        if (mine === 4) { ways4 += 1; score += 2600; }
        else if (mine === 3) score += 260;
        else if (mine === 2) score += 24;
      }
    }

    // 双威胁：两个方向同时成威胁 → 对手只能堵一边
    const threats4 = four + openFour * 2 + (ways4 >= 2 ? 1 : 0);
    const threats3 = openThree;
    let doubleThreat = 0;
    if (threats4 >= 2 || (threats4 >= 1 && threats3 >= 1) || threats3 >= 2) {
      doubleThreat = threats4 + threats3;
      score += 400000 * doubleThreat;
    }

    return {
      five: five,
      openFour: openFour > 0,
      four: four > 0 || openFour > 0,
      openThree: openThree > 0,
      double: doubleThreat,
      score: score,
    };
  }

  function candidateCells() {
    const near = [];
    for (let y = 0; y < SIZE; y++) near.push(new Array(SIZE).fill(false));
    let stones = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!board[y][x]) continue;
        stones += 1;
        const y0 = Math.max(0, y - NEAR);
        const y1 = Math.min(SIZE - 1, y + NEAR);
        const x0 = Math.max(0, x - NEAR);
        const x1 = Math.min(SIZE - 1, x + NEAR);
        for (let ny = y0; ny <= y1; ny++) {
          for (let nx = x0; nx <= x1; nx++) near[ny][nx] = true;
        }
      }
    }
    const list = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (near[y][x] && !board[y][x]) list.push({ x: x, y: y });
      }
    }
    if (!stones) list.push({ x: CENTER, y: CENTER });
    return list;
  }

  function aiChoose() {
    const cands = shuffle(candidateCells());
    const mine = [];
    const foe = [];
    for (let i = 0; i < cands.length; i++) {
      mine.push(analyze(cands[i].x, cands[i].y, WHITE));
      foe.push(analyze(cands[i].x, cands[i].y, BLACK));
    }
    // 同分取先出现的候选点；cands 已被 PRNG 打乱，所以整局可复现
    function pick(ok, weigh) {
      let best = null;
      let bestV = -1;
      for (let i = 0; i < cands.length; i++) {
        if (!ok(mine[i], foe[i])) continue;
        const v = weigh(mine[i], foe[i]);
        if (v > bestV) { bestV = v; best = cands[i]; }
      }
      return best;
    }
    return (
      pick(function (a) { return a.five; }, function (a) { return a.score; }) ||                                  // 1 自己能成五
      pick(function (a, b) { return b.five; }, function (a, b) { return b.score + a.score; }) ||                  // 2 对手能成五 → 必堵
      pick(function (a) { return a.openFour; }, function (a) { return a.score + a.double * 1e6; }) ||            // 3 自己活四
      pick(function (a, b) { return b.four; }, function (a, b) { return b.score + (b.openFour ? 1e6 : 0); }) ||   // 4 对手活四 / 冲四 → 必堵
      pick(function (a) { return a.openThree; }, function (a) { return a.score + a.double * 1e6; }) ||           // 5 自己活三
      pick(function (a, b) { return b.openThree; }, function (a, b) { return b.score + b.double * 1e6; }) ||     // 6 对手活三 → 堵
      pick(function () { return true; }, function (a, b) { return a.score + b.score * 0.85; })                    // 7 综合评分
    );
  }

  /* ---------- 画布：奶油底 + 灰格线，棋子用离屏精灵（径向高光） ---------- */
  const PAPER = '#f8ffe5';          // --cell
  const GRID = 'rgba(154,154,149,0.62)';
  const STAR = 'rgba(154,154,149,0.8)';
  const MARK = '#ef476f';           // --c2：最后一手 / 五连
  const CURSOR = '#1b9aaa';         // --c3

  let cellPx = 0;
  let sprBlack = null;
  let sprWhite = null;
  const pops = new Map(); // 落子缩放：key = y*SIZE+x → 起始时间
  let winT0 = 0;
  let raf = 0;

  function makeSprite(color) {
    const r = cellPx * 0.42;
    const size = Math.max(4, Math.ceil(r * 2 + 4));
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    const c = size / 2;
    const grad = g.createRadialGradient(c - r * 0.36, c - r * 0.4, r * 0.08, c, c, r * 1.06);
    if (color === BLACK) {
      grad.addColorStop(0, '#7d7d76');
      grad.addColorStop(0.4, '#4b4b47');
      grad.addColorStop(1, '#2f2f2c');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, '#fffdf2');
      grad.addColorStop(1, '#d9d4bf');
    }
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    if (color === WHITE) {
      g.lineWidth = Math.max(1, r * 0.1);
      g.strokeStyle = 'rgba(154,154,149,0.8)';
      g.stroke();
    }
    return cv;
  }

  function buildSprites() {
    cellPx = canvas.width / SIZE;
    sprBlack = makeSprite(BLACK);
    sprWhite = makeSprite(WHITE);
  }

  function drawStone(x, y, color, alpha, scale) {
    const spr = color === BLACK ? sprBlack : sprWhite;
    const s = (spr.width * (scale === undefined ? 1 : scale));
    const px = cellPx / 2 + x * cellPx;
    const py = cellPx / 2 + y * cellPx;
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.drawImage(spr, px - s / 2, py - s / 2, s, s);
    if (alpha !== undefined) ctx.globalAlpha = 1;
  }

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const k = t - 1;
    return 1 + c3 * k * k * k + c1 * k * k;
  }

  function draw(now) {
    if (!sprBlack) buildSprites();
    if (now === undefined) now = performance.now();
    const w = canvas.width;
    const half = cellPx / 2;

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, w);

    const lw = Math.max(1, Math.round(cellPx * 0.03));
    const off = lw % 2 ? 0.5 : 0;
    ctx.beginPath();
    for (let i = 0; i < SIZE; i++) {
      const p = Math.round(half + i * cellPx) + off;
      ctx.moveTo(Math.round(half) + off, p);
      ctx.lineTo(Math.round(w - half) + off, p);
      ctx.moveTo(p, Math.round(half) + off);
      ctx.lineTo(p, Math.round(w - half) + off);
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = GRID;
    ctx.stroke();

    const starR = Math.max(1.5, cellPx * 0.075);
    ctx.fillStyle = STAR;
    for (let i = 0; i < STARS.length; i++) {
      ctx.beginPath();
      ctx.arc(half + STARS[i][0] * cellPx, half + STARS[i][1] * cellPx, starR, 0, Math.PI * 2);
      ctx.fill();
    }

    const hover = state.hover;
    if (hover && !state.over && !state.thinking && state.turn === 'player' && board[hover.y][hover.x] === EMPTY) {
      drawStone(hover.x, hover.y, BLACK, 0.3, 1);
    }

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const color = board[y][x];
        if (!color) continue;
        const t0 = pops.get(y * SIZE + x);
        let scale = 1;
        if (t0 !== undefined) {
          const k = (now - t0) / POP_MS;
          if (k < 1) scale = 0.6 + 0.4 * easeOutBack(k > 0 ? k : 0);
        }
        drawStone(x, y, color, undefined, scale);
      }
    }

    if (state.last) {
      ctx.beginPath();
      ctx.arc(half + state.last.x * cellPx, half + state.last.y * cellPx, Math.max(2, cellPx * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = MARK;
      ctx.fill();
    }

    if (state.winLine && state.winLine.length > 1) {
      const a = state.winLine[0];
      const b = state.winLine[state.winLine.length - 1];
      const x0 = half + a[0] * cellPx;
      const y0 = half + a[1] * cellPx;
      const grow = winT0 ? Math.min(1, (now - winT0) / WIN_MS) : 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + (half + b[0] * cellPx - x0) * grow, y0 + (half + b[1] * cellPx - y0) * grow);
      ctx.lineWidth = Math.max(2, cellPx * 0.13);
      ctx.lineCap = 'round';
      ctx.strokeStyle = MARK;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (state.showCursor && !state.over) {
      const cx = half + state.cursor.x * cellPx;
      const cy = half + state.cursor.y * cellPx;
      const r = cellPx * 0.44;
      ctx.lineWidth = Math.max(1.5, cellPx * 0.055);
      ctx.strokeStyle = CURSOR;
      ctx.globalAlpha = 0.85;
      ctx.strokeRect(Math.round(cx - r) + 0.5, Math.round(cy - r) + 0.5, Math.round(r * 2) - 1, Math.round(r * 2) - 1);
      ctx.globalAlpha = 1;
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(animate);
  }

  function animate(now) {
    raf = 0;
    let alive = false;
    pops.forEach(function (t0, key) {
      if (now - t0 >= POP_MS) pops.delete(key);
      else alive = true;
    });
    if (winT0) {
      if (now - winT0 >= WIN_MS) winT0 = 0;
      else alive = true;
    }
    draw(now);
    if (alive) schedule();
  }

  function render() {
    scoreEl.textContent = String(state.score);
    bestEl.textContent = String(bestScore);
    statusEl.textContent = statusText();
    statusEl.classList.toggle('busy', state.thinking);
    undoBtn.disabled = state.history.length === 0;
    draw();
    if (pops.size || winT0) schedule();
  }

  function statusText() {
    if (state.over) {
      if (state.winner === 'player') return '你赢了';
      if (state.winner === 'ai') return 'AI 赢了';
      return '平局';
    }
    return state.thinking ? 'AI 思考中…' : '轮到你（黑）';
  }

  function floatScore() {
    floatEl.textContent = '+1';
    floatEl.classList.remove('on');
    void floatEl.offsetWidth; // 重排一次，让动画能重播
    floatEl.classList.add('on');
  }

  function showOverlay(emoji, title, sub) {
    overlayEmojiEl.textContent = emoji;
    overlayTitleEl.textContent = title;
    overlaySubEl.textContent = sub;
    overlayEl.classList.add('on');
  }

  function hideOverlay() {
    if (overTimer) { clearTimeout(overTimer); overTimer = 0; }
    overlayEl.classList.remove('on');
  }

  function endScreen() {
    if (overTimer) clearTimeout(overTimer);
    overTimer = setTimeout(function () {
      overTimer = 0;
      const hands = '你下了 ' + state.score + ' 手';
      if (state.winner === 'player') showOverlay('🎉', '你赢了', hands);
      else if (state.winner === 'ai') showOverlay('🤖', 'AI 赢了', hands);
      else showOverlay('🤝', '平局', '棋盘满了，' + hands);
    }, OVERLAY_MS);
  }

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 320;
    const px = Math.max(180, Math.round(cssW * dpr));
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
      buildSprites();
    }
    draw();
    if (pops.size || winT0) schedule();
  }

  /* ---------- 输入 ---------- */
  function cellFromPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * SIZE);
    const y = Math.floor(((clientY - rect.top) / rect.height) * SIZE);
    return inside(x, y) ? { x: x, y: y } : null;
  }

  let tap = null; // 按下时的位置，抬手时位移小于 TAP_TOL 才算落子

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tap = { id: e.pointerId, x: e.clientX, y: e.clientY, cell: cellFromPoint(e.clientX, e.clientY) };
  }

  function onPointerUp(e) {
    const t = tap;
    tap = null;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_TOL) return; // 拖过头当成滑动，不落子
    state.showCursor = false;
    state.hover = null;
    const c = t.cell || cellFromPoint(e.clientX, e.clientY);
    if (!c) { draw(); return; }
    state.cursor.x = c.x;
    state.cursor.y = c.y;
    if (!playerMove(c.x, c.y)) draw();
  }

  function onPointerMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const c = cellFromPoint(e.clientX, e.clientY);
    const cur = state.hover;
    if ((!c && !cur) || (c && cur && c.x === cur.x && c.y === cur.y)) return;
    state.hover = c;
    draw();
  }

  const ARROWS = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1], A: [-1, 0], D: [1, 0], W: [0, -1], S: [0, 1],
  };

  function handleKey(key) {
    if (typeof key !== 'string' || !key) return false;
    if (key === 'r' || key === 'R') { restart(); return true; }
    if (key === 'u' || key === 'U') { return undo(); }
    const dir = ARROWS[key];
    if (dir) {
      state.showCursor = true;
      state.hover = null;
      const nx = state.cursor.x + dir[0];
      const ny = state.cursor.y + dir[1];
      state.cursor.x = nx < 0 ? 0 : nx > SIZE - 1 ? SIZE - 1 : nx;
      state.cursor.y = ny < 0 ? 0 : ny > SIZE - 1 ? SIZE - 1 : ny;
      draw();
      return true;
    }
    if (key === 'Enter' || key === ' ') {
      state.showCursor = true;
      state.hover = null;
      const ok = playerMove(state.cursor.x, state.cursor.y);
      if (!ok) draw();
      return ok;
    }
    return false;
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const tg = e.target;
    const isUi = !!tg && (tg.tagName === 'BUTTON' || tg.tagName === 'SELECT' || tg.tagName === 'INPUT');
    /* 空格在本作里只有一个含义：在光标处落子。焦点若停在按钮上，浏览器会把空格
       当成"激活这个按钮"（点过「重新开始」之后再按空格就会重开一局），这里先截住并移走焦点；
       回车则相反，让给按钮自己 —— 否则按钮没法用键盘激活。 */
    if (isUi && (k === ' ' || k === 'Spacebar')) {
      e.preventDefault();
      if (tg.blur) tg.blur();
    } else if (isUi && k === 'Enter') {
      return;
    } else if (isUi && tg.blur) {
      tg.blur();  // 方向键等游戏按键：焦点还给棋盘，别让后续空格/回车被按钮截走
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' ||
        k === ' ' || k === 'Spacebar' || k === 'Enter') {
      e.preventDefault(); // 别让页面跟着滚
    }
    handleKey(k);
  }

  /* ---------- 测试钩子 ---------- */
  /* 直接摆子构造局面：不走回合与胜负判定；turn === 'ai' 时按正常节奏让 AI 落子 */
  function hookSetBoard(cells, turn) {
    restart();
    for (let i = 0; cells && i < cells.length; i++) {
      const c = cells[i];
      if (!c || !inside(c[0], c[1]) || (c[2] !== BLACK && c[2] !== WHITE)) continue;
      board[c[1]][c[0]] = c[2];
      state.history.push({ x: c[0], y: c[1], color: c[2] });
    }
    state.moves = state.history.length;
    state.score = 0;
    for (let j = 0; j < state.history.length; j++) {
      if (state.history[j].color === BLACK) state.score += 1;
    }
    state.turn = turn === 'ai' ? 'ai' : 'player';
    if (state.turn === 'ai') {
      state.thinking = true;
      aiTimer = setTimeout(aiMove, AI_DELAY);
    }
    render();
    return snapshot().board;
  }

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
    press: function (key) { return handleKey(String(key)); },
    setSeed: function (n) { seed = Number(n) >>> 0; rngState = seed; autoSeed = false; },
    /* —— 扩展钩子：构造局面 / 只问 AI 怎么选（不落子） —— */
    setBoard: hookSetBoard,
    aiPick: function () { const s = aiChoose(); return s ? { x: s.x, y: s.y } : null; },
  };

  document.getElementById('restart').addEventListener('click', restart);
  undoBtn.addEventListener('click', undo);
  document.getElementById('padRestart').addEventListener('click', restart);
  document.getElementById('padUndo').addEventListener('click', undo);
  document.getElementById('again').addEventListener('click', restart);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', function () { tap = null; });
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', function () {
    if (state.hover) { state.hover = null; draw(); }
  });
  document.addEventListener('keydown', onKeyDown);
  /* 鼠标点完按钮立刻失焦：否则焦点留在按钮上，之后按空格/回车会被按钮抢走 */
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.tagName === 'BUTTON' && t.blur) setTimeout(function () { t.blur(); }, 0);
  });
  window.addEventListener('resize', fit);

  fit();
  restart();
})();
