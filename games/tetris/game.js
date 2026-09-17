/* 俄罗斯方块 — 零依赖 · 可离线 · 可播种 · 浅色设计系统 */
(function () {
  'use strict';

  const ROWS = 20;
  const COLS = 10;
  const CELL = 22;
  const NEXT_CELL = 13;
  const BOARD_W = COLS * CELL;
  const BOARD_H = ROWS * CELL;
  const NEXT_W = NEXT_CELL * 4;
  const NEXT_H = (NEXT_CELL * 2 + 10) * 3;
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
  /* 强调色家族（--c3 青为主色，其余按 7 种方块各取一色） */
  const COLORS = {
    I: '#1b9aaa', O: '#ffc43d', T: '#f37694', S: '#06d6a0',
    Z: '#ef476f', J: '#22c2d6', L: '#ffd470'
  };
  const ID = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
  const BY_ID = ['', 'I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const KICKS = [0, -1, 1, -2, 2];
  /* 手感参数 */
  const DAS_MS = 160, ARR_MS = 45, SOFT_MS = 45, LOCK_MS = 500, LOCK_RESET_MAX = 15;
  const FLASH_MS = 90, COLLAPSE_FALL = 180, COLLAPSE_STAGGER = 16, LAND_FLASH_MS = 120;
  const HANDLED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Space', 'Spacebar',
    'x', 'X', 'z', 'Z', 'p', 'P', 'r', 'R', 'Enter', 'w', 'W', 'a', 'A', 's', 'S', 'd', 'D'];

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
  const $ = function (id) { return document.getElementById(id); };
  const el = {
    board: $('board'), next: $('next'),
    score: $('score'), best: $('best'), lines: $('lines'), level: $('level'),
    float: $('float'), levelFloat: $('level-float'), combo: $('combo'),
    overlay: $('overlay'), overlayEmoji: $('overlay-emoji'),
    overlayTitle: $('overlay-title'), overlaySub: $('overlay-sub'),
    again: $('again'), restartBtn: $('restart')
  };

  function setupCanvas(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }
  const ctx = setupCanvas(el.board, BOARD_W, BOARD_H);
  const nctx = setupCanvas(el.next, NEXT_W, NEXT_H);

  /* ---------- 状态 ---------- */
  let board = emptyBoard();
  let current = null;
  let bag = [];
  let queue = [];          // 至少保留 3 个待出方块（queue[0] 即下一个）
  let score = 0, lines = 0, level = 1, combo = 0;
  let over = false, paused = false;
  let best = Number(store.getItem(BEST_KEY)) || 0;
  let last = 0;
  let gravAcc = 0, lockAcc = 0, dasAcc = 0, arrAcc = 0, softAcc = 0;
  let landed = false, lockResets = 0;
  let heldDir = 0;
  const keys = { left: false, right: false, down: false };
  let animating = false, clearAnim = null, landFlash = null;

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

  /* ---------- 7-bag 随机器 ---------- */
  function refillBag() {
    bag = TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
  }

  function refillQueue() {
    while (queue.length < 3) {
      if (!bag.length) refillBag();
      queue.push(bag.pop());
    }
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
    refillQueue();
    const type = queue.shift();
    refillQueue();
    const x = type === 'O' ? 4 : 3;
    current = { type: type, id: ID[type], x: x, y: 0, cells: SHAPES[type].map(function (r) { return r.slice(); }) };
    landed = false;
    lockAcc = 0;
    lockResets = 0;
    gravAcc = 0;
    dasAcc = 0;
    arrAcc = 0;
    softAcc = 0;
    if (collide(current.cells, current.x, current.y)) gameOver();
  }

  function updateBest() {
    if (score > best) {
      best = score;
      try { store.setItem(BEST_KEY, String(best)); } catch (e) { /* 忽略写入失败 */ }
    }
  }

  /* ---------- 落地 / 消行 ---------- */
  function touchGround() {
    landed = true;
    lockAcc = 0;
    lockResets = 0;
  }

  function resetLock() {
    if (lockResets < LOCK_RESET_MAX) {
      lockAcc = 0;
      lockResets++;
    }
  }

  function gravityStep() {
    if (!current) return;
    if (!collide(current.cells, current.x, current.y + 1)) {
      current.y++;
      landed = false;
      lockAcc = 0;
      lockResets = 0;
    } else if (!landed) {
      touchGround();
    }
  }

  function doLock() {
    if (!current) return;
    eachCell(current.cells, function (i, j) {
      const y = current.y + i;
      if (y >= 0) board[y][current.x + j] = current.id;
    });
    current = null;
    landed = false;
    lockAcc = 0;
    lockResets = 0;

    const clearedRows = [];
    for (let y = ROWS - 1; y >= 0; y--) {
      let full = true;
      for (let x = 0; x < COLS; x++) {
        if (!board[y][x]) { full = false; break; }
      }
      if (full) clearedRows.push(y);
    }

    if (clearedRows.length === 0) {
      combo = 0;
      updateBest();
      renderHud();
      spawn();
      return;
    }

    /* 记录塌陷动画：每列从上往下，落在已消行上方的格子下坠 shift 格 */
    const clearedSet = new Set(clearedRows);
    const settle = [];
    for (let c = 0; c < COLS; c++) {
      let shift = 0;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (clearedSet.has(r)) { shift++; continue; }
        if (board[r][c]) settle.push({ c: c, from: r, to: r + shift, delay: c * COLLAPSE_STAGGER });
      }
    }

    const gained = LINE_SCORE[clearedRows.length] * level;
    lines += clearedRows.length;
    score += gained;
    const newLevel = Math.floor(lines / 10) + 1;
    const leveled = newLevel !== level;
    level = newLevel;
    combo++;
    updateBest();

    clearAnim = {
      rows: clearedRows, settle: settle, t: 0,
      dur: FLASH_MS + (COLS - 1) * COLLAPSE_STAGGER + COLLAPSE_FALL,
      combo: combo, leveled: leveled, gained: gained
    };
    animating = true;
  }

  function finishClear() {
    const a = clearAnim;
    const sorted = a.rows.slice().sort(function (x, y) { return x - y; });
    for (let i = 0; i < sorted.length; i++) {
      board.splice(sorted[i], 1);
      board.unshift(new Array(COLS).fill(0));
    }
    renderHud();
    showFloat('+' + a.gained);
    if (a.combo >= 2) showCombo(a.combo);
    if (a.leveled) showLevel();
    clearAnim = null;
    animating = false;
    spawn();
  }

  /* ---------- 操作 ---------- */
  function move(dx) {
    if (over || paused || animating || !current) return;
    if (!collide(current.cells, current.x + dx, current.y)) {
      current.x += dx;
      const wasGrounded = landed;
      const nowGrounded = collide(current.cells, current.x, current.y + 1);
      if (nowGrounded && !wasGrounded) touchGround();
      else if (nowGrounded && wasGrounded) resetLock();
      else { landed = false; lockAcc = 0; lockResets = 0; }
    }
  }

  function rotate(dir) {
    if (over || paused || animating || !current) return;
    let cells = current.cells;
    const times = dir > 0 ? 1 : 3;
    for (let k = 0; k < times; k++) cells = rotateCW(cells);
    for (let k = 0; k < KICKS.length; k++) {
      const dx = KICKS[k];
      if (!collide(cells, current.x + dx, current.y)) {
        current.cells = cells;
        current.x += dx;
        const wasGrounded = landed;
        const nowGrounded = collide(current.cells, current.x, current.y + 1);
        if (nowGrounded && !wasGrounded) touchGround();
        else if (nowGrounded && wasGrounded) resetLock();
        else { landed = false; lockAcc = 0; lockResets = 0; }
        return;
      }
    }
  }

  function softDrop() {
    if (over || paused || animating || !current) return;
    if (!collide(current.cells, current.x, current.y + 1)) {
      current.y++;
      score += 1;
      landed = false;
      lockAcc = 0;
      lockResets = 0;
      renderHud();
    } else if (!landed) {
      touchGround();
    }
  }

  function hardDrop() {
    if (over || paused || animating || !current) return;
    let dist = 0;
    while (!collide(current.cells, current.x, current.y + 1)) {
      current.y++;
      dist++;
    }
    score += dist * 2;
    const rows = new Set();
    eachCell(current.cells, function (i, j) {
      const y = current.y + i;
      if (y >= 0) rows.add(y);
    });
    doLock();
    if (!clearAnim) landFlash = { rows: rows, t: 0, dur: LAND_FLASH_MS };
    gravAcc = 0;
  }

  function dropInterval() {
    return Math.max(80, 800 - (level - 1) * 70);
  }

  function gameOver() {
    over = true;
    paused = false;
    updateBest();
    renderHud();
    el.overlayEmoji.textContent = '🙈';
    el.overlayTitle.textContent = '游戏结束';
    el.overlaySub.textContent = '得分 ' + score;
    el.again.textContent = '再试一次';
    el.overlay.classList.add('on');
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    last = 0;
    if (paused) {
      el.overlayEmoji.textContent = '⏸';
      el.overlayTitle.textContent = '已暂停';
      el.overlaySub.textContent = '按 P 或点「继续」回到游戏';
      el.again.textContent = '继续';
      el.overlay.classList.add('on');
    } else {
      el.overlay.classList.remove('on');
    }
  }

  function restart() {
    rng = mulberry32(seed);
    bag = [];
    queue = [];
    board = emptyBoard();
    current = null;
    score = 0;
    lines = 0;
    level = 1;
    combo = 0;
    over = false;
    paused = false;
    animating = false;
    clearAnim = null;
    landFlash = null;
    landed = false;
    lockResets = 0;
    gravAcc = 0;
    lockAcc = 0;
    dasAcc = 0;
    arrAcc = 0;
    softAcc = 0;
    last = 0;
    heldDir = 0;
    keys.left = keys.right = keys.down = false;
    el.overlay.classList.remove('on');
    refillQueue();
    spawn();
    renderHud();
    draw();
  }

  function normKey(k) {
    switch (k) {
      case 'w': case 'W': return 'ArrowUp';
      case 'a': case 'A': return 'ArrowLeft';
      case 's': case 'S': return 'ArrowDown';
      case 'd': case 'D': return 'ArrowRight';
    }
    return k;
  }

  function handleKey(key) {
    key = normKey(key);
    switch (key) {
      case 'ArrowLeft': keys.left = true; heldDir = -1; dasAcc = 0; arrAcc = 0; move(-1); break;
      case 'ArrowRight': keys.right = true; heldDir = 1; dasAcc = 0; arrAcc = 0; move(1); break;
      case 'ArrowDown': keys.down = true; softAcc = 0; softDrop(); break;
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

  function releaseKey(key) {
    key = normKey(key);
    if (key === 'ArrowLeft') { keys.left = false; heldDir = keys.right ? 1 : 0; dasAcc = 0; arrAcc = 0; }
    else if (key === 'ArrowRight') { keys.right = false; heldDir = keys.left ? -1 : 0; dasAcc = 0; arrAcc = 0; }
    else if (key === 'ArrowDown') { keys.down = false; }
  }

  function clearHeld() {
    keys.left = keys.right = keys.down = false;
    heldDir = 0;
    dasAcc = 0;
    arrAcc = 0;
    softAcc = 0;
  }

  /* ---------- 渲染 ---------- */
  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* 圆角方块 + 上缘内高光；ghost 只画低透明度纯色 */
  function drawCell(c, px, py, size, color, alpha, ghost) {
    const m = Math.max(1, Math.round(size * 0.06));
    const s = size - m * 2;
    const r = Math.max(2, Math.round(s * 0.18));
    c.globalAlpha = alpha;
    c.fillStyle = color;
    rrect(c, px + m, py + m, s, s, r);
    c.fill();
    if (!ghost) {
      c.globalAlpha = Math.min(1, alpha * 0.4);
      c.fillStyle = '#ffffff';
      rrect(c, px + m + s * 0.14, py + m + s * 0.1, s * 0.72, s * 0.26, r * 0.6);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(154, 154, 149, 0.16)';
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
  }

  function drawBoard() {
    drawGrid();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = board[y][x];
        if (v) drawCell(ctx, x * CELL, y * CELL, CELL, COLORS[BY_ID[v]], 1, false);
      }
    }
    if (landFlash) {
      const p = 1 - landFlash.t / landFlash.dur;
      ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.55 * p).toFixed(3) + ')';
      landFlash.rows.forEach(function (r) { ctx.fillRect(1, r * CELL + 1, BOARD_W - 2, CELL - 2); });
    }
    if (current && !over) {
      const color = COLORS[current.type];
      let gy = current.y;
      while (!collide(current.cells, current.x, gy + 1)) gy++;
      if (gy > current.y) {
        eachCell(current.cells, function (i, j) {
          if (gy + i >= 0) drawCell(ctx, (current.x + j) * CELL, (gy + i) * CELL, CELL, color, 0.18, true);
        });
      }
      eachCell(current.cells, function (i, j) {
        if (current.y + i >= 0) drawCell(ctx, (current.x + j) * CELL, (current.y + i) * CELL, CELL, color, 1, false);
      });
    }
  }

  function drawClearAnim() {
    const a = clearAnim;
    const inFlash = a.t < FLASH_MS;
    const clearedSet = new Set(a.rows);
    const settleByRC = new Map();
    for (let i = 0; i < a.settle.length; i++) settleByRC.set(a.settle[i].c * ROWS + a.settle[i].from, a.settle[i]);

    drawGrid();
    for (let y = 0; y < ROWS; y++) {
      if (clearedSet.has(y)) {
        if (inFlash) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.fillRect(1, y * CELL + 1, BOARD_W - 2, CELL - 2);
        }
        continue;
      }
      for (let x = 0; x < COLS; x++) {
        const v = board[y][x];
        if (!v) continue;
        if (!inFlash && settleByRC.has(x * ROWS + y)) continue; // 塌陷格稍后单独画
        drawCell(ctx, x * CELL, y * CELL, CELL, COLORS[BY_ID[v]], 1, false);
      }
    }

    if (!inFlash) {
      const p0 = a.t - FLASH_MS;
      for (let i = 0; i < a.settle.length; i++) {
        const s = a.settle[i];
        const v = board[s.from][s.c];
        if (!v) continue;
        const local = Math.max(0, Math.min(1, (p0 - s.delay) / COLLAPSE_FALL));
        const y = local <= 0 ? s.from : s.from + (s.to - s.from) * (local * local * local);
        drawCell(ctx, s.c * CELL, y * CELL, CELL, COLORS[BY_ID[v]], 1, false);
      }
    }
  }

  function drawNext() {
    nctx.clearRect(0, 0, NEXT_W, NEXT_H);
    for (let k = 0; k < 3; k++) {
      const type = queue[k];
      if (!type) continue;
      const m = SHAPES[type];
      let minI = 9, maxI = -1, minJ = 9, maxJ = -1;
      eachCell(m, function (i, j) {
        if (i < minI) minI = i;
        if (i > maxI) maxI = i;
        if (j < minJ) minJ = j;
        if (j > maxJ) maxJ = j;
      });
      const w = (maxJ - minJ + 1) * NEXT_CELL;
      const h = (maxI - minI + 1) * NEXT_CELL;
      const slotH = NEXT_CELL * 2 + 10;
      const slotY = k * slotH;
      const ox = (NEXT_W - w) / 2 - minJ * NEXT_CELL;
      const oy = slotY + (NEXT_CELL * 2 - h) / 2 - minI * NEXT_CELL;
      eachCell(m, function (i, j) {
        drawCell(nctx, ox + j * NEXT_CELL, oy + i * NEXT_CELL, NEXT_CELL, COLORS[type], 1, false);
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, BOARD_W, BOARD_H);
    ctx.fillStyle = '#f8ffe5';
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    if (clearAnim) drawClearAnim(); else drawBoard();
    drawNext();
  }

  /* ---------- HUD / 飘字 ---------- */
  function renderHud() {
    el.score.textContent = String(score);
    el.best.textContent = String(best);
    el.lines.textContent = String(lines);
    el.level.textContent = String(level);
  }

  function retrigger(elNode) {
    elNode.classList.remove('on');
    void elNode.offsetWidth; /* 强制重排以重启动画 */
    elNode.classList.add('on');
  }

  function showFloat(text) {
    el.float.textContent = text;
    retrigger(el.float);
  }

  function showCombo(n) {
    el.combo.textContent = 'Combo ×' + n;
    retrigger(el.combo);
  }

  function showLevel() {
    el.levelFloat.textContent = 'Level ' + level;
    retrigger(el.levelFloat);
  }

  /* ---------- 主循环 ---------- */
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(t - last, 100) : 0;
    last = t;

    if (!paused) {
      if (clearAnim) {
        clearAnim.t += dt;
        if (clearAnim.t >= clearAnim.dur) finishClear();
      }
      if (landFlash) {
        landFlash.t += dt;
        if (landFlash.t >= landFlash.dur) landFlash = null;
      }
    }

    if (!over && !paused && !animating) {
      gravAcc += dt;
      const interval = dropInterval();
      while (gravAcc >= interval) {
        gravAcc -= interval;
        gravityStep();
        if (over || animating) break;
      }
      if (landed && !over && !animating) {
        lockAcc += dt;
        if (lockAcc >= LOCK_MS) doLock();
      }
      if (!over && !animating) {
        if (heldDir !== 0) {
          dasAcc += dt;
          if (dasAcc >= DAS_MS) {
            arrAcc += dt;
            while (arrAcc >= ARR_MS) {
              arrAcc -= ARR_MS;
              move(heldDir);
              if (over || animating) break;
            }
          }
        }
        if (keys.down) {
          softAcc += dt;
          while (softAcc >= SOFT_MS) {
            softAcc -= SOFT_MS;
            softDrop();
            if (over || animating) break;
          }
        }
      }
    }

    draw();
  }

  /* ---------- 输入 ---------- */
  window.addEventListener('keydown', function (e) {
    if (HANDLED.indexOf(e.key) === -1) return;
    e.preventDefault();
    if (e.repeat) return; /* 长按交给 DAS/ARR */
    handleKey(e.key);
  }, { passive: false });

  window.addEventListener('keyup', function (e) {
    releaseKey(e.key);
  });

  window.addEventListener('blur', clearHeld);

  el.restartBtn.addEventListener('click', restart);
  el.again.addEventListener('click', function () {
    if (over) restart(); else togglePause();
  });

  const ACTION_KEY = { left: 'ArrowLeft', rotate: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown', drop: ' ' };
  Array.prototype.forEach.call(document.querySelectorAll('.pad button'), function (btn) {
    const key = ACTION_KEY[btn.getAttribute('data-action')];
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      handleKey(key);
    });
    const release = function () { releaseKey(key); };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  /* ---------- 测试钩子（契约不变） ---------- */
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
        next: queue[0] || null,
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
    press: function (key) {
      handleKey(key);
      releaseKey(key);
    },
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
      landed = false;
      lockAcc = 0;
      lockResets = 0;
      gravAcc = 0;
      animating = false;
      clearAnim = null;
      el.overlay.classList.remove('on');
      draw();
      return board.map(function (r) { return r.slice(); });
    }
  };

  /* ---------- 启动 ---------- */
  el.best.textContent = String(best);
  restart();
  requestAnimationFrame(frame);
})();
