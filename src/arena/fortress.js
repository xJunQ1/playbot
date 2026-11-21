import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const noise = n => Math.sin(n * 72.163 + 1.782) * .5 + .5;

function masonryBatch(root, materials) {
  const batches = new Map();
  function part(material, geometry, x, y, z, tint = 1) {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    if (geo !== geometry) geometry.dispose();
    const color = [], p = geo.attributes.position, uv = geo.attributes.uv, normal = geo.attributes.normal;
    for (let i = 0; i < p.count; i += 3) {
      const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
      for (let k = i; k < i + 3; k++) {
        const xx = p.getX(k) + x, yy = p.getY(k) + y, zz = p.getZ(k) + z;
        const wear = tint * (.91 + .09 * noise(xx * .073 + yy * .13 + zz * .051));
        color.push(wear, wear * .99, wear * .97);
        uv.setXY(k, (nx > nz ? zz : xx) / 9, (ny > .7 ? zz : yy) / 7);
      }
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    geo.translate(x, y, z);
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push(geo);
  }
  function box(material, x, y, z, w, h, d, tint = 1, yaw = 0) {
    if (w <= 0 || h <= 0 || d <= 0) return;
    part(material, new THREE.BoxGeometry(w, h, d).rotateY(yaw), x, y, z, tint);
  }
  function finish() {
    for (const [key, pieces] of batches) {
      const mesh = new THREE.Mesh(mergeGeometries(pieces), materials[key]);
      mesh.receiveShadow = true;
      root.add(mesh);
      for (const geometry of pieces) geometry.dispose();
    }
  }
  return { part, box, finish };
}

const pointedY = t => Math.sin(t) * (.70 + .30 * Math.sin(t));

function arch(batch, key, x, spring, z, radius, rise, band, depth, count) {
  for (let i = 0; i < count; i++) {
    const shape = new THREE.Shape();
    const a = Math.PI * i / count + .009, b = Math.PI * (i + 1) / count - .009;
    const outer = radius + band * (i === (count - 1) / 2 ? 1.16 : 1);
    for (let j = 0; j <= 3; j++) {
      const theta = THREE.MathUtils.lerp(a, b, j / 3);
      const xx = Math.cos(theta) * radius, yy = pointedY(theta) * rise;
      if (j === 0) shape.moveTo(xx, yy);
      else shape.lineTo(xx, yy);
    }
    for (let j = 3; j >= 0; j--) {
      const theta = THREE.MathUtils.lerp(a, b, j / 3);
      shape.lineTo(Math.cos(theta) * outer, pointedY(theta) * (rise + band));
    }
    shape.closePath();
    batch.part(key, new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }),
      x, spring, z, .83 + .17 * noise(i + 41));
  }
}

function merlons(batch, x, y, z, width, depth, h) {
  const count = Math.max(3, Math.round(width / (h * 1.26)));
  const step = width / count;
  for (let i = 0; i <= count; i++) {
    const xx = x - width / 2 + i * step;
    for (const side of [-1, 1]) {
      const zz = z + side * (depth / 2 - .32);
      batch.box('stone', xx, y + h / 2, zz, step * .62, h, h * .62);
      batch.box('trim', xx, y + h, zz, step * .68, h * .14, h * .72);
    }
  }
  for (const side of [-1, 1]) {
    const n = Math.max(2, Math.round(depth / step));
    for (let i = 1; i < n; i++) {
      batch.box('stone', x + side * width / 2, y + h / 2,
        z - depth / 2 + i * depth / n, h * .62, h, step * .62);
    }
  }
}

export function buildNorthGate(parent, radius, materials) {
  const root = new THREE.Group();
  root.name = 'north-portcullis';
  root.position.set(0, -1.33, -radius - 10.5);
  const batch = masonryBatch(root, materials);
  const { box } = batch;
  const opening = 3.75, spring = 5.15, rise = 3.40;
  for (const side of [-1, 1]) {
    const x = side * 5.29;
    box('stone', x, 4.8, -.8, 2.83, 9.6, 5.6);
    for (let row = 0; row < 10; row++) {
      const y = .43 + row * .88;
      box('trim', side * (opening + .36), y, 2.14, .74, .85, .61, .76 + noise(row) * .23);
      box('stone', side * (5.31 + (row % 2) * .15), y, 2.02, 1.66, .85, .51);
    }
    for (const [y, w, h] of [[.23, 3.4, .42], [.69, 3.07, .26], [spring, 3.08, .24], [9.61, 3.11, .41]]) {
      box('trim', x, y, -.5, w, h, 5.68);
    }
    box('stone', side * 5.83, 4.32, 2.49, .46, 7.5, .95);
    box('trim', side * 5.83, 7.95, 2.56, .69, .32, 1.09);
    box('iron', side * 5.06, 3.38, 2.55, .14, 1.11, .21);
    box('iron', side * 5.06, 3.76, 2.88, .33, .14, .74);
    batch.part('lamp', new THREE.OctahedronGeometry(.22).scale(1, 2, .87), side * 5.06, 4.02, 3.12);
  }
  arch(batch, 'trim', 0, spring, 1.76, opening, rise, .86, .76, 19);
  arch(batch, 'stone', 0, spring, -3.4, opening, rise, .58, 5.16, 19);
  arch(batch, 'trim', 0, spring, 2.52, opening + .89, rise + .89, .21, .19, 19);
  const shoulder = opening + .85;
  for (const side of [-1, 1]) {
    const fill = new THREE.Shape().moveTo(0, spring + rise + .83);
    for (let i = 1; i <= 18; i++) {
      const t = Math.PI / 2 * (1 - i / 18);
      fill.lineTo(side * Math.cos(t) * shoulder, spring + pointedY(t) * (rise + .83));
    }
    fill.lineTo(side * 5.37, spring).lineTo(side * 5.37, 9.52).lineTo(0, 9.52).closePath();
    batch.part('stone', new THREE.ExtrudeGeometry(fill, { depth: 4.65, bevelEnabled: false }), 0, 0, -2.88);
  }
  box('stone', 0, 9.97, -.35, 13.7, 1.19, 5.46);
  box('trim', 0, 10.6, -.35, 14.1, .32, 5.75);
  merlons(batch, 0, 10.7, -.4, 13.42, 5.4, 1.02);
  // Warm light in the tunnel behind the two leaves of the portcullis.
  box('doorway', 0, 4.6, -4.5, 8.8, 9.2, .25);
  for (let i = -8; i <= 8; i++) {
    const x = i * .424;
    const top = spring + rise * pointedY(Math.acos(x / opening)) - .22;
    box('iron', x, top / 2 + .40, .62, i === 0 ? .20 : .10, top, .15);
    batch.part('iron', new THREE.ConeGeometry(.11, .30, 4), x, .27, .62);
  }
  for (const y of [1.12, 2.91, 4.79, 5.02]) {
    box('iron', 0, y, .73, 7.38, .14, .28);
    for (let i = -8; i <= 8; i++) {
      batch.part('trim', new THREE.OctahedronGeometry(.071), i * .424, y, .91);
    }
  }
  // Paved approach with low parapets and three load-bearing piers beneath it.
  for (let i = 0; i < 12; i++) {
    const z = 8.3 - i * 1.35;
    for (let j = -2; j <= 2; j++) {
      box('trim', j * 1.47, -.16, z, 1.45, .29, 1.33, .72 + noise(i * 6 + j) * .24);
    }
    for (const side of [-1, 1]) {
      box('stone', side * 3.89, -.16, z, .52, .66, 1.35);
      box('trim', side * 3.89, .27, z, .73, .20, 1.33);
      if (i % 3 === 0) box('stone', side * 3.89, -2.28, z, .91, 4.36, 1.01);
    }
  }
  batch.finish();
  parent.add(root);
}

export function buildOuterFortress(scene, radius, materials, clothMaterial) {
  const root = new THREE.Group();
  root.name = 'floating-fortress-architecture';
  const base = -30;
  const tower = (key, x, z, width, top, roof, landmark = false) => {
    const group = new THREE.Group();
    group.name = key;
    root.add(group);
    const batch = masonryBatch(group, materials);
    const { box, part } = batch;
    const depth = width * .88;
    const height = top - base;
    box('stone', x, base + height / 2, z, width, height, depth);
    box('trim', x, base + .7, z, width * 1.16, 1.4, depth * 1.18);
    box('stone', x, base + 3.8, z, width * 1.1, 5, depth * 1.08);
    for (const side of [-1, 1]) for (const face of [-1, 1]) {
      box('trim', x + side * (width * .5 - .25), base + height * .5, z + face * depth * .48,
        width * .114, height, depth * .13, .88);
      box('stone', x + side * width * .53, base + height * .21, z + face * depth * .34,
        width * .15, height * .43, depth * .22);
    }
    for (const t of [.30, .57, .8, 1]) {
      const y = base + t * height;
      box('trim', x, y, z, width * 1.10, width * .080, depth * 1.10, .95);
      box('trim', x, y - width * .056, z, width * 1.065, width * .038, depth * 1.065, .78);
      if (t < .57 && !landmark) continue;
      for (let i = -2; i <= 2; i++) {
        box('trim', x + i * width * .195, y - width * .087, z + depth * .526,
          width * .074, width * .081, width * .093, .85);
      }
    }
    for (const face of [-1, 1]) {
      const front = z + face * (depth / 2 + .03);
      const tiers = landmark ? [.37, .63, .86] : [.50, .87];
      for (const t of tiers) {
        const y = base + t * height;
        for (const j of [-1, 0, 1]) {
          const xx = x + j * width * .22;
          const r = width * (j === 0 ? .074 : .054);
          const h = width * (landmark ? .35 : .32);
          box('doorway', xx, y, front, r * 2.28, h, .16);
          box('lamp', xx, y - h * .03, front + face * .09, r * .25, h * .72, .10, .7 + noise(x + j + t) * .3);
          for (const side of [-1, 1]) box('trim', xx + side * r * 1.19, y, front, r * .41, h, .54);
          arch(batch, 'trim', xx, y + h / 2, front - .28, r, r * 1.38, r * .34, .56, 7);
          box('trim', xx, y - h / 2, front, r * 2.95, .30, .76);
        }
      }
    }
    merlons(batch, x, top + .26, z, width * .99, depth, width * .12);
    if (roof) {
      const w = width * .76, d = depth * .74;
      box('stone', x, top + width * .12, z, w, width * .31, d);
      const spire = new THREE.ConeGeometry(w * .72, roof, 4, 3).rotateY(Math.PI / 4);
      spire.scale(1, 1, d / w);
      part('roof', spire, x, top + width * .25 + roof / 2, z);
      part('iron', new THREE.CylinderGeometry(.055, .12, 2.5, 6), x, top + width * .25 + roof + 1.2, z);
    }
    const foundation = new THREE.CylinderGeometry(width * .84, width * .21, width * 1.2, 9, 5);
    const vertices = foundation.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      const xx = vertices.getX(i), y = vertices.getY(i), zz = vertices.getZ(i);
      const wear = .88 + noise(xx * .091 + y * .49 + zz * .08) * .19;
      vertices.setXYZ(i, xx * wear + y * .13, y, zz * wear);
    }
    foundation.computeVertexNormals();
    part('slate', foundation, x, base - width * .59, z, .7);
    batch.finish();
  };

  const gateZ = -radius - 45;
  for (const side of [-1, 1]) tower(side < 0 ? 'citadel-west-tower' : 'citadel-east-tower',
    side * 16.5, gateZ, 15.4, 58 + side * 3.4, 18 + side * 3, true);
  const gallery = new THREE.Group();
  gallery.name = 'citadel-vaulted-gallery';
  const batch = masonryBatch(gallery, materials);
  const { box } = batch;
  for (const side of [-1, 1]) {
    box('trim', side * 9.3, 27.9, gateZ, 2.8, 3.9, 8.8);
    box('stone', side * 10.15, 23.0, gateZ, 2.6, 11.1, 7.6);
  }
  arch(batch, 'stone', 0, 29.45, gateZ - 3.9, 9.5, 9.65, 2.38, 7.8, 21);
  arch(batch, 'trim', 0, 29.45, gateZ + 4, 9.57, 9.72, .76, .58, 21);
  for (let i = -6; i <= 6; i++) {
    const x = i * 1.67;
    const bottom = 29.45 + 9.65 * pointedY(Math.acos(Math.min(1, Math.abs(x) / 9.5)));
    box('stone', x, (42.15 + bottom) / 2, gateZ, 1.69, 42.15 - bottom, 7.6);
  }
  box('trim', 0, 42.25, gateZ, 21, .74, 8.53);
  box('stone', 0, 43.02, gateZ, 21, .83, 8.1);
  merlons(batch, 0, 43.42, gateZ, 21, 7.8, 1.26);
  for (const side of [-1, 1]) {
    const x = side * 13.9, z = gateZ + 7.64;
    box('trim', x - 3.01, 35.1, z, .63, .48, 2.2);
    box('trim', x + 3.01, 35.1, z, .63, .48, 2.2);
    box('iron', x, 35.4, z + 1, 6.59, .27, .27);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 21, 12, 18), clothMaterial);
    cloth.position.set(x, 24.82, z + 1);
    gallery.add(cloth);
  }
  batch.finish();
  root.add(gallery);

  // Keep a clear view through the central arch and offset secondary keeps on each side.
  const sites = [
    [-56,-65,15,37,21], [-87,-79,19,48,22], [49,-68,15,44,22], [79,-78,20,38,26],
    [-77,-19,22,53,0], [71,-15,16,47,19], [-73,50,17,39,19], [73,48,18,43,0],
    [-36,80,21,43,19], [38,83,18,49,22], [-129,-130,24,68,0], [123,-141,26,70,0],
    [-130,40,24,62,26], [138,50,25,65,24], [-50,-162,25,61,25], [59,-167,22,73,27],
  ];
  sites.forEach(([x,z,w,h,spire], i) => tower('perimeter-keep-' + i, x, z, w, h, spire));
  for (const [from, to, y] of [[0, 1, 16], [2, 3, 18], [4, 6, 14], [5, 7, 19], [8, 9, 16]]) {
    const [ax, az] = sites[from], [bx, bz] = sites[to];
    const bridge = new THREE.Group();
    bridge.name = 'perimeter-stone-bridge';
    bridge.position.set((ax + bx) / 2, y, (az + bz) / 2);
    bridge.rotation.y = -Math.atan2(bz - az, bx - ax);
    const span = Math.hypot(bx - ax, bz - az);
    const bridgeBatch = masonryBatch(bridge, materials);
    const r = span * .32, rise = Math.min(9, span * .19);
    arch(bridgeBatch, 'stone', 0, -rise - 1.6, -2.28, r, rise, 1.35, 4.56, 17);
    for (const side of [-1, 1]) {
      bridgeBatch.box('stone', side * span * .396, -rise * .46, 0,
        span * .2, rise + 1.5, 4.53);
      bridgeBatch.box('stone', 0, .27, side * 2.06, span, 1.0, .50);
      bridgeBatch.box('trim', 0, .81, side * 2.06, span, .26, .75);
    }
    bridgeBatch.box('trim', 0, -.94, 0, span, .93, 4.9);
    bridgeBatch.finish();
    root.add(bridge);
  }
  scene.add(root);
}
