import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────
//  灰盒视觉层：只负责「让玩家看懂判定和姿态」
//  接入自己的美术时整个文件可以丢弃，
//  只需保留 createViz() / placeViz()，或用调试线框替代
// ─────────────────────────────────────────────────────────────

const COL = {
  player: 0x5aa9e6,
  playerAccent: 0x9ee6ff,
  boss: 0xd0714a,
  bossAccent: 0xffb28a,
  hit: 0xff3b5c,
  hurt: 0x2fe08a,
  ground: 0x20242a,
};

/** 骨架尺寸（米）。footik.js 做两骨 IK 需要这些真实长度，不要各写一份 */
export const RIG = {
  hipHeight: 0.98,   // hips 离地高度
  hipX: 0.15,        // 髋关节左右偏移
  thigh: 0.48,       // 大腿长
  shin: 0.46,        // 小腿长
};

/**
 * 一个可复用的「圆柱判定」可视化。
 * 只要三块：半透明填充 + 底环 + 顶环。不要满屏竖线。
 * kind: 'hit' 攻击判定（红，实一点） | 'hurt' 受击判定（绿，虚一点）
 */
export function createViz(kind = 'hit') {
  const color = kind === 'hit' ? COL.hit : COL.hurt;
  const fillOpacity = kind === 'hit' ? 0.16 : 0.07;
  const edgeOpacity = kind === 'hit' ? 0.95 : 0.55;

  const group = new THREE.Group();
  group.visible = false;

  const fill = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: fillOpacity,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  // 受击框只画上下两环，不画填充 —— 否则满屏绿色光柱，看不清角色
  fill.visible = kind === 'hit';

  const edgeMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: edgeOpacity,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const ringGeo = new THREE.RingGeometry(0.965, 1.0, 40);
  const ringB = new THREE.Mesh(ringGeo, edgeMat);
  ringB.rotation.x = -Math.PI / 2;
  const ringT = new THREE.Mesh(ringGeo, edgeMat);
  ringT.rotation.x = -Math.PI / 2;

  group.add(fill, ringB, ringT);
  group.userData = { fill, ringB, ringT };
  return group;
}

/** 把判定可视化同步到世界坐标：origin 脚下 + yaw 前向 + forward 偏移 */
export function placeViz(viz, origin, yaw, forward, radius, yMin, yMax, active) {
  if (!active || radius <= 0.001) { viz.visible = false; return; }
  const h = Math.max(0.05, yMax - yMin);
  const cx = origin.x + Math.sin(yaw) * forward;
  const cz = origin.z + Math.cos(yaw) * forward;

  const { fill, ringB, ringT } = viz.userData;
  fill.position.set(cx, yMin + h / 2, cz);
  fill.scale.set(radius, h, radius);
  ringB.position.set(cx, yMin + 0.02, cz);
  ringB.scale.set(radius, radius, radius);
  ringT.position.set(cx, yMax - 0.02, cz);
  ringT.scale.set(radius, radius, radius);
  viz.visible = true;
}

/**
 * 火柴人灰盒 —— 带关节的骨架，不是一块刚性胶囊。
 * 层级：group(世界变换) → body(翻滚/倒地旋转) → hips → spine → 头/双臂 → 前臂 → 武器
 * 缩放只作用于外观；判定框在 frame-data.js 里独立配置。
 */
export function makeFighter(isBoss, scale = 1) {
  const group = new THREE.Group();
  const bodyColor = isBoss ? COL.boss : COL.player;
  const accentColor = isBoss ? COL.bossAccent : COL.playerAccent;

  const matBody = new THREE.MeshStandardMaterial({
    color: bodyColor, roughness: 0.72, metalness: 0.06,
  });
  const matAccent = new THREE.MeshStandardMaterial({
    color: accentColor, roughness: 0.4, metalness: 0.25,
  });

  const limb = (len, r, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, len, 8), mat);
    m.position.y = -len / 2;
    m.castShadow = true;
    return m;
  };

  // body：翻滚 / 倒地时整体旋转的节点（原点在脚底）
  const body = new THREE.Group();
  group.add(body);

  // hips：髋部
  const hips = new THREE.Group();
  hips.position.y = 0.98;
  body.add(hips);

  // spine：下腹
  const spine = new THREE.Group();
  hips.add(spine);

  const lowerTorso = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, 0.20, 6, 14), matBody);
  lowerTorso.position.y = 0.18;
  lowerTorso.castShadow = true;
  spine.add(lowerTorso);

  // chest：上胸。躯干拆成两节才能弯出 S 曲线 —— 一根直棍永远像棍子
  const chest = new THREE.Group();
  chest.position.y = 0.34;
  spine.add(chest);

  const upperTorso = new THREE.Mesh(new THREE.CapsuleGeometry(0.205, 0.18, 6, 14), matBody);
  upperTorso.position.y = 0.14;
  upperTorso.castShadow = true;
  chest.add(upperTorso);

  // 正反面标识：灰盒没脸的时候，这两块是唯一的前后线索
  const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.18, 0.07), matAccent);
  chestPlate.position.set(0, 0.16, 0.185);
  chestPlate.castShadow = true;
  chest.add(chestPlate);

  const backPlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.30, 0.30, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x2e343c, roughness: 0.9 })
  );
  backPlate.position.set(0, 0.12, -0.185);
  chest.add(backPlate);

  // 肩横杆：让「转身」看得见
  const shoulderBar = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.065, 0.085), matAccent);
  shoulderBar.position.y = 0.30;
  chest.add(shoulderBar);

  // head
  const head = new THREE.Group();
  head.position.y = 0.46;
  chest.add(head);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.168, 16, 12), matAccent);
  headMesh.position.y = 0.07;
  headMesh.castShadow = true;
  head.add(headMesh);

  // 面甲：正脸一条深色横带。
  // 球头正反面长得完全一样，没有它，玩家从背后看会以为角色是反的。
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.155, 0.072, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.8 })
  );
  visor.position.set(0, 0.075, 0.148);
  head.add(visor);

  // 脖子：把头和躯干接上，不然像个球浮在桶上
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 10), matBody);
  neck.position.y = 0.38;
  chest.add(neck);

  // 双臂：arm = 肩，fore = 肘
  // 注意：角色局部 forward=+Z、up=+Y 时，右手在 -X（right = forward × up）
  // side=1 必须落在 -X，否则武器挂到左手、横扫方向整个镜像
  const makeArm = (side) => {
    const arm = new THREE.Group();
    arm.position.set(-0.335 * side, 0.30, 0);
    chest.add(arm);
    arm.add(limb(0.30, 0.082, matBody));

    const fore = new THREE.Group();
    fore.position.y = -0.30;
    arm.add(fore);
    fore.add(limb(0.28, 0.072, matBody));

    // 拳头：没有它读不出「打到哪」
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), matAccent);
    fist.position.y = -0.28;
    fist.castShadow = true;
    fore.add(fist);

    return { arm, fore, fist };
  };
  const R = makeArm(1);
  const L = makeArm(-1);

  // 武器：挂在右手末端，长轴沿 +Z（正前方）
  const weapon = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.055, isBoss ? 1.55 : 0.92),
    matAccent
  );
  weapon.position.set(0, -0.28, (isBoss ? 1.55 : 0.92) * 0.42);
  weapon.castShadow = true;
  R.fore.add(weapon);

  // 腿：leg = 髋，shin = 膝
  const makeLeg = (side) => {
    const leg = new THREE.Group();
    leg.position.set(0.15 * side, 0, 0);
    hips.add(leg);
    leg.add(limb(0.48, 0.10, matBody));

    const shin = new THREE.Group();
    shin.position.y = -0.48;
    leg.add(shin);
    shin.add(limb(0.46, 0.088, matBody));

    // 脚
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.26), matAccent);
    foot.position.set(0, -0.46, 0.06);
    shin.add(foot);

    return { leg, shin, foot };
  };
  const RL = makeLeg(1);
  const LL = makeLeg(-1);

  // 脚下圆环：不随 body 翻滚，始终贴地
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.40, 0.48, 32),
    new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  // 格挡盾面：挂在躯干上，跟着姿态走
  const guard = new THREE.Mesh(
    new THREE.SphereGeometry(0.78, 24, 18, -Math.PI * 0.46, Math.PI * 0.92, Math.PI * 0.14, Math.PI * 0.62),
    new THREE.MeshBasicMaterial({
      color: accentColor, transparent: true, opacity: 0.26,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  guard.position.set(0, 0.18, 0.12);
  guard.rotation.y = Math.PI / 2;
  guard.visible = false;
  guard.renderOrder = 90;
  chest.add(guard);

  const guardEdge = new THREE.Mesh(
    new THREE.RingGeometry(0.76, 0.805, 44, 1, -Math.PI * 0.46, Math.PI * 0.92),
    new THREE.MeshBasicMaterial({
      color: accentColor, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  guardEdge.position.copy(guard.position);
  guardEdge.rotation.y = Math.PI / 2;
  guardEdge.visible = false;
  guardEdge.renderOrder = 91;
  chest.add(guardEdge);

  group.scale.setScalar(scale);

  return {
    group, body, hips, spine, chest, head,
    armL: L.arm, foreL: L.fore, handL: L.fist, armR: R.arm, foreR: R.fore,
    legL: LL.leg, shinL: LL.shin, footL: LL.foot, legR: RL.leg, shinR: RL.shin, footR: RL.foot,
    lowerTorso, upperTorso, weapon, ring, guard, guardEdge, matBody, matAccent,
  };
}

/**
 * 把 pose 应用到骨架上。k 是混合系数：1 = 直接跟随，<1 = 平滑过渡
 * （状态切换时用 0.3 左右，避免跳帧；攻击/翻滚内部用 1）
 */
export function applyPose(rig, pose, k = 1) {
  if (!rig._cur) rig._cur = {};
  const cur = rig._cur;

  const joints = ['spine', 'head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR'];
  // 向下生长的关节（手臂/腿）：Rx(+θ) 把它们转向 -Z（身后），要取反才符合「正 = 向前」
  // 向上生长的关节（spine/head）：Rx(+θ) 本来就把它们转向 +Z（身前），不要取反
  const DOWNWARD = new Set(['armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR']);
  // 手臂比躯干慢半拍，产生跟随感（手臂甩出去之后才回来）
  const LAG = new Set(['armL', 'armR', 'foreL', 'foreR']);

  for (const key of joints) {
    const j = rig[key];
    if (!j) continue;
    const t = pose[key] ?? [0, 0, 0];
    const c = cur[key] ?? [t[0], t[1], t[2]];
    const kk = LAG.has(key) ? k * 0.62 : k;
    const n = [
      c[0] + (t[0] - c[0]) * kk,
      c[1] + (t[1] - c[1]) * kk,
      c[2] + (t[2] - c[2]) * kk,
    ];
    // spine 拆成下腹 + 上胸两段，弯曲分摊成 S 曲线而不是一根直棍
    if (key === 'spine') {
      j.rotation.set(n[0] * 0.55, n[1] * 0.40, n[2] * 0.5);
      if (rig.chest) rig.chest.rotation.set(n[0] * 0.45, n[1] * 0.60, n[2] * 0.5);
    } else {
      j.rotation.set(DOWNWARD.has(key) ? -n[0] : n[0], n[1], n[2]);
    }
    cur[key] = n;
  }

  // hips：走路时的骨盆左右摆 + 倾斜。这是「像在走路」和「像在滑行」的分界
  const tx = pose.__hipsX ?? 0;
  const cx = cur.__hipsX ?? tx;
  const nx = cx + (tx - cx) * k;
  rig.hips.position.x = nx;
  cur.__hipsX = nx;

  const tt = pose.__hipsTilt ?? 0;
  const ct = cur.__hipsTilt ?? tt;
  const nt = ct + (tt - ct) * k;
  rig.hips.rotation.z = nt;
  cur.__hipsTilt = nt;

  // body：翻滚 / 倒地
  const tb = pose.__body ?? [0, 0, 0];
  const cb = cur.__body ?? [tb[0], tb[1], tb[2]];
  const nb = [cb[0] + (tb[0] - cb[0]) * k, cb[1] + (tb[1] - cb[1]) * k, cb[2] + (tb[2] - cb[2]) * k];
  rig.body.rotation.set(nb[0], nb[1], nb[2]);
  cur.__body = nb;

  const ty = pose.__bodyY ?? 0;
  const cy = cur.__bodyY ?? ty;
  const ny = cy + (ty - cy) * k;
  rig.body.position.y = ny;
  cur.__bodyY = ny;
}

/** 场地：地面 + 网格 + 边界墙。尺寸就是战斗空间本身 */
export function makeArena(scene, size = 30) {
  const half = size / 2;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: COL.ground, roughness: 0.96, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(size, size, 0x3a424c, 0x2a3038);
  grid.position.y = 0.008;
  grid.material.transparent = true;
  grid.material.opacity = 0.75;
  scene.add(grid);

  // 中心圆：给「距离开阔感」一个参照
  const centerRing = new THREE.Mesh(
    new THREE.RingGeometry(5.85, 6.0, 64),
    new THREE.MeshBasicMaterial({ color: 0x39424d, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.y = 0.012;
  scene.add(centerRing);

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x2f353d, roughness: 0.95, transparent: true, opacity: 0.42,
  });
  const walls = [
    [0, 0.9, -half, size, 1.8, 0.35],
    [0, 0.9, half, size, 1.8, 0.35],
    [-half, 0.9, 0, 0.35, 1.8, size],
    [half, 0.9, 0, 0.35, 1.8, size],
  ];
  for (const [x, y, z, w, h, d] of walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z);
    scene.add(m);
  }

  return { size, half };
}

export function setupLights(scene) {
  scene.add(new THREE.HemisphereLight(0x9aa8c4, 0x14161c, 1.15));

  const key = new THREE.DirectionalLight(0xffeedd, 2.0);
  key.position.set(9, 15, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const c = key.shadow.camera;
  c.left = -22; c.right = 22; c.top = 22; c.bottom = -22; c.far = 60;
  key.shadow.bias = -0.0008;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x5a7fd0, 1.0);
  rim.position.set(-11, 9, -13);
  scene.add(rim);

  return { key, rim };
}
