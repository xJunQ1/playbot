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
  walk: 'Walking',            // Boss 踱步 / 绕圈时用
  roll: 'Dive_Roll',
  backstep: 'BossBackstep',
  moveback: 'Backstep',
  block: 'Blocking',   // 格挡：直接用 格挡.fbx 原始动作（重新转换的 0.95s 版本）
  blockmove: 'BlockMove',
  hitstun: 'Getting_Hit_Backwards',
  guardbreak: 'Getting_Hit_Backwards',
  dead: 'Death',
  // 三段按「动作类型」拉开，保证一眼能分出打到第几下：
  //   横劈 → 跳劈 → 旋身斩
  p_light1: 'LightCombo4_1',   // 轻击四段连招·第 1 段
  p_light2: 'LightCombo4_2',   // 轻击四段连招·第 2 段
  p_light3: 'LightCombo4_3',   // 轻击四段连招·第 3 段
  p_light4: 'LightCombo4_4',   // 轻击四段连招·第 4 段
  p_heavy: 'HeavyCombo1',      // 重击三连击·第 1 段
  p_heavy2: 'HeavyCombo2',     // 重击三连击·第 2 段
  p_heavy3: 'HeavyCombo3',     // 重击三连击·第 3 段
  b_sweep: 'Great_Sword_Attack',
  b_slam: 'Great_Sword_Slash',
  b_charge: 'Standing_Dodge_Forward',
};

// Cache support points on the soles before animation starts. Keep the extreme
// vertices at several slopes so heel strikes and toes can both carry weight.
function collectSoleVertices(root) {
  const patches = [];
  const point = new THREE.Vector3();
  root.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);
  root.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    const byBone = new Map();
    mesh.skeleton.bones.forEach((bone, i) => {
      if (/(?:foot|toebase)$/i.test(bone.name)) byBone.set(i, new Map());
    });
    if (!byBone.size) return;
    const stride = Math.max(1, Math.floor(position.count / 60000));
    for (let i = 0; i < position.count; i += stride) {
      let joint = 0;
      for (let j = 1; j < 4; j++) {
        if (skinWeight.getComponent(i, j) > skinWeight.getComponent(i, joint)) joint = j;
      }
      const hull = byBone.get(skinIndex.getComponent(i, joint));
      if (!hull) continue;
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          const key = 5 * x + z;
          const score = point.y + x * point.x + z * point.z;
          if (!hull.has(key) || score < hull.get(key).score) hull.set(key, { score, i });
        }
      }
    }
    const indices = new Set();
    for (const hull of byBone.values()) for (const { i } of hull.values()) indices.add(i);
    if (indices.size) patches.push({ mesh, indices });
  });
  return patches;
}

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

    // 蒙皮网格不能用 Box3.setFromObject 量身高：它会把骨骼变换算进去，
    // 姿态一变包围盒就失真（Tripo 的 Boss 因此只被放大到 1.8 倍，比玩家还矮）。
    // 改成直接读几何体的局部包围盒，再乘上网格相对 root 的缩放。
    let localH = 0;
    let meshRel = 1;
    const ws = new THREE.Vector3();
    this.root.getWorldScale(ws);
    this.root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const h = o.geometry.boundingBox.max.y - o.geometry.boundingBox.min.y;
      if (h <= localH) return;
      localH = h;
      const ms = new THREE.Vector3();
      o.getWorldScale(ms);
      meshRel = ws.y > 1e-6 ? ms.y / ws.y : 1;
    });

    let worldH = localH * meshRel;
    if (worldH < 1e-4) {
      const box = new THREE.Box3().setFromObject(this.root);
      worldH = box.max.y - box.min.y;
    }
    if (worldH < 1e-4) return;

    this.root.scale.multiplyScalar(targetHeight / (worldH * this.root.scale.y));

    this.root.updateMatrixWorld(true);

    // 脚底贴地：自己算几何包围盒的世界最低点（Box3 对 SkinnedMesh 会失真，
    // 之前 Boss 放大到 4.6m 后整只脚浮在地面上 0.5m）
    let minY = Infinity;
    const v = new THREE.Vector3();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        v.applyMatrix4(o.matrixWorld);
        if (v.y < minY) minY = v.y;
      }
    });
    if (Number.isFinite(minY)) this.root.position.y -= minY;
  }

  /**
   * 按「骨骼实际身高」缩放到目标高度（头骨 → 脚趾骨）。
   * 有些 FBX→GLB 的模型，蒙皮网格几何和骨骼尺度差几百倍，按网格包围盒量会失效。
   */
  fitToHeightBones(targetHeight) {
    this.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let head = null;
    let toe = null;
    this.root.traverse((o) => {
      if (!o.isBone || !o.name) return;
      if (!head && /^head$/i.test(o.name)) head = o;
      if (!toe && /toebase$/i.test(o.name)) toe = o;
    });
    if (!head || !toe) return false;

    head.getWorldPosition(v); const h0 = v.y;
    toe.getWorldPosition(v); const t0 = v.y;
    const boneH = h0 - t0;
    if (boneH < 1e-4) return false;

    // 头骨到脚趾骨大约占身高的 85%
    const k = (targetHeight * 0.85) / boneH;
    this.root.scale.multiplyScalar(k);
    this.root.updateMatrixWorld(true);

    toe.getWorldPosition(v);
    this.root.position.y -= v.y;   // 脚趾骨贴地
    this.root.updateMatrixWorld(true);
    return true;
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
        // 攻击/翻滚：单次播放，不循环（heavy2 / heavy3 / light4 也必须算进来，
        // 否则播到片段末尾会绕回第 0 帧，表现为「结尾重复一帧」）
        const onceState = actor.state === 'roll' || actor.state === 'attack' || actor.state === 'backstep'
          || /^light\d*$/.test(actor.state) || /^heavy\d*$/.test(actor.state);
        if (onceState) {
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
        } else if (key === 'moveback') {
          // 后退片段自带根位移 ≈0.98 m/s；播放速度跟实际移动速度对齐，避免脚底打滑
          const NATURAL = 0.98;
          next.setEffectiveTimeScale(THREE.MathUtils.clamp(actor.speed / NATURAL, 0.55, 2.6));   // 上限放宽，快退时也能和位移对齐
        } else if (key === 'blockmove') {
          const ref = 1.40;
          const sp = actor.speed > 0.05 ? actor.speed : ref;
          next.setEffectiveTimeScale(THREE.MathUtils.clamp(sp / ref, 0.45, 2.2));
        } else {
          next.setEffectiveTimeScale(1);
        }

        // 连段接缝：轻击/重击都是不同片段拼起来的，姿势差得多，
        // 给更长的混入时间（0.16s），否则接缝处会"跳一下"
        const COMBO_RE = /^(light\d|heavy\d?)$/;
        const isComboSeam = COMBO_RE.test(actor.state) || (this.currentName || '').startsWith('HeavyCombo');
        if (prev && prev !== next) {
          next.crossFadeFrom(prev, isComboSeam ? 0.16 : 0.08, false);   // 视觉淡入，逻辑早已切换
        }

        next.play();
        this.current = next;
        this.currentName = targetName;
      }
    }

    if (actor.backstep && this.currentName === targetName) {
      // The simulation frame drives both the planted step and the retreat.
      this.current.paused = true;
      this.current.time = this.current.getClip().duration * actor.frame / actor.backstep.frames;
    }
    this.mixer.update(dt);
    if (this.solePatches?.length) this.groundPose(actor, dt);
    if (this.gripEnabled !== false) applySwordGrip(this.root, 'Right');   // 握剑手：右手五指卷曲
  }

  groundPose(actor, dt) {
    if (actor.state !== 'attack' && actor.state !== 'backstep') {
      // Ease the visual offset out through the blend back into locomotion.
      this.root.position.y = THREE.MathUtils.damp(this.root.position.y, this.restRootY, 24, dt);
      return;
    }
    this.root.updateWorldMatrix(true, false);
    this.root.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const { mesh, indices } of this.solePatches) {
      for (const index of indices) {
        mesh.getVertexPosition(index, this.solePoint).applyMatrix4(mesh.matrixWorld);
        lowest = Math.min(lowest, this.solePoint.y);
      }
    }
    // Actor containers are unit scale and only rotate about Y. Move the
    // visual root, keeping attack travel, hitboxes and the lifted foot intact.
    this.root.position.y += this.root.parent.matrixWorld.elements[13] - lowest;
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
    // 锁定视角时按 S：面朝 Boss 后退，用 后退.fbx 的动作
    if (actor.lockOn && actor.state === 'move' && actor.moveAxis < 0) return 'moveback';
    // 只要带后退分量就播倒退走（含 S+A / S+D 斜向后退）。
    // 朝向在 applyMoveInput 里已经反过来了，所以斜向后退也是正确的倒退姿态。
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
/**
 * 「去外展」只对这几个片段生效（单位：度），其余片段 0 = 完全不动。
 * 全局生效会把待机/攻击这类本来就正常的动作收成内八，所以按片段配置。
 */
export const LEG_ABDUCT_CLIPS = {
  // 每个片段单独给角度：leg = 大腿内收，calf = 小腿内收（单位：度）
  // 后退目标：膝距 16.6 cm、脚距 14.2 cm
  WalkBack: { leg: 11.95, calf: 1.5, arm: 0 },
};

export const SOULS_PACK = {
  // 只登记真正用到的片段。缺文件会让整包加载失败（模型全部定格），所以不留实验项。
  Idle: 'assets/player/Idle.glb',
  Walking: 'assets/player/Running.glb',
  Running: 'assets/player/Running.glb',
  Dive_Roll: 'assets/player/Dive_Roll.glb',
  Blocking: 'assets/player/Blocking.glb',
  BlockWalk: 'assets/sword_and_shield_walk.glb',   // 只取下半身，和 Blocking 合成 BlockMove
  Getting_Hit_Backwards: 'assets/player/Getting_Hit_Backwards.glb',
  Death: 'assets/player/Death.glb',
  Backstep: 'assets/player/Backstep.glb',   // 后退：原始动作（膝 24.0 / 脚 19.4 cm）
  LightCombo4: 'assets/player/LightCombo4.glb',   // 轻击四段连招（一条动作，运行时切四段）
  LightCombo: 'assets/player/LightCombo.glb',   // 轻击三连击（三段拼接成一条，运行时切三段）
  HeavyCombo: 'assets/player/HeavyCombo_v2.glb',   // 重击三连击（剥网格 + 髋部抬高 + Y 钳制）
  Stable_Sword_Inward_Slash: 'assets/player/Stable_Sword_Inward_Slash.glb',
  Stable_Sword_Outward_Slash: 'assets/player/Stable_Sword_Outward_Slash.glb',
  Great_Sword_Slash: 'assets/player/Great_Sword_Slash.glb',
  Great_Sword_Attack: 'assets/player/Great_Sword_Attack.glb',
  Standing_Dodge_Forward: 'assets/Standing_Dodge_Forward.glb',
  Light_3: 'assets/player/Light_3.glb',
  Heavy_2: 'assets/player/Great_Sword_Attack.glb',
  Heavy_3: 'assets/player/Heavy_3.glb',
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
// ── 骨架别名 ──────────────────────────────────────────────────
// Mixamo 动作包的轨道名是 mixamorigHips / LeftArm…，而 Tripo、Mixamo 之外
// 的通用人形骨架常叫 Hip / L_Upperarm / R_Hand。retarget 时按这张表找目标骨骼。
const BONE_ALIASES = {
  Hips: ['Hip', 'Pelvis'],
  Spine: ['Spine01', 'Spine'],
  Spine1: ['Spine02', 'Spine1'],
  Spine2: null,                       // 目标只有两节脊椎，跳过避免双写同一条骨
  Neck: ['NeckTwist01', 'Neck'],
  Head: ['Head'],
  LeftShoulder: ['L_Clavicle'],
  LeftArm: ['L_Upperarm'],
  LeftForeArm: ['L_Forearm'],
  LeftHand: ['L_Hand'],
  RightShoulder: ['R_Clavicle'],
  RightArm: ['R_Upperarm'],
  RightForeArm: ['R_Forearm'],
  RightHand: ['R_Hand'],
  LeftUpLeg: ['L_Thigh'],
  LeftLeg: ['L_Calf'],
  LeftFoot: ['L_Foot'],
  LeftToeBase: ['L_ToeBase'],
  RightUpLeg: ['R_Thigh'],
  RightLeg: ['R_Calf'],
  RightFoot: ['R_Foot'],
  RightToeBase: ['R_ToeBase'],
};

/** 去掉 mixamorig / mixamorig: 前缀，拿到纯骨骼名 */
function stripRigName(name) {
  return name.replace(/^mixamorig[:_]?/i, '');
}

/** 在目标骨架里找这条轨道对应的骨骼：原名 → 去前缀 → 别名表 */
function resolveTargetBone(tMap, name) {
  if (tMap.has(name)) return tMap.get(name);
  const base = stripRigName(name);
  if (tMap.has(base)) return tMap.get(base);
  const alts = BONE_ALIASES[base];
  if (alts) for (const a of alts) if (tMap.has(a)) return tMap.get(a);
  return null;
}

/** 找右手骨骼：兼容 Mixamo（RightHand）与 Tripo（R_Hand） */
function findHand(root) {
  return findBone(root, /(right.?hand|R_Hand)$/i) ?? findBone(root, /hand_r$/i);
}
/** 目标骨架是不是 Mixamo 命名（决定用局部公式还是世界空间重定向） */
function usesMixamoRig(root) {
  let hit = false;
  root.traverse((o) => { if (!hit && o.isBone && /mixamorig/i.test(o.name ?? "")) hit = true; });
  return hit;
}

function lookupSourceByAlias(targetName, sByBase) {
  for (const [base, alts] of Object.entries(BONE_ALIASES)) {
    if (!alts) continue;
    if (alts.includes(targetName)) return sByBase.get(base) ?? null;
  }
  return null;
}

export function retargetClip(targetRoot, sourceRoot, clip, opts = {}) {
  // ── 去外展（把 Mixamo 动画自带的外八站姿收窄）─────────────────────────────
  // 大腿绕「骨骼本地 Z 轴」内收；脚掌反向补一半，避免内八。
  // 想关掉就加 URL 参数 ?legabduct=0；想更窄就调大（单位：度）。
  const qsAbduct = new URLSearchParams(location.search).get('legabduct');
  const LEG_ABDUCT = THREE.MathUtils.degToRad(
    qsAbduct != null ? Number(qsAbduct) : (opts.legAbduct ?? 0)
  );
  const qsCalf = new URLSearchParams(location.search).get('calfabduct');
  const CALF_ABDUCT = THREE.MathUtils.degToRad(
    qsCalf != null ? Number(qsCalf) : (opts.calfAbduct ?? 0)
  );
  const CALF_BONE = /^mixamorig(Left|Right)Leg$/;
  const qsArm = new URLSearchParams(location.search).get('armadduct');
  const ARM_ABDUCT = THREE.MathUtils.degToRad(
    qsArm != null ? Number(qsArm) : (opts.armAdduct ?? 0)
  );
  const qsArmPitch = new URLSearchParams(location.search).get('armpitch');
  const ARM_PITCH = THREE.MathUtils.degToRad(
    qsArmPitch != null ? Number(qsArmPitch) : (opts.armPitch ?? 0)
  );
  const ARM_BONE = /^mixamorig(Left|Right)Arm$/;
  const armAxisKey = (new URLSearchParams(location.search).get('armaxis') || opts.armAxis || 'x').toLowerCase();
  const armAxisVec = armAxisKey === 'y' ? new THREE.Vector3(0, 1, 0)
    : armAxisKey === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const qArmPitch = new THREE.Quaternion().setFromAxisAngle(armAxisVec, ARM_PITCH);
  const qArmL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -ARM_ABDUCT);
  const qArmR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ARM_ABDUCT);
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const qCalfL = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -CALF_ABDUCT);
  const qCalfR = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, CALF_ABDUCT);
  const LEG_BONE = /^mixamorig(Left|Right)UpLeg$/;
  const FOOT_BONE = /^mixamorig(Left|Right)Foot$/;
  const qLegL = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -LEG_ABDUCT);
  const qLegR = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, LEG_ABDUCT);
  const qFootL = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, LEG_ABDUCT * 0.5);
  const qFootR = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -LEG_ABDUCT * 0.5);
  const tMap = new Map();
  const sMap = new Map();
  targetRoot.traverse((o) => { if (o.name) tMap.set(o.name, o); });
  sourceRoot.traverse((o) => { if (o.name) sMap.set(o.name, o); });

  const out = [];
  const tmp = new THREE.Quaternion();

  // 目标骨骼的局部 rest 只在第一次抓，缓存住。
  // 否则第一个剪辑把骨架摆好之后，后面每个剪辑都会把「当前姿势」当成 rest，越接越歪。
  let restMap = targetRoot.userData.__restLocal;
  if (!restMap) {
    restMap = new Map();
    for (const [name, obj] of tMap) restMap.set(obj, obj.quaternion.clone());
    targetRoot.userData.__restLocal = restMap;
  }

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);

    const t = resolveTargetBone(tMap, bone);
    const s = sMap.get(bone);
    if (!t || !s) continue;

    if (prop === 'position') {
      // 只保留 Hips 的位移。翻滚时身体下潜靠的就是它 —— 全删掉只剩骨骼旋转，
      // 头顶永远降不下去，看起来像「按了闪避但人没滚」。
      // X/Z 锁死在 rest，避免和 frame-data.js 的 motion 曲线叠成双倍位移。
      if (!/^hips?$/i.test(stripRigName(bone))) continue;
      const ps = s.position;
      const pt = t.position;
      const vals = new Float32Array(track.values.length);
      for (let k = 0; k < track.values.length; k += 3) {
        vals[k]     = pt.x;
        vals[k + 1] = pt.y + (track.values[k + 1] - ps.y);
        vals[k + 2] = pt.z;
      }
      out.push(new THREE.VectorKeyframeTrack(`${t.name}.position`, track.times, vals));
      continue;
    }

    if (prop !== 'quaternion') continue;

    const qsInv = s.quaternion.clone().invert();
    const qt = (restMap.get(t) ?? t.quaternion).clone();
    const vals = new Float32Array(track.values.length);
    for (let k = 0; k < track.values.length; k += 4) {
      tmp.fromArray(track.values, k);
      tmp.premultiply(qsInv);   // sourceRest⁻¹ · anim
      tmp.premultiply(qt);      // targetRest · (...)
      tmp.normalize();
      // leg de-abduction: thigh inward, foot counter-half
      if (LEG_BONE.test(bone)) tmp.multiply(bone.includes('Left') ? qLegL : qLegR);
      else if (CALF_BONE.test(bone)) tmp.multiply(bone.includes('Left') ? qCalfL : qCalfR);
      else if (ARM_BONE.test(bone)) { tmp.multiply(bone.includes('Left') ? qArmL : qArmR); tmp.multiply(qArmPitch); }
      else if (FOOT_BONE.test(bone)) tmp.multiply(bone.includes('Left') ? qFootL : qFootR);
      tmp.toArray(vals, k);
    }
    out.push(new THREE.QuaternionKeyframeTrack(`${t.name}.quaternion`, track.times, vals));
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
  // 目标骨骼 ↔ 源骨骼配对：同名 → 去前缀同名 → 别名表反查
  const sByBase = new Map();
  for (const [name, obj] of sMap) sByBase.set(stripRigName(name), obj);
  const pairs = [];
  targetRoot.traverse((o) => {
    if (!o.isBone || !o.name) return;
    const s = sMap.get(o.name) ?? sByBase.get(o.name) ?? lookupSourceByAlias(o.name, sByBase);
    if (s) pairs.push([o, s]);
  });
  if (pairs.length < 10) return null;

  const fps = 60;
  const frames = Math.ceil(clip.duration * fps);
  const times = new Float32Array(frames + 1);
  const bufs = new Map();
  for (const [t] of pairs) bufs.set(t.name, new Float32Array((frames + 1) * 4));

  const mixer = new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(clip).play();

  const qS = new THREE.Quaternion();
  const qP = new THREE.Quaternion();
  const qL = new THREE.Quaternion();
  const qDelta = new THREE.Quaternion();
  const qTarget = new THREE.Quaternion();
  const qT = new THREE.Quaternion();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  // 只搬「相对绑定姿势的旋转增量」，不要直接复制世界朝向。
  // 直接复制会把两边 rest 的差异（Tripo 的 A-pose / 骨架朝向）也算进去，
  // 人就会整个歪掉。目标的 rest 只抓一次，缓存在 userData 上。
  sourceRoot.updateMatrixWorld(true);
  const sRest = new Map();
  for (const [t, s] of pairs) {
    s.matrixWorld.decompose(v1, qS, v1);
    sRest.set(s, qS.clone());
  }

  let tRest = targetRoot.userData.__restQuat;
  if (!tRest) {
    targetRoot.updateMatrixWorld(true);
    tRest = new Map();
    for (const [t] of pairs) {
      t.matrixWorld.decompose(v1, qT, v1);
      tRest.set(t, qT.clone());
    }
    targetRoot.userData.__restQuat = tRest;
  }

  for (let f = 0; f <= frames; f++) {
    times[f] = Math.min(clip.duration, f / fps);
    mixer.setTime(times[f]);
    sourceRoot.updateMatrixWorld(true);

    for (const [t, s] of pairs) {
      s.matrixWorld.decompose(v1, qS, v1);                 // source 当前朝向
      // R = R_now · R_rest⁻¹：把骨骼从 rest 转到当前姿态的那个「世界旋转」
      qT.copy(sRest.get(s)).invert();
      qDelta.copy(qS).multiply(qT).normalize();
      // 再把它作用到目标的 rest 上：R · R_target_rest
      qTarget.copy(qDelta).multiply(tRest.get(t)).normalize();

      if (t.parent) t.parent.matrixWorld.decompose(v2, qP, v2);
      else qP.identity();

      qL.copy(qP).invert().multiply(qTarget).normalize();
      qL.toArray(bufs.get(t.name), f * 4);

      // 立刻写回并刷新矩阵，让同一帧里的子骨骼能读到
      t.quaternion.copy(qL);
      t.updateMatrix();
      if (t.parent) t.matrixWorld.multiplyMatrices(t.parent.matrixWorld, t.matrix);
      else t.matrixWorld.copy(t.matrix);
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(sourceRoot);

  const tracks = pairs.map(
    ([t]) => new THREE.QuaternionKeyframeTrack(`${t.name}.quaternion`, times, bufs.get(t.name))
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
/**
 * 把 source 的手臂轨道（肩/大臂/小臂/手/手指）替换进 target，其余轨道保留。
 * 用途：倒退走要「手臂外张下垂」的观感，但躯干仍用慢跑的（带前倾）。
 */
const ARM_TRACK_RE = /^mixamorig(Left|Right)(Shoulder|Arm|ForeArm|Hand|HandThumb|HandIndex|HandMiddle|HandRing|HandPinky)/;
export function swapArmTracks(target, source) {
  const armTracks = new Map();
  for (const tr of source.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (ARM_TRACK_RE.test(bone)) armTracks.set(tr.name, tr.clone());
  }
  if (!armTracks.size) return target;
  const out = [];
  for (const tr of target.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (ARM_TRACK_RE.test(bone)) {
      const rep = armTracks.get(tr.name);
      if (rep) out.push(rep);
    } else {
      out.push(tr);
    }
  }
  return new THREE.AnimationClip(target.name, target.duration, out);
}
/**
 * 把 source 的下半身轨道（髋/腿/脚）替换进 target，上半身（脊椎+手臂+头）保留 target 的。
 * 用途：格挡片段原本是蹲姿（腿弯），换成待机的腿 → 站着举盾，同时手臂/剑的姿态不被破坏。
 */
const LOWER_TRACK_RE = /^mixamorig(Hips|LeftUpLeg|RightUpLeg|LeftLeg|RightLeg|LeftFoot|RightFoot|LeftToeBase|RightToeBase)$/;
/**
 * 只替换腿部骨骼轨道，保留 Hips —— 上半身和髋同源时不会出现「脊柱侧倾」。
 */
const LEG_TRACK_RE = /^mixamorig(LeftUpLeg|RightUpLeg|LeftLeg|RightLeg|LeftFoot|RightFoot|LeftToeBase|RightToeBase)$/;
export function swapLegTracks(target, source) {
  const legs = new Map();
  for (const tr of source.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (LEG_TRACK_RE.test(bone)) legs.set(tr.name, tr.clone());
  }
  if (!legs.size) return target;
  const out = [];
  for (const tr of target.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (LEG_TRACK_RE.test(bone)) {
      const rep = legs.get(tr.name);
      if (rep) out.push(rep);
    } else out.push(tr);
  }
  return new THREE.AnimationClip(target.name, target.duration, out);
}
export function swapLowerTracks(target, source) {
  const lower = new Map();
  for (const tr of source.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (LOWER_TRACK_RE.test(bone)) lower.set(tr.name, tr.clone());
  }
  if (!lower.size) return target;
  const out = [];
  for (const tr of target.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (LOWER_TRACK_RE.test(bone)) {
      const rep = lower.get(tr.name);
      if (rep) out.push(rep);
    } else {
      out.push(tr);
    }
  }
  return new THREE.AnimationClip(target.name, target.duration, out);
}
/**
 * 握剑手：把右手五指卷起来。项目里手指骨骼没有被动画驱动，
 * 所以每帧直接设成本地 Z 轴卷曲即可（实测 z 轴 70° 时指尖到掌心最近）。
 */
const GRIP_FINGERS = [
  // 指节 1 / 2 / 3 的卷曲角度（绕手骨本地 Z 轴）
  ['Index', 72, 88, 70],
  ['Middle', 76, 92, 72],
  ['Ring', 78, 92, 72],
  ['Pinky', 80, 94, 74],
  ['Thumb', 40, 46, 34],
];
/**
 * 把某个片段的髋部 Y 平移整体抬/降（米）。用于修「动作自带的髋高与角色身高不匹配」。
 * 只动 Hips 的 position 轨道，不影响旋转，也不影响其它骨骼。
 */
export function shiftClipHipsY(clip, dy) {
  if (!dy) return clip;
  const out = [];
  for (const tr of clip.tracks) {
    if (tr.name !== 'mixamorigHips.position') { out.push(tr); continue; }
    const v = tr.values.slice();
    for (let i = 1; i < v.length; i += 3) v[i] += dy;
    out.push(new THREE.VectorKeyframeTrack(tr.name, tr.times.slice(), v));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, out);
}
export function applySwordGrip(root, side = 'Right') {
  const z = new THREE.Vector3(0, 0, 1);
  for (const [name, a1, a2, a3] of GRIP_FINGERS) {
    for (let seg = 1; seg <= 3; seg++) {
      const bone = root.getObjectByName(`mixamorig${side}Hand${name}${seg}`);
      if (!bone) continue;
      const deg = seg === 1 ? a1 : seg === 2 ? a2 : a3;
      bone.quaternion.setFromAxisAngle(z, THREE.MathUtils.degToRad(deg));
    }
  }
}
export function blendUpperLower(upperClip, lowerClip, name, opts = {}) {
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
/**
 * 压低某个剪辑里的手臂摆动幅度。
 *
 * 做法：每根手臂骨骼的四元数轨道，朝**首帧基准**做 slerp 压缩 ——
 * factor = 0.25 表示只保留 25% 的摆幅。只改旋转轨道，根骨骼位移、
 * 腿和躯干的轨道完全不碰，所以步频、脚步、身体前倾都不受影响。
 *
 * @param {Map<string, THREE.AnimationClip>} clips binder.clips
 * @param {string[]} names 剪辑名（Walking / Running ...）
 * @param {number} factor 0 = 手臂完全不动，1 = 原样
 * @param {RegExp} boneRe 骨骼名匹配（默认肩 + 大臂 + 小臂）
 * @returns {number} 实际处理了多少条轨道
 */
export function dampenArmSwing(
  clips,
  names,
  factor = 0.25,
  boneRe = /(LeftArm|RightArm|LeftForeArm|RightForeArm|LeftShoulder|RightShoulder|L_Upperarm|R_Upperarm|L_Forearm|R_Forearm|L_Clavicle|R_Clavicle)$/i,
) {
  if (!(factor >= 0 && factor < 1)) return 0;

  const q = new THREE.Quaternion();
  const base = new THREE.Quaternion();
  const tmp = new THREE.Quaternion();
  let count = 0;

  for (const name of names) {
    const clip = clips.get(name);
    if (!clip) continue;

    for (const track of clip.tracks) {
      if (!track.name.endsWith('.quaternion')) continue;
      const bone = track.name.slice(0, -'.quaternion'.length);
      if (!boneRe.test(bone)) continue;

      const n = track.values.length / 4;
      if (n < 2) continue;

      base.fromArray(track.values, 0);
      for (let i = 1; i < n; i++) {
        q.fromArray(track.values, i * 4);
        // 四元数 q 和 -q 是同一个旋转；不同半球做 slerp 会绕远路
        if (q.dot(base) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        tmp.copy(base).slerp(q, factor);
        tmp.toArray(track.values, i * 4);
      }
      count++;
    }
  }
  return count;
}
/** 找一段动作里「手最快」的时刻（秒）—— 攻击动画的命中点大概就在那 */
/**
 * 去掉骨骼的 translation / scale 轨道，只保留 rotation。
 * 位移只留 Root / Hip 这种真正需要位移的根骨 —— 其余骨骼的位移是
 * 源骨架的骨头长度，套到别的骨架上会直接把手脚拉长。
 */
function stripBoneTransforms(clip) {
  const tracks = clip.tracks.filter((t) => {
    if (t.name.endsWith('.scale')) return false;
    if (t.name.endsWith('.position')) {
      const bone = t.name.slice(0, -'.position'.length);
      return /^(root|hip|hips|pelvis)$/i.test(bone);
    }
    return true;
  });
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  return out;
}
function findStrikeTime(clip) {
  const re = /(R_Upperarm|R_Forearm|R_Hand|R_Clavicle)\.quaternion$/i;
  let best = -1;
  let bestT = clip.duration * 0.4;
  for (const tr of clip.tracks) {
    if (!re.test(tr.name)) continue;
    const n = tr.values.length / 4;
    for (let i = 1; i < n; i++) {
      const b = (i - 1) * 4, a = i * 4;
      let dot = Math.abs(
        tr.values[a] * tr.values[b] + tr.values[a + 1] * tr.values[b + 1] +
        tr.values[a + 2] * tr.values[b + 2] + tr.values[a + 3] * tr.values[b + 3]
      );
      dot = Math.min(1, dot);
      const ang = 2 * Math.acos(dot);
      if (ang > best) { best = ang; bestT = tr.times[i]; }
    }
  }
  return bestT;
}

/**
 * 加载「同一个骨架」的自带动作包：不做重定向，只按名字登记。
 * 攻击类走 autoSlice —— 把长动画切到命中点前后，避免被帧表压成 4 倍速。
 */
/** 目标骨架的局部 rest（第一次调用时抓，之后复用） */
function getTargetRest(root) {
  let m = root.userData.__restLocal;
  if (!m) {
    m = new Map();
    root.traverse((o) => { if (o.name) m.set(o.name, o.quaternion.clone()); });
    root.userData.__restLocal = m;
  }
  return m;
}

/**
 * 加载「纯轨道 JSON」动作（由 FBX 离线转换而来）。
 * 轨道是 Mixamo 骨骼名，这里按别名表重定向到 Tripo 骨架：
 *     target = tRest · (sRest⁻¹ · anim)
 * JSON 里带了源骨架每根骨骼的 rest 四元数，所以运行时不需要源模型。
 */
export async function loadClipJSON(binder, url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('loadClipJSON ' + res.status + ' ' + url);
  const data = await res.json();

  const tMap = new Map();
  binder.root.traverse((o) => { if (o.name) tMap.set(o.name, o); });
  const rest = getTargetRest(binder.root);

  // raw：目标骨架和动作文件是同一套命名（都是 Mixamo），直接按名字放行，不做重定向
  const rawMap = opts.raw ? tMap : null;

  const qS = new THREE.Quaternion();
  const qD = new THREE.Quaternion();
  const tracks = [];

  for (const tr of data.tracks ?? []) {
    const dot = tr.n.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = tr.n.slice(0, dot);
    const prop = tr.n.slice(dot + 1);

    const t = rawMap ? rawMap.get(bone) : resolveTargetBone(tMap, bone);
    if (!t) continue;

    if (prop === 'quaternion' && rawMap) {
      tracks.push(new THREE.QuaternionKeyframeTrack(t.name + '.quaternion', tr.t, Float32Array.from(tr.v)));
      continue;
    }

    if (prop === 'quaternion') {
      const srcRest = data.rest?.[bone];
      if (!srcRest) continue;
      qS.fromArray(srcRest).invert();
      const qt = rest.get(t.name) ?? t.quaternion;
      const vals = new Float32Array(tr.v.length);
      for (let i = 0; i < tr.v.length; i += 4) {
        qD.fromArray(tr.v, i).premultiply(qS).premultiply(qt).normalize();
        qD.toArray(vals, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(t.name + '.quaternion', tr.t, vals));
    }
  }

  let clip = new THREE.AnimationClip(opts.name ?? data.name ?? 'clip', data.duration ?? 1, tracks);

  if (opts.slice === true) {
    const hit = findStrikeTime(clip);
    const a = Math.max(0, hit - 0.32);
    const b = Math.min(clip.duration, hit + 0.52);
    if (b - a > 0.2) clip = sliceClip(clip, a * 60, b * 60, 60);
    clip.name = opts.name ?? data.name ?? 'clip';
  }

  binder.clips.set(clip.name, clip);
  return clip;
}
export async function loadClipPack(binder, url, opts = {}) {
  if (!binder || !binder.loader) return 0;
  const g = await binder.loader.loadAsync(url);
  const byName = new Map((g.animations ?? []).map((c) => [c.name, c]));
  const auto = new Set(opts.autoSlice ?? []);
  let n = 0;

  for (const [target, srcName] of Object.entries(opts.map ?? {})) {
    const clip = byName.get(srcName);
    if (!clip) continue;
    // 动作文件里每根骨骼都带 translation/scale 轨道。它俩是「源骨架的骨头长度」，
    // 套到另一副骨架上会把手臂拉长、关节错位。只保留旋转，位移只留根骨和胯。
    let c = stripBoneTransforms(clip);
    if (auto.has(target)) {
      const t = findStrikeTime(clip);
      const a = Math.max(0, t - 0.32);
      const b = Math.min(clip.duration, t + 0.52);
      if (b - a > 0.2) c = sliceClip(clip, a * 60, b * 60, 60);
    }
    c.name = target;
    binder.clips.set(target, c);
    n++;
  }
  return n;
}
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
      // 统一用「局部增量」重定向：target = rest · (sourceRest⁻¹ · anim)。
      // 它对两侧 rest 的轴向差异不敏感；世界空间版本会把 Mixamo 绑定姿势里
      // 的 -90° 轴修正当成动作，导致整个人往前倒。
      const legCfg = LEG_ABDUCT_CLIPS[name] || {};
      clip = retargetClip(binder.root, g.scene, clip, {
        legAbduct: legCfg.leg ?? 0,
        calfAbduct: legCfg.calf ?? 0,
      });
      // 后退片段里其实是「两步」(实测一个循环 ≈1.86s)；原片 2.55s，循环点在相位中间，
      // 一播到底会看到姿势跳一下 = 用户说的「重播」。这里精确切一个循环，首尾同相，循环无跳变。
      if (name === 'Backstep') {
        // One step for the Boss; keep the full two-step loop for the player.
        binder.clips.set('BossBackstep', sliceClip(clip, 0, 56, 60));
        clip = sliceClip(clip, 0, Math.round(clip.duration * 60 * (1.86 / 2.55)), 60);
      }

      // 轻击三连击：三段素材先离线拼成一条连贯动作（接缝处姿势本来就一致），
      // 这里按原来的截断长度把它重新切成三段 → 接缝与重击三连击同样的处理方式。
      // 轻击四段连招：一条 4.00s 的连贯动作，按手速峰值切成四段
      //   峰值 0.26s / 0.74s / 1.58s / 2.42s，谷底 0.62 / 1.34 / 1.94，2.60s 之后是静止收尾
      if (name === 'LightCombo4') {
        const L1 = Math.round(0.62 * 60);   // 37
        const L2 = Math.round(1.34 * 60);   // 80
        const L3 = Math.round(1.94 * 60);   // 116
        const L4 = Math.round(2.60 * 60);   // 156
        const fullL4 = clip;
        // 源动作髋高整体下沉，四段各自补一点让脚贴地（实测校准值）
        binder.clips.set('LightCombo4_1', shiftClipHipsY(sliceClip(fullL4, 0,  L1, 60), -0.10));
        binder.clips.set('LightCombo4_2', shiftClipHipsY(sliceClip(fullL4, L1, L2, 60),  0.05));
        binder.clips.set('LightCombo4_3', shiftClipHipsY(sliceClip(fullL4, L2, L3, 60),  0.55));
        binder.clips.set('LightCombo4_4', shiftClipHipsY(sliceClip(fullL4, L3, L4, 60),  1.23));
      }

      if (name === 'LightCombo') {
        const C1 = 90, C2 = 90 + 92, C3 = 90 + 92 + 118;   // 每段都切到「招式挥完(95% 扫角)」之后
        const fullL = clip;
        binder.clips.set('LightCombo1', sliceClip(fullL, 0, C1, 60));
        binder.clips.set('LightCombo2', sliceClip(fullL, C1, C2, 60));
        binder.clips.set('LightCombo3', sliceClip(fullL, C2, C3, 60));
      }

      if (name === 'HeavyCombo') {
        const CUT1 = Math.round(0.50 * 60);   // 第 1 段 0.00–0.50s
        const CUT2 = Math.round(1.05 * 60);   // 第 2 段 0.50–1.05s
        const CUT3 = Math.round(1.70 * 60);   // 第 3 段 1.05–1.70s
        const full = clip;
        // 三段各自校准髋高：源动作髋高与本角色身高不匹配，逐段修到脚贴地
        binder.clips.set('HeavyCombo1', shiftClipHipsY(sliceClip(full, 0, CUT1, 60), -0.13));
        binder.clips.set('HeavyCombo2', shiftClipHipsY(sliceClip(full, CUT1, CUT2, 60), -0.12));
        binder.clips.set('HeavyCombo3', shiftClipHipsY(sliceClip(full, CUT2, CUT3, 60), 0.08));
      }

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
  // 上半身用 Walking（=慢跑）的手臂：肘部弯、手在身前，不会「外张下垂」。
  // 不要用 Idle —— 新模型的 Idle 手臂是摊开下垂的（实测两手间距 35.8cm、手高 1.03m），
  // 拿来当后退的上半身会很难看；Running 是 15.4cm / 1.18m。
  const walkUp = binder.clips.get('Walking') || binder.clips.get('Running');
  const backLo = binder.clips.get('WalkBack');
  if (walkUp && backLo) {
    // 倒退走时躯干总共前倾 25°，三节脊椎各分 1/3（8.33°）。
    // 用度写清楚，别再算弧度。
    // lean 取负 = 躯干略前倾；+25° 会把上半身压得往后仰，手臂看起来「抡到身后」。
    // -15° 实测：手相对髋 −3.1 cm（自然下垂），头高 1.017 m
    let backFull = blendUpperLower(walkUp, backLo, 'WalkBackFull', { lean: THREE.MathUtils.degToRad(-15) });
    // 手臂单独换成 Idle 的「外张下垂」姿态（躯干仍用慢跑上半身 + 25° 前倾）
    const idleArms = binder.clips.get('Idle');
    if (idleArms) backFull = swapArmTracks(backFull, idleArms);
    const armCount = backFull.tracks.filter((tr) => ARM_TRACK_RE.test(tr.name.slice(0, tr.name.lastIndexOf('.')))).length;
    console.log('[anim-pack] WalkBackFull 手臂轨道:', armCount, ' 两条腿脚距由 LEG_ABDUCT_CLIPS 决定');
    binder.clips.set('WalkBackFull', backFull);
  }

  // 静止格挡 = 站姿：身体/腿用 Idle，手臂用 Blocking 的举盾姿势
  {
    const idleClip = binder.clips.get('Idle');
    const blockClip = binder.clips.get('Blocking');
    if (idleClip && blockClip) {
      binder.clips.set('BlockStance', swapArmTracks(idleClip, blockClip));
      // 站姿格挡（推荐）：保留 Blocking 的上半身/手臂/剑，只把腿换成待机的站姿
      const blockUpName = new URLSearchParams(location.search).get('blockup') || 'BlockingUp';
      const blockUp = binder.clips.get(blockUpName) || blockClip;
      binder.clips.set('BlockStand', swapLowerTracks(blockUp, idleClip));   // Idle 的髋+腿（站姿、脚贴地）+ Blocking 的脊柱/手臂
    }
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
  const hand = findHand(root);
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
  const hand = findHand(binder.root);
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

  // ★ 缩放基准必须是「武器真正的父级」= 手骨的世界缩放，不是场景根。
  //   FBX→GLB 的模型常在中间插一层 100× 的 model / armature 节点，
  //   用 binder.root 量会小 100 倍：武器变成几十上百米，握点（palmOffset/sf）也跟着飞出去几米。
  hand.updateWorldMatrix(true, false);
  const ws = new THREE.Vector3();
  hand.getWorldScale(ws);
  const sf = ws.y > 1e-4 ? ws.y : 1;
  const targetBoneSpace = (opts.length ?? 1.0) / sf;
  const bladeLen = targetBoneSpace;   // 归一化后的刃长（本地单位），剑轨采样用
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

  /**
   * 按「世界尺寸」闭环校正。
   * 上面那套推导依赖手骨缩放估得准；真机上一旦估偏（父级多一层 100× 节点、
   * 或者 mixer 还没跑第一帧），武器就会大得离谱。这里直接量世界包围盒迭代收敛，
   * 最多 3 次、误差 < 2%。
   */
  function normalizeWorldLength() {
    const targetLen = opts.length ?? 1.0;
    if (!(targetLen > 0)) return 0;
    let cur = 0;
    for (let pass = 0; pass < 3; pass++) {
      outer.updateWorldMatrix(true, true);
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      cur = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(cur) || cur < 1e-6) return 0;
      const ratio = targetLen / cur;
      if (Math.abs(ratio - 1) < 0.02) break;
      outer.scale.multiplyScalar(ratio);
      realign();                 // 缩放会带偏握点，重新钉回掌心
    }
    return cur;
  }
  normalizeWorldLength();

  /** 当前武器的世界长度（米），调参面板/控制台排查用 */
  function measureWorldLength() {
    outer.updateWorldMatrix(true, true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    return +Math.max(size.x, size.y, size.z).toFixed(2);
  }

  /** 沿长轴挪握点：0 = 柄端，1 = 刃端（镰刀/长柄武器常要握在中段） */
  function setGripShift(s) {
    gripShift = Math.min(1, Math.max(0, s));
    gripAxisValue = gripEndValue + gripDir * gripShift * axisLen;
    realign();
  }

  // 暴露给调参面板 / 控制台：改完角度后调 realign()，柄会重新钉回掌心
  outer.userData.weapon = {
    realign, rollGroup, target, setGripShift, getGripShift: () => gripShift,
    normalizeWorldLength, measureWorldLength,
  };
  outer.userData.weaponLength = bladeLen;   // 刃长（本地单位），剑轨采样用
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
  // FBX→GLB 的模型骨骼尺度可能和网格差很远，再按骨骼校一次（武器挂载之前）
  if (opts.boneFit) binder.fitToHeightBones(opts.targetHeight);
  if (actor.isBoss) {
    binder.restRootY = binder.root.position.y;
    binder.solePoint = new THREE.Vector3();
    binder.solePatches = collectSoleVertices(binder.root);
  }

  // 武器是附加物：加载失败不能把整个 bindModel 拖挂 ——
  // 那样 Promise.all 会 reject，window.__dbg 都挂不上，整个 demo 停摆。
  if (opts.weaponModel) {
    try {
      const weapon = await attachWeaponModel(binder, opts.weaponModel, opts.weaponOpts ?? {});
      if (weapon) actor.weapon = weapon;   // 供「拖刀」等状态切换用
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
