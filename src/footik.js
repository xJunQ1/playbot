import * as THREE from 'three';
import { RIG } from './graybox.js';

// ─────────────────────────────────────────────────────────────
//  脚部 IK：解决「滑步」
//
//  没有 IK 时，腿只是跟着正弦函数摆——身体移动速度和腿的摆动频率
//  毫无关系，脚在地上蹭。这里做两件事：
//    1. 步态控制器：支撑脚锁死在世界坐标，摆动脚抬起→落下
//    2. 两骨 IK：给定髋和脚的世界位置，反解大腿/小腿角度
//
//  纯视觉层，不影响判定。翻滚/倒地/受击时自动关闭。
// ─────────────────────────────────────────────────────────────

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

class Foot {
  constructor(side) {
    this.side = side;                 // +1 右 / -1 左
    this.current = new THREE.Vector3();
    this.swingFrom = new THREE.Vector3();
    this.swingTo = new THREE.Vector3();
    this.progress = side > 0 ? 0 : 0.5;  // 距离累积，用来错开两只脚
    this.swinging = false;
    this.swingT = 0;
  }
}

export class FootIK {
  constructor(opts = {}) {
    this.enabled = true;
    this.feet = [new Foot(1), new Foot(-1)];

    // 摆动参数
    this.swingTime = opts.swingTime ?? 0.14;   // 抬脚到落地的时长（秒）
    this.liftHeight = opts.liftHeight ?? 0.15; // 抬脚高度
    this.footWidth = opts.footWidth ?? 0.16;   // 两脚间距的一半
    this.minStep = opts.minStep ?? 0.30;
    this.maxStep = opts.maxStep ?? 1.30;

    this._prevPos = new THREE.Vector3();
    this._speed = 0;
    this._init = false;
    this._forward = new THREE.Vector3(0, 0, 1);
  }

  setEnabled(v) {
    if (!v) this._init = false;
    this.enabled = v;
  }

  /** 把两只脚摆到身体两侧（重开、状态切换时用） */
  reset(actor) {
    const fwd = _v1.set(Math.sin(actor.yaw), 0, Math.cos(actor.yaw));
    const right = _v2.set(-fwd.z, 0, fwd.x);
    for (const foot of this.feet) {
      foot.current.copy(actor.pos)
        .addScaledVector(right, foot.side * this.footWidth);
      foot.current.y = 0;
      foot.swinging = false;
      foot.swingT = 0;
      foot.progress = foot.side > 0 ? 0 : 0.5;
    }
    this._prevPos.copy(actor.pos);
    this._speed = 0;
    this._init = true;
  }

  /**
   * 推进步态并写回骨骼。
   * @param actor 需要 pos / yaw / mesh
   * @param dt    真实秒
   */
  update(actor, dt) {
    if (!this.enabled || !actor.mesh?.hips) return;
    if (dt <= 0) return;

    if (!this._init) this.reset(actor);

    const hips = actor.mesh.hips;
    const fwd = this._forward.set(Math.sin(actor.yaw), 0, Math.cos(actor.yaw));
    const right = _v2.set(-fwd.z, 0, fwd.x);

    // 这一帧身体走了多远。渲染帧率高于逻辑帧时会出现 moved=0 的空帧，
    // 直接拿它算 speed 会被误判成「停住了」，脚被拉回身侧 —— 必须平滑。
    const moved = actor.pos.distanceTo(this._prevPos);
    this._prevPos.copy(actor.pos);
    const rawSpeed = moved / Math.max(1e-4, dt);
    this._speed += (rawSpeed - this._speed) * Math.min(1, dt * 10);
    const speed = this._speed;

    // 步幅随速度变化：走得快步子大，但有个上下限
    const stepLen = THREE.MathUtils.clamp(speed * 0.42, this.minStep, this.maxStep);
    const restSpeed = 0.25;

    for (const foot of this.feet) {
      if (foot.swinging) {
        foot.swingT += dt / this.swingTime;
        const t = Math.min(1, foot.swingT);
        foot.current.lerpVectors(foot.swingFrom, foot.swingTo, t);
        foot.current.y = Math.sin(t * Math.PI) * this.liftHeight;
        if (t >= 1) {
          foot.swinging = false;
          foot.swingT = 0;
          foot.progress = 0;
          foot.current.y = 0;
        }
      } else {
        foot.progress += moved;

        if (speed < restSpeed) {
          // 站住：脚慢慢收回身体两侧（避免停下来时两脚还叉在前后）
          const rest = _v3.copy(actor.pos).addScaledVector(right, foot.side * this.footWidth);
          rest.y = 0;
          const k = Math.min(1, dt * 14);
          foot.current.lerp(rest, Math.min(1, k));
        } else if (foot.progress > stepLen) {
          // 落后太多，迈一步
          foot.swingFrom.copy(foot.current);
          foot.swingTo.copy(actor.pos)
            .addScaledVector(fwd, stepLen * 0.55)
            .addScaledVector(right, foot.side * this.footWidth);
          foot.swingTo.y = 0;
          foot.swinging = true;
          foot.swingT = 0;
        }
      }
    }

    // 骨骼世界矩阵必须是新的，否则 worldToLocal 拿到上一帧的结果
    actor.mesh.group.updateMatrixWorld(true);

    for (const foot of this.feet) {
      this._solveLeg(actor, foot);
    }
  }

  /** 两骨 IK：髋 → 膝 → 踝，在 YZ 平面内反解 */
  _solveLeg(actor, foot) {
    const hips = actor.mesh.hips;
    const leg = foot.side > 0 ? actor.mesh.legR : actor.mesh.legL;
    const shin = foot.side > 0 ? actor.mesh.shinR : actor.mesh.shinL;
    if (!leg || !shin) return;

    // 目标脚位置 → hips 局部空间
    const local = hips.worldToLocal(_v3.copy(foot.current));
    // 扣掉腿根在髋部的左右偏移
    local.x -= RIG.hipX * foot.side;

    const L1 = RIG.thigh;
    const L2 = RIG.shin;

    // 腿只在前后方向上摆，用 YZ 平面求解
    const down = -local.y;   // 髋到脚的垂直距离（正）
    const front = local.z;   // 脚在身体前方为正

    let d = Math.hypot(down, front);
    d = THREE.MathUtils.clamp(d, 0.05, (L1 + L2) * 0.995);

    // 髋→踝方向相对 -Y 轴的偏角
    const alpha = Math.atan2(front, Math.max(0.0001, down));

    // 余弦定理：大腿与「髋→踝」连线的夹角
    const cosBeta = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const beta = Math.acos(THREE.MathUtils.clamp(cosBeta, -1, 1));

    // 膝关节内角
    const cosKnee = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
    const kneeInner = Math.acos(THREE.MathUtils.clamp(cosKnee, -1, 1));
    const kneeBend = Math.PI - kneeInner;

    // 关键符号：three.js 里 Rx(+θ) 把向下的向量转向 -Z（身后）。
    // 所以「向前摆」= 负角度；膝盖向前弯 = 小腿正角度。
    //   leg  角 = -(alpha + beta)   大腿比髋→踝连线更靠前
    //   shin 角 = +kneeBend         小腿相对大腿向后折，膝盖才朝前
    const legTarget = -(alpha + beta);
    const shinTarget = kneeBend;

    // 平滑逼近：状态切换（翻滚→站立）时腿不会瞬移，支撑期也只差几毫米
    const k = 0.75;
    leg.rotation.x += (legTarget - leg.rotation.x) * k;
    shin.rotation.x += (shinTarget - shin.rotation.x) * k;
  }
}
