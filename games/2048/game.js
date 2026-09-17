/* 2048 · 零依赖离线小游戏 */
(function () {
  'use strict';

  const N = 4;
  const CELLS = N * N;
  const SLIDE_MS = 110; // 与 .tile 的 transform 过渡一致
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
    const plan = { moves: [], merges: [] }; // 供渲染层做滑动/合并动画
    let gained = 0;

    for (const line of LINES[dir]) {
      const vals = [];
      const srcs = [];
      for (const idx of line) if (board[idx] !== 0) { vals.push(board[idx]); srcs.push(idx); }
      const out = [];
      for (let k = 0; k < vals.length; k++) {
        const to = line[out.length];
        if (k + 1 < vals.length && vals[k] === vals[k + 1]) {
          const v = vals[k] * 2;
          out.push(v);
          gained += v;
          plan.moves.push({ from: srcs[k], to: to, dead: true });
          plan.moves.push({ from: srcs[k + 1], to: to, dead: true });
          plan.merges.push({ to: to, v: v });
          k++; // 每个格子每步只合并一次
        } else {
          out.push(vals[k]);
          plan.moves.push({ from: srcs[k], to: to, dead: false });
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

    syncHud();
    if (gained > 0) floatScore(gained);
    const at = spawn();
    playMove(plan, at);

    if (!won && has2048()) {
      won = true;
      keepPlaying = false;
      showOverlay('达成 2048！', '得分 ' + score, '继续挑战');
    } else if (!canMove()) {
      over = true;
      showOverlay('游戏结束', '得分 ' + score, '再试一次');
    }
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
    clearTiles();
    hideOverlay();

    const a = spawn();
    const b = spawn();
    if (a >= 0) addTile(a, board[a], 'pop');
    if (b >= 0) addTile(b, board[b], 'pop');

    syncHud();
  }

  /* ---------- 覆盖层 ---------- */
  function showOverlay(title, sub, btnText) {
    overlayMsgEl.textContent = title;
    overlaySubEl.textContent = sub;
    overlayBtn.textContent = btnText;
    overlayEl.classList.add('show');
  }
  function hideOverlay() {
    overlayEl.classList.remove('show');
  }
  function overlayAction() {
    if (over) { restart(); return; }
    if (won && !keepPlaying) {
      keepPlaying = true;
      hideOverlay();
      if (!canMove()) {
        over = true;
        showOverlay('游戏结束', '得分 ' + score, '再试一次');
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

  /* ---------- 渲染（DOM 方块：transform 定位 + 110ms 过渡） ---------- */
  const fieldEl = document.getElementById('field');
  const tilesEl = document.getElementById('tiles');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const addEl = document.getElementById('add');
  const boardEl = document.getElementById('board');
  const overlayEl = document.getElementById('overlay');
  const overlayMsgEl = document.getElementById('overlayMsg');
  const overlaySubEl = document.getElementById('overlaySub');
  const overlayBtn = document.getElementById('overlayBtn');

  let view = new Array(CELLS).fill(null); // 槽位 → { el, inner }

  /* 一格 = 自身宽度的 100%，所以 translate 的百分比就是格子数 */
  function offset(slot) {
    return 'translate(' + (slot % N) * 100 + '%,' + Math.floor(slot / N) * 100 + '%)';
  }

  for (let i = 0; i < CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.transform = offset(i);
    fieldEl.insertBefore(cell, tilesEl);
  }

  function addTile(slot, value, anim) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.transform = offset(slot);

    const inner = document.createElement('div');
    inner.className = 'tile-inner' + (value <= 2048 ? ' v' + value : ''); // 超过 2048 用默认底色
    inner.textContent = String(value);
    if (value > 9999) inner.classList.add('d5');
    else if (value > 999) inner.classList.add('d4');
    if (anim) inner.classList.add(anim);

    el.appendChild(inner);
    tilesEl.appendChild(el);
    view[slot] = { el: el, inner: inner };
  }

  function clearTiles() {
    tilesEl.textContent = '';
    view.fill(null);
  }

  function playMove(plan, spawnIdx) {
    const dying = [];
    for (const m of plan.moves) {
      const t = view[m.from];
      if (!t) continue;
      view[m.from] = null;
      t.el.style.transform = offset(m.to);
      if (m.dead) {
        t.inner.classList.add('shrink'); // 被合并掉的方块：滑过去 → 缩小消失
        dying.push(t.el);
      } else {
        view[m.to] = t;
      }
    }
    for (const g of plan.merges) addTile(g.to, g.v, 'pop-now'); // 合并结果原地弹出
    if (dying.length) {
      setTimeout(function () {
        for (let i = 0; i < dying.length; i++) dying[i].remove();
      }, SLIDE_MS);
    }
    if (spawnIdx >= 0) addTile(spawnIdx, board[spawnIdx], 'pop'); // 新方块等滑完再弹
  }

  function syncHud() {
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
  }

  function floatScore(n) {
    addEl.textContent = '+' + n;
    addEl.classList.remove('active');
    void addEl.offsetWidth; // 重排一次，让动画能重新播放
    addEl.classList.add('active');
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

  document.getElementById('restart').addEventListener('click', restart);
  overlayBtn.addEventListener('click', overlayAction);

  const SWIPE = 24;
  let touchX = 0;
  let touchY = 0;
  let touching = false;

  boardEl.addEventListener('touchstart', function (e) {
    const t = e.changedTouches[0];
    touchX = t.clientX;
    touchY = t.clientY;
    touching = true;
  }, { passive: true });

  boardEl.addEventListener('touchcancel', function () { touching = false; }, { passive: true });

  boardEl.addEventListener('touchend', function (e) {
    if (!touching) return;
    touching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });

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
})();
