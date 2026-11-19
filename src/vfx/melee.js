// ─────────────────────────────────────────────────────────────
//  近战武器特效 —— 纯 three.js 程序化实现，零外部资源
//
//  设计原则（和 frame-data.js 一致）：特效只是「判定帧的视觉回声」，
//  不参与任何战斗逻辑，删掉整个文件游戏照样能跑。
//
//  · swingFromActor(actor, move)  刀光弧：判定帧第一帧开火，扫过 active 帧
//  · hit(attacker, defender, hb)  命中火花 + 闪光（金属感，暖色）
//  · guard(actor)                 格挡火花（冷色、量少、无冲击环）
//  · parry(actor)                 弹反：白色闪光 + 冲击环 + 爆量火花
//  · update(dt)                   真实秒推进；命中冻结时由调用方传 0 来冻住
//
//  调参：VFX_CFG 已挂到 lil-gui「近战特效」文件夹
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { BladeTrail } from './blade-trail.js';
import { guardFromAO } from './ao-guard.js';

// free_slash_vfx 的月牙刀光贴图（作为剑轨遮罩）
let _slashMap = null;
function slashMap() {
  if (_slashMap !== null) return _slashMap || null;
  if (typeof document === 'undefined') return (_slashMap = false);
  _slashMap = new THREE.TextureLoader().load('assets/vfx/Slash_Noise_Slash_Noise.png');
  _slashMap.colorSpace = THREE.SRGBColorSpace;
  _slashMap.wrapS = THREE.ClampToEdgeWrapping;
  _slashMap.wrapT = THREE.ClampToEdgeWrapping;
  return _slashMap;
}

export const VFX_CFG = {
  enabled: true,
  intensity: 1.0,     // 全局亮度/数量倍率
  slashLife: 1.0,     // 刀光时长倍率（越大越「拖」）
  sparkCount: 18,     // 单次命中基础火花数（重击 ×1.6）
  telegraph: true,         // Boss 起手预警（起手帧手部红光）
  telegraphBossOnly: true, // 只给 Boss 挂；关掉的话玩家出招也会有
  telegraphStart: 0.35,    // 起手第一帧就有的亮度（0 = 从全黑慢慢亮）

  // ── 真实剑轨（跟刃采样）──────────────────────────────
  arc: false,              // 旧的固定弧光（已被真实剑轨取代，留着可对比）
  trail: true,             // 剑轨总开关
  trailLife: 0.26,         // 采样存活秒数：越长拖尾越长
  trailIntensity: 1.55,    // 亮度倍率
  trailBoss: true,         // Boss 也铺

  // 玩家剑轨配色：取自 free_slash_vfx 的 "Slash World Var 2" 材质
  //   _Color  r0.04 g0.00 b0.47（深紫） / 高光 r0.24 g0.00 b1.00（紫罗兰）
  trailMap: true,          // 用 free_slash_vfx 的月牙贴图（关掉=纯色光带）
  trailMapTile: 1.9,       // 贴图沿时间方向平铺次数（越大月牙越密）
  trailShift: -0.1,         // 光带沿刃身微调（负值 = 往护手方向收；-0.1 = 略收回，贴合剑身内侧）
  trailPurple: true,       // 用 Unity 包里的紫色配色（关掉=纯白）
  trailCore: '#9d5bff',    // 刃尖核心色（亮紫）
  trailEdge: '#3a08b8',    // 刃根边缘色（深紫）
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (a, b) => a + Math.random() * (b - a);

// ── 程序化贴图：不依赖任何外部图片，断网也能跑 ───────────────
let _tex = null;
function tex() {
  if (_tex !== null) return _tex;
  // 无 DOM（headless 测试）时退化为无贴图，仍然能跑
  if (typeof document === 'undefined') return (_tex = {});
  _tex = { spark: radialTexture(64, 0.62), flash: radialTexture(128, 0.28) };
  return _tex;
}

function radialTexture(size, core) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(core * 0.6, 'rgba(255,255,255,0.82)');
  g.addColorStop(core, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── 刀光弧几何：在「本地 +Z 为前方」的空间里铺一条月牙带 ──────
function makeArcGeometry(shape, radius, opts = {}) {
  const seg = 56;
  const inner = opts.inner ?? 0.55;
  const total = opts.angle ?? 2.0;
  const half = total / 2;
  const tilt = opts.tilt ?? 0;
  const reverse = !!opts.reverse;

  const pos = [];
  const uvs = [];
  const idx = [];

  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = -half + t * total;
    let ox, oy, oz, ix, iy, iz;

    if (shape === 'vertical') {
      // 竖劈：以肩为圆心，从上往下扫
      const s = Math.sin(a), c = Math.cos(a);
      ox = 0.10; oy = s * radius; oz = c * radius;
      ix = 0.10; iy = s * radius * inner; iz = c * radius * inner;
    } else if (shape === 'thrust') {
      // 突刺：窄扇形 + 长半径，视觉上是一条「锥」
      const s = Math.sin(a), c = Math.cos(a);
      ox = s * radius; oy = (t - 0.5) * tilt * radius; oz = c * radius;
      ix = s * radius * inner; iy = oy * 0.4; iz = c * radius * inner;
    } else {
      // 横扫：水平面内的一刀，带一点斜度（纯水平会显得像圆规）
      const s = Math.sin(a), c = Math.cos(a);
      oy = (t - 0.5) * tilt * radius;
      ox = s * radius; oz = c * radius;
      ix = s * radius * inner; iy = oy * 0.75; iz = c * radius * inner;
    }

    pos.push(ox, oy, oz, ix, iy, iz);
    const u = reverse ? 1 - t : t;
    uvs.push(u, 1, u, 0);
  }

  for (let i = 0; i < seg; i++) {
    const a0 = i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
    idx.push(a0, b0, a1, b0, b1, a1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

const ARC_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ARC_FRAG = `
uniform float uProgress;
uniform float uFade;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float head = uProgress;

  // 只显示已经扫过的部分
  if (u > head) discard;

  float d = head - u;                 // 距离刀锋的进度
  float lead = exp(-d * 7.0);         // 刀锋白热
  float body = (1.0 - smoothstep(0.0, 0.85, d)) * 0.55;

  // 厚度方向柔边（内缘更硬，外缘羽化）
  float edge = smoothstep(0.0, 0.22, v) * (1.0 - smoothstep(0.72, 1.0, v));

  // 两端收尖，避免出现「半圆环」
  float taper = mix(0.28, 1.0, sin(clamp(u, 0.001, 0.999) * 3.14159265));

  // 一点高频噪声，让刀光像光而不是塑料板
  float grain = 0.86 + 0.14 * sin(u * 120.0 + v * 18.0);

  float a = (lead * 0.92 + body) * edge * taper * grain * uFade;
  if (a < 0.004) discard;

  vec3 col = mix(uColorB, uColorA, clamp(lead * 1.25, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}`;

function makeArcMaterial(colorA, colorB) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uProgress: { value: 0 },
      uFade: { value: 1 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
    },
    vertexShader: ARC_VERT,
    fragmentShader: ARC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ═════════════════════════════════════════════════════════════
export class MeleeVFX {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.getCamera = opts.getCamera ?? (() => null);
    this.effects = [];
    // 真实剑轨：玩家 / Boss 各一条，按「刃根→刃尖」逐帧采样
    this.trails = {
      player: new BladeTrail(scene, { life: VFX_CFG.trailLife, maxSamples: 72 }),
      boss: new BladeTrail(scene, { life: VFX_CFG.trailLife, maxSamples: 72 }),
    };
    this.trails.boss.setColors(0xfff4e2, 0xffb066);
  }

  get activeCount() { return this.effects.length; }

  /**
   * 每帧喂一次剑轨。
   * @param key 'player' | 'boss'
   * @param base 刃根世界坐标
   * @param tip  刃尖世界坐标
   * @param dt   秒
   * @param swinging 是否正在挥剑；false 时只让旧轨迹自然消退
   */
  feedTrail(key, base, tip, dt, swinging = true) {
    const trail = this.trails && this.trails[key];
    if (!trail) return;
    if (!VFX_CFG.enabled || !VFX_CFG.trail) { trail.clear(); return; }
    if (key === 'boss' && !VFX_CFG.trailBoss) { trail.release(dt); return; }
    trail.life = Math.max(0.05, VFX_CFG.trailLife);
    trail.setMap(VFX_CFG.trailMap ? slashMap() : null, VFX_CFG.trailMapTile || 1);
    if (key === 'player') {
      if (VFX_CFG.trailPurple) trail.setColors(VFX_CFG.trailCore || '#9d5bff', VFX_CFG.trailEdge || '#3a08b8');
      else trail.setColors('#ffffff', '#dfefff');
    }
    trail.material.uniforms.uIntensity.value = clamp(VFX_CFG.intensity * VFX_CFG.trailIntensity, 0, 4);
    if (swinging && base && tip) trail.push(base, tip, dt);
    else trail.release(dt);
  }

  // ── 刀光 ───────────────────────────────────────────────────
  /**
   * @param actor 施法角色（需要 pos / yaw / scale / isBoss）
   * @param move  MOVES 里的一条招式（需要 hitbox / active / swing）
   */
  swingFromActor(actor, move) {
    if (!VFX_CFG.arc) return null;
    if (!VFX_CFG.enabled || !actor || !move || !move.hitbox || move.active <= 0) return null;

    const scale = actor.scale ?? 1;
    const hb = move.hitbox;
    const shape = move.swing === 'vertical' ? 'vertical'
      : move.swing === 'thrust' ? 'thrust' : 'horizontal';
    const isBoss = !!actor.isBoss;

    const radius = clamp((hb.offset + hb.radius) * scale * 1.12, 0.85, 6.5);
    const yBase = (hb.yMin + hb.yMax) * 0.5 * scale;

    const colorA = isBoss ? 0xffdcb4 : 0xffffff;
    const colorB = isBoss ? 0xff6a2b : 0x8fd3ff;

    const angle = shape === 'vertical' ? 1.85 : shape === 'thrust' ? 0.55 : 2.0;
    const inner = shape === 'vertical' ? 0.52 : shape === 'thrust' ? 0.10 : 0.58;
    const tilt = shape === 'horizontal' ? (isBoss ? 0.26 : 0.18) : shape === 'thrust' ? 0.05 : 0;

    const geo = makeArcGeometry(shape, radius, { angle, inner, tilt, reverse: isBoss });
    const mat = makeArcMaterial(colorA, colorB);

    const mesh = guardFromAO(new THREE.Mesh(geo, mat), mat);
    mesh.position.copy(actor.pos);
    mesh.position.y += yBase;
    mesh.rotation.y = actor.yaw;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.scene.add(mesh);

    // 生命周期贴着判定窗口：active 6 帧 → 0.10s；再给一点余韵
    const baseLife = clamp((move.active / 60) * 1.15 + 0.06, 0.11, 0.34);
    const life = Math.max(0.06, baseLife * VFX_CFG.slashLife);

    let age = 0;
    const effect = {
      update: (dt) => {
        age += dt;
        const t = clamp(age / life, 0, 1);
        // 挥砍是「甩」出去的：前段快、后段慢
        const p = 1 - Math.pow(1 - t, 2.4);
        mat.uniforms.uProgress.value = p;
        mat.uniforms.uFade.value = (1 - smoothstep(0.52, 1, t)) * clamp(VFX_CFG.intensity, 0, 2);
        const s = 1 + 0.10 * t;
        mesh.scale.set(s, s, s);
        if (t >= 1) { this._drop(mesh); geo.dispose(); mat.dispose(); return false; }
        return true;
      },
      dispose: () => { this._drop(mesh); geo.dispose(); mat.dispose(); },
    };
    this.effects.push(effect);
    return effect;
  }

  // ── 命中火花 ───────────────────────────────────────────────
  hit(attacker, defender, hitbox) {
    if (!VFX_CFG.enabled || !hitbox || !defender) return;

    // 接触点：判定圆朝受击者方向推一点，避免火花在身体里
    const p = new THREE.Vector3().copy(hitbox.center);
    p.y = clamp((hitbox.yMin + hitbox.yMax) * 0.5, 0.35, 2.6);

    const dx = defender.pos.x - p.x;
    const dz = defender.pos.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    p.x += nx * hitbox.radius * 0.5;
    p.z += nz * hitbox.radius * 0.5;

    const size = clamp((defender.scale ?? 1) * 0.95, 0.85, 2.6);
    const heavy = (attacker?.move?.damage ?? 0) >= 200;

    this._burst(p, { size, heavy, dir: new THREE.Vector3(nx, 0.2, nz) });
    this._flash(p, {
      size: size * (heavy ? 1.55 : 1.0),
      color: 0xfff1d6,
      life: heavy ? 0.12 : 0.08,
    });
  }

  // ── 格挡（普通）：冷色小火花，没有冲击环 ───────────────────
  guard(actor) {
    if (!VFX_CFG.enabled || !actor) return;
    const p = this._shieldPoint(actor);
    this._burst(p, {
      size: 0.8 * (actor.scale ?? 1),
      heavy: false,
      dir: new THREE.Vector3(Math.sin(actor.yaw), 0.4, Math.cos(actor.yaw)),
      color: 0xbfe6ff,
      count: 10,
    });
    this._flash(p, { size: 0.8 * (actor.scale ?? 1), color: 0xd8f0ff, life: 0.07 });
  }

  // ── 弹反：白闪 + 冲击环 + 爆量火花 ─────────────────────────
  parry(actor) {
    if (!VFX_CFG.enabled || !actor) return;
    const scale = actor.scale ?? 1;
    const p = this._shieldPoint(actor);

    this._flash(p, { size: 1.7 * scale, color: 0xffffff, life: 0.12 });
    this._burst(p, {
      size: 1.2 * scale,
      heavy: true,
      dir: new THREE.Vector3(Math.sin(actor.yaw), 0.35, Math.cos(actor.yaw)),
      color: 0xfff6d8,
      count: 30,
    });
    this._ring(p, {
      scale,
      normal: new THREE.Vector3(Math.sin(actor.yaw), 0.15, Math.cos(actor.yaw)).normalize(),
      from: 0.18,
      to: 1.35,
      life: 0.20,
      color: 0xffffff,
    });
    // 第二圈慢一点，做出「扩散」的层次
    this._ring(p, {
      scale,
      normal: new THREE.Vector3(Math.sin(actor.yaw), 0.15, Math.cos(actor.yaw)).normalize(),
      from: 0.12,
      to: 0.9,
      life: 0.30,
      color: 0xffd9a0,
    });
  }

  // ── 生命周期 ───────────────────────────────────────────────
  // ── Boss 起手预警：手部红光 ────────────────────────────────
  /**
   * 从「起手帧」第一帧就亮（telegraphStart 是起始亮度），越接近挥出越亮，
   * 而且挂在右手/武器握把上 —— 抬手、举剑、蓄力都跟着骨骼走，不用算世界坐标。
   * 判定帧一到或被打断，50ms 内熄灭，交给刀光接管。
   */
  telegraph(actor, move) {
    if (!VFX_CFG.telegraph || !actor || !move || !move.hitbox || move.active <= 0) return null;

    const anchor = this._handAnchor(actor);
    if (!anchor) return null;

    // 注意：fighter 的 group 已经按 actor.scale 缩放过，这里一律用「局部单位」
    const layerDefs = [
      { size: 0.30, color: 0xff7a4a, opacity: 0.90 },  // 芯：亮到发白
      { size: 0.66, color: 0xff3a10, opacity: 0.46 },  // 焰
      { size: 1.30, color: 0xc01000, opacity: 0.20 },  // 晕：把空气也染红
    ];

    const sprites = [];
    const mats = [];
    const base = anchor.offset;

    for (const L of layerDefs) {
      const mat = new THREE.SpriteMaterial({
        map: tex().flash ?? null,
        color: L.color,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sp = guardFromAO(new THREE.Sprite(mat), mat);
      sp.position.copy(base);
      sp.scale.setScalar(L.size);
      sp.renderOrder = 6;
      anchor.obj.add(sp);
      sprites.push(sp);
      mats.push(mat);
    }

    // 几粒往上飘的火星：红光要有热源，不然像贴纸
    const embers = [];
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex().spark ?? null,
        color: 0xff9a5a,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sp = guardFromAO(new THREE.Sprite(mat), mat);
      sp.scale.setScalar(rand(0.04, 0.085));
      sp.position.copy(base).add(new THREE.Vector3(
        rand(-0.08, 0.08), rand(-0.06, 0.05), rand(-0.08, 0.08),
      ));
      sp.renderOrder = 6;
      anchor.obj.add(sp);
      sprites.push(sp);
      mats.push(mat);
      embers.push({ sp, mat, t: rand(0, 1), speed: rand(0.35, 0.8) });
    }

    const startBrightness = clamp(VFX_CFG.telegraphStart, 0, 1);
    let out = 0;
    let age = 0;
    const token = {};

    const kill = () => {
      for (const sp of sprites) anchor.obj.remove(sp);
      for (const m of mats) m.dispose();
    };

    const effect = {
      update: (dt) => {
        age += dt;
        const live = actor.__vfxTele === token
          && actor.move === move
          && actor.frame < move.startup
          && actor.state !== 'dead';

        if (live) {
          // 起手第一帧就有 startBrightness，之后线性涨到 1（挥出的瞬间最亮）
          const p = clamp(actor.frame / Math.max(1, move.startup), 0, 1);
          const target = startBrightness + (1 - startBrightness) * p;
          out += (target - out) * Math.min(1, dt * 16);
        } else {
          out -= dt * 20;                       // ~50ms 熄灭
          if (out <= 0.002) { kill(); return false; }
        }

        const k = clamp(VFX_CFG.intensity, 0, 2);
        // 火焰不是恒定的：两个不同频率的正弦叠出「呼吸」
        const flick = 0.84 + 0.10 * Math.sin(age * 31) + 0.06 * Math.sin(age * 79);

        for (let i = 0; i < layerDefs.length; i++) {
          mats[i].opacity = layerDefs[i].opacity * out * flick * k;
          sprites[i].scale.setScalar(layerDefs[i].size * (0.7 + 0.6 * out));
        }

        for (const e of embers) {
          e.t += dt * e.speed;
          if (e.t >= 1) {
            e.t = 0;
            e.sp.position.copy(base).add(new THREE.Vector3(
              rand(-0.08, 0.08), rand(-0.06, 0.04), rand(-0.08, 0.08),
            ));
          }
          e.sp.position.y += dt * e.speed * 0.45;
          e.mat.opacity = Math.sin(e.t * Math.PI) * 0.85 * out * k;
        }

        return true;
      },
      dispose: kill,
    };

    actor.__vfxTele = token;
    this.effects.push(effect);
    return effect;
  }

  /** 找右手：灰盒用武器（把光放在握把上），真模型找 hand 骨骼 */
  _handAnchor(actor) {
    const m = actor?.mesh;
    const weapon = m?.weapon;
    if (weapon && weapon.isObject3D) {
      const g = weapon.geometry;
      if (g && typeof g.computeBoundingBox === 'function' && !g.boundingBox) g.computeBoundingBox();
      const z0 = g?.boundingBox ? g.boundingBox.min.z : 0;
      return { obj: weapon, offset: new THREE.Vector3(0, 0, z0 * 0.85) };
    }
    const root = actor?.binder?.root;
    if (root) {
      const hand = this._findBone(root, /righthand|right_hand|hand_r|handr/i);
      if (hand) return { obj: hand, offset: new THREE.Vector3() };
    }
    return null;
  }

  _findBone(root, re) {
    let found = null;
    if (typeof root.traverse !== 'function') return null;
    root.traverse((o) => {
      if (!found && o.isBone && re.test(o.name ?? '')) found = o;
    });
    return found;
  }
  update(dt) {     if (!(dt > 0)) return;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].update(dt)) this.effects.splice(i, 1);
    }
  }

  clear() {
    for (const e of this.effects) e.dispose();
    this.effects.length = 0;
  }

  dispose() {
    this.clear();
  }

  // ── 内部构件 ───────────────────────────────────────────────
  _drop(obj) {
    this.scene.remove(obj);
  }

  _shieldPoint(actor) {
    const scale = actor.scale ?? 1;
    return new THREE.Vector3(
      actor.pos.x + Math.sin(actor.yaw) * 0.55 * scale,
      1.15 * scale,
      actor.pos.z + Math.cos(actor.yaw) * 0.55 * scale,
    );
  }

  /** 一簇火星：Points + 逐粒子速度/重力 */
  _burst(point, opts = {}) {
    const size = opts.size ?? 1;
    const heavy = !!opts.heavy;
    const baseCount = opts.count ?? VFX_CFG.sparkCount;
    const count = Math.max(0, Math.round(baseCount * (heavy ? 1.6 : 1) * clamp(VFX_CFG.intensity, 0, 2)));
    if (count === 0) return;

    const dir = (opts.dir ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    const base = new THREE.Color(opts.color ?? 0xffcf8a);
    const hot = new THREE.Color(0xffffff);

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = [];

    for (let i = 0; i < count; i++) {
      pos[i * 3] = point.x;
      pos[i * 3 + 1] = point.y;
      pos[i * 3 + 2] = point.z;

      const v = new THREE.Vector3(rand(-1, 1), rand(-0.15, 0.95), rand(-1, 1))
        .normalize().addScaledVector(dir, 1.0).normalize();
      const speed = rand(1.6, 5.4) * size * (heavy ? 1.35 : 1);
      vel.push(v.multiplyScalar(speed));

      const c = base.clone().lerp(hot, rand(0, 0.65));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.085 * size * (heavy ? 1.35 : 1),
      map: tex().spark ?? null,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const pts = guardFromAO(new THREE.Points(geo, mat), mat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    this.scene.add(pts);

    const life = rand(0.20, 0.36);
    let age = 0;

    const effect = {
      update: (dt) => {
        age += dt;
        const t = clamp(age / life, 0, 1);
        const arr = geo.attributes.position.array;
        for (let i = 0; i < count; i++) {
          const v = vel[i];
          v.y -= 13.5 * dt;
          v.multiplyScalar(1 - 1.8 * dt);
          arr[i * 3] += v.x * dt;
          arr[i * 3 + 1] += v.y * dt;
          arr[i * 3 + 2] += v.z * dt;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = Math.pow(1 - t, 1.4);
        if (t >= 1) { this._drop(pts); geo.dispose(); mat.dispose(); return false; }
        return true;
      },
      dispose: () => { this._drop(pts); geo.dispose(); mat.dispose(); },
    };
    this.effects.push(effect);
  }

  /** 命中闪光：一个加色 Sprite，快速放大后消失 */
  _flash(point, opts = {}) {
    const size = opts.size ?? 1;
    const life = opts.life ?? 0.09;
    const mat = new THREE.SpriteMaterial({
      map: tex().flash ?? null,
      color: opts.color ?? 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(point);
    sp.scale.setScalar(0.12 * size);
    sp.renderOrder = 5;
    this.scene.add(sp);

    let age = 0;
    const effect = {
      update: (dt) => {
        age += dt;
        const t = clamp(age / life, 0, 1);
        sp.scale.setScalar((0.45 + 1.65 * t) * size);
        mat.opacity = Math.pow(1 - t, 2.2) * clamp(VFX_CFG.intensity, 0, 2);
        if (t >= 1) { this._drop(sp); mat.dispose(); return false; }
        return true;
      },
      dispose: () => { this._drop(sp); mat.dispose(); },
    };
    this.effects.push(effect);
  }

  /** 冲击环：贴着法线朝外的圆环，向外扩 + 淡出 */
  _ring(point, opts = {}) {
    const scale = opts.scale ?? 1;
    const life = opts.life ?? 0.2;
    const normal = (opts.normal ?? new THREE.Vector3(0, 1, 0)).clone().normalize();

    const geo = new THREE.RingGeometry(0.42, 0.52, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: opts.color ?? 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = guardFromAO(new THREE.Mesh(geo, mat), mat);
    mesh.position.copy(point);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.scene.add(mesh);

    const from = (opts.from ?? 0.2) * scale;
    const to = (opts.to ?? 1.2) * scale;
    let age = 0;

    const effect = {
      update: (dt) => {
        age += dt;
        const t = clamp(age / life, 0, 1);
        const s = from + (to - from) * (1 - Math.pow(1 - t, 2.0));
        mesh.scale.set(s, s, s);
        mat.opacity = Math.pow(1 - t, 1.6) * clamp(VFX_CFG.intensity, 0, 2);
        if (t >= 1) { this._drop(mesh); geo.dispose(); mat.dispose(); return false; }
        return true;
      },
      dispose: () => { this._drop(mesh); geo.dispose(); mat.dispose(); },
    };
    this.effects.push(effect);
  }
}
