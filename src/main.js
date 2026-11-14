import * as THREE from 'three';
import GUI from 'lil-gui';
import { CFG, MOVES, LIMITS, totalFrames, motionAt, dumpJSON, moveIssues, validateAll } from './frame-data.js';
import { makeFighter, makeArena, setupLights, createViz, placeViz, applyPose } from './graybox.js';
import { poseFor } from './pose.js';
import { FootIK } from './footik.js';
import { MeleeVFX, VFX_CFG } from './vfx/melee.js';

// ═══════════════════════════════════════════════════════════════
//  0. 渲染基础设施
// ═══════════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c0e);
scene.fog = new THREE.Fog(0x0b0c0e, 34, 62);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 6, 10);

setupLights(scene);
const ARENA = makeArena(scene, 30);

// 近战特效（刀光 / 命中火花 / 弹反），纯程序化，不依赖外部资源
const vfx = new MeleeVFX(scene, { getCamera: () => camera });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ═══════════════════════════════════════════════════════════════
//  1. 确定性随机（回放/调参对比必需）
// ═══════════════════════════════════════════════════════════════
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(0xC0FFEE);

// ═══════════════════════════════════════════════════════════════
//  2. 输入层：快照 + 缓冲
// ═══════════════════════════════════════════════════════════════
const keys = new Set();
const BUFFER_WINDOW = 8;     // 输入缓冲 8 帧 ≈ 133ms
// 每个键一个队列，不是单值。单值的话连点会互相覆盖：
// 玩家在 light1 里连点三次 J，只有最后一次被记住，等到判定窗口开放时
// 那个时间戳早过期了 —— 表现就是「要点两次才进第二段」。
const pressedAt = Object.create(null);

const KEYMAP = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ShiftLeft: 'roll', Space: 'roll',
  KeyJ: 'light', KeyK: 'heavy', KeyL: 'block',
};

addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  if (k) {
    e.preventDefault();
    // 保留「最新一次」按键。用队列反而更糟：连点会攒下好几个旧时间戳，
    // 等到判定窗口开放时它们全部过期，一个都用不上。
    if (!e.repeat) pressedAt[k] = logicFrame;
  }
  keys.add(e.code);

  if (e.code === 'F1') { CFG.showHitbox = !CFG.showHitbox; syncGUI(); }
  if (e.code === 'F2') { CFG.timeScale = CFG.timeScale === 1.0 ? 0.25 : 1.0; syncGUI(); }
  if (e.code === 'F3') { CFG.paused = !CFG.paused; syncGUI(); }
  if (e.code === 'KeyR') { resetFight(); }
  if (e.code === 'KeyP') { downloadJSON(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousedown', (e) => { if (e.button === 2) { e.preventDefault(); player.lockOn = !player.lockOn; } });

const CODES_BY_NAME = {};
for (const [code, name] of Object.entries(KEYMAP)) (CODES_BY_NAME[name] ??= []).push(code);
const down = (name) => (CODES_BY_NAME[name] ?? []).some((c) => keys.has(c));
/** 消费一次缓冲输入；window 帧内有效 */
function consume(name, window = BUFFER_WINDOW) {
  const t = pressedAt[name];
  if (t === undefined) return false;
  if (logicFrame - t > window) { pressedAt[name] = undefined; return false; }
  pressedAt[name] = undefined;
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  3. 角色
// ═══════════════════════════════════════════════════════════════
const HITSTOP_LIGHT = () => CFG.hitstop;
const HITSTOP_HEAVY = () => CFG.hitstopHeavy;

class Actor {
  constructor({ name, isBoss, scale, pos, hp, poise, hurt }) {
    this.name = name;
    this.isBoss = isBoss;
    this.mesh = makeFighter(isBoss, scale);
    this.scale = scale;
    this.pos = new THREE.Vector3(pos[0], 0, pos[1]);
    this.yaw = Math.PI;
    this.hp = hp; this.maxHp = hp;
    this.poise = poise; this.maxPoise = poise;
    this.hurt = hurt;               // { radius, height }
    this.state = 'idle';
    this.moveId = null;
    this.move = null;
    this.frame = 0;
    this.iframe = 0;
    this.hitSet = new Set();
    this.lockOn = false;
    this.stunTimer = 0;
    this.flashTimer = 0;
    this.footIK = new FootIK();
    scene.add(this.mesh.group);

    // 判定可视化
    this.hitViz = createViz('hit');
    this.hurtViz = createViz('hurt');
    scene.add(this.hitViz, this.hurtViz);
  }

  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  setState(name, moveId = null) {
    this.state = name;
    this.frame = 0;
    this.moveId = moveId;
    this.move = moveId ? MOVES[moveId] : null;
    this.hitSet.clear();
    if (name === 'roll') { this.iframe = CFG.playerIframe; this.rollTotal = CFG.rollTotal; }
    if (name === 'dead') this.frame = 0;
  }

  /** 单帧推进：位移 + 计时器 */
  stepMotion() {
    if (!this.move) return;
    const d0 = motionAt(this.move, Math.max(0, this.frame - 1));
    const d1 = motionAt(this.move, this.frame);
    const delta = d1 - d0;
    if (delta !== 0) this.translate(delta);
  }

  translate(dist) {
    const f = this.forward;
    this.pos.x += f.x * dist;
    this.pos.z += f.z * dist;
    this.clampToArena();
  }

  clampToArena() {
    const lim = ARENA.half - 0.8;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -lim, lim);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -lim, lim);
  }

  /** 平滑转向，rate = 每帧最大弧度 */
  turnToward(targetYaw, framesFor180) {
    const maxStep = Math.PI / framesFor180;
    let diff = ((targetYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    diff = THREE.MathUtils.clamp(diff, -maxStep, maxStep);
    this.yaw += diff;
  }

  syncMesh() {
    this.mesh.group.position.copy(this.pos);
    this.mesh.group.rotation.y = this.yaw;
    // 受击闪白（闪红会让蓝色角色变紫，读不出「刚被打中」）
    const f = this.flashTimer > 0 ? 1 : 0;
    this.mesh.matBody.emissive?.setHex?.(f ? 0xffffff : 0x000000);
    this.mesh.matBody.emissiveIntensity = f ? 0.85 : 0;
  }

  reset(pos, yaw) {
    this.pos.set(pos[0], 0, pos[1]);
    this.yaw = yaw;
    this.hp = this.maxHp;
    this.poise = this.maxPoise;
    this.setState('idle');
    this.iframe = 0;
    this.flashTimer = 0;
  }
}

// ── 实例 ──────────────────────────────────────────────────────
const player = new Actor({
  name: 'PLAYER', isBoss: false, scale: 1.0, pos: [0, 8],
  hp: 1200, poise: 100, hurt: { radius: 0.40, height: 1.95 },
});
const boss = new Actor({
  name: 'BOSS', isBoss: true, scale: 2.6, pos: [0, -8],
  hp: 3200, poise: 120, hurt: { radius: 1.15, height: 4.6 },
});

// ═══════════════════════════════════════════════════════════════
//  4. 判定：圆柱近似（灰盒足够，替换真美术后可换胶囊扫掠）
// ═══════════════════════════════════════════════════════════════
function cylinderHit(aPos, aR, aY0, aY1, bPos, bR, bY0, bY1) {
  const dx = aPos.x - bPos.x, dz = aPos.z - bPos.z;
  if (dx * dx + dz * dz > (aR + bR) * (aR + bR)) return false;
  return aY1 > bY0 && aY0 < bY1;
}

/** 当前帧是否有活跃 hitbox */
function activeHitbox(actor) {
  const m = actor.move;
  if (!m || m.active <= 0) return null;
  if (actor.frame < m.startup || actor.frame >= m.startup + m.active) return null;
  const f = actor.forward;
  const center = actor.pos.clone().addScaledVector(f, m.hitbox.offset * actor.scale);
  return {
    center,
    radius: m.hitbox.radius * actor.scale,
    yMin: m.hitbox.yMin * actor.scale,
    yMax: m.hitbox.yMax * actor.scale,
  };
}

function resolveHit(attacker, defender, hb) {
  if (!hb) return;
  if (attacker.hitSet.has(defender.name)) return;
  if (defender.iframe > 0) return;

  const hurtY1 = defender.hurt.height * defender.scale;
  const hurtR = defender.hurt.radius * defender.scale;

  if (!cylinderHit(hb.center, hb.radius, hb.yMin, hb.yMax,
                   defender.pos, hurtR, 0, hurtY1)) return;

  attacker.hitSet.add(defender.name);
  vfx.hit(attacker, defender, hb);
  applyDamage(attacker, defender, attacker.move);
}

function applyDamage(attacker, defender, move) {
  // 玩家格挡 / 弹反窗口
  if (defender === player && player.state === 'block') {
    const parryEnd = 8;
    if (player.frame <= parryEnd) {
      // 弹反成功
      boss.poise = Math.max(0, boss.poise - 60);
      boss.setState('hitstun');
      boss.stunTimer = 90;
      player.iframe = 20;
      shake(0.14);
      hitstop(HITSTOP_HEAVY());
      vfx.parry(player);
      banner('弹反', 500);
      return;
    }
    // 普通格挡：减伤 80%，削减韧性
    defender.hp -= move.damage * 0.2;
    defender.poise -= move.damage * 0.14;
    defender.setState('hitstun');
    defender.stunTimer = 14;
    if (defender.poise <= 0) {
      defender.setState('guardbreak');
      defender.stunTimer = 60;
      defender.poise = defender.maxPoise * 0.5;   // 破防后回一半，避免连锁破防
    }
    shake(0.05);
    hitstop(HITSTOP_LIGHT());
    vfx.guard(player);
    flash(defender);
    return;
  }

  const dmg = move.damage;
  defender.hp = Math.max(0, defender.hp - dmg);
  defender.poise = Math.max(0, defender.poise - move.poise);
  defender.setState('hitstun');
  defender.stunTimer = move.hitstun;
  defender.flashTimer = 4;

  // 削韧满：强制长硬直
  if (defender.poise <= 0 && defender === boss) {
    defender.stunTimer = 110;
    defender.poise = defender.maxPoise;
  }

  // Boss 挨打记账：越打越凶。复仇窗口内间隔缩短、只进攻、优先快招。
  if (defender === boss) {
    AI.revengeHits = (AI.revengeHits || 0) + 1;
    AI.revengeUntil = logicFrame + 80 + AI.revengeHits * 12;   // 1.3s 起，连击越久越凶
  }

  shake(0.06 + dmg / 4000);
  hitstop(dmg > 200 ? HITSTOP_HEAVY() : HITSTOP_LIGHT());
  flash(defender);

  if (defender.hp <= 0) {
    defender.setState('dead');
    banner(defender === boss ? '击败' : '你死了', 2200, defender === player);
  }
}

function flash(a) { a.flashTimer = 4; }

// ═══════════════════════════════════════════════════════════════
//  5. 玩家状态机
// ═══════════════════════════════════════════════════════════════
/** 屏幕基：前 = 玩家指向 Boss。保证 W 永远靠近、A/D 绕圈，不会与相机互转打转 */
function screenBasis() {
  const toBoss = boss.pos.clone().sub(player.pos).setY(0);
  if (toBoss.lengthSq() < 1e-4) toBoss.set(0, 0, -1);
  toBoss.normalize();
  return { fwd: toBoss, right: new THREE.Vector3(-toBoss.z, 0, toBoss.x) };
}

function playerTick() {
  if (player.flashTimer > 0) player.flashTimer--;
  if (player.iframe > 0) player.iframe--;

  // 转向：锁定时朝 Boss，否则朝移动方向
  // 注意：翻滚 / 受击期间禁止转向，否则翻滚轨迹会被拉弯
  if (player.lockOn && player.state !== 'roll' && player.state !== 'hitstun' && player.state !== 'guardbreak') {
    const d = boss.pos.clone().sub(player.pos);
    player.turnToward(Math.atan2(d.x, d.z), 16);
  }

  switch (player.state) {
    case 'dead': player.frame++; return;

    case 'hitstun':
    case 'guardbreak':
      player.frame++;
      if (player.frame >= player.stunTimer) player.setState('idle');
      return;

    case 'roll': {
      player.frame++;
      // 翻滚位移：前 20 帧走完 4.6m（用抛物线速度曲线）
      const t = Math.min(1, player.frame / 20);
      const prev = rollDist(player.frame - 1);
      const cur = rollDist(player.frame);
      player.translate(cur - prev);
      if (player.frame >= CFG.rollTotal) player.setState('idle');
      return;
    }

    case 'light1':
    case 'light2':
    case 'light3':
    case 'heavy':
    case 'heavy2':
    case 'heavy3': {
      player.frame++;
      player.stepMotion();
      const m = player.move;

      // 连段取消：判定结束后 cancelFrom 帧起可以接下一段，或者取消进翻滚。
      // 轻击链 light1→light2→light3，重击链 heavy→heavy2→heavy3，
      // 两条链都只吃自己那个键（J / K），串不了。
      if (player.frame >= m.startup + m.active + m.cancelFrom) {
        const CHAIN = {
          light1: ['light2', 'p_light2', 'light'],
          light2: ['light3', 'p_light3', 'light'],
          heavy:  ['heavy2', 'p_heavy2', 'heavy'],
          heavy2: ['heavy3', 'p_heavy3', 'heavy'],
        };
        const link = CHAIN[player.state];
        // 连段窗口给到 18 帧（0.3s）：轻击一整段才 56 帧，窗口太窄的话
        // 玩家在第二段收招前按的键会被输入缓冲丢掉，连招直接断。
        // 窗口必须盖住整段招式的取消延迟。light1 的判定到 38 帧结束、
        // cancelFrom=3，也就是第 41 帧才开放连段 —— 窗口给小了，玩家在起手段
        // 按的键到那一刻已经过期，只能眼睁睁看着第一段打完再重来。
        if (link && consume(link[2], 55)) {
          player.setState(link[0], link[1]);
          return;
        }
        if (consume('roll', 10)) { startRoll(); return; }
      }
      if (player.frame >= totalFrames(m)) player.setState('idle');
      return;
    }

    case 'block': {
      player.frame++;
      // 格挡时可以缓慢移动（类魂：持盾是「半速龟缩」，不是原地站桩）
      applyMoveInput(0.42);
      if (player.state !== 'block') return;   // 移动里没改状态，保险

      // 松开格挡给 4 帧余量，避免抖动误松
      if (!down('block') && player.frame > 4) { player.setState('idle'); return; }

      // 格挡中可取消进翻滚 / 出轻击
      if (player.frame > 6 && consume('roll', 6)) { startRoll(); return; }
      if (player.frame > 8 && consume('light', 6)) { player.setState('light1', 'p_light1'); return; }
      return;
    }

    default: {
      // idle / move：接受一切输入
      // 顺序很重要：格挡判定放在移动之后，这样按住 L 的同时还能移动
      if (consume('roll')) { startRoll(); return; }
      if (consume('light')) { player.setState('light1', 'p_light1'); return; }
      if (consume('heavy')) { player.setState('heavy', 'p_heavy'); return; }

      const moved = applyMoveInput(1.0);
      if (down('block')) { player.setState('block'); return; }

      if (moved) {
        if (player.state === 'idle') player.setState('move');
      } else if (player.state === 'move') {
        player.setState('idle');
      }
      return;
    }
  }
}

/**
 * 统一的移动输入处理。
 * 屏幕基永远以「玩家→Boss」为前方：W 靠近、S 远离、A/D 绕圈，
 * 不会出现「相机追角色朝向、输入方向又依赖相机」的螺旋打转。
 * @param speedScale 移动速度倍率（格挡 0.42、正常 1.0）
 * @returns 这一帧是否真的产生了移动
 */
function applyMoveInput(speedScale = 1) {
  const fwdInput = (down('fwd') ? 1 : 0) - (down('back') ? 1 : 0);
  const strafeInput = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
  if (!fwdInput && !strafeInput) {
    player.moving = false;
    player.speed = 0;
    return false;
  }

  const { fwd, right } = screenBasis();

  // 倒退比前进慢 —— 这是常识，也是动画能对上的前提。
  // 按 4.2 m/s 倒着跑，倒退走动画得加速 2.7 倍才追得上，直接崩。
  const axisScale = fwdInput < 0 ? 0.55 : 1.0;
  const speed = CFG.runSpeed * speedScale * axisScale;

  player.moving = true;
  player.speed = speed;
  player.moveAxis = fwdInput;     // +1 前 / -1 后 / 0 只有横移，给动画选 clip 用
  player.strafeAxis = strafeInput;

  const dir = new THREE.Vector3()
    .addScaledVector(fwd, fwdInput)
    .addScaledVector(right, strafeInput)
    .normalize();

  player.pos.addScaledVector(dir, speed / 60);
  player.clampToArena();

  const targetYaw = player.lockOn
    ? Math.atan2(fwd.x, fwd.z)        // 锁定：脸始终对着 Boss
    // 非锁定后退时朝向要反过来：倒退动画是「面朝前、腿向后迈」，
    // 如果让角色脸朝移动方向，就成了月球漫步 —— 面朝目标却横着飘过去。
    // 所以后退时让角色背对移动方向，腿往后踩的方向才和实际位移一致。
    : (fwdInput < 0
        ? Math.atan2(-dir.x, -dir.z)
        : Math.atan2(dir.x, dir.z));
  player.turnToward(targetYaw, player.lockOn ? 16 : 12);
  return true;
}

function rollDist(frame) {
  if (frame <= 0) return 0;
  const t = Math.min(1, frame / 32);
  return CFG.rollDistance * (1 - Math.pow(1 - t, 2.2));
}

function startRoll() {
  const fwdInput = (down('fwd') ? 1 : 0) - (down('back') ? 1 : 0);
  const strafeInput = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
  if (fwdInput || strafeInput) {
    const { fwd, right } = screenBasis();
    const dir = new THREE.Vector3()
      .addScaledVector(fwd, fwdInput)
      .addScaledVector(right, strafeInput)
      .normalize();
    player.yaw = Math.atan2(dir.x, dir.z);
  }
  player.setState('roll');
  player.iframe = CFG.playerIframe;
}

// ═══════════════════════════════════════════════════════════════
//  6. Boss：权重轮盘 AI
// ═══════════════════════════════════════════════════════════════
const AI = {
  recent: [],
  lastMoveFrame: -999,
  gapFrames: 60,
  combatActive: false,

  // ── 意图层 ──────────────────────────────────────────────
  // 之前 Boss 只有「朝玩家走」和「出招」两个动作，看起来像个只会冲的靶子。
  // 真正的类魂 Boss 大部分时间在「观察、踱步、拉开距离」，攻击只是其中一环。
  // 意图会维持一段时间（40~120 帧）再重选，避免每帧抖动。
  intent: 'approach',      // approach | stalk | retreat | wait
  intentUntil: 0,
  strafeSign: 1,

  // ── 额外的行为槽 ────────────────────────────────────────
  dash: { until: 0, vx: 0, vz: 0 },   // 后跳/侧闪的短时位移
  nextBackstep: 0,                    // 后跳冷却
  nextDodge: 0,                       // 对玩家起手做反应的冷却
  feintChecked: false,                // 本次出招是否已经判过佯攻
  phase2: false,                      // 二阶段是否已触发
  phase3: false,

  // ── 反击意识 ────────────────────────────────────────────
  // Boss 挨打后进入「复仇窗口」：间隔缩短、只进攻不后撤、优先挑起手快的招。
  // 没有这个，Boss 就是个挨打不还手的木桩 —— 玩家可以无脑站桩输出。
  revengeUntil: 0,
  revengeHits: 0,
};

/** 触发一次短时弹开（后跳 / 侧闪） */
function bossDash(dirVec, frames, distPerFrame) {
  boss._lastDash = logicFrame;   // 给测试/调试用
  AI.dash.vx = dirVec.x * distPerFrame;
  AI.dash.vz = dirVec.z * distPerFrame;
  AI.dash.until = logicFrame + frames;
}

/** 按距离和随机性挑一个意图 */
function pickBossIntent(dist, stopDist) {
  // 复仇状态只进攻：不后撤、不站定，直接压上去或者绕圈找角度
  if (logicFrame < AI.revengeUntil) {
    return dist > stopDist * 2.0 ? 'approach' : 'stalk';
  }

  const r = rng();

  // 贴太近：后撤或绕圈，别一直顶着玩家
  if (dist < stopDist * 1.15) {
    return r < 0.5 ? 'retreat' : 'stalk';
  }
  // 中近距离（正好在多数招式的射程里）：绕圈找机会为主
  if (dist < 7) {
    if (r < 0.45) return 'stalk';
    if (r < 0.70) return 'approach';
    if (r < 0.88) return 'wait';
    return 'retreat';
  }
  // 远距离：接近为主，偶尔绕一下
  if (r < 0.70) return 'approach';
  if (r < 0.92) return 'stalk';
  return 'wait';
}

/** 按当前意图移动 Boss */
function moveBossByIntent(toPlayer, dist, stopDist) {
  const unit = toPlayer.clone().normalize();
  const right = new THREE.Vector3(-unit.z, 0, unit.x);   // 与连线垂直，用来绕圈
  const step = (CFG.runSpeed * 0.42) / 60;

  let moved = false;

  switch (AI.intent) {
    case 'approach':
      if (dist > stopDist) {
        boss.pos.addScaledVector(unit, step);
        moved = true;
      }
      break;

    case 'stalk':
      // 横向绕圈，同时轻微往里收
      boss.pos.addScaledVector(right, AI.strafeSign * step * 0.85);
      if (dist > stopDist * 1.8) boss.pos.addScaledVector(unit, step * 0.45);
      moved = true;
      break;

    case 'retreat':
      if (dist < stopDist * 2.6) {
        boss.pos.addScaledVector(unit, -step * 0.75);
        moved = true;
      }
      break;

    case 'wait':
    default:
      break;
  }

  if (moved) boss.clampToArena();
  boss.moving = moved;
}

function pickBossMove(dist) {
  const pool = [];
  for (const [id, m] of Object.entries(MOVES)) {
    if (!id.startsWith('b_')) continue;
    if (dist < m.minRange || dist > m.maxRange) continue;
    if (AI.recent.includes(id)) continue;
    const ready = (logicFrame - (AI.cooldowns?.[id] ?? -999)) > m.cooldown * 60 * CFG.bossCooldownScale;
    if (!ready) continue;
    // 距离越接近区间中心权重越高
    const mid = (m.minRange + m.maxRange) / 2;
    const half = Math.max(1, (m.maxRange - m.minRange) / 2);
    const centerBias = Math.max(0.15, 1 - (Math.abs(dist - mid) / half) * 0.7);

    // 复仇状态：起手越短权重越高，专挑快招糊玩家一脸
    let w = m.weight * centerBias;
    if (logicFrame < AI.revengeUntil) {
      const fastness = 1 - Math.min(1, m.startup / 60);
      w *= 1 + fastness * 1.8;
    }
    pool.push({ id, w });
  }
  if (!pool.length) return null;
  const sum = pool.reduce((s, p) => s + p.w, 0);
  let r = rng() * sum;
  for (const p of pool) { r -= p.w; if (r <= 0) return p.id; }
  return pool[pool.length - 1].id;
}

function bossTick() {
  if (boss.flashTimer > 0) boss.flashTimer--;
  if (boss.stunTimer > 0) boss.stunTimer--;

  // 短时弹开（后跳 / 侧闪）优先于一切移动，不受状态机影响
  if (logicFrame < AI.dash.until) {
    boss.pos.x += AI.dash.vx;
    boss.pos.z += AI.dash.vz;
    boss.clampToArena();
  }

  const toPlayer = player.pos.clone().sub(boss.pos).setY(0);
  const dist = toPlayer.length();
  const targetYaw = Math.atan2(toPlayer.x, toPlayer.z);

  switch (boss.state) {
    case 'dead': boss.frame++; return;

    case 'hitstun':
      boss.frame++;
      if (boss.frame >= boss.stunTimer) {
        boss.setState('idle');
        // 挨打完立刻能出手，不给玩家「打完一套继续站桩」的窗口
        if (logicFrame < AI.revengeUntil) {
          AI.gapFrames = 0;
          AI.intentUntil = 0;
        }
      }
      return;

    default: {
      // idle / attack：转向（转身速度是穿身收益的核心）
      boss.turnToward(targetYaw, CFG.bossTurnFrames);

      if (boss.move) {
        // ── 佯攻：起手到一半突然取消，专门惩罚「看见抬手就翻滚」的玩家 ──
        if (!AI.feintChecked
            && boss.frame >= boss.move.startup * 0.62
            && boss.frame < boss.move.startup
            && boss.move.active > 0) {
          AI.feintChecked = true;
          if (rng() < (CFG.bossFeintChance ?? 0.12)) {
            boss.setState('idle');
            AI.lastMoveFrame = logicFrame;
            AI.gapFrames = 18;          // 佯攻后很快接真招
            AI.intentUntil = 0;
            return;
          }
        }

        // 二阶段：血量 55% 以下，动作速度 +25%（改规则不改数值的示范位）
        const speedUp = boss.hp < boss.maxHp * 0.55 ? 1.25 : 1.0;
        boss.frame += speedUp;
        boss.stepMotion();

        if (boss.frame >= totalFrames(boss.move)) {
          boss.setState('idle');
          AI.lastMoveFrame = logicFrame;
          AI.gapFrames = Math.round(CFG.bossComboGap * 60 * (0.7 + rng() * 0.6));
          AI.feintChecked = false;
        }
        return;
      }

      // 停下距离：必须大于两者的碰撞半径之和，否则 Boss 会一直往玩家身上挤，
      // 推挤逻辑再把玩家顶开 —— 表现就是「被 Boss 推着走」
      const stopDist = player.hurt.radius + boss.hurt.radius * boss.scale + 0.30;

      // ── 阶段转换：血量跌破阈值时强制打断当前行为，吼一声进入下一阶段 ──
      if (!AI.phase2 && boss.hp < boss.maxHp * 0.55) {
        AI.phase2 = true;
        AI.intentUntil = 0;
        AI.feintChecked = false;
        boss.setState('attack', 'b_roar');
        boss.moving = false;
        return;
      }
      if (!AI.phase3 && boss.hp < boss.maxHp * 0.25) {
        AI.phase3 = true;
        AI.intentUntil = 0;
        boss.setState('attack', 'b_roar');
        boss.moving = false;
        return;
      }

      // ── 看破：玩家正在起手（还在 startup 段），Boss 有概率后撤躲开 ──
      const playerWinding = (player.state === 'light1' || player.state === 'light2'
                              || player.state === 'heavy')
                            && player.move
                            && player.frame < player.move.startup;
      if (playerWinding && dist < 6 && logicFrame > AI.nextDodge) {
        AI.nextDodge = logicFrame + 75;
        if (rng() < (CFG.bossDodgeChance ?? 0.35)) {
          bossDash(toPlayer.clone().normalize().negate(), 10, 0.28);
          AI.intent = 'retreat';
          AI.intentUntil = logicFrame + 36;
          AI.gapFrames = Math.max(AI.gapFrames, 10);
          return;
        }
      }

      // ── 贴身弹开：被压太紧时偶尔后跳到中距离，避免被贴脸压制 ──
      // 阈值要留出余量：Boss 的 approach 会在 stopDist 停住，实际距离通常落在
      // 1.2~1.5 倍之间，用 1.12 倍几乎永远够不到。
      if (dist < stopDist * 1.40 && logicFrame > AI.nextBackstep) {
        AI.nextBackstep = logicFrame + 110;
        if (rng() < (CFG.bossBackstepChance ?? 0.28)) {
          bossDash(toPlayer.clone().normalize().negate(), 12, 0.32);
          AI.intent = 'stalk';
          AI.intentUntil = logicFrame + 40;
          return;
        }
      }

      // ── 追击：玩家在翻滚就缩短等待，惩罚乱滚 ──
      if (player.state === 'roll') {
        AI.gapFrames = Math.min(AI.gapFrames, 12);
      }

      // 意图到期就重选。维持 40~120 帧，所以 Boss 会「踱一会儿再换想法」，
      // 而不是每帧随机抖来抖去。
      if (logicFrame >= AI.intentUntil) {
        AI.intent = pickBossIntent(dist, stopDist);
        AI.intentUntil = logicFrame + 40 + Math.floor(rng() * 80);
        if (rng() < 0.45) AI.strafeSign = -AI.strafeSign;   // 换个绕圈方向
      }

      // 出招后的间隔期：站定或绕圈，不再一味逼近 —— 这是给玩家的反击窗口
      if (logicFrame - AI.lastMoveFrame < AI.gapFrames) {
        moveBossByIntent(toPlayer, dist, stopDist);
        return;
      }

      const id = pickBossMove(dist);
      if (id) {
        AI.recent.push(id);
        if (AI.recent.length > 3) AI.recent.shift();
        AI.cooldowns ??= {};
        AI.cooldowns[id] = logicFrame;
        AI.feintChecked = false;
        boss.setState('attack', id);
        // 出完招换个意图，避免连着用同一套走位
        AI.intentUntil = 0;
        boss.moving = false;
        return;
      }

      // 没有可用招（都在冷却 / 超出射程）：按意图走位
      moveBossByIntent(toPlayer, dist, stopDist);
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  7. 固定步长主循环
// ═══════════════════════════════════════════════════════════════
const STEP = 1 / 60;
let acc = 0;
let lastTime = performance.now();
let logicFrame = 0;
let hitstopFrames = 0;
let shakeAmt = 0;

function hitstop(f) { hitstopFrames = Math.max(hitstopFrames, f); }
function shake(v) { shakeAmt = Math.min(0.3, shakeAmt + v); }

/** 出招第一帧挂预警；之后特效自己读 actor.frame，判定帧一到自动淡出 */
function syncTelegraph(a) {
  if (!a.move || a.move.active <= 0) return;
  if (a.frame !== 1) return;
  if (VFX_CFG.telegraphBossOnly && !a.isBoss) return;
  vfx.telegraph(a, a.move);
}

/** 判定窗口的第一帧放刀光（不是起手帧） */
function spawnSwingVFX(a) {
  const m = a.move;
  if (!m || m.active <= 0) return;
  if (a.frame !== m.startup) return;
  vfx.swingFromActor(a, m);
}

function tick() {
  if (CFG.paused) return;
  if (hitstopFrames > 0) { hitstopFrames--; shakeAmt *= 0.75; return; }

  logicFrame++;

  playerTick();
  bossTick();

  // 判定：双向
  resolveHit(player, boss, activeHitbox(player));
  resolveHit(boss, player, activeHitbox(boss));

  // 起手预警：出招第一帧挂上，判定帧前最亮（类魂的「读招」全靠它）
  syncTelegraph(player);
  syncTelegraph(boss);

  // 刀光在「判定帧第一帧」才亮 —— 起手就亮会让攻击没有重量
  spawnSwingVFX(player);
  spawnSwingVFX(boss);

  // 角色间推挤（翻滚时关闭 —— 这就是「穿身」）
  // 不对称：被顶开的是 Boss 多、玩家少。五五开的话，体型大的一方主动往里压，
  // 玩家就会被「推着走」—— 玩家自己走一步，Boss 挤回来半步，净位移全由 Boss 决定。
  if (player.state !== 'roll' && player.iframe <= 0) {
    const dx = player.pos.x - boss.pos.x;
    const dz = player.pos.z - boss.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = player.hurt.radius + boss.hurt.radius * boss.scale;

    if (d > 0.001 && d < minD) {
      const overlap = minD - d;
      const nx = dx / d;
      const nz = dz / d;

      // 玩家只让 15%
      player.pos.x += nx * overlap * 0.15;
      player.pos.z += nz * overlap * 0.15;
      player.clampToArena();

      // 重新量一次距离，剩下的重叠全部由 Boss 承担。
      // 这一步是「贴墙卡死」的解药：玩家在墙边时，上一次推挤会被 clamp 吃掉，
      // 如果还按 15/85 分摊，重叠永远消不掉，两个人就焊在原地了。
      const dx2 = player.pos.x - boss.pos.x;
      const dz2 = player.pos.z - boss.pos.z;
      const d2 = Math.hypot(dx2, dz2);
      if (d2 > 0.001 && d2 < minD) {
        const remain = minD - d2;
        boss.pos.x -= (dx2 / d2) * remain;
        boss.pos.z -= (dz2 / d2) * remain;
        boss.clampToArena();
      }
    }
  }

  // 战斗外恢复：待机 / 移动 / 格挡时回复韧性
  if (player.state === 'idle' || player.state === 'move' || player.state === 'block') {
    player.poise = Math.min(player.maxPoise, player.poise + 0.6);
  }
}

// ── 相机 ──────────────────────────────────────────────────────
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 6, 16);
let camYaw = Math.PI;

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

function updateCamera(dtReal) {
  const focus = player.pos.clone().add(new THREE.Vector3(0, 1.9, 0));
  const dist = 8.6;

  // 相机永远位于「玩家→Boss」的反向延长线上：Boss 恒定在画面正前方
  const { fwd } = screenBasis();
  const targetYaw = Math.atan2(-fwd.x, -fwd.z);
  camYaw = lerpAngle(camYaw, targetYaw, 1 - Math.pow(0.002, dtReal));

  const dir = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
  const desired = focus.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, 3.9, 0));

  const k = 1 - Math.pow(0.001, dtReal);
  camPos.lerp(desired, Math.min(1, k * 2.0));

  const lookAtPoint = focus.clone();
  if (player.lockOn) {
    lookAtPoint.lerp(
      boss.pos.clone().add(new THREE.Vector3(0, boss.hurt.height * boss.scale * 0.35, 0)),
      0.34
    );
  }
  camTarget.lerp(lookAtPoint, Math.min(1, k * 2.6));

  const shakeVec = new THREE.Vector3(
    (Math.random() - 0.5) * shakeAmt,
    (Math.random() - 0.5) * shakeAmt,
    (Math.random() - 0.5) * shakeAmt
  );
  camera.position.copy(camPos).add(shakeVec);
  camera.lookAt(camTarget);
  shakeAmt *= 0.86;
}

/** 把当前状态翻译成姿态并套到骨架上 */
function applyActorPose(a, dtReal) {
  if (!a.mesh || !a.mesh.spine) return;
  // 接了真模型时，骨骼动画接管，程序化姿态和脚部 IK 全部让位
  if (a.binder) return;
  const period = a.state === 'move' ? 36 : 90;
  const clock = (logicFrame % period) / period;
  const pose = poseFor(a, clock);

  // 攻击 / 翻滚 / 受击要精确跟随帧号，待机和跑动给一点平滑
  let blend = 0.85;
  if (a.state === 'idle' || a.state === 'move') blend = 0.28;
  else if (a.state === 'roll') blend = 0.55;

  applyPose(a.mesh, pose, blend);

  // 头部注视：头独立于躯干看向对手。
  // 这是「像个人」和「像个木偶」最便宜的分界线 —— 打架时人的头不会跟着身子乱晃。
  if (a.state !== 'dead' && a.mesh.head) {
    const look = a === player ? boss : player;
    const dx = look.pos.x - a.pos.x;
    const dz = look.pos.z - a.pos.z;
    const dist = Math.hypot(dx, dz) || 1;

    let dYaw = ((Math.atan2(dx, dz) - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    dYaw = THREE.MathUtils.clamp(dYaw, -1.0, 1.0);

    const targetH = look.hurt.height * look.scale * 0.55;
    const headH = 1.78 * a.scale;
    const pitch = Math.atan2(targetH - headH, dist);

    const h = a.mesh.head;
    h.rotation.y += (dYaw * 0.6 - h.rotation.y) * 0.22;
    h.rotation.x += (THREE.MathUtils.clamp(-pitch * 0.7, -0.32, 0.32) - h.rotation.x) * 0.22;
  }

  // 脚部 IK：只在「身体直立、脚踩地」的状态生效
  const grounded =
    a.state === 'idle' || a.state === 'move' || a.state === 'block' ||
    a.state === 'attack' || a.state === 'light1' || a.state === 'light2' ||
    a.state === 'heavy' || a.state === 'hitstun' || a.state === 'guardbreak';

  a.footIK.setEnabled(grounded);
  if (grounded) a.footIK.update(a, dtReal);
}

/** 格挡视觉：盾面出现；按下后 8 帧内（弹反窗口）高亮脉动，一眼看出「现在能反」 */
function updateGuardViz(a) {
  const g = a.mesh.guard;
  const e = a.mesh.guardEdge;
  if (!g) return;

  const active = a.state === 'block';
  g.visible = active;
  if (e) e.visible = active;
  if (!active) return;

  const parry = a.frame <= 8;
  const pulse = parry ? 1 + Math.sin(logicFrame * 0.9) * 0.06 : 1.0;
  const color = parry ? 0xffffff : 0x9ee6ff;

  g.material.opacity = parry ? 0.58 : 0.30;
  g.material.color.setHex(color);
  g.scale.setScalar(pulse);

  if (e) {
    e.material.opacity = parry ? 1.0 : 0.65;
    e.material.color.setHex(color);
    e.scale.setScalar(pulse);
  }
}

// ── 渲染 ──────────────────────────────────────────────────────
function render(dtReal) {
  // 美术模型动画（灰盒可不接）
  const animDt = CFG.paused ? 0 : dtReal;   // 暂停时冻结动画，方便逐帧检查
  if (player.binder) player.binder.update(player, animDt);
  if (boss.binder) boss.binder.update(boss, animDt);

  player.syncMesh();
  boss.syncMesh();

  // 判定可视化
  const pv = activeHitbox(player);
  placeViz(player.hitViz, player.pos, player.yaw,
    player.move ? player.move.hitbox.offset * player.scale : 0,
    pv ? pv.radius : 0,
    pv ? pv.yMin : 0, pv ? pv.yMax : 1, CFG.showHitbox && !!pv);

  const bv = activeHitbox(boss);
  placeViz(boss.hitViz, boss.pos, boss.yaw,
    boss.move ? boss.move.hitbox.offset * boss.scale : 0,
    bv ? bv.radius : 0,
    bv ? bv.yMin : 0, bv ? bv.yMax : 1, CFG.showHitbox && !!bv);

  // 受击框（受击判定区，非遮挡）
  placeViz(player.hurtViz, player.pos, 0, 0,
    player.hurt.radius * player.scale, 0, player.hurt.height * player.scale, CFG.showHitbox);
  placeViz(boss.hurtViz, boss.pos, 0, 0,
    boss.hurt.radius * boss.scale, 0, boss.hurt.height * boss.scale, CFG.showHitbox);

  // 格挡 / 弹反窗口的可视化
  updateGuardViz(player);

  // 姿态：由帧表驱动的程序化骨骼动画 + 脚部 IK
  applyActorPose(player, dtReal);
  applyActorPose(boss, dtReal);

  // 特效推进：顿帧时冻结（打在铁上那一下要「停」住）
  vfx.update(CFG.paused || hitstopFrames > 0 ? 0 : dtReal * CFG.timeScale);

  renderer.render(scene, camera);
}

// ── 主循环 ────────────────────────────────────────────────────
function loop(now) {
  requestAnimationFrame(loop);
  const dtReal = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (!CFG.paused) {
    acc += dtReal * CFG.timeScale;
    let guard = 0;
    while (acc >= STEP && guard++ < 5) {
      tick();
      acc -= STEP;
    }
    updateCamera(dtReal);
  }

  render(dtReal);
  updateHUD();
}

// ═══════════════════════════════════════════════════════════════
//  8. HUD
// ═══════════════════════════════════════════════════════════════
const hud = document.getElementById('hud');
const bannerEl = document.getElementById('banner');
let bannerTimer = null;

function banner(text, ms = 1200, isDead = false) {
  bannerEl.textContent = text;
  bannerEl.classList.toggle('dead', isDead);
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), ms);
}

function bar(cur, max, width = 10) {
  const n = Math.round((cur / max) * width);
  return '█'.repeat(Math.max(0, n)) + '░'.repeat(Math.max(0, width - n));
}

function stateLabel(a) {
  const m = a.move;
  if (m) return `${a.state}:${a.moveId}#${Math.round(a.frame)}/${totalFrames(m)}`;
  if (a.state === 'block') return `block#${Math.round(a.frame)}${a.frame <= 8 ? ' 弹反中' : ''}`;
  return `${a.state}#${Math.round(a.frame)}`;
}

/**
 * 帧数据进度条：▁起手 █判定 ░收招，暗色=未播放，亮色=已播放
 * 这是调参时唯一需要一直盯着的 UI
 */
function frameBar(a) {
  const m = a.move;
  if (!m) return '';
  const total = totalFrames(m);
  const W = 34;
  const sEnd = m.startup / total;
  const aEnd = (m.startup + m.active) / total;
  const curIdx = Math.min(W - 1, Math.floor((a.frame / total) * W));

  let html = '';
  for (let i = 0; i < W; i++) {
    const t = i / W;
    let ch, cls;
    if (t < sEnd) { ch = '▁'; cls = 'fb-s'; }
    else if (t < aEnd) { ch = '█'; cls = 'fb-a'; }
    else { ch = '░'; cls = 'fb-r'; }
    const passed = i <= curIdx;
    if (i === curIdx) html += `<span class="cur">${ch}</span>`;
    else html += `<span class="${cls}${passed ? '' : ' dim'}">${ch}</span>`;
  }
  return html;
}

/** 格挡专用条：只关心「弹反窗还剩几帧」 */
function guardBar(a) {
  if (a.frame > 8) return '<span class="k">格挡稳定 · 弹反窗已过</span>';
  const left = 9 - a.frame;
  return `<span class="warn">弹反窗 ${bar(left, 8, 8)} ${a.frame}/8</span>`;
}

function updateHUD() {
  const dist = player.pos.distanceTo(boss.pos);
  const pMove = player.state === 'light1' || player.state === 'light2' ||
                player.state === 'heavy' || player.state === 'roll' ||
                player.state === 'block';
  hud.innerHTML =
`<span class="k">玩家</span>  HP <span class="p">${bar(player.hp, player.maxHp, 20)}</span> ${Math.round(player.hp)}
      <span class="k">韧性</span> <span class="p">${bar(player.poise, player.maxPoise, 10)}</span>  <span class="k">无敌</span> ${player.iframe > 0 ? '<span class="warn">●' + player.iframe + '</span>' : '○'}
      <span class="k">状态</span> <span class="p">${stateLabel(player).padEnd(24)}</span> <span class="k">锁定</span> ${player.lockOn ? '<span class="p">ON</span>' : 'off'}
      ${player.state === 'block' ? guardBar(player) : (pMove ? frameBar(player) : '')}

<span class="k">Boss</span>  HP <span class="b">${bar(boss.hp, boss.maxHp, 20)}</span> ${Math.round(boss.hp)}
      <span class="k">韧性</span> <span class="b">${bar(boss.poise, boss.maxPoise, 10)}</span>  <span class="k">距离</span> ${dist.toFixed(1)}m
      <span class="k">状态</span> <span class="b">${stateLabel(boss).padEnd(24)}</span> ${boss.hp < boss.maxHp * 0.55 ? '<span class="warn">二阶段</span>' : '<span class="k">一阶段</span>'}
      ${frameBar(boss)}

<span class="k">逻辑帧</span> ${logicFrame}   <span class="k">hitstop</span> ${hitstopFrames}   <span class="k">倍速</span> ${CFG.timeScale}x`;
}

// ═══════════════════════════════════════════════════════════════
//  9. 调参面板
// ═══════════════════════════════════════════════════════════════
const gui = new GUI({ title: '帧数据调参（改完立即生效）' });
const fPlayer = gui.addFolder('玩家');
fPlayer.add(CFG, 'playerIframe', 6, 20, 1).name('翻滚无敌帧');
fPlayer.add(CFG, 'rollTotal', 20, 50, 1).name('翻滚总帧');
fPlayer.add(CFG, 'rollDistance', 2, 8, 0.1).name('翻滚距离(m)');
fPlayer.add(CFG, 'runSpeed', 2, 8, 0.1).name('移速(m/s)');

const fBoss = gui.addFolder('Boss');
fBoss.add(CFG, 'bossTurnFrames', 8, 60, 1).name('转身180°帧');
fBoss.add(CFG, 'bossComboGap', 0.3, 2.5, 0.05).name('连段间隔(s)');
fBoss.add(CFG, 'bossCooldownScale', 0.3, 2, 0.05).name('冷却倍率');

const fMoves = gui.addFolder('招式帧数据');
const moveParams = {};
const moveInfo = {};
for (const [id, m] of Object.entries(MOVES)) {
  if (!id.startsWith('b_')) continue;
  const sub = fMoves.addFolder(`${m.label} [${id}]`);
  moveParams[id] = { startup: m.startup, active: m.active, recovery: m.recovery };
  moveInfo[id] = { total: totalFrames(m), check: 'ok' };

  const refresh = () => {
    moveInfo[id].total = totalFrames(m);
    const issues = moveIssues(id, m);
    moveInfo[id].check = issues.length ? '⚠ ' + issues[0] : 'ok';
    sub.controllers.forEach((c) => c.updateDisplay());
  };
  refresh();

  // 范围来自 LIMITS，想调得更长直接改 frame-data.js 里的数字
  sub.add(moveParams[id], 'startup', LIMITS.startup.min, LIMITS.startup.max, 1).name('起手帧')
    .onChange((v) => { m.startup = v; refresh(); });
  sub.add(moveParams[id], 'active', LIMITS.active.min, LIMITS.active.max, 1).name('判定帧')
    .onChange((v) => { m.active = v; refresh(); });
  sub.add(moveParams[id], 'recovery', LIMITS.recovery.min, LIMITS.recovery.max, 1).name('收招帧')
    .onChange((v) => { m.recovery = v; refresh(); });
  sub.add(m, 'damage', 0, 900, 10).name('伤害');

  // 只读：总帧 + 越界检查
  sub.add(moveInfo[id], 'total').name('→ 总帧').disable();
  sub.add(moveInfo[id], 'check').name('→ 检查').disable();
}

const fDebug = gui.addFolder('调试');
fDebug.add(CFG, 'showHitbox').name('判定框 (F1)').listen();
fDebug.add(CFG, 'timeScale', 0.05, 2, 0.05).name('时间倍速 (F2)').listen();
fDebug.add(CFG, 'paused').name('暂停 (F3)').listen();
fDebug.add(CFG, 'hitstop', 0, 16, 1).name('命中冻结帧');
fDebug.add({ fn: resetFight }, 'fn').name('重开 (R)');
fDebug.add({ fn: downloadJSON }, 'fn').name('导出帧表 (P)');

const fVfx = gui.addFolder('近战特效');
fVfx.add(VFX_CFG, 'enabled').name('开启');
fVfx.add(VFX_CFG, 'intensity', 0, 2, 0.05).name('强度');
fVfx.add(VFX_CFG, 'slashLife', 0.4, 2.5, 0.05).name('刀光时长倍率');
fVfx.add(VFX_CFG, 'sparkCount', 0, 40, 1).name('火花数量');
fVfx.add(VFX_CFG, 'telegraph').name('Boss 起手预警');

function syncGUI() { gui.controllersRecursive().forEach((c) => c.updateDisplay()); }

function downloadJSON() {
  const blob = new Blob([dumpJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moves-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════════
// 10. 重开
// ═══════════════════════════════════════════════════════════════
function resetFight() {
  player.reset([0, 8], Math.PI);
  boss.reset([0, -8], 0);
  AI.recent = [];
  AI.lastMoveFrame = -999;
  AI.gapFrames = 90;
  AI.cooldowns = {};
  rng = mulberry32(0xC0FFEE);
  logicFrame = 0;
  hitstopFrames = 0;
  shakeAmt = 0;
  vfx.clear();
  player.footIK.reset(player);
  boss.footIK.reset(boss);
  bannerEl.classList.remove('show');
}

// ═══════════════════════════════════════════════════════════════
// 11. 美术资源接入钩子
//     不带参数 → 纯灰盒，零额外依赖
//     带参数   → 用真模型替换外观，帧数据与判定完全不变
//     用法：?p=assets/hero.glb&ps=1.0&b=assets/boss.glb&bs=2.6
// ═══════════════════════════════════════════════════════════════
(async function attachModels() {
  const q = new URLSearchParams(location.search);

  // 默认就加载完整美术资源：模型 + 武器 + 动捕包。
  // 想回到纯灰盒（零依赖、秒开）加 ?graybox=1。
  const graybox = q.get('graybox') != null;
  const pUrl = graybox ? null : (q.get('p') ?? 'assets/Y_Bot.glb');
  const bUrl = graybox ? null : (q.get('b') ?? 'assets/Y_Bot.glb');
  const wantWeapon = !graybox && q.get('noweapon') == null;
  const weaponUrl = wantWeapon ? (q.get('wp') ?? 'assets/jian_min.glb') : null;
  const wantAnim = !graybox && q.get('anim') !== '0';
  if (!pUrl && !bUrl) return;

  try {
    const { bindModel, loadAnimationPack } = await import('./asset-adapter.js');
    banner('加载模型…', 1500);
    await Promise.all([
      pUrl ? bindModel(player, pUrl, {
        renderer,
        targetHeight: Number(q.get('ph') ?? 1.95),
        // 武器：优先用外部模型（wp 参数），否则用程序化生成的剑
        weaponModel: weaponUrl,
        weaponOpts: weaponUrl ? {
          length: Number(q.get('wl') ?? 1.4),
          alignAxis: q.get('wax') ?? 'z',
          gripEnd: Number(q.get('wgrip') ?? -1),
          gripShift: Number(q.get('wshift') ?? 0.10),
          palmOffset: Number(q.get('wpalm') ?? 0.06),
          palmSide: Number(q.get('wside') ?? -0.05),
          rotation: q.get('wrot') ? q.get('wrot').split(',').map(Number) : undefined,
        } : undefined,
        weapon: (!weaponUrl && wantWeapon) ? { length: Number(q.get('wl') ?? 1.4) } : null,
        scale: Number(q.get('ps') ?? 1),
        yawOffset: Number(q.get('py') ?? 0),
      }) : null,
      bUrl ? bindModel(boss, bUrl, {
        renderer,
        targetHeight: Number(q.get('bh') ?? 4.60),
        // Boss 也用同一把模型剑，只是按体型放大
        weaponModel: weaponUrl,
        weaponOpts: weaponUrl ? {
          length: Number(q.get('bwl') ?? 2.2),
          alignAxis: q.get('wax') ?? 'z',
          gripEnd: Number(q.get('wgrip') ?? -1),
          gripShift: Number(q.get('wshift') ?? 0.10),
          palmOffset: Number(q.get('wpalm') ?? 0.06),
          palmSide: Number(q.get('wside') ?? -0.05),
          rotation: q.get('wrot') ? q.get('wrot').split(',').map(Number) : undefined,
        } : undefined,
        weapon: (!weaponUrl && wantWeapon) ? { length: Number(q.get('bwl') ?? 2.4) } : null,
        scale: Number(q.get('bs') ?? 1),
        yawOffset: Number(q.get('by') ?? 0),
      }) : null,
    ].filter(Boolean));

    // 追加类魂动作包（13 条 Mixamo 动捕，骨骼名同源，不需要 retarget）
    if (wantAnim) {
      banner('加载动作包…', 1200);
      const actors = [player, boss].filter((a) => a.binder);
      const counts = await Promise.all(actors.map((a) => loadAnimationPack(a.binder)));
      console.log('[anim-pack] clips loaded per actor:', counts);
    }

    banner('模型就位', 1200);
  } catch (err) {
    console.warn('[asset] 模型加载失败，保持灰盒：', err);
    banner('模型加载失败，保持灰盒', 2200);
  }
})();

// ═══════════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════════
// 调试接口：控制台里可以直接查状态、脚的世界坐标
window.__dbg = { player, boss, CFG, MOVES, camera, scene, AI };

// 启动时校验一遍帧数据上限，越界的招式直接打到 console
const frameIssues = validateAll();

resetFight();
requestAnimationFrame(loop);
banner(frameIssues.length ? `帧数据越界 ${frameIssues.length} 项 · 见 console` : '按 J 开打', 1800);
