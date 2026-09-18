/* 隔山炮战 —— 单文件实现，零外部依赖。
 * 章节：1 常量 2 PRNG/存档 3 DOM 4 地形 5 关卡 6 武器 7 状态 8 相机
 *       9 输入 10 物理 11 命中 12 AI 13 粒子 14 音效 15 渲染
 *       16 HUD 17 流程 18 主循环 19 测试钩子 20 启动
 */
(function () {
'use strict';

/* ═══════════════════ 1. 常量与配色 ═══════════════════ */

var W = 800, H = 600;                    // 逻辑画布（4:3）：瞄准时整片战场一屏可见
var WORLD_W = 800, WORLD_H = 600;        // 世界 = 一屏，飞行时再拉近跟随
var AUTH_W = 1440, AUTH_GROUND = 860;    // 关卡数据按"1440 宽、地面 860"书写，装载时重标定
var FLOOR_Y = 560;                       // 基岩层：弹坑最多挖到这里，炮不会被炸出画面
var WALL_Y = 300, WALL_W = 120;          // 两端挡墙：打过头会砸在坡上，而不是飞出世界
var STEP = 1 / 120;                      // 物理固定步长（秒）
var GRAV = 430;                          // 重力 px/s²
var WIND_K = 17;                         // 风（-1..1）→ 水平加速度
var ANG_MIN = 5, ANG_MAX = 89;
var PWR_MIN = 8, PWR_MAX = 100;
var SPEED_BASE = 200, SPEED_PER = 4.3;   // 力度 → 初速（满力 45° 射程约 930，是两炮间距的 1.6 倍）
var CANNON_X = [110, WORLD_W - 110];
var CANNON_HW = 26, CANNON_HH = 16;
var MUZZLE_LEN = CANNON_HW + 16;   // 炮口到炮心的距离（发射点与 AI 预测共用）
var HP_MAX = 100;
var SHOT_CAP = 4;                        // 同屏最多 4 发（三连弹用）
var MAX_PARTS = 360;
var CAM_Z_IDLE = 1, CAM_Z_FLY = 1.55;
var SKY_MARGIN = 240;
var FLY_LEAD = 0.22;                     // 镜头对炮弹的前瞻（秒）
var RESULT_HOLD = 0.5;                   // 命中后镜头停留（秒）
var ENEMY_AIM_T = 1.35;                  // 敌方瞄准停顿（秒）
var TRAIL_MAX = 260;                     // 上一发弹道残影点数

var COL = {
  skyTop: '#a9dcf0', skyMid: '#c9ebf7', skyBot: '#eaf7fb',
  sun: '#ffe9a8', sunCore: '#ffd470',
  cloud: '#ffffff',
  grass: '#6bbf59',
  soil: '#d8b184', soilDark: '#bd9163',
  rock: '#a8a49a', rockDark: '#8a867d',
  rockLight: '#c3bfb4', rockDeep: '#7e7a72', caveShade: '#6d6a63',
  cannonA: '#1b9aaa', cannonADark: '#14727e',
  cannonB: '#ef476f', cannonBDark: '#b3304f',
  shell: '#555', trail: 'rgba(255,255,255,0.75)',
  ink: '#555', white: '#fff',
  hpA: '#1b9aaa', hpB: '#ef476f',
  hud: 'rgba(85,85,85,0.68)'
};

/* ═══════════════════ 2. PRNG / 存档 ═══════════════════ */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

var STORE_KEY = 'games.artillery.v1';
var save = { muted: false, map: 0, weapon: 0, mode: 0 };
/* 默认种子随机：否则每次刷新都玩到同一局（无尽地形、风、AI 误差全固定）。
   setSeed(n) 仍然能钉死整条序列，测试照旧可复现。 */
var seed = ((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) || 1, rng = mulberry32(seed);

function loadSave() {
  try {
    var raw = window.localStorage ? window.localStorage.getItem(STORE_KEY) : null;
    if (!raw) return;
    var o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      save.muted = !!o.muted;                      /* 不做进度存档：只记住静音与上次的选择 */
      save.map = Math.max(0, o.map | 0);
      save.weapon = Math.max(0, o.weapon | 0);
      save.mode = Math.max(0, Math.min(MODE_TOTAL - 1, o.mode | 0));
    }
  } catch (e) { /* 隐私模式下 localStorage 会抛错，忽略即可 */ }
}
function putSave() {
  try {
    if (window.localStorage) window.localStorage.setItem(STORE_KEY, JSON.stringify(save));
  } catch (e) { /* 同上 */ }
}

/* ═══════════════════ 3. DOM 引用 ═══════════════════ */

var el = {};
function grabDom() {
  var ids = ['game', 'stage', 'overlay', 'ovEmoji', 'ovTitle', 'ovLine1', 'ovLine2', 'ovLine3',
    'again', 'restart', 'mapSel', 'randMap', 'mapName', 'mapStars', 'weapons', 'modes',
    'fireBtn', 'weaponBtn', 'pauseBtn'];
  for (var i = 0; i < ids.length; i++) el[ids[i]] = document.getElementById(ids[i]);
  el.buttons = [];
  var ws = el.weapons.getElementsByTagName('button');
  for (var j = 0; j < ws.length; j++) el.buttons.push(ws[j]);
}

/* ═══════════════════ 4. 地形 ═══════════════════ */

/* 逐列分成四层（y 越大越低）：
 *   土   [surf, rock)      能炸、会塌方（超过休止角就往下滑）
 *   岩带 [rock, rockBot)   普通弹只能崩掉一层壳；只有钻地弹能真正啃开
 *   空腔 [rockBot, FLOOR)  空气：天然桥 / 溶洞，炮弹能从中穿过
 *   基岩 [FLOOR, ∞)        挖不穿的底板
 * 岩带底低于基岩时没有空腔，也就是常见的"整座山都是实心"。
 * 因为岩带永远在土面之下，所以只要邻列的土面低于岩带底，那里就是洞口——
 * 天然桥、溶洞都是这么长出来的。 */
var surf = new Float32Array(WORLD_W);      // 土面
var rock = new Float32Array(WORLD_W);      // 岩带顶
var rockBot = new Float32Array(WORLD_W);   // 岩带底
var surf0 = new Float32Array(WORLD_W);     // 关卡初始地形（重开用）
var rock0 = new Float32Array(WORLD_W);
var rockBot0 = new Float32Array(WORLD_W);
var terrainSig = 0;                        // 每次地形变化 +1（AI 失效判定用）

var SPALL = 3.4;      // 普通弹命中岩石时崩掉的壳厚（像素）
var RIM_MAX = 11;     // 抛土在坑口外侧堆起的最大高度
var RIM_KEEP = 0.24;  // 挖走的土有多大比例被抛到坑口，其余炸飞
var REPOSE = 2.1;     // 相邻列高差超过它就塌方（约 65°），只对土生效

function clampCol(x) {
  var i = x | 0;
  return i < 0 ? 0 : (i >= WORLD_W ? WORLD_W - 1 : i);
}
function terrainHeightAt(x) { return surf[clampCol(x)]; }
function terrainRockAt(x) { return rock[clampCol(x)]; }
function terrainRockBotAt(x) { return rockBot[clampCol(x)]; }
/* 该点是不是实体：土、岩带、基岩都算，空腔不算 */
function solidAt(x, y) {
  if (y >= FLOOR_Y) return true;
  var i = clampCol(x);
  return y >= surf[i] && y < rockBot[i];
}
/* 这一列最多能挖到哪：岩带底，但绝不低于基岩（基岩挖不穿） */
function digFloor(x) {
  var b = rockBot[clampCol(x)];
  return b < FLOOR_Y ? b : FLOOR_Y;
}

/* 用控制点生成地表：余弦插值，避免直线段太生硬 */
var G1 = 500, RELIEF = 0.7;              // 地面落在 y=500，山体起伏按 0.7 重标定
function reliefY(y) {
  var r = G1 - (AUTH_GROUND - y) * RELIEF;
  return r < 70 ? 70 : (r > FLOOR_Y ? FLOOR_Y : r);
}
/* 控制点 → 余弦插值采样（地表与岩层共用） */
function profileAt(pts, x, xs) {
  var seg = 0;
  while (seg < pts.length - 2 && x > pts[seg + 1][0] * xs) seg++;
  var a = pts[seg], b = pts[seg + 1];
  var span = (b[0] - a[0]) * xs;
  var t = span <= 0 ? 0 : (x - a[0] * xs) / span;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  var c = (1 - Math.cos(t * Math.PI)) * 0.5;
  return reliefY(a[1]) + (reliefY(b[1]) - reliefY(a[1])) * c;
}

/* pts = 地表控制点；soil = 没有岩层控制点时的土层厚度上限；
   coreY = 平坦岩顶的高度（960 = 不限制）；rockPts = 岩带顶控制点；
   rockThick = 岩带厚度（0/未给 = 岩层一直连到基岩）；rockBotPts = 岩带底控制点（做天然桥用） */
function buildProfile(pts, soil, coreY, flattenAt, rockPts, rockThick, rockBotPts) {
  var i, x;
  var cy = coreY >= 960 ? -1 : reliefY(coreY);
  var xs = WORLD_W / AUTH_W, fl = [];
  for (i = 0; i < flattenAt.length; i++) fl.push(flattenAt[i] | 0);
  for (x = 0; x < WORLD_W; x++) surf[x] = profileAt(pts, x, xs);
  // 炮位附近推平，保证两台炮都站得稳
  for (i = 0; i < fl.length; i++) {
    var cx = fl[i], hw = 34, base = surf[cx], k;
    for (k = cx - hw; k <= cx + hw; k++) {
      if (k < 0 || k >= WORLD_W) continue;
      surf[k] = Math.max(surf[k], base - 2);
      var w = 1 - Math.abs(k - cx) / hw;
      surf[k] = surf[k] + (base - surf[k]) * Math.min(1, w * 2.2);
    }
  }
  /* 两端挡墙：用 smoothstep 把边界平滑抬到 WALL_Y，
     硬抬会在挡墙内侧留一道垂直悬崖（看上去像根针） */
  for (x = 0; x < WALL_W; x++) {
    var et = 1 - x / WALL_W, ew = et * et * (3 - 2 * et);
    var tgt = WALL_Y + (1 - ew) * 200;
    var xr = WORLD_W - 1 - x;
    if (surf[x] > tgt) surf[x] = surf[x] * (1 - ew) + tgt * ew;
    if (surf[xr] > tgt) surf[xr] = surf[xr] * (1 - ew) + tgt * ew;
  }
  for (x = 0; x < WORLD_W; x++) {
    var top;
    if (rockPts) top = profileAt(rockPts, x, xs);      /* 逐列岩顶：岩核 / 岩壁 / 石包 / 岩帽 */
    else top = surf[x] + soil;
    if (cy >= 0 && top > cy) top = cy;
    if (top < surf[x]) top = surf[x];                  /* 岩顶不能高于地表 */
    if (top > FLOOR_Y) top = FLOOR_Y;                  /* 基岩永远是挖掘下限 */
    rock[x] = top;
    if (rockBotPts) {
      var bot = profileAt(rockBotPts, x, xs);
      rockBot[x] = bot < top ? top : bot;              /* 岩带底（做天然桥/溶洞） */
    } else if (rockThick > 0) {
      rockBot[x] = Math.min(FLOOR_Y, top + rockThick);
    } else {
      rockBot[x] = FLOOR_Y + 400;                      /* 连到基岩：没有空腔 */
    }
  }
  surf0.set(surf); rock0.set(rock); rockBot0.set(rockBot);
}

/* 抛土：把一部分炸出来的土堆在坑口外圈，堆出一圈唇。
   真实爆炸的土不会凭空消失，这是"挖走多少、剩下多少"的一半答案。 */
function pileRim(ccx, a, amount) {
  if (amount <= 0) return;
  var span = Math.max(6, a * 0.55);
  var per = Math.min(RIM_MAX, amount / (a * 0.75));
  var i, d, x, w;
  for (i = 0; i < 2; i++) {
    var dir = i === 0 ? -1 : 1;
    for (d = 0; d < span; d++) {
      x = Math.round(ccx + dir * (a + d));
      if (x < 1 || x >= WORLD_W - 1) continue;
      w = 1 - d / span;
      surf[x] -= per * w * w * 0.85;
      if (surf[x] < 40) surf[x] = 40;
    }
  }
}

/* 塌方：土坡陡过休止角就往下滑，直到坡度回到阈值内。
   坑壁会塌成碗形、削出来的针尖会自己垮掉，而岩带不动——这是"土是散的、岩是整的"。 */
function slumpSoil(passes) {
  var p, i, d, k;
  for (p = 0; p < passes; p++) {
    for (i = 0; i < WORLD_W - 1; i++) {
      d = surf[i + 1] - surf[i];
      if (d > REPOSE) { k = (d - REPOSE) * 0.3; surf[i] += k; surf[i + 1] -= k; }
      else if (d < -REPOSE) { k = (-d - REPOSE) * 0.3; surf[i] -= k; surf[i + 1] += k; }
      if (surf[i] > rock[i]) surf[i] = rock[i];              /* 土滑到岩面上就没了 */
      if (surf[i + 1] > rock[i + 1]) surf[i + 1] = rock[i + 1];
    }
  }
}

/* 定向弹坑：命中越快坑越大；入射越陡坑越深越窄，越平则越宽越浅，并且整体朝飞行方向前移。
   体积大致守恒（宽×深 ≈ 常数），所以"同样一发炮弹"在不同角度下挖掉的山体形状明显不同。
   落到岩石上时：普通弹只崩壳（SPALL），钻地弹（wp.rockDig）才真啃得动岩带。 */
function terrainBlast(cx, cy, wp, vx, vy, digScale) {
  var sp = Math.sqrt(vx * vx + vy * vy);
  if (sp < 1) sp = 1;
  var descent = Math.atan2(Math.abs(vy), Math.abs(vx));        // 0 = 平射，π/2 = 垂直砸下
  var kSpeed = 1 + (sp - 560) / 1500;                          // 命中速度 → 体积
  if (kSpeed < 0.72) kSpeed = 0.72;
  if (kSpeed > 1.35) kSpeed = 1.35;
  var wid = 1.34 - 0.58 * Math.sin(descent);                   // 越陡越窄
  var dep = 0.52 + 0.80 * Math.sin(descent);                   // 越陡越深
  if (typeof digScale !== 'number') digScale = 1;
  var a = wp.r * kSpeed * wid * (0.6 + 0.4 * digScale);         // 水平半轴
  var b = wp.r * kSpeed * dep * digScale;                       // 垂直半轴
  var dir = vx >= 0 ? 1 : -1;
  var ccx = cx + (1 - Math.sin(descent)) * a * 0.34 * dir;     // 平射时坑心前移（抛土方向）
  var x0 = Math.max(0, Math.floor(ccx - a)), x1 = Math.min(WORLD_W - 1, Math.ceil(ccx + a));
  var dirt = 0, rockCut = 0, rockCols = 0, cols = 0, broke = 0, x, dx, t, edge, lim, chip, nb;
  for (x = x0; x <= x1; x++) {
    dx = x - ccx;
    t = dx / a;
    if (t <= -1 || t >= 1) continue;
    edge = cy + b * Math.sqrt(1 - t * t);
    lim = digFloor(x);                                   /* 基岩之下挖不动 */
    /* 土：一路挖到岩顶（或基岩）为止 */
    if (edge > surf[x]) {
      var l2 = edge < rock[x] ? edge : rock[x];
      if (l2 > lim) l2 = lim;
      if (l2 > surf[x]) { dirt += l2 - surf[x]; surf[x] = l2; }
      if (edge > rock[x] - 0.5) cols++;                  /* 这一列挖到底就碰岩 */
    }
    /* 岩带 */
    if (edge > rock[x] + 0.5 && rock[x] < lim - 0.5) {
      rockCols++;
      if (wp.rockDig) {                                  /* 钻地弹：岩带一起啃 */
        nb = edge < lim ? edge : lim;
        rockCut += nb - rock[x];
        rock[x] = nb;
        if (rock[x] >= lim - 0.5) broke++;               /* 这一列挖到岩带底/基岩 */
      } else {                                           /* 其它弹：只崩一层壳 */
        chip = SPALL * (0.45 + 0.55 * Math.min(1, wp.r / 70));
        nb = rock[x] + chip;
        if (nb > lim) nb = lim;
        rockCut += nb - rock[x];
        rock[x] = nb;
      }
    }
  }
  if (dirt > 0.5) {
    pileRim(ccx, a, dirt * RIM_KEEP);
    slumpSoil(3);
  }
  if (dirt > 0 || rockCut > 0) terrainSig++;
  return { removed: dirt, a: a, b: b, cx: ccx, rockCols: rockCols, cols: cols, rockCut: rockCut, broke: broke };
}

/* 对称圆坑：钻地弹的掘进与测试工具用（不受速度与角度影响） */
function terrainCarve(cx, cy, r, rockDig) {
  var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(WORLD_W - 1, Math.ceil(cx + r));
  if (x1 < x0) return 0;
  var removed = 0, rr = r * r, x, dx, edge, before;
  for (x = x0; x <= x1; x++) {
    dx = x - cx;
    edge = cy + Math.sqrt(Math.max(0, rr - dx * dx));   // 圆的下缘
    if (edge <= surf[x]) continue;
    before = surf[x];
    surf[x] = Math.min(edge, rock[x]);
    if (surf[x] > before) removed += surf[x] - before;
    var lim2 = digFloor(x);
    if (rockDig && edge > rock[x] && rock[x] < lim2 - 0.5) {
      rock[x] = Math.min(edge, lim2);
    }
  }
  if (removed > 0) { slumpSoil(1); terrainSig++; }
  else if (rockDig) terrainSig++;
  return removed;
}

function terrainStats() {
  var minH = 1e9, maxH = -1e9, sum = 0, i, d, craters = 0, voids = 0, rocks = 0;
  for (i = 0; i < WORLD_W; i++) {
    d = surf[i];
    if (d < minH) minH = d;
    if (d > maxH) maxH = d;
    sum += d;
    if (surf[i] > surf0[i] + 1) craters++;
    if (rockBot[i] < FLOOR_Y - 1) voids++;          /* 这一列下面有空腔 */
    if (rock[i] > surf[i] + 0.5) rocks++;           /* 这一列有埋在土下的岩石 */
  }
  return { minH: Math.round(minH), maxH: Math.round(maxH), avg: Math.round(sum / WORLD_W), craters: craters, voids: voids, rockCols: rocks, sig: terrainSig };
}

/* ═══════════════════ 5. 关卡 ═══════════════════ */

/* pts 用控制点描述山形；soil 土壤厚度；coreY 岩石层顶（960 = 无岩层） */
/* 每张地图的地层身份（pts = 地表，rockPts = 岩带顶，rockBotPts = 岩带底，rockThick = 岩带厚度）：
 *   1 小丘   全土            —— 先学会抛物线
 *   2 双峰   两峰埋岩核       —— 山心是石头，挖不动
 *   3 高墙   土帽 + 石墙基    —— 刨掉墙头再平射，别想把墙拆掉
 *   4 缓坡   左深右浅         —— 左坡随便刨，右坡下面就是石头
 *   5 峡谷   谷底石床         —— 谷底挖不动，文章在山肩上
 *   6 石心山 岩心 + 土壳      —— 先剥壳，钻地弹才啃得动岩心
 *   7 天生桥 桥面岩、桥下空腔  —— 炮弹能从桥洞里穿过去
 *   8 陡崖   整块岩壁 + 土顶   —— 只能从崖顶落
 *   9 铁壁   浅岩层           —— 弹坑一律很浅，考精确度
 *  10 高原   最厚土层         —— 想怎么刨就怎么刨
 *  11 乱石岗 石包夹土沟       —— 必须把炮弹送进土沟
 *  12 要塞   岩体 + 土坡外挂   —— 只有斜坡那层土刨得开 */
var LEVELS = [
  { name: '教学·小丘', tip: '低角度打不远，试试 45° 上下', cx: [180, 1250],
    pts: [[0, 878], [220, 862], [430, 760], [640, 690], [840, 776], [1060, 848], [1280, 806], [1440, 862]],
    soil: 900, coreY: 960, wind: 0, hp: 60, err: 26 },
  { name: '双峰', tip: '两座峰的山心都是石头，刨不动，走低的那边', cx: [200, 1230],
    pts: [[0, 876], [240, 828], [420, 596], [560, 706], [770, 846], [980, 618], [1150, 764], [1440, 868]],
    rockPts: [[0, 960], [360, 960], [400, 610], [450, 598], [500, 660], [545, 790], [880, 960], [940, 650], [990, 628], [1040, 680], [1090, 800], [1200, 960], [1440, 960]],
    soil: 900, coreY: 960, wind: 0, hp: 70, err: 23 },
  { name: '高墙', tip: '墙头是土、墙基是石头：刨出缺口再平射', cx: [180, 1256],
    pts: [[0, 872], [300, 858], [470, 792], [556, 430], [622, 408], [706, 776], [900, 694], [1120, 762], [1440, 818]],
    rockPts: [[0, 950], [300, 930], [440, 900], [500, 530], [556, 470], [622, 452], [680, 530], [730, 830], [900, 830], [1120, 850], [1440, 940]],
    soil: 900, coreY: 960, wind: 0, hp: 70, err: 21 },
  { name: '缓坡', tip: '左坡土厚随便刨，右坡下面就是石头', cx: [214, 1244],
    pts: [[0, 862], [220, 838], [500, 758], [760, 638], [980, 556], [1180, 662], [1440, 784]],
    rockPts: [[0, 960], [520, 960], [700, 860], [860, 690], [980, 600], [1100, 700], [1220, 780], [1330, 880], [1440, 950]],
    soil: 900, coreY: 960, wind: 0.5, hp: 80, err: 19 },
  { name: '峡谷', tip: '谷底是整块岩床，别往谷底扔；山肩上土厚', cx: [232, 1214],
    pts: [[0, 858], [200, 816], [420, 892], [524, 906], [664, 838], [880, 698], [1080, 636], [1440, 700]],
    rockPts: [[0, 940], [240, 910], [400, 912], [470, 925], [560, 930], [660, 905], [760, 880], [860, 800], [960, 720], [1080, 700], [1200, 760], [1320, 830], [1440, 910]],
    soil: 900, coreY: 960, wind: 0.7, hp: 80, err: 17 },
  { name: '石心山', tip: '先刨开土壳，里头是石头；钻地弹才啃得动岩心', cx: [180, 1264],
    pts: [[0, 858], [300, 718], [520, 556], [700, 604], [880, 756], [1150, 818], [1440, 856]],
    rockPts: [[0, 930], [300, 785], [520, 620], [700, 670], [880, 820], [1150, 885], [1440, 925]],
    soil: 900, coreY: 960, wind: 0.7, hp: 90, err: 15 },
  { name: '天生桥', tip: '两峰之间是一座石桥，桥洞底下也能打过去', cx: [190, 1258],
    pts: [[0, 870], [180, 776], [340, 536], [400, 760], [430, 880], [470, 940], [555, 945], [560, 805], [660, 805], [665, 945], [760, 940], [820, 880], [880, 700], [1060, 596], [1240, 818], [1440, 866]],
    rockPts: [[0, 940], [300, 720], [360, 620], [420, 850], [540, 900], [560, 815], [660, 815], [680, 900], [760, 930], [880, 790], [1060, 700], [1240, 890], [1440, 930]],
    rockBotPts: [[0, 1200], [556, 1200], [560, 830], [660, 830], [664, 1200], [1200, 1200]],
    soil: 900, coreY: 960, wind: 0.9, hp: 90, err: 14 },
  { name: '陡崖', tip: '崖壁是整块岩石，翻不过去，只能从崖顶落', cx: [180, 1244],
    pts: [[0, 878], [420, 856], [700, 556], [820, 522], [960, 698], [1160, 838], [1440, 856]],
    rockPts: [[0, 920], [420, 890], [660, 700], [720, 600], [800, 560], [880, 700], [1000, 700], [1120, 830], [1250, 880], [1440, 920]],
    soil: 900, coreY: 960, wind: 1.0, hp: 95, err: 12 },
  { name: '铁壁', tip: '地下就是岩层，弹坑一律很浅，落点要算准', cx: [208, 1252],
    pts: [[0, 858], [260, 818], [520, 698], [760, 758], [1000, 656], [1240, 798], [1440, 856]],
    rockPts: [[0, 890], [260, 845], [520, 725], [760, 785], [1000, 683], [1240, 825], [1440, 885]],
    soil: 900, coreY: 960, wind: 1.1, hp: 100, err: 11 },
  { name: '高原', tip: '土层最厚的一张：想怎么刨就怎么刨', cx: [186, 1252],
    pts: [[0, 858], [150, 700], [360, 638], [700, 634], [900, 698], [1100, 818], [1440, 856]],
    rockPts: [[0, 905], [120, 900], [300, 900], [700, 900], [900, 910], [1100, 920], [1300, 920], [1440, 925]],
    soil: 900, coreY: 960, wind: 1.2, hp: 110, err: 10 },
  { name: '乱石岗', tip: '石包是石头、石包之间是土沟，得把炮弹送进土沟', cx: [200, 1240],
    pts: [[0, 866], [200, 738], [380, 596], [540, 776], [700, 636], [880, 776], [1040, 596], [1220, 758], [1440, 862]],
    rockPts: [[0, 930], [220, 800], [320, 610], [400, 600], [460, 700], [520, 910], [600, 930], [660, 900], [700, 650], [760, 650], [820, 900], [880, 930], [960, 690], [1040, 610], [1100, 640], [1160, 800], [1240, 930], [1440, 930]],
    soil: 900, coreY: 960, wind: 1.3, hp: 115, err: 9 },
  { name: '最终要塞', tip: '要塞是整块岩石，只有斜坡上那层土刨得开', cx: [188, 1244],
    pts: [[0, 878], [260, 838], [420, 516], [560, 418], [700, 466], [860, 694], [1060, 842], [1440, 856]],
    rockPts: [[0, 930], [240, 890], [380, 570], [480, 500], [560, 452], [640, 500], [700, 540], [800, 700], [900, 780], [1000, 880], [1100, 930], [1440, 930]],
    soil: 900, coreY: 960, wind: 1.4, hp: 120, err: 8 }
];

function endlessLevelSpec(n) {
  var pts = [[0, 860]], i, k = 4 + (n % 4);
  for (i = 1; i <= k; i++) {
    var x = Math.round(i * AUTH_W / (k + 1));
    var peak = i % 2 === 1;
    var y = peak ? 520 + rng() * 240 : 780 + rng() * 90;
    pts.push([x, Math.round(y)]);
  }
  pts.push([1440, 860]);
  var ax = 180 + Math.round(rng() * 90), bx = AUTH_W - 180 - Math.round(rng() * 90);
  /* 随机地层：62% 的关卡有岩层；其中 35% 的岩带会"中途结束"，
     下面是空腔 —— 天然桥/溶洞，炮弹能从桥下穿过去。 */
  var rockPts = null, rockThick = 0, coreY = 960;
  if (rng() < 0.62) {
    var depth = 26 + rng() * 120;
    rockPts = [];
    for (i = 0; i < pts.length; i++) rockPts.push([pts[i][0], pts[i][1] + depth]);
    if (rng() < 0.35) rockThick = 46 + rng() * 90;
  } else {
    coreY = rng() < 0.5 ? 620 + rng() * 120 : 960;
  }
  return {
    name: '无尽 ' + n, tip: '地形随机，越往后电脑越准越硬',
    pts: pts, cx: [ax, bx], soil: 900, coreY: coreY,
    rockPts: rockPts, rockThick: rockThick,
    wind: Math.min(1.6, 0.6 + n * 0.12), hp: 80 + n * 14, err: Math.max(2.6, 9 - n * 0.6)
  };
}

var curLevel = null;
var selMap = 0;                            /* 当前选中的地图（0..LEVELS.length-1） */

/* 难度星级由电脑准度与血量推出来，给地图选择器当提示 */
function mapStars(i) {
  var lv = LEVELS[i];
  var s = 1 + Math.round((26 - lv.err) / 18 * 3.4);
  if (lv.hp >= 100) s += 1;
  if (lv.wind >= 1.1) s += 1;
  return Math.max(1, Math.min(5, s));
}
function mapLabel(i) {
  var st = '', k;
  for (k = 0; k < mapStars(i); k++) st += '★';
  return (i + 1) + ' · ' + LEVELS[i].name + '  ' + st;
}
function levelSpec(n) {
  if (modeIdx === 1) return endlessLevelSpec(n + 1);
  return LEVELS[Math.min(n, LEVELS.length - 1)];
}

/* ═══════════════════ 6. 武器 ═══════════════════ */

var WEAPONS = [
  { k: 'std', name: '标准弹', sub: '均衡', r: 44, dmg: 34, dr: 96, split: 0, drill: 0 },
  { k: 'heavy', name: '重弹', sub: '坑大', r: 68, dmg: 46, dr: 142, split: 0, drill: 0 },
  { k: 'tri', name: '三连弹', sub: '一分为三', r: 30, dmg: 22, dr: 68, split: 3, drill: 0 },
  { k: 'drill', name: '钻地弹', sub: '钻入岩层', r: 52, dmg: 42, dr: 116, split: 0, drill: 46, rockDig: 1 }
];
var weapon = 0;
function weaponUnlocked(i) { return i >= 0 && i < WEAPONS.length; }   /* 四种炮弹开局就能用 */

/* ═══════════════════ 7. 状态 ═══════════════════ */

var MODE_TOTAL = 3;
var modeIdx = 0;
var phase = 'intro';        // intro | aim | fly | impact | enemyAim | levelClear（无尽过关过渡）| over
var turn = 0, levelIdx = 0;
var wind = 0, windTarget = 0;
var paused = false, muted = false;
var phaseT = 0, windT = 0;
var stats = { shots: 0, hits: 0, dmgDealt: 0, dmgTaken: 0, turns: 0, startT: 0 };
var curTrailX = new Float32Array(TRAIL_MAX), curTrailY = new Float32Array(TRAIL_MAX), curTrailN = 0;
var prevTrailX = new Float32Array(TRAIL_MAX), prevTrailY = new Float32Array(TRAIL_MAX), prevTrailN = 0;
var trailTick = 0;
/* 表现层专用的随机源：镜头抖动与粒子的随机数绝不能从玩法随机流里取，
   否则帧率一变、随机流就错位，"同种子同输入 = 同结果"的契约会破。 */
var vrng = mulberry32(0x51ED2701);

var cannons = [
  { x: CANNON_X[0], y: 800, angle: 45, power: 62, hp: HP_MAX, hpMax: HP_MAX, side: 1, alive: true, recoil: 0, barrel: 0, flash: 0, main: COL.cannonA, dark: COL.cannonADark },
  { x: CANNON_X[1], y: 800, angle: 45, power: 62, hp: HP_MAX, hpMax: HP_MAX, side: -1, alive: true, recoil: 0, barrel: 0, flash: 0, main: COL.cannonB, dark: COL.cannonBDark }
];

var shells = [];
for (var si = 0; si < SHOT_CAP; si++) shells.push({ on: false, owner: 0, w: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, smoke: 0, splitLeft: 0 });

/* ═══════════════════ 8. 相机 ═══════════════════ */

var cam = { x: W / 2, y: WORLD_H / 2, z: CAM_Z_IDLE, tx: W / 2, ty: WORLD_H / 2, tz: CAM_Z_IDLE, shake: 0, shakeX: 0, shakeY: 0 };
var followX = 0, followY = 0, followOn = false;

function camClamp() {
  var z = cam.tz;                            // 用目标缩放算边界；用当前缩放会在缓动结束后停在非法位置
  var hw = W / (2 * z), hh = H / (2 * z);
  if (cam.tx < hw) cam.tx = hw;
  if (cam.tx > WORLD_W - hw) cam.tx = WORLD_W - hw;
  var top = hh - SKY_MARGIN;                 // 天空留白：高抛时镜头可以跟出世界上边界
  if (cam.ty < top) cam.ty = top;
  var bot = WORLD_H - hh + 100;              // 世界底部之下留 100px，炮沉到基岩也留得住
  if (cam.ty > bot) cam.ty = bot;
}
function camPanTo(x, z, y) {
  cam.tx = x; cam.tz = z;
  cam.ty = (y === undefined || y === null) ? WORLD_H - H / (2 * z) - 40 : y;
  camClamp();
}
/* 把镜头对准某一方的炮：炮落在画面中下部，地面始终可见 */
function camLookAtCannon(i, z) {
  var c = cannons[i], hh = H / (2 * z);
  var ty = c.y - hh * 0.42;
  var maxTy = WORLD_H - hh + 100;
  if (ty > maxTy) ty = maxTy;
  camPanTo(c.x, z, ty);
}
function camUpdate(dt) {
  var k = 1 - Math.exp(-7 * dt), kz = 1 - Math.exp(-9 * dt);
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  cam.z += (cam.tz - cam.z) * kz;
  if (cam.shake > 0) {
    cam.shake = Math.max(0, cam.shake - dt * 26);
    var a = cam.shake;
    cam.shakeX = (vrng() * 2 - 1) * a;
    cam.shakeY = (vrng() * 2 - 1) * a;
  } else { cam.shakeX = 0; cam.shakeY = 0; }
}
function camFollow(x, y, z) {
  var hh = H / (2 * z);
  followX = x; followY = y;
  cam.tz = z;
  cam.tx = x;
  /* 跟弹时别把地面甩出画面：下限由地面决定，否则高抛时满屏都是天空 */
  var groundY = terrainHeightAt(x);
  if (groundY < 380) groundY = 380;
  var ty = y + hh * 0.30;
  var minTy = groundY - hh + 30;
  if (ty < minTy) ty = minTy;
  cam.ty = ty;
  camClamp();
}

/* ═══════════════════ 9. 输入 ═══════════════════ */

var held = { left: false, right: false, up: false, down: false };
var repeatT = { left: 0, right: 0, up: 0, down: 0 };
var KEYMAP = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down'
};

function aimActive() {
  if (paused || phase === 'over' || phase === 'intro') return false;
  if (phase === 'aim') return true;
  return false;
}
function playerSide() { return modeIdx === 2 ? turn : 0; }

/* d = 屏幕方向（-1 往左摆、+1 往右摆）。
   炮口相对炮身的偏移量随朝向量符号翻转，所以这里要按 side 镜像——
   否则左炮按 → 时炮口会往左上走，看起来就是"左右反了"。 */
function adjustAngle(d) {
  if (!aimActive()) return;
  var c = cannons[turn];
  c.angle = Math.min(ANG_MAX, Math.max(ANG_MIN, c.angle - d * c.side));
  aimDirty();
}
function adjustPower(d) {
  if (!aimActive()) return;
  var c = cannons[turn];
  c.power = Math.min(PWR_MAX, Math.max(PWR_MIN, c.power + d));
  aimDirty();
}
function aimDirty() { syncHud(); }
function cycleWeapon(d) {
  var n = WEAPONS.length, i, k;
  for (i = 1; i <= n; i++) {
    k = ((weapon + d * i) % n + n) % n;
    if (weaponUnlocked(k)) { weapon = k; syncHud(); sfxClick(); return; }
  }
}
function fireFromTurn() {
  if (phase !== 'aim' || paused) return false;
  return launch(turn);
}

/* 触屏 / 鼠标：拖动 = 调角度与力度（横向角度、纵向力度），松手发射 */
var drag = { on: false, x: 0, y: 0, a0: 0, p0: 0, moved: 0 };
function pointerWorld(ev) {
  var r = el.game.getBoundingClientRect();
  var sx = (ev.clientX - r.left) / r.width * W;
  var sy = (ev.clientY - r.top) / r.height * H;
  return { x: (sx - (W / 2 + cam.shakeX)) / cam.z + cam.x, y: (sy - (H / 2 + cam.shakeY)) / cam.z + cam.y };
}
function pointerDown(ev) {
  unlockAudio();
  if (phase === 'intro') { startRun(); return; }
  if (phase !== 'aim' || paused) return;
  drag.on = true; drag.x = ev.clientX; drag.y = ev.clientY; drag.moved = 0;
  var c = cannons[turn]; drag.a0 = c.angle; drag.p0 = c.power;
}
function pointerMove(ev) {
  if (!drag.on) return;
  var dx = ev.clientX - drag.x, dy = drag.y - ev.clientY;
  drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
  var c = cannons[turn];
  c.angle = Math.min(ANG_MAX, Math.max(ANG_MIN, drag.a0 - dx * 0.14 * c.side));
  c.power = Math.min(PWR_MAX, Math.max(PWR_MIN, drag.p0 + dy * 0.22));
  syncHud();
}
function pointerUp() {
  if (!drag.on) return;
  drag.on = false;
  unlockAudio();
  if (phase === 'aim' && !paused) launch(turn);
}

/* ═══════════════════ 10. 物理 ═══════════════════ */

/* 线段与圆求交（返回进入参数 t∈[0,1]，无交返回 -1）。
   用线段而不是点，是为了高速弹也不会"一帧穿过"炮身与小兵。 */
function segCircleT(x0, y0, x1, y1, cx, cy, r) {
  var dx = x1 - x0, dy = y1 - y0;
  var fx = x0 - cx, fy = y0 - cy;
  var a = dx * dx + dy * dy;
  if (a < 1e-6) return (fx * fx + fy * fy <= r * r) ? 0 : -1;
  var b = 2 * (fx * dx + fy * dy);
  var c = fx * fx + fy * fy - r * r;
  var disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  var sq = Math.sqrt(disc);
  var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  if (t1 < 0 && t2 > 1) return 0;
  return -1;
}

/* 这一帧的弹道有没有蹭到炮身或小兵 */
function unitHit(x0, y0, x1, y1) {
  var i, c, t, sx, sy, bestT = 2, bestI = -1, bestX = 0, bestY = 0;
  for (i = 0; i < 2; i++) {
    c = cannons[i];
    if (!c.alive) continue;
    t = segCircleT(x0, y0, x1, y1, c.x, c.y - CANNON_HH * 0.55, CANNON_HW * 0.95);
    if (t >= 0 && t < bestT) { bestT = t; bestI = i; }
    sx = c.x - c.side * 42; sy = c.y - 20;
    t = segCircleT(x0, y0, x1, y1, sx, sy, 13);
    if (t >= 0 && t < bestT) { bestT = t; bestI = i; }
  }
  if (bestI < 0) return null;
  bestX = x0 + (x1 - x0) * bestT;
  bestY = y0 + (y1 - y0) * bestT;
  if (bestY >= terrainHeightAt(bestX)) return null;    /* 接触点在地面之下 → 交给地形判定 */
  return { x: bestX, y: bestY, i: bestI };
}

function freeShell() {
  for (var i = 0; i < SHOT_CAP; i++) if (!shells[i].on) return shells[i];
  return null;
}
function activeShells() {
  var n = 0;
  for (var i = 0; i < SHOT_CAP; i++) if (shells[i].on) n++;
  return n;
}
function muzzlePoint(c) {
  var a = c.angle * Math.PI / 180;
  return { x: c.x + c.side * Math.cos(a) * MUZZLE_LEN, y: c.y - CANNON_HH - Math.sin(a) * MUZZLE_LEN };
}

function launch(who) {
  var c = cannons[who];
  if (!c.alive) return false;
  var sh = freeShell();
  if (!sh) return false;
  var a = c.angle * Math.PI / 180;
  var v = SPEED_BASE + c.power * SPEED_PER;
  var m = muzzlePoint(c);
  sh.on = true; sh.owner = who; sh.w = weapon; sh.age = 0; sh.smoke = 0;
  sh.splitLeft = WEAPONS[weapon].split;
  sh.drillLeft = WEAPONS[weapon].drill;
  sh.x = m.x; sh.y = m.y;
  sh.vx = c.side * Math.cos(a) * v;
  sh.vy = -Math.sin(a) * v;
  c.recoil = 1;
  c.flash = 0.75 + WEAPONS[weapon].r / 90;      /* 重弹的火光更大 */
  curTrailN = 0;
  stats.shots++;
  phase = 'fly'; phaseT = 0;
  cam.tz = CAM_Z_FLY;
  sfxFire();
  syncHud();
  return true;
}

function despawn(sh) { sh.on = false; }
function shellsGone() { return activeShells() === 0; }

function stepShell(sh, dt) {
  var wp = WEAPONS[sh.w];
  sh.age += dt;
  var px = sh.x, py = sh.y;
  sh.vy += GRAV * dt;
  sh.vx += wind * WIND_K * dt;
  sh.x += sh.vx * dt;
  sh.y += sh.vy * dt;

  if (sh.x < -60 || sh.x > WORLD_W + 60) { missShell(sh); return; }
  if (sh.y > WORLD_H + 160) { missShell(sh); return; }

  /* 命中炮身 / 小兵：就地起爆，不允许穿过去 */
  var uh = unitHit(px, py, sh.x, sh.y);
  if (uh) {
    sh.x = uh.x; sh.y = uh.y;
    explodeShell(sh, uh.x, uh.y, true);
    return;
  }

  /* 三连弹：飞行 0.42 秒后一分为三 */
  if (wp.split > 0 && sh.splitLeft > 0 && sh.age > 0.42) {
    var sp = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy) || 1;
    var base = Math.atan2(sh.vy, sh.vx);
    var extra = freeShell();
    if (extra) {
      var a2 = base - 0.20;
      extra.on = true; extra.owner = sh.owner; extra.w = sh.w; extra.age = sh.age; extra.smoke = 0;
      extra.splitLeft = 0; extra.drillLeft = 0;
      extra.x = sh.x; extra.y = sh.y;
      extra.vx = Math.cos(a2) * sp * 0.92; extra.vy = Math.sin(a2) * sp * 0.92;
    }
    extra = freeShell();
    if (extra) {
      var a3 = base + 0.20;
      extra.on = true; extra.owner = sh.owner; extra.w = sh.w; extra.age = sh.age; extra.smoke = 0;
      extra.splitLeft = 0; extra.drillLeft = 0;
      extra.x = sh.x; extra.y = sh.y;
      extra.vx = Math.cos(a3) * sp * 0.92; extra.vy = Math.sin(a3) * sp * 0.92;
    }
    sh.splitLeft = 0;
    sh.vx *= 0.92; sh.vy *= 0.92;
    sfxClick();
  }

  if (solidAt(sh.x, sh.y)) {
    var ci = clampCol(sh.x);
    /* 钻地弹：土和岩带都能钻，钻满 46 像素或碰到基岩才炸 */
    if (wp.drill > 0 && sh.drillLeft > 0 && sh.y < digFloor(ci) - 2 && sh.y < WORLD_H) {
      terrainCarve(sh.x, sh.y, 17, true);
      sh.drillLeft -= 26;
      sh.y += 22;
      sh.vx *= 0.3;
      sh.vy = Math.abs(sh.vy) * 0.22 + 60;
      if (sh.y >= rock[ci]) spawnStone(sh.x, sh.y, 5); else spawnDirt(sh.x, sh.y, 5);
      sfxClick();
      return;
    }
    explodeShell(sh, sh.x, sh.y);
  }
}
function missShell(sh) {
  despawn(sh);
  spawnSmoke(sh.x < 0 ? 0 : WORLD_W, WORLD_H * 0.5, 6, 2.2);
}

/* ═══════════════════ 11. 命中 / 伤害 / 胜负 ═══════════════════ */

function explodeShell(sh, x, y, onUnit) {
  var wp = WEAPONS[sh.w];
  var vx = sh.vx, vy = sh.vy;
  despawn(sh);
  worldExplode(x, y, wp, sh.owner, vx, vy, onUnit);
}

function worldExplode(x, y, wp, owner, vx, vy, onUnit) {
  if (typeof vx !== 'number') { vx = 0; vy = 300; }            // 直接调用（测试/工具）当成垂直落下
  var blast = terrainBlast(x, y, wp, vx, vy, onUnit ? 0.62 : 1);
  lastBlast = blast;
  spawnBurstDir(x, y, blast.a, vx, vy);
  spawnBurst(x, y, wp.r);
  if (blast.rockCut > 0 || blast.rockCols > 0) {   /* 打到岩石：飞碎石、声音更硬 */
    spawnStone(x, y, Math.min(22, 4 + blast.rockCols + blast.broke * 3));
    sfxRock();
  }
  cam.shake = Math.min(12, 3 + wp.r * 0.08);
  sfxImpact(wp.r);
  lastImpactX = x; lastImpactY = y;

  var i, c, d, dmg, gotTarget = false;
  for (i = 0; i < 2; i++) {
    c = cannons[i];
    if (!c.alive) continue;
    d = Math.sqrt((c.x - x) * (c.x - x) + (c.y - 8 - y) * (c.y - 8 - y));
    if (d < wp.dr) {
      dmg = Math.round(wp.dmg * (1 - d / wp.dr));
      if (dmg > 0) { hurt(i, dmg, owner); if (i !== owner) gotTarget = true; }
    }
  }
  if (gotTarget) stats.hits++;
  settleCannons();
  aiInvalidate();
}

function hurt(i, dmg, owner) {
  var c = cannons[i];
  c.hp = Math.max(0, c.hp - dmg);
  floatText(c.x, c.y - 62, '-' + dmg);
  if (i === 0) stats.dmgTaken += dmg; else stats.dmgDealt += dmg;
  if (c.hp <= 0) {
    c.alive = false;
    spawnBurst(c.x, c.y - 10, 46);
    over(1 - i);            /* 参数是"赢家的下标"：0 = 左侧（单人模式即玩家） */
  }
}

function settleCannons() {
  for (var i = 0; i < 2; i++) {
    var c = cannons[i];
    c.y = terrainHeightAt(c.x);
  }
}

function targetOf(owner) { return 1 - owner; }

function over(winnerIdx) {
  /* 无尽模式里"赢一关"不是结束：满血进入下一关，地形与难度重新生成。
     早先这里直接走结算，导致无尽永远只有第 1 关（HUD 恒显示"无尽 1"）。 */
  if (winnerIdx === 0 && modeIdx === 1) {
    phase = 'levelClear'; phaseT = 0;
    followOff();
    commitTrail();
    lastWin = true;
    sfxWin();
    setToast('第 ' + (levelIdx + 1) + ' 关通过', '满血续战 · 下一关地形重掷、电脑更准', 1.5);
    syncHud();
    return;
  }
  phase = 'over'; phaseT = 0;
  paused = false;
  followOff();
  commitTrail();
  lastWin = winnerIdx === 0;
  if (lastWin) sfxWin(); else sfxLose();
  showResult(lastWin);
  syncHud();
}

/* ═══════════════════ 12. AI ═══════════════════ */

var ai = {
  on: false, valid: false, sig: -1, i: 0, list: null, listN: 0,
  bestA: 45, bestP: 60, bestD: 1e9, stage: 0, err: 10
};
var aiAngles = new Float32Array(40 * 20);
var aiPowers = new Float32Array(40 * 20);

/* 失效 = 把解对应的地形签名标脏；下一帧/下一次求解会自动重算。
   （早先这里写的是 ai.valid=false，导致搜索期间每帧都被判定为"需要重算"而反复从头开始） */
function aiInvalidate() { ai.sig = -1; ai.valid = false; ai.on = false; }

/* 三级细化：粗搜一格功率=6，早先细化窗口只有 ±5，永远跳不出粗格子，
   于是"最优解"系统性偏几十到几百像素（电脑因此打不中人）。
   现在每级窗口是上一级步长的若干倍，逐级收敛到几像素。 */
var AI_REFINE = [
  { wa: 3.0, wp: 7.0, sa: 0.5, sp: 1.0 },
  { wa: 0.8, wp: 1.6, sa: 0.12, sp: 0.22 },
  { wa: 0.2, wp: 0.4, sa: 0.03, sp: 0.06 }
];
function aiBuildList() {
  var n = 0, a, p;
  if (ai.stage === 0) {
    for (a = 10; a <= 88; a += 2.5) for (p = 16; p <= 100; p += 6) { aiAngles[n] = a; aiPowers[n] = p; n++; }
  } else {
    var r = AI_REFINE[ai.stage - 1], ca = ai.bestA, cp = ai.bestP, ang, pw;
    for (a = -r.wa; a <= r.wa + 1e-6; a += r.sa) {
      for (p = -r.wp; p <= r.wp + 1e-6; p += r.sp) {
        ang = ca + a; pw = cp + p;
        if (ang < ANG_MIN || ang > ANG_MAX || pw < PWR_MIN || pw > PWR_MAX) continue;
        aiAngles[n] = ang; aiPowers[n] = pw; n++;
        if (n >= aiAngles.length) break;
      }
      if (n >= aiAngles.length) break;
    }
  }
  ai.listN = n; ai.i = 0;
}

function aiSimulate(x0, y0, side, angDeg, power, maxT) {
  var a = angDeg * Math.PI / 180, v = SPEED_BASE + power * SPEED_PER;
  /* 起点必须和真实炮口完全一致：早先这里写 34、真实炮口是 CANNON_HW+16=42，
     AI 每次都恒定偏 25px（预测再准也打不中）。 */
  var x = x0 + side * Math.cos(a) * MUZZLE_LEN, y = y0 - CANNON_HH - Math.sin(a) * MUZZLE_LEN;
  var vx = side * Math.cos(a) * v, vy = -Math.sin(a) * v;
  /* 必须和世界物理用同一个步长：欧拉积分对步长敏感，早先用 1/60 预测、
     实际按 1/120 模拟，解出来的"最优解"会系统性偏出几十到几百像素。 */
  var dt = STEP, t = 0, g, minClr = 1e9, clr;
  while (t < maxT) {
    vy += GRAV * dt; vx += wind * WIND_K * dt;
    x += vx * dt; y += vy * dt; t += dt;
    if (x < -60 || x > WORLD_W + 60) break;
    if (y > WORLD_H + 120) break;
    if (solidAt(x, y)) return { x: x, y: y, t: t, ok: true, minClr: -1 };
    clr = terrainHeightAt(x) - y;            /* 空腔里不算擦地（那里根本没有地） */
    if (clr >= 0 && clr < minClr) minClr = clr;
  }
  return { x: x, y: y, t: t, ok: false, minClr: minClr };
}

/* 不做"从上一发学习"的偏移修正：地形是多峰的，小幅修正会把落点推进另一个分支，
   实测命中率会在 58px 与 200px+ 之间来回震荡。难度只由每关的 err 决定。 */

/* 每帧摊销推进搜索，敌方回合开始时已有解 */
function aiTick(budget) {
  if (phase === 'fly' || phase === 'over' || paused) return;
  if (modeIdx === 2) return;
  if (ai.sig !== terrainSig) aiReset();
  if (!ai.on) return;
  var steps = 0, c = cannons[1];
  var tx = cannons[0].x, ty = cannons[0].y - 8;
  while (ai.i < ai.listN && steps < budget) {
    var ang = aiAngles[ai.i], pw = aiPowers[ai.i];
    var r = aiSimulate(c.x, c.y, c.side, ang, pw, 5.2);
    var d = Math.sqrt((r.x - tx) * (r.x - tx) + (r.y - ty) * (r.y - ty));
    if (!r.ok) d += 260;                       // 飞出界 = 极差
    if (r.minClr >= 0 && r.minClr < 26) d += (26 - r.minClr) * 3.2;   // 擦地弹道在噪声下会翻车
    if (d < ai.bestD) { ai.bestD = d; ai.bestA = ang; ai.bestP = pw; }
    ai.i++; steps += Math.round(r.t / STEP);
  }
  if (ai.i >= ai.listN) {
    if (ai.stage < AI_REFINE.length) { ai.stage++; aiBuildList(); }
    else { ai.on = false; ai.valid = true; ai.sig = terrainSig; }
  }
}

function aiReset() {
  ai.on = true; ai.valid = false; ai.sig = terrainSig; ai.stage = 0;
  ai.bestD = 1e9; ai.bestA = 60; ai.bestP = 60;
  aiBuildList();
}

function aiSolution() {
  var n1 = (rng() + rng() + rng() - 1.5) * 1.1, n2 = (rng() + rng() + rng() - 1.5) * 1.1;
  var err = ai.err;
  var a = Math.min(ANG_MAX, Math.max(ANG_MIN, ai.bestA + n1 * err * 0.42));
  var p = Math.min(PWR_MAX, Math.max(PWR_MIN, ai.bestP + n2 * err * 0.85));
  return { angle: a, power: p };
}


/* ═══════════════════ 13. 粒子 ═══════════════════ */

var parts = [];
for (var pi = 0; pi < MAX_PARTS; pi++) parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, col: '#fff', type: 0 });
var partN = 0;
var floats = [];
for (var fi = 0; fi < 10; fi++) floats.push({ on: false, x: 0, y: 0, life: 0, txt: '' });
var flashes = [];
for (var fli = 0; fli < 8; fli++) flashes.push({ on: false, x: 0, y: 0, life: 0, max: 1, r: 0 });

function freePart() {
  for (var i = 0; i < MAX_PARTS; i++) if (!parts[i].on) return parts[i];
  return null;
}
function spawnPart(x, y, vx, vy, life, size, col, type) {
  var p = freePart();
  if (!p) return null;
  p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life; p.max = life; p.size = size; p.col = col; p.type = type;
  return p;
}
function spawnDirt(x, y, n) {
  for (var i = 0; i < n; i++) {
    spawnPart(x + (vrng() * 2 - 1) * 14, y - vrng() * 12,
      (vrng() * 2 - 1) * 90, -60 - vrng() * 130, 0.7 + vrng() * 0.6,
      2 + vrng() * 3, vrng() < 0.35 ? COL.soilDark : COL.soil, 0);
  }
}
function spawnSmoke(x, y, n, scale) {
  for (var i = 0; i < n; i++) {
    spawnPart(x + (vrng() * 2 - 1) * 10, y + (vrng() * 2 - 1) * 10,
      (vrng() * 2 - 1) * 24, -18 - vrng() * 26, 0.9 + vrng() * 0.9,
      (2.4 + vrng() * 2.6) * scale, '#ffffff', 1);
  }
}
function spawnSpark(x, y, n, col) {
  for (var i = 0; i < n; i++) {
    var a = vrng() * Math.PI * 2, s = 90 + vrng() * 240;
    spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.22 + vrng() * 0.3, 1.5 + vrng() * 2, col || COL.sunCore, 2);
  }
}
function spawnBurstDir(x, y, r, vx, vy) {
  var sp = Math.sqrt(vx * vx + vy * vy) || 1;
  var ux = vx / sp, uy = vy / sp;
  var base = Math.atan2(uy, ux), i, ang, sd, d;
  for (i = 0; i < 22; i++) {
    ang = base + (vrng() * 2 - 1) * 1.05;
    sd = 110 + vrng() * 260;
    spawnPart(x + (vrng() * 2 - 1) * 14, y - vrng() * 10,
      Math.cos(ang) * sd, Math.sin(ang) * sd - 40,
      0.75 + vrng() * 0.6, 2 + vrng() * 3,
      vrng() < 0.35 ? COL.soilDark : COL.soil, 0);
  }
  for (i = 0; i < 12; i++) {
    d = (vrng() * 2 - 1) * r * 0.8;
    spawnPart(x + d, y, Math.cos(base) * (60 + vrng() * 90) + (vrng() * 2 - 1) * 40,
      Math.sin(base) * 70 - 90 - vrng() * 120, 0.8 + vrng() * 0.7, 2 + vrng() * 3, COL.soilDark, 0);
  }
}

function spawnStone(x, y, n) {
  for (var i = 0; i < n; i++) {
    var a = vrng() * Math.PI * 2, s = 120 + vrng() * 220;
    spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s - 60,
      0.6 + vrng() * 0.5, 2 + vrng() * 2.6,
      vrng() < 0.5 ? COL.rock : COL.rockDark, 0);
  }
}

function spawnBurst(x, y, r) {
  var i;
  var f = null;
  for (i = 0; i < flashes.length; i++) if (!flashes[i].on) { f = flashes[i]; break; }
  if (f) { f.on = true; f.x = x; f.y = y; f.life = 0.28; f.max = 0.28; f.r = r * 0.75; }
  spawnSpark(x, y, 22, COL.sunCore);
  spawnDirt(x, y, 26);
  spawnSmoke(x, y, 14, r / 60);
  var d;
  for (i = 0; i < 10; i++) {
    d = (vrng() * 2 - 1) * r * 0.7;
    spawnPart(x + d, y, (vrng() * 2 - 1) * 70, -120 - vrng() * 170, 0.8 + vrng() * 0.7,
      2 + vrng() * 3, COL.soilDark, 0);
  }
}
function floatText(x, y, txt) {
  for (var i = 0; i < floats.length; i++) {
    var f = floats[i];
    if (f.on) continue;
    f.on = true; f.x = x; f.y = y; f.life = 1.1; f.txt = txt;
    return;
  }
}
function stepParts(dt) {
  var i, p, f, n = 0;
  for (i = 0; i < MAX_PARTS; i++) {
    p = parts[i];
    if (!p.on) continue;
    p.life -= dt;
    if (p.life <= 0) { p.on = false; continue; }
    if (p.type === 0) { p.vy += 620 * dt; p.vx *= 0.99; }
    else if (p.type === 1) { p.vy -= 26 * dt; p.size += 12 * dt; }
    else { p.vy += 180 * dt; p.vx *= 0.94; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.type === 0 && p.y > terrainHeightAt(p.x) - 1) {
      p.y = terrainHeightAt(p.x) - 1; p.vy *= -0.24; p.vx *= 0.5;
      if (Math.abs(p.vy) < 12) p.life = Math.min(p.life, 0.12);
    }
    n++;
  }
  partN = n;
  for (i = 0; i < floats.length; i++) {
    f = floats[i];
    if (!f.on) continue;
    f.life -= dt; f.y -= 34 * dt;
    if (f.life <= 0) f.on = false;
  }
  for (i = 0; i < flashes.length; i++) {
    f = flashes[i];
    if (!f.on) continue;
    f.life -= dt;
    if (f.life <= 0) f.on = false;
  }
}

/* ═══════════════════ 14. 音效（WebAudio 合成，零外部文件） ═══════════════════ */

var AC = null, master = null, noiseBuf = null;
var whistle = null, whistleGain = null;
var sfxPlays = 0, lastPlay = -1;

function unlockAudio() {
  if (AC || muted) return;
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = 0.28;
    master.connect(AC.destination);
    var n = Math.floor(AC.sampleRate * 0.5), buf = AC.createBuffer(1, n, AC.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    if (AC.state === 'suspended' && AC.resume) AC.resume();
  } catch (e) { AC = null; }
}
function gate() {
  if (!AC || muted) return false;
  var t = AC.currentTime;
  if (t === lastPlay) return false;
  lastPlay = t;
  return true;
}
function noise(dur, gain, freq, q) {
  var src = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  src.buffer = noiseBuf;
  f.type = 'lowpass'; f.frequency.value = freq; if (q) f.Q.value = q;
  g.gain.setValueAtTime(gain, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(); src.stop(AC.currentTime + dur);
}
function tone(f0, f1, dur, gain, type) {
  var o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, AC.currentTime);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), AC.currentTime + dur);
  g.gain.setValueAtTime(gain, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
  o.connect(g); g.connect(master);
  o.start(); o.stop(AC.currentTime + dur);
}
function sfxFire() { if (!gate()) return; sfxPlays++; noise(0.22, 0.5, 900, 0.7); tone(240, 70, 0.26, 0.42, 'triangle'); startWhistle(); }
function sfxImpact(r) { if (!gate()) return; sfxPlays++; noise(0.42 + r / 400, 0.55, 420, 0.8); tone(110, 38, 0.4, 0.5, 'sine'); stopWhistle(); }
function sfxClick() { if (!gate()) return; sfxPlays++; noise(0.05, 0.22, 2600); }
function sfxRock() { if (!gate()) return; sfxPlays++; noise(0.09, 0.3, 5200, 1.2); }   /* 砸在岩石上：短促、更亮 */
function sfxTurn() { if (!gate()) return; sfxPlays++; tone(560, 560, 0.1, 0.16, 'square'); setTimeout(function () { if (AC && !muted) tone(760, 760, 0.12, 0.16, 'square'); }, 110); }
function sfxWin() { if (!gate()) return; sfxPlays++; [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { if (AC && !muted) tone(f, f, 0.18, 0.2, 'triangle'); }, i * 120); }); }
function sfxLose() { if (!gate()) return; sfxPlays++; [392, 330, 262].forEach(function (f, i) { setTimeout(function () { if (AC && !muted) tone(f, f * 0.98, 0.26, 0.2, 'triangle'); }, i * 150); }); }

function startWhistle() {
  if (!AC || muted || whistle) return;
  whistle = AC.createOscillator();
  whistleGain = AC.createGain();
  whistle.type = 'triangle';
  whistle.frequency.value = 700;
  whistleGain.gain.value = 0.0;
  whistleGain.gain.linearRampToValueAtTime(0.10, AC.currentTime + 0.12);
  whistle.connect(whistleGain); whistleGain.connect(master);
  whistle.start();
}
function stopWhistle() {
  if (!whistle) return;
  try { whistleGain.gain.cancelScheduledValues(AC.currentTime); whistleGain.gain.setValueAtTime(whistleGain.gain.value, AC.currentTime); whistleGain.gain.linearRampToValueAtTime(0, AC.currentTime + 0.12); whistle.stop(AC.currentTime + 0.16); } catch (e) { /* 忽略 */ }
  whistle = null; whistleGain = null;
}
function whistleFollow() {
  if (!whistle || !AC) return;
  var best = null, bs = -1, i, sh, sp;
  for (i = 0; i < SHOT_CAP; i++) {
    sh = shells[i];
    if (!sh.on) continue;
    sp = Math.abs(sh.vx) + Math.abs(sh.vy) * 0.4;
    if (sp > bs) { bs = sp; best = sh; }
  }
  if (!best) { stopWhistle(); return; }
  var f = 190 + Math.min(1250, Math.max(0, (WORLD_H - best.y) * 0.55 + bs * 0.7));
  whistle.frequency.setTargetAtTime(f, AC.currentTime, 0.05);
}
function setMute(v) {
  muted = !!v;
  save.muted = muted;
  putSave();
  if (master) master.gain.value = muted ? 0 : 0.28;
  if (muted) stopWhistle();
  syncHud();
}

/* ═══════════════════ 15. 渲染 ═══════════════════ */

var gctx = null, skyGrad = null, sc = 1, dpr = 1, resizeTick = 0;

function resizeCanvas() {
  var rect = el.game.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  var cw = Math.max(300, Math.round(rect.width * dpr));
  var ch = Math.max(400, Math.round(rect.height * dpr));
  if (el.game.width !== cw || el.game.height !== ch) {
    el.game.width = cw; el.game.height = ch;
    skyGrad = null;
  }
  sc = cw / W;
}

function worldTransform() {
  var s = cam.z * sc;
  gctx.setTransform(s, 0, 0, s,
    sc * (W / 2 + cam.shakeX - cam.x * cam.z),
    sc * (H / 2 + cam.shakeY - cam.y * cam.z));
}
function screenTransform() { gctx.setTransform(sc, 0, 0, sc, 0, 0); }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSky() {
  screenTransform();
  if (!skyGrad) {
    skyGrad = gctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, COL.skyTop);
    skyGrad.addColorStop(0.55, COL.skyMid);
    skyGrad.addColorStop(1, COL.skyBot);
  }
  gctx.fillStyle = skyGrad;
  gctx.fillRect(0, 0, W, H);
  var sx = W * 0.78 - (cam.x - WORLD_W / 2) * 0.06 * cam.z;
  var sy = 96 - (cam.y - WORLD_H / 2) * 0.05 * cam.z;
  gctx.beginPath(); gctx.arc(sx, sy, 38, 0, 6.2832); gctx.fillStyle = COL.sun; gctx.fill();
  gctx.beginPath(); gctx.arc(sx, sy, 24, 0, 6.2832); gctx.fillStyle = COL.sunCore; gctx.fill();
}

var clouds = [];
function initClouds() {
  clouds.length = 0;
  for (var i = 0; i < 9; i++) {
    clouds.push({ x: (i * 97 + 40) % WORLD_W, y: 46 + (i % 4) * 54, w: 86 + (i % 3) * 46, h: 22 + (i % 3) * 8, par: 0.30 + (i % 3) * 0.12 });
  }
}
function drawClouds() {
  worldTransform();
  gctx.fillStyle = COL.cloud;
  for (var i = 0; i < clouds.length; i++) {
    var c = clouds[i];
    var cx = c.x + (cam.x - WORLD_W / 2) * (1 - c.par);
    cx = ((cx % WORLD_W) + WORLD_W) % WORLD_W;
    var cy = c.y + (cam.y - WORLD_H / 2) * (1 - c.par) * 0.6;
    for (var k = -1; k <= 1; k++) {
      var px = cx + k * WORLD_W;
      if (px < cam.x - 520 || px > cam.x + 520) continue;
      gctx.globalAlpha = 0.82;
      gctx.beginPath();
      gctx.ellipse(px, cy, c.w * 0.5, c.h * 0.5, 0, 0, 6.2832);
      gctx.ellipse(px - c.w * 0.28, cy + 4, c.w * 0.32, c.h * 0.42, 0, 0, 6.2832);
      gctx.ellipse(px + c.w * 0.30, cy + 3, c.w * 0.30, c.h * 0.40, 0, 0, 6.2832);
      gctx.fill();
    }
  }
  gctx.globalAlpha = 1;
}

function drawTerrain() {
  var x, b;
  worldTransform();

  /* 岩带：从岩顶沿到岩底（岩底低于基岩时被基岩板盖住） */
  gctx.beginPath();
  gctx.moveTo(-4, rock[0]);
  for (x = 0; x < WORLD_W; x += 2) gctx.lineTo(x, rock[x]);
  gctx.lineTo(WORLD_W + 4, rock[WORLD_W - 1]);
  for (x = WORLD_W - 1; x >= 0; x -= 2) {
    b = rockBot[x] > FLOOR_Y ? FLOOR_Y : rockBot[x];
    gctx.lineTo(x, b);
  }
  b = rockBot[0] > FLOOR_Y ? FLOOR_Y : rockBot[0];
  gctx.lineTo(-4, b);
  gctx.closePath();
  gctx.fillStyle = COL.rock;
  gctx.fill();

  /* 岩顶硬边：画在土之前，所以只在岩石露出来的地方可见 */
  gctx.beginPath();
  gctx.moveTo(0, rock[0]);
  for (x = 0; x < WORLD_W; x += 2) gctx.lineTo(x, rock[x]);
  gctx.strokeStyle = COL.rockDark;
  gctx.lineWidth = 2.4;
  gctx.stroke();

  /* 岩带底面：天然桥/溶洞的洞顶，露在外面才看得见 */
  gctx.beginPath();
  var anyBot = false;
  for (x = 0; x < WORLD_W; x += 2) {
    b = rockBot[x] > FLOOR_Y ? FLOOR_Y : rockBot[x];
    if (!anyBot) { gctx.moveTo(x, b); anyBot = true; } else gctx.lineTo(x, b);
  }
  gctx.strokeStyle = COL.caveShade;
  gctx.lineWidth = 3;
  gctx.stroke();

  /* 土只画"地表到岩顶"这一层：早先是整块填到底，把岩石整个盖住了，
     所以炸开的坑里看不到石头 */
  gctx.beginPath();
  gctx.moveTo(-4, surf[0]);
  for (x = 0; x < WORLD_W; x += 2) gctx.lineTo(x, surf[x]);
  gctx.lineTo(WORLD_W + 4, surf[WORLD_W - 1]);
  for (x = WORLD_W - 1; x >= 0; x -= 2) gctx.lineTo(x, rock[x]);
  gctx.lineTo(-4, rock[0]);
  gctx.closePath();
  gctx.fillStyle = COL.soil;
  gctx.fill();

  /* 草皮只长在有土的地方；露头的裸岩换成浅岩色描边——
     不然整座石山都被描一圈绿边，看不出哪块是石头 */
  gctx.lineJoin = 'round';
  gctx.lineCap = 'round';
  var segKind = -1, sx = 0, kind;
  for (x = 0; x <= WORLD_W; x += 2) {
    kind = (x < WORLD_W && rock[x] - surf[x] < 3) ? 1 : 0;   /* 1 = 裸岩 */
    if (kind !== segKind) {
      if (segKind >= 0) {
        gctx.beginPath();
        gctx.moveTo(sx, surf[Math.max(0, Math.min(WORLD_W - 1, sx))]);
        for (var k = sx; k <= x; k += 2) gctx.lineTo(k, surf[Math.min(WORLD_W - 1, k)]);
        gctx.strokeStyle = segKind === 1 ? COL.rockLight : COL.grass;
        gctx.lineWidth = segKind === 1 ? 5 : 8;
        gctx.stroke();
      }
      segKind = kind; sx = x;
    }
  }

  /* 基岩板：挖不穿的底板，颜色比普通岩层更深一点 */
  gctx.fillStyle = COL.rockDeep;
  gctx.fillRect(-4, FLOOR_Y, WORLD_W + 8, WORLD_H + 400 - FLOOR_Y);
}
function drawSoldier(ctx, c) {
  if (!c.alive) return;
  var x = c.x - c.side * 42, y = c.y;          /* 小兵站在炮的外侧 */
  var main = c.main, dark = c.dark;
  ctx.fillStyle = dark;
  ctx.fillRect(x - 5, y - 12, 3.4, 12);
  ctx.fillRect(x + 1.6, y - 12, 3.4, 12);
  ctx.fillStyle = main;
  roundRect(ctx, x - 8, y - 30, 16, 20, 4);
  ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 34, 7.5, 0, 6.2832); ctx.fillStyle = '#f2c9a0'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 35.5, 8.6, Math.PI, 0); ctx.fillStyle = dark; ctx.fill();
}

function drawCannon(ctx, c, isTurn) {
  var y = c.y - c.recoil * 4;
  var base = c.main, dark = c.dark;
  if (!c.alive) {
    ctx.fillStyle = COL.rockDark;
    roundRect(ctx, c.x - CANNON_HW - 6, c.y - 12, (CANNON_HW + 6) * 2, 14, 4);
    ctx.fill();
    return;
  }
  var a = c.angle * Math.PI / 180;
  var th = Math.atan2(-Math.sin(a), c.side * Math.cos(a));
  ctx.save();
  ctx.translate(c.x, y - CANNON_HH - 2);
  ctx.rotate(th);
  ctx.fillStyle = dark;
  roundRect(ctx, 0, -7, CANNON_HW + 26, 14, 4);
  ctx.fill();
  ctx.fillStyle = '#f8ffe5';
  ctx.fillRect(CANNON_HW + 18, -5.5, 6, 11);
  ctx.restore();
  ctx.fillStyle = base;
  roundRect(ctx, c.x - CANNON_HW, y - CANNON_HH, CANNON_HW * 2, CANNON_HH + 4, 5);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(c.x - 10, y + 2, 5, 0, 6.2832);
  ctx.arc(c.x, y + 2, 5, 0, 6.2832);
  ctx.arc(c.x + 10, y + 2, 5, 0, 6.2832);
  ctx.fill();
  if (c.flash > 0) {
    var m = muzzlePoint(c);
    ctx.globalAlpha = Math.min(1, c.flash);
    ctx.fillStyle = COL.sunCore;
    ctx.beginPath(); ctx.arc(m.x, m.y, 13 * c.flash + 5, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawSoldier(ctx, c);
  if (isTurn && (phase === 'aim' || phase === 'enemyAim')) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.arc(c.x, c.y - 6, 34, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawAim() {
  if (phase !== 'aim') return;
  var c = cannons[turn];
  if (!c.alive) return;
  var a = c.angle * Math.PI / 180;
  var m = muzzlePoint(c);
  var len = 54 + c.power * 1.9;
  var dx = c.side * Math.cos(a), dy = -Math.sin(a);
  worldTransform();
  gctx.strokeStyle = 'rgba(255,255,255,0.85)';
  gctx.lineWidth = 2.4;
  gctx.setLineDash([6, 8]);
  gctx.beginPath();
  gctx.moveTo(m.x + dx * 10, m.y + dy * 10);
  gctx.lineTo(m.x + dx * len, m.y + dy * len);
  gctx.stroke();
  gctx.setLineDash([]);
}

function drawPrevTrail() {
  if (prevTrailN < 2) return;
  worldTransform();
  gctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (var i = 0; i < prevTrailN; i += 3) {
    gctx.beginPath();
    gctx.arc(prevTrailX[i], prevTrailY[i], 2.1, 0, 6.2832);
    gctx.fill();
  }
}

/* 每种炮弹的大小和外形都不一样，并沿飞行方向朝向 */
var SHELL_LOOK = {
  std: { r: 5.5, shape: 'ball', col: '#5b5b5b' },
  heavy: { r: 9.5, shape: 'bomb', col: '#3f3f45' },
  tri: { r: 4.5, shape: 'dart', col: '#6a6a72' },
  drill: { r: 6.5, shape: 'drill', col: '#54545c' }
};
function drawShells() {
  worldTransform();
  for (var i = 0; i < SHOT_CAP; i++) {
    var sh = shells[i];
    if (!sh.on) continue;
    var look = SHELL_LOOK[WEAPONS[sh.w].k] || SHELL_LOOK.std;
    var ang = Math.atan2(sh.vy, sh.vx);
    gctx.save();
    gctx.translate(sh.x, sh.y);
    gctx.rotate(ang);
    gctx.fillStyle = look.col;
    if (look.shape === 'ball') {
      gctx.beginPath(); gctx.arc(0, 0, look.r, 0, 6.2832); gctx.fill();
      gctx.fillStyle = 'rgba(255,255,255,0.85)';
      gctx.beginPath(); gctx.arc(-look.r * 0.35, -look.r * 0.35, look.r * 0.34, 0, 6.2832); gctx.fill();
    } else if (look.shape === 'bomb') {
      gctx.beginPath(); gctx.arc(0, 0, look.r, 0, 6.2832); gctx.fill();
      gctx.fillStyle = 'rgba(255,255,255,0.22)';
      gctx.beginPath(); gctx.arc(0, 0, look.r * 0.62, 0, 6.2832); gctx.fill();
      gctx.fillStyle = look.col;
      gctx.beginPath();                       /* 尾翼 */
      gctx.moveTo(-look.r * 1.5, -look.r * 0.3);
      gctx.lineTo(-look.r * 2.3, -look.r * 0.9);
      gctx.lineTo(-look.r * 2.3, look.r * 0.9);
      gctx.lineTo(-look.r * 1.5, look.r * 0.3);
      gctx.closePath(); gctx.fill();
      gctx.fillStyle = 'rgba(255,255,255,0.8)';
      gctx.beginPath(); gctx.arc(-look.r * 0.3, -look.r * 0.35, look.r * 0.26, 0, 6.2832); gctx.fill();
    } else if (look.shape === 'dart') {
      gctx.beginPath();                       /* 细长尖头 */
      gctx.moveTo(look.r * 2.4, 0);
      gctx.quadraticCurveTo(look.r * 0.6, look.r, -look.r * 1.6, look.r * 0.5);
      gctx.lineTo(-look.r * 2.2, 0);
      gctx.lineTo(-look.r * 1.6, -look.r * 0.5);
      gctx.quadraticCurveTo(look.r * 0.6, -look.r, look.r * 2.4, 0);
      gctx.closePath(); gctx.fill();
    } else {
      gctx.beginPath();                       /* 钻头：锥形尖 + 螺旋纹 */
      gctx.moveTo(look.r * 2.6, 0);
      gctx.lineTo(-look.r * 1.8, look.r * 0.85);
      gctx.lineTo(-look.r * 1.8, -look.r * 0.85);
      gctx.closePath(); gctx.fill();
      gctx.strokeStyle = 'rgba(255,255,255,0.45)';
      gctx.lineWidth = 1.2;
      gctx.beginPath();
      gctx.moveTo(-look.r * 0.4, -look.r * 0.5);
      gctx.lineTo(look.r * 1.2, look.r * 0.1);
      gctx.moveTo(-look.r * 1.0, -look.r * 0.62);
      gctx.lineTo(look.r * 0.4, look.r * 0.34);
      gctx.stroke();
    }
    gctx.restore();
  }
}

function drawParticles() {
  var i, p, a, t;
  worldTransform();
  for (i = 0; i < MAX_PARTS; i++) {
    p = parts[i];
    if (!p.on) continue;
    a = p.life / p.max;
    if (p.type === 0) {
      gctx.globalAlpha = Math.min(1, a * 1.6);
      gctx.fillStyle = p.col;
      gctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
    } else if (p.type === 1) {
      gctx.globalAlpha = a * 0.5;
      gctx.fillStyle = p.col;
      gctx.beginPath(); gctx.arc(p.x, p.y, p.size, 0, 6.2832); gctx.fill();
    } else {
      gctx.globalAlpha = Math.min(1, a * 1.9);
      gctx.fillStyle = p.col;
      gctx.beginPath(); gctx.arc(p.x, p.y, p.size, 0, 6.2832); gctx.fill();
    }
  }
  gctx.globalAlpha = 1;
  for (i = 0; i < flashes.length; i++) {
    var f = flashes[i];
    if (!f.on) continue;
    t = 1 - f.life / f.max;
    gctx.globalAlpha = (1 - t) * 0.85;
    gctx.fillStyle = COL.white;
    gctx.beginPath(); gctx.arc(f.x, f.y, f.r * (0.4 + t * 0.9), 0, 6.2832); gctx.fill();
  }
  gctx.globalAlpha = 1;
  gctx.textAlign = 'center';
  gctx.font = '700 17px -apple-system, "PingFang SC", sans-serif';
  for (i = 0; i < floats.length; i++) {
    var fl = floats[i];
    if (!fl.on) continue;
    gctx.globalAlpha = Math.min(1, fl.life);
    gctx.strokeStyle = 'rgba(85,85,85,0.72)';
    gctx.lineWidth = 3.4;
    gctx.strokeText(fl.txt, fl.x, fl.y);
    gctx.fillStyle = COL.white;
    gctx.fillText(fl.txt, fl.x, fl.y);
  }
  gctx.globalAlpha = 1;
  gctx.textAlign = 'left';
}

/* ── 画面内 HUD：血条 / 回合 / 风 / 角度力度 ── */

var FONT = '-apple-system, "PingFang SC", sans-serif';

function hudPanel(x, y, w, h, r) {
  gctx.fillStyle = COL.hud;
  roundRect(gctx, x, y, w, h, r === undefined ? 9 : r);
  gctx.fill();
}
function drawHpPanel(x, y, w, c, color, label) {
  hudPanel(x, y, w, 32);
  gctx.fillStyle = '#fff';
  gctx.font = '600 13px ' + FONT;
  gctx.textAlign = 'left';
  gctx.fillText(label, x + 11, y + 21);
  var tx = x + 52, tw = w - 52 - 46;
  gctx.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(gctx, tx, y + 10, tw, 12, 6);
  gctx.fill();
  var fw = tw * Math.max(0, c.hp) / c.hpMax;
  if (fw > 1) {
    gctx.fillStyle = color;
    roundRect(gctx, tx, y + 10, fw, 12, 6);
    gctx.fill();
  }
  gctx.fillStyle = '#fff';
  gctx.font = '700 14px ' + FONT;
  gctx.textAlign = 'right';
  gctx.fillText(String(Math.round(c.hp)), x + w - 11, y + 21);
  gctx.textAlign = 'left';
}
function drawChip(x, y, w, h, label, val) {
  hudPanel(x, y, w, h);
  gctx.fillStyle = 'rgba(255,255,255,0.78)';
  gctx.font = '600 12px ' + FONT;
  gctx.fillText(label, x + 12, y + 16);
  gctx.fillStyle = '#fff';
  gctx.font = '700 19px ' + FONT;
  gctx.fillText(val, x + 12, y + 35);
}
function drawHud() {
  screenTransform();
  var playing = phase !== 'over' && phase !== 'intro';
  /* 双方血条：左上 / 右上 */
  drawHpPanel(12, 10, 250, cannons[0], COL.hpA, '我方');
  drawHpPanel(W - 262, 10, 250, cannons[1], COL.hpB, '敌方');
  /* 回合指示：顶部中间 */
  if (playing) {
    var t = modeIdx === 2 ? (turn === 0 ? '左方回合' : '右方回合') : (turn === 0 ? '我方回合' : '敌方回合');
    var tw = 108, tx = W / 2 - tw / 2;
    hudPanel(tx, 10, tw, 28, 14);
    gctx.fillStyle = '#fff';
    gctx.font = '600 14px ' + FONT;
    gctx.textAlign = 'center';
    gctx.fillText(t, W / 2, 29);
    gctx.textAlign = 'left';
  }
  /* 风：右下 */
  var ww = 124, wh = 40, wx = W - 14 - ww, wy = H - 14 - wh;
  hudPanel(wx, wy, ww, wh);
  gctx.fillStyle = 'rgba(255,255,255,0.78)';
  gctx.font = '600 12px ' + FONT;
  gctx.fillText('风', wx + 12, wy + 16);
  var mag = Math.abs(wind), n = Math.max(1, Math.min(3, Math.ceil(mag / 0.5))), st = '', i;
  var arrow = wind >= 0 ? '▶' : '◀';
  for (i = 0; i < n; i++) st += arrow;
  gctx.fillStyle = '#fff';
  gctx.font = '700 18px ' + FONT;
  gctx.fillText(Math.abs(wind) < 0.08 ? '无风' : st, wx + 12, wy + 34);
  /* 角度 / 力度：左下（只有能瞄准时才显示） */
  if (playing && phase === 'aim') {
    var c = cannons[turn];
    drawChip(14, H - 54, 104, 40, '角度', Math.round(c.angle) + '°');
    drawChip(126, H - 54, 104, 40, '力度', String(Math.round(c.power)));
  }
}

function drawOffscreenEnemy() {
  if (phase !== 'aim' && phase !== 'enemyAim') return;
  var foe = cannons[1 - turn];
  if (!foe.alive) return;
  var hw = W / (2 * cam.z);
  if (foe.x > cam.x - hw && foe.x < cam.x + hw) return;
  screenTransform();
  var right = foe.x > cam.x;
  var ax = right ? W - 30 : 30, ay = H * 0.45;
  gctx.fillStyle = COL.hud;
  gctx.beginPath();
  gctx.moveTo(ax + (right ? 15 : -15), ay);
  gctx.lineTo(ax - (right ? 7 : -7), ay - 13);
  gctx.lineTo(ax - (right ? 7 : -7), ay + 13);
  gctx.closePath();
  gctx.fill();
  gctx.fillStyle = '#fff';
  gctx.font = '600 13px -apple-system, "PingFang SC", sans-serif';
  gctx.textAlign = 'center';
  gctx.fillText(String(Math.round(Math.abs(foe.x - cannons[turn].x))), ax, ay + 31);
  gctx.textAlign = 'left';
}

function drawToast() {
  if (toast.t <= 0) return;
  screenTransform();
  var a = Math.min(1, toast.t / 0.9);
  gctx.globalAlpha = a;
  gctx.fillStyle = COL.hud;
  roundRect(gctx, W / 2 - 210, 66, 420, 56, 10);
  gctx.fill();
  gctx.fillStyle = '#fff';
  gctx.textAlign = 'center';
  gctx.font = '700 19px -apple-system, "PingFang SC", sans-serif';
  gctx.fillText(toast.title, W / 2, 91);
  gctx.font = '400 14px -apple-system, "PingFang SC", sans-serif';
  gctx.fillText(toast.sub, W / 2, 113);
  gctx.textAlign = 'left';
  gctx.globalAlpha = 1;
}

function renderFrame() {
  gctx.setTransform(sc, 0, 0, sc, 0, 0);
  gctx.clearRect(0, 0, W, H);
  drawSky();
  drawClouds();
  drawTerrain();
  drawPrevTrail();
  drawCannon(gctx, cannons[0], turn === 0);
  drawCannon(gctx, cannons[1], turn === 1);
  drawAim();
  drawShells();
  drawParticles();
  drawOffscreenEnemy();
  drawHud();
  drawToast();
}

/* ═══════════════════ 16. HUD / 浮层 ═══════════════════ */

var toast = { t: 0, title: '', sub: '' };

function setToast(title, sub, secs) {
  toast.title = title; toast.sub = sub; toast.t = secs;
}

function buildMapOptions() {
  el.mapSel.innerHTML = '';
  for (var i = 0; i < LEVELS.length; i++) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = mapLabel(i);
    el.mapSel.appendChild(o);
  }
  el.mapSel.value = String(selMap);
}

function buildWeaponButtons() {
  el.weapons.innerHTML = '';
  el.buttons = [];
  for (var i = 0; i < WEAPONS.length; i++) {
    var b = document.createElement('button');
    b.type = 'button';
    var n = document.createElement('span');
    var s = document.createElement('small');
    b.appendChild(n); b.appendChild(s);
    b._name = n; b._sub = s; b._state = '';
    (function (k, btn) {
      btn.addEventListener('click', function () {
        unlockAudio();
        if (!weaponUnlocked(k)) return;
        weapon = k; syncHud(); sfxClick();
      });
    })(i, b);
    el.weapons.appendChild(b);
    el.buttons.push(b);
  }
}

function syncHud() {
  if (!el.mapName) return;
  el.mapName.textContent = modeIdx === 1 ? ('无尽 ' + (levelIdx + 1)) : (curLevel ? curLevel.name : '');
  var st = '', n = modeIdx === 1 ? Math.min(5, 1 + Math.floor(levelIdx / 3)) : mapStars(selMap), k;
  for (k = 0; k < n; k++) st += '★';
  el.mapStars.textContent = st;
  if (el.mapSel) {
    el.mapSel.disabled = modeIdx === 1;
    if (!el.mapSel.disabled && el.mapSel.value !== String(selMap)) el.mapSel.value = String(selMap);
  }
  /* 血量 / 角度 / 力度 / 风 / 回合指示都画在画面里（见 drawHud），
     这里只维护页面级信息，避免每帧同步 DOM */
  for (var i = 0; i < el.buttons.length; i++) {
    var b = el.buttons[i];
    var state = i === weapon ? 'on' : 'off';
    if (b._state !== state) {
      b._state = state;
      b._name.textContent = WEAPONS[i].name;
      b._sub.textContent = WEAPONS[i].sub;
      b.className = state;
      b.disabled = false;
    }
  }
  var mb = el.modes.getElementsByTagName('button');
  for (var m = 0; m < mb.length; m++) {
    var cls = m === modeIdx ? 'on' : '';
    if (mb[m].className !== cls) mb[m].className = cls;
  }
  var pt = paused ? '▶ 继续' : '⏸ 暂停';
  if (el.pauseBtn.textContent !== pt) el.pauseBtn.textContent = pt;
}

function overlayShow(emoji, title, l1, l2, l3, btn) {
  el.ovEmoji.textContent = emoji;
  el.ovTitle.textContent = title;
  el.ovLine1.textContent = l1 || '';
  el.ovLine2.textContent = l2 || '';
  el.ovLine3.textContent = l3 || '';
  el.again.textContent = btn;
  el.overlay.className = 'overlay on';
}
function overlayHide() { el.overlay.className = 'overlay'; }

function showIntro() {
  var l1, l2;
  if (modeIdx === 0) { l1 = LEVELS.length + ' 张地图任选 · 4 种炮弹都能用'; l2 = '土能炸开、岩石只崩壳，只有钻地弹啃得动岩层'; }
  else if (modeIdx === 1) { l1 = '每关地形重掷，赢一关满血续战'; l2 = '电脑越来越准、血越来越厚，看你能撑到第几关'; }
  else { l1 = '两个人在同一台设备上轮流开炮'; l2 = '左方先手'; }
  overlayShow('🎯', modeIdx === 0 ? '隔山炮战' : (modeIdx === 1 ? '无尽炮战' : '双人同机'), l1, l2, '← → 角度 · ↑ ↓ 力度 · 空格发射', '开始');
}

function showResult(win) {
  var acc = stats.shots ? Math.round(100 * stats.hits / stats.shots) : 0;
  var l1, l2, l3, btn;
  if (modeIdx === 2) {
    l1 = (win ? '左方' : '右方') + '获胜';
    l2 = '共开火 ' + stats.shots + ' 发 · 命中 ' + stats.hits + ' 发';
    l3 = '剩余血量 ' + Math.round(cannons[win ? 0 : 1].hp);
    btn = '再来一局';
  } else if (modeIdx === 1) {
    l1 = '打到无尽 ' + (levelIdx + 1);
    l2 = '开火 ' + stats.shots + ' 发 · 命中 ' + stats.hits + ' 发（' + acc + '%）';
    l3 = '每赢一关满血续战，地形重掷、电脑更准';
    btn = '再来一局';
  } else if (win) {
    l1 = '地图 ' + (selMap + 1) + ' · ' + (curLevel ? curLevel.name : '') + ' 打过';
    l2 = '剩余血量 ' + Math.round(cannons[0].hp) + ' · 开火 ' + stats.shots + ' 发';
    l3 = selMap + 1 < LEVELS.length ? ('下一张：' + LEVELS[selMap + 1].name + '（也可以直接在上面换地图）') : '12 张地图全部打过！';
    btn = selMap + 1 < LEVELS.length ? '下一张' : '再来一局';
  } else {
    l1 = '地图 ' + (selMap + 1) + ' · ' + (curLevel ? curLevel.name : '');
    l2 = '开火 ' + stats.shots + ' 发 · 命中 ' + stats.hits + ' 发（' + acc + '%）';
    l3 = '打不过就换张图，或者换种炮弹';
    btn = '重打这张';
  }
  overlayShow(win ? '🎉' : '💥', win ? '过关！' : '被击毁', l1, l2, l3, btn);
}

/* ═══════════════════ 17. 流程 ═══════════════════ */

var lastWin = false, lastImpactX = WORLD_W / 2, lastImpactY = 0, hudT = 0;
var lastBlast = { removed: 0, a: 0, b: 0, cx: 0 };
var solCache = { angle: 45, power: 60 };

function clearShells() { for (var i = 0; i < SHOT_CAP; i++) shells[i].on = false; }
function clearParts() {
  for (var i = 0; i < MAX_PARTS; i++) parts[i].on = false;
  for (var j = 0; j < floats.length; j++) floats[j].on = false;
  for (var k = 0; k < flashes.length; k++) flashes[k].on = false;
  partN = 0;
}
function commitTrail() {
  var n = Math.min(curTrailN, TRAIL_MAX);
  for (var i = 0; i < n; i++) { prevTrailX[i] = curTrailX[i]; prevTrailY[i] = curTrailY[i]; }
  prevTrailN = n;
  curTrailN = 0;
}

function loadLevel(i) {
  levelIdx = i;
  if (modeIdx !== 1) selMap = i;
  curLevel = levelSpec(i);
  var xs = WORLD_W / AUTH_W;
  var px = curLevel.cx ? [Math.round(curLevel.cx[0] * xs), Math.round(curLevel.cx[1] * xs)] : CANNON_X;
  buildProfile(curLevel.pts, curLevel.soil, curLevel.coreY, px, curLevel.rockPts, curLevel.rockThick, curLevel.rockBotPts);
  var k;
  for (k = 0; k < 2; k++) {
    cannons[k].x = px[k];
    cannons[k].hpMax = k === 0 ? HP_MAX : Math.round(curLevel.hp);
    cannons[k].hp = cannons[k].hpMax;
    cannons[k].alive = true;
    cannons[k].angle = 46 + rng() * 8;
    cannons[k].power = 62;
    cannons[k].recoil = 0;
    cannons[k].flash = 0;
  }
  settleCannons();
  wind = (rng() * 2 - 1) * curLevel.wind;
  windTarget = wind;
  ai.err = curLevel.err;
  aiInvalidate();
  clearShells(); clearParts();
  prevTrailN = 0; curTrailN = 0;
  stopWhistle();
  turn = 0; phase = 'aim'; phaseT = 0; paused = false;
  stats = { shots: 0, hits: 0, dmgDealt: 0, dmgTaken: 0, turns: 0, startT: 0 };
  lastImpactX = WORLD_W / 2; lastImpactY = 560;
  camLookAtCannon(0, CAM_Z_IDLE);
  setToast('第 ' + (i + 1) + ' 关 · ' + curLevel.name, curLevel.tip, 4.2);
  syncHud();
}

function startRun() {
  overlayHide();
  unlockAudio();
  loadLevel(modeIdx === 1 ? 0 : selMap);
  syncHud();
}

/* setMode 钩子用：直接进可开火状态，不挡结算面板 */
function applyMode(i) {
  if (typeof i === 'number') modeIdx = Math.max(0, Math.min(MODE_TOTAL - 1, i));
  overlayHide();
  loadLevel(modeIdx === 1 ? 0 : selMap);
  save.mode = modeIdx;
  putSave();
  syncHud();
}
function applyModeWithIntro(i) {
  applyMode(i);
  phase = 'intro';
  showIntro();
  syncHud();
}

/* 直接换地图开打：地图是可选项，不再和进度绑定 */
function pickMap(i) {
  if (typeof i !== 'number' || i < 0 || i >= LEVELS.length) return false;
  if (modeIdx === 1) { modeIdx = 0; save.mode = 0; }   /* 无尽模式换图 = 退出无尽 */
  selMap = i;
  save.map = i;
  overlayHide();
  unlockAudio();
  loadLevel(i);
  syncHud();
  return true;
}
function randomMap() {
  var i = Math.floor(vrng() * LEVELS.length);
  if (i === selMap) i = (i + 1) % LEVELS.length;
  return pickMap(i);
}

function followShells() {
  var i, best = null;
  for (i = 0; i < SHOT_CAP; i++) if (shells[i].on) { best = shells[i]; break; }
  if (!best) return;
  camFollow(best.x + best.vx * FLY_LEAD, best.y + best.vy * FLY_LEAD, CAM_Z_FLY);
}
function followOff() { followX = 0; followY = 0; }

function nextTurn() {
  turn = 1 - turn;
  stats.turns++;
  windTarget = (rng() * 2 - 1) * (curLevel ? curLevel.wind : 0);
  phaseT = 0;
  if (modeIdx === 2) {
    phase = 'aim';
    camLookAtCannon(turn, CAM_Z_IDLE);
    setToast(turn === 0 ? '左方回合' : '右方回合', '拖拽或方向键调整，空格发射', 1.8);
  } else if (turn === 1) {
    if (!ai.valid) aiSolveNow();
    solCache = aiSolution();
    phase = 'enemyAim';
    camLookAtCannon(1, 1.06);
    setToast('敌方回合', '它在瞄准你', 1.6);
    sfxTurn();
  } else {
    phase = 'aim';
    camLookAtCannon(0, CAM_Z_IDLE);
    sfxTurn();
  }
  syncHud();
}


function aiSolveNow() {
  if (modeIdx === 2) return;
  aiReset();
  var guard = 0;
  while (ai.on && guard++ < 400) aiTick(120000);
  ai.valid = true;
  ai.sig = terrainSig;
}

function stepFlow(dt) {
  if (phase === 'over' || phase === 'intro' || paused) return;
  phaseT += dt;
  if (phase === 'fly') {
    if (shellsGone()) {
      commitTrail();
      phase = 'impact'; phaseT = 0;
      camPanTo(lastImpactX, 1.45, lastImpactY - 40);
    }
  } else if (phase === 'levelClear') {
    if (phaseT >= 1.5) loadLevel(levelIdx + 1);
  } else if (phase === 'impact') {
    if (phaseT > RESULT_HOLD) {
      if (phase === 'over') return;
      nextTurn();
    }
  } else if (phase === 'enemyAim') {
    var c = cannons[1];
    c.angle += (solCache.angle - c.angle) * Math.min(1, dt * 3.4);
    c.power += (solCache.power - c.power) * Math.min(1, dt * 3.4);
    if (phaseT > ENEMY_AIM_T) {
      c.angle = Math.max(ANG_MIN, Math.min(ANG_MAX, solCache.angle));
      c.power = Math.max(PWR_MIN, Math.min(PWR_MAX, solCache.power));
      wind = windTarget;
      launch(1);
    }
  }
}

/* ═══════════════════ 18. 主循环 ═══════════════════ */

var acc = 0, lastT = 0, nowT = 0;

function handleHold(dt) {
  if (!aimActive()) return;
  var keys = ['left', 'right', 'up', 'down'], dirs = [-1, 1, 1, -1];
  for (var i = 0; i < 4; i++) {
    var k = keys[i];
    if (!held[k]) { repeatT[k] = 0; continue; }
    repeatT[k] += dt;
    if (repeatT[k] < 0.26) continue;
    while (repeatT[k] >= 0.05) {
      repeatT[k] -= 0.05;
      if (i < 2) adjustAngle(dirs[i]); else adjustPower(dirs[i]);   /* dirs: left=-1 right=+1 up=+1 down=-1 */
    }
  }
}

function recordTrail() {
  for (var i = 0; i < SHOT_CAP; i++) {
    var sh = shells[i];
    if (!sh.on) continue;
    if (curTrailN < TRAIL_MAX) {
      curTrailX[curTrailN] = sh.x; curTrailY[curTrailN] = sh.y; curTrailN++;
    }
    sh.smoke -= STEP;
    if (sh.smoke <= 0) {
      sh.smoke = 0.05;
      spawnSmoke(sh.x, sh.y, 1, 0.55 + WEAPONS[sh.w].r / 90);
    }
  }
}

function stepWorld(dt) {
  var i, sh, c;
  handleHold(dt);
  if (phase === 'fly') followShells();
  camUpdate(dt);
  for (i = 0; i < SHOT_CAP; i++) {
    sh = shells[i];
    if (sh.on) stepShell(sh, dt);
  }
  trailTick += dt;
  if (trailTick > 0.022) { trailTick = 0; recordTrail(); }
  stepFlow(dt);
  stepParts(dt);
  for (i = 0; i < 2; i++) {
    c = cannons[i];
    if (c.recoil > 0) c.recoil = Math.max(0, c.recoil - dt * 4.4);
    if (c.flash > 0) c.flash = Math.max(0, c.flash - dt * 7);
  }
  if (phase === 'aim') aiTick(6000);
  if (phase !== 'fly') wind += (windTarget - wind) * Math.min(1, dt * 2.4);
  if (toast.t > 0) toast.t = Math.max(0, toast.t - dt);
  stopWhistleIfIdle();
  whistleFollow();
  hudT += dt;
  if (hudT > 0.12) { hudT = 0; syncHud(); }
}

function stopWhistleIfIdle() {
  if (whistle && activeShells() === 0) stopWhistle();
}

function frame(t) {
  if (!lastT) lastT = t;
  var dt = (t - lastT) / 1000;
  lastT = t;
  nowT = t / 1000;
  if (dt > 0.05) dt = 0.05;
  if (++resizeTick >= 20) { resizeTick = 0; resizeCanvas(); }
  if (!paused) {
    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard++ < 16) { stepWorld(STEP); acc -= STEP; }
    if (guard >= 16) acc = 0;
  }
  renderFrame();
  requestAnimationFrame(frame);
}

/* ═══════════════════ 19. 测试钩子 ═══════════════════ */

function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }

function snapshotState() {
  var shellArr = [], i, sh;
  for (i = 0; i < SHOT_CAP; i++) {
    sh = shells[i];
    if (!sh.on) continue;
    shellArr.push({ owner: sh.owner, w: sh.w, x: Math.round(sh.x), y: Math.round(sh.y), vx: Math.round(sh.vx), vy: Math.round(sh.vy), age: Math.round(sh.age * 1000) / 1000 });
  }
  return {
    mode: modeIdx, modeName: ['单张地图', '无尽', '双人同机'][modeIdx],
    phase: phase, turn: turn, paused: paused, over: phase === 'over', win: lastWin,
    level: levelIdx + 1, levelName: curLevel ? curLevel.name : '', levelTip: curLevel ? curLevel.tip : '',
    map: selMap, mapIndex: selMap + 1, mapStars: modeIdx === 1 ? 0 : mapStars(selMap),
    seed: seed, wind: Math.round(wind * 1000) / 1000, muted: muted,
    weapon: weapon, weaponName: WEAPONS[weapon].name,
    a: { x: cannons[0].x, y: Math.round(cannons[0].y), angle: Math.round(cannons[0].angle * 100) / 100, power: Math.round(cannons[0].power * 100) / 100, hp: Math.round(cannons[0].hp), hpMax: cannons[0].hpMax, alive: cannons[0].alive },
    b: { x: cannons[1].x, y: Math.round(cannons[1].y), angle: Math.round(cannons[1].angle * 100) / 100, power: Math.round(cannons[1].power * 100) / 100, hp: Math.round(cannons[1].hp), hpMax: cannons[1].hpMax, alive: cannons[1].alive },
    shells: shellArr, shellCount: shellArr.length,
    camera: { x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z * 1000) / 1000, tx: Math.round(cam.tx), ty: Math.round(cam.ty), tz: Math.round(cam.tz * 1000) / 1000, shake: Math.round(cam.shake * 100) / 100 },
    terrain: terrainStats(),
    lastImpact: [Math.round(lastImpactX), Math.round(lastImpactY)],
    lastBlast: { removed: Math.round(lastBlast.removed), a: Math.round(lastBlast.a), b: Math.round(lastBlast.b) },
    stats: { shots: stats.shots, hits: stats.hits, dmgDealt: stats.dmgDealt, dmgTaken: stats.dmgTaken, turns: stats.turns },
    parts: partN, trailN: prevTrailN,
    ai: { angle: Math.round(ai.bestA * 10) / 10, power: Math.round(ai.bestP * 10) / 10, ready: ai.valid, err: ai.err }
  };
}

window.__game = {
  snapshot: snapshotState,
  restart: function () { startRun(); },
  setSeed: function (n) { seed = ((n | 0) >>> 0) || 1; rng = mulberry32(seed); aiInvalidate(); return seed; },
  setMode: applyMode,
  loadLevel: loadLevel,
  setAim: function (side, a, p) {
    var c = cannons[side | 0]; if (!c) return null;
    if (typeof a === 'number') c.angle = clampNum(a, ANG_MIN, ANG_MAX);
    if (typeof p === 'number') c.power = clampNum(p, PWR_MIN, PWR_MAX);
    syncHud();
    return { angle: c.angle, power: c.power };
  },
  fire: function (side) { return launch(side | 0); },
  setWeapon: function (i) { if (weaponUnlocked(i)) { weapon = i | 0; save.weapon = weapon; putSave(); syncHud(); return true; } return false; },
  setMap: function (i) { return pickMap(i | 0); },
  randomMap: randomMap,
  mapStars: mapStars,
  mapList: function () { var o = [], i; for (i = 0; i < LEVELS.length; i++) o.push(mapLabel(i)); return o; },
  setWind: function (w) { wind = windTarget = clampNum(w || 0, -2, 2); syncHud(); return wind; },
  setTerrain: function (pts, soil, coreY, rockPts, rockThick, rockBotPts) {
    buildProfile(pts || LEVELS[0].pts, soil || 900, coreY || 960, CANNON_X, rockPts, rockThick, rockBotPts);
    settleCannons(); aiInvalidate(); return terrainStats();
  },
  terrainAt: terrainHeightAt,
  terrainRockAt: terrainRockAt,
  terrainRockBotAt: terrainRockBotAt,
  solidAt: solidAt,
  layers: function (x) {
    var i = clampCol(x);
    return { surf: Math.round(surf[i]), rock: Math.round(rock[i]), rockBot: Math.round(rockBot[i]), voidFrom: Math.round(rockBot[i]) };
  },
  terrainStats: terrainStats,
  carve: function (x, y, r) { var v = terrainCarve(x, y, r); settleCannons(); aiInvalidate(); return v; },
  /* 定向爆破：同一落点、给定速度 → 用于验证"方向/速度决定坑形" */
  blast: function (x, y, wi, vx, vy) {
    var wp = WEAPONS[wi | 0] || WEAPONS[0];
    var b = terrainBlast(x, y, wp, vx || 0, vy === undefined ? 300 : vy);
    lastBlast = b; lastImpactX = x; lastImpactY = y;
    settleCannons(); aiInvalidate();
    return { removed: Math.round(b.removed), a: Math.round(b.a), b: Math.round(b.b), cx: Math.round(b.cx),
             rockCols: b.rockCols, rockCut: Math.round(b.rockCut), broke: b.broke, cols: b.cols };
  },
  ejectaBias: function () {
    var sx = 0, n = 0, i;
    for (i = 0; i < MAX_PARTS; i++) if (parts[i].on && parts[i].type === 0) { sx += parts[i].vx; n++; }
    return { n: n, meanVx: n ? Math.round(sx / n) : 0 };
  },
  simulate: function (side, ang, pw) {
    var c = cannons[side | 0] || cannons[0];
    return aiSimulate(c.x, c.y, c.side, clampNum(ang, ANG_MIN, ANG_MAX), clampNum(pw, PWR_MIN, PWR_MAX), 9);
  },
  aiInfo: function () { return { angle: ai.bestA, power: ai.bestP, ready: ai.valid, err: ai.err, bestD: ai.bestD, i: ai.i, listN: ai.listN, stage: ai.stage, on: ai.on, sig: ai.sig, terrainSig: terrainSig }; },
  aiSolve: function () { aiSolveNow(); return { angle: ai.bestA, power: ai.bestP }; },
  setAiErr: function (e) { ai.err = e; return ai.err; },
  camera: function () { return { x: cam.x, y: cam.y, z: cam.z, tx: cam.tx, ty: cam.ty, tz: cam.tz, shake: cam.shake }; },
  viewRect: function () {
    var hw = W / (2 * cam.z), hh = H / (2 * cam.z);
    return { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
  },
  step: function (dt, count) {
    var d = typeof dt === 'number' && dt > 0 ? dt : STEP;
    var c = typeof count === 'number' && count > 0 ? count : 1;
    for (var i = 0; i < c; i++) stepWorld(d);
    return c;
  },
  advance: function (ms) {
    var n = Math.round(clampNum((ms | 0) / 1000, 0, 60) / STEP), i;
    for (i = 0; i < n; i++) { stepWorld(STEP); if (phase === 'over') break; }
    return { phase: phase, turn: turn, hp: [Math.round(cannons[0].hp), Math.round(cannons[1].hp)], shells: activeShells() };
  },
  press: pressKey,
  hold: function (k, on) { if (KEYMAP[k]) held[KEYMAP[k]] = !!on; return held; },
  setPaused: function (p) { paused = !!p; syncHud(); return paused; },
  togglePause: function () {
    if (phase === 'over' || phase === 'intro') return paused;
    paused = !paused;
    if (paused) stopWhistle();
    syncHud();
    return paused;
  },
  nextTurn: function () { nextTurn(); return { phase: phase, turn: turn, sol: solCache }; },
  aiSolveNow: function () { aiSolveNow(); return { angle: ai.bestA, power: ai.bestP, bestD: ai.bestD }; },
  commitTrail: commitTrail,
  pools: function () {
    var used = 0, i;
    for (i = 0; i < MAX_PARTS; i++) if (parts[i].on) used++;
    return {
      parts: used, partsMax: MAX_PARTS, shells: activeShells(), shellsMax: SHOT_CAP,
      floats: floats.length, flashes: flashes.length, domNodes: document.getElementsByTagName('*').length,
      terrainCols: WORLD_W, canvas: el.game.width + 'x' + el.game.height
    };
  },
  mute: setMute,
  audioInfo: function () { return { ready: !!AC, muted: muted, plays: sfxPlays, whistle: !!whistle }; },
  world: { W: W, H: H, WORLD_W: WORLD_W, WORLD_H: WORLD_H, GRAV: GRAV, WIND_K: WIND_K, SPEED_BASE: SPEED_BASE, SPEED_PER: SPEED_PER, ANG_MIN: ANG_MIN, ANG_MAX: ANG_MAX, PWR_MIN: PWR_MIN, PWR_MAX: PWR_MAX, HP_MAX: HP_MAX },
  weapons: WEAPONS,
  levels: LEVELS
};

/* ═══════════════════ 20. 启动 ═══════════════════ */

function pressKey(key) {
  var k = typeof key === 'string' ? key : '';
  if (k === ' ' || k === 'space' || k === 'Space' || k === 'Enter' || k === 'enter') {
    unlockAudio();
    if (phase === 'intro') { startRun(); return true; }
    return fireFromTurn();
  }
  if (k === 'ArrowLeft' || k === 'left') { adjustAngle(-1); return true; }
  if (k === 'ArrowRight' || k === 'right') { adjustAngle(1); return true; }
  if (k === 'ArrowUp' || k === 'up') { adjustPower(1); return true; }
  if (k === 'ArrowDown' || k === 'down') { adjustPower(-1); return true; }
  if (k === 'q' || k === 'Q') { cycleWeapon(-1); return true; }
  if (k === 'e' || k === 'E') { cycleWeapon(1); return true; }
  if (k === 'p' || k === 'P' || k === 'Escape') { window.__game.togglePause(); return true; }
  if (k === 'm' || k === 'M') { setMute(!muted); return true; }
  if (k === 'r' || k === 'R') { startRun(); return true; }
  return false;
}

function bindEvents() {
  /* 鼠标点完按钮立刻失焦：否则焦点留在按钮上，之后按空格会"再次点它" */
  document.addEventListener('click', function (e) {
    var t = e.target;
    /* 同步 blur：setTimeout(0) 在后台标签页会被节流，焦点会赖着不掉 */
    if (t && t.tagName === 'BUTTON' && t.blur) t.blur();
  });

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key, tg = e.target;
    var isUi = !!tg && (tg.tagName === 'BUTTON' || tg.tagName === 'SELECT' || tg.tagName === 'INPUT');
    /* 空格在本作里只有一个含义：开火。
       若焦点停在按钮上，浏览器会把空格解释成"激活该按钮"——点过"开始"之后
       再按空格就会重开一局，非常破坏体验。这里直接截住并移走焦点。 */
    if (k === ' ' && isUi) {
      e.preventDefault();
      if (tg.blur) tg.blur();
    } else if (isUi && (k === 'Enter' || k === ' ')) {
      return;                                   /* 回车交给按钮自己处理 */
    }
    unlockAudio();
    if (KEYMAP[k]) {
      held[KEYMAP[k]] = true;
      repeatT[KEYMAP[k]] = 0;
      pressKey(k);                       /* 第一次按键立即生效，长按才走连发 */
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Enter' || k === 'q' || k === 'e' || k === 'p' || k === 'm' || k === 'r' || k === 'Escape') {
      e.preventDefault();
      pressKey(k);
    }
  });
  window.addEventListener('keyup', function (e) {
    if (KEYMAP[e.key]) held[KEYMAP[e.key]] = false;
  });
  var cvs = el.game;
  cvs.addEventListener('mousedown', function (e) { pointerDown(e); e.preventDefault(); });
  window.addEventListener('mousemove', pointerMove);
  window.addEventListener('mouseup', pointerUp);
  cvs.addEventListener('touchstart', function (e) { if (e.touches.length) pointerDown(e.touches[0]); e.preventDefault(); }, { passive: false });
  cvs.addEventListener('touchmove', function (e) { if (e.touches.length) pointerMove(e.touches[0]); e.preventDefault(); }, { passive: false });
  cvs.addEventListener('touchend', function (e) { pointerUp(); e.preventDefault(); }, { passive: false });
  el.again.addEventListener('click', function () {
    unlockAudio();
    if (phase === 'over' && lastWin && modeIdx === 0 && selMap + 1 < LEVELS.length) {
      overlayHide();
      loadLevel(selMap + 1);
    } else startRun();
  });
  el.mapSel.addEventListener('change', function () { pickMap(parseInt(el.mapSel.value, 10) || 0); });
  el.randMap.addEventListener('click', function () { randomMap(); });
  el.restart.addEventListener('click', function () { startRun(); });
  el.fireBtn.addEventListener('click', function () { unlockAudio(); if (phase === 'aim') launch(turn); });
  el.weaponBtn.addEventListener('click', function () { unlockAudio(); cycleWeapon(1); });
  el.pauseBtn.addEventListener('click', function () { unlockAudio(); window.__game.togglePause(); });
  var mb = el.modes.getElementsByTagName('button');
  for (var i = 0; i < mb.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () { unlockAudio(); applyModeWithIntro(parseInt(btn.getAttribute('data-mode'), 10) || 0); });
    })(mb[i]);
  }
  window.addEventListener('resize', resizeCanvas);
}

function boot() {
  grabDom();
  loadSave();
  muted = save.muted;
  gctx = el.game.getContext('2d');
  initClouds();
  buildMapOptions();
  buildWeaponButtons();
  bindEvents();
  resizeCanvas();
  modeIdx = Math.max(0, Math.min(MODE_TOTAL - 1, save.mode));
  selMap = Math.max(0, Math.min(LEVELS.length - 1, save.map));
  weapon = Math.max(0, Math.min(WEAPONS.length - 1, save.weapon));
  loadLevel(modeIdx === 1 ? 0 : selMap);
  phase = 'intro';
  showIntro();
  syncHud();
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
