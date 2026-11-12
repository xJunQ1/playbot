// ─────────────────────────────────────────────────────────────
//  程序化姿态：灰盒的「动画」
//  没有外部模型，也不需要——姿态由帧表参数驱动，
//  改 startup/active/recovery，动作节奏自动跟着变。
//  关节单位：弧度。约定 rotation.x = 前后摆（正=向前），y = 扭转，z = 左右展。
// ─────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 2.2);
const easeIn = (t) => Math.pow(clamp01(t), 1.9);

export const POSE_JOINTS = ['spine', 'head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR'];

function basePose() {
  return {
    __body: [0, 0, 0],   // body 节点旋转（翻滚 / 倒地用）
    __bodyY: 0,          // body 节点抬高（翻滚时把旋转中心挪到腰）
    __hipsX: 0,          // 骨盆左右偏移（走路的重心转移）
    __hipsTilt: 0,       // 骨盆左右倾斜
    spine: [0.03, 0, 0],
    head: [0, 0, 0],
    armL: [0.12, 0, 0.20],
    armR: [0.12, 0, -0.20],
    foreL: [0.22, 0, 0],
    foreR: [0.22, 0, 0],
    legL: [0, 0, 0.05],
    legR: [0, 0, -0.05],
    shinL: [0.08, 0, 0],
    shinR: [0.08, 0, 0],
  };
}

export function mixPose(a, b, t) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (Array.isArray(a[k])) {
      const bv = b[k] ?? a[k];
      out[k] = [lerp(a[k][0], bv[0], t), lerp(a[k][1], bv[1], t), lerp(a[k][2], bv[2], t)];
    } else {
      out[k] = lerp(a[k], b[k] ?? a[k], t);
    }
  }
  for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
  return out;
}

// ── 循环动作 ──────────────────────────────────────────────────

/** 待机：呼吸 + 手臂微摆。t 是 0..1 的循环相位 */
export function poseIdle(t) {
  const p = basePose();
  const b = Math.sin(t * TAU);
  p.spine = [0.03 + b * 0.028, b * 0.03, 0];
  p.head = [-b * 0.035, b * 0.02, 0];
  p.armL = [0.12 + b * 0.06, 0, 0.20 + b * 0.03];
  p.armR = [0.12 + b * 0.06, 0, -0.20 - b * 0.03];
  p.foreL = [0.22 + b * 0.04, 0, 0];
  p.foreR = [0.22 + b * 0.04, 0, 0];
  p.__bodyY = b * 0.012;
  return p;
}

/** 跑动：双腿交替 + 反向摆臂，重心上下起伏 */
export function poseMove(t) {
  const p = basePose();
  const s = Math.sin(t * TAU);
  const c = Math.cos(t * TAU);
  p.legL = [s * 0.62, 0, 0.05];
  p.legR = [-s * 0.62, 0, -0.05];
  p.shinL = [Math.max(0, -s) * 0.85 + 0.08, 0, 0];
  p.shinR = [Math.max(0, s) * 0.85 + 0.08, 0, 0];
  p.armL = [-s * 0.42 + 0.15, 0, 0.10];
  p.armR = [s * 0.42 + 0.15, 0, -0.10];
  p.foreL = [0.55 + Math.max(0, -s) * 0.35, 0, 0];
  p.foreR = [0.55 + Math.max(0, s) * 0.35, 0, 0];
  p.spine = [0.10, s * 0.10, 0];
  p.head = [-0.05, -s * 0.06, 0];
  p.__bodyY = Math.abs(c) * 0.035;
  // 骨盆：左右偏 + 反向倾斜。没有这个，腿动得再准也像在滑行
  p.__hipsX = s * 0.032;
  p.__hipsTilt = -s * 0.055;
  return p;
}

// ── 一次性动作 ────────────────────────────────────────────────

/** 翻滚：整个人绕腰前进方向滚一圈，同时蜷缩 */
export function poseRoll(frame, total) {
  const p = basePose();
  const rollFrames = Math.max(1, Math.floor(total * 0.62));
  const t = clamp01(frame / rollFrames);
  const ease = easeOut(t);

  // __body 不经过 applyPose 的 x 取反，符号要按 three.js 真实方向写：
  // Rx(+) 把头顶 (+Y) 转向 +Z，也就是向前滚
  p.__body = [ease * TAU, 0, 0];
  p.__bodyY = 0.92 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) + (1 - t) * 0.0;

  p.spine = [0.55, 0, 0];
  p.head = [0.32, 0, 0];
  p.armL = [1.55, 0, 0.28];
  p.armR = [1.55, 0, -0.28];
  p.foreL = [1.25, 0, 0];
  p.foreR = [1.25, 0, 0];
  p.legL = [1.35, 0, 0.09];
  p.legR = [1.35, 0, -0.09];
  p.shinL = [1.55, 0, 0];
  p.shinR = [1.55, 0, 0];
  return p;
}

/** 受击：后仰 + 侧偏，随帧回正 */
export function poseHit(frame, stun) {
  const p = basePose();
  const t = clamp01(frame / Math.max(1, Math.min(stun, 20)));
  const k = 1 - easeOut(t);
  p.spine = [0.03 - 0.42 * k, 0.10 * k, 0.16 * k];
  p.head = [-0.34 * k, 0.12 * k, 0.10 * k];
  p.armL = [0.12 + 0.35 * k, 0, 0.10 + 0.30 * k];
  p.armR = [0.12 + 0.35 * k, 0, -0.10 - 0.30 * k];
  p.foreL = [0.22 + 0.45 * k, 0, 0];
  p.foreR = [0.22 + 0.45 * k, 0, 0];
  p.legL = [0.20 * k, 0, 0.05];
  p.legR = [-0.14 * k, 0, -0.05];
  p.__bodyY = -0.05 * k;
  return p;
}

/** 格挡：侧身、双臂抬起挡在身前；弹反窗内压得更高 */
export function poseBlock(frame) {
  const p = basePose();
  const parry = frame <= 8;
  const k = parry ? 1 : 0.88;
  p.spine = [0.14, -0.28 * k, 0];
  p.head = [0.05, 0.18 * k, 0];
  p.armR = [1.52 * k, 0.34, -0.50];
  p.foreR = [1.18 * k, 0, -0.12];
  p.armL = [0.95 * k, -0.24, 0.42];
  p.foreL = [1.05 * k, 0, 0.10];
  p.legL = [0.28, 0, 0.12];
  p.legR = [-0.16, 0, -0.12];
  p.shinL = [0.30, 0, 0];
  p.shinR = [0.16, 0, 0];
  p.__bodyY = -0.035;
  return p;
}

/** 破防：完全失衡，向后倒 */
export function poseGuardbreak(frame) {
  const p = poseHit(frame, 24);
  const t = clamp01(frame / 18);
  p.spine = [-0.55 + t * 0.2, 0.25, 0.2];
  p.head = [-0.5, 0.2, 0];
  p.armL = [0.7, 0, 0.75];
  p.armR = [0.7, 0, -0.75];
  p.__bodyY = -0.10;
  return p;
}

/** 死亡：向后倒地，武器脱手 */
export function poseDead(frame) {
  const p = basePose();
  const t = easeOut(clamp01(frame / 34));
  p.__body = [-t * Math.PI * 0.52, 0, 0];
  p.__bodyY = lerp(0.0, 0.30, t);
  p.spine = [0.05 - t * 0.30, 0, 0];
  p.head = [-t * 0.45, 0, 0];
  p.armL = [0.2 + t * 0.9, 0, 0.10 + t * 0.55];
  p.armR = [0.2 + t * 0.9, 0, -0.10 - t * 0.55];
  p.foreL = [0.22 + t * 0.4, 0, 0];
  p.foreR = [0.22 + t * 0.4, 0, 0];
  p.legL = [t * 0.35, 0, 0.05 + t * 0.12];
  p.legR = [t * 0.2, 0, -0.05 - t * 0.12];
  p.shinL = [0.08 + t * 0.5, 0, 0];
  p.shinR = [0.08 + t * 0.3, 0, 0];
  return p;
}

// ── 攻击：由帧表参数直接生成姿态 ──────────────────────────────

/** 蓄力姿态（按挥击类型分） */
function windPose(swing) {
  const p = basePose();
  if (swing === 'vertical') {
    p.spine = [-0.18, 0, 0];
    p.head = [-0.12, 0, 0];
    p.armR = [2.85, 0, -0.18];
    p.foreR = [0.30, 0, 0];
    p.armL = [2.55, 0, 0.20];
    p.foreL = [0.55, 0, 0];
    p.legL = [0.10, 0, 0.05];
    p.legR = [-0.10, 0, -0.05];
    p.__bodyY = 0.03;
  } else if (swing === 'thrust') {
    p.spine = [-0.14, -0.30, 0];
    p.head = [0.05, 0.20, 0];
    p.armR = [0.35, 0, -0.55];
    p.foreR = [1.75, 0, 0];
    p.armL = [0.55, 0, 0.45];
    p.foreL = [0.90, 0, 0];
    p.legL = [-0.28, 0, 0.05];
    p.legR = [0.34, 0, -0.05];
    p.shinL = [0.45, 0, 0];
    p.shinR = [0.20, 0, 0];
    p.__bodyY = -0.04;
  } else {
    // horizontal
    p.spine = [0.06, 0.55, 0];
    p.head = [0.02, -0.28, 0];
    p.armR = [1.15, -0.95, -0.62];
    p.foreR = [0.72, 0, 0];
    p.armL = [0.55, 0.55, 0.30];
    p.foreL = [0.55, 0, 0];
    p.legL = [-0.14, 0, 0.05];
    p.legR = [0.16, 0, -0.05];
  }
  return p;
}

/** 挥出姿态 */
function strikePose(swing) {
  const p = basePose();
  if (swing === 'vertical') {
    p.spine = [0.58, 0, 0];
    p.head = [0.25, 0, 0];
    p.armR = [0.52, 0, -0.10];
    p.foreR = [0.10, 0, 0];
    p.armL = [0.85, 0, 0.18];
    p.foreL = [0.35, 0, 0];
    p.legL = [0.34, 0, 0.07];
    p.legR = [-0.26, 0, -0.07];
    p.shinL = [0.42, 0, 0];
    p.shinR = [0.14, 0, 0];
    p.__bodyY = -0.07;
  } else if (swing === 'thrust') {
    p.spine = [0.34, 0.16, 0];
    p.head = [0.10, -0.10, 0];
    p.armR = [1.62, 0, -0.12];
    p.foreR = [0.06, 0, 0];
    p.armL = [0.30, 0, 0.42];
    p.foreL = [0.45, 0, 0];
    p.legL = [0.52, 0, 0.05];
    p.legR = [-0.34, 0, -0.05];
    p.shinL = [0.20, 0, 0];
    p.shinR = [0.55, 0, 0];
    p.__bodyY = -0.02;
  } else {
    p.spine = [0.12, -0.62, 0];
    p.head = [0.06, 0.30, 0];
    p.armR = [1.45, 0.95, -0.30];
    p.foreR = [0.12, 0, 0];
    p.armL = [0.35, -0.55, 0.55];
    p.foreL = [0.40, 0, 0];
    p.legL = [0.22, 0, 0.05];
    p.legR = [-0.20, 0, -0.05];
    p.__bodyY = -0.03;
  }
  return p;
}

/**
 * 攻击姿态：直接吃帧表。
 * startup 段从待机过渡到蓄力；active 段瞬间挥出；recovery 段回到待机。
 * 改帧数 → 动作自动变快变慢，不用重做任何关键帧。
 */
export function poseAttack(move, frame) {
  const idle = basePose();
  const swing = move.swing ?? 'horizontal';

  // 没有挥击的动作（怒吼之类）：只做躯干起伏，不甩武器
  if (swing === 'none') {
    const t = clamp01(frame / Math.max(1, move.startup));
    const shout = mixPose(idle, {
      ...basePose(),
      spine: [-0.30, 0, 0],
      head: [-0.34, 0, 0],
      armL: [0.95, 0, 0.85],
      armR: [0.95, 0, -0.85],
      foreL: [0.85, 0, 0],
      foreR: [0.85, 0, 0],
      legL: [0.18, 0, 0.16],
      legR: [-0.12, 0, -0.16],
      __bodyY: -0.02,
    }, easeOut(t));
    return shout;
  }

  const wind = windPose(swing);
  const strike = strikePose(swing);

  const { startup, active, recovery } = move;

  if (frame < startup) {
    const t = easeOut(frame / Math.max(1, startup));
    return mixPose(idle, wind, t);
  }
  if (frame < startup + active) {
    const t = easeIn((frame - startup) / Math.max(1, active));
    return mixPose(wind, strike, t);
  }
  const t = clamp01((frame - startup - active) / Math.max(1, recovery));
  return mixPose(strike, idle, easeOut(t));
}

/** 统一入口：给定 actor，返回这一帧该摆的姿势 */
export function poseFor(actor, clock) {
  switch (actor.state) {
    case 'idle':
    case 'move':
      return actor.state === 'move' ? poseMove(clock) : poseIdle(clock);
    case 'roll':
      return poseRoll(actor.frame, actor.rollTotal ?? 33);
    case 'block':
      return poseBlock(actor.frame);
    case 'hitstun':
      return poseHit(actor.frame, actor.stunTimer || 14);
    case 'guardbreak':
      return poseGuardbreak(actor.frame);
    case 'dead':
      return poseDead(actor.frame);
    case 'attack':
    case 'light1':
    case 'light2':
    case 'heavy':
      return actor.move ? poseAttack(actor.move, actor.frame) : poseIdle(clock);
    default:
      return poseIdle(clock);
  }
}
