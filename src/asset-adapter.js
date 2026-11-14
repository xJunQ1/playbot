import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { totalFrames } from './frame-data.js';

// ═══════════════════════════════════════════════════════════════
//  美术接入适配层
//  灰盒 → 真模型，只改这里 + 一个 URL。
//  设计原则：模型是「表现层」，帧数据永远是权威。
//  动画剪辑通过 timeScale 被拉伸到帧表长度，而不是反过来改帧表。
// ═══════════════════════════════════════════════════════════════

let _loader = null;

export function initLoader(renderer) {
  if (_loader) return _loader;
  const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/');
  const ktx2 = new KTX2Loader()
    .setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')
    .detectSupport(renderer);
  _loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);
  return _loader;
}

/**
 * 打击点分析结果（tools/analyze.html 实测，Y_Bot 同源动画）。
 * strike   = 手最快的帧 ≈ 判定该生效的地方
 * activeAt = 判定窗起点，activeLen = 判定窗长度
 * cut      = 截到第几帧（后半段是慢慢回位，游戏里不要）
 */
export const STRIKE = {
  Stable_Sword_Inward_Slash:  { strike: 42, activeAt: 32, activeLen: 15, frames: 212, cut: 64 },
  Stable_Sword_Outward_Slash: { strike: 35, activeAt: 34, activeLen: 6,  frames: 90,  cut: 55 },
  Great_Sword_Slash:          { strike: 43, activeAt: 39, activeLen: 14, frames: 211, cut: 77 },
  Great_Sword_Attack:         { strike: 63, activeAt: 56, activeLen: 17, frames: 113, cut: 93 },
  Standing_Dodge_Forward:     { strike: 18, activeAt: 14, activeLen: 27, frames: 60,  cut: 46 },
  Light_3:                    { strike: 63, activeAt: 56, activeLen: 17, frames: 113, cut: 93 },
  Heavy_2:                    { strike: 45, activeAt: 38, activeLen: 11, frames: 50,  cut: 50 },
  Heavy_3:                    { strike: 42, activeAt: 32, activeLen: 15, frames: 212, cut: 75 },
};

/** 动作名 → 状态名映射。键是逻辑动作，值是 SOULS_PACK 里的剪辑名（大小写不敏感） */
export const DEFAULT_CLIP_MAP = {
  idle: 'Idle',
  move: 'Running',
  moveback: 'WalkBackFull',   // 运行时合成：Walking 的上半身 + WalkBack 的腿
  walk: 'Walking',            // Boss 踱步 / 绕圈时用
  roll: 'Dive_Roll',
  block: 'Blocking',
  blockmove: 'BlockMove',
  hitstun: 'Getting_Hit_Backwards',
  guardbreak: 'Getting_Hit_Backwards',
  dead: 'Death',
  // 三段按「动作类型」拉开，保证一眼能分出打到第几下：
  //   横劈 → 跳劈 → 旋身斩
  p_light1: 'Stable_Sword_Outward_Slash',  // 横劈
  p_light2: 'Light_3',                     // 旋身斩
  p_light3: 'Stable_Sword_Inward_Slash',   // 剑盾斩收尾
  p_heavy: 'Great_Sword_Slash',
  p_heavy2: 'Heavy_3',          // 剑盾横扫
  p_heavy3: 'Standing_Dodge_Forward',   // 突进冲撞收尾
  b_sweep: 'Great_Sword_Attack',
  b_slam: 'Great_Sword_Slash',
  b_charge: 'Standing_Dodge_Forward',
  b_roar: 'Stable_Sword_Inward_Slash',   // 必须是 SOULS_PACK 的键，不是文件名
};

export class ModelBinder {
  /**
   * @param gltf        GLTFLoader 结果
   * @param opts.scale      模型缩放（米制，需要和灰盒胶囊高度对齐）
   * @param opts.yawOffset  朝向修正（Mixamo 系通常 Math.PI）
   * @param opts.clipMap    动作名映射
   */
  constructor(gltf, opts = {}) {
    this.root = gltf.scene;
    this.root.rotation.y = opts.yawOffset ?? Math.PI;
    this.root.scale.setScalar(opts.scale ?? 1);
    this.clipMap = { ...DEFAULT_CLIP_MAP, ...(opts.clipMap ?? {}) };

    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = new Map(gltf.animations.map((c) => [c.name, c]));
    this.actions = new Map();
    this.current = null;
    this.currentName = '';

    this.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
  }

  /** 把模型挂到 Actor 的容器上（替换灰盒内容，但保留 group 作为 transform 锚点） */
  attachTo(actorContainer, offsetY = 0) {
    this.root.position.y = offsetY;
    for (const child of [...actorContainer.children]) actorContainer.remove(child);
    // 灰盒可能带缩放（Boss 2.6x）；换成真模型后容器归一，缩放交给模型自身
    actorContainer.scale.setScalar(1);
    actorContainer.add(this.root);
  }

  /**
   * 按包围盒自动缩放到目标身高，并把脚底对到 y=0。
   * 手填 scale 全凭运气 —— GLB 的来源千奇百怪（有的 1 单位 = 1cm，有的 = 3m）。
   * @param targetHeight 目标身高（米）
   */
  fitToHeight(targetHeight) {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const h = box.max.y - box.min.y;
    if (h < 1e-4) return;

    this.root.scale.multiplyScalar(targetHeight / h);

    this.root.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(this.root);
    this.root.position.y -= box2.min.y;   // 脚底贴地
  }

  _getAction(name) {
    if (this.actions.has(name)) return this.actions.get(name);

    // 大小写不敏感查找：GLB 里常是 "Idle" / "Idle_01" / "Armature|Idle"
    let key = name;
    if (!this.clips.has(key)) {
      const want = String(name).toLowerCase();
      for (const k of this.clips.keys()) {
        const lk = k.toLowerCase();
        if (lk === want || lk.endsWith('|' + want) || lk.startsWith(want)) { key = k; break; }
      }
    }

    const clip = this.clips.get(key);
    if (!clip) return null;
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    this.actions.set(name, action);
    return action;
  }

  /**
   * 每渲染帧调用。
   * 关键逻辑：把剪辑时长拉伸到帧表总时长，逻辑帧决定「播到哪」。
   */
  update(actor, dt) {
    const key = this._clipKey(actor);
    const targetName = this.clipMap[key];

    if (targetName && targetName !== this.currentName) {
      const next = this._getAction(targetName);
      if (next) {
        const prev = this.current;
        next.reset();
        next.enabled = true;
        next.setEffectiveWeight(1);
        // 攻击 / 翻滚：单次播放，不循环
        if (actor.state === 'roll' || actor.state.startsWith('light') ||
            actor.state === 'heavy' || actor.state === 'attack') {
          next.setLoop(THREE.LoopOnce, 1);
          next.clampWhenFinished = true;
        } else {
          next.setLoop(THREE.LoopRepeat, Infinity);
        }

        // ★ 核心：把动画时长对准帧表
        if (actor.move) {
          const frames = totalFrames(actor.move);
          const ratio = (next.getClip().duration * 60) / Math.max(1, frames);
          next.setEffectiveTimeScale(ratio);
        } else if (key === 'blockmove' || key === 'moveback') {
          // 只给「格挡慢走」做速度缩放：慢速时脚滑特别刺眼，步频必须跟上。
          // 跑动不做缩放 —— 跑步动画按原速播观感最好，为了对齐步频去调快
          // 反而把节奏弄乱，而高速下那点滑步根本看不出来。
          // ref 越大 → timeScale 越小 → 摆动越慢。
          // moveback 调到 1.65：速度 2.31 / 1.65 = 1.40，比原来的 1.78 慢一档。
          const ref = key === 'moveback' ? 1.65 : 1.40;
          const sp = actor.speed > 0.05 ? actor.speed : ref;
          next.setEffectiveTimeScale(THREE.MathUtils.clamp(sp / ref, 0.45, 2.2));
        } else {
          next.setEffectiveTimeScale(1);
        }

        if (prev && prev !== next) {
          next.crossFadeFrom(prev, 0.08, false);   // 视觉淡入，逻辑早已切换
        }
        next.play();
        this.current = next;
        this.currentName = targetName;
      }
    }

    this.mixer.update(dt);
  }

  _clipKey(actor) {
    // 有招式时用 moveId 作为键（p_light1 / p_heavy / b_sweep ...），
    // 否则用状态名（idle / move / roll / block / dead ...）。
    // 不能用 `state === 'light1' || 'light2' || 'heavy'` 那种写法 —— || 链恒为真，
    // 会把 'light1' 当成键去查 p_light1 的动画，永远查不到。
    if (actor.moveId) return actor.moveId;
    // 格挡时走动要播行走动画，否则原地循环 + 代码位移 = 滑行
    if (actor.state === 'block' && actor.moving) return 'blockmove';
    // 站立但脚下在动（Boss 踱步/绕圈）：播走路，不要原地站着平移
    if (actor.state === 'idle' && actor.moving) return 'walk';
    // 只要带后退分量就播倒退走（含 S+A / S+D 斜向后退）。
    // 朝向在 applyMoveInput 里已经反过来了，所以斜向后退也是正确的倒退姿态。
    if (actor.state === 'move' && actor.moveAxis < 0) return 'moveback';
    return actor.state;
  }
}

/**
 * 类魂动作包：来自 MisterYI/deevid-mixamo-assets（GitHub，886 个 Mixamo 动画 GLB）。
 * 这些是**纯动画文件**（skin 为空，只有 bone track），骨骼名是 mixamorig:xxx，
 * 可以直接套到任何同源 Mixamo 角色上，不需要 retarget。
 * 时长是原片长度，binder 会用 timeScale 拉伸到帧表长度。
 */
/**
 * 类魂动作包 —— 全部来自用户的 Mixamo 账号，和 Y_Bot 同一条导出管线。
 * 同源意味着 rest pose 完全一致，retargetClip 会退化成恒等变换，动作零畸变。
 */
export const SOULS_PACK = {
  Idle: 'assets/Idle.glb',
  Walking: 'assets/Walking.glb',
  Running: 'assets/Running.glb',
  WalkBack: 'assets/Walking_Backwards_1.glb',   // 1.20s/72f，步频比原版快
  Dive_Roll: 'assets/Stand_To_Roll.glb',
  Blocking: 'assets/Great_Sword_Blocking.glb',
  BlockWalk: 'assets/sword_and_shield_walk.glb',   // 只取下半身，和 Blocking 合成 BlockMove
  Getting_Hit_Backwards: 'assets/Reaction.glb',
  Death: 'assets/Two_Handed_Sword_Death.glb',
  Stable_Sword_Inward_Slash: 'assets/Sword_And_Shield_Slash.glb',
  Stable_Sword_Outward_Slash: 'assets/Sword_Slash.glb',
  Great_Sword_Slash: 'assets/Great_Sword_Slash.glb',
  Great_Sword_Attack: 'assets/Great_Sword_High_Spin_Attack.glb',
  Standing_Dodge_Forward: 'assets/Standing_Dodge_Forward.glb',
  Light_3: 'assets/Great_Sword_High_Spin_Attack.glb',   // 轻击终结：旋身斩
  Heavy_2: 'assets/sword_and_shield_jump.glb',          // 重击二段：跳劈
  Heavy_3: 'assets/Sword_And_Shield_Slash.glb',         // 重击终结：同一文件、更长的截取
};

/**
 * rest pose 补偿（retarget）。
 *
 * glTF 动画存的是骨骼局部旋转的**绝对值**。Mixamo 动画假设骨骼带基础旋转
 * （比如大腿骨绕 Y 转 180°），而 three.js 的模型常把 T-pose 烘焙进顶点、
 * 骨骼 rest 归零。直接套绝对值 = 把烘焙过的模型再转一遍 → 整个人散架。
 *
 * 公式：  target(t) = targetRest · (sourceRest⁻¹ · anim(t))
 *
 * 只补偿 rotation。position 一律丢弃 —— 两套骨架的长度不同，做差值补偿会把
 * 骨骼拉长/压短，表现就是「蹲成一团」。位移交回 frame-data.js 的 motion 曲线。
 */
function retargetClip(targetRoot, sourceRoot, clip) {
  const tMap = new Map();
  const sMap = new Map();
  targetRoot.traverse((o) => { if (o.name) tMap.set(o.name, o); });
  sourceRoot.traverse((o) => { if (o.name) sMap.set(o.name, o); });

  const out = [];
  const tmp = new THREE.Quaternion();

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);

    const t = tMap.get(bone);
    const s = sMap.get(bone);
    if (!t || !s) continue;

    if (prop === 'position') {
      // 只保留 Hips 的位移。翻滚时身体下潜靠的就是它 —— 全删掉只剩骨骼旋转，
      // 头顶永远降不下去，看起来像「按了闪避但人没滚」。
      // X/Z 锁死在 rest，避免和 frame-data.js 的 motion 曲线叠成双倍位移。
      if (!/Hips$/i.test(bone)) continue;
      const ps = s.position;
      const pt = t.position;
      const vals = new Float32Array(track.values.length);
      for (let k = 0; k < track.values.length; k += 3) {
        vals[k]     = pt.x;
        vals[k + 1] = pt.y + (track.values[k + 1] - ps.y);
        vals[k + 2] = pt.z;
      }
      out.push(new THREE.VectorKeyframeTrack(`${bone}.position`, track.times, vals));
      continue;
    }

    if (prop !== 'quaternion') continue;

    const qsInv = s.quaternion.clone().invert();
    const qt = t.quaternion.clone();
    const vals = new Float32Array(track.values.length);
    for (let k = 0; k < track.values.length; k += 4) {
      tmp.fromArray(track.values, k);
      tmp.premultiply(qsInv);   // sourceRest⁻¹ · anim
      tmp.premultiply(qt);      // targetRest · (...)
      tmp.normalize();
      tmp.toArray(vals, k);
    }
    out.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, track.times, vals));
  }

  return new THREE.AnimationClip(clip.name, clip.duration, out);
}

/**
 * 世界空间 retarget（严谨版）。
 *
 * 逐帧把 source 骨骼的**世界朝向**算出来，反解成 target 的局部旋转：
 *   targetLocal(t) = targetParentWorld(t)⁻¹ · sourceWorld(t)
 * 父链上任何差异都被自动吸收，不像局部公式那样按骨链累积。
 *
 * 代价：要逐帧采样（60fps × 每段动画），加载慢几百毫秒。
 * 骨架对不上时返回 null，调用方退回局部公式。
 */
function retargetClipWorld(targetRoot, sourceRoot, clip, name) {
  targetRoot.updateMatrixWorld(true);
  sourceRoot.updateMatrixWorld(true);

  const tMap = new Map();
  const sMap = new Map();
  targetRoot.traverse((o) => { if (o.name) tMap.set(o.name, o); });
  sourceRoot.traverse((o) => { if (o.name) sMap.set(o.name, o); });

  // 前序遍历：父骨骼一定排在子骨骼前面，算一帧时能直接用父的矩阵
  const ordered = [];
  targetRoot.traverse((o) => { if (o.name && sMap.has(o.name)) ordered.push(o.name); });
  if (ordered.length < 10) return null;

  const fps = 60;
  const frames = Math.ceil(clip.duration * fps);
  const times = new Float32Array(frames + 1);
  const bufs = new Map();
  for (const n of ordered) bufs.set(n, new Float32Array((frames + 1) * 4));

  const mixer = new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(clip).play();

  const qS = new THREE.Quaternion();
  const qP = new THREE.Quaternion();
  const qL = new THREE.Quaternion();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  for (let f = 0; f <= frames; f++) {
    times[f] = Math.min(clip.duration, f / fps);
    mixer.setTime(times[f]);
    sourceRoot.updateMatrixWorld(true);

    for (const n of ordered) {
      const s = sMap.get(n);
      const t = tMap.get(n);

      s.matrixWorld.decompose(v1, qS, v1);                 // source 世界朝向
      if (t.parent) t.parent.matrixWorld.decompose(v2, qP, v2);
      else qP.identity();

      qL.copy(qP).invert().multiply(qS).normalize();
      qL.toArray(bufs.get(n), f * 4);

      // 立刻写回并刷新矩阵，让同一帧里的子骨骼能读到
      t.quaternion.copy(qL);
      t.updateMatrix();
      if (t.parent) t.matrixWorld.multiplyMatrices(t.parent.matrixWorld, t.matrix);
      else t.matrixWorld.copy(t.matrix);
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(sourceRoot);

  const tracks = ordered.map(
    (n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, bufs.get(n))
  );
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/**
 * 截取一段动画，并把时间轴平移到 0。
 *
 * 不要用 THREE.AnimationUtils.subclip —— 它保留原始 times（比如从 0.67s 开始），
 * 却把 duration 设成 (end-start)/fps。两者错位，playhead 播到的根本不是要的那段：
 * 翻滚动画因此永远停在下蹲姿势，看起来像「没有翻滚动作」。
 */
function sliceClip(clip, startFrame, endFrame, fps = 60) {
  const t0 = startFrame / fps;
  const t1 = endFrame / fps;
  const tracks = [];

  for (const track of clip.tracks) {
    const stride = track.getValueSize();
    const times = [];
    const values = [];

    for (let i = 0; i < track.times.length; i++) {
      const t = track.times[i];
      if (t < t0 - 1e-6 || t > t1 + 1e-6) continue;
      times.push(t - t0);                                  // 平移到 0
      for (let k = 0; k < stride; k++) values.push(track.values[i * stride + k]);
    }

    if (times.length < 2) continue;
    tracks.push(new track.constructor(track.name, times, values));
  }

  return new THREE.AnimationClip(clip.name, Math.max(0.01, t1 - t0), tracks);
}

/**
 * 上半身 + 下半身拼接。
 *
 * 格挡移动不能整段换成 walk —— 那样手臂会变成走路摆臂，格挡就没了，
 * 看起来像「格挡和走路两个动作同时播」。取格挡的上半身 + 走路的腿，
 * 才是「举着盾走」。
 */
function blendUpperLower(upperClip, lowerClip, name, opts = {}) {
  const LOWER = new Set([
    'mixamorigHips',
    'mixamorigLeftUpLeg', 'mixamorigRightUpLeg',
    'mixamorigLeftLeg', 'mixamorigRightLeg',
    'mixamorigLeftFoot', 'mixamorigRightFoot',
    'mixamorigLeftToeBase', 'mixamorigRightToeBase',
    'mixamorigLeftToe_End', 'mixamorigRightToe_End',
  ]);

  // 可选躯干前倾补偿。借来的上半身和原动画的腿拼在一起时重心常对不上
  // （倒退走会显得人往后仰），用这个把它压回去。正值 = 前倾。
  const leanPerBone = opts.lean ? opts.lean / 3 : 0;
  const leanAxis = new THREE.Vector3(1, 0, 0);
  const LEAN_BONES = /^mixamorig(Spine|Spine1|Spine2)$/;

  const boneOf = (track) => track.name.split('.')[0];
  const out = [];
  const tmpQ = new THREE.Quaternion();
  const partQ = new THREE.Quaternion();

  for (const t of upperClip.tracks) {
    if (LOWER.has(boneOf(t))) continue;   // 上半身只取外来动画
    const c = t.clone();

    if (leanPerBone && LEAN_BONES.test(boneOf(c)) && c.name.endsWith('.quaternion')) {
      // 三节脊椎各分 1/3，弯出弧线而不是在腰上折断
      partQ.setFromAxisAngle(leanAxis, leanPerBone);
      for (let i = 0; i < c.values.length; i += 4) {
        tmpQ.fromArray(c.values, i).premultiply(partQ);
        tmpQ.toArray(c.values, i);
      }
    }
    out.push(c);
  }
  for (const t of lowerClip.tracks) {
    if (!LOWER.has(boneOf(t))) continue;  // 下半身只取原动画
    out.push(t.clone());
  }

  return new THREE.AnimationClip(name, lowerClip.duration, out);
}

/** 往已绑定的 binder 上追加一批外部动画剪辑 */
export async function loadAnimationPack(binder, pack = SOULS_PACK, base = '') {
  if (!binder || !binder.loader) return 0;
  const entries = Object.entries(pack);
  let loaded = 0;

  await Promise.all(entries.map(async ([name, url]) => {
    try {
      const g = await binder.loader.loadAsync(base + url);
      let clip = g.animations?.[0];
      if (!clip) return;

      // ① rest pose 补偿。deevid 动画和 xbot 骨架虽然骨骼同名，rest 差异极大
      //    （RightUpLeg 差 180°、Shoulder 差 132°）。用局部公式：
      //        target = targetRest · (sourceRest⁻¹ · anim)
      //    世界空间版本（retargetClipWorld）在这两套 rig 上反而更差，不启用。
      clip = retargetClip(binder.root, g.scene, clip);

      // ② 砍掉后半段回位：动捕会把动作慢慢收回静止姿势，游戏里只要「挥完就停」
      const info = STRIKE[name];
      if (info) {
        clip = sliceClip(clip, 0, info.cut, 60);
      } else if (name === 'Dive_Roll') {
        // Stand_To_Roll 是「站立 → 下蹲 → 翻滚 → 起身」的完整过程（142 帧）：
        //   0–40  下蹲准备（头顶 1.50 → 0.95）
        //   47–91 真正翻滚（头顶降到 0.03）
        //   92+   起身
        // 只取下蹲尾声到翻滚结束，46 帧 ≈ 0.77s，正好是类魂翻滚的长度。
        clip = sliceClip(clip, 40, 92, 60);
      }

            // ③ Hips 的水平位移已在 retargetClip 里锁死为 rest，这里不用再过滤

      clip.name = name;
      binder.clips.set(name, clip);
      loaded++;
    } catch (err) {
      console.warn(`[anim-pack] 缺少 ${name}:`, err.message);
    }
  }));

// 合成「举着盾走」：上半身照抄格挡，下半身照抄行走
  const up = binder.clips.get('Blocking');
  const lo = binder.clips.get('BlockWalk');
  if (up && lo) {
    binder.clips.set('BlockMove', blendUpperLower(up, lo, 'BlockMove'));
  }

  // 合成「倒退走」：WalkBack 这段动画的前臂四元数 w 在 0.87~0.97，
  // 几乎不转 —— 手臂是僵直外撇的，直接播会像胳膊折了。
  // 上半身借 Walking 的自然摆臂，下半身用 WalkBack 的腿。
  const walkUp = binder.clips.get('Walking');
  const backLo = binder.clips.get('WalkBack');
  if (walkUp && backLo) {
    // 倒退走时躯干总共前倾 25°，三节脊椎各分 1/3（8.33°）。
    // 用度写清楚，别再算弧度。
    binder.clips.set('WalkBackFull',
      blendUpperLower(walkUp, backLo, 'WalkBackFull', { lean: THREE.MathUtils.degToRad(25) }));
  }

  return loaded;
}

function OrigenHipsTranslation(trackName) {
  return /(^|[^a-z])Hips\.(position|translation)$/i.test(trackName);
}

/** 按名字正则找骨骼（排除手指、脚趾这些同名干扰项） */
function findBone(root, re) {
  let hit = null;
  root.traverse((o) => {
    if (hit || !o.name) return;
    if (!re.test(o.name)) return;
    if (/thumb|index|middle|ring|pinky|toe/i.test(o.name)) return;
    hit = o;
  });
  return hit;
}

/**
 * 往右手骨骼挂一把剑。
 *
 * 武器挂在骨骼上，尺寸用**骨骼空间**写 —— 模型被 fitToHeight 缩放时
 * 武器会跟着等比放大，不用为玩家和 Boss 各配一套数值。
 */
export function attachWeapon(root, opts = {}) {
  const hand = findBone(root, /righthand/i);
  if (!hand) return null;

  // length 用「世界米数」传，这里换算回骨骼空间。
  // 不换算的话，同一份数值在玩家（scale≈1.1）和 Boss（scale≈0.7）身上
  // 会得到两把完全不同的剑。
  const ws = new THREE.Vector3();
  root.getWorldScale(ws);
  const sf = ws.y > 1e-4 ? ws.y : 1;
  const L = (opts.length ?? 1.0) / sf;
  const W = (opts.width ?? 0.065) / sf;

  const steel = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xc8d2da, metalness: 0.9, roughness: 0.25,
  });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x2a1f18, roughness: 0.9 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0x8a6a32, metalness: 0.8, roughness: 0.4 });

  const g = new THREE.Group();

  // 剑身沿 +Y：Mixamo 手骨的 Y 轴指向手指方向
  const blade = new THREE.Mesh(new THREE.BoxGeometry(W, L, W * 0.22), steel);
  blade.position.y = L * 0.5 + 0.10;
  blade.castShadow = true;
  g.add(blade);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(W * 0.72, W * 2.2, 4), steel);
  tip.position.y = L + 0.10 + W * 1.1;
  tip.rotation.y = Math.PI / 4;
  g.add(tip);

  const guard = new THREE.Mesh(new THREE.BoxGeometry(W * 3.4, W * 0.42, W * 0.72), goldMat);
  guard.position.y = 0.10;
  g.add(guard);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.36, W * 0.32, L * 0.20, 8), gripMat);
  grip.position.y = 0.10 - L * 0.10;
  g.add(grip);

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(W * 0.48, 8, 6), goldMat);
  pommel.position.y = 0.10 - L * 0.20;
  g.add(pommel);

  // 朝向修正：实测 Y Bot 的手骨 +Y 指向手指，绕 Z 转 -90° 后剑身才指向角色正前方
  // （俯视角下为 (0, -0.33, -0.92)：朝前略向下，是自然的持剑角度）。
  g.rotation.set(...(opts.rotation ?? [0, 0, -Math.PI / 2]));

  hand.add(g);
  return g;
}

/**
 * 用外部 GLB 模型当武器（替代程序化生成的剑）。
 *
 * 和 attachWeapon 的区别：那个是代码拼的盒子，这个是完整模型。
 * 需要额外处理三件事：归一化到目标世界长度、把模型中心挪到握持点、转轴对齐。
 * jian.glb 这种 AI 生成模型长轴常常是 Z 而不是 Y，不转的话剑会横着戳出去。
 */
export async function attachWeaponModel(binder, url, opts = {}) {
  const hand = findBone(binder.root, /righthand/i);
  if (!hand) return null;

  const g = await binder.loader.loadAsync(url);
  const model = g.scene;

  // ① 找出长轴 —— 必须在缩放前算，缩放在长轴上才有意义
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const longestAxis = size.x >= size.y && size.x >= size.z ? 'x'
                    : (size.y >= size.z ? 'y' : 'z');
  const AXIS_IDX = longestAxis === 'x' ? 0 : longestAxis === 'y' ? 1 : 2;
  const longest = size.getComponent(AXIS_IDX) || 1;

  const ws = new THREE.Vector3();
  binder.root.getWorldScale(ws);
  const sf = ws.y > 1e-4 ? ws.y : 1;
  const targetBoneSpace = (opts.length ?? 1.0) / sf;
  const k = targetBoneSpace / longest;

  // 只沿长轴缩放：等比放大会让剑「又长又宽」，
  // 真实加长兵器是拉长刃身、截面不变。另外两轴保持模型原始尺寸。
  model.scale.set(1, 1, 1);
  if (opts.uniform) {
    // 镰刀 / 锤子 / 斧这类「长宽比不能改」的武器：整体等比缩放，
    // 否则只拉长轴会把刀头压成一条线。
    model.scale.setScalar(k);
  } else {
    // 剑 / 枪这类：只拉长轴，截面不变
    model.scale.setComponent(AXIS_IDX, k);
  }

  // ② 柄端
  // gripEnd 决定「柄」在长轴哪一端；gripShift = 沿长轴从柄端往刃端的偏移比例(0~1)。
  //   - 剑：柄在最底端，gripShift≈0
  //   - 镰刀/长柄：通常要握在轴中段，gripShift 取 0.3~0.6
  const gripSign = opts.gripEnd ?? -1;
  const axisMin = box.min.getComponent(AXIS_IDX);
  const axisMax = box.max.getComponent(AXIS_IDX);
  const axisLen = axisMax - axisMin;
  const gripEndValue = gripSign > 0 ? axisMax : axisMin;
  const gripDir = gripSign > 0 ? -1 : 1;      // 从柄端指向刃端的方向
  let gripShift = opts.gripShift ?? 0;         // 0 = 柄端，1 = 刃端
  let gripAxisValue = gripEndValue + gripDir * gripShift * axisLen;

  // ③ 转轴：长轴对齐到 +Y，再由外层 Group 转到「朝前」
  const inner = new THREE.Group();
  // 绕武器自身长轴的滚转：决定镰刀刃朝上 / 朝侧 / 朝下
  const rollGroup = new THREE.Group();
  rollGroup.rotation.y = opts.roll ?? 0;
  rollGroup.add(model);
  inner.add(rollGroup);
  if (opts.alignAxis === 'z') inner.rotation.x = -Math.PI / 2;
  else if (opts.alignAxis === 'x') inner.rotation.z = Math.PI / 2;

  const outer = new THREE.Group();
  outer.add(inner);
  outer.rotation.set(...(opts.rotation ?? [0, 0, -Math.PI / 2]));

  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  hand.add(outer);

  // ④ 精确对齐：找到「柄末端那一圈的顶点」的几何中心，
  //    然后平移 outer，让它正好落在掌心。
  //
  //    关键：旋转 outer 时，柄重心也会跟着转 —— 所以每次改 rotation
  //    都要重新测一次柄重心、再补一次平移，武器才会「绕柄转」：
  //    柄始终钉在掌心，只有刃身绕柄甩。只算一次的话，一调角度柄就飞出手。
  const tol = Math.abs(box.max.getComponent(AXIS_IDX) - box.min.getComponent(AXIS_IDX)) * 0.03;
  // 掌心位置（手骨局部）：手指沿 +Y，掌心偏 +X
  const target = new THREE.Vector3(
    (opts.palmSide ?? 0.03) / sf,
    (opts.palmOffset ?? 0.06) / sf,
    0,
  );

  /** 测出「柄端顶点圈」在手骨局部空间的几何中心（要求 rotation 已就位、position 归零） */
  function measureGripInHand() {
    outer.position.set(0, 0, 0);
    outer.updateMatrixWorld(true);
    hand.updateMatrixWorld(true);
    const handInv = hand.matrixWorld.clone().invert();
    const sum = new THREE.Vector3();
    let n = 0;
    const v = new THREE.Vector3();
    model.traverse((o) => {
      if (!o.isMesh) return;
      const pa = o.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pa.count / 4000));
      for (let i = 0; i < pa.count; i += step) {
        v.fromBufferAttribute(pa, i);
        if (Math.abs(v.getComponent(AXIS_IDX) - gripAxisValue) < tol) {
          // 模型局部 → 世界 → 手骨局部
          v.applyMatrix4(o.matrixWorld).applyMatrix4(handInv);
          sum.add(v);
          n++;
        }
      }
    });
    return n > 0 ? sum.divideScalar(n) : null;
  }

  /** 绕柄重新对齐：改完 outer.rotation / rollGroup.rotation 后调用一次 */
  function realign() {
    const g = measureGripInHand();
    // 注意：先 copy 再 sub，避免原地修改 target（会累积偏移）
    if (g) outer.position.copy(target).sub(g);
    outer.updateMatrixWorld(true);
  }
  realign();

  /** 沿长轴挪握点：0 = 柄端，1 = 刃端（镰刀/长柄武器常要握在中段） */
  function setGripShift(s) {
    gripShift = Math.min(1, Math.max(0, s));
    gripAxisValue = gripEndValue + gripDir * gripShift * axisLen;
    realign();
  }

  // 暴露给调参面板 / 控制台：改完角度后调 realign()，柄会重新钉回掌心
  outer.userData.weapon = { realign, rollGroup, target, setGripShift, getGripShift: () => gripShift };
  if (binder) binder.weaponGroup = outer;

  return outer;
}

/**
 * 一步到位：加载模型并替换某个 Actor 的灰盒外观
 * @example
 *   const binder = await bindModel(player, '/assets/hero.glb', { scale: 1.0, renderer });
 */
export async function bindModel(actor, url, opts = {}) {
  const loader = opts.loader ?? initLoader(opts.renderer);
  const gltf = await loader.loadAsync(url);
  const binder = new ModelBinder(gltf, opts);
  binder.loader = loader;
  binder.attachTo(actor.mesh.group);
  if (opts.targetHeight) binder.fitToHeight(opts.targetHeight);

  // 武器是附加物：加载失败不能把整个 bindModel 拖挂 ——
  // 那样 Promise.all 会 reject，window.__dbg 都挂不上，整个 demo 停摆。
  if (opts.weaponModel) {
    try {
      await attachWeaponModel(binder, opts.weaponModel, opts.weaponOpts ?? {});
    } catch (e) {
      console.error('[weapon] 挂载失败:', e);
    }
  } else if (opts.weapon) {
    try {
      attachWeapon(binder.root, opts.weapon);
    } catch (e) {
      console.error('[weapon] 程序化武器失败:', e);
    }
  }

  actor.binder = binder;
  actor.mesh.group.traverse((o) => { if (o.isMesh && o.material) o.material.side = THREE.FrontSide; });
  return binder;
}
