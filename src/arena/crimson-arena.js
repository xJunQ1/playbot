import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { buildStage, updateStage } from './stage.js';

// ═══════════════════════════════════════════════════════════════
//  展示页：只负责渲染器 / 相机 / 后处理 / 机位
//  场景本体在 stage.js（战斗也用它），改美术不用改两处
// ═══════════════════════════════════════════════════════════════

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(33, innerWidth / innerHeight, 0.5, 1200);
const lookAt = new THREE.Vector3(0, -5, 0);
camera.position.set(0, 76, 60);
camera.lookAt(lookAt);

const stage = buildStage(scene);

// ── 后处理：GTAO 压凹缝 → 泛光 → 输出
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({
  radius: 1.2, distanceExponent: 1.3, thickness: 2.0, scale: 0.85,
  samples: 24, distanceFallOff: 1.0, screenSpaceRadius: false,
});
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
composer.addPass(gtao);

const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.7, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── 机位
const VIEWS = {
  '1': { pos: [0, 76, 60], look: [0, -5, 0], fov: 33 },
  '2': { pos: [0, 123, 0.5], look: [0, 0, 0], fov: 28 },
  '3': { pos: [17, 13, 17], look: [0, 1.5, 0], fov: 44 },
  '4': { pos: [0, 5, 24], look: [0, 4.4, 34], fov: 52 },
  '5': { pos: [22, 2, 22], look: [29, 1.5, 29], fov: 46 },
  '6': { pos: [38, 8, 38], look: [32, 5, 32], fov: 34 },
  '7': { pos: [10, 7, 10], look: [15, 6.4, 15], fov: 42 },
};

function applyView(v) {
  camera.position.set(...v.pos);
  lookAt.set(...v.look);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(lookAt);
}

addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'g') gtao.enabled = !gtao.enabled;
  if (VIEWS[e.key]) applyView(VIEWS[e.key]);
  if (e.key.toLowerCase() === 'h') {
    const el = document.getElementById('hint');
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
});

// ── 渲染循环
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  updateStage(t, camera);
  camera.lookAt(lookAt);
  composer.render();
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  gtao.setSize(innerWidth, innerHeight);
});

window.__arena = { scene, camera, renderer, bloom, gtao, stage, radius: stage.radius };
