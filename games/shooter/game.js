(function () {
  'use strict';

  // ---------- seeded PRNG (mulberry32) ----------
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- persistent best score (localStorage guarded by try/catch) ----------
  let useLS = false;
  let memBest = null;
  try {
    localStorage.setItem('__shooter_probe', '1');
    localStorage.removeItem('__shooter_probe');
    useLS = true;
  } catch (e) {
    useLS = false;
  }

  function loadBest() {
    try {
      const v = useLS ? localStorage.getItem('shooter-best') : memBest;
      return v ? (Number(v) || 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveBest(v) {
    if (useLS) {
      try { localStorage.setItem('shooter-best', String(v)); } catch (e) { /* ignore */ }
    } else {
      memBest = String(v);
    }
  }

  // ---------- constants ----------
  const W = 360;
  const H = 600;
  const PW = 34;              // player width
  const PH = 34;              // player height
  const PLAYER_STEP = 6;      // per-frame / per-press move distance
  const FIRE_INTERVAL = 8;    // frames between auto-shots
  const BULLET_SPEED = 8;
  const BULLET_W = 4;
  const BULLET_H = 12;
  const EW = 30;              // enemy width
  const EH = 30;              // enemy height
  const MAX_LIVES = 3;
  const SCORE_PER_KILL = 10;
  const MAX_LEVEL = 12;
  const LEVEL_FRAMES = 900;   // ~15s at 60fps
  const LEVEL_SCORE = 500;

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const livesEl = document.getElementById('lives');
  const levelEl = document.getElementById('level');
  const overlay = document.getElementById('overlay');
  const ovTitle = document.getElementById('ov-title');
  const ovSub = document.getElementById('ov-sub');
  const restartBtn = document.getElementById('restart');

  // ---------- state ----------
  let seed = 1;
  let rng = mulberry32(seed);
  let player, bullets, enemies, particles;
  let score, best, lives, level, over, paused, frame;
  let spawnTimer, fireTimer, shake, flashAlpha, flashColor;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function spawnInterval() {
    return Math.max(14, 50 - (level - 1) * 4);
  }

  function enemySpeed() {
    return Math.min(6, 1.6 + (level - 1) * 0.35);
  }

  function spawnEnemy() {
    enemies.push({
      x: rng() * (W - EW),
      y: -EH,
      w: EW,
      h: EH,
      speed: enemySpeed()
    });
  }

  function initState() {
    rng = mulberry32(seed);
    player = { x: (W - PW) / 2, y: H - 70, w: PW, h: PH };
    bullets = [];
    enemies = [];
    particles = [];
    score = 0;
    lives = MAX_LIVES;
    level = 1;
    over = false;
    paused = false;
    frame = 0;
    spawnTimer = 0;
    fireTimer = 0;
    shake = 0;
    flashAlpha = 0;
    flashColor = '255,255,255';
    spawnEnemy(); // deterministic first enemy
  }

  function restart() {
    initState();
    hideOverlay();
    updateHud();
    canvas.focus();
  }

  // ---------- particles / flash ----------
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 22 + Math.random() * 14,
        maxLife: 36,
        size: 2 + Math.random() * 3,
        color: color
      });
    }
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function doFlash(color) {
    flashAlpha = 0.3;
    flashColor = color;
  }

  // ---------- game logic ----------
  function loseLife() {
    lives--;
    shake = 8;
    doFlash('255,107,107');
    if (lives <= 0) {
      lives = 0;
      over = true;
      best = Math.max(best, score);
      saveBest(best);
      showOverlay('游戏结束', '得分 ' + score + ' · 按 R 或点击「重新开始」');
    }
    updateHud();
  }

  function updateLevel() {
    const lv = Math.min(MAX_LEVEL, 1 + Math.floor(Math.max(frame / LEVEL_FRAMES, score / LEVEL_SCORE)));
    if (lv > level) {
      level = lv;
      doFlash('73,177,245');
      updateHud();
    }
  }

  function update() {
    if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - 0.04);
    if (paused) return;
    if (over) {
      updateParticles();
      if (shake > 0) shake--;
      return;
    }

    frame++;
    updateLevel();

    // held-key movement
    if (keys.has('left')) player.x -= PLAYER_STEP;
    if (keys.has('right')) player.x += PLAYER_STEP;
    if (keys.has('up')) player.y -= PLAYER_STEP;
    if (keys.has('down')) player.y += PLAYER_STEP;
    player.x = clamp(player.x, 0, W - PW);
    player.y = clamp(player.y, 0, H - PH);

    // auto-fire
    fireTimer--;
    if (fireTimer <= 0) {
      bullets.push({ x: player.x + PW / 2 - BULLET_W / 2, y: player.y - BULLET_H, w: BULLET_W, h: BULLET_H });
      fireTimer = FIRE_INTERVAL;
    }

    // bullets move up
    for (let i = bullets.length - 1; i >= 0; i--) {
      bullets[i].y -= BULLET_SPEED;
      if (bullets[i].y + BULLET_H < 0) bullets.splice(i, 1);
    }

    // spawn enemies
    spawnTimer--;
    if (spawnTimer <= 0) {
      spawnEnemy();
      spawnTimer = spawnInterval();
    }

    // enemies move down + collisions
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.y += e.speed;

      // bullet hits
      let hit = false;
      for (let j = bullets.length - 1; j >= 0; j--) {
        if (aabb(e, bullets[j])) {
          bullets.splice(j, 1);
          hit = true;
        }
      }
      if (hit) {
        enemies.splice(i, 1);
        score += SCORE_PER_KILL;
        burst(e.x + EW / 2, e.y + EH / 2, '#ff9f43', 10);
        updateHud();
        continue;
      }

      // collision with player
      if (aabb(e, player)) {
        enemies.splice(i, 1);
        burst(e.x + EW / 2, e.y + EH / 2, '#ff6b6b', 14);
        loseLife();
        continue;
      }

      // passed the bottom
      if (e.y > H) {
        enemies.splice(i, 1);
        loseLife();
      }
    }

    updateParticles();
    if (shake > 0) shake--;
    updateHud();
  }

  // ---------- rendering ----------
  function render() {
    ctx.clearRect(0, 0, W, H);

    // background
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#14161b');
    g.addColorStop(1, '#1c2028');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    let ox = 0;
    let oy = 0;
    if (shake > 0) {
      ox = (Math.random() - 0.5) * shake;
      oy = (Math.random() - 0.5) * shake;
    }
    ctx.save();
    ctx.translate(ox, oy);

    // bullets
    ctx.fillStyle = '#49b1f5';
    for (const b of bullets) {
      ctx.fillRect(b.x, b.y, BULLET_W, BULLET_H);
    }

    // enemies (downward triangles)
    for (const e of enemies) {
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.moveTo(cx, cy + e.h / 2);
      ctx.lineTo(cx + e.w / 2, cy - e.h / 2);
      ctx.lineTo(cx - e.w / 2, cy - e.h / 2);
      ctx.closePath();
      ctx.fill();
    }

    // player (upward plane)
    const px = player.x + player.w / 2;
    const py = player.y + player.h / 2;
    ctx.fillStyle = '#49b1f5';
    ctx.beginPath();
    ctx.moveTo(px, py - PH / 2);
    ctx.lineTo(px + PW / 2, py + PH / 2);
    ctx.lineTo(px, py + PH / 2 - 9);
    ctx.lineTo(px - PW / 2, py + PH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e6e8eb';
    ctx.beginPath();
    ctx.arc(px, py - 2, 3, 0, Math.PI * 2);
    ctx.fill();

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    ctx.restore();

    // flash overlay
    if (flashAlpha > 0) {
      ctx.fillStyle = 'rgba(' + flashColor + ',' + flashAlpha.toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  // ---------- HUD / overlay ----------
  function updateHud() {
    scoreEl.textContent = String(score);
    bestEl.textContent = String(Math.max(best, score));
    livesEl.textContent = String(lives);
    levelEl.textContent = String(level);
  }

  function showOverlay(title, sub) {
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  // ---------- input ----------
  const keys = new Set();

  function normKey(k) {
    switch (k) {
      case 'ArrowLeft': case 'a': case 'A': return 'left';
      case 'ArrowRight': case 'd': case 'D': return 'right';
      case 'ArrowUp': case 'w': case 'W': return 'up';
      case 'ArrowDown': case 's': case 'S': return 'down';
      default: return null;
    }
  }

  function movePlayer(dx, dy) {
    player.x = clamp(player.x + dx * PLAYER_STEP, 0, W - PW);
    player.y = clamp(player.y + dy * PLAYER_STEP, 0, H - PH);
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) showOverlay('已暂停', '按空格或点击「重新开始」继续');
    else hideOverlay();
  }

  window.addEventListener('keydown', function (ev) {
    const dir = normKey(ev.key);
    if (dir) {
      ev.preventDefault();
      keys.add(dir);
      if (dir === 'left') movePlayer(-1, 0);
      else if (dir === 'right') movePlayer(1, 0);
      else if (dir === 'up') movePlayer(0, -1);
      else if (dir === 'down') movePlayer(0, 1);
      return;
    }
    if (ev.key === ' ' || ev.key === 'Space') {
      ev.preventDefault();
      togglePause();
      return;
    }
    if (ev.key === 'r' || ev.key === 'R') {
      ev.preventDefault();
      restart();
      return;
    }
    if (ev.key === 'Enter') {
      if (over) restart();
    }
  });

  window.addEventListener('keyup', function (ev) {
    const dir = normKey(ev.key);
    if (dir) keys.delete(dir);
  });

  // pointer / touch drag
  let dragging = false;

  function movePlayerToPointer(ev) {
    const rect = canvas.getBoundingClientRect();
    const lx = (ev.clientX - rect.left) * (W / rect.width);
    const ly = (ev.clientY - rect.top) * (H / rect.height);
    player.x = clamp(lx - PW / 2, 0, W - PW);
    player.y = clamp(ly - PH / 2, 0, H - PH);
  }

  canvas.addEventListener('pointerdown', function (ev) {
    dragging = true;
    canvas.focus();
    if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    movePlayerToPointer(ev);
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (dragging) movePlayerToPointer(ev);
  });

  canvas.addEventListener('pointerup', function () { dragging = false; });
  canvas.addEventListener('pointercancel', function () { dragging = false; });

  restartBtn.addEventListener('click', restart);

  // ---------- sizing ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- test hooks ----------
  function snapshot() {
    return {
      score: score,
      over: over,
      paused: paused,
      lives: lives,
      player: { x: Math.round(player.x), y: Math.round(player.y) },
      bullets: bullets.length,
      enemies: enemies.length,
      enemyXs: enemies.map(function (e) { return Math.round(e.x); }),
      enemyYs: enemies.map(function (e) { return Math.round(e.y); }),
      level: level
    };
  }

  function press(key) {
    const dir = normKey(key);
    if (dir) {
      if (dir === 'left') movePlayer(-1, 0);
      else if (dir === 'right') movePlayer(1, 0);
      else if (dir === 'up') movePlayer(0, -1);
      else if (dir === 'down') movePlayer(0, 1);
      return;
    }
    if (key === ' ' || key === 'Space') { togglePause(); return; }
    if (key === 'r' || key === 'R') { restart(); return; }
    if (key === 'Enter') { if (over) restart(); }
  }

  function setSeed(n) {
    seed = n >>> 0;
  }

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: setSeed
  };

  // ---------- boot ----------
  best = loadBest();
  initState();
  updateHud();
  resize();
  window.addEventListener('resize', resize);
  canvas.focus();
  requestAnimationFrame(loop);
})();
