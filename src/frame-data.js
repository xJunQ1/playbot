import { METEOR } from './meteor-smash.js';

// ─────────────────────────────────────────────────────────────
//  帧数据表 —— 这是整个战斗的全部真相
//  所有数值单位：帧（60fps）/ 米 / 点
//  修改后刷新页面即生效；按 P 可导出当前调参结果
// ─────────────────────────────────────────────────────────────

/** 全局可调参数（调参面板直接绑定这个对象） */
export const CFG = {
  // 玩家
  playerIframe: 16,        // 翻滚无敌帧
  rollTotal: 52,           // 翻滚总帧（对齐 Stand_To_Roll 截取后的 46 帧 + 缓冲）
  rollDistance: 4.6,       // 翻滚位移（米）
  rollCancelFrom: 24,      // 翻滚可取消帧
  runSpeed: 4.2,
  walkSpeed: 2.0,

  // 战斗全局
  hitstop: 5,              // 轻击与连斩的顿帧基准
  hitstopHeavy: 8,
  camShake: 0.06,

  // Boss
  bossTurnFrames: 34,      // 转身 180° 所需帧（穿身收益的核心旋钮）
  bossComboGap: 0.9,       // 连段间隔（秒），难度第一旋钮
  bossAggroRange: 26,
  bossCooldownScale: 1.0,

  // Boss 的「额外行为」概率（调参用）
  bossFeintChance: 0,       // 佯攻：起手到一半取消（0 = 关；攻击一旦出手就打到底）
  bossDodgeChance: 0.35,    // 看破：玩家起手时后撤
  bossBackstepChance: 0.28, // 贴身弹开概率（内部还有冷却）
  bossBlockChance: 0.35,    // 架招：玩家起手时举盾格挡的概率
  bossBlockFrames: 34,      // 一次架招持续帧数
  bossBlockCooldown: 150,   // 两次架招的最短间隔（帧）

  // 调试
  showHitbox: true,
  timeScale: 1.0,
  paused: false,
};

const LIFT_END = 43;
const TOSS_START = LIFT_END + 90;

export const GRAB_TIMING = {
  reach: 4,
  contactLead: 1,
  contactFrames: 4,
  pull: 7,
  lift: LIFT_END,
  toss: TOSS_START,
  kickStart: TOSS_START + 3,
  kick: TOSS_START + 19,
  followThrough: TOSS_START + 48,
  recover: TOSS_START + 55,
  missRecovery: 27,
  wallStun: 34,
};

/**
 * 招式定义
 * startup  起手帧
 * active   判定帧数（>0 才产生 hitbox）
 * recovery 收招帧数
 * cancelFrom 从「判定结束」后多少帧起可被取消
 * motion    [[帧, 前向位移(m)]...] 线性插值，即 root motion 的真相
 * hitbox    offset 前向偏移 / radius 半径 / yMin..yMax 高度区间
 */
export const MOVES = {
  // ── 玩家 ──────────────────────────────────────────────
  // 帧数按 Y_Bot 同源动捕的打击点重配（tools/analyze.html 实测）：
  //   p_light1  Sword_And_Shield_Slash  strike@42/212 → 截到 64，压成 56 帧
  //   p_light2  Sword_Slash             strike@35/90  → 截到 55，压成 52 帧
  //   p_heavy   Great_Sword_Slash       strike@43/211 → 截到 77，放成 80 帧
  p_light1: {
    // 轻击四段连招·第 1 段（0.00–0.62s，实测出刀 0.26s）
    label: '轻击 1（连招·第一段）', swing: 'horizontal',
    startup: 16, active: 6, recovery: 15, cancelFrom: 0,
    damage: 80, poise: 14, hitstun: 14, stamina: 9,
    motion: [[0, 0], [16, 0.08], [24, 0.34], [37, 0.34]],
    hitbox: { offset: 0.95, radius: 0.72, yMin: 0.30, yMax: 1.85 },
  },
  p_light2: {
    // 第 2 段（0.62–1.34s，段内出刀 0.12s —— 承接上一刀的惯性，起手很短）
    label: '轻击 2（连招·第二段）', swing: 'horizontal',
    startup: 7, active: 6, recovery: 30, cancelFrom: 0,
    damage: 90, poise: 16, hitstun: 16, stamina: 10,
    motion: [[0, 0], [7, 0.05], [16, 0.30], [43, 0.30]],
    hitbox: { offset: 1.00, radius: 0.78, yMin: 0.28, yMax: 1.90 },
  },
  p_light3: {
    // 第 3 段（1.34–1.94s，段内出刀 0.24s）
    label: '轻击 3（连招·第三段）', swing: 'horizontal',
    startup: 15, active: 6, recovery: 15, cancelFrom: 0,
    damage: 110, poise: 20, hitstun: 18, stamina: 12,
    motion: [[0, 0], [15, 0.08], [24, 0.36], [36, 0.36]],
    hitbox: { offset: 1.05, radius: 0.85, yMin: 0.25, yMax: 1.95 },
  },
  p_light4: {
    // 终结（1.94–2.60s，段内出刀 0.48s，收招最长）
    label: '轻击 4（连招·终结）', swing: 'thrust',
    startup: 26, active: 8, recovery: 6, cancelFrom: 6,
    damage: 160, poise: 30, hitstun: 24, stamina: 16,
    motion: [[0, 0], [26, 0.10], [34, 0.95], [40, 0.95]],
    hitbox: { offset: 1.15, radius: 0.90, yMin: 0.22, yMax: 2.05 },
  },
  p_heavy: {
    // 重击三连击·第 1 段（0.00–0.50s，实测出刀 0.26s）
    label: '重击 1（连击·第一段）', swing: 'vertical',
    startup: 15, active: 7, recovery: 8, cancelFrom: 0,   // 段长只有 30 帧，连段窗口必须紧贴判定结束
    damage: 260, poise: 55, hitstun: 34, stamina: 26,
    motion: [[0, 0], [15, 0.10], [22, 0.55], [30, 0.55]],
    hitbox: { offset: 1.25, radius: 0.95, yMin: 0.20, yMax: 2.10 },
  },
  p_heavy2: {
    // 重击三连击·第 2 段（0.50–1.05s，实测出刀 0.74s → 段内 0.24s）
    label: '重击 2（连击·第二段）', swing: 'horizontal',
    startup: 14, active: 8, recovery: 11, cancelFrom: 0,
    damage: 300, poise: 60, hitstun: 34, stamina: 24,
    motion: [[0, 0], [14, 0.12], [22, 0.70], [33, 0.70]],
    hitbox: { offset: 1.30, radius: 1.00, yMin: 0.20, yMax: 2.15 },
  },
  p_heavy3: {
    // 重击三连击·第 3 段（1.05–1.70s，实测出刀 1.22s → 段内 0.17s，后面带 1.58s 的收势）
    label: '重击 3（连击·终结）', swing: 'thrust',
    startup: 10, active: 10, recovery: 19, cancelFrom: 8,
    damage: 380, poise: 80, hitstun: 40, stamina: 30,
    motion: [[0, 0], [10, 0.05], [18, 0.85], [26, 1.20], [39, 1.20]],
    hitbox: { offset: 1.20, radius: 0.95, yMin: 0.20, yMax: 2.10 },
  },

  // ── Boss ──────────────────────────────────────────────
  //   b_sweep   Great_Sword_High_Spin_Attack  strike@63/113 → 截到 93，90 帧
  //   b_slam    Sword_And_Shield_Slash        strike@42/212 → 截到 76，90 帧
  b_sweep: {
    label: '横扫（中）',
    swing: 'horizontal',
    startup: 54, active: 16, recovery: 20, cancelFrom: 14,
    damage: 320, poise: 32, hitstun: 22, stamina: 0,
    motion: [[0, 0], [54, 0.15], [62, 1.10], [74, 1.60], [90, 1.60]],
    // offset/radius 会乘 boss.scale：0.85×2.6=2.2m 前方、0.45×2.6=1.17m 半径
    // 远端 4.16m，要盖过 stopDist（3.69m），否则 Boss 站在攻击距离外永远打空
    hitbox: { offset: 1.05, radius: 0.55, yMin: 0.0, yMax: 1.05 },
    minRange: 0, maxRange: 5.5, weight: 1.0, cooldown: 1.2,
  },
  b_slam: {
    label: '下砸（慢）', swing: 'vertical',
    startup: 38, active: 18, recovery: 34, cancelFrom: 16,
    damage: 420, poise: 42, hitstun: 30, stamina: 0,
    motion: [[0, 0], [38, 0.10], [50, 0.60], [90, 0.60]],
    // 下砸范围本来就大：0.95×2.6=2.47m 前方、0.65×2.6=1.69m 半径
    hitbox: { offset: 1.05, radius: 0.70, yMin: 0.0, yMax: 0.52 },
    minRange: 0, maxRange: 4.5, weight: 0.85, cooldown: 2.0,
  },

  b_heavy_combo: {
    label: '重剑四连斩', swing: 'horizontal',
    startup: 24, active: 8, recovery: 204, cancelFrom: 0,
    damage: 165, poise: 17, hitstun: 16, stamina: 0,
    // 挥砍窗口按实际剑尖轨迹校准。最后一段是纵向下砸。
    followUps: [
      { delay: 36, active: 7 },
      { delay: 72, active: 8 },
      { delay: 117, active: 8, swing: 'vertical' },
    ],
    motion: [[0, 0], [14, 0.12], [30, 0.75], [48, 0.83], [72, 1.68],
      [106, 2.32], [129, 2.39], [146, 2.92], [178, 2.92], [220, 3.15]],
    hitbox: { offset: 0.76, radius: 0.58, yMin: 0.0, yMax: 0.75 },
    minRange: 2.7, maxRange: 4.5, weight: 0.48, cooldown: 8,
    requiresClip: true,
  },
  b_meteor: {
    label: '熔岩跃砸', swing: 'none', meteor: true, requiresClip: true,
    startup: METEOR.landingFrame, active: 1, recovery: METEOR.end - METEOR.impact - 1, cancelFrom: 0,
    damage: 490, poise: 55, hitstun: 35, stamina: 0,
    hitbox: { offset: 0, radius: METEOR.radius, yMin: 0, yMax: 2.15 },
    minRange: 2.8, maxRange: 12.8, weight: 1.32, cooldown: 12,
  },
  b_grab: {
    label: '破防擒拿', swing: 'none', grab: true,
    startup: 37, active: 7, recovery: GRAB_TIMING.recover, cancelFrom: 0,
    damage: 280, poise: 0, hitstun: 0, stamina: 0,
    dashDistance: 5.25, dashExtension: 1.10, aimLockFrames: 6,
    hitbox: { offset: 0.24, radius: 0.42, yMin: 0.10, yMax: 0.64 },
    minRange: 4.1, maxRange: 6.9, weight: 0.42, cooldown: 13,
  },
};

/** 派生：总帧数 */
export function totalFrames(m) {
  return (m.grab ? grabLastContactFrame(m) : m.startup + m.active) + m.recovery;
}

export function grabContactFrame(move) {
  return move.startup + move.active + (move.active > 0 ? GRAB_TIMING.reach : 0);
}

export function grabLastContactFrame(move) {
  const extra = move.active > 0 ? GRAB_TIMING.contactFrames - GRAB_TIMING.contactLead - 1 : 0;
  return grabContactFrame(move) + extra;
}

// ─────────────────────────────────────────────────────────────
//  帧数上限：分三层，别混为一谈
//  ① UI 硬上限  —— 滑块能拉到的范围（改这里的数字就能继续拉长）
//  ② 设计软上限 —— 超过照样能跑，但玩家体验会崩，只给警告
//  ③ 物理上限   —— 动画系统真正撑不住的地方
// ─────────────────────────────────────────────────────────────
export const LIMITS = {
  // ① UI 滑块范围（放宽到足够做超长蓄力大招）
  startup:  { min: 1, max: 300 },
  active:   { min: 0, max: 90 },
  recovery: { min: 0, max: 300 },

  // ② 设计软上限（超了 console 警告 + 面板标红，不阻止）
  startupWarn: 150,     // 2.5s：再长玩家会以为游戏卡死
  activeWarn: 20,       // 再长就觉得「明明躲开了还是被打」
  totalWarn: 240,       // 4s：输入缓冲会过期，收招前按键全丢

  // ③ 物理上限：动画拉伸倍率下限
  //    timeScale = clipDuration×60 / 总帧。低于 0.35 就是 1/3 速慢放，骨骼动起来很假
  timeScaleFloor: 0.35,
  timeScaleCeil: 3.0,
};

/** 检查一个招式是否越界，返回问题描述数组（空数组 = 健康） */
export function moveIssues(id, m) {
  const out = [];
  const total = totalFrames(m);

  if (m.startup > LIMITS.startupWarn) {
    out.push(`起手 ${m.startup}f 超过 ${LIMITS.startupWarn}f：玩家会以为游戏卡了`);
  }
  if (m.active > LIMITS.activeWarn) {
    out.push(`判定 ${m.active}f 超过 ${LIMITS.activeWarn}f：玩家会觉得「躲不掉」`);
  }
  if (total > LIMITS.totalWarn) {
    out.push(`总帧 ${total}f 超过 ${LIMITS.totalWarn}f：超过 4 秒，8 帧输入缓冲会过期`);
  }
  if (m.startup + m.active === 0) {
    out.push('没有出招窗口（startup 和 active 都是 0）');
  }
  if (m.startup > LIMITS.startup.max || m.active > LIMITS.active.max || m.recovery > LIMITS.recovery.max) {
    out.push('超出 UI 滑块上限，只能用 JSON 导入');
  }
  return out;
}

/**
 * 把动画剪辑拉伸到帧表长度需要的倍率。
 * 接真模型时用它校核：< timeScaleFloor 说明这段动画撑不住这么长的帧表，得重切或分段。
 */
export function animationScale(m, clipDurationSec) {
  return (clipDurationSec * 60) / Math.max(1, totalFrames(m));
}

/** 启动时跑一遍，把所有越界招式打到 console */
export function validateAll() {
  const report = [];
  for (const [id, m] of Object.entries(MOVES)) {
    const issues = moveIssues(id, m);
    if (issues.length) report.push({ id, label: m.label, total: totalFrames(m), issues });
  }
  if (report.length) {
    console.warn(`[frame-data] ${report.length} 个招式越界：`);
    for (const r of report) console.warn(`  ${r.id} (${r.label}) 总帧 ${r.total}`, r.issues);
  }
  return report;
}

/** 取某帧的累积前向位移 */
export function motionAt(m, frame) {
  const pts = m.motion;
  if (!pts || pts.length === 0) return 0;
  if (frame <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [f1, d1] = pts[i];
    const [f0, d0] = pts[i - 1];
    if (frame <= f1) {
      const t = f1 === f0 ? 0 : (frame - f0) / (f1 - f0);
      return d0 + (d1 - d0) * t;
    }
  }
  return pts[pts.length - 1][1];
}

/** 导出当前完整配置为 JSON 字符串 */
export function dumpJSON() {
  return JSON.stringify({ CFG, MOVES }, null, 2);
}
