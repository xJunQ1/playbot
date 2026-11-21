import * as THREE from 'three';
import * as T from './tex.js';
import { buildArenaProps } from './props.js';
import { arenaRailings, ruinedColumns, towerStonework, wallCrownColumns } from './stonework.js';
import { brazierFlame, carvedRobe, chippedStone, cloudLayer, fracturedRock, wovenCloth } from './weathered.js';
import { guardFromAO } from '../vfx/ao-guard.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ═══════════════════════════════════════════════════════════════
//  擂台舞台：浮空要塞 · 猩红魔法竞技场
//  只负责「往一个已有的 scene 里搭场景」，不碰渲染器 / 相机 / 后处理，
//  所以展示页（crimson-arena.js）和战斗（main.js）可以共用同一份美术。
// ═══════════════════════════════════════════════════════════════

export const ARENA_R = 22;      // 台面半径（战斗可用半径 = 这个再减栏杆和体型）
const WALK = ARENA_R - 1.4;     // 栏杆所在半径
const GOLD = 0xe9c17a;

let ST = null;                  // 动画需要的引用（由 buildStage 填）

// ── 阶段切换（一阶段 / 二阶段）────────────────────────────────
//  二阶段把场景推到「血月」：法阵转猩红、雾变浓变红、火盆变血焰、天光压暗。
//  只改材质/灯光参数，不重建任何几何，所以切换是零成本的。
const REFS = { washLights: [], decor: [] };
const FOG_P2 = new THREE.Color(0x4a1420);
const SKY_BASE = { top: new THREE.Color(0x5b4d73), mid: new THREE.Color(0xc8aec6), bot: new THREE.Color(0x1b1626) };
const SKY_P2 = { top: new THREE.Color(0x180810), mid: new THREE.Color(0x5c1726), bot: new THREE.Color(0x0b0509) };
let PHASE_MIX = 0;      // 0 = 一阶段，1 = 二阶段
let PHASE_TARGET = 0;

export function setStagePhase(phase) {
  PHASE_TARGET = phase >= 2 ? 1 : 0;
}

export function buildStage(scene, opts = {}) {
  const R = ARENA_R;
  PHASE_MIX = PHASE_TARGET = 0;
  REFS.decor = [];
  REFS.washLights = [];
  const weatherTime = { value: 0 }, bloodMoon = { value: 0 };
  // 展示页需要法阵亮一点；战斗里第三人称贴地看，太亮会糊成霓虹
  const MAGIC_OPACITY = opts.magicOpacity ?? 1.0;
// ── 贴图
const TEXLOW = new URLSearchParams(location.search).get('tex') === 'low';
const floorTextures = T.makeFloorTextures(TEXLOW ? 1024 : 2048, R * 2);
const masonry = T.makeMasonryTextures(TEXLOW);
const texMagic = T.makeMagicTexture(TEXLOW ? 2048 : 4096, R * 2, R / 22);
// 金线非常细：各向异性过滤开到最大，否则贴着看/斜着看时细线会在 mip 里被抹掉，
// 表现为「金色花纹时而出现时而消失」
texMagic.anisotropy = 8;
texMagic.minFilter = THREE.LinearMipmapLinearFilter;
texMagic.magFilter = THREE.LinearFilter;
texMagic.generateMipmaps = true;
texMagic.needsUpdate = true;
const texStone = T.makeStoneTexture(TEXLOW ? 256 : 512, [62, 56, 74]);
const texStoneDark = T.makeStoneTexture(TEXLOW ? 256 : 512, [44, 39, 55]);
// 用同一张石面贴图当高度图算法线：一步就把「平铺的塑料面」变成有凹凸的石头
const nrmStone = T.makeNormalMap(texStone.image, 2.4);
const nrmStoneDark = T.makeNormalMap(texStoneDark.image, 2.4);
// 墙面浮雕法线：一个开间（壁柱 + 尖拱盲窗 + 卷草 + 束带）
const texRelief = T.makeReliefTile(1024);
const nrmRelief = T.makeNormalMap(texRelief, 3.4);
nrmRelief.repeat.set(34, 1);
const albedoRelief = T.makeReliefAlbedo(texRelief, texStone.image);
albedoRelief.repeat.set(34, 1);
// 柱身浮雕：8 道竖槽 + 柱头束带
const colReliefCanvas = T.makeColumnRelief(512);
const nrmColumn = T.makeNormalMap(colReliefCanvas, 2.5);
const albedoColumn = T.makeReliefAlbedo(colReliefCanvas, texStone.image, '150,140,182', 0.26);
albedoColumn.repeat.set(3, 4);
nrmColumn.repeat.set(3, 4);
const matColumn = new THREE.MeshStandardMaterial({
  map: albedoColumn, normalMap: nrmColumn, normalScale: new THREE.Vector2(2.4, 2.4),
  color: 0xd7cfd8, emissive: 0x231d2d, emissiveIntensity: 1.0,
  roughness: 0.93, metalness: 0.03,
});
const matLeaf = new THREE.MeshStandardMaterial({
  map: texStone, normalMap: nrmStone, normalScale: new THREE.Vector2(0.8, 0.8),
  color: 0xe8dcf8, emissive: 0x2a2038, emissiveIntensity: 1.0,
  roughness: 0.9, metalness: 0.03,
});

// 柱头：一圈茛苕叶浮雕
const capReliefCanvas = T.makeCapitalRelief(512);
const nrmCapital = T.makeNormalMap(capReliefCanvas, 3.2);
nrmCapital.repeat.set(2, 1);
const albedoCapital = T.makeReliefAlbedo(capReliefCanvas, texStone.image, '150,140,182', 0.24);
albedoCapital.repeat.set(2, 1);
const matCapital = new THREE.MeshStandardMaterial({
  map: albedoCapital, normalMap: nrmCapital, normalScale: new THREE.Vector2(2.2, 2.2),
  color: 0xe4d6f4, emissive: 0x362a48, emissiveIntensity: 1.0,
  roughness: 0.92, metalness: 0.03,
});

const clothMaterial = wovenCloth(T.makeBannerTexture(), weatherTime);
const texFlame = T.makeFlameTexture();
const texLeaf = T.makeLeafTexture();
const rockGeometry = fracturedRock();

// ── 叶片几何：在 XY 平面画茛苕叶轮廓 → 挤出 → 弯到柱头的圆柱面上
function makeLeafGeometry(w = 0.6, h = 1.2, depth = 0.07, radius = 2.55) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(-w * 0.55, h * 0.25, -w * 0.42, h * 0.55);
  s.quadraticCurveTo(-w * 0.78, h * 0.63, -w * 0.28, h * 0.78);
  s.quadraticCurveTo(-w * 0.44, h * 0.93, 0, h);
  s.quadraticCurveTo(w * 0.44, h * 0.93, w * 0.28, h * 0.78);
  s.quadraticCurveTo(w * 0.78, h * 0.63, w * 0.42, h * 0.55);
  s.quadraticCurveTo(w * 0.55, h * 0.25, 0, 0);

  const geo = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018,
    bevelSegments: 2, curveSegments: 10,
  });

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ang = x / radius;
    const r = radius + z;
    pos.setXYZ(i, Math.sin(ang) * r, y, Math.cos(ang) * r - radius);
  }
  geo.computeVertexNormals();
  return geo;
}

// ── 材质
const matStone = new THREE.MeshStandardMaterial({
  map: texStone, normalMap: nrmStone, normalScale: new THREE.Vector2(1.1, 1.1),
  color: 0xd2c9de, roughness: 0.92, metalness: 0.04,
});
const matStoneDark = new THREE.MeshStandardMaterial({
  map: texStoneDark, normalMap: nrmStoneDark, normalScale: new THREE.Vector2(1.2, 1.2),
  color: 0xa89ebc, roughness: 0.96, metalness: 0.02,
});
const matFloor = new THREE.MeshStandardMaterial({
  ...floorTextures, normalScale: new THREE.Vector2(0.92, 0.92),
  color: 0xddd9e4, roughness: 0.98, metalness: 0.02,
});
const dressedTile = T.makeStoneTexture(TEXLOW ? 384 : 768, [105, 99, 105]);
const brokenTile = T.makeStoneTexture(TEXLOW ? 256 : 512, [135, 128, 121]);
const grainUrl = new URL('../../assets/arena/basalt-grain.webp', import.meta.url);
new THREE.ImageLoader().load(grainUrl.href, image => {
  T.layerStoneGrain(floorTextures.map, image, TEXLOW ? 16 : 24, 0.78);
  T.layerStoneGrain(masonry.map, image, 26, 0.70);
  T.layerStoneGrain(texStone, image, 1, 0.72);
  T.layerStoneGrain(texStoneDark, image, 1, 0.56);
  T.layerStoneGrain(albedoRelief, image, 2, 0.58);
  T.layerStoneGrain(albedoColumn, image, 1, 0.60);
  T.layerStoneGrain(albedoCapital, image, 1, 0.54);
  T.layerStoneGrain(dressedTile, image, 1, .91);
  T.layerStoneGrain(brokenTile, image, 1, .87);
});
const brassTex = T.makeBrassTextures(512);
const matGoldLine = new THREE.MeshStandardMaterial({
  map: brassTex.map, roughnessMap: brassTex.roughnessMap,
  color: 0xd5aa70, emissive: 0x4b2a11, emissiveIntensity: 0.35,
  roughness: 0.62, metalness: 0.82,
});
const ironPatina = T.makeStoneTexture(256, [127, 111, 107]);
const matIron = new THREE.MeshStandardMaterial({
  map: ironPatina, bumpMap: ironPatina, bumpScale: .045, color: 0x989190,
  emissive: 0x130c0d, emissiveIntensity: .52, roughness: .76, metalness: .53,
  side: THREE.DoubleSide,
});
const columnMaterials = {
  dressed: new THREE.MeshStandardMaterial({
    map: dressedTile, bumpMap: dressedTile, bumpScale: .085, color: 0xd9c9bc,
    roughness: .94, vertexColors: true,
  }),
  fracture: new THREE.MeshStandardMaterial({
    map: brokenTile, bumpMap: brokenTile, bumpScale: .112, color: 0xd1bab0,
    roughness: 1, vertexColors: true, flatShading: true,
  }),
  seams: new THREE.MeshStandardMaterial({
    map: dressedTile, bumpMap: dressedTile, bumpScale: .065, color: 0x948385,
    roughness: 1, vertexColors: true,
  }),
  metal: matIron,
};
const matCrimson = new THREE.MeshStandardMaterial({ color: 0x7d1024, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
// 给材质命名：Electron 里如果某个材质编译失败，日志能直接指出是哪一个
matFloor.name = 'floor';
matStone.name = 'stone';
matStoneDark.name = 'stoneDark';
matGoldLine.name = 'goldLine';
matIron.name = 'iron';
matCrimson.name = 'crimson';

const root = new THREE.Group();
  const obstacles = [];   // 战斗平面的立柱圆形和倒柱旋转矩形
scene.add(root);

// ═══════════════════════════════════════ 天空
function buildSky() {
  const geo = new THREE.SphereGeometry(600, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    precision: 'highp',
    uniforms: {
      cTop: { value: new THREE.Color(0x5b4d73) },
      cMid: { value: new THREE.Color(0xc8aec6) },
      cBot: { value: new THREE.Color(0x1b1626) },
      time: { value: 0 },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec3 vP;
      uniform vec3 cTop, cMid, cBot;
      uniform float time;
      float noise(vec3 p) {
        vec3 i = floor(p), w = fract(p);
        w = w * w * (3.0 - 2.0 * w);
        const vec3 hashAxis = vec3(127.1, 311.7, 74.7);
        float q = dot(i, hashAxis);
        vec4 xz = fract(sin(q + vec4(0.0, hashAxis.x, hashAxis.z, hashAxis.x + hashAxis.z)) * 43758.5453);
        vec4 top = fract(sin(q + hashAxis.y + vec4(0.0, hashAxis.x, hashAxis.z, hashAxis.x + hashAxis.z)) * 43758.5453);
        vec2 a = mix(xz.xz, xz.yw, w.x);
        vec2 b = mix(top.xz, top.yw, w.x);
        vec2 slice = mix(a, b, w.y);
        return mix(slice.x, slice.y, w.z);
      }
      void main(){
        vec3 direction = normalize(vP);
        float h = direction.y * 0.5 + 0.5;
        vec3 c = mix(cBot, cMid, smoothstep(0.0, 0.55, h));
        c = mix(c, cTop, smoothstep(0.5, 1.0, h));
        vec3 p = direction * vec3(4.2, 12.0, 4.2) + vec3(time * 0.016, 0.0, time * 0.008);
        float clouds = noise(p) * 0.65 + noise(p * 2.35 + 11.7) * 0.25 + noise(p * 5.0) * 0.10;
        float horizon = smoothstep(0.36, 0.51, h) * (1.0 - smoothstep(0.66, 0.9, h));
        c = mix(c, c * 0.54, smoothstep(0.46, 0.82, clouds) * horizon * 0.63);
        c += cMid * (1.0 - smoothstep(0.12, 0.35, clouds)) * horizon * 0.14;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  scene.add(m);
  REFS.skyMat = mat;
}
buildSky();

// ═══════════════════════════════════════ 台面 + 底座
function mapDeckGeometry(geometry) {
  geometry.rotateX(-Math.PI / 2);
  const { position, uv } = geometry.attributes;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) / (2 * R) + 0.5, position.getZ(i) / (2 * R) + 0.5);
  }
  return geometry;
}

function deckHeight(x, z) {
  const uneven = 0.5 + 0.28 * Math.sin(x * 0.55 + 1.7) * Math.cos(z * 0.48 - 0.6)
    + 0.14 * Math.sin(x * 1.31 - 0.4) * Math.cos(z * 1.17 + 2.1)
    + 0.08 * Math.sin(x * 2.9 + 3.1) * Math.cos(z * 3.3);
  const edge = THREE.MathUtils.clamp((R - Math.hypot(x, z)) / 1.6, 0, 1);
  return -0.001 - uneven * 0.03 * edge;
}

function buildPlatform() {
  // 主石台：侧面深、顶面石板、底面也铺一层（从下往上看要塞时不会穿帮）
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.005, 2.6, 160, 1), [
    matStoneDark, matFloor, matStoneDark,
  ]);
  // 台体顶面压到台面起伏之下，否则起伏层往下凹的地方会露出这一层，形成大片灰色楔形色块
  top.position.y = -1.36;
  top.receiveShadow = true;
  root.add(top);

  // 外沿压边（三层线脚）
  for (const [r, y, t] of [[R + 0.05, 0.12, 0.34], [R + 0.1, -0.1, 0.2], [R - 0.05, -0.42, 0.22]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 10, 180), matStone);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = y;
    root.add(ring);
  }

  // 内侧走道（参考图里法阵外还有一圈更高的环廊）
  const walk = new THREE.Mesh(mapDeckGeometry(new THREE.RingGeometry(WALK - 2.9, WALK + 0.55, 140, 1)), matFloor);
  walk.position.y = 0.16;
  walk.receiveShadow = true;
  root.add(walk);

  // 走道内外两道铜线
  for (const r of [WALK - 2.95, WALK + 0.6]) {
    const line = new THREE.Mesh(new THREE.RingGeometry(r - 0.05, r + 0.05, 200, 1), matGoldLine);
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.18;
    root.add(line);
  }

  // 底座：倒锥形的岩体，用扰动过的顶点做出碎裂感
  const rockGeo = new THREE.CylinderGeometry(R * 0.97, R * 0.16, 17, 72, 6, true);
  const pos = rockGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + (Math.sin(x * 1.7) * Math.cos(z * 1.3) + Math.sin(y * 2.1)) * 0.055;
    pos.setXYZ(i, x * k, y - 1.4, z * k);
  }
  rockGeo.computeVertexNormals();
  const rock = new THREE.Mesh(rockGeo, matStoneDark);
  // 底座是倒锥，顶点扰动后上缘会窜到台面之上；压到台面以下，
  // 否则贴边战斗时镜头会看到一大片岩体斜插在画面里
  rock.position.y = -7.6;
  rock.receiveShadow = true;
  root.add(rock);

  // 底座外圈的悬挂岩块
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.1;
    const rr = R * (0.9 + Math.random() * 0.12);
    const s = 0.9 + Math.random() * 2.4;
    const m = new THREE.Mesh(rockGeometry, matStoneDark);
    m.scale.set(s, s * (1.4 + Math.random()), s * .91);
    m.position.set(Math.cos(a) * rr, -2.2 - Math.random() * 9, Math.sin(a) * rr);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    root.add(m);
  }
}
buildPlatform();

// 台沿亮边：把台面和外面那圈壕沟分开
(function buildRimLine() {
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.35, R + 0.05, 160, 1),
    new THREE.MeshBasicMaterial({ color: 0xb9a4d0, transparent: true, opacity: 0.26, depthWrite: false, toneMapped: false })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.03;
  root.add(rim);
})();

// ═══════════════════════════════════════ 墙体厚度 + 尖拱窗棂 + 爬墙藤
//  原来墙体是一张单面圆筒；这里补内壳、顶部环面、压顶线，再开窗、铺藤，
//  近看才有「石砌厚墙」而不是「一张纸弯成圆」。
(function buildWallDepthAndIvy() {
  const rTop = R + 11, rBot = R + 13, H = 24, baseY = -15, topY = baseY + H, gap = 0.34;
  const matInner = new THREE.MeshStandardMaterial({
    ...masonry, normalScale: new THREE.Vector2(.63, .63),
    color: 0xc3bec7, emissive: 0x1e1a27, emissiveIntensity: 1.0,
    roughness: 0.96, metalness: 0.02, side: THREE.DoubleSide,
  });
  const matTrim = new THREE.MeshStandardMaterial({
    map: texStone, normalMap: nrmStone, color: 0xc9bedb, roughness: 0.92, metalness: 0.02,
  });

  // 内层壳
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop - 1.7, rBot - 1.7, H, 96, 1, true, Math.PI + gap / 2, Math.PI * 2 - gap),
    matInner
  );
  inner.position.y = baseY + H / 2;
  inner.name = 'weathered-ashlar-wall';
  root.add(inner);

  const frieze = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop - 1.60, rTop - 1.55, 1.10, 120, 1, true, Math.PI + gap / 2, Math.PI * 2 - gap),
    new THREE.MeshStandardMaterial({
      map: albedoRelief, normalMap: nrmRelief, normalScale: new THREE.Vector2(.56, .56),
      color: 0x9c909e, emissive: 0x241e2b, roughness: .96, side: THREE.DoubleSide,
    })
  );
  frieze.position.y = topY - .76;
  root.add(frieze);

  // 顶部环面：墙从此有了厚度
  const cap = new THREE.Mesh(
    new THREE.RingGeometry(rTop - 1.7, rTop + 0.4, 96, 1, Math.PI + gap / 2, Math.PI * 2 - gap),
    matTrim
  );
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = topY + 0.02;
  scene.add(cap);

  // 压顶圆线（内外两道）
  for (const [rr, tube] of [[rTop - 0.1, 0.3], [rTop - 1.75, 0.22]]) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(rr, tube, 6, 160), matTrim);
    t.rotation.x = -Math.PI / 2;
    t.position.y = topY + 0.3;
    scene.add(t);
  }

  // 尖拱窗：暗洞口 + 三竖棂 + 三横棂 + 圆窗 + 石框
  const winW = 1.05, winH = 3.2, archK = 1.35;
  for (let i = 0; i < 12; i++) {
    const a = ((i + 0.5) / 12) * Math.PI * 2 + Math.PI / 12;
    const d = Math.abs(((a - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < 0.2) continue;

    const g = new THREE.Group();
    const wallR = rTop - 1.05;
    g.position.set(Math.cos(a) * wallR, 0.6, Math.sin(a) * wallR);
    g.lookAt(0, 0.6, 0);

    const shp = new THREE.Shape();
    shp.moveTo(-winW, -winH);
    shp.lineTo(-winW, winH);
    shp.quadraticCurveTo(0, winH + archK, winW, winH);
    shp.lineTo(winW, -winH);
    shp.closePath();
    const lit = i % 4 === 1;
    const hole = new THREE.Mesh(
      new THREE.ShapeGeometry(shp, 16),
      lit
        ? new THREE.MeshStandardMaterial({
            color: 0x241619, emissive: 0x7c4027, emissiveIntensity: 0.45,
            roughness: 1.0, side: THREE.DoubleSide,
          })
        : new THREE.MeshBasicMaterial({ color: 0x0c0916, side: THREE.DoubleSide })
    );
    g.add(hole);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(winW * 2.38, .22, .48), matTrim);
    sill.position.set(0, -winH - .03, .22);
    g.add(sill);

    for (const mx of [-winW * 0.5, 0, winW * 0.5]) {
      const mull = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, winH * 2, 5), matTrim);
      mull.position.set(mx, 0, 0.07);
      g.add(mull);
    }
    for (const my of [-winH * 0.45, 0, winH * 0.45]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, winW * 2, 5), matTrim);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0, my, 0.07);
      g.add(bar);
    }
    const oc = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.06, 5, 16), matTrim);
    oc.position.set(0, winH * 0.62, 0.07);
    g.add(oc);

    // 石框：沿洞口轮廓走一圈细管
    const framePts = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const x = -winW + t * winW * 2;
      const y = t <= 0.5
        ? winH + Math.sin(t * Math.PI) * archK
        : winH + Math.sin((1 - t) * Math.PI) * archK;
      framePts.push(new THREE.Vector3(x, y, 0.05));
    }
    framePts.unshift(new THREE.Vector3(-winW, -winH, 0.05));
    framePts.push(new THREE.Vector3(winW, -winH, 0.05));
    const frame = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(framePts), 40, 0.11, 5, false),
      matTrim
    );
    g.add(frame);
    scene.add(g);
  }

  // 爬墙藤：细管沿墙向上爬，叶子用实例化面片挂上去
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3b2230, roughness: 0.95 });
  const leafGeo = new THREE.PlaneGeometry(0.64, 0.58);
  const leafMat = new THREE.MeshStandardMaterial({
    map: texLeaf, color: 0xdebaad, emissive: 0x230d16, emissiveIntensity: 0.38,
    roughness: 0.82, side: THREE.DoubleSide, alphaTest: 0.42,
  });
  const leaves = [];
  const stems = [];
  for (let i = 0; i < (TEXLOW ? 35 : 64); i++) {
    const a0 = Math.random() * Math.PI * 2;
    let a = a0, y = -5 + Math.random() * 3;
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const r = rTop - 1.15 + Math.random() * 0.35;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      a += (Math.random() - 0.5) * 0.24;
      y += 0.7 + Math.random() * 1.4;
      if (y > 7.5) break;
    }
    if (pts.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(pts);
    stems.push(new THREE.TubeGeometry(curve, pts.length * 3, 0.036, 4, false));
    for (let k = 0; k < 29; k++) leaves.push(curve.getPoint(Math.random()));
  }
  const vines = new THREE.Mesh(mergeGeometries(stems), stemMat);
  for (const stem of stems) stem.dispose();
  root.add(vines);
  REFS.decor.push(vines);
  const inst = new THREE.InstancedMesh(leafGeo, leafMat, leaves.length);
  REFS.decor.push(inst);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  leaves.forEach((pt, i) => {
    e.set(Math.random() * 1.2 - 0.6, Math.random() * Math.PI * 2, Math.random() * 1.2 - 0.6);
    q.setFromEuler(e);
    const sc = 0.7 + Math.random() * 0.9;
    m.compose(
      pt.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5)),
      q,
      new THREE.Vector3(sc, sc, sc)
    );
    inst.setMatrixAt(i, m);
  });
  root.add(inst);
})();

// ═══════════════════════════════════════ 台面微起伏 + 人尺度道具
//  ① 台面不再是完美平面：只往下沉 0.3–3 cm，脚不会浮空
//  ② 断柱 / 倒柱 / 铁链：给 2 m 高的角色一个尺度参照
(function buildDeckSurfaceAndProps() {
  // ── 台面起伏
  const geo = mapDeckGeometry(new THREE.RingGeometry(0.01, R - 0.03, 160, 64));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, deckHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const deck = new THREE.Mesh(geo, matFloor);
  deck.name = 'arena-flagstone-deck';
  deck.receiveShadow = true;
  root.add(deck);

  // ── 断柱（立着的）
  const pillarSpecs = [
    { x: -8.6, z: 5.2, h: 2.1, r: 0.62 },
    { x: 7.8, z: -6.4, h: 2.6, r: 0.58 },
    { x: 2.4, z: 10.4, h: 1.35, r: 0.5 },
    { x: -10.2, z: -5.6, h: 1.7, r: 0.54 },
  ];
  const fallen = [
    { x: 6.2, z: 8.4, yaw: 0.7, len: 3.4 },
    { x: -4.4, z: -9.2, yaw: -0.4, len: 2.8 },
  ];
  ruinedColumns(root, pillarSpecs, fallen, columnMaterials, deckHeight);
  for (const p of pillarSpecs) {
    obstacles.push({ x: p.x, z: p.z, r: p.r * 1.35 });
    T.paintFloorContact(floorTextures.map, 2 * R, p.x, p.z, p.r * 2.5, p.r * 2.2);
  }
  for (const f of fallen) {
    T.paintFloorContact(floorTextures.map, 2 * R, f.x, f.z, f.len * .67, 1.064, f.yaw);
    obstacles.push({
      x: f.x, z: f.z, axisX: Math.cos(f.yaw), axisZ: -Math.sin(f.yaw),
      halfLength: f.len / 2 + .42 * .7, halfWidth: .56,
    });
  }

  const linksPerChain = 23;
  const link = new THREE.TorusGeometry(.088, .023, 6, 14);
  link.scale(.74, 1.43, 1);
  const chains = new THREE.InstancedMesh(link, matIron, linksPerChain * 3);
  chains.name = 'interlocked-iron-chains';
  const transform = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const roll = new THREE.Quaternion();
  const anchor = new THREE.TorusGeometry(.12, .035, 6, 14);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + .9;
    const x0 = Math.cos(a) * (R - 1.5), z0 = Math.sin(a) * (R - 1.5);
    const x1 = Math.cos(a) * (R - 4.2), z1 = Math.sin(a) * (R - 4.2);
    const endY = .235;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x0, 1.08, z0),
      new THREE.Vector3(THREE.MathUtils.lerp(x0, x1, .3), .61, THREE.MathUtils.lerp(z0, z1, .3)),
      new THREE.Vector3(THREE.MathUtils.lerp(x0, x1, .72), .29, THREE.MathUtils.lerp(z0, z1, .72)),
      new THREE.Vector3(x1, endY, z1),
    ]);
    for (let j = 0; j < linksPerChain; j++) {
      const t = j / (linksPerChain - 1);
      curve.getPointAt(t, transform.position);
      transform.quaternion.setFromUnitVectors(up, curve.getTangentAt(t));
      transform.quaternion.multiply(roll.setFromAxisAngle(up, (j % 2) * Math.PI / 2));
      transform.updateMatrix();
      chains.setMatrixAt(i * linksPerChain + j, transform.matrix);
    }
    for (const [x, y, z] of [[x0, 1.08, z0], [x1, endY, z1]]) {
      const eye = new THREE.Mesh(anchor, matIron);
      eye.position.set(x, y, z);
      eye.rotation.y = -a;
      root.add(eye);
    }
  }
  root.add(chains);
  REFS.decor.push(chains);
})();
// ═══════════════════════════════════════ 台面碎屑与裂缝贴花
//  贴地视角下，只靠贴图会像一张纸；加实物碎屑和裂缝，地面才有纵深。
(function buildFloorDetail() {
  // ① 裂缝贴花：14 张，随机旋转、大小 4~9m
  const crackTex = T.makeCrackTexture(512);
  const crackMat = new THREE.MeshBasicMaterial({
    map: crackTex, transparent: true, opacity: 0.56, depthWrite: false,
    toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const NO_CRACK = new URLSearchParams(location.search).get('cracks') === '0';
  for (let i = 0; i < (NO_CRACK ? 0 : 9); i++) {
    const a = Math.random() * Math.PI * 2;
    const site = obstacles[i % obstacles.length];
    const r = 0.6 + Math.random() * 2.6;
    const sc = 2.1 + Math.random() * 2.6;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sc, sc), crackMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(site.x + Math.cos(a) * r, 0.02, site.z + Math.sin(a) * r);
    root.add(m);
  }

  // Stone chips collect close to damaged masonry and against the perimeter.
  const rubbleGeo = new THREE.DodecahedronGeometry(1, 0);
  const rubbleMat = new THREE.MeshStandardMaterial({
    map: texStoneDark, normalMap: nrmStoneDark, normalScale: new THREE.Vector2(.72, .72),
    color: 0xc2b6c6, emissive: 0x16121d, roughness: 0.95, metalness: 0.02,
  });
  const count = TEXLOW ? 94 : 195;
  const inst = new THREE.InstancedMesh(rubbleGeo, rubbleMat, count);
  inst.name = 'grounded-stone-chips';
  const transform = new THREE.Object3D();
  const point = new THREE.Vector3(), tint = new THREE.Color();
  const stone = rubbleGeo.attributes.position;
  let seed = 68429;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2;
    const cluster = i < count * 0.63 ? obstacles[i % obstacles.length] : null;
    const r = cluster ? 0.58 + random() * (cluster.halfLength ? 2.45 : 1.80) : 12.2 + random() * 7.7;
    const x = (cluster?.x ?? 0) + Math.cos(a) * r;
    const z = (cluster?.z ?? 0) + Math.sin(a) * r;
    const scale = 0.026 + Math.pow(random(), 2.4) * (cluster ? 0.21 : 0.12);
    transform.rotation.set(random() * 3.2, random() * Math.PI * 2, random() * 3.1);
    transform.scale.set(scale * (0.9 + random() * 0.8), scale * 0.66, scale);
    let bottom = Infinity;
    for (let v = 0; v < stone.count; v++) {
      point.fromBufferAttribute(stone, v).multiply(transform.scale).applyQuaternion(transform.quaternion);
      bottom = Math.min(bottom, point.y);
    }
    const deckY = Math.hypot(x, z) >= WALK - 2.9 ? .16 : deckHeight(x, z);
    transform.position.set(x, deckY - bottom - 0.014, z);
    transform.updateMatrix();
    inst.setMatrixAt(i, transform.matrix);
    inst.setColorAt(i, tint.setScalar(.61 + random() * .37));
  }
  inst.receiveShadow = true;
  root.add(inst);
  REFS.decor.push(inst);
})();
// ═══════════════════════════════════════ 石作细部：线脚 / 牛腿 / 铜饰 / 壁龛
//  这些是「不像积木」的关键：轮廓上叠涩、转折处有牛腿、墙面有凹龛和束带，
//  眼睛读到的是石作的层次，而不是几个基本体拼起来。
(function buildDetail() {
  // 台沿线脚：三段叠涩，一次 lathe 成形
  const prof = [
    [R + 0.02, -1.30], [R + 0.66, -1.18], [R + 0.84, -0.96], [R + 0.78, -0.74],
    [R + 0.54, -0.60], [R + 0.50, -0.42], [R + 0.66, -0.30], [R + 0.72, -0.14],
    [R + 0.56, 0.00], [R + 0.30, 0.06], [R + 0.24, 0.16], [R - 0.02, 0.18],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const cornice = new THREE.Mesh(new THREE.LatheGeometry(prof, 200), matStone);
  cornice.castShadow = true;
  cornice.receiveShadow = true;
  root.add(cornice);

  // 檐下牛腿：锥形石托，一圈 28 个
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const g = new THREE.Group();
    g.position.set(Math.cos(a) * (R + 0.5), -0.66, Math.sin(a) * (R + 0.5));
    g.rotation.y = -a;
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.58, 1.5, 6), matStoneDark);
    br.rotation.z = Math.PI / 2;
    br.position.x = 0.35;
    g.add(br);
    root.add(g);
  }

  // 地面铜饰：三道嵌铜环 + 12 道细铜条
  for (const rr of [R * 0.44, R * 0.63, R * 0.81]) {
    const inlay = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.055, 6, 200), matGoldLine);
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.y = 0.035;
    root.add(inlay);
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 24;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(R * 0.37, 0.02, 0.09), matGoldLine);
    strip.position.set(Math.cos(a) * R * 0.62, 0.033, Math.sin(a) * R * 0.62);
    strip.rotation.y = -a;
    root.add(strip);
  }

  // 城墙内侧：24 个内凹尖拱壁龛 + 两道束带 + 檐下小托石
  const rIn = R + 10.4;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + Math.PI / 24;
    const d = Math.abs(((a - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < 0.24) continue;

    // 带圆拱的洞口：上面是半圆，下面直边
    const nw = 1.35, nh = 3.1;
    const shape = new THREE.Shape();
    shape.moveTo(-nw, -nh);
    shape.lineTo(-nw, nh - nw);
    shape.absarc(0, nh - nw, nw, Math.PI, 0, true);
    shape.lineTo(nw, -nh);
    shape.closePath();
    const niche = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 12),
      new THREE.MeshStandardMaterial({ color: 0x1c1530, roughness: 1.0, side: THREE.DoubleSide })
    );
    niche.position.set(Math.cos(a) * rIn, 0.6, Math.sin(a) * rIn);
    niche.lookAt(0, 0.6, 0);
    root.add(niche);

    // 洞口石框（两侧细柱 + 拱券）
    for (const sgn of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 5.0, 6), matStoneDark);
      const ja = a + sgn * (nw + 0.16) / rIn;
      jamb.position.set(Math.cos(ja) * (rIn - 0.02), -1.7, Math.sin(ja) * (rIn - 0.02));
      root.add(jamb);
    }
    const archFrame = new THREE.Mesh(new THREE.TorusGeometry(nw + 0.16, 0.2, 8, 22, Math.PI), matStoneDark);
    archFrame.position.set(Math.cos(a) * (rIn - 0.02), 0.6 + nh - nw, Math.sin(a) * (rIn - 0.02));
    archFrame.lookAt(0, 0.6 + nh - nw, 0);
    root.add(archFrame);

    // 龛底的小托石
    const corbel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.22, 0.7, 6), matStoneDark);
    corbel.position.set(Math.cos(a) * (rIn - 0.2), -2.5, Math.sin(a) * (rIn - 0.2));
    root.add(corbel);
  }
  for (const yy of [-1.9, 5.9]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(rIn - 0.1, 0.2, 6, 180), matStoneDark);
    band.rotation.x = -Math.PI / 2;
    band.position.y = yy;
    root.add(band);
  }
})();

// ═══════════════════════════════════════ 金色法阵
function buildMagic() {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(R * 2, R * 2),
    new THREE.MeshBasicMaterial({
      map: texMagic, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: MAGIC_OPACITY, toneMapped: false,
      // 加色线条不吃雾：否则离中心远一点整片法阵会被雾压暗，看着像「花纹时有时无」
      fog: false,
      // 和台面共面时会有深度打架，用 polygon offset 顶开
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.041;   // 抬高一点，彻底离开台面/贴花所在的深度层
  root.add(plane);
  REFS.magicMat = plane.material;
  REFS.magicOpacity = MAGIC_OPACITY;

  // 法阵中心的地面微光，让中心比四周亮一档（参考图正中就是最亮的）
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(9.5, 64),
    new THREE.MeshBasicMaterial({
      map: T.makeRadialGlow(), color: 0x6e5383, transparent: true, opacity: 0.15,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  root.add(glow);
  REFS.glowMat = glow.material;
}
buildMagic();

// ═══════════════════════════════════════ 环栏
function buildBalustrade() {
  const lamps = arenaRailings(root, WALK, columnMaterials);
  const mount = new THREE.CylinderGeometry(.19, .11, .21, 10);
  const glow = new THREE.PlaneGeometry(.49, .64);
  const flame = new THREE.MeshBasicMaterial({
    map: texFlame, color: 0xe5a06c, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  for (const {x,z,angle} of lamps) {
    const cup = new THREE.Mesh(mount, matIron);
    cup.position.set(x, 1.858, z);
    root.add(cup);
    const light = new THREE.Mesh(glow, flame);
    light.position.set(x, 2.16, z);
    light.rotation.y = angle + Math.PI;
    root.add(light);
  }
}
buildBalustrade();

// ═══════════════════════════════════════ 四向台阶
function buildStairs() {
  const group = new THREE.Group();
  group.name = 'stone-approach-stairs';
  const treads = [], supports = [];
  for (let dir = 0; dir < 4; dir++) {
    const yaw = dir * Math.PI / 2;
    for (let step = 0; step < 7; step++) {
      const y = .16 - step * .245;
      const z = R - .22 + step * .78 + .39;
      const w = 7.28 - step * .11;
      const h = y + 2.05;
      supports.push(new THREE.BoxGeometry(w, h, .78).translate(0, y - h / 2 - .08, z).rotateY(yaw));
      const division = w / 3;
      for (let slab = -1; slab <= 1; slab++) {
        const tread = new THREE.BoxGeometry(division - .026, .12, .81);
        treads.push(tread.translate(slab * division, y - .042, z).rotateY(yaw));
      }
      for (const side of [-1, 1]) {
        const cheek = new THREE.BoxGeometry(.58, .81, .79);
        supports.push(cheek.translate(side * (w * .5 + .29), y + .12, z).rotateY(yaw));
      }
    }
  }
  for (const [parts, material] of [[treads, matStone], [supports, matStoneDark]]) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const part of parts) part.dispose();
  }
  root.add(group);
}
buildStairs();

REFS.decor.push(buildArenaProps(root, R, WALK, {
  stone: matStone, trim: matStoneDark, iron: matIron,
}, texFlame));

// ═══════════════════════════════════════ 火盆塔（四个对角）
const braziers = [];
function buildPylons() {
  const blaze = brazierFlame(weatherTime, bloodMoon);
  const flameSheet = new THREE.PlaneGeometry(3.36, 4.38);
  flameSheet.translate(0, 2.19, 0);
  const coalMaterial = new THREE.MeshStandardMaterial({
    color: 0x412522, roughness: .96, emissive: 0xe84213, emissiveIntensity: .40,
  });
  const coalGeo = rockGeometry;
  const coalTransform = new THREE.Object3D();
  const coalTint = new THREE.Color();
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const g = new THREE.Group();
    g.position.set(Math.cos(a) * (R - 1.2), 0, Math.sin(a) * (R - 1.2));
    g.rotation.y = -a;

    g.name = 'rim-brazier-pylon';
    towerStonework(g, columnMaterials, i * 2.17 + .40);
    T.paintFloorContact(floorTextures.map, 2 * R, g.position.x, g.position.z, 3.5, 3.5, 0, .54);

    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 0.68, 0.9, 16, 1, true), matIron);
    bowl.position.y = 8.6;
    g.add(bowl);

    // 盆底 + 盆沿：不加的话从下往上看是个黑洞
    const bowlBottom = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), matIron);
    bowlBottom.rotation.x = -Math.PI / 2;
    bowlBottom.position.y = 8.17;
    g.add(bowlBottom);

    const bowlRim = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.075, 6, 28), matIron);
    bowlRim.rotation.x = -Math.PI / 2;
    bowlRim.position.y = 9.06;
    g.add(bowlRim);

    const coalBed = new THREE.Mesh(new THREE.CylinderGeometry(1.04, .89, .13, 18), matIron);
    coalBed.position.y = 8.62;
    g.add(coalBed);
    const coals = new THREE.InstancedMesh(coalGeo, coalMaterial, 21);
    for (let j = 0; j < coals.count; j++) {
      const angle = j * 2.39996;
      const r = Math.sqrt(j / coals.count) * .93;
      coalTransform.position.set(Math.cos(angle) * r, 8.70 + j % 4 * .02, Math.sin(angle) * r);
      coalTransform.rotation.set(j * 2.1, j * .93, j * 1.6);
      const scale = .095 + (j % 6) * .021;
      coalTransform.scale.set(scale * 1.4, scale * .58, scale);
      coalTransform.updateMatrix();
      coals.setMatrixAt(j, coalTransform.matrix);
      coals.setColorAt(j, coalTint.setRGB(.41 + j % 5 * .125, .22 + j % 3 * .15, .14 + j % 4 * .09));
    }
    g.add(coals);

    const fire = new THREE.Mesh(flameSheet, blaze);
    fire.name = 'brazier-flame';
    fire.position.set(Math.cos(a) * (R - 1.2), 8.72, Math.sin(a) * (R - 1.2));
    root.add(fire);

    const light = new THREE.PointLight(0xff6a2a, 70, 40, 2);
    light.position.y = 9.45;
    g.add(light);

    braziers.push({ fire, light });
    root.add(g);
  }
}
buildPylons();

// ═══════════════════════════════════════ 执环雕像（北侧一对）
function buildStatue(x, z, yaw, scale = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  g.name = "carved-warden";
  g.scale.setScalar(scale);

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.1, 3.2, 8), matStone);
  plinth.position.y = 1.4; plinth.castShadow = true;
  g.add(plinth);
  const plinthTop = new THREE.Mesh(new THREE.CylinderGeometry(3.05, 2.95, 0.4, 16), matStone);
  plinthTop.position.y = 3.1;
  g.add(plinthTop);

  const robe = new THREE.Mesh(carvedRobe(), matStone);
  robe.position.y = 3.25;
  robe.receiveShadow = true;
  g.add(robe);

  const chest = new THREE.Mesh(new THREE.SphereGeometry(.91, 24, 16), matStone);
  chest.position.set(.07, 9.08, .16);
  chest.scale.set(1.04, .93, .61);
  g.add(chest);
  const cowl = new THREE.Mesh(new THREE.SphereGeometry(.73, 22, 16), matStoneDark);
  cowl.position.set(0, 10.06, -.04);
  cowl.scale.set(.94, 1.06, .83);
  g.add(cowl);
  const face = new THREE.Mesh(new THREE.SphereGeometry(.43, 18, 12), matStone);
  face.position.set(.018, 10.00, .38);
  face.scale.set(.89, 1.19, .46);
  g.add(face);
  const hoodEdge = new THREE.Mesh(new THREE.TorusGeometry(.46, .082, 7, 32), matStoneDark);
  hoodEdge.position.set(0, 10.01, .43);
  hoodEdge.scale.y = 1.23;
  g.add(hoodEdge);
  const clasp = new THREE.Mesh(new THREE.SphereGeometry(.17, 10, 8), matGoldLine);
  clasp.position.set(.02, 9.38, .74);
  clasp.scale.z = .38;
  g.add(clasp);

  const limbDirection = new THREE.Vector3();
  const vertical = new THREE.Vector3(0, 1, 0);
  function sleeve(start, end, top, bottom) {
    const length = limbDirection.subVectors(end, start).length();
    const mesh = new THREE.Mesh(chippedStone(top, bottom, length, .022, 8), matStone);
    mesh.position.copy(start).lerp(end, .5);
    mesh.quaternion.setFromUnitVectors(vertical, limbDirection.normalize());
    g.add(mesh);
  }
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(side * 1.04, 9.26, .12);
    const elbow = new THREE.Vector3(side * 1.52, 8.48, .55);
    const palm = new THREE.Vector3(side * 1.15, 8.53, 1.38);
    sleeve(shoulder, elbow, .28, .39);
    sleeve(elbow, palm, .20, .30);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(.21, 14, 10), matStone);
    hand.position.copy(palm);
    hand.scale.set(.92, .72, 1.20);
    g.add(hand);
  }

  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.075, 8, 48), matGoldLine);
  halo.position.set(0, 9.6, 1.35);
  halo.rotation.x = 0.18;
  g.add(halo);
  const halo2 = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 8, 40), matGoldLine);
  halo2.position.set(0, 9.6, 1.36);
  halo2.rotation.x = 0.18;
  g.add(halo2);
  // 环上的芒刺
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.5, 6), matGoldLine);
    spike.position.set(Math.cos(a) * 1.55, 9.6 + Math.sin(a) * 1.55, 1.35);
    spike.rotation.z = a - Math.PI / 2;
    spike.rotation.x = 0.18;
    g.add(spike);
  }

  return g;
}
const statueA = buildStatue(-25, -R - 4, Math.PI * 0.16, 1.5);
const statueB = buildStatue(25, -R - 4, -Math.PI * 0.16, 1.5);
statueA.position.y = -4.2;
statueB.position.y = -4.2;
root.add(statueA, statueB);
for (const [sx, sz] of [[-25, -R - 4], [25, -R - 4]]) {
  const l = new THREE.PointLight(0xe2cfbf, 430, 52, 2);
  l.position.set(sx * 0.86, 20, sz + 12);
  scene.add(l);
}

// ═══════════════════════════════════════ 猩红布幔
function buildBanners() {
  const geo = new THREE.PlaneGeometry(2.7, 8.4, 16, 24);
  const rod = new THREE.CylinderGeometry(.061, .061, 3.08, 8);
  rod.rotateZ(Math.PI / 2);
  const ferrule = new THREE.SphereGeometry(.105, 9, 7);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 6;
    const r = R + 8.74;
    if (Math.abs(Math.sin(a)) > .98 && Math.sin(a) < 0) continue;
    const group = new THREE.Group();
    group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    group.rotation.y = -a - Math.PI / 2;
    const bar = new THREE.Mesh(rod, matIron);
    bar.position.y = 8.95;
    group.add(bar);
    for (const side of [-1, 1]) {
      const end = new THREE.Mesh(ferrule, matGoldLine);
      end.position.set(side * 1.52, 8.95, 0);
      group.add(end);
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(.12, .22, .78), matIron);
      bracket.position.set(side * 1.4, 8.95, -.36);
      group.add(bracket);
    }
    const mesh = new THREE.Mesh(geo, clothMaterial);
    mesh.name = 'woven-crimson-banner';
    mesh.position.set(0, 4.74, .05);
    group.add(mesh);
    root.add(group);
  }
}
buildBanners();

// ═══════════════════════════════════════ 崖边红叶
function buildFoliage() {
  const group = new THREE.Group();
  group.name = 'rooted-perimeter-foliage';
  const branchMaterial = new THREE.MeshStandardMaterial({ color: 0x362b2d, roughness: .98 });
  const leafMaterial = new THREE.MeshStandardMaterial({
    map: texLeaf, color: 0xd8b39f, emissive: 0x210b0a, emissiveIntensity: .32,
    side: THREE.DoubleSide, alphaTest: .44, roughness: .81,
  });
  const patches = [], branches = [];
  const count = TEXLOW ? 24 : 47;
  for (let index = 0; index < count; index++) {
    const a = index / count * Math.PI * 2 + Math.random() * .16;
    if (Math.sin(a) < -.98) continue;
    const r = R + 2.45 + Math.random() * 5.5;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    for (let j = 0; j < 5; j++) {
      const height = 3.6 + Math.random() * 3.1;
      const spread = 1.13 + Math.random() * 1.39;
      const bearing = j * 2.36 + a;
      const dx = Math.cos(bearing) * spread, dz = Math.sin(bearing) * spread;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, -4.15, z),
        new THREE.Vector3(x + dx * .25, -4.15 + height * .47, z + dz * .25),
        new THREE.Vector3(x + dx * .64, -4.15 + height * .80, z + dz * .64),
        new THREE.Vector3(x + dx, -4.15 + height, z + dz),
      ]);
      branches.push(new THREE.TubeGeometry(curve, 7, .028 + height * .004, 4, false));
      for (let k = 0; k < 6; k++) {
        const fraction = .51 + k * .083;
        patches.push({ position: curve.getPoint(fraction), bearing: bearing + k * 1.27, scale: .63 + Math.random() * .42 });
      }
    }
  }
  const wood = new THREE.Mesh(mergeGeometries(branches), branchMaterial);
  for (const branch of branches) branch.dispose();
  const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.76, 1.32), leafMaterial, patches.length);
  const transform = new THREE.Object3D();
  const tint = new THREE.Color();
  for (const [index, {position, bearing, scale}] of patches.entries()) {
    transform.position.copy(position);
    transform.rotation.set(.21 + index % 5 * .10, bearing, Math.sin(index * 1.68) * .71);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    leaves.setMatrixAt(index, transform.matrix);
    leaves.setColorAt(index, tint.setScalar(.62 + index % 7 * .054));
  }
  group.add(wood, leaves);
  root.add(group);
  REFS.decor.push(group);
}
buildFoliage();

// ═══════════════════════════════════════ 飘落的花瓣 / 灰烬
(function buildPetals() {
  const N = TEXLOW ? 150 : 310;
  const pos = new Float32Array(N * 3);
  const spd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * (R + 14);
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 26 - 2;
    pos[i * 3 + 2] = Math.sin(a) * r;
    spd[i] = 0.25 + Math.random() * 0.85;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSpd', new THREE.BufferAttribute(spd, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: [
      'attribute float aSpd;',
      'uniform float uTime;',
      'varying float vA;',
      'void main(){',
      '  vec3 p = position;',
      '  p.y = mod(p.y - uTime * aSpd * 1.6, 26.0) - 2.0;',
      '  p.x += sin(uTime * 0.6 + position.y * 0.7) * 1.2;',
      '  p.z += cos(uTime * 0.5 + position.x * 0.6) * 1.2;',
      '  vA = 0.12 + 0.3 * (1.0 - abs(p.y - 10.0) / 14.0);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_PointSize = clamp((0.58 + aSpd*.81) * (110.0 / -mv.z), 1.0, 7.0);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying float vA;',
      'void main(){',
      '  vec2 p = gl_PointCoord - .5;',
      '  float d = length(vec2((p.x + p.y)*1.26,(p.x - p.y)*.80));',
      '  if (d > .5) discard;',
      '  gl_FragColor = vec4(vec3(.73, .26, .24), (1.-smoothstep(.24,.5,d)) * vA);',
      '}',
    ].join('\n'),
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  REFS.decor.push(pts);
  window.__petals = mat;
})();

// ═══════════════════════════════════════ 台底断裂的城垛
(function buildUnderRuin() {
  const mat = new THREE.MeshStandardMaterial({ map: texStoneDark, color: 0x8a7fa0, roughness: 1.0, metalness: 0.0 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.random() * 0.2;
    const r = R * 0.72 + Math.random() * 8;
    const s = 1.4 + Math.random() * 2.6;
    const rock = new THREE.Mesh(rockGeometry, mat);
    rock.position.set(Math.cos(a) * r, -9 - Math.random() * 9, Math.sin(a) * r);
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    rock.scale.set(s, s * (1.5 + Math.random()), s * .83);
    root.add(rock);
  }
})();

// ═══════════════════════════════════════ 浮空碎石
const floaters = [];
function buildFloaters() {
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = R + 3 + Math.random() * 9;
    const s = 0.3 + Math.random() * 1.0;
    const mesh = new THREE.Mesh(rockGeometry, matStoneDark);
    mesh.scale.set(s, s * 1.28, s * .85);
    mesh.position.set(Math.cos(a) * r, -22 - Math.random() * 10, Math.sin(a) * r);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    root.add(mesh);
    floaters.push({ mesh, y0: mesh.position.y, phase: Math.random() * 6.28, yaw: mesh.rotation.y, amp: 0.25 + Math.random() * 0.5 });
  }
}
buildFloaters();

// ═══════════════════════════════════════ 云海
if (new URLSearchParams(location.search).get('clouds') !== '0') {
  const strata = [[-20, 0x9b8ea4, .14, .88], [-42, 0xbab0be, .49, 1.72], [-67, 0xb0a3b4, .64, 2.26]];
  for (const [height, color, opacity, drift] of strata) {
    if (TEXLOW && height === -20) continue;
    const layer = cloudLayer(760, color, weatherTime, bloodMoon, opacity, drift);
    layer.position.y = height;
    layer.name = 'drifting-cloud-stratum';
    root.add(layer);
  }
}

// 云墙（大面片）已移除：贴边的第三人称镜头会穿进这些面片，画面上出现整片灰/黑遮挡。
// 远景氛围交给雾和云海底板，效果更稳。

// ═══════════════════════════════════════ 台外壕沟（环形地面，压住下面的白云）
(function buildMoat() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(R * 0.99, R + 12.5, 128, 1),
    new THREE.MeshStandardMaterial({ map: texStoneDark, normalMap: nrmStoneDark, color: 0x676477, roughness: .76, metalness: .04 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -4.2;
  ring.receiveShadow = true;
  root.add(ring);

  // 壕沟外沿一圈压边
  const lip = new THREE.Mesh(new THREE.TorusGeometry(R + 12.4, 0.5, 8, 160), matStoneDark);
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = -4.0;
  root.add(lip);
})();

// ═══════════════════════════════════════ 环绕城墙 + 北面门桥
//  参考图的场地不是孤立圆盘：外圈有连续的墙、壁柱和拱，把视线挡住一半，
//  舞台感才出得来。
function buildSurround() {
  const g = new THREE.Group();
  const matWall = (new THREE.MeshStandardMaterial({
    ...masonry, normalScale: new THREE.Vector2(.59, .59),
    color: 0xc4b9c4, emissive: 0x251d2c, emissiveIntensity: 1.0,
    roughness: 0.95, metalness: 0.02, side: THREE.DoubleSide,
  }));
  const matWallDark = new THREE.MeshStandardMaterial({
    map: texStoneDark, color: 0x9d92b4, emissive: 0x141022, emissiveIntensity: 1.0,
    roughness: 0.97, metalness: 0.02,
  });

  // 一圈圆形城墙（不是方墙）：北面留 34° 的缺口给门桥
  const rTop = R + 11, rBot = R + 13, H = 24, baseY = -15;
  const gap = 0.34;
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, H, 96, 1, true, Math.PI + gap / 2, Math.PI * 2 - gap),
    matWall
  );
  wall.position.y = baseY + H / 2;
  g.add(wall);

  wallCrownColumns(g, rTop - .76, baseY + H + .02, gap, columnMaterials);

  // 外围石柱：柱础两级 + 带竖槽的柱身 + 三道束带 + 柱头
  // 和墙一样吃柱身浮雕（albedo 烘死 + 法线），远近都能看出是石柱而不是圆柱。
  const buildOuterColumn = (a, rOff) => {
    const cx = Math.cos(a) * rOff;
    const cz = Math.sin(a) * rOff;
    const baseY = -14, topY = 6.6, H = topY - baseY;

    const p1 = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.7, 1.7, 16), matColumn);
    p1.position.set(cx, baseY + 0.85, cz);
    g.add(p1);

    const p2 = new THREE.Mesh(new THREE.CylinderGeometry(2.92, 3.22, 1.1, 16), matColumn);
    p2.position.set(cx, baseY + 2.25, cz);
    g.add(p2);

    const footRing = new THREE.Mesh(new THREE.TorusGeometry(2.78, 0.28, 6, 28), matColumn);
    footRing.rotation.x = -Math.PI / 2;
    footRing.position.set(cx, baseY + 2.9, cz);
    g.add(footRing);

    const shaftH = H - 3.6;
    const shaft = new THREE.Mesh(chippedStone(2.18, 2.46, shaftH, .016, 12), matColumn);
    shaft.position.set(cx, baseY + 3.1 + shaftH / 2, cz);
    g.add(shaft);

    // 束带：把柱子分段，近看有石作节奏
    for (const t of [0.30, 0.62, 0.88]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(2.32, 0.15, 6, 32), matColumn);
      band.rotation.x = -Math.PI / 2;
      band.position.set(cx, baseY + 3.1 + shaftH * t, cz);
      g.add(band);
    }

    // 柱身嵌铜箍：和法阵同色的细环，冷紫里点几处暖
    for (const t of [0.18, 0.48, 0.76]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(2.41, 0.052, 6, 40), matGoldLine);
      hoop.rotation.x = -Math.PI / 2;
      hoop.position.set(cx, baseY + 3.1 + shaftH * t, cz);
      g.add(hoop);
    }

    // 柱头：钟形剖面（lathe），叶饰才有展开的曲面可以贴
    const capProfile = [
      [2.28, 0.00], [2.42, 0.14], [2.62, 0.44], [2.86, 0.82],
      [2.98, 1.06], [2.94, 1.22], [3.16, 1.34], [3.24, 1.46], [3.24, 1.56],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const cap = new THREE.Mesh(new THREE.LatheGeometry(capProfile, 28), matCapital);
    cap.position.set(cx, topY - 1.25, cz);
    g.add(cap);
    // 顶面盖板：否则从下往上看柱头是个黑洞
    const capTop = new THREE.Mesh(new THREE.CylinderGeometry(3.24, 3.24, 0.18, 28), matCapital);
    capTop.position.set(cx, topY + 0.28, cz);
    g.add(capTop);

    // 立体茛苕叶：一圈大叶 + 一圈错位小叶，几何体直接弯到柱头曲面上
    const bigLeaf = makeLeafGeometry(0.98, 1.75, 0.11, 3.02);
    const smallLeaf = makeLeafGeometry(0.72, 1.18, 0.09, 3.18);
    for (let k = 0; k < 8; k++) {
      const la = (k / 8) * Math.PI * 2;
      const leafM = new THREE.Mesh(bigLeaf, matLeaf);
      leafM.position.set(cx, topY - 1.15, cz);
      leafM.rotation.y = la;
      leafM.rotation.x = -0.06;
      g.add(leafM);
    }
    for (let k = 0; k < 8; k++) {
      const la = ((k + 0.5) / 8) * Math.PI * 2;
      const leafM = new THREE.Mesh(smallLeaf, matLeaf);
      leafM.position.set(cx, topY - 0.48, cz);
      leafM.rotation.y = la;
      leafM.rotation.x = -0.04;
      g.add(leafM);
    }

    const capBand = new THREE.Mesh(new THREE.TorusGeometry(2.95, 0.12, 6, 32), matCapital);
    capBand.rotation.x = -Math.PI / 2;
    capBand.position.set(cx, topY - 1.32, cz);
    g.add(capBand);

    const abacus = new THREE.Mesh(new THREE.CylinderGeometry(3.38, 3.38, 0.42, 16), matCapital);
    abacus.position.set(cx, topY + 0.55, cz);
    g.add(abacus);
  };

  // 外侧扶壁：让墙有厚度和节奏
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.16;
    const d = Math.abs(((a - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < gap / 2 + 0.1) continue;
    buildOuterColumn(a, rBot + 1.6);
  }

  // 墙面的长幡由 buildBanners() 统一挂在 R + 8.8 处，这里不再重复

  // 北面门桥：桥面 + 圆管扶手 + 桥下三个半圆拱
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(15, 1.1, 30), matWall);
  bridge.position.set(0, -1.2, -R - 17);
  g.add(bridge);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 30, 8), matWallDark);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(sx * 7.4, 0.35, -R - 17);
    g.add(rail);
  }
  for (let k = 0; k < 3; k++) {
    const arch = new THREE.Mesh(new THREE.TorusGeometry(5, 1.0, 6, 18, Math.PI), matWallDark);
    arch.position.set(0, -3.2, -R - 6 - k * 10);
    g.add(arch);
  }

  scene.add(g);
}
buildSurround();

// ═══════════════════════════════════════ 远景哥特要塞
//  三圈塔楼 + 横跨的拱桥：近圈压住画面边缘，中圈给纵深，远圈只剩剪影
function buildFortress() {
  const g = new THREE.Group();
  const matFar = new THREE.MeshStandardMaterial({ map: texStoneDark, color: 0xaca1ae, roughness: .97, metalness: 0 });
  const matFarDark = new THREE.MeshStandardMaterial({ map: texStoneDark, color: 0x837c8d, roughness: .99, metalness: 0 });
  const matSlit = new THREE.MeshBasicMaterial({ color: 0x1a1428 });
  const foundations = [];

  const tower = (x, z, w, h, d, mat, spires = true) => {
    const base = -34;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.46, w * 0.55, h, 8), mat);
    t.position.set(x, base + h / 2, z);
    g.add(t);
    // 收分（塔身上窄下宽）
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.34, w * 0.44, h * 0.26, 8), matFarDark);
    upper.position.set(x, base + h + h * 0.13, z);
    g.add(upper);
    // 束带：把一段圆柱切成几层，远看才有「塔」的节奏
    for (let k = 1; k <= 3; k++) {
      const yy = base + (h * k) / 4;
      const band = new THREE.Mesh(new THREE.TorusGeometry(w * 0.5, w * 0.055, 6, 20), matFarDark);
      band.rotation.x = -Math.PI / 2;
      band.position.set(x, yy, z);
      g.add(band);
    }
    // 窗缝：深色竖条，绕着塔身排一圈
    for (let k = 0; k < 8; k++) {
      const a2 = (k / 8) * Math.PI * 2;
      const slit = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 0.12, h * 0.22),
        matSlit   // 共享材质，否则 48 座塔 × 8 扇 = 384 个材质，永远合不了批
      );
      slit.position.set(x + Math.cos(a2) * (w * 0.47), base + h * 0.52, z + Math.sin(a2) * (w * 0.47));
      slit.lookAt(x, base + h * 0.52, z);
      g.add(slit);
    }

    foundations.push({ x, z, width: w });
    if (spires) {
      const spire = new THREE.Mesh(new THREE.ConeGeometry(w * 0.5, h * 0.34, 4), matFarDark);
      spire.position.set(x, base + h + h * 0.34, z);
      spire.rotation.y = Math.PI / 4;
      g.add(spire);
      // 尖顶基座的四座小塔
      for (let k = 0; k < 4; k++) {
        const a3 = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const pin = new THREE.Mesh(new THREE.ConeGeometry(w * 0.09, h * 0.1, 4), matFarDark);
        pin.position.set(x + Math.cos(a3) * w * 0.42, base + h + h * 0.09, z + Math.sin(a3) * w * 0.42);
        g.add(pin);
      }
    }
    return t;
  };

  // 近圈：8 座巨型塔，正好在画面四周立起来
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.28;
    const r = 132 + (i % 2) * 26;
    const w = 13 + (i % 3) * 4;
    tower(Math.cos(a) * r, Math.sin(a) * r, w, 62 + (i % 4) * 12, w * 1.15, matFarDark);
  }
  // 中圈：16 座，给纵深和错落
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.12;
    const r = 210 + (i % 4) * 26;
    const w = 8 + (i % 5) * 2.5;
    tower(Math.cos(a) * r, Math.sin(a) * r, w, 58 + (i % 5) * 22, w, i % 3 ? matFar : matFarDark);
  }
  // 远圈：24 座，只留雾里的剪影
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.7;
    const r = 200 + (i % 6) * 34;
    const w = 12 + (i % 4) * 6;
    tower(Math.cos(a) * r, Math.sin(a) * r, w, 70 + (i % 6) * 26, w, matFar, false);
  }

  // 北面主门楼：两座高塔夹一道拱门，门洞里透红光（对应参考图正上方城门）
  const gateZ = -R - 46;
  tower(-21, gateZ, 20, 104, 20, matFarDark);
  tower(21, gateZ, 20, 104, 20, matFarDark);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(16, 3.4, 8, 30, Math.PI), matFarDark);
  arch.position.set(0, 30, gateZ);
  g.add(arch);
  // 门楼两侧垂下的猩红长幡
  for (const sx of [-1, 1]) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 34, 10, 17), clothMaterial);
    cloth.position.set(sx * 12.5, 30, gateZ + 9);
    g.add(cloth);
  }

  // Floating towers are anchored into jagged stone islands beneath their masonry.
  const foundationGeometry = new THREE.CylinderGeometry(1, .28, 1, 9, 4);
  const vertices = foundationGeometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    const surface = 1 + .16 * Math.sin(x * 8 + y * 12) * Math.cos(z * 9 - y * 8);
    vertices.setXYZ(i, x * surface + .17 * (y - .5), y, z * surface);
  }
  foundationGeometry.computeVertexNormals();
  const foundationsMesh = new THREE.InstancedMesh(foundationGeometry, matFarDark, foundations.length);
  const instance = new THREE.Object3D();
  for (const [i, { x, z, width }] of foundations.entries()) {
    const height = width * (.76 + i % 4 * .16);
    instance.position.set(x, -34 + .45 - height * .5, z);
    instance.rotation.y = i * 1.43;
    instance.scale.set(width * .72, height, width * .68);
    instance.updateMatrix();
    foundationsMesh.setMatrixAt(i, instance.matrix);
  }
  g.add(foundationsMesh);

  // 横跨的拱桥：左右各两道，参考图两侧那些高架拱
  const bridges = [
    [0.35, 96, 34, 22], [2.55, 108, 40, 24], [3.9, 88, 28, 18], [5.5, 120, 44, 26],
  ];
  for (const [a, r, span, y] of bridges) {
    const b = new THREE.Mesh(new THREE.TorusGeometry(span, 2.4, 6, 26, Math.PI * 0.62), matFarDark);
    b.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    b.rotation.y = -a;
    g.add(b);
  }

  scene.add(g);
}
buildFortress();

// ═══════════════════════════════════════ 光
function buildLights() {
  const hemi = new THREE.HemisphereLight(0xc9b8dc, 0x1f1a2a, 0.88);
  scene.add(hemi);
  REFS.hemi = hemi;

  const key = new THREE.DirectionalLight(0xefe6ff, 2.5);
  REFS.key = key;
  key.position.set(28, 52, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const c = key.shadow.camera;
  c.left = -40; c.right = 40; c.top = 40; c.bottom = -40; c.far = 160;
  key.shadow.bias = -0.0018;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  // 品红补光：从场地后下方打上来，压出参考图那种冷紫 + 洋红的天光
  const rim = new THREE.DirectionalLight(0xff4f7d, 1.0);
  rim.position.set(-34, 16, -46);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x8f7fd8, 0.55);
  const fill2 = new THREE.DirectionalLight(0xb0a0d4, 0.5); fill2.position.set(10, 34, 46); scene.add(fill2);
  // 掠射光：几乎平行于墙面打过去，浮雕的凹凸才吃得到光
  // 四向掠射光：几乎贴着墙面打，浮雕的凹凸才吃得到光（单向光只能照亮半圈）
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const gr = new THREE.DirectionalLight(0xc2aee6, 0.32);
    gr.position.set(Math.cos(a) * 60, 11, Math.sin(a) * 60);
    gr.target.position.set(Math.cos(a) * 10, 2, Math.sin(a) * 10);
    scene.add(gr, gr.target);
  }
  const rimLow = new THREE.DirectionalLight(0xff4f72, 0.65); rimLow.position.set(-40, 6, -60); scene.add(rimLow);
  fill.position.set(-18, 10, 40);
  scene.add(fill);
}
buildLights();

// ═══════════════════════════════════════ 墙面洗光
//  台面到墙之间没有光源，内墙会黑成一片；六盏贴地冷光从台缘往墙上打，
//  窗棂、藤蔓、壁龛才有轮廓。
(function buildWallWash() {
  if (new URLSearchParams(location.search).get('lights') === 'low') return;
  // 复用六盏低强度洗墙光，保留石面明暗与火盆附近的暖色。
  // 少掉的亮度由内墙自发光 + 半球光补。
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.6;
    const l = new THREE.PointLight(0xa89dc0, 455, 68, 2);
    l.position.set(Math.cos(a) * (R + 1.5), 7.5, Math.sin(a) * (R + 1.5));
    scene.add(l);
    REFS.washLights.push(l);
  }
})();


  ST = {
    scene, braziers, floaters, weatherTime, bloodMoon, lastTime: null, fogBase: null,
    petals: window.__petals ?? null,
    warmFire: new THREE.Color(0xff862f), bloodFire: new THREE.Color(0xff294c),
    sunBase: new THREE.Color(0xefe6ff), sunBlood: new THREE.Color(0xff9ca9),
    washBase: new THREE.Color(0xa89dc0), washBlood: new THREE.Color(0xbf6281),
    glowBase: new THREE.Color(0x6e5383), glowBlood: new THREE.Color(0xa3294b),
  };

  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = false;
    const material = object.material;
    if (material.transparent || material.alphaTest > 0) guardFromAO(object, material);
  });
  return {
    radius: R, root, obstacles, setPhase: setStagePhase,
    setDecor(on) { for (const object of REFS.decor) object.visible = on; },
  };
}

/** Scene animation uses elapsed time in both the arena preview and the game. */
export function updateStage(t, camera) {
  if (!ST) return;
  const dt = ST.lastTime === null ? 0 : THREE.MathUtils.clamp(t - ST.lastTime, 0, .1);
  ST.lastTime = t;
  ST.weatherTime.value = t;
  REFS.skyMat.uniforms.time.value = t;

  const previous = PHASE_MIX;
  const step = dt * 2.2;
  PHASE_MIX += THREE.MathUtils.clamp(PHASE_TARGET - PHASE_MIX, -step, step);
  const mix = PHASE_MIX;
  ST.bloodMoon.value = mix;

  for (const [i, { fire, light }] of ST.braziers.entries()) {
    if (camera) fire.rotation.y = Math.atan2(camera.position.x - fire.position.x, camera.position.z - fire.position.z);
    const flicker = 1 + Math.sin(t * 8 + i * 2.1) * .072 + Math.sin(t * 23 + i) * .045;
    light.intensity = (61 + 20 * mix) * flicker;
  }
  for (const f of ST.floaters) {
    f.mesh.position.y = f.y0 + Math.sin(t * .52 + f.phase) * f.amp;
    f.mesh.rotation.y = f.yaw + t * (.065 + f.phase * .012);
  }
  if (ST.petals) ST.petals.uniforms.uTime.value = t;
  if (mix === previous) return;

  REFS.magicMat.color.setRGB(1, 1 - .62 * mix, 1 - .55 * mix);
  REFS.magicMat.opacity = REFS.magicOpacity * (1 + .30 * mix);
  REFS.glowMat.color.copy(ST.glowBase).lerp(ST.glowBlood, mix);
  const fog = ST.scene.fog;
  if (fog) {
    if (previous === 0 || !ST.fogBase) ST.fogBase = { color: fog.color.clone(), near: fog.near, far: fog.far };
    fog.color.copy(ST.fogBase.color).lerp(FOG_P2, mix);
    fog.near = THREE.MathUtils.lerp(ST.fogBase.near, 38, mix);
    fog.far = THREE.MathUtils.lerp(ST.fogBase.far, 190, mix);
  }
  REFS.skyMat.uniforms.cTop.value.copy(SKY_BASE.top).lerp(SKY_P2.top, mix);
  REFS.skyMat.uniforms.cMid.value.copy(SKY_BASE.mid).lerp(SKY_P2.mid, mix);
  REFS.skyMat.uniforms.cBot.value.copy(SKY_BASE.bot).lerp(SKY_P2.bot, mix);
  for (const { light } of ST.braziers) light.color.copy(ST.warmFire).lerp(ST.bloodFire, mix);
  for (const light of REFS.washLights) light.color.copy(ST.washBase).lerp(ST.washBlood, mix);
  REFS.key.intensity = 2.5 * (1 - .34 * mix);
  REFS.key.color.copy(ST.sunBase).lerp(ST.sunBlood, mix);
  REFS.hemi.intensity = .88 * (1 - .35 * mix);
}
