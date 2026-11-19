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
  hitstop: 5,              // 命中冻结帧（按伤害分级见 hitstopByDamage）
  hitstopHeavy: 8,
  camShake: 0.06,

  // Boss
  bossTurnFrames: 34,      // 转身 180° 所需帧（穿身收益的核心旋钮）
  bossComboGap: 0.9,       // 连段间隔（秒），难度第一旋钮
  bossAggroRange: 26,
  bossCooldownScale: 1.0,

  // Boss 的「额外行为」概率（调参用）
  bossFeintChance: 0.12,    // 佯攻：起手到一半取消
  bossDodgeChance: 0.35,    // 看破：玩家起手时后撤
  bossBackstepChance: 0.28, // 贴身弹开概率（内部还有冷却）

  // 调试
  showHitbox: true,
  timeScale: 1.0,
  paused: false,
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
    label: '轻击 1（横劈）',
    swing: 'horizontal',
    startup: 32, active: 6, recovery: 14, cancelFrom: 3,
    damage: 90, poise: 16, hitstun: 16, stamina: 12,
    motion: [[0, 0], [32, 0.10], [40, 0.42], [52, 0.42]],
    hitbox: { offset: 0.95, radius: 0.72, yMin: 0.30, yMax: 1.85 },
  },
  p_light2: {
    // 二段：旋身斩。Hips 在整段里累计转 407°（实测），身体会转一整圈。
    // 判定不能用「前方扇形」—— 视觉上剑在绕圈，判定框却钉在角色正前方，
    // 打到背后的人看着像穿模。这里改成以角色为中心的环绕判定。
    label: '轻击 2（旋身斩）',
    swing: 'horizontal',
    startup: 32, active: 10, recovery: 10, cancelFrom: 3,   // 总 52 帧，和轻击 1 同帧数（起手 32 + 判定 10 + 收招 10）
    damage: 110, poise: 22, hitstun: 18, stamina: 14,
    motion: [[0, 0], [32, 0.10], [44, 0.40], [52, 0.40]],
    hitbox: { offset: 0.0, radius: 1.45, yMin: 0.25, yMax: 2.00 },
  },
  p_light3: {
    // 终结：剑盾斩。收招最长，代价是耐力翻倍
    label: '轻击 3（剑盾斩）',
    swing: 'horizontal',
    startup: 35, active: 16, recovery: 19, cancelFrom: 8,
    damage: 150, poise: 30, hitstun: 22, stamina: 18,
    motion: [[0, 0], [35, 0.18], [48, 0.85], [70, 0.85]],
    hitbox: { offset: 1.05, radius: 0.85, yMin: 0.25, yMax: 1.95 },
  },
  p_heavy: {
    label: '重击', swing: 'vertical',
    startup: 41, active: 15, recovery: 24, cancelFrom: 14,
    damage: 260, poise: 55, hitstun: 34, stamina: 30,
    motion: [[0, 0], [41, 0.12], [52, 0.62], [80, 0.62]],
    hitbox: { offset: 1.25, radius: 0.95, yMin: 0.20, yMax: 2.10 },
  },
  p_heavy2: {
    // 二段：剑盾横扫，横向大范围，和大剑的竖劈形成十字
    label: '重击 2（剑盾横扫）',
    swing: 'horizontal',
    startup: 36, active: 17, recovery: 32, cancelFrom: 12,
    damage: 300, poise: 60, hitstun: 34, stamina: 26,
    motion: [[0, 0], [36, 0.15], [50, 1.00], [85, 1.00]],
    hitbox: { offset: 1.30, radius: 1.00, yMin: 0.20, yMax: 2.15 },
  },
  p_heavy3: {
    // 终结：突进冲撞。位移最大（4.6m），收招最长 —— 打空会被狠狠惩罚
    label: '重击 3（突进冲撞）',
    swing: 'thrust',
    startup: 30, active: 12, recovery: 26, cancelFrom: 12,
    damage: 380, poise: 80, hitstun: 40, stamina: 34,
    motion: [[0, 0], [24, 0.0], [34, 3.20], [42, 4.60], [68, 4.60]],
    hitbox: { offset: 1.20, radius: 0.95, yMin: 0.20, yMax: 2.10 },
  },

  // ── Boss ──────────────────────────────────────────────
  //   b_sweep   Great_Sword_High_Spin_Attack  strike@63/113 → 截到 93，90 帧
  //   b_slam    Sword_And_Shield_Slash        strike@42/212 → 截到 76，90 帧
  //   b_charge  Standing_Dodge_Forward        strike@18/60  → 截到 46，60 帧
  b_sweep: {
    label: '横扫（中）',
    swing: 'horizontal',
    startup: 54, active: 16, recovery: 20, cancelFrom: 14,
    damage: 320, poise: 0, hitstun: 22, stamina: 0,
    motion: [[0, 0], [54, 0.15], [62, 1.10], [74, 1.60], [90, 1.60]],
    // offset/radius 会乘 boss.scale：0.85×2.6=2.2m 前方、0.45×2.6=1.17m 半径
    // 远端 4.16m，要盖过 stopDist（3.69m），否则 Boss 站在攻击距离外永远打空
    hitbox: { offset: 1.05, radius: 0.55, yMin: 0.0, yMax: 1.05 },
    minRange: 0, maxRange: 5.5, weight: 1.0, cooldown: 1.2,
  },
  b_slam: {
    label: '下砸（慢）', swing: 'vertical',
    startup: 38, active: 18, recovery: 34, cancelFrom: 16,
    damage: 420, poise: 0, hitstun: 30, stamina: 0,
    motion: [[0, 0], [38, 0.10], [50, 0.60], [90, 0.60]],
    // 下砸范围本来就大：0.95×2.6=2.47m 前方、0.65×2.6=1.69m 半径
    hitbox: { offset: 1.05, radius: 0.70, yMin: 0.0, yMax: 0.52 },
    minRange: 0, maxRange: 4.5, weight: 0.85, cooldown: 2.0,
  },
  b_charge: {
    label: '突进（快）', swing: 'thrust',
    startup: 13, active: 10, recovery: 37, cancelFrom: 14,
    damage: 280, poise: 0, hitstun: 26, stamina: 0,
    motion: [[0, 0], [13, 0.0], [21, 3.40], [32, 5.60], [60, 5.60]],
    // 突进靠位移命中，判定框本身收窄：0.55×2.6=1.43m 前方、0.40×2.6=1.04m 半径
    hitbox: { offset: 0.55, radius: 0.40, yMin: 0.0, yMax: 1.30 },
    minRange: 6.0, maxRange: 16.0, weight: 1.1, cooldown: 2.6,
  },
  b_roar: {
    label: '怒吼（免费招）', swing: 'none',
    startup: 110, active: 0, recovery: 40, cancelFrom: 0,
    damage: 0, poise: 0, hitstun: 0, stamina: 0,
    motion: [[0, 0]],
    hitbox: { offset: 0, radius: 0, yMin: 0, yMax: 0 },
    minRange: 0, maxRange: 30, weight: 0.28, cooldown: 14,
  },
};

/** 派生：总帧数 */
export function totalFrames(m) {
  return m.startup + m.active + m.recovery;
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
