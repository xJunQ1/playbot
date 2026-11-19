import * as THREE from 'three';
import GUI from 'lil-gui';
import { CFG, MOVES, LIMITS, totalFrames, motionAt, dumpJSON, moveIssues, validateAll } from './frame-data.js';
import { makeFighter, createViz, placeViz, applyPose } from './graybox.js';
import { buildStage, updateStage, ARENA_R } from './arena/stage.js';
import { createSettings } from './settings.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { poseFor } from './pose.js';
import { FootIK } from './footik.js';
import { MeleeVFX, VFX_CFG } from './vfx/melee.js';
import { guardFromAO } from './vfx/ao-guard.js';
import { GroundScratch } from './vfx/scratch.js';

// ═══════════════════════════════════════════════════════════════
//  0.0 调参持久化（帧数据 / 全局 CFG / 特效）
//  · 服务端：GET/POST /api/tuning → data/tuning.json（serve.mjs 提供）
//  · 本地兜底：localStorage，服务端不可用也不会丢
//  · 调完自动保存（1s 内检测到变化就写盘），重启浏览器/Electron 后自动回填
// ═══════════════════════════════════════════════════════════════
const TUNING_KEY = 'souls-tuning-v1';
// 招式表的「代码版本指纹」：只要 frame-data.js 里的招式数值改过，旧存档里的招式数值就自动作废，
// 避免"改了代码但存档把旧数字盖回去"这种坑
// 特效参数也做同样的指纹校验：代码里改了默认值，旧存档里的 vfx 就不再覆盖
const VFX_REV = (() => {
  let h = 2166136261;
  const s = JSON.stringify(VFX_CFG);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
})();

const MOVES_REV = (() => {
  let h = 2166136261;
  const s = JSON.stringify(MOVES);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
})();
const MOVE_FIELDS = ['startup', 'active', 'recovery', 'cancelFrom', 'damage', 'poise', 'hitstun', 'stamina'];
// 这些是「运行时开关」而不是调参：绝对不能存档，否则暂停/调试状态会被固化，
// 下次启动就是全场景静止 + 输入没反应的假死状态
const TUNING_SKIP = new Set(['paused', 'showHitbox', 'timeScale']);

function tuningSnapshot() {
  const moves = {};
  for (const [id, m] of Object.entries(MOVES)) {
    const o = {};
    for (const k of MOVE_FIELDS) if (typeof m[k] === 'number') o[k] = m[k];
    moves[id] = o;
  }
  const pick = (src) => {
    const o = {};
    for (const [k, v] of Object.entries(src || {})) {
      if (TUNING_SKIP.has(k)) continue;
      if (typeof v === 'number' || typeof v === 'boolean') o[k] = v;
    }
    return o;
  };
  return { v: 1, rev: MOVES_REV, vfxRev: VFX_REV, moves, cfg: pick(CFG), vfx: pick(VFX_CFG) };
}

function tuningApply(data) {
  if (!data || typeof data !== 'object') return false;
  let hit = 0;
  for (const [id, o] of Object.entries(data.moves || {})) {
    const m = MOVES[id];
    if (!m || !o) continue;
    for (const k of MOVE_FIELDS) if (typeof o[k] === 'number') { m[k] = o[k]; hit++; }
  }
  for (const [k, v] of Object.entries(data.cfg || {})) {
    if (TUNING_SKIP.has(k)) continue;
    if (k in CFG && (typeof v === 'number' || typeof v === 'boolean')) { CFG[k] = v; hit++; }
  }
  for (const [k, v] of Object.entries(data.vfx || {})) {
    if (k in VFX_CFG && (typeof v === 'number' || typeof v === 'boolean')) { VFX_CFG[k] = v; hit++; }
  }
  return hit > 0;
}

async function tuningLoad() {
  let data = null;
  try {
    const r = await fetch('/api/tuning', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && Object.keys(j).length) data = j;
    }
  } catch { /* 服务端没起来就用本地存档 */ }
  if (!data) {
    try { data = JSON.parse(localStorage.getItem(TUNING_KEY) || 'null'); } catch { data = null; }
  }
  // 没有 rev 字段的老存档（或 rev 对不上）= 招式数值不可信，整块丢弃
  const revOk = !data || !data.moves || data.rev === MOVES_REV;
  if (!revOk) {
    console.warn(`[tuning] 招式表代码已更新（rev ${data.rev} → ${MOVES_REV}），旧存档的招式数值作废，改用代码里的数字`);
  }
  const overrides = [];
  for (const [id, o] of Object.entries((revOk ? (data && data.moves) : null) || {})) {
    const m = MOVES[id];
    if (!m || !o) continue;
    for (const k of MOVE_FIELDS) {
      if (TUNING_SKIP.has(k)) continue;
      if (typeof o[k] === 'number' && o[k] !== m[k]) overrides.push(`${id}.${k}: ${m[k]} → ${o[k]}`);
    }
  }
  const vfxRevOk = !data || !data.vfx || !data.vfxRev || data.vfxRev === VFX_REV;
  if (!vfxRevOk) console.warn(`[tuning] 特效代码已更新（存档 vfxRev ${data.vfxRev ?? '无'} → 代码 ${VFX_REV}），旧存档的特效参数作废`);
  const ok = tuningApply(revOk ? (vfxRevOk ? data : { ...data, vfx: null }) : { ...data, moves: null, vfx: vfxRevOk ? data.vfx : null });
  if (overrides.length) {
    console.warn(`[tuning] 存档覆盖了 ${overrides.length} 个字段（面板里点「用代码默认值覆盖存档」可清掉）`);
    console.warn('[tuning] ' + overrides.slice(0, 8).join(' | '));
  }
  CFG.paused = false;   // 无论如何都以「未暂停」启动
  CFG.timeScale = 1;
  window.__tuningLoaded = ok;
  if (ok) console.log('[tuning] 已载入存档调参');
  return ok;
}

let __tuningSaving = false;
async function tuningSave(silent = true) {
  const snap = tuningSnapshot();
  const text = JSON.stringify(snap);
  try { localStorage.setItem(TUNING_KEY, text); } catch { /* 隐私模式忽略 */ }
  try {
    if (!__tuningSaving) {
      __tuningSaving = true;
      await fetch('/api/tuning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      if (!silent) console.log('[tuning] 已写入 data/tuning.json');
    }
  } catch { /* 离线也不影响本地存档 */ }
  finally { __tuningSaving = false; }
  window.__tuningSavedAt = Date.now();
}

async function tuningClear() {
  try { localStorage.removeItem(TUNING_KEY); } catch { /* 忽略 */ }
  try { await fetch('/api/tuning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* 忽略 */ }
}

await tuningLoad();   // 必须在建角色 / 建面板之前跑完

// 自动保存：值有变化就写盘（1s 轮询，比给每个滑条挂 onChange 稳）
let __tuningLast = JSON.stringify(tuningSnapshot());
setInterval(() => {
  const now = JSON.stringify(tuningSnapshot());
  if (now !== __tuningLast) { __tuningLast = now; tuningSave(); }
}, 1000);
addEventListener('beforeunload', () => { tuningSave(); });

// ═══════════════════════════════════════════════════════════════
//  0. 渲染基础设施
// ═══════════════════════════════════════════════════════════════
// 关掉 MSAA：集成显卡上 4x MSAA 几乎等于把像素成本翻倍；改在后期用 FXAA，画质接近、成本极低
const QSP = new URLSearchParams(location.search);
const PRECISION = QSP.get('prec') === 'high' ? 'highp' : 'mediump';
// 核显的片元单元对 highp 很敏感；mediump 在 1080p 下几乎看不出差别
const renderer = new THREE.WebGLRenderer({ antialias: false, precision: PRECISION, powerPreference: 'high-performance' });
// ── 画质开关（URL 参数）：?res=0.75 渲染倍率 / ?ao=0 关环境光遮蔽 / ?shadow=0 关阴影
const QS = new URLSearchParams(location.search);
const RES = Math.min(1.5, Math.max(0.5, parseFloat(QS.get('res') || '1')));
renderer.setPixelRatio(Math.min(devicePixelRatio, 2.0) * RES);
renderer.info.autoReset = false;   // 自己每帧重置，才能在渲染后读到当帧的 draw call
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = QS.get('shadow') !== '0';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 背景/雾跟着舞台的紫调走：原来是近黑色，舞台外的远景会被压成一片死黑
scene.background = new THREE.Color(0x191226);
scene.fog = new THREE.Fog(0x241a33, 70, 190);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1200);
camera.position.set(0, 6, 10);

// 擂台：和展示页共用 stage.js 里同一份美术（浮空要塞 · 猩红魔法竞技场）
const STAGE = buildStage(scene, { magicOpacity: 0.42 });

// 舞台里的「透明 / 镂空」装饰（红叶、藤蔓、裂纹贴花、法阵光带）不能进 GTAO 预通道：
// 那一遍会把它们当实心几何，镂空处就在墙上糊出一块块黑斑。
{
  let n = 0;
  const guarded = [];
  STAGE.root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.transparent || (m.alphaTest && m.alphaTest > 0) || m.blending === THREE.AdditiveBlending) {
        guardFromAO(o, m);
        guarded.push(o);
        n++;
      }
    }
  });
  if (n) console.log('[stage] 排除 AO 预通道的透明装饰:', n);
  window.__aoGuarded = guarded;   // 排查用：可临时恢复 onBeforeRender 对比
}
// 舞台贴图统一开到显卡支持的最大各向异性：细金线在斜视时才不会闪没
{
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  STAGE.root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) {
        const tex = m[key];
        if (tex && tex.anisotropy !== maxAniso) { tex.anisotropy = maxAniso; tex.needsUpdate = true; }
      }
    }
  });
  console.log('[stage] 贴图各向异性 →', maxAniso);
}

const ARENA = { half: STAGE.radius };   // 兼容旧引用，实际边界用圆形

// 近战特效（刀光 / 命中火花 / 弹反），纯程序化，不依赖外部资源
const vfx = new MeleeVFX(scene, { getCamera: () => camera });

// 拖刀划痕：贴地光带，寿命到了自动消失
const scratch = new GroundScratch(scene);   // 参数在 scratch.js 顶部统一调

// ── 后处理：只开环境光遮蔽。贴地视角下凹缝（栏杆之间、台阶、浮雕、柱础）压暗，
//   否则整个场地会像一张平面贴图。
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// AO 分辨率：默认跟随画布；?ao=half 时 AO 只渲半分辨率（核显上收益最大的一项）
const AO_HALF = QSP.get('ao') === 'half';
const gtao = new GTAOPass(scene, camera, AO_HALF ? innerWidth >> 1 : innerWidth, AO_HALF ? innerHeight >> 1 : innerHeight);
if (AO_HALF) {
  const baseSetSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => baseSetSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
}
gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({
  radius: 0.85, distanceExponent: 1.4, thickness: 1.6, scale: 0.95,
  samples: 8, distanceFallOff: 1.0, screenSpaceRadius: false,
});
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
composer.addPass(gtao);
// 画质开关：?ao=0 关掉环境光遮蔽（低配机建议关，这是最贵的一项）
if (location.search.includes('ao=0')) gtao.enabled = false;
// 泛光：法阵、火盆、刀光的高光溢出一层，配合锐化能提升“通透感”
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.18, 0.6, 0.85);
// 泛光暂不启用：UnrealBloomPass 与 GTAOPass 在这版 three 上冲突，整帧会变黑
// bloom.setSize(innerWidth, innerHeight);
// composer.addPass(bloom);

composer.addPass(new OutputPass());

// 锐化（unsharp mask，3x3）：把高频细节拉回来，抵消 FXAA/上采样带来的软
const SharpenShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    strength: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (strength <= 0.001) { gl_FragColor = c; return; }
      vec2 px = 1.0 / resolution;
      vec3 blur =
        texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)).rgb +
        texture2D(tDiffuse, vUv + vec2( px.x, 0.0)).rgb +
        texture2D(tDiffuse, vUv + vec2(0.0, -px.y)).rgb +
        texture2D(tDiffuse, vUv + vec2(0.0,  px.y)).rgb;
      blur *= 0.25;
      vec3 sharpened = c.rgb + (c.rgb - blur) * (strength * 3.0);
      gl_FragColor = vec4(clamp(sharpened, 0.0, 1.0), c.a);
    }
  `,
};
// FXAA：替代 MSAA 的抗锯齿，一个全屏 pass，成本远低于 4x MSAA
const fxaa = new ShaderPass(FXAAShader);
function syncFXAA() {
  const pr = renderer.getPixelRatio();
  fxaa.material.uniforms.resolution.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
}
syncFXAA();
composer.addPass(fxaa);

// SMAA：比 FXAA 保留更多细节，比 MSAA 便宜；和 FXAA 二选一
const smaa = new SMAAPass(innerWidth, innerHeight);
smaa.enabled = false;
composer.addPass(smaa);

// 锐化：放在 FXAA 之后，把被抗锯齿抹掉的细节补回来
const sharpen = new ShaderPass(SharpenShader);
function syncSharpen() {
  const pr = renderer.getPixelRatio();
  sharpen.material.uniforms.resolution.value.set(innerWidth * pr, innerHeight * pr);
  sharpen.enabled = sharpen.material.uniforms.strength.value > 0.001;
}
syncSharpen();
composer.addPass(sharpen);

// ── 画质档位：低 / 中 / 高，Q 键循环
//  只动「渲染分辨率 / 环境光遮蔽 / 装饰物件」，不改光照数量（改灯会触发着色器重编译）
const QUALITY = {
  low: { res: 0.7, ao: false, decor: false, label: '低' },
  mid: { res: 1.0, ao: false, decor: true, label: '中' },
  high: { res: 1.0, ao: true, decor: true, label: '高' },
};
let qualityName = QS.get('q') || 'high';
let qualityRes = 1.0;
function applyQuality(name) {
  const q = QUALITY[name] ?? QUALITY.mid;
  qualityName = name;
  qualityRes = q.res;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2.0) * q.res * RES);
  composer.setSize(innerWidth, innerHeight);
  gtao.enabled = q.ao && QSP.get('ao') !== '0';   // URL 的 ?ao=0 优先，别被画质档覆盖
  gtao.setSize(innerWidth, innerHeight);
  STAGE.setDecor(q.decor);
  const el = document.getElementById('banner');
  if (el) {
    el.textContent = `画质：${q.label}`;
    el.classList.add('show');
    clearTimeout(applyQuality._t);
    applyQuality._t = setTimeout(() => el.classList.remove('show'), 900);
  }
}
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'q') {
    const order = ['low', 'mid', 'high'];
    const next = order[(order.indexOf((window.__settingsApi?.state().preset) || qualityName) + 1) % order.length];
    if (window.__settingsApi) window.__settingsApi.applyPreset(next);
    else applyQuality(next);
  }
});
applyQuality(qualityName);
// 预编译所有材质的着色器，避免第一次看到某个物体时卡一下
renderer.compile(scene, camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  gtao.setSize(innerWidth, innerHeight);
  syncFXAA();
  syncSharpen();
  smaa.setSize(innerWidth, innerHeight);
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

// 动作 -> 按键列表。可在设置页重绑定，存在 localStorage。
const DEFAULT_KEYS = {
  fwd: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  roll: ['ShiftLeft', 'Space'],
  light: ['KeyJ'], heavy: ['KeyK'], block: ['KeyL'],
};
const ACTION_KEYS = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('souls-demo-keys') || 'null');
    if (saved && typeof saved === 'object') return Object.assign({}, DEFAULT_KEYS, saved);
  } catch (e) { /* 忽略 */ }
  return JSON.parse(JSON.stringify(DEFAULT_KEYS));
})();

const KEYMAP = {};
const CODES_BY_NAME = {};
function rebuildKeymap() {
  for (const k of Object.keys(KEYMAP)) delete KEYMAP[k];
  for (const k of Object.keys(CODES_BY_NAME)) delete CODES_BY_NAME[k];
  for (const [action, codes] of Object.entries(ACTION_KEYS)) {
    for (const code of codes) {
      KEYMAP[code] = action;
      (CODES_BY_NAME[action] || (CODES_BY_NAME[action] = [])).push(code);
    }
  }
  try { localStorage.setItem('souls-demo-keys', JSON.stringify(ACTION_KEYS)); } catch (e) { /* 忽略 */ }
}
rebuildKeymap();

addEventListener('keydown', (e) => {
  if (window.__recordingKey) { e.preventDefault(); return; }
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
console.log('[build] turn-v3 / back-latched / yaw-stripped');
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

  /**
   * 圆形台面约束：半径 = 台面半径 − 栏杆 − 自身半径。
   * 沿径向夹住，贴边时顺着圆滑走，不像方形 clamp 那样卡在角上。
   */
  clampToArena() {
    // ① 先解圆柱障碍（断柱 / 倒柱）：挡住就沿法线推出去，能贴着绕
    for (const o of STAGE.obstacles) {
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z;
      const min = o.r + this.hurt.radius;
      const d = Math.hypot(dx, dz);
      if (d < min) {
        if (d > 1e-4) {
          const k = min / d;
          this.pos.x = o.x + dx * k;
          this.pos.z = o.z + dz * k;
        } else {
          // 正好在柱心：没有方向可推，朝 +X 推到边缘
          this.pos.x = o.x + min;
        }
      }
    }
    // ② 再夹圆形台面
    const lim = ARENA_R - 1.8 - this.hurt.radius;
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > lim && d > 1e-6) {
      const k = lim / d;
      this.pos.x *= k;
      this.pos.z *= k;
    }
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
if (location.search.includes('debug')) {
  window.__player = player;   // ?debug 排查用
  window.__MOVES = MOVES;     // 帧数据表（联调 / 持久化自检）
  window.__CFG = CFG;
  window.__VFX_CFG = VFX_CFG;
  window.__vfx = vfx;          // 剑轨 / 特效调试
  window.__camera = camera;    // 相机（截图 / 取景排查用）
  window.__scene = scene;      // 场景（材质 / 灯光排查用）
  window.__tuningSave = () => tuningSave(false);
  window.__tuningClear = () => tuningClear();
}
const boss = new Actor({
  name: 'BOSS', isBoss: true, scale: 2.6, pos: [0, -8],
  hp: 3200, poise: 120, hurt: { radius: 1.15, height: 4.6 },
});
if (location.search.includes('debug')) window.__boss = boss;   // Boss（动作 / AI 排查用）

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

// ── Boss 超霸体 ──────────────────────────────────────────────
// 2 秒内连续受击 5 次 → 触发「超霸体」，持续 10 秒。
//   超霸体期间：不产生受击僵直（血量照扣），出招也不会延长超霸体。
// 另外：Boss 只要在出招，整段攻击都是霸体，不会被玩家的攻击打断。
const BOSS_ARMOR = { windowFrames: 120, maxStuns: 5, durationFrames: 600 };

/** 记一次僵直；返回 true 表示这次应该免疫（已经霸体 / 刚触发霸体） */
function registerBossStun() {
  if (!boss.stunMarks) boss.stunMarks = [];
  if (boss.armorUntil === undefined) boss.armorUntil = -1;

  if (logicFrame < boss.armorUntil) return true;

  boss.stunMarks = boss.stunMarks.filter((f) => logicFrame - f <= BOSS_ARMOR.windowFrames);
  boss.stunMarks.push(logicFrame);

  if (boss.stunMarks.length >= BOSS_ARMOR.maxStuns) {
    boss.stunMarks.length = 0;
    boss.armorUntil = logicFrame + BOSS_ARMOR.durationFrames;
    // 只解除当前僵直；正在出招就不打断它
    if (boss.state === 'hitstun') {
      boss.setState('idle');
      boss.stunTimer = 0;
    }
    banner('超霸体', 1000);
    console.log('[boss] 2 秒内连续受击 5 次 → 超霸体 10 秒（logicFrame', logicFrame, '）');
    return true;
  }
  return false;
}

/** 霸体是否生效中 */
function bossArmored() {
  return logicFrame < (boss.armorUntil ?? -1);
}

function applyDamage(attacker, defender, move) {
  // 玩家格挡 / 弹反窗口
  if (defender === player && player.state === 'block') {
    const parryEnd = 8;
    if (player.frame <= parryEnd) {
      // 弹反成功
      boss.poise = Math.max(0, boss.poise - 60);
      if (!registerBossStun() && boss.state !== 'attack') {   // 超霸体 / 出招中都不吃僵直
        boss.setState('hitstun');
        boss.stunTimer = 90;
      }
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

  // Boss 架招：减伤 70%，不吃硬直，只掉韧性；韧性打空照样破防
  if (defender === boss && boss.state === 'block') {
    defender.hp = Math.max(0, defender.hp - move.damage * 0.30);
    defender.poise = Math.max(0, defender.poise - move.damage * 0.22);
    defender.flashTimer = 3;
    shake(0.05);
    hitstop(HITSTOP_LIGHT());
    vfx.guard(boss);
    if (defender.poise <= 0) {
      defender.setState('hitstun');
      defender.stunTimer = 40;
      defender.poise = defender.maxPoise * 0.5;
    }
    return;
  }

  const dmg = move.damage;
  defender.hp = Math.max(0, defender.hp - dmg);
  defender.poise = Math.max(0, defender.poise - move.poise);
  // Boss 霸体判定：
  //   · 超霸体生效中 → 不产生受击僵直
  //   · 正在出招     → 整段攻击都是霸体，不会被打断
  // 两种情况血量都照扣。
  const bossImmune = defender === boss ? registerBossStun() : false;
  const bossAttacking = defender === boss && boss.state === 'attack';
  if (!bossImmune && !bossAttacking) {
    defender.setState('hitstun');
    defender.stunTimer = move.hitstun;
  }
  defender.flashTimer = 4;

  // 削韧满：强制长硬直
  if (defender.poise <= 0 && defender === boss) {
    if (!bossImmune && !bossAttacking) defender.stunTimer = 110;   // 超霸体 / 出招中都免疫
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
    case 'light4':
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
          light3: ['light4', 'p_light4', 'light'],
          heavy: ['heavy2', 'p_heavy2', 'heavy'],
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

      // 按住 S 只转一次：必须松开 S 才能再次触发（防止连点/长按导致连续翻身）
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
  const fwdInput = (down('fwd') ? 1 : 0) - (down('back') ? 1 : 0);   // S 直接参与移动，不再转身
  const strafeInput = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
  if (!fwdInput && !strafeInput) {
    player.moving = false;
    player.speed = 0;
    return false;
  }

  const { fwd, right } = screenBasis();

  // 倒退比前进慢 —— 这是常识，也是动画能对上的前提。
  // 按 4.2 m/s 倒着跑，倒退走动画得加速 2.7 倍才追得上，直接崩。
  // 锁定视角后退（Backstep）用更慢的速度：步子小、速度也得跟着小
  const axisScale = (player.lockOn && fwdInput < 0) ? 0.452 : 1.0;   // 锁定后退 ≈1.90 m/s
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

  // 朝向 = 移动方向（S 也是移动方向，不再背对着倒着走）
  const targetYaw = player.lockOn
    ? Math.atan2(fwd.x, fwd.z)
    : Math.atan2(dir.x, dir.z);
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
  const all = [];      // 射程内 + 冷却好了的招
  for (const [id, m] of Object.entries(MOVES)) {
    if (!id.startsWith('b_')) continue;
    if (dist < m.minRange || dist > m.maxRange) continue;
    const cdScale = CFG.bossCooldownScale * (AI.phase2 ? 0.72 : 1);
    const ready = (logicFrame - (AI.cooldowns?.[id] ?? -999)) > m.cooldown * 60 * cdScale;
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
    // 反重复用「降权」而不是「禁用」：Boss 只有 3 个攻击，
    // 硬禁掉最近两招会让池子里只剩 1 个 → 每次靠近都放同一招（看着像固定的）。
    if (AI.recent[AI.recent.length - 1] === id) w *= 0.30;   // 刚用过的明显降权
    else if (AI.recent.includes(id)) w *= 0.70;              // 更早用过的小幅降权
    all.push({ id, w });
  }
  const pool = all;
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

    case 'block':
      // 架招：面向玩家站定，时间到解除
      boss.turnToward(targetYaw, CFG.bossTurnFrames);
      boss.frame++;
      if (logicFrame >= (AI.blockUntil ?? 0)) {
        boss.setState('idle');
        AI.gapFrames = Math.max(AI.gapFrames, 8);
      }
      return;

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
          AI.gapFrames = Math.round(CFG.bossComboGap * 60 * (0.7 + rng() * 0.6) * (AI.phase2 ? 0.78 : 1));
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
        // 「怒吼」动作已取消：阶段转换只做横幅 / 场景变化，不再播那段站着扭头的动作
        boss.moving = false;
        // 二阶段：场景推到血月（法阵转红、雾变浓、火盆变血焰）
        STAGE.setPhase(2);
        banner('第二阶段 · 血月', 1800);
        shakeAmt = Math.max(shakeAmt, 0.9);
        AI.gapFrames = 0;
        return;
      }
      if (!AI.phase3 && boss.hp < boss.maxHp * 0.25) {
        AI.phase3 = true;
        AI.intentUntil = 0;
        // 「怒吼」动作已取消：阶段转换只做横幅 / 场景变化，不再播那段站着扭头的动作
        boss.moving = false;
        return;
      }

      // ── 看破：玩家正在起手（还在 startup 段），Boss 有概率后撤躲开 ──
      // 连招合并后玩家有 light1~4 / heavy~heavy3，用前缀判断，新加招式不用再改这里
      const playerWinding = (player.state.startsWith('light') || player.state.startsWith('heavy'))
        && player.move
        && player.frame < player.move.startup;
      // ── 架招：玩家起手时按概率举盾格挡（和「看破后撤」并存，先判格挡）──
      if (playerWinding && dist < 6.5 && logicFrame > (AI.nextBlock ?? 0)) {
        AI.nextBlock = logicFrame + (CFG.bossBlockCooldown ?? 150);
        if (rng() < (CFG.bossBlockChance ?? 0.35)) {
          boss.setState('block');
          AI.blockUntil = logicFrame + (CFG.bossBlockFrames ?? 34);
          boss.moving = false;
          return;
        }
      }

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
        if (AI.recent.length > 2) AI.recent.shift();
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
  // free_slash_vfx 的新月贴图：只给 Boss 加一层（玩家已有紫色剑轨）
  if (a.isBoss) vfx.crescentSlash(a, m);
}

// ── 剑轨采样：从武器组拿「刃根 / 刃尖」世界坐标 ─────────────────
const _trailBase = new THREE.Vector3();
const _trailTip = new THREE.Vector3();
const _trailDir = new THREE.Vector3();
const ATTACK_STATE_RE = /^(light\d|heavy\d?|attack)$/;

/**
 * 量出武器「剑身」在组本地坐标里的跨度：不假设是 +Y，
 * 直接对组内网格求本地包围盒，取最长轴的两端（握把端 / 剑尖端）。
 * 结果缓存在武器组的 userData 上，只在第一次调用时算一次。
 */
const _bladeInv = new THREE.Matrix4();
const _bladeM = new THREE.Matrix4();
const _bladeV = new THREE.Vector3();
const _bladeMin = new THREE.Vector3();
const _bladeMax = new THREE.Vector3();
function bladeSpan(group) {
  if (group.userData.bladeSpan) return group.userData.bladeSpan;
  group.updateWorldMatrix(true, true);
  _bladeInv.copy(group.matrixWorld).invert();
  _bladeMin.set(Infinity, Infinity, Infinity);
  _bladeMax.set(-Infinity, -Infinity, -Infinity);
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    _bladeM.copy(_bladeInv).multiply(o.matrixWorld);
    const pa = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pa.count / 400));
    for (let i = 0; i < pa.count; i += step) {
      _bladeV.fromBufferAttribute(pa, i).applyMatrix4(_bladeM);
      _bladeMin.min(_bladeV);
      _bladeMax.max(_bladeV);
    }
  });
  const size = _bladeMax.clone().sub(_bladeMin);
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');
  const span = { axis, lo: _bladeMin[axis], hi: _bladeMax[axis] };
  group.userData.bladeSpan = span;
  return span;
}

/**
 * 每帧调用。只要角色处于出招状态就持续采样，
 * 挥得快 → 同一时间窗内扫过的路径更长；停下 → 旧采样自然淡出。
 */
function feedBladeTrail(key, a, dt) {
  if (!vfx.trails || !vfx.trails[key]) return;
  const swinging = !!a && ATTACK_STATE_RE.test(a.state);
  const group = a && a.binder && a.binder.weaponGroup;
  if (!swinging || !group) { vfx.feedTrail(key, null, null, dt, false); return; }

  // 用实测的剑身跨度取两端（不再假设本地 +Y 就是刃向）
  const span = bladeSpan(group);
  group.updateWorldMatrix(true, false);
  _trailBase.set(0, 0, 0);
  _trailTip.set(0, 0, 0);
  _trailBase[span.axis] = span.lo;
  _trailTip[span.axis] = span.hi;
  _trailBase.applyMatrix4(group.matrixWorld);
  _trailTip.applyMatrix4(group.matrixWorld);

  // 沿刃身「平行下移」一段：让光带正好压住整条剑身（负值 = 往护手方向挪）
  const shift = VFX_CFG.trailShift ?? 0;
  if (shift) {
    _trailDir.copy(_trailTip).sub(_trailBase).normalize();
    _trailBase.addScaledVector(_trailDir, shift);
    _trailTip.addScaledVector(_trailDir, shift);
  }
  vfx.feedTrail(key, _trailBase, _trailTip, dt, true);
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

/** 把相机瞬间对齐到「玩家身后、Boss 在正前方」，开场和重开时调用 */
function snapCamera() {
  const toBoss = boss.pos.clone().sub(player.pos).setY(0);
  if (toBoss.lengthSq() < 1e-4) toBoss.set(0, 0, -1);
  toBoss.normalize();
  camYaw = Math.atan2(-toBoss.x, -toBoss.z);
  const focus = player.pos.clone().add(new THREE.Vector3(0, 1.9, 0));
  const dir = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
  camPos.copy(focus).addScaledVector(dir, 8.6).add(new THREE.Vector3(0, 3.9, 0));
  camTarget.copy(focus);
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

function updateCamera(dtReal) {
  const focus = player.pos.clone().add(new THREE.Vector3(0, 1.9, 0));
  const dist = 8.6;

  // 相机永远位于「玩家→Boss」的反向延长线上：Boss 恒定在画面正前方
  const { fwd } = screenBasis();
  const targetYaw = Math.atan2(-fwd.x, -fwd.z);
  // 目标角与当前角最多每帧转 maxStep，避免 Boss 贴身绕圈时镜头疯狂旋转
  const maxYawStep = 4.0 * Math.min(dtReal, 0.1);          // 约 230 度/秒上限
  const prevYaw = camYaw;
  camYaw = lerpAngle(camYaw, targetYaw, 1 - Math.pow(0.002, dtReal));
  let dYaw = ((camYaw - prevYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(dYaw) > maxYawStep) camYaw = prevYaw + Math.sign(dYaw) * maxYawStep;
  if (!Number.isFinite(camYaw)) camYaw = 0;

  const dir = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
  const desired = focus.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, 3.9, 0));

  const k = 1 - Math.pow(0.001, dtReal);
  camPos.lerp(desired, Math.min(1, k * 2.0));
  if (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)) {
    camPos.copy(desired);
  }

  // 镜头约束：贴边战斗时镜头会退到台外。硬拉回来会让镜头贴脸，
  // 所以改成「退出去多少就抬高多少」——越过台沿看进去，台沿和栏杆就不会挡住半个画面。
  const camR = Math.hypot(camPos.x, camPos.z);
  const hardMax = ARENA_R + 6;
  if (camR > hardMax) {
    const kk = hardMax / camR;
    camPos.x *= kk;
    camPos.z *= kk;
  }
  const over = Math.max(0, camR - (ARENA_R - 2.2));
  camPos.y = Math.max(camPos.y, 3.6 + over * 0.9);

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

// ═══════════════════════════════════════════════════════════════
// Boss 的镰刀：待机 / 走路时拖在身后
//
// 关键：拖刀姿态在**世界空间**里算，握把高度写死 —— 走路动画的髋部
// 起伏传不到刀上，所以不会上下颠；只跟 Boss 的水平位置和朝向走。
// 攻击 / 受击 / 死亡时把刀交回右手，恢复原来的局部变换。
// ═══════════════════════════════════════════════════════════════
/**
 * 缩短手臂：只缩放上臂 / 前臂这两级骨骼。
 * 子骨骼（手、手指、扭转骨）会跟着等比缩小，整条手臂一致变短，不会脱节。
 * 动作包里的 scale 轨道已被 stripBoneTransforms 去掉，这里的值不会被覆盖。
 */
/**
 * 把武器缩放到指定世界长度（沿它最长的那个轴）。
 * 每次换模型/换骨架，骨骼尺度都可能变，武器挂上去就会过大或过小 —— 挂完量一次再纠正。
 */
function fitWeaponLength(actor, meters) {
  const w = actor?.weapon;
  if (!w || !(meters > 0)) return 0;
  // 量之前必须从父级往下把世界矩阵刷一遍：只对 w 自己 updateMatrixWorld 会读到父级旧矩阵，
  // 量出来差一两个数量级，再按这个差值缩放就把武器放大成几十米。
  const from = w.parent ?? w;
  if (from.updateWorldMatrix) from.updateWorldMatrix(true, true);
  for (let pass = 0; pass < 3; pass++) {
    const box = new THREE.Box3().setFromObject(w);
    const size = box.getSize(new THREE.Vector3());
    const cur = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(cur) || cur < 1e-4) return 0;
    const ratio = meters / cur;
    if (Math.abs(ratio - 1) < 0.02) return +cur.toFixed(2);   // 返回「实测」长度，日志才不会说谎
    w.scale.multiplyScalar(ratio);
    w.updateMatrixWorld(true);
  }
  const box = new THREE.Box3().setFromObject(w);
  const size = box.getSize(new THREE.Vector3());
  return +Math.max(size.x, size.y, size.z).toFixed(2);
}

function setArmLength(actor, factor) {
  if (!actor?.binder || !(factor > 0.1)) return 0;
  let n = 0;
  actor.binder.root.traverse((o) => {
    if (!o.isBone) return;
    if (!/^(L|R)_(Upperarm|Forearm)$/i.test(o.name)) return;
    o.scale.setScalar(factor);
    n++;
  });
  return n;
}
const DRAG = {
  enabled: true,
  back: 0.02,     // （旧逻辑用，现已不生效：握把直接跟手骨）
  height: 0,      // （旧逻辑用，现已不生效：握把高度由手的位置决定）
  tipLen: 0,      // 刀刃落点距离；0 = 按身高自动（1.02H），只影响地面划痕位置
  ground: true,   // 拖地模式：俯角按「握把离地高度」反算，刀尖永远正好落在 y = 0
  side: 0.30,     // 刀杆侧偏角（弧度）：绕竖轴把刀甩到斜后方，刀尖朝外；负值换边
  elev: 0.15,     // 只在 ground=false 时生效：固定俯角
  roll: 0,        // 绕刀杆自转：调刀刃朝上 / 朝地（刀身摊平用 ±1.57）
};

let dragState = null;
const _dragDir = new THREE.Vector3();
const _dragAxisY = new THREE.Vector3(0, 1, 0);
const _dragQuat = new THREE.Quaternion();
const _dragRoll = new THREE.Quaternion();
const _dragHandQuat = new THREE.Quaternion();
const _dragLocalQuat = new THREE.Quaternion();
const _dragHandPos = new THREE.Vector3();
const _dragRefX = new THREE.Vector3();
const _dragRefZ = new THREE.Vector3();
const _dragBasis = new THREE.Matrix4();

function setupDragWeapon() {
  const w = boss.weapon;
  if (!w || dragState) return;

  const q = new URLSearchParams(location.search);
  DRAG.enabled = q.get('drag') !== '0';
  const num = (name, key) => {
    const v = q.get(name);
    if (v != null && Number.isFinite(Number(v))) DRAG[key] = Number(v);
  };
  num('dback', 'back');
  num('dh', 'height');
  num('dtip', 'tipLen');
  num('delev', 'elev');
  num('droll', 'roll');
  num('dside', 'side');
  if (q.get('dground') != null) DRAG.ground = q.get('dground') !== '0';

  // 用「模型实际身高」当拖刀尺度的基准（boss.hurt.height 是战斗数值，和模型不一定一致）
  //
  // ★ 必须按骨骼量，不能按几何包围盒的 Y 轴：
  //   Tripo 导出的网格是 Z-up，身高在 Z 轴上，Y 只有 0.47 的「厚度」，
  //   量出来只有 5mm，于是握把被钉在地面、整把镰刀插到地板底下 ——
  //   表现就是「待机时武器消失，只有攻击（武器交回手上）才出现」。
  let modelH = 1.9;
  try {
    const root = boss.binder.root;
    root.updateMatrixWorld(true);
    let head = null;
    let toe = null;
    root.traverse((o) => {
      if (!o.isBone) return;
      if (!head && /^head$/i.test(o.name)) head = o;
      if (!toe && /toebase$/i.test(o.name)) toe = o;
    });
    const v = new THREE.Vector3();
    let fromBones = false;
    if (head && toe) {
      head.getWorldPosition(v); const hy = v.y;
      toe.getWorldPosition(v); const ty = v.y;
      // 头骨 → 脚趾骨大约占身高 85%，和 fitToHeightBones 用的是同一个基准
      const boneH = Math.abs(hy - ty);
      if (boneH > 1e-3) { modelH = boneH / 0.85; fromBones = true; }
    }
    // 兜底：拿不到骨骼时退回几何包围盒，但取「最长轴」而不是 Y，并对量级做合理性夹取
    if (!fromBones) {
      const ws = new THREE.Vector3();
      root.getWorldScale(ws);
      let localH = 0;
      root.traverse((o) => {
        if (!o.isSkinnedMesh || !o.geometry) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const h = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        if (h > localH) localH = h;
      });
      const guess = localH * ws.y;
      modelH = (guess > 0.5 && guess < 10) ? guess : (boss.hurt?.height ?? 1.95);
    }
  } catch (e) { /* 灰盒模式下没有 binder，用默认值 */ }

  dragState = {
    obj: w,
    hand: w.parent,
    pos: w.position.clone(),
    quat: w.quaternion.clone(),
    scale: w.scale.clone(),
    heightRef: modelH,
    onHand: true,
    yaw0: 0,                        // 进入拖刀时的 yaw
    z0: new THREE.Vector3(0, 0, 1), // 进入拖刀时锁定的「刀身滚转参考轴」
  };
}

function updateDragWeapon() {
  const d = dragState;
  if (!d) return;

  // Boss 只有 idle（含踱步/绕圈）和 move 算「非战斗」
  const wantDrag = DRAG.enabled && (boss.state === 'idle' || boss.state === 'move');

  if (!wantDrag) {
    // 切回战斗：恢复调参面板上的握持姿态
    if (d.dragging) {
      d.dragging = false;
      d.obj.position.copy(d.pos);
      d.obj.quaternion.copy(d.quat);
      d.obj.scale.copy(d.scale);
      if (typeof applyBossWeapon === 'function') applyBossWeapon();
      d.pos.copy(d.obj.position);
      d.quat.copy(d.obj.quaternion);
      d.scale.copy(d.obj.scale);
    }
    return;
  }

  const entering = !d.dragging;
  if (entering) {
    d.dragging = true;
    d.pos.copy(d.obj.position);      // 记下进入拖刀前的握持姿态
    d.quat.copy(d.obj.quaternion);
    d.scale.copy(d.obj.scale);
  }

  // ★ 关键：武器始终是手骨的子节点，不摘下来 —— boss 是「抓着手柄拖」，
  //   握把位置就是 realign() 算好的掌心位置，跟着手一起动，不会再错位。
  //   这里只改它相对手骨的旋转，让刀身朝斜后方横着甩出去。
  d.obj.position.copy(d.pos);
  d.obj.scale.copy(d.scale);

  // 握把世界坐标（= 手骨世界矩阵 × 握把局部位置）
  d.hand.updateWorldMatrix(true, false);
  _dragHandPos.copy(d.pos).applyMatrix4(d.hand.matrixWorld);

  // 握把 → 刀尖的实际长度
  const L = DRAG.tipLen > 0 ? DRAG.tipLen : (d.heightRef || 1.9) * 1.02;

  // 水平方向：正后方（yaw + π）绕竖轴偏 DRAG.side
  const yaw = boss.yaw;
  const az = yaw + Math.PI + DRAG.side;
  const hx = Math.sin(az), hz = Math.cos(az);

  if (DRAG.ground) {
    // ★ 拖地：俯角不写死，按「握把离地多高」反算 —— 刀尖的水平投影 flat 满足
    //   flat² + drop² = L²，于是刀尖永远正好落在 y = 0：手抬高、放低都不会悬空或插进地里。
    const drop = Math.min(Math.max(_dragHandPos.y, 0.05), L * 0.92);
    const flat = Math.sqrt(Math.max(0.01, L * L - drop * drop));
    _dragDir.set(hx * flat / L, -drop / L, hz * flat / L).normalize();
  } else {
    const ce = Math.cos(DRAG.elev), se = Math.sin(DRAG.elev);
    _dragDir.set(hx * ce, -se, hz * ce).normalize();
  }

  // 进入拖刀的第一帧：用最短弧定一次「刀身滚转」，并把它锁下来。
  //
  // ★ 不能每帧都用 setFromUnitVectors：它只保证 +Y 指向刀杆方向，滚转是最短弧的副产物。
  //   主角左右移动时 Boss 会转身追人 → yaw 连续变化 → 最短弧的滚转角跟着乱拧，
  //   看起来就是「刀绕着刀柄自转」。锁住之后每帧只做绕 Y 的刚性旋转。
  if (entering) {
    _dragQuat.setFromUnitVectors(_dragAxisY, _dragDir);
    d.yaw0 = yaw;
    _dragRefZ.set(0, 0, 1).applyQuaternion(_dragQuat);
    d.z0.copy(_dragRefZ);
  }

  // 锁定参考随身体绕 Y 转过 Δyaw，再投影到「垂直于当前刀杆」的平面上
  _dragRefZ.copy(d.z0).applyAxisAngle(_dragAxisY, yaw - d.yaw0);
  _dragRefZ.addScaledVector(_dragDir, -_dragRefZ.dot(_dragDir));
  if (_dragRefZ.lengthSq() < 1e-8) _dragRefZ.set(0, 0, 1);      // 刀杆与参考轴重合时的退化
  _dragRefZ.normalize();
  _dragRefX.crossVectors(_dragDir, _dragRefZ).normalize();
  _dragRefZ.crossVectors(_dragRefX, _dragDir).normalize();      // 再正交化，避免浮点漂移
  _dragBasis.makeBasis(_dragRefX, _dragDir, _dragRefZ);
  _dragQuat.setFromRotationMatrix(_dragBasis);

  if (DRAG.roll) {
    _dragRoll.setFromAxisAngle(_dragDir, DRAG.roll);
    _dragQuat.premultiply(_dragRoll);      // 绕刀杆自转
  }

  // 世界朝向 → 手骨局部朝向
  d.hand.getWorldQuaternion(_dragHandQuat);
  _dragLocalQuat.copy(_dragHandQuat).invert().multiply(_dragQuat);
  d.obj.quaternion.copy(_dragLocalQuat);

  // 换了朝向后，握把会绕武器原点画弧、离开掌心 ——
  // 用 realign() 重新量一次「手柄末端那一圈」的几何中心，把它重新钉回掌心。
  // 这样看上去就是手始终抓着刀柄在拖，武器只是绕握点转了个方向。
  const wApi = d.obj.userData && d.obj.userData.weapon;
  if (wApi && typeof wApi.realign === 'function') wApi.realign();

  // 刀刃落点 → 地面划痕（拖地模式下正好落在 y = 0 的地面点）
  scratch.emit(
    _dragHandPos.x + _dragDir.x * L,
    _dragHandPos.z + _dragDir.z * L,
  );
}
// ── 渲染 ──────────────────────────────────────────────────────
function render(dtReal) {
  updateStage(performance.now() / 1000, camera);
  updateStage(performance.now() / 1000, camera);
  // 美术模型动画（灰盒可不接）
  const animDt = CFG.paused ? 0 : dtReal;   // 暂停时冻结动画，方便逐帧检查
  if (player.binder) player.binder.update(player, animDt);
  if (boss.binder) boss.binder.update(boss, animDt);

  player.syncMesh();
  boss.syncMesh();

  // 走路拖刀：世界空间定位，所以不会被走路动画带着上下颠
  updateDragWeapon();
  scratch.update(CFG.paused ? 0 : dtReal * CFG.timeScale);

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
  const dtVfx = CFG.paused || hitstopFrames > 0 ? 0 : dtReal * CFG.timeScale;
  vfx.update(dtVfx);

  // ── 真实剑轨：按「刃根 → 刃尖」逐帧采样，扇形由剑自己扫出来 ──
  feedBladeTrail('player', player, dtVfx);
  feedBladeTrail('boss', boss, dtVfx);

  const _q = gpuTimer ? gpuTimer.begin() : null;
  composer.render();
  if (gpuTimer && _q) gpuTimer.end(_q);
  if (window.__perf) { window.__perf.calls = renderer.info.render.calls; window.__perf.tris = renderer.info.render.triangles; }
  renderer.info.reset();
}

// ── 主循环 ────────────────────────────────────────────────────

// ── GPU 计时（EXT_disjoint_timer_query_webgl2）：直接问显卡这一帧花了多少毫秒
const gpuTimer = (() => {
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const pool = [];
  return {
    gl, ext,
    begin() {
      const q = pool.pop() || gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      return q;
    },
    end(q) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      q.__pending = true;
      pool.push(q);
      if (pool.length > 6) {
        const old = pool.shift();
        if (old.__pending) gl.deleteQuery(old);
      }
    },
    read() {
      let ms = null;
      for (const q of pool) {
        if (!q.__pending) continue;
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          if (!disjoint) ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          q.__pending = false;
        }
      }
      return ms;
    },
  };
})();
let __fpsFrames = 0, __fpsAcc = 0, __fps = 0;


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

  __fpsFrames++; __fpsAcc += dtReal;
  if (__fpsAcc >= 0.5) {
    __fps = Math.round(__fpsFrames / __fpsAcc); __fpsFrames = 0; __fpsAcc = 0;
    window.__perf = { fps: __fps, q: qualityName, ratio: +renderer.getPixelRatio().toFixed(2), ao: gtao.enabled, gpuMs: gpuTimer ? +(gpuTimer.read() ?? 0).toFixed(2) : null };
  }
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

<span class="k">逻辑帧</span> ${logicFrame}   <span class="fps"><span class="k">FPS</span> <span class="p">${__fps}</span>   </span><span class="k">画质</span> ${(QUALITY[qualityName] ?? QUALITY.mid).label}   <span class="k">hitstop</span> ${hitstopFrames}   <span class="k">倍速</span> ${CFG.timeScale}x`;
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

const moveParams = {};
const moveInfo = {};

function addMoveFolder(parent, id, m) {
  const sub = parent.addFolder(`${m.label} [${id}]`);
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

const fMovesP = gui.addFolder('玩家招式');
const fMovesB = gui.addFolder('Boss 招式');
for (const [id, m] of Object.entries(MOVES)) {
  addMoveFolder(id.startsWith('b_') ? fMovesB : fMovesP, id, m);
}
fMovesP.open();

const fDebug = gui.addFolder('调试');
fDebug.add(CFG, 'showHitbox').name('判定框 (F1)').listen();
fDebug.add(CFG, 'timeScale', 0.05, 2, 0.05).name('时间倍速 (F2)').listen();
fDebug.add(CFG, 'paused').name('暂停 (F3)').listen();
fDebug.add(CFG, 'hitstop', 0, 16, 1).name('命中冻结帧');
fDebug.add({ fn: resetFight }, 'fn').name('重开 (R)');
fDebug.add({ fn: downloadJSON }, 'fn').name('导出帧表 (P)');

// 调参存档：改完自动保存；这里给手动按钮和状态显示
const fSave = gui.addFolder('调参存档');
const saveState = {
  status: () => (window.__tuningLoaded ? '已载入存档' : '使用默认值'),
  save: () => tuningSave(false).then(() => { saveState.info = '已保存'; }),
  clear: () => tuningClear().then(() => { saveState.info = '已清除，按 R 或刷新后恢复默认'; }),
  info: '',
};
fSave.add(saveState, 'save').name('保存到文件 / 浏览器');
fSave.add(saveState, 'clear').name('清除存档');
fSave.add({
  fn: async () => {
    await tuningClear();
    __tuningLast = JSON.stringify(tuningSnapshot());
    await tuningSave(false);
    saveState.info = '已用当前代码默认值重建存档';
  }
}, 'fn').name('用代码默认值覆盖存档');
fSave.add(saveState, 'status').name('→ 载入状态').disable();
fSave.add(saveState, 'info').name('→ 操作结果').disable();
fSave.open();

const fVfx = gui.addFolder('近战特效');
fVfx.add(VFX_CFG, 'enabled').name('开启');
fVfx.add(VFX_CFG, 'intensity', 0, 2, 0.05).name('强度');
fVfx.add(VFX_CFG, 'slashLife', 0.4, 2.5, 0.05).name('刀光时长倍率');
fVfx.add(VFX_CFG, 'trail').name('剑轨（跟刃白光）');
fVfx.add(VFX_CFG, 'trailPurple').name('紫色配色（Unity 包）');
fVfx.add(VFX_CFG, 'trailMap').name('月牙贴图');
fVfx.add(VFX_CFG, 'trailMapTile', 0.25, 4, 0.05).name('贴图平铺次数');
fVfx.add(VFX_CFG, 'trailShift', -0.8, 0.8, 0.02).name('沿剑身平移(m)');
fVfx.add(VFX_CFG, 'trailLife', 0.08, 0.8, 0.01).name('剑轨拖尾(秒)');
fVfx.add(VFX_CFG, 'trailIntensity', 0.1, 3, 0.05).name('剑轨亮度');
fVfx.add(VFX_CFG, 'trailBoss').name('Boss 也有剑轨');
fVfx.add(VFX_CFG, 'arc').name('旧弧光（对比用）');
fVfx.add(VFX_CFG, 'sparkCount', 0, 40, 1).name('火花数量');
fVfx.add(VFX_CFG, 'telegraph').name('Boss 起手预警');
fVfx.add(VFX_CFG, 'telegraphStart', 0, 1, 0.05).name('起手亮度');

// ── Boss 武器朝向（绕柄旋转，改完立即生效）──────────────────────────
// 原理：outer.rotation 以「柄重心」为支点，改角度后 realign() 会重测
// 柄位置并补平移 —— 柄钉在掌心，只有刃身绕柄甩。
// 默认值要和下面 attachModels 里的 [-100°, 0, -90°] 保持一致。
const DEG2RAD = Math.PI / 180;
// grip：0 = 握在柄端，1 = 握在刃端；镰刀这类长柄一般握在中段 0.3~0.6
const bossWeapon = { x: -100, y: 0, z: -90, roll: 0, grip: 0.10 };

function applyBossWeapon() {
  const wg = boss.binder && boss.binder.weaponGroup;
  if (!wg) return;
  wg.rotation.set(bossWeapon.x * DEG2RAD, bossWeapon.y * DEG2RAD, bossWeapon.z * DEG2RAD);
  const w = wg.userData && wg.userData.weapon;
  if (!w) return;
  w.rollGroup.rotation.y = bossWeapon.roll * DEG2RAD;
  if (typeof w.setGripShift === 'function') w.setGripShift(bossWeapon.grip);
  else w.realign();
}

function flipBossWeapon(axis) {
  // 加 180° 后归一化到 [-180, 180)
  let v = bossWeapon[axis] + 180;
  v = ((v % 360) + 360) % 360;
  bossWeapon[axis] = v >= 180 ? v - 360 : v;
  syncGUI();
  applyBossWeapon();
}

const fWeapon = gui.addFolder('Boss 武器（绕柄）');
fWeapon.add(bossWeapon, 'x', -180, 180, 1).name('绕柄 X°').onChange(applyBossWeapon);
fWeapon.add(bossWeapon, 'y', -180, 180, 1).name('绕柄 Y°').onChange(applyBossWeapon);
fWeapon.add(bossWeapon, 'z', -180, 180, 1).name('绕柄 Z°').onChange(applyBossWeapon);
fWeapon.add(bossWeapon, 'roll', -180, 180, 1).name('沿柄滚转°').onChange(applyBossWeapon);
fWeapon.add(bossWeapon, 'grip', 0, 1, 0.01).name('握柄位置(0柄端/1刃端)').onChange(applyBossWeapon);
fWeapon.add({ fn: () => flipBossWeapon('x') }, 'fn').name('翻转 X 180°');
fWeapon.add({ fn: () => flipBossWeapon('z') }, 'fn').name('翻转 Z 180°');
fWeapon.add({ fn: () => { bossWeapon.x = -100; bossWeapon.y = 0; bossWeapon.z = -90; bossWeapon.roll = 0; bossWeapon.grip = 0.10; syncGUI(); applyBossWeapon(); } }, 'fn').name('恢复默认');

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
  // 不能写 -999：那会让 logicFrame - lastMoveFrame 恒大于 gapFrames，
  // 开局的 90 帧等待直接失效，Boss 第 0 帧就会出手（表现为一加载就前冲一下）。
  AI.lastMoveFrame = 0;
  AI.gapFrames = 90;
  STAGE.setPhase(1);
  if (typeof snapCamera === 'function') snapCamera();
  AI.cooldowns = {};
  rng = mulberry32(0xC0FFEE);
  logicFrame = 0;
  hitstopFrames = 0;
  shakeAmt = 0;
  vfx.clear();
  boss.stunMarks = [];
  boss.armorUntil = -1;
  scratch.clear();
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
  // 玩家用 main 新增的 player 动画模型；Boss 用本地最新的 boss_model
  const pUrl = graybox ? null : (q.get('p') ?? 'assets/player/player.glb');
  // Boss 换成 boss(1).zip 里那套 FBX 转出来的模型（顶点已按旧模型校正到同一尺度）；
  // 旧的 182MB boss_model.glb 保留着，想对比用 ?b=assets/boss_model.glb
  const bUrl = graybox ? null : (q.get('b') ?? 'assets/boss_model_v2.glb');
  const wantWeapon = !graybox && q.get('noweapon') == null;
  const weaponUrl = wantWeapon ? (q.get('wp') ?? 'assets/jian_min.glb') : null;
  // Boss 单独一把武器：默认巨剑，?bwp=... 可覆盖，?bwp=none 回到和玩家同一把剑
  // Boss 武器：巨剑（assets/greatsword.glb）。想换回镰刀用 ?bwp=assets/scythe.glb
  const bossWeaponUrl = !wantWeapon ? null : (q.get('bwp') === 'none' ? weaponUrl : (q.get('bwp') ?? 'assets/greatsword.glb'));
  const wantAnim = !graybox && q.get('anim') !== '0';
  if (!pUrl && !bUrl) return;

  try {
    const { bindModel, loadAnimationPack, loadClipPack, loadClipJSON, dampenArmSwing } = await import('./asset-adapter.js');
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
        // player.glb 自身朝向与游戏约定一致，不需要额外修正
        yawOffset: Number(q.get('py') ?? 0),
      }) : null,
      bUrl ? bindModel(boss, bUrl, {
        renderer,
        targetHeight: Number(q.get('bh') ?? 1.95),
        boneFit: true,   // 这套 FBX 模型要按骨骼量身高
        // Boss 的巨剑：等比缩放（默认开），长轴本来就是 Y，不需要转轴
        // 原始尺寸 0.98 长 / 0.30 宽，细端（刀柄）在 -Y，等比缩放到 2.00 m
        weaponModel: bossWeaponUrl,
        weaponOpts: bossWeaponUrl ? {
          length: Number(q.get('bwl') ?? 2.00),
          alignAxis: q.get('bwax') ?? 'y',
          gripEnd: Number(q.get('bwgrip') ?? -1),
          gripShift: Number(q.get('bwshift') ?? 0.08),
          palmOffset: Number(q.get('bwpalm') ?? 0.06),
          palmSide: Number(q.get('bwside') ?? -0.05),
          uniform: q.get('bwuni') !== '0',
          roll: Number(q.get('bwroll') ?? 0),
          // 这组角度是给镰刀调的（绕手骨 X ≈ -100°）。巨剑沿用同一套握持姿态，
          // 若看着歪了用 ?bwrot= 覆盖，例如 ?bwrot=-1.57,0,-1.57
          rotation: q.get('bwrot') ? q.get('bwrot').split(',').map(Number) : [-100 * Math.PI / 180, 0, -Math.PI / 2],
        } : undefined,
        weapon: (!bossWeaponUrl && wantWeapon) ? { length: Number(q.get('bwl') ?? 2.4) } : null,
        scale: Number(q.get('bs') ?? 1),
        // ★ 这套 Boss 模型（FBX→GLB）正面就是 +Z，和玩家那套 Tripo（+X）不一样。
        //   实测静止姿态：脚→脚趾向量 atan2(x, z) ≈ 1.3°，所以修正量取 0。
        //   沿用 -90° 会让 Boss 侧身 90° 朝人走，看起来「面朝侧面」。
        yawOffset: Number(q.get('by') ?? 0),
      }) : null,
    ].filter(Boolean));

    // 把实际加载到的武器角度同步进调参面板（用 ?bwrot= 覆盖时也对得上）
    const wg0 = boss.binder && boss.binder.weaponGroup;
    if (wg0) {
      bossWeapon.x = Math.round(wg0.rotation.x / DEG2RAD);
      bossWeapon.y = Math.round(wg0.rotation.y / DEG2RAD);
      bossWeapon.z = Math.round(wg0.rotation.z / DEG2RAD);
      const w0 = wg0.userData && wg0.userData.weapon;
      if (w0) {
        bossWeapon.roll = Math.round(w0.rollGroup.rotation.y / DEG2RAD);
        if (typeof w0.getGripShift === 'function') bossWeapon.grip = w0.getGripShift();
      }
      syncGUI();
    }

    // 追加类魂动作包（13 条 Mixamo 动捕，骨骼名同源，不需要 retarget）
    if (wantAnim) {
      banner('加载动作包…', 1200);
      const actors = [player, boss].filter((a) => a.binder);
      const counts = await Promise.all(actors.map((a) => loadAnimationPack(a.binder)));

      // Boss 用自带动作包（assets/boss_anims.glb，同一套 Tripo 骨架，直接播）
      let bossPicked = 0;
      if (boss.binder) {
        try {
          bossPicked = await loadClipPack(boss.binder, 'assets/boss_anims.glb', {
            map: {
              cry: 'cry',
              walk: 'walk',
              slash: 'slash',
              chop: 'chop',
              cast: 'cast_a_spell',
              hit: 'hit_to_body_01',
              dead: 'defeat_03',
            },
            autoSlice: ['slash', 'chop'],
          });
        } catch (e) {
          console.warn('[boss-anim] 自带动作包加载失败，回退 Mixamo:', e);
        }

        // boss动作/ 里的动作（FBX / GLB → 轨道 JSON），按骨骼名直接套（raw）
        // 走路沿用原文件，其余全部来自 boss动作/
        const jsonClips = [
          ['walk', 'assets/anims/走路.json', false],
          ['hit', 'assets/anims/受击.json', false],
          ['block', 'assets/anims/格挡.json', false],
          ['sweep', 'assets/anims/转身横扫.json', false],
          ['dead', 'assets/anims/死亡.json', false],
          ['combo1', 'assets/anims/连招1.json', false],   // boss连招1.glb
          ['combo2', 'assets/anims/连招2.json', false],   // boss连招2.glb
        ];
        for (const [name, url, slice] of jsonClips) {
          try {
            await loadClipJSON(boss.binder, url, { name, slice, raw: true });
          } catch (e) {
            console.warn('[boss-anim] JSON 动作加载失败:', name, e);
          }
        }
        console.log('[boss-anim] JSON 动作已覆盖:', jsonClips.map((c) => c[0]).join(','));

        if (bossPicked > 0) {
          Object.assign(boss.binder.clipMap, {
            idle: 'Idle',
            walk: 'walk',
            move: 'walk',
            moveback: 'walk',
            blockmove: 'walk',
            block: 'block',
            b_sweep: 'combo1',
            b_slam: 'combo2',
            // b_roar 已移除（动作取消）
            hitstun: 'hit',
            guardbreak: 'hit',
            dead: 'dead',
          });
          console.log('[boss-anim] 自带动作包已接管 Boss，clip 数:', bossPicked);
        }
      }

      // Boss 走路摆臂太大：只保留 25% 摆幅（?barm=0 锁死手臂，?barm=1 复原）
      // 只处理移动类剪辑，攻击/翻滚/受击的甩臂原样保留。
      const armFactor = Number(q.get('barm') ?? 0.25);
      if (boss.binder && armFactor < 1) {
        const n = dampenArmSwing(boss.binder.clips, ['Walking', 'Running'], armFactor);
        console.log('[anim-pack] boss 摆臂压缩轨迹数:', n, 'factor:', armFactor);
      }
      console.log('[anim-pack] clips loaded per actor:', counts);
    }

    // 武器长度按体型重新标定（换模型后骨骼尺度变了）
    const wl = Number(q.get('bwl') ?? 2.10);
    const realWl = fitWeaponLength(boss, wl);
    if (realWl) console.log('[boss-weapon] 武器长度校准为', realWl, 'm');

    // Boss 手臂略短一点：默认 0.92，?armlen= 可覆盖（1 = 原样）
    const armLen = Number(q.get('armlen') ?? 0.92);
    if (armLen > 0.1 && armLen !== 1) {
      const n = setArmLength(boss, armLen);
      console.log('[boss-arm] 缩短手臂骨骼:', n, 'factor:', armLen);
    }

    setupDragWeapon();
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
// GPU 探测：运行时读，不是写死的。不同机器会得到不同结果。
window.__gpuInfo = (() => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer0 = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const vendor0 = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  return { renderer: String(renderer0 || ''), vendor: String(vendor0 || ''), masked: !dbg, webgpu: 'gpu' in navigator };
})();
window.__gpu = window.__gpuInfo.renderer || 'unknown';

window.__dbg = { player, boss, CFG, MOVES, camera, scene, AI };
window.__dbg = { player, boss, CFG, MOVES, camera, scene, AI, vfx, scratch, armor: { registerBossStun, bossArmored } };

// 启动时校验一遍帧数据上限，越界的招式直接打到 console
const frameIssues = validateAll();

resetFight();
applyQuality(qualityName);

// 设置页（Esc / 右下角齿轮）
const settings = createSettings({
  sharpen, syncSharpen, bloom, smaa, fxaa,
  renderer, composer, gtao, camera, scene, STAGE, CFG,
  gpuName: window.__gpu,
  keymap: ACTION_KEYS,
  defaultKeys: DEFAULT_KEYS,
  onKeymapChange: rebuildKeymap,
  onPreset: (name) => { qualityName = name; },
});
window.__settingsApi = settings;
settings.bind();
// 预编译所有材质的着色器，避免第一次看到某个物体时卡一下
renderer.compile(scene, camera);
snapCamera();
requestAnimationFrame(loop);
banner(frameIssues.length ? `帧数据越界 ${frameIssues.length} 项 · 见 console` : '按 J 开打', 1800);
