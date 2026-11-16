import * as THREE from 'three';
import * as T from './tex.js';
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
const REFS = { magicMat: null, glowMat: null, skyMat: null, washLights: [], decor: [] };
const FOG_BASE = new THREE.Color(0x9d86b0);
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
  // 展示页需要法阵亮一点；战斗里第三人称贴地看，太亮会糊成霓虹
  const MAGIC_OPACITY = opts.magicOpacity ?? 1.0;
// ── 贴图
const TEXLOW = new URLSearchParams(location.search).get('tex') === 'low';
const texFloor = T.makeFloorTexture(TEXLOW ? 1024 : 3072, R * 2);
const texMagic = T.makeMagicTexture(TEXLOW ? 2048 : 4096, R * 2, R / 22);
const texStone = T.makeStoneTexture(TEXLOW ? 256 : 512, [62, 56, 74]);
const texStoneDark = T.makeStoneTexture(TEXLOW ? 256 : 512, [44, 39, 55]);
// 用同一张石面贴图当高度图算法线：一步就把「平铺的塑料面」变成有凹凸的石头
const nrmStone = T.makeNormalMap(texStone.image, 2.4);
const nrmStoneDark = T.makeNormalMap(texStoneDark.image, 2.4);
const nrmFloor = T.makeNormalMap(texFloor.image, 1.5);
// 细节法线：高频小凹凸，专门给贴地视角用（和主法线叠加，不占额外 UV）
const nrmDetail = T.makeNormalMap(T.makeStoneTexture(256, [140, 136, 150]).image, 3.0);

/** 给材质叠一层高频细节法线：按世界尺度重复，越近越能看出石面的颗粒 */
function addDetailNormal(mat, repeat, strength) {
  const tex = nrmDetail.clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailNormal = { value: tex };
    shader.uniforms.uDetailStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetailNormal;\nuniform float uDetailStrength;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 detailN = texture2D(uDetailNormal, vNormalMapUv * 7.0).xyz * 2.0 - 1.0;
        normal = normalize(normal + vec3(detailN.xy * uDetailStrength, 0.0));`);
  };
  mat.needsUpdate = true;
  return mat;
}
// 墙面浮雕法线：一个开间（壁柱 + 尖拱盲窗 + 卷草 + 束带）
const texRelief = T.makeReliefTile(1024);
const nrmRelief = T.makeNormalMap(texRelief, 3.4);
nrmRelief.repeat.set(65, 10);
const albedoRelief = T.makeReliefAlbedo(texRelief, texStone.image);
albedoRelief.repeat.set(65, 10);
// 地面浮雕：4×4 石板一个贴图块，铺 12 次 → 每块石板约 1.25 m
const nrmFloorRelief = T.makeNormalMap(T.makeFloorRelief(1024, 4), 2.6);
nrmFloorRelief.repeat.set(13, 13);
// 柱身浮雕：8 道竖槽 + 柱头束带
const nrmColumn = T.makeNormalMap(T.makeColumnRelief(512), 3.4);
nrmColumn.repeat.set(2, 3);
const colReliefCanvas = T.makeColumnRelief(512);
const albedoColumn = T.makeReliefAlbedo(colReliefCanvas, texStone.image, '150,140,182', 0.26);
albedoColumn.repeat.set(3, 4);
nrmColumn.repeat.set(3, 4);
const matColumn = new THREE.MeshStandardMaterial({
  map: albedoColumn, normalMap: nrmColumn, normalScale: new THREE.Vector2(2.4, 2.4),
  color: 0xd2c4e4, emissive: 0x2a2138, emissiveIntensity: 1.0,
  roughness: 0.93, metalness: 0.03,
});
const matButtress = matColumn;
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

// 城墙上的小石柱：竖槽更细，单独一套平铺
const postReliefCanvas = T.makePostRelief(512);
const nrmPost = T.makeNormalMap(postReliefCanvas, 3.0);
nrmPost.repeat.set(2, 1);
const albedoPost = T.makeReliefAlbedo(postReliefCanvas, texStone.image, '150,140,182', 0.30);
albedoPost.repeat.set(2, 1);
const matPost = new THREE.MeshStandardMaterial({
  map: albedoPost, normalMap: nrmPost, normalScale: new THREE.Vector2(2.0, 2.0),
  color: 0xc8badc, emissive: 0x1f1830, emissiveIntensity: 1.0,
  roughness: 0.94, metalness: 0.03,
});
const texBanner = T.makeBannerTexture();
const texFlame = T.makeFlameTexture();
const texCloud = T.makeCloudTexture();
const texLeaf = T.makeLeafTexture();

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
const matFloor = (new THREE.MeshStandardMaterial({
  map: texFloor, normalMap: nrmFloorRelief, normalScale: new THREE.Vector2(1.55, 1.55),
  color: 0xe2daee, roughness: 0.9, metalness: 0.05,
}));
const brassTex = T.makeBrassTextures(512);
const matGoldLine = new THREE.MeshStandardMaterial({
  map: brassTex.map, roughnessMap: brassTex.roughnessMap,
  color: 0xd9b168, emissive: 0x5a3a10, emissiveIntensity: 0.7,
  roughness: 0.62, metalness: 0.82,
});
const matIron = new THREE.MeshStandardMaterial({ color: 0x453a52, emissive: 0x140f1c, emissiveIntensity: 1.0, roughness: 0.66, metalness: 0.28, side: THREE.DoubleSide });
const matCrimson = new THREE.MeshStandardMaterial({ color: 0x7d1024, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
// 给材质命名：Electron 里如果某个材质编译失败，日志能直接指出是哪一个
matFloor.name = 'floor';
matStone.name = 'stone';
matStoneDark.name = 'stoneDark';
matGoldLine.name = 'goldLine';
matIron.name = 'iron';
matCrimson.name = 'crimson';

const root = new THREE.Group();
  const obstacles = [];   // 供战斗用的圆柱障碍：{ x, z, r }
scene.add(root);

// ═══════════════════════════════════════ 天空
function buildSky() {
  const geo = new THREE.SphereGeometry(600, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      cTop: { value: new THREE.Color(0x5b4d73) },
      cMid: { value: new THREE.Color(0xc8aec6) },
      cBot: { value: new THREE.Color(0x1b1626) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec3 vP; uniform vec3 cTop, cMid, cBot;
      void main(){
        float h = normalize(vP).y * 0.5 + 0.5;
        vec3 c = mix(cBot, cMid, smoothstep(0.0, 0.55, h));
        c = mix(c, cTop, smoothstep(0.5, 1.0, h));
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
  const walk = new THREE.Mesh(new THREE.RingGeometry(WALK - 2.9, WALK + 0.55, 140, 1), matFloor);
  walk.rotation.x = -Math.PI / 2;
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
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), matStoneDark);
    m.position.set(Math.cos(a) * rr, -2.2 - Math.random() * 9, Math.sin(a) * rr);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.y = 1.4 + Math.random();
    root.add(m);
  }
}
buildPlatform();

// 台沿亮边：把台面和外面那圈壕沟分开
(function buildRimLine() {
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.35, R + 0.05, 160, 1),
    new THREE.MeshBasicMaterial({ color: 0xb9a4d0, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })
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
    map: albedoRelief, normalMap: nrmRelief, normalScale: new THREE.Vector2(1.9, 1.9),
    color: 0x9c92b4, emissive: 0x51406f, emissiveIntensity: 1.0,
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
  scene.add(inner);

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

  const matNicheDark = new THREE.MeshBasicMaterial({ color: 0x0c0916, side: THREE.DoubleSide });
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
            color: 0x2a0f18, emissive: 0x6b1f2c, emissiveIntensity: 1.1,
            roughness: 1.0, side: THREE.DoubleSide,
          })
        : new THREE.MeshBasicMaterial({ color: 0x0c0916, side: THREE.DoubleSide })
    );
    g.add(hole);

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
  const leafGeo = new THREE.PlaneGeometry(0.62, 0.46);
  const leafMat = new THREE.MeshStandardMaterial({
    map: texLeaf, color: 0xe0506a, emissive: 0x3a0812, emissiveIntensity: 0.7,
    roughness: 0.85, side: THREE.DoubleSide,
    transparent: true, alphaTest: 0.3,
  });
  const leaves = [];
  for (let i = 0; i < 96; i++) {
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
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 4, 0.055, 4, false), stemMat));
    for (let k = 0; k < 36; k++) leaves.push(curve.getPoint(Math.random()));
  }
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
  scene.add(inst);
})();

// ═══════════════════════════════════════ 台面微起伏 + 人尺度道具
//  ① 台面不再是完美平面：只往下沉 0.3–3 cm，脚不会浮空
//  ② 断柱 / 倒柱 / 铁链：给 2 m 高的角色一个尺度参照
(function buildDeckSurfaceAndProps() {
  // ── 台面起伏
  const geo = new THREE.RingGeometry(0.01, R - 0.03, 160, 64);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const n2 = (x, z) =>
    0.5 + 0.28 * Math.sin(x * 0.55 + 1.7) * Math.cos(z * 0.48 - 0.6)
       + 0.14 * Math.sin(x * 1.31 - 0.4) * Math.cos(z * 1.17 + 2.1)
       + 0.08 * Math.sin(x * 2.9 + 3.1) * Math.cos(z * 3.3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const edgeFade = Math.min(1, (R - Math.hypot(x, z)) / 1.6);   // 台缘保持水平，和压边线脚对齐
    pos.setY(i, -(0.003 + n2(x, z) * 0.03 * Math.max(0, edgeFade)));
    uv.setXY(i, x / (2 * R) + 0.5, z / (2 * R) + 0.5);
  }
  geo.computeVertexNormals();
  const deck = new THREE.Mesh(geo, matFloor);
  deck.position.y = 0.002;
  deck.receiveShadow = true;
  root.add(deck);

  // ── 断柱（立着的）
  const pillarSpecs = [
    { x: -8.6, z: 5.2, h: 2.1, r: 0.62 },
    { x: 7.8, z: -6.4, h: 2.6, r: 0.58 },
    { x: 2.4, z: 10.4, h: 1.35, r: 0.5 },
    { x: -10.2, z: -5.6, h: 1.7, r: 0.54 },
  ];
  for (const p of pillarSpecs) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.35, p.r * 1.5, 0.34, 12), matStoneDark);
    base.position.y = 0.17;
    g.add(base);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 1.06, p.h, 14), matColumn);
    shaft.position.y = 0.34 + p.h / 2;
    shaft.rotation.z = (Math.random() - 0.5) * 0.03;
    g.add(shaft);

    // 断口：一圈随机高度的碎片
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const hh = 0.1 + Math.random() * 0.28;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09 + Math.random() * 0.07, 0), matStoneDark);
      chunk.position.set(Math.cos(a) * p.r * 0.85, 0.34 + p.h - 0.05, Math.sin(a) * p.r * 0.85);
      chunk.scale.y = 1.6;
      g.add(chunk);
    }
    g.rotation.y = Math.random() * Math.PI;
    g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    root.add(g);
    obstacles.push({ x: p.x, z: p.z, r: p.r * 1.35 });
  }

  // ── 倒柱（躺在地上，斜靠台面）
  const fallen = [
    { x: 6.2, z: 8.4, yaw: 0.7, len: 3.4 },
    { x: -4.4, z: -9.2, yaw: -0.4, len: 2.8 },
  ];
  for (const f of fallen) {
    const g = new THREE.Group();
    g.position.set(f.x, 0, f.z);
    g.rotation.y = f.yaw;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.56, f.len, 12), matColumn);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.set(0, 0.5, 0);
    g.add(shaft);
    // 断掉的两端
    for (const sx of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), matStoneDark);
      cap.position.set((sx * f.len) / 2, 0.5, 0);
      cap.scale.set(0.7, 1, 1);
      g.add(cap);
    }
    g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    root.add(g);
    obstacles.push({ x: f.x, z: f.z, r: 0.9 });
  }

  // ── 垂下来的铁链
  const chainMat = new THREE.MeshStandardMaterial({ color: 0x2c2536, roughness: 0.55, metalness: 0.65 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.9;
    const x0 = Math.cos(a) * (R - 1.5), z0 = Math.sin(a) * (R - 1.5);
    const x1 = Math.cos(a) * (R - 4.2), z1 = Math.sin(a) * (R - 4.2);
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const sag = Math.sin(t * Math.PI) * 0.45;
      pts.push(new THREE.Vector3(
        x0 + (x1 - x0) * t,
        1.1 - t * 1.0 - sag * 0.4 + sag * 0.2,
        z0 + (z1 - z0) * t
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const chain = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.055, 6, false), chainMat);
    chain.castShadow = true;
    root.add(chain);
  }
})();
// ═══════════════════════════════════════ 台面碎屑与裂缝贴花
//  贴地视角下，只靠贴图会像一张纸；加实物碎屑和裂缝，地面才有纵深。
(function buildFloorDetail() {
  // ① 裂缝贴花：14 张，随机旋转、大小 4~9m
  const crackTex = T.makeCrackTexture(512);
  const crackMat = new THREE.MeshBasicMaterial({
    map: crackTex, transparent: true, opacity: 1.0, depthWrite: false,
    toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const NO_CRACK = new URLSearchParams(location.search).get('cracks') === '0';
  for (let i = 0; i < (NO_CRACK ? 0 : 14); i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * (R - 6);
    const sc = 4 + Math.random() * 5;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sc, sc), crackMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
    root.add(m);
  }

  // ② 碎屑：220 块小石头，靠台缘密、中心稀
  const rubbleGeo = new THREE.DodecahedronGeometry(1, 0);
  const rubbleMat = new THREE.MeshStandardMaterial({
    map: texStoneDark, normalMap: nrmStoneDark, normalScale: new THREE.Vector2(1.2, 1.2),
    color: 0xc2b6d6, emissive: 0x1a1526, emissiveIntensity: 1.0, roughness: 0.95, metalness: 0.02,
  });
  const N = 220;
  const inst = new THREE.InstancedMesh(rubbleGeo, rubbleMat, N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < N; i++) {
    const t = Math.pow(Math.random(), 0.45);        // 向台缘加权
    const r = 2 + t * (R - 3);
    const a = Math.random() * Math.PI * 2;
    const sc = 0.05 + Math.random() * 0.14;
    e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    q.setFromEuler(e);
    m4.compose(
      new THREE.Vector3(Math.cos(a) * r, sc * 0.85, Math.sin(a) * r),
      q,
      new THREE.Vector3(sc * (0.8 + Math.random() * 0.6), sc * (0.5 + Math.random() * 0.5), sc * (0.8 + Math.random() * 0.6))
    );
    inst.setMatrixAt(i, m4);
  }
  inst.castShadow = true;
  inst.receiveShadow = true;
  root.add(inst);
  REFS.decor.push(inst);   // 碎屑也算装饰，低画质一起关

  // ③ 中心磨损环：战斗最常踩的地方，石面被磨得发亮
  const worn = new THREE.Mesh(
    new THREE.RingGeometry(3.5, 9.5, 96, 1),
    new THREE.MeshBasicMaterial({
      color: 0xb9a8cc, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
  );
  worn.rotation.x = -Math.PI / 2;
  worn.position.y = 0.008;
  root.add(worn);
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
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.025;
  root.add(plane);
  REFS.magicMat = plane.material;

  // 法阵中心的地面微光，让中心比四周亮一档（参考图正中就是最亮的）
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(9.5, 64),
    new THREE.MeshBasicMaterial({
      color: 0x5b4a80, transparent: true, opacity: 0.07,
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
  const balusterGeo = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.00, 0.00),
      new THREE.Vector2(0.22, 0.00),
      new THREE.Vector2(0.23, 0.05),
      new THREE.Vector2(0.15, 0.10),
      new THREE.Vector2(0.13, 0.18),
      new THREE.Vector2(0.11, 0.30),
      new THREE.Vector2(0.16, 0.42),
      new THREE.Vector2(0.19, 0.52),
      new THREE.Vector2(0.18, 0.62),
      new THREE.Vector2(0.12, 0.72),
      new THREE.Vector2(0.10, 0.82),
      new THREE.Vector2(0.14, 0.90),
      new THREE.Vector2(0.20, 0.96),
      new THREE.Vector2(0.20, 1.02),
    ],
    8
  );
  const count = 176;
  const inst = new THREE.InstancedMesh(balusterGeo, matStone, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    // 四个台阶口留空
    const deg = (a * 180 / Math.PI) % 90;
    const open = Math.min(deg, 90 - deg) < 6.5;
    const s = open ? 0.0001 : 1;
    m.makeRotationY(-a);
    m.setPosition(Math.cos(a) * WALK, 0.2, Math.sin(a) * WALK);
    m.scale(new THREE.Vector3(s, s, s));
    inst.setMatrixAt(i, m);
  }
  inst.castShadow = true;
  root.add(inst);
  REFS.decor.push(inst);

  // 上扶手 + 下枕石
  for (const [y, tube] of [[1.45, 0.16], [0.2, 0.1]]) {
    const rail = new THREE.Mesh(new THREE.TorusGeometry(WALK, tube, 8, 220), matStone);
    rail.rotation.x = -Math.PI / 2;
    rail.position.y = y;
    root.add(rail);
  }

  // 栏柱（每 11°一根，和参考图的节奏接近）
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2 + Math.PI / 32;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.85, 0.46), matStone);
    post.position.set(Math.cos(a) * WALK, 0.97, Math.sin(a) * WALK);
    post.rotation.y = -a;
    post.castShadow = true;
    root.add(post);
    // 柱头小火苗（参考图栏杆上有一圈小灯）
    if (i % 4 === 0) {
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.9), new THREE.MeshBasicMaterial({
        map: texFlame, color: 0xffc07a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      lamp.position.set(Math.cos(a) * WALK, 2.1, Math.sin(a) * WALK);
      lamp.rotation.y = -a;
      root.add(lamp);
    }
  }

  // 外侧女墙：高角度下比细栏杆更立得住，也是挂布幔的地方
  const parapet = new THREE.Mesh(
    new THREE.CylinderGeometry(WALK + 0.75, WALK + 0.62, 1.15, 150, 1, true),
    new THREE.MeshStandardMaterial({ map: texStone, color: 0xc9c0d6, roughness: 0.92, metalness: 0.03, side: THREE.DoubleSide })
  );
  parapet.position.y = 0.55;
  parapet.castShadow = true;
  root.add(parapet);
  const cap = new THREE.Mesh(new THREE.TorusGeometry(WALK + 0.72, 0.13, 8, 200), matStone);
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = 1.13;
  root.add(cap);
}
buildBalustrade();

// ═══════════════════════════════════════ 四向台阶
function buildStairs() {
  const group = new THREE.Group();
  const steps = 7;
  for (let dir = 0; dir < 4; dir++) {
    const g = new THREE.Group();
    g.rotation.y = (dir * Math.PI) / 2;
    for (let i = 0; i < steps; i++) {
      const w = 7.4 - i * 0.18;
      const h = 0.34 * (steps - i);
      const d = 0.78;
      const step = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matStone);
      step.position.set(0, -h / 2 + 0.16, R - 0.2 + i * d + d / 2);
      step.castShadow = true; step.receiveShadow = true;
      g.add(step);
      // 踏面前沿的金线：远看才分得清七级台阶
      const edge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.12), matGoldLine);
      edge.position.set(0, 0.17, R - 0.2 + i * d + d);
      g.add(edge);
    }
    // 台阶两侧的矮墙
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.0, steps * 0.78 + 0.6), matStone);
      wall.position.set(sx * (7.4 / 2 + 0.25), -0.5, R + steps * 0.39);
      g.add(wall);
    }
    group.add(g);
  }
  root.add(group);
}
buildStairs();

// ═══════════════════════════════════════ 火盆塔（四个对角）
const braziers = [];
function buildPylons() {
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const g = new THREE.Group();
    g.position.set(Math.cos(a) * (R - 1.2), 0, Math.sin(a) * (R - 1.2));
    g.rotation.y = -a;

    // 八角基座 + 收分柱身 + 圆盘檐口：全部避开方块
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.45, 1.5, 8), matStone);
    base.position.y = 0.75; base.castShadow = true;
    g.add(base);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.6, 6.2, 16), matButtress);
    shaft.position.y = 4.6; shaft.castShadow = true;
    g.add(shaft);

    for (const y of [2.9, 4.6, 6.4]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(1.36, 0.09, 6, 24), matGoldLine);
      band.rotation.x = -Math.PI / 2;
      band.position.y = y;
      g.add(band);
    }

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 1.55, 0.45, 8), matStone);
    cap.position.y = 7.9; g.add(cap);

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

    // 炭床：暗红色自发光，让盆口有内容，也给火焰一个「来源」
    const embers = new THREE.Mesh(
      new THREE.CircleGeometry(1.22, 20),
      new THREE.MeshStandardMaterial({
        color: 0x3a0f06, emissive: 0xff6a26, emissiveIntensity: 2.4,
        roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide, toneMapped: false,
      })
    );
    embers.rotation.x = -Math.PI / 2;
    embers.position.y = 8.52;
    g.add(embers);

    // 用面片而不是 Sprite：Sprite 在 GTAO 的深度缓冲里会读不到深度，渲染成黑方块
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 2.3), new THREE.MeshBasicMaterial({
      map: texFlame, color: 0xffb070, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    // 挂到 scene 而不是柱子的 group：group 带旋转，面片会被转成侧对镜头
    fire.position.set(Math.cos(a) * (R - 1.2), 9.62, Math.sin(a) * (R - 1.2));
    scene.add(fire);

    const light = new THREE.PointLight(0xff6a2a, 70, 40, 2);
    light.position.y = 9.45;
    g.add(light);

    braziers.push({ fire, light, base: 2.1 });
    root.add(g);
  }
}
buildPylons();

// ═══════════════════════════════════════ 执环雕像（北侧一对）
function buildStatue(x, z, yaw, scale = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  g.scale.setScalar(scale);

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.1, 3.2, 8), matStone);
  plinth.position.y = 1.4; plinth.castShadow = true;
  g.add(plinth);
  const plinthTop = new THREE.Mesh(new THREE.CylinderGeometry(3.05, 2.95, 0.4, 16), matStone);
  plinthTop.position.y = 3.1;
  g.add(plinthTop);

  // 长袍：上窄下宽的多面锥，轮廓比细节重要
  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 2.05, 5.6, 14, 1), matStone);
  robe.position.y = 6.1;
  robe.castShadow = true;
  g.add(robe);

  // 衣褶：一圈细棱，从腰一直垂到袍摆，近看才有布的重量感
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.11;
    const fold = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.17, 5.3, 5), matStoneDark);
    const rr = 1.62;
    fold.position.set(Math.cos(a) * rr, 6.05, Math.sin(a) * rr);
    fold.rotation.z = Math.cos(a) * 0.075;
    fold.rotation.x = -Math.sin(a) * 0.075;
    g.add(fold);
  }
  // 腰绳
  const belt = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.1, 6, 24), matStoneDark);
  belt.rotation.x = -Math.PI / 2;
  belt.position.y = 7.6;
  g.add(belt);

  // 披肩 + 兜帽边
  const mantle = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.45, 1.1, 16, 1, true), matStoneDark);
  mantle.position.y = 8.55;
  g.add(mantle);
  const hoodRim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.09, 6, 20), matStoneDark);
  hoodRim.rotation.x = -Math.PI / 2;
  hoodRim.position.y = 9.72;
  g.add(hoodRim);

  // 手：两只球，托在环下方
  for (const sx of [-1, 1]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), matStone);
    hand.position.set(sx * 1.28, 8.28, 1.18);
    g.add(hand);
  }

  const chest = new THREE.Mesh(new THREE.SphereGeometry(1.05, 16, 12), matStone);
  chest.position.y = 8.9;
  chest.scale.set(1.0, 0.82, 0.78);
  g.add(chest);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.52, 14, 12), matStone);
  head.position.y = 10.05;
  g.add(head);

  // 兜帽
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.78, 1.5, 12), matStone);
  hood.position.y = 10.35;
  g.add(hood);

  // 双臂前伸托举
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 2.5, 8), matStone);
    arm.position.set(sx * 1.05, 8.55, 0.55);
    arm.rotation.x = -1.05;
    arm.rotation.z = sx * 0.32;
    g.add(arm);
  }

  // 手握的巨大法环（参考图里雕像举着一圈细环）
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
  const l = new THREE.PointLight(0xd9c8ff, 900, 60, 2);
  l.position.set(sx * 0.86, 20, sz + 12);
  scene.add(l);
}

// ═══════════════════════════════════════ 猩红布幔
const banners = [];
function buildBanners() {
  const geo = new THREE.PlaneGeometry(2.7, 8.4, 4, 18);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 6;
    const r = R + 8.8;
    const g = new THREE.Group();
    g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    g.rotation.y = -a;

    // 横杆
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.9, 6), matIron);
    arm.rotation.z = Math.PI / 2;
    arm.position.y = 8.95;
    g.add(arm);

    // 单面：正面朝台内。镜头被挤到台外时，布幔会被剔除而不是糊住半个屏幕
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: texBanner, color: 0xffffff, emissive: 0x2a0410, emissiveIntensity: 0.9, roughness: 0.9, metalness: 0.0,
      transparent: true, alphaTest: 0.35,
    }));
    mesh.position.set(0, 5.2, 0.02);
    g.add(mesh);

    banners.push({ mesh, base: geo.attributes.position.array.slice(), phase: Math.random() * 6.28 });
    root.add(g);
  }
}
buildBanners();

// ═══════════════════════════════════════ 崖边红叶
function buildFoliage() {
  const geo = new THREE.PlaneGeometry(2.4, 1.7);
  const mat = new THREE.MeshStandardMaterial({
    map: texLeaf, color: 0xd8455c, emissive: 0x2a0710, emissiveIntensity: 0.5,
    roughness: 0.85, metalness: 0,
    side: THREE.DoubleSide, transparent: true, alphaTest: 0.35,
  });
  const count = 1200;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = R - 2.2 + Math.random() * 9.5;
    const s = 0.34 + Math.random() * 0.55;
    e.set(Math.random() * 0.7, Math.random() * Math.PI, Math.random() * 0.7);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(Math.cos(a) * r, 0.2 + Math.random() * 2.6, Math.sin(a) * r),
      q,
      new THREE.Vector3(s, s, s)
    );
    inst.setMatrixAt(i, m);
  }
  root.add(inst);
}
buildFoliage();

// ═══════════════════════════════════════ 飘落的花瓣 / 灰烬
(function buildPetals() {
  const N = 420;
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
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
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
      '  gl_PointSize = (0.7 + aSpd * 1.4) * (120.0 / -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying float vA;',
      'void main(){',
      '  float d = length(gl_PointCoord - 0.5);',
      '  if (d > 0.5) discard;',
      '  gl_FragColor = vec4(vec3(1.0, 0.24, 0.32) * vA, (1.0 - d * 2.0) * vA);',
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
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat);
    rock.position.set(Math.cos(a) * r, -9 - Math.random() * 9, Math.sin(a) * r);
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    rock.scale.set(1, 1.5 + Math.random(), 1);
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
    const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), matStoneDark);
    mesh.position.set(Math.cos(a) * r, -22 - Math.random() * 10, Math.sin(a) * r);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    root.add(mesh);
    floaters.push({ mesh, y0: mesh.position.y, phase: Math.random() * 6.28, amp: 0.25 + Math.random() * 0.5 });
  }
}
buildFloaters();

// ═══════════════════════════════════════ 云海
const clouds = [];
function buildClouds() {
  const geo = new THREE.PlaneGeometry(1, 1);
  const SKIP_CLOUDS = new URLSearchParams(location.search).get('clouds') === '0';
  for (let i = 0; i < (SKIP_CLOUDS ? 0 : 56); i++) {
    const r = 20 + Math.random() * 220;
    const a = Math.random() * Math.PI * 2;
    const s = 55 + Math.random() * 150;
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: texCloud, transparent: true, opacity: 0.40 + Math.random() * 0.32,
      depthWrite: false, side: THREE.DoubleSide, color: 0xe9dfef,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI;
    mesh.position.set(Math.cos(a) * r, -10 - Math.random() * 34, Math.sin(a) * r);
    mesh.scale.set(s, s * (0.7 + Math.random() * 0.5), 1);
    scene.add(mesh);
    clouds.push({ mesh, spin: (Math.random() - 0.5) * 0.01, phase: Math.random() * 6.28 });
  }
}
buildClouds();

// 云海底板：一张大平面铺在要塞下方，让「浮空」有底而不是悬在纯色里
(function buildCloudSea() {
  const t = texCloud.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(7, 7);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial({
    map: t, transparent: true, opacity: 0.5, depthWrite: false, color: 0xc4b3d6,
  }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -13;
  sea.material.opacity = 0.5;
  scene.add(sea);
})();

// 云墙（大面片）已移除：贴边的第三人称镜头会穿进这些面片，画面上出现整片灰/黑遮挡。
// 远景氛围交给雾和云海底板，效果更稳。

// ═══════════════════════════════════════ 台外壕沟（环形地面，压住下面的白云）
(function buildMoat() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(R * 0.99, R + 12.5, 128, 1),
    new THREE.MeshStandardMaterial({ map: texStoneDark, color: 0x7d7396, roughness: 1.0, metalness: 0 })
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
    map: albedoRelief, normalMap: nrmRelief, normalScale: new THREE.Vector2(1.9, 1.9),
    color: 0xbfb4d2, emissive: 0x30263f, emissiveIntensity: 1.0,
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

  // 墙顶的圆齿（用圆柱，不用方块）
  const teeth = 64;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    // 跳过北面缺口
    const d = Math.abs(((a - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < gap / 2 + 0.06) continue;
    if (Math.random() < 0.16) continue;                     // 崩掉的缺口
    const th = 1.2 + Math.random() * 1.3;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.14, th, 12), matPost);
    const tRing = new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.07, 5, 20), matPost);
    tRing.rotation.x = -Math.PI / 2;
    tRing.position.set(Math.cos(a) * (rTop - 0.3), baseY + H + 0.12, Math.sin(a) * (rTop - 0.3));
    g.add(tRing);

    // 小柱头：再收一层 + 顶板，城齿从「锥子」变成小柱
    const mCap = new THREE.Mesh(new THREE.CylinderGeometry(1.26, 1.06, 0.26, 12), matPost);
    mCap.position.set(Math.cos(a) * (rTop - 0.3), baseY + H + th + 0.12, Math.sin(a) * (rTop - 0.3));
    g.add(mCap);
    const mTop = new THREE.Mesh(new THREE.CylinderGeometry(1.34, 1.34, 0.09, 12), matPost);
    mTop.position.set(Math.cos(a) * (rTop - 0.3), baseY + H + th + 0.30, Math.sin(a) * (rTop - 0.3));
    g.add(mTop);
    t.position.set(Math.cos(a) * (rTop - 0.3), baseY + H + th / 2, Math.sin(a) * (rTop - 0.3));
    t.rotation.z = (Math.random() - 0.5) * 0.06;            // 轻微歪斜，像年久失修
    g.add(t);
  }

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
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.18, 2.46, shaftH, 16, 1), matColumn);
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
  const matFar = new THREE.MeshStandardMaterial({ color: 0x584a70, roughness: 1.0, metalness: 0 });
  const matFarDark = new THREE.MeshStandardMaterial({ color: 0x392f4c, roughness: 1.0, metalness: 0 });
  const matSlit = new THREE.MeshBasicMaterial({ color: 0x1a1428 });

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
  const gateGlow = new THREE.Mesh(new THREE.PlaneGeometry(13, 30), new THREE.MeshBasicMaterial({
    color: 0xff3f6b, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  gateGlow.position.set(0, 16, gateZ + 8);
  g.add(gateGlow);
  // 门楼两侧垂下的猩红长幡
  for (const sx of [-1, 1]) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 34), new THREE.MeshStandardMaterial({
      map: texBanner, color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide,
      transparent: true, alphaTest: 0.3,
    }));
    cloth.position.set(sx * 12.5, 30, gateZ + 9);
    g.add(cloth);
  }

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
  // 只留 3 盏：前向渲染每个点光都要逐片元算一遍，之前 12 盏是最大的性能开销之一。
  // 少掉的亮度由内墙自发光 + 半球光补。
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.6;
    const l = new THREE.PointLight(0xa48bd6, 780, 80, 2);
    l.position.set(Math.cos(a) * (R + 1.5), 7.5, Math.sin(a) * (R + 1.5));
    scene.add(l);
    REFS.washLights.push(l);
  }
})();


  ST = {
    scene,
    braziers: typeof braziers !== 'undefined' ? braziers : [],
    banners: typeof banners !== 'undefined' ? banners : [],
    floaters: typeof floaters !== 'undefined' ? floaters : [],
    clouds: typeof clouds !== 'undefined' ? clouds : [],
    petals: window.__petals ?? null,
  };

  // ── 投影清理：城墙/远景塔/台面这些大件投的影会横跨擂台，
  //    形成大片三角形暗块，而且很吃阴影 pass。只保留近处道具和角色的投影。
  // 静态场景一律不投影：AO 已经给了接触阴影，而场景级投影只会在地面留下大片楔形暗块
  // （角色是在 buildStage 之后才加进来的，所以它们的投影不受影响）
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
  return {
    radius: R, root, obstacles, setPhase: setStagePhase,
    setDecor(on) { for (const o of REFS.decor) o.visible = on; },
  };
}


/** 每帧动画：火苗跳动 / 布幔摆动 / 碎石浮动 / 云海旋转 / 花瓣下落 */
export function updateStage(t, camera) {
  if (!ST) return;
  const { braziers, banners, floaters, clouds, petals } = ST;

  for (let i = 0; i < braziers.length; i++) {
    const b = braziers[i];
    const f = 1 + Math.sin(t * 9 + i * 2.1) * 0.09 + Math.sin(t * 23 + i) * 0.05;
    b.fire.scale.set(b.base * f * 1.05, b.base * 1.55 * f, 1);
    if (camera) b.fire.quaternion.copy(camera.quaternion);
    b.light.intensity = 62 + Math.sin(t * 11 + i) * 18;
  }

  const geo = banners[0]?.mesh.geometry;
  if (geo) {
    const arr = geo.attributes.position;
    for (const b of banners) {
      const base = b.base;
      for (let i = 0; i < arr.count; i++) {
        const ix = i * 3;
        const x = base[ix], y = base[ix + 1];
        const k = (y + 4.2) / 8.4;
        arr.setX(i, x + Math.sin(t * 1.7 + y * 0.9 + b.phase) * 0.22 * k);
        arr.setZ(i, Math.sin(t * 1.1 + y * 1.3 + b.phase) * 0.3 * k);
      }
    }
    arr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  for (const f of floaters) {
    f.mesh.position.y = f.y0 + Math.sin(t * 0.6 + f.phase) * f.amp;
    f.mesh.rotation.y += 0.0015;
  }
  for (const c of clouds) c.mesh.rotation.z += c.spin * 0.35;

  if (petals) petals.uniforms.uTime.value = t;

  // ── 阶段过渡：二阶段把场景推到「血月」
  if (PHASE_MIX !== PHASE_TARGET) {
    PHASE_MIX += Math.sign(PHASE_TARGET - PHASE_MIX) * Math.min(0.9, 2.2 * 0.016);
    PHASE_MIX = Math.max(0, Math.min(1, PHASE_MIX));
  }
  const mix = PHASE_MIX;
  if (mix > 0.001) {
    if (REFS.magicMat) {
      REFS.magicMat.color.setRGB(1, 1 - 0.62 * mix, 1 - 0.55 * mix);
      REFS.magicMat.opacity = 0.42 * (1 + 0.30 * mix);
    }
    if (REFS.glowMat) REFS.glowMat.color.setRGB(0.36 + 0.34 * mix, 0.29 - 0.22 * mix, 0.5 - 0.30 * mix);
    const fog = ST.scene?.fog;
    if (fog) {
      fog.color.copy(FOG_BASE).lerp(FOG_P2, mix);
      fog.near = 78 - 40 * mix;
      fog.far = 360 - 170 * mix;
    }
    if (REFS.skyMat) {
      REFS.skyMat.uniforms.cTop.value.copy(SKY_BASE.top).lerp(SKY_P2.top, mix);
      REFS.skyMat.uniforms.cMid.value.copy(SKY_BASE.mid).lerp(SKY_P2.mid, mix);
      REFS.skyMat.uniforms.cBot.value.copy(SKY_BASE.bot).lerp(SKY_P2.bot, mix);
    }
    for (const b of braziers) {
      b.light.color.setRGB(1, 0.42 - 0.24 * mix, 0.16 + 0.20 * mix);
      b.light.intensity = 62 * (1 + 0.45 * mix);
    }
    for (const l of REFS.washLights) l.color.setRGB(0.64 + 0.2 * mix, 0.55 - 0.3 * mix, 0.84 - 0.2 * mix);
    if (REFS.key) {
      REFS.key.intensity = 2.5 * (1 - 0.34 * mix);
      REFS.key.color.setRGB(1, 0.94 - 0.24 * mix, 0.88 - 0.34 * mix);
    }
    if (REFS.hemi) REFS.hemi.intensity = 0.88 * (1 - 0.35 * mix);
  }
}