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
  } catch (e) { useLS = false; }

  function loadBest() {
    try {
      const v = useLS ? localStorage.getItem('shooter-best') : memBest;
      return v ? (Number(v) || 0) : 0;
    } catch (e) { return 0; }
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
  const PW = 34;             // player width
  const PH = 34;             // player height
  const PLAYER_STEP = 6;     // per-frame / per-press move distance
  const FIRE_INTERVAL = 8;   // frames between auto-shots
  const BULLET_SPEED = 8;
  const BULLET_W = 4;
  const BULLET_H = 12;
  const EW = 30;             // enemy base width
  const EH = 30;             // enemy base height
  const MAX_LIVES = 3;
  const SCORE_PER_KILL = 10;
  const MAX_LEVEL = 12;
  const LEVEL_FRAMES = 900;  // ~15s at 60fps
  const LEVEL_SCORE = 500;

  // pool capacities (hard caps; no per-frame allocation)
  const MAX_BULLETS = 120;
  const MAX_ENEMIES = 60;
  const MAX_PARTICLES = 400;

  // ---------- palette (from base.css accent family) ----------
  const C_GREEN = '#06d6a0';
  const C_GREEN_DK = '#14727e';
  const C_RED = '#ef476f';
  const C_RED_DK = '#c33556';
  const C_YELLOW = '#ffc43d';
  const C_YELLOW_DK = '#d99a00';

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const bestEl = document.getElementById('best');
  const scoreEl = document.getElementById('score');
  const floatEl = document.getElementById('float');
  const levelFloatEl = document.getElementById('levelFloat');
  const livesEl = document.getElementById('lives');
  const levelEl = document.getElementById('level');
  const overlay = document.getElementById('overlay');
  const ovEmoji = document.getElementById('ovEmoji');
  const ovTitle = document.getElementById('ovTitle');
  const ovSub = document.getElementById('ovSub');
  const againBtn = document.getElementById('again');
  const restartBtn = document.getElementById('restart');
  const pauseBtn = document.getElementById('pauseBtn');

  // ---------- cached background gradient (created once, reused every frame) ----------
  const bgGradient = ctx.createLinearGradient(0, 0, 0, H);
  bgGradient.addColorStop(0, '#d9f0f2');   // 天际淡青
  bgGradient.addColorStop(1, '#f8ffe5');   // 奶油田野

  // ---------- parallax layers (fixed, allocated once at boot) ----------
  const clouds = [];
  for (let i = 0; i < 6; i++) {
    const a = 0.05 + Math.random() * 0.05;
    clouds.push({ x: Math.random() * W, y: Math.random() * H, r: 26 + Math.random() * 44, sp: 0.15 + Math.random() * 0.3, css: 'rgba(34,194,214,' + a + ')' });
  }
  const stars = [];
  for (let i = 0; i < 42; i++) {
    const a = 0.06 + Math.random() * 0.1;
    stars.push({ x: Math.random() * W, y: Math.random() * H, sp: 0.4 + Math.random() * 1.0, css: 'rgba(20,114,126,' + a + ')', r: 0.6 + Math.random() * 1.3 });
  }

  // ---------- object pools (fixed capacity) ----------
  const bulletPool = [];
  const enemyPool = [];
  const particlePool = [];
  let bulletCount = 0;
  let enemyCount = 0;
  let particleCount = 0;

  (function initPools() {
    for (let i = 0; i < MAX_BULLETS; i++) bulletPool.push({ x: 0, y: 0, w: BULLET_W, h: BULLET_H });
    for (let i = 0; i < MAX_ENEMIES; i++) enemyPool.push({ x: 0, y: 0, w: EW, h: EH, hp: 1, kind: 'small', speed: 1, flash: 0 });
    for (let i = 0; i < MAX_PARTICLES; i++) particlePool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, color: '', kind: 'spark' });
  })();

  // swap last active element into slot i, shrink count (O(1) removal)
  function swapRemove(pool, n, i) {
    const last = n - 1;
    const t = pool[i];
    pool[i] = pool[last];
    pool[last] = t;
    return n - 1;
  }

  // ---------- state ----------
  let seed = 1;
  let rng = mulberry32(seed);
  let player = null;
  let score, best, lives, level, over, paused, frame;
  let spawnTimer, fireTimer, flashAlpha, flashColor;
  const keys = new Set();

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  function spawnInterval() { return Math.max(14, 50 - (level - 1) * 4); }
  function enemySpeed() { return Math.min(6, 1.6 + (level - 1) * 0.35); }
  function mediumChance() { return Math.min(0.4, 0.12 * (level - 1)); }

  function spawnEnemy() {
    if (enemyCount >= MAX_ENEMIES) return;
    const e = enemyPool[enemyCount++];
    e.kind = rng() < mediumChance() ? 'medium' : 'small';
    e.hp = e.kind === 'medium' ? 2 : 1;
    e.w = e.kind === 'medium' ? EW + 10 : EW;
    e.h = e.kind === 'medium' ? EH + 10 : EH;
    e.x = rng() * (W - e.w);
    e.y = -e.h;
    e.speed = enemySpeed();
    e.flash = 0;
  }

  function initState() {
    rng = mulberry32(seed);
    player = { x: (W - PW) / 2, y: H - 70, w: PW, h: PH, tilt: 0, invuln: 0 };
    bulletCount = 0;
    enemyCount = 0;
    particleCount = 0;
    score = 0;
    lives = MAX_LIVES;
    level = 1;
    over = false;
    paused = false;
    frame = 0;
    spawnTimer = 0;
    fireTimer = 0;
    flashAlpha = 0;
    flashColor = '255,255,255';
    keys.clear();
    spawnEnemy(); // deterministic first enemy
  }

  function restart() {
    initState();
    hideOverlay();
    updateHud();
    canvas.focus();
  }

  // ---------- particles ----------
  function addSpark(x, y, vx, vy, life, size, color) {
    if (particleCount >= MAX_PARTICLES) return;
    const p = particlePool[particleCount++];
    p.kind = 'spark';
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life;
    p.size = size; p.color = color;
  }

  function addRing(x, y, color) {
    if (particleCount >= MAX_PARTICLES) return;
    const p = particlePool[particleCount++];
    p.kind = 'ring';
    p.x = x; p.y = y; p.vx = 0; p.vy = 0;
    p.life = 18; p.maxLife = 18;
    p.size = 46; p.color = color;
  }

  function explode(x, y, color) {
    addRing(x, y, color);
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.2;
      addSpark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 20 + Math.random() * 16, 2 + Math.random() * 3, color);
    }
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 2;
      addSpark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 14 + Math.random() * 10, 1.5 + Math.random() * 2, '#fffdf2');
    }
  }

  function updateParticles() {
    for (let i = 0; i < particleCount; i++) {
      const p = particlePool[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.life--;
      if (p.life <= 0) { particleCount = swapRemove(particlePool, particleCount, i); i--; }
    }
  }

  // ---------- feedback ----------
  function doFlash(color) { flashAlpha = 0.32; flashColor = color; }

  function shakeStage() {
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
  }

  function showFloat(el, text) {
    el.textContent = text;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  // ---------- game logic ----------
  function loseLife() {
    if (player.invuln > 0) return;
    lives--;
    shakeStage();
    doFlash('239,71,111');
    player.invuln = 90;
    if (lives <= 0) {
      lives = 0;
      over = true;
      best = Math.max(best, score);
      saveBest(best);
      showOverlay('🙈', '游戏结束', '得分 ' + score, '再试一次');
    }
    updateHud();
  }

  function updateLevel() {
    const lv = Math.min(MAX_LEVEL, 1 + Math.floor(Math.max(frame / LEVEL_FRAMES, score / LEVEL_SCORE)));
    if (lv > level) {
      level = lv;
      doFlash('34,194,214');
      showFloat(levelFloatEl, 'Level ' + lv);
      updateHud();
    }
  }

  function update() {
    if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - 0.03);
    if (player.invuln > 0) player.invuln--;
    if (paused) return;
    if (over) { updateParticles(); return; }

    frame++;
    updateLevel();

    // held-key movement + tilt
    let dx = 0;
    let dy = 0;
    if (keys.has('left')) dx -= 1;
    if (keys.has('right')) dx += 1;
    if (keys.has('up')) dy -= 1;
    if (keys.has('down')) dy += 1;
    player.x = clamp(player.x + dx * PLAYER_STEP, 0, W - PW);
    player.y = clamp(player.y + dy * PLAYER_STEP, 0, H - PH);
    const targetTilt = dx * 0.26;
    player.tilt += (targetTilt - player.tilt) * 0.18;

    // auto-fire
    fireTimer--;
    if (fireTimer <= 0) {
      if (bulletCount < MAX_BULLETS) {
        const b = bulletPool[bulletCount++];
        b.x = player.x + PW / 2 - BULLET_W / 2;
        b.y = player.y - BULLET_H;
      }
      fireTimer = FIRE_INTERVAL;
    }

    // bullets move up
    for (let i = 0; i < bulletCount; i++) {
      bulletPool[i].y -= BULLET_SPEED;
      if (bulletPool[i].y + BULLET_H < 0) { bulletCount = swapRemove(bulletPool, bulletCount, i); i--; }
    }

    // spawn enemies
    spawnTimer--;
    if (spawnTimer <= 0) { spawnEnemy(); spawnTimer = spawnInterval(); }

    // enemies move down + collisions
    for (let i = 0; i < enemyCount; i++) {
      const e = enemyPool[i];
      if (e.flash > 0) e.flash--;
      e.y += e.speed;

      for (let j = 0; j < bulletCount; j++) {
        const b = bulletPool[j];
        if (aabb(e, b)) {
          bulletCount = swapRemove(bulletPool, bulletCount, j); j--;
          e.hp--;
          if (e.hp > 0) e.flash = 6;
          else break;
        }
      }

      if (e.hp <= 0) {
        enemyCount = swapRemove(enemyPool, enemyCount, i); i--;
        score += SCORE_PER_KILL;
        explode(e.x + e.w / 2, e.y + e.h / 2, C_RED);
        showFloat(floatEl, '+10');
        updateHud();
        continue;
      }

      if (player.invuln <= 0 && aabb(e, player)) {
        enemyCount = swapRemove(enemyPool, enemyCount, i); i--;
        explode(e.x + e.w / 2, e.y + e.h / 2, C_YELLOW);
        loseLife();
        continue;
      }

      if (e.y > H) {
        enemyCount = swapRemove(enemyPool, enemyCount, i); i--;
        loseLife();
      }
    }

    updateParticles();
    updateHud();
  }

  // ---------- rendering ----------
  function drawPlayer() {
    const px = player.x + player.w / 2;
    const py = player.y + player.h / 2;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(player.tilt);

    // tail flame (behind body, points down = +y)
    const f = 12 + Math.random() * 8;
    ctx.fillStyle = 'rgba(255,183,3,0.9)';
    ctx.beginPath();
    ctx.moveTo(-5, 13);
    ctx.quadraticCurveTo(0, 13 + f, 5, 13);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(-2.5, 13);
    ctx.quadraticCurveTo(0, 13 + f * 0.55, 2.5, 13);
    ctx.closePath();
    ctx.fill();

    // body: rounded trapezoid (narrow nose up, wide tail down)
    ctx.fillStyle = C_GREEN;
    ctx.strokeStyle = C_GREEN_DK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, -16);
    ctx.quadraticCurveTo(0, -18.5, 5, -16);
    ctx.lineTo(16, 15);
    ctx.quadraticCurveTo(0, 16.5, -16, 15);
    ctx.lineTo(-5, -16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(-4, -4, 2.6, 6.5, 0.45, 0, Math.PI * 2);
    ctx.fill();

    // cockpit
    ctx.fillStyle = '#fffdf2';
    ctx.beginPath();
    ctx.arc(0, -3, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawSmallEnemy(e) {
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    const w = e.w / 2;
    const h = e.h / 2;
    const white = e.flash > 0;
    ctx.fillStyle = white ? '#fff' : C_RED;
    ctx.strokeStyle = white ? '#e0e0e0' : C_RED_DK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + h);          // nose down
    ctx.lineTo(cx - w, cy - h);
    ctx.lineTo(cx + w, cy - h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = white ? '#c33556' : '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy - 2, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMediumEnemy(e) {
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    const w = e.w / 2;
    const h = e.h / 2;
    const white = e.flash > 0;
    ctx.fillStyle = white ? '#fff' : C_YELLOW;
    ctx.strokeStyle = white ? '#e0e0e0' : C_YELLOW_DK;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx - w, cy + h * 0.4);
    ctx.lineTo(cx - w * 0.55, cy - h);
    ctx.lineTo(cx + w * 0.55, cy - h);
    ctx.lineTo(cx + w, cy + h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = white ? '#d99a00' : C_YELLOW_DK;
    ctx.beginPath();
    ctx.arc(cx, cy - 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, W, H);

    // parallax clouds
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      c.y += c.sp;
      if (c.y > H + c.r) { c.y = -c.r; c.x = Math.random() * W; }
      ctx.fillStyle = c.css;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // parallax stars
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.y += s.sp;
      if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
      ctx.fillStyle = s.css;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }

    // bullets (glow + core + highlight)
    for (let i = 0; i < bulletCount; i++) {
      const b = bulletPool[i];
      ctx.fillStyle = 'rgba(6,214,160,0.25)';
      ctx.fillRect(b.x - 2, b.y - 4, b.w + 4, b.h + 8);
      ctx.fillStyle = C_GREEN;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(b.x + 1, b.y, 1, b.h);
    }

    // enemies
    for (let i = 0; i < enemyCount; i++) {
      const e = enemyPool[i];
      if (e.kind === 'medium') drawMediumEnemy(e);
      else drawSmallEnemy(e);
    }

    // player (blink while invulnerable)
    if (player.invuln > 0 && (Math.floor(frame / 4) % 2 === 0)) ctx.globalAlpha = 0.35;
    drawPlayer();
    ctx.globalAlpha = 1;

    // particles
    for (let i = 0; i < particleCount; i++) {
      const p = particlePool[i];
      const t = Math.max(0, p.life / p.maxLife);
      if (p.kind === 'ring') {
        const r = (1 - t) * p.size;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = t;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.globalAlpha = t;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;

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
    bestEl.textContent = String(Math.max(best, score));
    scoreEl.textContent = String(score);
    livesEl.dataset.lives = String(Math.max(0, lives));
    levelEl.textContent = String(level);
  }

  function showOverlay(emoji, title, sub, btnText) {
    ovEmoji.textContent = emoji;
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    againBtn.textContent = btnText;
    overlay.classList.add('on');
  }

  function hideOverlay() { overlay.classList.remove('on'); }

  // ---------- input ----------
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
    if (dx !== 0) player.tilt = dx * 0.3;
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    if (paused) showOverlay('⏸', '已暂停', '按空格或点「继续」继续', '继续');
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
    if (ev.key === ' ' || ev.code === 'Space') {
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

  // ---------- test hooks ----------
  function snapshot() {
    const xs = [];
    const ys = [];
    for (let i = 0; i < enemyCount; i++) {
      xs.push(Math.round(enemyPool[i].x));
      ys.push(Math.round(enemyPool[i].y));
    }
    return {
      score: score,
      over: over,
      paused: paused,
      lives: lives,
      player: { x: Math.round(player.x), y: Math.round(player.y) },
      bullets: bulletCount,
      enemies: enemyCount,
      enemyXs: xs,
      enemyYs: ys,
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
    if (key === ' ' || key === 'Space' || key === 'Spacebar') { togglePause(); return; }
    if (key === 'r' || key === 'R') { restart(); return; }
    if (key === 'Enter') { if (over) restart(); }
  }

  function setSeed(n) { seed = n >>> 0; }

  window.__game = {
    snapshot: snapshot,
    restart: restart,
    press: press,
    setSeed: setSeed
  };

  // ---------- pad buttons (touch) ----------
  const DIR_KEYS = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
  document.querySelectorAll('.pad button[data-dir]').forEach(function (btn) {
    btn.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      press(DIR_KEYS[btn.getAttribute('data-dir')]);
    });
  });
  pauseBtn.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    togglePause();
  });

  restartBtn.addEventListener('click', restart);
  againBtn.addEventListener('click', function () {
    if (paused && !over) { paused = false; hideOverlay(); }
    else restart();
  });

  // ---------- sizing ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- boot ----------
  best = loadBest();
  initState();
  updateHud();
  resize();
  window.addEventListener('resize', resize);
  canvas.focus();
  requestAnimationFrame(loop);
})();
