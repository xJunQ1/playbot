import * as THREE from 'three';
import GUI from 'lil-gui';
import { CFG, MOVES, LIMITS, GRAB_TIMING, totalFrames, motionAt, dumpJSON, moveIssues, validateAll } from './frame-data.js';
import { makeFighter, createViz, placeViz, applyPose } from './graybox.js';
import { buildStage, updateStage, ARENA_R } from './arena/stage.js';
import { createSettings } from './settings.js';
import { createBossIntro, tintBossFace } from './boss-intro.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { DEATH_POSE_FRAMES, poseFor } from './pose.js';
import { FootIK } from './footik.js';
import { MeleeVFX, VFX_CFG } from './vfx/melee.js';
import { guardFromAO } from './vfx/ao-guard.js';
import { GroundScratch } from './vfx/scratch.js';
import { PerfectDodgeEffect } from './vfx/perfect-dodge.js';
import { UltimateEffect } from './vfx/ultimate.js';
import { ULTIMATE_END, ULTIMATE_CANCEL_FROM, ULTIMATE_CAMERA_RETURN, ULTIMATE_CUTS, ULTIMATE_KICKS, ULTIMATE_STAGGER,
  FINISHER, createUltimateCast, ultimateStep, ultimateSourceFrame, ultimateFallbackPose, startFinisher, finisherRun,
  loadPlayerUltimate, loadNativeClip } from './ultimate.js';
import { METEOR, meteorFrame, newMeteorSmash, updateMeteorSmash } from './meteor-smash.js';
import { BossSmashEffect } from './vfx/boss-smash.js';
import { clampToWall, launchContact, grabPoint, grabGetUpProgress, grabRecoveryFrames, grabWallCameraFocus, grabBossAnimation, grabPlayerAnimation, restoreGrabJoints, poseBossGrab, poseGrabVictim, swordGripPose } from './grab-combo.js';

// ═══════════════════════════════════════════════════════════════
//  0.0 调参持久化（帧数据 / 全局 CFG / 特效）
//  · 服务端：GET/POST /api/tuning → data/tuning.json（serve.mjs 提供）
//  · 本地兜底：localStorage，服务端不可用也不会丢
//  · 调完自动保存（1s 内检测到变化就写盘），重启浏览器/Electron 后自动回填
// ═══════════════════════════════════════════════════════════════
const TUNING_KEY = 'souls-tuning-v1';
const grabTestMode = new URLSearchParams(location.search).get('grabTest') === '1';
// 招式表的「代码版本指纹」：只要 frame-data.js 里的招式数值改过，旧存档里的招式数值就自动作废，
// 避免"改了代码但存档把旧数字盖回去"这种坑
// 特效参数也做同样的指纹校验：代码里改了默认值，旧存档里的 vfx 就不再覆盖
const VFX_REV = (() => {
  let h = 2166136261;
  const s = JSON.stringify(VFX_CFG);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
})();

function moveRevision(moves) {
  let h = 2166136261;
  const s = JSON.stringify(moves);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
const MOVES_REV = moveRevision(MOVES);
const PRE_METEOR_DESCENT_REV = moveRevision({
  ...MOVES, b_meteor: { ...MOVES.b_meteor, startup: METEOR.impact },
});
// 新增招式时，上一版的调参存档仍适用于原有招式。
const preMeteorMoves = Object.entries(MOVES).filter(([id]) => id !== 'b_meteor');
const PRE_METEOR_MOVES_REV = moveRevision(Object.fromEntries(preMeteorMoves));
const priorMoves = Object.fromEntries(preMeteorMoves.filter(([id]) => id !== 'b_grab'));
const PRIOR_MOVES_REV = moveRevision(priorMoves);
const GRAB_TEST_MOVES_REV = '5ca4ea42'; // Finalized grab recovery is longer than this save format's default.
const PRE_POISE_REVISIONS = ['1f85fb6a', 'c596bfa4', 'bcbe563f'];
const BOSS_POISE_UPDATED = new Set(['b_sweep', 'b_slam', 'b_heavy_combo']);
const ORIGINAL_GRAB_MOVES_REV = 'ac84b67d'; // 旧擒拿配置的命中范围不在存档字段内。
const LEGACY_MOVES_REV = moveRevision(Object.fromEntries(Object.entries(priorMoves)
  .filter(([id]) => id !== 'b_heavy_combo')));
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
  const revOk = !data || !data.moves || [MOVES_REV, PRE_METEOR_DESCENT_REV, PRE_METEOR_MOVES_REV, GRAB_TEST_MOVES_REV, ORIGINAL_GRAB_MOVES_REV, PRIOR_MOVES_REV, LEGACY_MOVES_REV, ...PRE_POISE_REVISIONS].includes(data.rev);
  if (!revOk) {
    console.warn(`[tuning] 招式表代码已更新（rev ${data.rev} → ${MOVES_REV}），旧存档的招式数值作废，改用代码里的数字`);
  }
  if (revOk && data?.moves && data.rev !== MOVES_REV) {
    for (const id of BOSS_POISE_UPDATED) {
      if (data.moves[id]?.poise === 0) delete data.moves[id].poise;
    }
  }
  if (data?.rev === PRE_METEOR_DESCENT_REV && data.moves?.b_meteor?.startup === METEOR.impact) {
    delete data.moves.b_meteor.startup;
  }
  const savedGrab = revOk ? data?.moves?.b_grab : null;
  if (typeof savedGrab?.recovery === 'number' && savedGrab.recovery < GRAB_TIMING.recover) {
    savedGrab.recovery = GRAB_TIMING.recover;
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
  if (grabTestMode) return;
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
  if (grabTestMode) return;
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
let atTitle = !grabTestMode && !QS.has('debug') && QS.get('autostart') !== '1';
const titleScreen = document.getElementById('titleScreen');
const startButton = document.getElementById('startGame');
const exitToTitle = document.getElementById('exitToTitle');
function setTitleVisible(visible) {
  atTitle = visible;
  titleScreen.hidden = !visible;
  document.body.classList.toggle('on-title', visible);
  exitToTitle.hidden = visible || grabTestMode;
}
titleScreen.hidden = !atTitle;
document.body.classList.toggle('on-title', atTitle);
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
// The heat ripple warps the finished frame, including the swords and sparks.
const dodgeEffect = new PerfectDodgeEffect(scene);
const ultimateEffect = new UltimateEffect(scene);
const bossSmashEffect = new BossSmashEffect(scene, STAGE.impactSurface);
composer.addPass(bossSmashEffect.pass);
composer.addPass(dodgeEffect.pass);
composer.addPass(vfx.guardImpact.pass);

// ── 画质档位：低 / 中 / 高，F4 键循环
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
}
addEventListener('keydown', (e) => {
  if (e.code === 'F4' && !e.repeat && !KEYMAP[e.code] &&
      !document.getElementById('settings').classList.contains('open')) {
    e.preventDefault();
    const order = ['low', 'mid', 'high'];
    const next = order[(order.indexOf((window.__settingsApi?.state().preset) || qualityName) + 1) % order.length];
    if (window.__settingsApi) window.__settingsApi.applyPreset(next);
    else applyQuality(next);
    banner(`画质 · ${QUALITY[next].label}`, 900);
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
  light: ['Mouse0'], heavy: ['KeyF'], block: ['Mouse2'], lock: ['Mouse1'], ultimate: ['KeyQ'],
};
const ACTION_KEYS = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('souls-demo-keys') || 'null');
    if (saved && typeof saved === 'object') {
      if (!localStorage.getItem('souls-demo-keys-v2')) {
        for (const [action, old] of Object.entries({ light: 'KeyJ', heavy: 'KeyK', block: 'KeyL' })) {
          const next = DEFAULT_KEYS[action][0];
          if (saved[action]?.length === 1 && saved[action][0] === old &&
              !Object.values(saved).some(codes => codes.includes(next))) saved[action] = [next];
        }
      }
      if (!Object.hasOwn(saved, 'ultimate')) {
        for (const [action, codes] of Object.entries(saved)) {
          if (Array.isArray(codes)) saved[action] = codes.filter(code => code !== 'KeyQ');
        }
      }
      return Object.assign({}, DEFAULT_KEYS, saved);
    }
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
  try { localStorage.setItem('souls-demo-keys', JSON.stringify(ACTION_KEYS)); localStorage.setItem('souls-demo-keys-v2', '1'); } catch (e) { /* 忽略 */ }
}
rebuildKeymap();

let grabSequence = null;
let bossIntro = null;
const canvas = renderer.domElement;
const settingsOpen = () => document.getElementById('settings').classList.contains('open');
function press(code) {
  if (bossIntro || player.state === 'dead' || keys.has(code)) return;
  keys.add(code);
  const action = KEYMAP[code];
  if (action === 'lock') player.lockOn = !player.lockOn;
  else if (action && !grabSequence) pressedAt[action] = logicFrame;
}
function clearBufferedInput() {
  for (const action of Object.keys(pressedAt)) delete pressedAt[action];
}
function clearInput() {
  keys.clear();
  clearBufferedInput();
}
addEventListener('keydown', (e) => {
  if (!combatReady || settingsOpen() || window.__recordingKey) return;
  if (grabTestMode && e.code === 'KeyG') {
    e.preventDefault();
    if (!e.repeat && !gui.domElement.contains(document.activeElement)) startGrabTest();
    return;
  }
  if (grabTestMode && e.code === 'Tab' && document.pointerLockElement === canvas) {
    e.preventDefault();
    document.exitPointerLock();
    return;
  }
  if (KEYMAP[e.code]) e.preventDefault();
  if (!e.repeat) press(e.code);
  if (e.code === 'F1') { CFG.showHitbox = !CFG.showHitbox; syncGUI(); }
  if (e.code === 'F2') { CFG.timeScale = CFG.timeScale === 1.0 ? 0.25 : 1.0; syncGUI(); }
  if (e.code === 'F3') { CFG.paused = !CFG.paused; syncGUI(); }
  if (e.code === 'KeyR') { resetFight(); }
  if (e.code === 'KeyP') { downloadJSON(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => {
  if (!combatReady || settingsOpen() || CFG.paused) return;
  e.preventDefault();
  if (!document.pointerLockElement) canvas.requestPointerLock?.()?.catch(() => {});
  press('Mouse' + e.button);
});
addEventListener('mouseup', e => keys.delete('Mouse' + e.button));
addEventListener('blur', clearInput);
let hadPointerLock = false;
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (hadPointerLock && !locked) {
    clearInput();
    if (combatReady && !grabTestMode && !settingsOpen()) settings.open(true);
  }
  hadPointerLock = locked;
});
canvas.addEventListener('mousemove', e => {
  if (!combatReady || settingsOpen() || CFG.paused || player.lockOn || bossIntro ||
      (ultimateCast && !ultimateCast.cameraReturned)) return;
  const speed = 0.0025 * settings.state().sensitivity;
  const deltaYaw = -e.movementX * speed;
  if (railOrbit && !grabSequence) railOrbit.mouseYaw += deltaYaw;
  else camYaw = (camYaw + deltaYaw) % (2 * Math.PI);
  camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * speed, -0.26, 1.05);
});

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
    this.poiseRegenAt = 0;
    this.poiseRecoverySlowed = false;
    this.counterUntil = 0;
    this.hurt = hurt;               // { radius, height }
    this.state = 'idle';
    this.moveId = null;
    this.move = null;
    this.frame = 0;
    this.actionSequence = 0;
    this.iframe = 0;
    this.hitSet = new Set();
    this.lockOn = false;
    this.stunTimer = 0;
    this.flashTimer = 0;
    this.footIK = new FootIK();
    this.previousPosition = this.pos.clone();
    this.previousYaw = this.yaw;
    this.previousFrame = this.frame;
    this.previousAction = this.actionSequence;
    scene.add(this.mesh.group);

    // 判定可视化
    this.hitViz = createViz('hit');
    this.hurtViz = createViz('hurt');
    scene.add(this.hitViz, this.hurtViz);
  }

  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  setState(name, moveId = null) {
    this.state = name;
    this.actionSequence++;
    this.grabConnected = false;
    if (name !== 'backstep') this.backstep = null;
    if (name !== 'recover') this.recoveryFrames = 0;
    this.frame = 0;
    this.moveId = moveId;
    this.move = moveId ? MOVES[moveId] : null;
    this.hitSet.clear();
    if (name === 'roll') { this.iframe = CFG.playerIframe; this.rollTotal = CFG.rollTotal; }
  }

  /** 单帧推进：位移 + 计时器 */
  stepMotion(previousFrame = this.frame - 1) {
    if (!this.move) return;
    const d0 = motionAt(this.move, Math.max(0, previousFrame));
    const d1 = motionAt(this.move, this.frame);
    const delta = d1 - d0;
    if (delta !== 0) this.translate(delta);
  }

  translate(dist) {
    const f = this.forward;
    // 将大步拆开，避免快速翻滚或突进一步跨过障碍。
    const steps = Math.max(1, Math.ceil(Math.abs(dist) / this.hurt.radius));
    const step = dist / steps;
    for (let i = 0; i < steps; i++) {
      this.pos.x += f.x * step;
      this.pos.z += f.z * step;
      this.clampToArena();
    }
  }

  /**
   * 圆形台面约束：半径 = 台面半径 − 栏杆 − 自身半径。
   * 沿径向夹住，贴边时顺着圆滑走，不像方形 clamp 那样卡在角上。
   */
  clampToArena() {
    // ① 在障碍的局部平面求最近点。立柱使用半径，倒柱使用有长度和朝向的矩形。
    const clamp = THREE.MathUtils.clamp;
    for (const { x, z, r = 0, axisX = 1, axisZ = 0, halfLength = 0, halfWidth = 0 } of STAGE.obstacles) {
      const dx = this.pos.x - x, dz = this.pos.z - z;
      const along = dx * axisX + dz * axisZ;
      const across = -dx * axisZ + dz * axisX;
      let pushX = along - clamp(along, -halfLength, halfLength);
      let pushZ = across - clamp(across, -halfWidth, halfWidth);
      const clearance = r + this.hurt.radius;
      const distance = Math.hypot(pushX, pushZ);
      if (distance >= clearance) continue;

      if (distance > 1e-4) {
        const push = clearance / distance - 1;
        pushX *= push;
        pushZ *= push;
      } else if (halfLength - Math.abs(along) <= halfWidth - Math.abs(across)) {
        pushX = (along < 0 ? -halfLength - clearance : halfLength + clearance) - along;
        pushZ = 0;
      } else {
        pushX = 0;
        pushZ = (across < 0 ? -halfWidth - clearance : halfWidth + clearance) - across;
      }
      this.pos.x += pushX * axisX - pushZ * axisZ;
      this.pos.z += pushX * axisZ + pushZ * axisX;
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
    let diff = THREE.MathUtils.euclideanModulo(targetYaw - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    diff = THREE.MathUtils.clamp(diff, -maxStep, maxStep);
    this.yaw += diff;
  }

  rememberVisualFrame() {
    this.previousPosition.copy(this.pos);
    this.previousYaw = this.yaw;
    this.previousFrame = this.frame;
    this.previousAction = this.actionSequence;
  }

  samplePosition(alpha, target) {
    return target.lerpVectors(this.previousPosition, this.pos, alpha);
  }

  sampleActionFrame(alpha) {
    return this.previousAction === this.actionSequence
      ? THREE.MathUtils.lerp(this.previousFrame, this.frame, alpha) : this.frame;
  }

  syncMesh(alpha = 1) {
    this.samplePosition(alpha, this.mesh.group.position);
    const yaw = this.previousAction === this.actionSequence ? lerpYaw(this.previousYaw, this.yaw, alpha) : this.yaw;
    this.mesh.group.rotation.set(0, yaw, 0, 'YXZ');
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
    this.poiseRegenAt = 0;
    this.poiseRecoverySlowed = false;
    this.counterUntil = 0;
    this.setState('idle');
    this.moving = false;
    this.speed = 0;
    this.stunTimer = 0;
    this.iframe = 0;
    this.flashTimer = 0;
    this.rememberVisualFrame();
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
  hp: 12800, poise: 600, hurt: { radius: 1.15, height: 4.6 },
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

/** 找到当前判定窗口。连斩每一段各自记录命中。 */
function activeStrike(move, frame) {
  if (!move || move.active <= 0) return null;
  const followUps = move.followUps;
  if (followUps) {
    for (let i = followUps.length - 1; i >= 0; i--) {
      const strike = followUps[i];
      const startup = move.startup + strike.delay;
      if (frame >= startup && frame < startup + strike.active) {
        return { index: i + 1, startup, active: strike.active, swing: strike.swing ?? move.swing };
      }
    }
  }
  if (frame < move.startup || frame >= move.startup + move.active) return null;
  return { index: 0, startup: move.startup, active: move.active, swing: move.swing };
}

function activeHitbox(actor) {
  const m = actor.move;
  const strike = activeStrike(m, actor.frame);
  if (!strike) return null;
  if (m.meteor) {
    if (!meteorSmash?.target || meteorSmash.ownerAction !== actor.actionSequence || actor.frame !== m.startup) return null;
    return {
      strike, center: meteorSmash.target, radius: METEOR.radius - player.hurt.radius * player.scale,
      yMin: 0, yMax: m.hitbox.yMax,
    };
  }
  const f = actor.forward;
  const center = actor.pos.clone().addScaledVector(f, m.hitbox.offset * actor.scale);
  return {
    strike,
    center,
    radius: m.hitbox.radius * actor.scale,
    yMin: m.hitbox.yMin * actor.scale,
    yMax: m.hitbox.yMax * actor.scale,
  };
}

const PERFECT_DODGE_FRAMES = 10;
const PERFECT_DODGE_SLOW_SECONDS = .44;
const ULTIMATE_MAX = 100;
const ULTIMATE_PARRY_GAIN = 25;
const ULTIMATE_DODGE_GAIN = 20;
const GUARD_HOLD_COST = .30;
const BOSS_GUARD_HOLD_COST = .18;
const PARRY_WINDOW = 8;
const DODGE_POISE_RETURN = 12;
const PARRY_POISE_RETURN = 10;
const LIGHT_POISE_RETURN = 8;
const PARRY_POISE_DAMAGE = 26;
const COUNTER_WINDOW = 72;
const COUNTER_POISE_MULTIPLIER = 1.5;
const DEFENSE_REGEN_DELAY = 42;
const DEFENSE_REGEN_RATE = .53;
const HIT_POISE_REGEN_DELAY = 90;
const HIT_POISE_REGEN_RATE = .24;
let ultimateCast = null, releasedUltimate = null, playerUltimateMotion = null;
let meteorSmash = null;
const ultimateDelta = new THREE.Vector3();
const waveStartProbe = new THREE.Vector3(), waveEndProbe = new THREE.Vector3();
const waveSweep = new THREE.Line3(waveStartProbe, waveEndProbe);
const ultimateTarget = new THREE.Vector3();
const POISE_BREAK_FRAMES = { player: 44, boss: 96 };
const rollSweep = new THREE.Line3();
const dodgeProbe = new THREE.Vector3();
const dodgeGrabOffset = new THREE.Vector3();
let perfectDodgeFrame = null;
let dodgeSlowTime = 0;
let dodgeVisualAlpha = 1;

function dodgeProgress() {
  return PERFECT_DODGE_SLOW_SECONDS - dodgeSlowTime;
}

function dodgeTimeScale() {
  const elapsed = dodgeProgress();
  const { smoothstep } = THREE.MathUtils;
  const strength = smoothstep(elapsed, 0, .037) * (1 - smoothstep(elapsed, .175, PERFECT_DODGE_SLOW_SECONDS));
  return 1 - .64 * strength;
}

function dodgePoseAlpha() {
  if (dodgeSlowTime <= 0 || grabSequence || hitstopFrames > 0) return 1;
  const { clamp, lerp, smoothstep } = THREE.MathUtils;
  const elapsed = dodgeProgress();
  const blend = smoothstep(elapsed, 0, .042) * (1 - smoothstep(elapsed, .318, PERFECT_DODGE_SLOW_SECONDS));
  return lerp(1, clamp(acc / STEP, 0, 1), blend);
}
let ultimateEnergy = 0;

function addUltimateEnergy(amount) {
  ultimateEnergy = Math.min(ULTIMATE_MAX, ultimateEnergy + amount);
}

function confirmPerfectDodge() {
  perfectDodgeFrame = player.frame;
  dodgeSlowTime = PERFECT_DODGE_SLOW_SECONDS;
  addUltimateEnergy(ULTIMATE_DODGE_GAIN);
  restorePlayerPoise(DODGE_POISE_RETURN, .94);
  player.counterUntil = logicFrame + COUNTER_WINDOW;
  if (VFX_CFG.enabled) dodgeEffect.trigger(rollSweep.start, player.forward);
  banner('完美闪避', 690, 'dodge');
}

function resolveHit(attacker, defender, hb) {
  if (!hb || attacker.state === 'dead' || defender.state === 'dead') return;
  if (defender === player && grabSequence) return;
  const hitKey = hb.strike.index + ':' + defender.name;
  if (attacker.hitSet.has(hitKey)) return;
  const perfectWindow = defender === player && player.state === 'roll' &&
    player.iframe > 0 && perfectDodgeFrame === null && player.frame < PERFECT_DODGE_FRAMES;
  if (defender.iframe > 0 && !perfectWindow) return;

  const hurtY = defender.pos.y;
  const hurtY1 = hurtY + defender.hurt.height * defender.scale;
  const hurtR = defender.hurt.radius * defender.scale;
  // The player may cross the rim of the attack volume in the same frame.
  const target = perfectWindow && rollSweep.distanceSq() > 1e-8
    ? rollSweep.closestPointToPoint(hb.center, true, dodgeProbe)
    : defender.pos;
  if (!cylinderHit(hb.center, hb.radius, hb.yMin, hb.yMax, target, hurtR, hurtY, hurtY1)) return;

  const grab = attacker === boss && attacker.move.grab;
  if (grab && attacker.forward.dot(dodgeGrabOffset.copy(target).sub(attacker.pos)) <= 0) return;
  if (perfectWindow) {
    attacker.hitSet.add(hitKey);
    confirmPerfectDodge();
    return;
  }
  if (grab) {
    attacker.hitSet.add(hitKey);
    capturePlayer();
    return;
  }
  attacker.hitSet.add(hitKey);
  if (defender.state !== 'block') vfx.hit(attacker, defender, hb);
  applyDamage(attacker, defender, attacker.move);
}

// ── Boss 超霸体 ──────────────────────────────────────────────
// 2 秒内连续受击 5 次 → 触发「超霸体」，持续 10 秒。
//   超霸体期间：不产生受击僵直（血量照扣），出招也不会延长超霸体。
// 出招时普通命中无法打断 Boss，成功弹反单独结算。
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

function finishDeath(actor, frame = 0) {
  if (actor.hp > 0 || actor.state === 'dead') return;
  actor.hp = 0;
  actor.setState('dead');
  actor.frame = frame;
  actor.moving = false;
  actor.speed = 0;

  if (actor === player) {
    clearInput();
    player.lockOn = false;
    if (boss.state !== 'dead') {
      boss.setState('idle');
      boss.moving = false;
      boss.speed = 0;
    }
  }
  banner(actor === player ? '你死了' : '击败首领', 2200, actor === player ? 'defeat' : 'victory');
}

function restorePlayerPoise(amount, limit = 1) {
  const restored = Math.min(amount, Math.max(0, player.maxPoise * limit - player.poise));
  player.poise += restored;
  if (player.poise >= player.maxPoise) player.poiseRecoverySlowed = false;
}

function regeneratePlayerPoise() {
  const canRecover = ['idle', 'move', 'roll', 'light1', 'light2', 'light3', 'light4'].includes(player.state);
  if (canRecover && logicFrame >= player.poiseRegenAt) {
    restorePlayerPoise(player.poiseRecoverySlowed ? HIT_POISE_REGEN_RATE : DEFENSE_REGEN_RATE);
  }
}

function damagePoise(actor, amount, minimumStun = 0, fromHit = false) {
  if (actor.state === 'guardbreak' || actor.state === 'dead') return false;
  const loss = THREE.MathUtils.clamp(amount, 0, actor.poise);
  actor.poise -= loss;
  if (actor === player && loss > 0) {
    const delay = fromHit ? HIT_POISE_REGEN_DELAY : DEFENSE_REGEN_DELAY;
    actor.poiseRegenAt = Math.max(actor.poiseRegenAt, logicFrame + delay);
    if (fromHit) actor.poiseRecoverySlowed = true;
  }
  if (actor.poise > 0 || actor.hp <= 0) return false;

  const duration = actor.isBoss ? POISE_BREAK_FRAMES.boss : POISE_BREAK_FRAMES.player;
  actor.setState('guardbreak');
  actor.stunTimer = Math.max(duration, minimumStun);
  actor.moving = false;
  actor.speed = 0;
  if (actor === player) {
    actor.counterUntil = 0;
    clearBufferedInput();
  }
  banner(actor.isBoss ? '首领破势' : '架势崩溃', 680);
  return true;
}

function stepPoiseBreak(actor) {
  const frames = ++actor.frame;
  const refill = actor.maxPoise * (actor.isBoss ? 1 : .55);
  if (frames < actor.stunTimer) {
    if (!actor.isBoss) actor.poise = Math.max(actor.poise, refill * frames / actor.stunTimer);
    return;
  }
  actor.poise = refill;
  if (!actor.isBoss) actor.poiseRegenAt = Math.max(actor.poiseRegenAt, logicFrame);
  actor.stunTimer = 0;
  actor.setState('idle');
}

function applyDamage(attacker, defender, move) {
  if (defender === player && player.state === 'block') {
    if (player.frame <= PARRY_WINDOW) {
      if (!damagePoise(boss, PARRY_POISE_DAMAGE)) {
        boss.setState('parried');
        boss.stunTimer = 32;
        boss.moving = false;
        banner('弹反 · 反击窗口', 650);
      }
      addUltimateEnergy(ULTIMATE_PARRY_GAIN);
      restorePlayerPoise(PARRY_POISE_RETURN, .94);
      player.counterUntil = logicFrame + COUNTER_WINDOW;
      player.iframe = 20;
      shake(0.14);
      hitstop(HITSTOP_HEAVY());
      vfx.parry(player, attacker, guardContact(player, attacker));
      return;
    }

    const pressure = move.poise * 1.45;
    const spill = Math.max(0, pressure - player.poise);
    if (spill > 0) defender.hp = Math.max(0, defender.hp - move.damage * .42 * spill / pressure);
    damagePoise(defender, pressure, 0, true);
    shake(0.05);
    hitstop(HITSTOP_LIGHT());
    vfx.guard(player, attacker, guardContact(player, attacker));
    flash(defender);
    finishDeath(defender);
    return;
  }

  const counter = attacker === player && defender === boss && logicFrame < player.counterUntil;
  if (counter) player.counterUntil = 0;
  if (defender === boss && boss.state === 'block' && !counter) {
    defender.hp = Math.max(0, defender.hp - move.damage * .30);
    damagePoise(defender, move.poise * .80);
    defender.flashTimer = 3;
    shake(0.05);
    hitstop(HITSTOP_LIGHT());
    vfx.guard(boss, attacker, guardContact(boss, attacker));
    finishDeath(defender);
    return;
  }

  const vulnerable = defender.state === 'guardbreak';
  const dmg = move.damage * (vulnerable ? (defender.isBoss ? 1.4 : 1.25) : 1);
  defender.hp = Math.max(0, defender.hp - dmg);
  const existingStun = ['parried', 'ultimateStun'].includes(defender.state) ? defender.stunTimer - defender.frame : 0;
  const shattered = damagePoise(defender, move.poise * (counter ? COUNTER_POISE_MULTIPLIER : 1),
    existingStun, defender === player && dmg > 0);
  if (attacker === player && defender === boss && attacker.state.startsWith('light') && dmg > 0) {
    restorePlayerPoise(LIGHT_POISE_RETURN);
  }
  if (defender === player && dmg > 0) player.counterUntil = 0;
  if (counter && !shattered) banner('反击削韧', 480);
  // Boss 霸体判定：
  //   · 超霸体生效中 → 不产生受击僵直
  //   · 正在出招     → 整段攻击都是霸体，不会被打断
  // 两种情况血量都照扣。
  // 反击照常结算伤害和削韧，保留正在进行的弹反硬直。
  const bossParried = defender === boss && (defender.state === 'parried' || defender.state === 'ultimateStun');
  const poiseBroken = defender.state === 'guardbreak';
  const bossImmune = defender === boss && (bossParried || poiseBroken || registerBossStun());
  const bossAttacking = defender === boss && boss.state === 'attack';
  const canStagger = !poiseBroken && !bossImmune && !bossAttacking;
  if (defender.hp > 0 && canStagger) {
    defender.setState('hitstun');
    defender.stunTimer = move.hitstun;
  }
  defender.flashTimer = 4;

  // Boss 挨打记账：越打越凶。复仇窗口内间隔缩短、只进攻、优先快招。
  if (defender === boss) {
    AI.revengeHits = (AI.revengeHits || 0) + 1;
    AI.revengeUntil = logicFrame + 80 + AI.revengeHits * 12;   // 1.3s 起，连击越久越凶
  }

  shake(0.06 + dmg / 4000);
  hitstop(dmg > 200 ? HITSTOP_HEAVY() : HITSTOP_LIGHT());
  flash(defender);

  finishDeath(defender);
}

function flash(a) { a.flashTimer = 4; }

// ═══════════════════════════════════════════════════════════════
//  5. 玩家状态机
// ═══════════════════════════════════════════════════════════════
function screenBasis() {
  // 栏杆避让只调整镜头构图，移动和翻滚沿用鼠标控制的视角方向。
  const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  if (player.lockOn) {
    const target = boss.pos.clone().sub(player.pos).setY(0);
    if (target.lengthSq() > 1e-4) fwd.copy(target.normalize());
  }
  return { fwd, right: new THREE.Vector3(-fwd.z, 0, fwd.x) };
}

function tryUltimate() {
  if (boss.state === 'dead' || !consume('ultimate', 15)) return false;
  if (ultimateEnergy < ULTIMATE_MAX) return false;

  ultimateEnergy = 0;
  ultimateCast = createUltimateCast(player, boss, camYaw, camPitch, playerUltimateMotion);
  player.yaw = Math.atan2(ultimateCast.forward.x, ultimateCast.forward.z);
  player.setState('ultimate');
  player.moving = false;
  player.speed = 0;
  clearBufferedInput();
  banner('银弧连斩', 920, 'ultimate');
  return true;
}

function strikeUltimate(cast, cut) {
  const finisher = cut === FINISHER;
  cast.hits++;
  boss.hp = Math.max(0, boss.hp - cut.damage * (boss.state === 'guardbreak' ? 1.4 : 1));
  if (boss.hp > 0) {
    const hold = finisher ? 58 : ULTIMATE_STAGGER;
    damagePoise(boss, finisher ? 25 : cut.poise ?? 10, hold);
    if (boss.state === 'guardbreak') boss.stunTimer = Math.max(boss.stunTimer, boss.frame + hold);
    else {
      boss.setState('ultimateStun');
      boss.stunTimer = hold;
    }
    boss.moving = false;
    boss.speed = 0;
  }
  flash(boss);
  shake(finisher ? .18 : .043);
  hitstop(finisher ? 4 : 1);
  finishDeath(boss);
}

function resolveUltimateCuts(cast) {
  const frame = player.frame;
  if (frame === FINISHER.hit && !cast.wave) {
    startFinisher(cast, player.pos);
    cast.wave.firedAt = logicFrame;
    releasedUltimate = cast;
  }
  if (boss.state === 'dead' || boss.iframe > 0 || boss.pos.y > 1.30) return;
  const cut = ULTIMATE_CUTS.find(cut => cut.hit === frame && cut !== FINISHER)
    ?? ULTIMATE_KICKS.find(kick => kick.hit === frame);
  if (!cut) return;
  const delta = ultimateTarget.copy(boss.pos).sub(player.pos).setY(0);
  const reach = cut.reach + Math.min(.60, boss.hurt.radius * boss.scale * .28);
  if (delta.lengthSq() <= reach ** 2 && delta.dot(cast.forward) >= -.62) strikeUltimate(cast, cut);
}

function resolveUltimateWave() {
  const cast = releasedUltimate;
  if (!cast) return;
  const wave = cast.wave;
  const age = logicFrame - wave.firedAt;
  if (age > FINISHER.duration + 10) {
    if (cast.hits === 0 && player.state !== 'dead' && (!ultimateCast || ultimateCast === cast)) {
      banner('大招落空', 600, 'ultimate');
    }
    releasedUltimate = null;
    if (!ultimateCast) ultimateEffect.clear();
    return;
  }
  if (wave.struck || age > FINISHER.duration || boss.state === 'dead' || boss.iframe > 0 || boss.pos.y > 1.30) return;
  const frame = FINISHER.hit + age;
  waveStartProbe.copy(wave.origin).addScaledVector(wave.direction, finisherRun(frame - 1) - .8);
  waveEndProbe.copy(wave.origin).addScaledVector(wave.direction, finisherRun(frame) + 1.05);
  const reach = 1.92 + Math.min(.60, boss.hurt.radius * boss.scale * .28);
  if (waveSweep.closestPointToPoint(ultimateTarget.copy(boss.pos).setY(0), true, ultimateDelta)
    .distanceToSquared(ultimateTarget) <= reach ** 2) {
    wave.struck = true;
    strikeUltimate(cast, FINISHER);
  }
}

function endUltimate(cast) {
  returnUltimateCamera(cast);
  ultimateCast = null;
  if (!releasedUltimate) ultimateEffect.clear();
}

function advanceUltimate() {
  const cast = ultimateCast;
  if (cast) {
    cast.previous = player.frame++;
    if (player.frame < ULTIMATE_END) {
      const buffered = name => logicFrame - (pressedAt[name] ?? -Infinity) <= BUFFER_WINDOW;
      const canCancel = player.frame >= ULTIMATE_CANCEL_FROM &&
        (['fwd', 'back', 'left', 'right'].some(down) || buffered('roll') || buffered('light') ||
          (player.poise > 0 && (down('block') || buffered('block'))) ||
          (player.poise > MOVES.p_heavy.stamina && buffered('heavy')));
      if (!canCancel) {
        player.pos.add(ultimateStep(cast, player.frame, ultimateDelta));
        player.clampToArena();
        return true;
      }
    }
    endUltimate(cast);
    if (cast.hits === 0 && !releasedUltimate) banner('大招落空', 600, 'ultimate');
  }
  player.setState('idle');
  return false;
}

function startPlayerAttack(state, id) {
  const cost = state.startsWith('heavy') ? MOVES[id].stamina : 0;
  if (cost > 0) {
    if (player.poise <= cost) {
      banner('韧性不足', 560);
      return false;
    }
    damagePoise(player, cost);
  }
  player.setState(state, id);
  return true;
}

function playerTick() {
  if (player.flashTimer > 0) player.flashTimer--;
  if (player.state === 'dead') { player.frame++; return; }
  if (grabSequence) { player.frame++; return; }
  if (player.iframe > 0) player.iframe--;

  // 转向：锁定时朝 Boss，否则朝移动方向
  // 注意：翻滚 / 受击期间禁止转向，否则翻滚轨迹会被拉弯
  if (player.lockOn && player.state !== 'roll' && player.state !== 'hitstun' && player.state !== 'guardbreak') {
    const d = boss.pos.clone().sub(player.pos);
    player.turnToward(Math.atan2(d.x, d.z), 16);
  }

  if (player.state === 'ultimate' && advanceUltimate()) return;

  switch (player.state) {

    case 'guardbreak':
      stepPoiseBreak(player);
      return;
    case 'hitstun':
      player.frame++;
      if (player.frame >= player.stunTimer) player.setState('idle');
      return;


    case 'roll': {
      player.frame++;
      // Save this tick's path so an early roll can dodge a hit it just crossed.
      rollSweep.start.copy(player.pos);
      const prev = rollDist(player.frame - 1);
      const cur = rollDist(player.frame);
      player.translate(cur - prev);
      rollSweep.end.copy(player.pos);
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
      // 轻击和重击各自接续对应的连段。
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
        if (link && consume(link[2], 55) && startPlayerAttack(link[0], link[1])) return;
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

      if (!down('block') && player.frame > PARRY_WINDOW) {
        player.setState('idle');
        return;
      }

      // A timed tap has no cost. Holding past the parry window consumes stance.
      if (player.frame > PARRY_WINDOW && damagePoise(player, GUARD_HOLD_COST)) return;

      // 格挡中可取消进翻滚 / 出轻击
      if (tryUltimate()) return;
      if (player.frame > 6 && consume('roll', 6)) { startRoll(); return; }
      if (player.frame > PARRY_WINDOW && consume('light', 6)) { startPlayerAttack('light1', 'p_light1'); return; }
      if (player.frame > PARRY_WINDOW && consume('heavy', 6)) startPlayerAttack('heavy', 'p_heavy');
      return;
    }

    default: {
      // idle / move：接受一切输入
      // 顺序很重要：格挡判定放在移动之后，这样按住 L 的同时还能移动
      if (tryUltimate()) return;
      if (consume('roll')) { startRoll(); return; }
      if (consume('light')) { startPlayerAttack('light1', 'p_light1'); return; }
      if (consume('heavy') && startPlayerAttack('heavy', 'p_heavy')) return;

      // 按住 S 只转一次：必须松开 S 才能再次触发（防止连点/长按导致连续翻身）
      const moved = applyMoveInput(1.0);
      const freshGuard = consume('block');
      if (down('block') || freshGuard) {
        if (player.poise > 0) {
          player.setState('block');
          return;
        }
        if (freshGuard) banner('韧性不足', 560);
      }

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
 * 自由视角按镜头方向移动，锁定时绕 Boss 移动。
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

  player.moveAxis = fwdInput;     // +1 前 / -1 后 / 0 只有横移，给动画选 clip 用
  player.strafeAxis = strafeInput;

  const dir = new THREE.Vector3()
    .addScaledVector(fwd, fwdInput)
    .addScaledVector(right, strafeInput)
    .normalize();

  const { x: startX, z: startZ } = player.pos;
  player.pos.addScaledVector(dir, speed / 60);
  player.clampToArena();

  // 碰撞会吃掉向墙的步长。用实际位移选动画和朝向，贴栏杆时沿边转身。
  const dx = player.pos.x - startX;
  const dz = player.pos.z - startZ;
  const distance = Math.hypot(dx, dz);
  player.moving = distance > 1e-4;
  player.speed = player.moving ? distance * 60 : 0;
  if (!player.moving) return false;

  const targetYaw = player.lockOn
    ? Math.atan2(fwd.x, fwd.z)
    : Math.atan2(dx, dz);
  player.turnToward(targetYaw, player.lockOn ? 16 : 12);
  return true;
}

function rollDist(frame) {
  if (frame <= 0) return 0;
  const t = Math.min(1, frame / 32);
  const step = perfectDodgeFrame === null ? 0
    : .52 * THREE.MathUtils.smoothstep(frame, perfectDodgeFrame, perfectDodgeFrame + 6);
  return CFG.rollDistance * (1 - Math.pow(1 - t, 2.2)) + step;
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
  perfectDodgeFrame = null;
  rollSweep.start.copy(player.pos);
  rollSweep.end.copy(player.pos);
}

// ═══════════════════════════════════════════════════════════════
//  6. Boss：权重轮盘 AI
// ═══════════════════════════════════════════════════════════════
const initialBossAI = () => ({
  recent: [],
  cooldowns: {},
  lastMoveFrame: 0,
  gapFrames: 90,
  punishUntil: 0,
  closeSince: null,
  comboRangeSince: null,
  playerAttack: null,

  // ── 意图层 ──────────────────────────────────────────────
  // 之前 Boss 只有「朝玩家走」和「出招」两个动作，看起来像个只会冲的靶子。
  // 真正的类魂 Boss 大部分时间在「观察、踱步、拉开距离」，攻击只是其中一环。
  // 意图会维持一段时间（40~120 帧）再重选，避免每帧抖动。
  intent: 'approach',      // approach | stalk | retreat | wait
  intentUntil: 0,
  strafeSign: 1,

  // ── 额外的行为槽 ────────────────────────────────────────
  nextBackstep: 0,                    // 后跳冷却
  nextDodge: 0,                       // 对玩家起手做反应的冷却
  nextBlock: 0,
  blockUntil: 0,
  feintChecked: false,                // 本次出招是否已经判过佯攻
  phase2: false,                      // 二阶段是否已触发
  phase3: false,

  // ── 反击意识 ────────────────────────────────────────────
  // Boss 挨打后进入「复仇窗口」：间隔缩短、只进攻不后撤、优先挑起手快的招。
  // 没有这个，Boss 就是个挨打不还手的木桩 —— 玩家可以无脑站桩输出。
  revengeUntil: 0,
  revengeHits: 0,
});
const AI = initialBossAI();
const BOSS_ATTACK_RULES = {
  b_sweep: { preferredRange: [4.1, 5.5], punishFrames: 24 },
  b_slam: { preferredRange: [0, 3.95], punishFrames: 30 },
  b_heavy_combo: { preferredRange: [3.2, 4.35], punishFrames: 36 },
  b_grab: { preferredRange: [4.7, 6.9], punishFrames: 36 },
  b_meteor: { preferredRange: [5.4, 12.0], punishFrames: 42 },
};

function playerWallRadius() {
  return ARENA_R - 1.8 - player.hurt.radius;
}

function lerpYaw(from, to, weight) {
  const delta = to - from;
  return from + Math.atan2(Math.sin(delta), Math.cos(delta)) * weight;
}

function capturePlayer() {
  const move = boss.move;
  boss.grabConnected = true;
  boss.frame = move.startup + move.active;
  const direction = boss.forward;
  grabSequence = {
    phase: 'held', age: 0, direction, origin: player.pos.clone(), damage: move.damage,
    startFrame: logicFrame, initialYaw: player.yaw, caughtYaw: boss.yaw + Math.PI,
  };
  player.yaw = grabSequence.caughtYaw;
  player.setState('grabbed');
  player.moving = false;
  player.speed = 0;
  clearBufferedInput();
  hitstop(3);
  shake(0.08);
}

function grabImpact(damage, strength) {
  player.hp = Math.max(0, player.hp - damage);
  flash(player);
  shake(strength);
  const center = player.pos.clone();
  vfx.hit(boss, player, { center, radius: 0.3, yMin: center.y + 0.50, yMax: center.y + 1.1 });
}

function beginGrabLanding(sequence) {
  sequence.phase = 'wall';
  sequence.age = 0;
  sequence.height = player.pos.y;
  sequence.getUp = player.hp > 0 && !!player.binder?.clipMap.grabGetUp;
  player.setState('wallstun');
}

function advanceGrab() {
  const sequence = grabSequence;
  if (!sequence) return;
  const timing = GRAB_TIMING;
  const { phase, direction } = sequence;
  const age = ++sequence.age;
  if (phase === 'held' || phase === 'toss') {
    if (boss.state === 'dead' || !boss.grabConnected) {
      beginGrabLanding(sequence);
      return;
    }
    const lift = THREE.MathUtils.smoothstep(age, timing.pull, timing.lift);
    const toss = THREE.MathUtils.clamp((age - timing.toss) / (timing.kick - timing.toss), 0, 1);
    const height = 0.52 * lift + Math.sin(toss * Math.PI) * 0.45 + 0.03 * toss;
    const target = grabPoint(boss, direction, 0.23 * (1 - toss), 0.62 + 0.43 * toss, height);
    clampToWall(target, playerWallRadius());
    player.pos.copy(sequence.origin).lerp(target, THREE.MathUtils.smoothstep(age, 0, timing.pull));
    if (age >= timing.toss) sequence.phase = 'toss';
    if (age < timing.kick) return;

    sequence.phase = 'flight';
    sequence.age = 0;
    sequence.origin = player.pos.clone();
    const contact = launchContact(player.pos, direction, playerWallRadius());
    sequence.destination = contact.point;
    sequence.flightFrames = Math.max(1, Math.min(51, Math.ceil(contact.distance * 1.7)));
    sequence.launchCameraYaw = camYaw;
    player.setState('launched');
    grabImpact(sequence.damage, 0.22);
    hitstop(HITSTOP_HEAVY());
    return;
  }
  if (phase === 'flight') {
    const t = Math.min(1, age / sequence.flightFrames);
    player.pos.lerpVectors(sequence.origin, sequence.destination, t);
    const arc = Math.min(1, sequence.flightFrames / 18);
    player.pos.y += (Math.sin(Math.PI * t) * 0.52 - sequence.origin.y * 0.78 * t) * arc;
    if (t < 1) return;

    grabImpact(Math.round(sequence.damage * 0.25), 0.28);
    beginGrabLanding(sequence);
    sequence.wallCameraYaw = camYaw;
    hitstop(5);
    return;
  }
  player.pos.y = sequence.height * (1 - THREE.MathUtils.smoothstep(age, 0, sequence.getUp ? 11 : 9));
  if (player.hp > 0) {
    const dx = boss.pos.x - player.pos.x, dz = boss.pos.z - player.pos.z;
    const targetYaw = player.lockOn && Math.hypot(dx, dz) > 0.01 ? Math.atan2(dx, dz) : sequence.initialYaw;
    player.yaw = lerpYaw(sequence.caughtYaw, targetYaw, grabGetUpProgress(sequence));
  }
  if (age < grabRecoveryFrames(sequence)) return;

  grabSequence = null;
  clearBufferedInput();
  player.pos.y = 0;
  if (player.hp <= 0) {
    finishDeath(player, player.binder ? 0 : DEATH_POSE_FRAMES);
  } else {
    player.setState('idle');
    player.iframe = 8;
  }
}

function tickBossGrab(move) {
  const previousFrame = boss.frame++;
  const trackingFrames = move.aimLockFrames === undefined
    ? Math.max(1, move.startup - 6) : move.startup - move.aimLockFrames;
  if (previousFrame < trackingFrames) {
    const d = player.pos.clone().sub(boss.pos);
    boss.turnToward(Math.atan2(d.x, d.z), CFG.bossTurnFrames);
  }
  const contactFrame = move.startup + move.active;
  if (!boss.grabConnected) {
    const advance = frame => THREE.MathUtils.smoothstep(frame, move.startup - 1, contactFrame - 1);
    const distance = (advance(boss.frame) - advance(previousFrame)) * move.dashDistance;
    if (distance > 0) boss.translate(distance);
  }
  const recovery = boss.grabConnected ? Math.max(move.recovery, GRAB_TIMING.recover) : GRAB_TIMING.missRecovery;
  if (boss.frame >= contactFrame + recovery) finishBossAttack(BOSS_ATTACK_RULES.b_grab.punishFrames);
}

const COMBO_FRONT_DOT = Math.cos(Math.PI / 4);
const COMBO_SHORT_RECOVERY = 24;

function inBossComboRange(toPlayer, dist) {
  const move = MOVES.b_heavy_combo;
  return dist >= move.minRange && dist <= move.maxRange
    && boss.forward.dot(toPlayer) >= dist * COMBO_FRONT_DOT;
}

function playerAttackThreatensBoss(move) {
  const facing = player.forward;
  const forwardDistance = facing.dot(boss.pos.clone().sub(player.pos));
  if (forwardDistance <= 0) return false;

  // Look along the actual advancing hitbox from the first to the last active frame.
  const offset = move.hitbox.offset * player.scale - motionAt(move, player.frame);
  const first = offset + motionAt(move, move.startup);
  const last = offset + motionAt(move, move.startup + move.active - 1);
  const nearest = THREE.MathUtils.clamp(forwardDistance, Math.min(first, last), Math.max(first, last));
  const center = player.pos.clone().addScaledVector(facing, nearest);
  return cylinderHit(center, move.hitbox.radius * player.scale,
    move.hitbox.yMin * player.scale, move.hitbox.yMax * player.scale,
    boss.pos, boss.hurt.radius * boss.scale, 0, boss.hurt.height * boss.scale);
}

function tryBossDefense(toPlayer) {
  const move = player.move;
  if (!move || move.active <= 0 || player.frame >= move.startup) return false;
  if (AI.playerAttack?.sequence !== player.actionSequence) {
    AI.playerAttack = { sequence: player.actionSequence, noticedAt: null, checked: false };
  }
  const attack = AI.playerAttack;
  if (attack.checked) return false;
  const canBlock = boss.poise >= 14 && logicFrame >= AI.nextBlock && CFG.bossBlockChance > 0
    && boss.forward.dot(toPlayer) > 0;
  const canDodge = logicFrame >= AI.nextDodge && CFG.bossDodgeChance > 0;
  if ((!canBlock && !canDodge) || !playerAttackThreatensBoss(move)) {
    attack.noticedAt = null;
    return false;
  }

  attack.noticedAt ??= logicFrame;
  const reactionFrames = THREE.MathUtils.clamp(Math.floor(move.startup / 2), 3, 8);
  if (logicFrame - attack.noticedAt < reactionFrames) {
    boss.moving = false;
    return true;
  }
  attack.checked = true;
  if (canBlock && rng() < CFG.bossBlockChance) {
    AI.nextBlock = logicFrame + CFG.bossBlockCooldown;
    AI.blockUntil = logicFrame + CFG.bossBlockFrames;
    boss.setState('block');
    boss.moving = false;
    return true;
  }
  if (canDodge && rng() < CFG.bossDodgeChance && startBossBackstep(toPlayer, 28, 0.85)) {
    AI.nextDodge = logicFrame + 75;
    return true;
  }
  return false;
}

function bossCanTrackDuringAttack(move, frame) {
  if (frame < move.startup) return frame < move.startup * 0.55;
  let previousEnd = move.startup + move.active;
  for (const strike of move.followUps ?? []) {
    const start = move.startup + strike.delay;
    if (frame < start) return frame >= previousEnd && frame < (previousEnd + start) / 2;
    previousEnd = start + strike.active;
  }
  return false;
}

function finishBossAttack(punishFrames) {
  boss.setState('idle');
  AI.lastMoveFrame = logicFrame;
  AI.punishUntil = Math.max(AI.punishUntil, logicFrame + punishFrames);
  AI.gapFrames = Math.round(CFG.bossComboGap * 60 * (0.7 + rng() * 0.6) * (AI.phase2 ? 0.78 : 1));
  AI.feintChecked = false;
}


function startBossBackstep(toPlayer, frames, distance) {
  if (toPlayer.lengthSq() < 1e-6) return false;
  boss.setState('backstep');
  boss.backstep = { direction: toPlayer.clone().normalize().negate(), frames, distance };
  boss.moving = false;
  AI.intent = 'wait';
  AI.intentUntil = logicFrame + frames + 10;
  AI.gapFrames = 10;
  return true;
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
    if (m.requiresClip && !boss.binder?.clips.has(boss.binder.clipMap[id])) continue;
    if (dist < m.minRange || dist > m.maxRange) continue;
    if (id === 'b_heavy_combo' && (AI.comboRangeSince === null || logicFrame - AI.comboRangeSince < 24)) continue;
    const cdScale = CFG.bossCooldownScale * (AI.phase2 ? 0.72 : 1);
    const ready = (logicFrame - (AI.cooldowns?.[id] ?? -999)) > m.cooldown * 60 * cdScale;
    if (!ready) continue;
    // 距离越接近区间中心权重越高
    const mid = (m.minRange + m.maxRange) / 2;
    const half = Math.max(1, (m.maxRange - m.minRange) / 2);
    const centerBias = Math.max(0.15, 1 - (Math.abs(dist - mid) / half) * 0.7);

    // 复仇状态：起手越短权重越高，专挑快招糊玩家一脸
    const [preferredMin, preferredMax] = BOSS_ATTACK_RULES[id]?.preferredRange ?? [m.minRange, m.maxRange];
    const distanceWeight = dist >= preferredMin && dist <= preferredMax ? 1.65 : 0.55;
    let w = m.weight * centerBias * distanceWeight;
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

function tickBossMeteor(move, targetYaw) {
  if (meteorSmash?.ownerAction !== boss.actionSequence) meteorSmash = newMeteorSmash(boss);
  const prior = meteorSmash.frame;
  const frame = meteorFrame(move, ++boss.frame);
  updateMeteorSmash(meteorSmash, boss, player, frame,
    () => boss.turnToward(targetYaw, CFG.bossTurnFrames), () => banner('熔岩跃砸', 640, 'notice'));
  if (prior < METEOR.launch && frame >= METEOR.launch) {
    impactImpulse = Math.max(impactImpulse, .125);
  }
  if (boss.frame >= totalFrames(move)) finishBossAttack(BOSS_ATTACK_RULES.b_meteor.punishFrames);
}

function bossTick() {
  if (boss.flashTimer > 0) boss.flashTimer--;
  if (boss.stunTimer > 0 && boss.state === 'hitstun') boss.stunTimer--;
  if (boss.state === 'dead') { boss.frame++; return; }
  if (player.state === 'dead') return;

  const toPlayer = player.pos.clone().sub(boss.pos).setY(0);
  const dist = toPlayer.length();
  const targetYaw = Math.atan2(toPlayer.x, toPlayer.z);
  const stopDist = player.hurt.radius + boss.hurt.radius * boss.scale + 0.30;
  AI.closeSince = dist < stopDist - 0.12 ? (AI.closeSince ?? logicFrame) : null;
  AI.comboRangeSince = inBossComboRange(toPlayer, dist) ? (AI.comboRangeSince ?? logicFrame) : null;

  switch (boss.state) {
    case 'recover':
      if (++boss.frame >= boss.recoveryFrames) finishBossAttack(18);
      return;

    case 'backstep': {
      const { direction, frames, distance } = boss.backstep;
      if (boss.frame >= frames) {
        boss.setState('idle');
        AI.lastMoveFrame = logicFrame;
        return;
      }
      const previous = THREE.MathUtils.smoothstep(boss.frame, 0, frames);
      const progress = THREE.MathUtils.smoothstep(++boss.frame, 0, frames);
      boss.pos.addScaledVector(direction, distance * (progress - previous));
      boss.clampToArena();
      return;
    }

    case 'block':
      // 架招：面向玩家站定，时间到解除
      boss.turnToward(targetYaw, CFG.bossTurnFrames);
      boss.frame++;
      if (damagePoise(boss, BOSS_GUARD_HOLD_COST)) return;
      if (logicFrame >= (AI.blockUntil ?? 0)) {
        boss.setState('idle');
        AI.gapFrames = Math.max(AI.gapFrames, 8);
      }
      return;

    case 'guardbreak':
      stepPoiseBreak(boss);
      return;

    case 'ultimateStun':
    case 'parried':
      if (++boss.frame >= boss.stunTimer) {
        boss.stunTimer = 0;
        boss.setState('idle');
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
      const move = boss.move;
      if (move?.grab) { tickBossGrab(move); return; }
      if (move?.meteor) { tickBossMeteor(move, targetYaw); return; }
      if (move) {
        if (bossCanTrackDuringAttack(move, boss.frame)) boss.turnToward(targetYaw, CFG.bossTurnFrames);

        if (!AI.feintChecked && boss.frame >= move.startup * 0.62 && boss.frame < move.startup && move.active > 0) {
          AI.feintChecked = true;
          if (rng() < CFG.bossFeintChance) {
            boss.setState('idle');
            AI.lastMoveFrame = logicFrame;
            AI.gapFrames = 18;
            AI.intentUntil = 0;
            return;
          }
        }

        const speedUp = boss.hp < boss.maxHp * 0.55 ? 1.25 : 1.0;
        const previousFrame = boss.frame;
        const end = totalFrames(move);
        boss.frame = Math.min(boss.frame + speedUp, end);
        if (boss.moveId === 'b_heavy_combo') {
          const second = move.followUps[0];
          const branchFrame = move.startup + second.delay + second.active;
          if (previousFrame < branchFrame && boss.frame >= branchFrame && !inBossComboRange(toPlayer, dist)) {
            boss.frame = branchFrame;
            boss.stepMotion(previousFrame);
            boss.binder.prepareRecovery(boss.moveId, branchFrame / end);
            boss.setState('recover');
            boss.recoveryFrames = COMBO_SHORT_RECOVERY;
            return;
          }
        }

        boss.stepMotion(previousFrame);
        if (boss.frame >= end) finishBossAttack(BOSS_ATTACK_RULES[boss.moveId]?.punishFrames ?? 24);
        return;
      }

      if (grabTestMode || grabSequence || logicFrame < AI.punishUntil) {
        boss.moving = false;
        return;
      }
      boss.turnToward(targetYaw, CFG.bossTurnFrames);

      // ── 阶段转换：血量跌破阈值时强制打断当前行为，吼一声进入下一阶段 ──
      if (!AI.phase2 && boss.hp < boss.maxHp * 0.55) {
        AI.phase2 = true;
        AI.intentUntil = 0;
        AI.feintChecked = false;
        // 「怒吼」动作已取消：阶段转换只做横幅 / 场景变化，不再播那段站着扭头的动作
        boss.moving = false;
        // 二阶段：场景推到血月（法阵转红、雾变浓、火盆变血焰）
        STAGE.setPhase(2);
        banner('第二阶段 · 血月', 1800, 'phase');
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

      if (tryBossDefense(toPlayer)) return;

      // 贴身压力要持续一段时间，正常接敌距离不会触发后撤。
      if (AI.closeSince !== null && logicFrame - AI.closeSince >= 24 && logicFrame >= AI.nextBackstep) {
        AI.nextBackstep = logicFrame + 110;
        if (rng() < CFG.bossBackstepChance && startBossBackstep(toPlayer, 26, 0.70)) return;
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

      const facingPlayer = boss.forward.dot(toPlayer) >= dist * Math.cos(Math.PI / 3);
      const id = facingPlayer ? pickBossMove(dist) : null;
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
let impactImpulse = 0;

function hitstop(f) { hitstopFrames = Math.max(hitstopFrames, f); }
function shake(v) { shakeAmt = Math.min(0.3, shakeAmt + v); }

/** 出招第一帧挂预警；之后特效自己读 actor.frame，判定帧一到自动淡出 */
function syncTelegraph(a, previousFrame) {
  if (!a.move || a.move.meteor || a.move.active <= 0) return;
  if (previousFrame >= 1 || a.frame < 1) return;
  if (VFX_CFG.telegraphBossOnly && !a.isBoss) return;
  vfx.telegraph(a, a.move);
}

/** 判定窗口的第一帧放刀光（不是起手帧） */
function spawnSwingVFX(a, hitbox, previousFrame) {
  if (a.move?.grab || a.move?.meteor || !hitbox || previousFrame >= hitbox.strike.startup) return;
  const swing = { ...a.move, ...hitbox.strike };
  vfx.swingFromActor(a, swing);
  // free_slash_vfx 的新月贴图：只给 Boss 加一层（玩家已有紫色剑轨）
  if (a.isBoss) vfx.crescentSlash(a, swing);
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
  const [widthAxis] = ['x', 'y', 'z'].filter(key => key !== axis).sort((a, b) => size[b] - size[a]);
  const span = { axis, widthAxis, lo: _bladeMin[axis], hi: _bladeMax[axis] };
  group.userData.bladeSpan = span;
  return span;
}

function sampleWeaponBlade(group, base, tip) {
  const span = bladeSpan(group);
  if (!Number.isFinite(span.lo) || !Number.isFinite(span.hi) || span.hi - span.lo < .001) return false;
  group.updateWorldMatrix(true, false);
  base.set(0, 0, 0);
  tip.set(0, 0, 0);
  base[span.axis] = span.lo;
  tip[span.axis] = span.hi;
  base.applyMatrix4(group.matrixWorld);
  tip.applyMatrix4(group.matrixWorld);
  return true;
}

function guardContact(defender, attacker) {
  const blade = new THREE.Line3();
  if (!defender.binder?.weaponGroup ||
      !sampleWeaponBlade(defender.binder.weaponGroup, blade.start, blade.end)) return null;

  // Prefer the overlap of the visible blades. Combat uses larger hit volumes,
  // so a successful block can also need a contact point on the defender's blade alone.
  const aim = attacker.pos.clone().sub(defender.pos).setY(0).normalize();
  const scale = defender.scale;
  aim.multiplyScalar(.72 * scale).add(defender.pos).y += 1.18 * scale;
  const point = blade.closestPointToPoint(aim, true, new THREE.Vector3());
  const incoming = new THREE.Line3();
  if (attacker.binder?.weaponGroup &&
      sampleWeaponBlade(attacker.binder.weaponGroup, incoming.start, incoming.end)) {
    const other = incoming.closestPointToPoint(point, true, new THREE.Vector3());
    const near = blade.closestPointToPoint(other, true, new THREE.Vector3());
    if (near.distanceToSquared(other) < (.45 * scale) ** 2 &&
        near.distanceToSquared(aim) < (.65 * scale) ** 2) point.copy(near).lerp(other, .30);
  }
  if (point.distanceToSquared(aim) > (.95 * scale) ** 2 || point.y < defender.pos.y + .42 * scale) return null;
  return { point, axis: blade.delta(new THREE.Vector3()).normalize() };
}

/**
 * 每帧调用。只要角色处于出招状态就持续采样，
 * 挥得快 → 同一时间窗内扫过的路径更长；停下 → 旧采样自然淡出。
 */
function feedBladeTrail(key, a, dt, swinging = !!a && !a.move?.grab && ATTACK_STATE_RE.test(a.state)) {
  if (!vfx.trails || !vfx.trails[key]) return;
  const group = a && a.binder && a.binder.weaponGroup;
  if (!swinging || !group) { vfx.feedTrail(key, null, null, dt, false); return; }

  if (!sampleWeaponBlade(group, _trailBase, _trailTip)) {
    vfx.feedTrail(key, null, null, dt, false);
    return;
  }

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
  player.rememberVisualFrame();
  boss.rememberVisualFrame();
  if (hitstopFrames > 0) { hitstopFrames--; shakeAmt *= 0.75; return; }

  logicFrame++;

  const previousPlayerFrame = player.frame;
  const previousBossFrame = boss.frame;
  playerTick();
  bossTick();
  advanceGrab();

  // Resolve the cut before the enemy's strike. A landed cut cancels that attack.
  if (player.state === 'ultimate' && ultimateCast) resolveUltimateCuts(ultimateCast);
  resolveUltimateWave();
  resolveHit(player, boss, activeHitbox(player));
  const bossHit = activeHitbox(boss);
  if (bossHit && boss.move.meteor) {
    impactImpulse = Math.max(impactImpulse, .64);
    bossSmashEffect.impact(bossHit.center, VFX_CFG.enabled ? VFX_CFG.intensity : 0);
    hitstop(4);
  }
  resolveHit(boss, player, bossHit);
  if (meteorSmash && (boss.actionSequence !== meteorSmash.ownerAction || player.state === 'dead')) {
    boss.pos.y = 0;
    meteorSmash = null;
  }
  if (ultimateCast && player.state !== 'ultimate') endUltimate(ultimateCast);

  // 起手预警：出招第一帧挂上，判定帧前最亮（类魂的「读招」全靠它）
  syncTelegraph(player, previousPlayerFrame);
  syncTelegraph(boss, previousBossFrame);

  // 刀光在「判定帧第一帧」才亮 —— 起手就亮会让攻击没有重量
  spawnSwingVFX(player, activeHitbox(player), previousPlayerFrame);
  spawnSwingVFX(boss, activeHitbox(boss), previousBossFrame);

  // 角色间推挤（翻滚时关闭 —— 这就是「穿身」）
  // 不对称：被顶开的是 Boss 多、玩家少。五五开的话，体型大的一方主动往里压，
  // 玩家就会被「推着走」—— 玩家自己走一步，Boss 挤回来半步，净位移全由 Boss 决定。
  const bossDashingToGrab = boss.move?.grab && boss.frame >= boss.move.startup
    && boss.frame < boss.move.startup + boss.move.active;
  const meteorLanding = meteorSmash && meteorSmash.frame >= METEOR.launch && meteorSmash.frame < METEOR.impact + 12;
  if (!grabSequence && !bossDashingToGrab && !meteorLanding && player.state !== 'dead' && boss.state !== 'dead'
    && player.state !== 'roll' && player.iframe <= 0) {
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

  regeneratePlayerPoise();
}

// ── 相机 ──────────────────────────────────────────────────────
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const focus = new THREE.Vector3();
const cameraPlayer = new THREE.Vector3();
const cameraBoss = new THREE.Vector3();
const framing = { distance: 3.15, clearance: 2.4, pivotHeight: 1.48, lockLift: 0.16, shoulder: 0.32, pitch: 0.075 };
let camYaw = 0;
let camPitch = framing.pitch;
let railCameraYaw = null;
let railOrbit = null;

function snapCamera() {
  camYaw = player.yaw + Math.PI;
  camPitch = framing.pitch;
  railCameraYaw = null;
  railOrbit = null;
  camTarget.copy(player.pos);
  camTarget.y += framing.pivotHeight;
  updateCamera(0);
}

function ultimateHomeYaw(cast, actorPosition, targetPosition) {
  const x = actorPosition.x - targetPosition.x;
  const z = actorPosition.z - targetPosition.z;
  return player.lockOn && Math.hypot(x, z) > .01 ? Math.atan2(x, z) : cast.viewYaw;
}

function returnUltimateCamera(cast) {
  if (cast.cameraReturned) return;
  cast.cameraReturned = true;
  if (grabSequence) return;
  camYaw = ultimateHomeYaw(cast, player.pos, boss.pos);
  camPitch = player.lockOn ? Math.min(cast.viewPitch, framing.pitch) : cast.viewPitch;
}

function updateCamera(dtReal, alpha = 1) {
  player.samplePosition(alpha, cameraPlayer);
  boss.samplePosition(alpha, cameraBoss);
  focus.copy(cameraPlayer);
  const normalFocus = framing.pivotHeight + (player.lockOn ? framing.lockLift : 0);
  const wallFocus = grabSequence?.phase === 'wall'
    ? grabWallCameraFocus(grabSequence) : 0;
  const castFrame = ultimateCast ? ultimateSourceFrame(player.frame) : 0;
  const returning = ultimateCast && player.frame >= ULTIMATE_CAMERA_RETURN.start;
  const returnProgress = returning
    ? THREE.MathUtils.smoothstep(player.frame, ULTIMATE_CAMERA_RETURN.start, ULTIMATE_CAMERA_RETURN.end) : 0;
  if (returnProgress === 1) returnUltimateCamera(ultimateCast);
  const cinematic = ultimateCast && !ultimateCast.cameraReturned;
  const ultimateView = cinematic ? THREE.MathUtils.smoothstep(castFrame, 0, 26) * (1 - returnProgress) : 0;
  const ultimateWide = THREE.MathUtils.smoothstep(castFrame, 139, 174) * ultimateView;
  if (ultimateCast) {
    focus.addScaledVector(ultimateCast.forward, .63 * ultimateView);
    focus.addScaledVector(ultimateCast.side, -.22 * ultimateView);
  }
  const aerialAim = meteorSmash?.airborne ? Math.min(boss.pos.y, 3.8) * .20 : 0;
  focus.y += THREE.MathUtils.lerp(normalFocus, 0.65, wallFocus) + .31 * ultimateWide + aerialAim;
  const follow = 1 - Math.exp(-(returning ? 32 : 18) * dtReal);
  if (grabSequence?.phase === 'flight') {
    const direction = grabSequence.direction;
    camYaw = lerpYaw(camYaw, Math.atan2(-direction.x, -direction.z), 1 - Math.exp(-10 * dtReal));
  } else if (grabSequence?.phase === 'wall' && grabSequence.wallCameraYaw !== undefined) {
    const { age, wallCameraYaw, launchCameraYaw } = grabSequence;
    const dx = player.pos.x - boss.pos.x, dz = player.pos.z - boss.pos.z;
    const targetYaw = player.lockOn && Math.hypot(dx, dz) > 0.01 ? Math.atan2(dx, dz) : launchCameraYaw;
    const progress = THREE.MathUtils.smoothstep(age, 7, grabRecoveryFrames(grabSequence) - 1);
    camYaw = lerpYaw(wallCameraYaw, targetYaw, progress);
  } else if (cinematic) {
    const angle = Math.atan2(-ultimateCast.forward.x, -ultimateCast.forward.z);
    const orbit = .98 + .25 * THREE.MathUtils.smoothstep(castFrame, 160, 278);
    const homeYaw = ultimateHomeYaw(ultimateCast, cameraPlayer, cameraBoss);
    const home = lerpYaw(ultimateCast.viewYaw, homeYaw, returnProgress);
    camYaw = lerpYaw(home, angle + orbit, ultimateView);
    const pitch = player.lockOn ? Math.min(ultimateCast.viewPitch, framing.pitch) : ultimateCast.viewPitch;
    camPitch = THREE.MathUtils.lerp(pitch, .24 + .050 * ultimateWide, ultimateView);
  } else if (player.lockOn) {
    const dx = cameraPlayer.x - cameraBoss.x;
    const dz = cameraPlayer.z - cameraBoss.z;
    if (Math.hypot(dx, dz) > 0.01) {
      const delta = Math.atan2(dx, dz) - camYaw;
      camYaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-8 * dtReal));
    }
    // 锁定只跟踪 Boss 的水平方位。镜头偏高时平滑回落，低机位保持原俯仰。
    camPitch += (Math.min(camPitch, framing.pitch) - camPitch) * follow;
  }
  camTarget.lerp(focus, follow);
  const pivotX = camTarget.x + Math.cos(camYaw) * framing.shoulder;
  const pivotZ = camTarget.z - Math.sin(camYaw) * framing.shoulder;
  const pitchScale = Math.cos(camPitch);
  const minBoom = framing.clearance * pitchScale;
  const railRadius = ARENA_R - 1.65;
  const pivotRadius = Math.hypot(pivotX, pivotZ);
  const turn = 1 - Math.exp(-(returning ? 26 : 10) * dtReal);
  const freeLook = !player.lockOn && !grabSequence && !cinematic;
  const mouseYaw = freeLook ? (railOrbit?.mouseYaw ?? 0) : 0;
  let armYaw = camYaw;
  let railExtend = null;

  if (pivotRadius + minBoom > railRadius) {
    railOrbit ??= { mouseYaw: 0, manual: false };
    railOrbit.mouseYaw = 0;
    if (!freeLook) railOrbit.manual = false;
    // 用余弦定理找出保留最短镜头臂时，镜头仍在栏杆内侧的方位范围。
    const radialYaw = Math.atan2(pivotX, pivotZ);
    const limitCos = (railRadius ** 2 - pivotRadius ** 2 - minBoom ** 2) / (2 * pivotRadius * minBoom);
    const minAngle = Math.acos(THREE.MathUtils.clamp(limitCos, -1, 1));
    const fullTurn = Math.PI * 2;
    const maxAngle = fullTurn - minAngle;
    const previous = THREE.MathUtils.euclideanModulo((railCameraYaw ?? camYaw) - radialYaw, fullTurn);
    const safeAngle = THREE.MathUtils.clamp(previous, minAngle, maxAngle);
    const maxStep = 4 * dtReal;
    let next = safeAngle;
    if (mouseYaw !== 0) {
      // 从当前可见角度处理鼠标增量，丢弃撞到限位的部分。反向输入从这一侧立即生效。
      const step = THREE.MathUtils.clamp(mouseYaw, -maxStep, maxStep);
      next = THREE.MathUtils.clamp(safeAngle + step, minAngle, maxAngle);
      const appliedYaw = next - safeAngle;
      if (appliedYaw !== 0) {
        // 移动方向只跟随实际接受的鼠标输入，镜头自动让位时保持原有朝向基准。
        camYaw = (camYaw + appliedYaw) % fullTurn;
        railOrbit.manual = true;
      }
    } else if (!railOrbit.manual) {
      const wanted = THREE.MathUtils.euclideanModulo(camYaw - radialYaw, fullTurn);
      const target = wanted >= minAngle && wanted <= maxAngle
        ? wanted
        : previous < Math.PI ? minAngle : maxAngle;
      const autoStep = returning ? 10 * dtReal : maxStep;
      next += THREE.MathUtils.clamp((target - safeAngle) * turn, -autoStep, autoStep);
    }
    armYaw = radialYaw + next;
    if (railOrbit.manual) {
      const angleToRail = Math.min(next - minAngle, maxAngle - next);
      railExtend = THREE.MathUtils.smoothstep(angleToRail, 0, 0.35);
    }
  } else {
    railOrbit = null;
    if (mouseYaw !== 0) camYaw = (camYaw + mouseYaw) % (2 * Math.PI);
    armYaw = railCameraYaw === null ? camYaw : lerpYaw(railCameraYaw, camYaw, turn);
  }
  const yawOffset = lerpYaw(camYaw, armYaw, 1) - camYaw;
  railCameraYaw = Math.abs(yawOffset) > 0.001 ? armYaw : null;
  armYaw = railCameraYaw ?? camYaw;

  const sinYaw = Math.sin(armYaw), cosYaw = Math.cos(armYaw);
  const along = pivotX * sinYaw + pivotZ * cosYaw;
  const across = pivotX * cosYaw - pivotZ * sinYaw;
  const toRail = Math.sqrt(Math.max(0, railRadius ** 2 - across ** 2)) - along;
  // 侧移时先维持短镜头臂，等朝向恢复后再伸回肩后距离。
  const extend = railExtend ?? (1 - THREE.MathUtils.smoothstep(Math.abs(yawOffset), 0, 0.45));
  const desiredBoom = THREE.MathUtils.lerp(minBoom, (framing.distance - .34 * ultimateView + 1.65 * ultimateWide) * pitchScale, extend);
  const boom = THREE.MathUtils.clamp(toRail, 0.1, desiredBoom);
  camPos.set(pivotX + boom * sinYaw, camTarget.y + boom * Math.tan(camPitch), pivotZ + boom * cosYaw);
  camPos.y = Math.max(camPos.y, 0.45);

  let aimX = pivotX, aimZ = pivotZ;
  if (railCameraYaw !== null && player.lockOn && !grabSequence) {
    const aimYaw = armYaw + Math.PI;
    const bossYaw = Math.atan2(cameraBoss.x - camPos.x, cameraBoss.z - camPos.z);
    const delta = lerpYaw(aimYaw, bossYaw, 1) - aimYaw;
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.aspect);
    const playerYaw = Math.atan2(cameraPlayer.x - camPos.x, cameraPlayer.z - camPos.z);
    const halfSpan = Math.abs(lerpYaw(bossYaw, playerYaw, 0.5) - bossYaw);
    const margin = THREE.MathUtils.clamp(halfSpan, halfFov * 0.75, halfFov * 0.94);
    // 镜头侧移时适当朝 Boss 转向，给锁定目标留出画面空间。
    const yaw = aimYaw + delta - THREE.MathUtils.clamp(delta, -margin, margin);
    aimX = camPos.x + Math.sin(yaw) * boom;
    aimZ = camPos.z + Math.cos(yaw) * boom;
  }

  const shakeVec = new THREE.Vector3(
    (Math.random() - 0.5) * (shakeAmt + impactImpulse),
    (Math.random() - 0.5) * (shakeAmt + impactImpulse),
    (Math.random() - 0.5) * (shakeAmt + impactImpulse)
  );
  camera.position.copy(camPos).add(shakeVec);
  camera.lookAt(aimX, camTarget.y, aimZ);
  shakeAmt *= 0.86;
  impactImpulse *= Math.exp(-dtReal * 8.4);
}

/** 把当前状态翻译成姿态并套到骨架上 */
function applyActorPose(a, dtReal, getUp = 0, alpha = 1) {
  if (!a.mesh || !a.mesh.spine) return;
  // 接了真模型时，骨骼动画接管，程序化姿态和脚部 IK 全部让位
  if (a.binder) return;
  const period = a.state === 'move' ? 36 : 90;
  const clock = (logicFrame % period) / period;
  const pose = poseFor(a, clock, getUp, a.sampleActionFrame(alpha));

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
    a.state === 'heavy' || a.state === 'hitstun' || a.state === 'guardbreak' || a.state === 'parried';

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
  tipLen: 0,      // 手到刀尖的距离；0 = 自动测量。
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
    poseGrip: swordGripPose(w.parent),
    pos: w.position.clone(),
    quat: w.quaternion.clone(),
    scale: w.scale.clone(),
    heightRef: modelH,
    onHand: true,
    yaw0: 0,                        // 进入拖刀时的 yaw
    z0: new THREE.Vector3(0, 0, 1), // 进入拖刀时锁定的「刀身滚转参考轴」
  };
}

function dragDirection(yaw, length, tipClearance) {
  const vertical = DRAG.ground
    ? -THREE.MathUtils.clamp(_dragHandPos.y - tipClearance, 0.05, length * 0.92) / length
    : -Math.sin(DRAG.elev);
  const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  _dragDir.set(Math.sin(yaw) * horizontal, vertical, Math.cos(yaw) * horizontal);
}

function updateDragWeapon(intro) {
  const d = dragState;
  if (!d || (intro && !intro.landed)) return;

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
    const palm = d.obj.userData.weapon?.target;
    const span = bladeSpan(d.obj);
    d.tipLength = 0;
    if (palm && span.axis === 'y') {
      const grip = d.obj.worldToLocal(d.hand.localToWorld(palm.clone()));
      if (grip.y - span.lo < span.hi - grip.y) {
        d.tipLength = (span.hi - grip.y) * d.obj.getWorldScale(_dragRefX).y;
      }
    }
  }

  // ★ 关键：武器始终是手骨的子节点，不摘下来 —— boss 是「抓着手柄拖」，
  //   握把位置就是 realign() 算好的掌心位置，跟着手一起动，不会再错位。
  //   这里只改它相对手骨的旋转，让刀身朝斜后方横着甩出去。
  d.obj.position.copy(d.pos);
  d.obj.scale.copy(d.scale);

  // 握把世界坐标（= 手骨世界矩阵 × 握把局部位置）
  d.hand.updateWorldMatrix(true, false);
  _dragHandPos.copy(d.obj.userData.weapon?.target ?? d.pos).applyMatrix4(d.hand.matrixWorld);

  // 握把 → 刀尖的实际长度
  const L = DRAG.tipLen > 0 ? DRAG.tipLen : d.tipLength || (d.heightRef || 1.9) * 1.02;

  // 水平方向：正后方（yaw + π）绕竖轴偏 DRAG.side
  const yaw = boss.yaw;
  const az = yaw + Math.PI + DRAG.side;

  const bevel = d.tipLength && DRAG.tipLen <= 0 ? 0.022 : 0;
  dragDirection(az, L, bevel);

  if (d.poseGrip && d.tipLength) {
    d.poseGrip(_dragDir, 1);
    d.hand.updateWorldMatrix(true, false);
    _dragHandPos.copy(d.obj.userData.weapon.target).applyMatrix4(d.hand.matrixWorld);
    if (DRAG.ground) dragDirection(az, L, bevel);
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
  d.obj.quaternion.copy(_dragHandQuat).invert().multiply(_dragQuat);

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
let lastPoseLogicFrame = 0;
function render(dtReal, dodgeScale) {
  updateStage(performance.now() / 1000, camera);
  // 美术模型动画（灰盒可不接）
  const animDt = CFG.paused ? 0 : dtReal * dodgeScale;   // 暂停时冻结动画，方便逐帧检查
  restoreGrabJoints();
  const cast = player.state === 'ultimate' ? ultimateCast : null;
  const ultimateAlpha = hitstopFrames > 0 || CFG.paused ? 1 : THREE.MathUtils.clamp(acc / STEP,0,1);
  const castFrame = cast ? THREE.MathUtils.lerp(cast.previous, player.frame, ultimateAlpha) : 0;
  player.syncMesh(cast?.motion ? ultimateAlpha : dodgeVisualAlpha);
  boss.syncMesh(meteorSmash ? ultimateAlpha : dodgeVisualAlpha);
  const getUp = grabSequence?.phase === 'wall' ? grabGetUpProgress(grabSequence) : 0;
  if (combatReady) {
    // 擒拿的所有姿态都跟随战斗帧，慢放或命中冻结时和判定保持同步。
    const poseDt = Math.max(0, logicFrame - lastPoseLogicFrame) * STEP;
    if (grabSequence && player.binder) {
      player.binder.update(player, poseDt, grabPlayerAnimation(player, grabSequence, logicFrame));
    } else if (cast && player.binder) {
      player.binder.update(player, hitstopFrames > 0 ? 0 : animDt * CFG.timeScale,
        cast.motion
          ? { key: 'ultimate', sampleTime: ultimateSourceFrame(castFrame) / 60, fade: .085, groundFeet: true }
          : ultimateFallbackPose(player.binder, castFrame));
    } else {
      player.binder?.update(player, animDt);
    }
    lastPoseLogicFrame = logicFrame;
    const bossAnimDt = hitstopFrames > 0 ? 0 : animDt * CFG.timeScale;
    const kick = boss.move?.grab ? grabBossAnimation(boss) : undefined;
    if (bossIntro) bossIntro.pose(bossAnimDt);
    else if (meteorSmash) {
      const frame = meteorFrame(boss.move, boss.sampleActionFrame(ultimateAlpha));
      boss.binder?.update(boss, bossAnimDt, { key: 'b_meteor', sampleTime: frame / 60, fade: .09, groundFeet: true });
    } else boss.binder?.update(boss, boss.move?.grab ? poseDt : bossAnimDt,
      kick ?? { poseFrame: boss.sampleActionFrame(dodgeVisualAlpha) });
  }

  // 走路拖刀：世界空间定位，所以不会被走路动画带着上下颠
  updateDragWeapon(bossIntro);
  scratch.update(CFG.paused ? 0 : dtReal * CFG.timeScale);

  // 判定可视化和角色一起等资源就绪。
  const showHitbox = combatReady && !bossIntro && CFG.showHitbox;
  const pv = activeHitbox(player);
  placeViz(player.hitViz, player.pos, player.yaw,
    player.move ? player.move.hitbox.offset * player.scale : 0,
    pv ? pv.radius : 0,
    pv ? pv.yMin : 0, pv ? pv.yMax : 1, showHitbox && !!pv);

  const bv = activeHitbox(boss);
  placeViz(boss.hitViz, boss.pos, boss.yaw,
    boss.move ? boss.move.hitbox.offset * boss.scale : 0,
    bv ? bv.radius : 0,
    bv ? bv.yMin : 0, bv ? bv.yMax : 1, showHitbox && !!bv);

  // 受击框（受击判定区，非遮挡）
  placeViz(player.hurtViz, player.pos, 0, 0,
    player.hurt.radius * player.scale, 0, player.hurt.height * player.scale, showHitbox && player.state !== 'dead');
  placeViz(boss.hurtViz, boss.pos, 0, 0,
    boss.hurt.radius * boss.scale, 0, boss.hurt.height * boss.scale, showHitbox && boss.state !== 'dead');

  // 格挡 / 弹反窗口的可视化
  updateGuardViz(player);

  // 姿态：由帧表驱动的程序化骨骼动画 + 脚部 IK
  applyActorPose(player, dtReal, getUp, dodgeVisualAlpha);
  applyActorPose(boss, dtReal, 0, dodgeVisualAlpha);
  const grabHand = poseBossGrab(boss);
  if (boss.move?.grab) boss.binder?.groundPose(boss, 0);
  poseGrabVictim(player, grabSequence, grabHand);

  // 特效推进：顿帧时冻结（打在铁上那一下要「停」住）
  dodgeEffect.update(CFG.paused ? 0 : dtReal, player);
  const dtVfx = CFG.paused || hitstopFrames > 0 ? 0 : dtReal * CFG.timeScale * dodgeScale;
  vfx.update(dtVfx);
  const intensity = VFX_CFG.enabled ? VFX_CFG.intensity : 0;
  if (cast || releasedUltimate) {
    const blade = cast && (player.binder?.weaponGroup ?? (!player.binder ? player.mesh.weapon : null));
    const sample = blade && sampleWeaponBlade(blade, _trailBase, _trailTip);
    if (sample && blade.parent) {
      const grip = blade.userData.weapon?.target;
      const hand = grip ? blade.parent.localToWorld(_trailDir.copy(grip)) : blade.parent.getWorldPosition(_trailDir);
      if (_trailTip.distanceToSquared(hand) < _trailBase.distanceToSquared(hand)) {
        _trailDir.copy(_trailTip);
        _trailTip.copy(_trailBase);
        _trailBase.copy(_trailDir);
      }
    }
    const effectsFrame = cast ? castFrame : FINISHER.hit + logicFrame - releasedUltimate.wave.firedAt;
    ultimateEffect.update(cast ?? releasedUltimate, effectsFrame, dtVfx, intensity, renderer.getPixelRatio(),
      sample ? _trailBase : null, sample ? _trailTip : null);
  }
  bossSmashEffect.update(meteorSmash, meteorSmash ? meteorFrame(boss.move, boss.sampleActionFrame(ultimateAlpha)) : 0,
    dtVfx, intensity, camera);

  // ── 真实剑轨：按「刃根 → 刃尖」逐帧采样，扇形由剑自己扫出来 ──
  feedBladeTrail('player', player, dtVfx);
  feedBladeTrail('boss', boss, dtVfx, bossIntro ? false : undefined);

  vfx.guardImpact.updateView(camera);
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
  const dtReal = THREE.MathUtils.clamp((now - lastTime) / 1000, 0, 0.1);
  lastTime = now;

  let dodgeScale = 1;
  if (atTitle) {
    frameTitle(now);
  } else if (bossIntro) {
    if (!CFG.paused) bossIntro.advance(dtReal * CFG.timeScale);
    bossIntro.frameCamera(camera, settings.state().fov);
    if (bossIntro.finished) finishBossIntro();
  } else if (combatReady && !CFG.paused) {
    // Average both ends of this render interval so the ramp is stable at different refresh rates.
    const previousScale = dodgeTimeScale();
    dodgeSlowTime = Math.max(0, dodgeSlowTime - dtReal);
    dodgeScale = (previousScale + dodgeTimeScale()) * .5;
    acc += dtReal * CFG.timeScale * dodgeScale;
    let guard = 0;
    while (acc >= STEP && guard++ < 5) {
      tick();
      acc -= STEP;
    }
    dodgeVisualAlpha = dodgePoseAlpha();
    updateCamera(dtReal, dodgeVisualAlpha);
  }

  render(dtReal, dodgeScale);
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
const bossHud = document.getElementById('bossHud');
const debugHud = document.getElementById('combatDebug');
const hudFps = document.getElementById('hudFps');
const hudSpeed = document.getElementById('hudSpeed');
const hudHealth = document.getElementById('hudHealth');
const hudStatus = document.getElementById('hudStatus');
const hudPhase = document.getElementById('hudPhase');
const playerLife = document.getElementById('playerLife');
const playerHud = playerLife.closest('.player-hud');
const playerPoise = document.getElementById('playerPoise');
const ultimateMeter = document.getElementById('ultimateMeter');
const ultimateValue = document.getElementById('ultimateValue');
const bossLife = document.getElementById('bossLife');
const bossPoise = document.getElementById('bossPoise');
const bannerEl = document.getElementById('banner');
const bannerText = document.getElementById('bannerText');
const bannerHint = document.getElementById('bannerHint');
let bannerTimer = null;

function banner(text, ms = 1200, kind = 'notice') {
  bannerText.textContent = text;
  bannerEl.dataset.kind = kind;
  bannerHint.hidden = kind !== 'defeat' && kind !== 'victory';
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), ms);
}

function hudText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function hudMeter(element, value, max) {
  const ratio = max > 0 ? THREE.MathUtils.clamp(value / max, 0, 1) : 0;
  const fill = ratio.toFixed(4);
  if (element.style.getPropertyValue('--fill') !== fill) element.style.setProperty('--fill', fill);
  const current = String(Math.round(ratio * max));
  const total = String(Math.round(max));
  if (element.getAttribute('aria-valuenow') !== current) element.setAttribute('aria-valuenow', current);
  if (element.getAttribute('aria-valuemax') !== total) element.setAttribute('aria-valuemax', total);
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
  const curIdx = Math.min(W - 1, Math.floor((a.frame / total) * W));

  let html = '';
  for (let i = 0; i < W; i++) {
    const t = i / W;
    let ch, cls;
    if (t < sEnd) { ch = '▁'; cls = 'fb-s'; }
    else if (activeStrike(m, t * total)) { ch = '█'; cls = 'fb-a'; }
    else { ch = '░'; cls = 'fb-r'; }
    const passed = i <= curIdx;
    if (i === curIdx) html += `<span class="cur">${ch}</span>`;
    else html += `<span class="${cls}${passed ? '' : ' dim'}">${ch}</span>`;
  }
  return html;
}

/** 格挡专用条：只关心「弹反窗还剩几帧」 */
function guardBar(a) {
  if (a.frame > PARRY_WINDOW) return '<span class="k">持续架势 · 消耗韧性</span>';
  const left = PARRY_WINDOW + 1 - a.frame;
  return `<span class="warn">弹反窗 ${bar(left, PARRY_WINDOW, 8)} ${a.frame}/${PARRY_WINDOW}</span>`;
}

function updateHUD() {
  if (grabTestMode) updateGrabTestStatus();
  hudMeter(playerLife, player.hp, player.maxHp);
  hudMeter(playerPoise, player.poise, player.maxPoise);
  playerHud.classList.toggle('poise-low', player.poise <= MOVES.p_heavy.stamina);
  playerHud.classList.toggle('poise-broken', player.state === 'guardbreak');
  bossHud.classList.toggle('poise-broken', boss.state === 'guardbreak');
  hudMeter(ultimateMeter, ultimateEnergy, ULTIMATE_MAX);
  const ultimateReady = ultimateEnergy >= ULTIMATE_MAX;
  playerHud.classList.toggle('ultimate-ready', ultimateReady);
  hudText(ultimateValue, ultimateReady ? '可释放' : `${ultimateEnergy}%`);
  hudMeter(bossLife, boss.hp, boss.maxHp);
  hudMeter(bossPoise, boss.poise, boss.maxPoise);
  playerHud.classList.toggle('is-low', player.hp < player.maxHp * 0.25);
  hudText(hudHealth, `${Math.round(player.hp)} / ${Math.round(player.maxHp)}`);
  const status = [player.lockOn ? '锁定' : '',
    player.state === 'guardbreak' ? '破势' : logicFrame < player.counterUntil ? '反击窗口' : player.iframe > 0 ? '无敌' : '',
  ].filter(Boolean).join(' · ');
  hudStatus.hidden = !status;
  hudText(hudStatus, status);
  hudText(hudFps, __fps ? String(__fps) : '–');
  const speed = CFG.paused ? '已暂停' : CFG.timeScale !== 1 ? `${CFG.timeScale}×` : '';
  hudSpeed.hidden = !speed;
  hudText(hudSpeed, speed);

  const bloodMoon = AI.phase2 || AI.phase3;
  const phase = bloodMoon ? 'blood' : 'normal';
  if (bossHud.dataset.phase !== phase) bossHud.dataset.phase = phase;
  hudText(hudPhase, boss.state === 'dead' ? '已击败' : boss.state === 'guardbreak' ? '破势 · 伤害提升' : boss.state === 'ultimateStun' ? '僵直' : AI.phase3 ? '血月 · 第三阶段' : bloodMoon ? '血月 · 第二阶段' : '第一阶段');

  if (!hud.classList.contains('show-debug')) return;
  const dist = player.pos.distanceTo(boss.pos);
  debugHud.innerHTML =
    `玩家 ${stateLabel(player)} · 韧性 ${Math.round(player.poise)}/${Math.round(player.maxPoise)}
${player.state === 'block' ? guardBar(player) : frameBar(player)}
首领 ${stateLabel(boss)} · 韧性 ${Math.round(boss.poise)} · ${dist.toFixed(1)} m
${frameBar(boss)}
逻辑帧 ${logicFrame} · ${(QUALITY[qualityName] ?? QUALITY.mid).label}画质 · 顿帧 ${hitstopFrames}`;
}

// ═══════════════════════════════════════════════════════════════
//  9. 调参面板
// ═══════════════════════════════════════════════════════════════
const gui = new GUI({ title: grabTestMode ? '擒拿调试' : '帧数据调参（改完立即生效）' });
gui.show(grabTestMode);
hud.classList.toggle('show-debug', grabTestMode);
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
  const minRecovery = m.grab ? GRAB_TIMING.recover : LIMITS.recovery.min;
  sub.add(moveParams[id], 'recovery', minRecovery, LIMITS.recovery.max, 1).name('收招帧')
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
fDebug.add({ fn: () => openGrabMode(true) }, 'fn').name('打开擒拿调试');

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

const grabTest = {
  location: '场地中央',
  distance: 5.85,
  startup: MOVES.b_grab.startup,
  active: MOVES.b_grab.active,
  dashDistance: MOVES.b_grab.dashDistance,
  hitRadius: MOVES.b_grab.hitbox.radius * boss.scale,
  aimLockFrames: MOVES.b_grab.aimLockFrames,
  damage: MOVES.b_grab.damage,
  status: '等待加载',
};

function grabTestMove() {
  const { startup, active, dashDistance, aimLockFrames, hitRadius, damage } = grabTest;
  return {
    ...MOVES.b_grab, startup, active, dashDistance, aimLockFrames, damage,
    hitbox: { ...MOVES.b_grab.hitbox, radius: hitRadius / boss.scale },
  };
}

function openGrabMode(enabled) {
  const url = new URL(location.href);
  if (enabled) url.searchParams.set('grabTest', '1');
  else url.searchParams.delete('grabTest');
  location.assign(url);
}

function startGrabTest() {
  if (!combatReady || settingsOpen()) return;
  resetFight();
  Object.assign(MOVES.b_grab, grabTestMove());
  CFG.paused = false;
  boss.setState('attack', 'b_grab');
  syncGUI();
}

function stepGrabTest() {
  if (!combatReady || settingsOpen()) return;
  const stopped = hitstopFrames > 0;
  CFG.paused = false;
  tick();
  updateCamera(STEP);
  render(stopped ? 0 : STEP);
  CFG.paused = true;
  acc = 0;
  syncGUI();
}

const grabTestPhases = { held: '抓举', toss: '抛空', flight: '踢飞', wall: '撞墙' };
function updateGrabTestStatus() {
  const move = boss.move;
  if (!combatReady) grabTest.status = '等待加载';
  else if (grabSequence?.phase === 'held' && grabSequence.age >= GRAB_TIMING.lift) grabTest.status = '举起 · 挣扎';
  else if (grabSequence) grabTest.status = grabTestPhases[grabSequence.phase];
  else if (!move?.grab) grabTest.status = '待命 · G 出招';
  else if (boss.frame < move.startup) grabTest.status = '红光预警';
  else if (boss.frame < move.startup + move.active) grabTest.status = '突进抓取';
  else grabTest.status = boss.grabConnected ? '命中收招' : '抓空收招';
}

if (grabTestMode) {
  for (const folder of gui.folders) folder.hide();
  document.getElementById('help').textContent = 'G 出招 · R 复位 · WASD 移动 · Shift / Space 翻滚 · Tab 释放鼠标 · F1 判定框 · F2 慢放 · F3 暂停';
  gui.add(grabTest, 'status').name('当前阶段').listen().disable();
  gui.add({ run: startGrabTest }, 'run').name('施放擒拿 (G)');
  gui.add({ reset: resetFight }, 'reset').name('场景复位 (R)');
  gui.add({ step: stepGrabTest }, 'step').name('单步一帧');
  gui.add(grabTest, 'location', ['场地中央', '近墙']).name('起始位置').onChange(resetFight);
  gui.add(grabTest, 'distance', 2.5, 8, 0.05).name('起始距离 (m)');
  const params = gui.addFolder('擒拿参数 · 下次出招生效').open();
  params.add(grabTest, 'startup', 8, 120, 1).name('红光预警 (帧)');
  params.add(grabTest, 'active', 3, 40, 1).name('突进抓取 (帧)');
  params.add(grabTest, 'dashDistance', 1, 9, 0.05).name('突进距离 (m)');
  params.add(grabTest, 'hitRadius', 0.2, 2.5, 0.01).name('抓取半径 (m)');
  params.add(grabTest, 'aimLockFrames', 0, 30, 1).name('提前锁方向 (帧)');
  params.add(grabTest, 'damage', 0, 600, 5).name('踢击伤害');
  const debug = gui.addFolder('播放与判定').open();
  debug.add(CFG, 'showHitbox').name('判定框 (F1)').listen();
  debug.add(CFG, 'timeScale', 0.05, 2, 0.05).name('播放速度 (F2)').listen();
  debug.add(CFG, 'paused').name('暂停 (F3)').listen();
  debug.add({ export: downloadJSON }, 'export').name('导出擒拿参数 (P)');
  gui.add({ exit: () => openGrabMode(false) }, 'exit').name('返回正常对战');
}

function downloadJSON() {
  const data = grabTestMode ? JSON.stringify({ MOVES: { b_grab: grabTestMove() } }, null, 2) : dumpJSON();
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moves-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════════
// 10. 重开
// ═══════════════════════════════════════════════════════════════
function finishBossIntro() {
  if (!bossIntro) return;
  bossIntro.dispose();
  bossIntro = null;
  document.body.classList.remove('boss-intro');
  camera.fov = settings.state().fov;
  camera.updateProjectionMatrix();
  clearInput();
  acc = 0;
}

function resetFight() {
  finishBossIntro();
  grabSequence = null;
  if (grabTestMode) {
    const playerZ = grabTest.location === '近墙' ? playerWallRadius() - 0.32 : 2.9;
    player.reset([0, playerZ], Math.PI);
    player.lockOn = true;
    boss.reset([0, playerZ - grabTest.distance], 0);
    acc = 0;
  } else {
    player.reset([0, 8], Math.PI);
    boss.reset([0, -8], 0);
  }
  Object.assign(AI, initialBossAI());
  clearBufferedInput();
  STAGE.setPhase(1);
  ultimateCast = null;
  if (typeof snapCamera === 'function') snapCamera();
  rng = mulberry32(0xC0FFEE);
  logicFrame = 0;
  hitstopFrames = 0;
  shakeAmt = 0;
  vfx.clear();
  dodgeEffect.clear();
  perfectDodgeFrame = null;
  dodgeSlowTime = 0;
  dodgeVisualAlpha = 1;
  acc = 0;
  ultimateEnergy = 0;
  releasedUltimate = null;
  ultimateEffect.clear();
  meteorSmash = null;
  impactImpulse = 0;
  bossSmashEffect.clear();
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
let combatReady = false, assetsReady = false;
const menuTime = performance.now();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function frameTitle(now) {
  const drift = reducedMotion.matches ? 0 : Math.sin((now - menuTime) * .00022);
  const wide = camera.aspect > 1.2;
  camera.position.set(-9.5 + drift * 2.1, 14.0 + drift * .70, 34.5);
  camera.lookAt(wide ? -26 : -3.7, wide ? 26 : 34, -59);
}

function startGame() {
  if (!assetsReady || combatReady || (atTitle && settingsOpen())) return;
  const fromTitle = atTitle;
  combatReady = true;
  setTitleVisible(false);
  document.body.classList.remove('booting');
  resetFight();
  for (const actor of [player, boss]) actor.mesh.group.visible = true;
  if (!grabTestMode && boss.weapon) {
    bossIntro = createBossIntro(scene, boss, camera, STAGE.impactSurface);
    if (bossIntro) document.body.classList.add('boss-intro');
  }
  lastTime = performance.now();
  if (fromTitle) canvas.focus({ preventScroll: true });
  if (!bossIntro) banner(frameIssues.length ? `帧数据越界 ${frameIssues.length} 项 · 见 console` : '点击战斗画面捕获鼠标', 1800);
}

function returnToTitle() {
  if (!combatReady || grabTestMode) return;
  combatReady = false;
  settings.open(false);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  CFG.paused = false;
  clearInput();
  acc = 0;
  resetFight();
  player.mesh.group.visible = boss.mesh.group.visible = false;
  setTitleVisible(true);
  frameTitle(performance.now());
  startButton.focus({ preventScroll: true });
}

function completeLoading() {
  const target = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  try {
    renderer.compile(ultimateEffect.root, camera, scene);
    renderer.compile(bossSmashEffect.root, camera, scene);
  } finally {
    renderer.setRenderTarget(target);
  }
  dodgeEffect.prepare(player.binder?.root ?? player.mesh.group, renderer, camera, composer.readBuffer);
  assetsReady = true;
  startButton.disabled = false;
  const status = document.getElementById('titleLoading');
  status.textContent = status.dataset.fallback ? '部分模型未能加载，仍可开始游戏' : '';
  if (!atTitle) {
    startGame();
    return;
  }
  if (!settingsOpen() && document.activeElement === document.body) startButton.focus({ preventScroll: true });
}

async function attachModels() {
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
  if (!pUrl && !bUrl) {
    player.mesh.group.visible = boss.mesh.group.visible = false;
    completeLoading();
    return;
  }

  const actors = [player, boss];
  for (const actor of actors) actor.mesh.group.visible = false;

  try {
    const { bindModel, loadAnimationPack, loadClipPack, loadClipJSON, dampenArmSwing } = await import('./asset-adapter.js');
    banner('加载模型…', 1500);
    const models = await Promise.allSettled([
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
    const failedModel = models.find(result => result.status === 'rejected');
    if (failedModel) throw failedModel.reason;

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
      const counts = await Promise.all(actors.filter(actor => actor.binder).map(actor => loadAnimationPack(actor.binder)));
      if (player.binder && pUrl === 'assets/player/player.glb') {
        try {
          playerUltimateMotion = await loadPlayerUltimate(player.binder);
        } catch (error) {
          console.warn('[ultimate] Could not load the supplied move:', error);
        }
      }
      const grabClips = [
        [boss.binder, 'grabKick', 'assets/anims/GrabSideKick.json'],
        [player.binder, 'grabGetUp', 'assets/anims/GrabGetUp.json'],
      ];
      await Promise.all(grabClips.map(async ([binder, key, url]) => {
        if (!binder) return;
        try {
          const clip = await loadClipJSON(binder, url);
          if (clip.tracks.length) binder.clipMap[key] = clip.name;
        } catch (error) {
          console.warn('[grab-anim] 动作加载失败:', key, error);
        }
      }));

      // Boss 用自带动作包（assets/boss_anims.glb，同一套 Tripo 骨架，直接播）
      let bossPicked = 0;
      if (boss.binder) {
        if (bUrl === 'assets/boss_model_v2.glb') {
          try {
            await loadNativeClip(boss.binder, 'assets/anims/BossMeteorSmashSource.json', 'b_meteor', METEOR.end / 60);
          } catch (error) {
            console.warn('[boss-anim] 无法加载蓄力一击:', error);
          }
        }
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

        if (bUrl === 'assets/boss_model_v2.glb') {
          try {
            const clip = await loadClipJSON(boss.binder, 'assets/anims/Sword_Heavy_Combo.json', { raw: true });
            if (clip.tracks.length) boss.binder.clipMap.b_heavy_combo = clip.name;
          } catch (e) {
            console.warn('[boss-anim] 重剑四连斩加载失败:', e);
          }
        }

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

    if (boss.binder && bUrl === 'assets/boss_model_v2.glb') tintBossFace(boss.binder.root);
    setupDragWeapon();
  } catch (err) {
    console.warn('[asset] 模型加载失败，保持灰盒：', err);
    document.getElementById('titleLoading').dataset.fallback = 'true';
  } finally {
    completeLoading();
  }
}

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
  onOpen: clearInput,
  onFrameDataVisibilityChange: grabTestMode ? undefined : visible => {
    gui.show(visible);
    hud.classList.toggle('show-debug', visible);
  },
  onPreset: (name) => { qualityName = name; },
});
window.__settingsApi = settings;
settings.bind();
canvas.tabIndex = -1;
startButton.addEventListener('click', startGame);
exitToTitle.addEventListener('click', returnToTitle);
document.getElementById('titleSettings').addEventListener('click', () => settings.open(true));
// 预编译所有材质的着色器，避免第一次看到某个物体时卡一下
renderer.compile(scene, camera);
snapCamera();
requestAnimationFrame(loop);
attachModels();
