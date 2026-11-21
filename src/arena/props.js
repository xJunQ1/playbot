import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HALF_TURN = Math.PI;
const UP = new THREE.Vector3(0, 1, 0);

function place(geometry, material, group, x, y, z, yaw = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function boxes(group, material, pieces) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, pieces.length);
  const transform = new THREE.Object3D();
  for (const [index, piece] of pieces.entries()) {
    const [x, y, z, width, height, depth, yaw = 0, roll = 0, tint = 1] = piece;
    transform.position.set(x, y, z);
    transform.rotation.set(0, yaw, roll);
    transform.scale.set(width, height, depth);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    mesh.setColorAt(index, new THREE.Color().setScalar(tint));
  }
  mesh.receiveShadow = true;
  group.add(mesh);
}

function buildPortcullis(root, radius, stone, trim, iron, flame) {
  const gate = new THREE.Group();
  gate.name = 'north-portcullis';
  gate.position.set(0, -0.65, -radius - 12.8);
  const opening = 3.58, spring = 5.0;
  const outline = new THREE.Shape().moveTo(-opening, 0).lineTo(-opening, spring);
  outline.absarc(0, spring, opening, HALF_TURN, 0, true);
  outline.lineTo(opening, 0).closePath();
  const backing = new THREE.ShapeGeometry(outline, 26);
  const colors = [];
  const position = backing.attributes.position;
  const lower = new THREE.Color(0x482b35), upper = new THREE.Color(0x171923);
  const shade = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const darkness = THREE.MathUtils.smoothstep(position.getY(i), 0, spring + opening);
    shade.copy(lower).lerp(upper, darkness);
    colors.push(shade.r, shade.g, shade.b);
  }
  backing.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  place(backing, new THREE.MeshBasicMaterial({ vertexColors: true }), gate, 0, 0, -0.72);

  const masonry = [], coping = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const y = .35 + i * .65;
      masonry.push([side * (opening + .40), y, .28, .85 + .05 * (i % 2), .64, 1.23, 0, 0, .82 + (i % 4) * .052]);
      masonry.push([side * 5.22, y, -.05, 1.63, .635, 2.40 + .1 * (i % 2), 0, 0, .76 + (i % 3) * .064]);
    }
    coping.push([side * 5.22, .15, .0, 2.05, .27, 2.79]);
    coping.push([side * 5.22, 5.19, .0, 2.03, .22, 2.66]);
    coping.push([side * 4.91, 6.66, -.1, 1.79, 2.68, 2.15, 0, 0, .79]);
    coping.push([side * 4.91, 8.12, -.1, 2.06, .25, 2.44]);
  }
  coping.push([0, .23, .55, 7.55, .34, .83, 0, 0, .72]);
  boxes(gate, stone, masonry);
  boxes(gate, trim, coping);

  const voussoirs = [];
  const segments = 15;
  for (let i = 0; i < segments; i++) {
    const start = i * HALF_TURN / segments + .004;
    const end = (i + 1) * HALF_TURN / segments - .004;
    const outer = opening + (i === 7 ? 1.04 : .78 + (i % 3) * .055);
    const stoneShape = new THREE.Shape();
    stoneShape.moveTo(Math.cos(start) * opening, Math.sin(start) * opening);
    stoneShape.absarc(0, 0, opening, start, end, false);
    stoneShape.lineTo(Math.cos(end) * outer, Math.sin(end) * outer);
    stoneShape.absarc(0, 0, outer, end, start, true);
    stoneShape.closePath();
    const wedge = new THREE.ExtrudeGeometry(stoneShape, { depth: .78, bevelEnabled: false, curveSegments: 4 });
    wedge.translate(0, spring, -.12);
    voussoirs.push(wedge);
  }
  const arch = mergeGeometries(voussoirs);
  for (const wedge of voussoirs) wedge.dispose();
  place(arch, stone, gate, 0, 0, 0);
  const moulding = new THREE.TorusGeometry(opening + .41, .09, 6, 32, HALF_TURN);
  place(moulding, trim, gate, 0, spring, .69);

  const grating = [];
  for (let i = -6; i <= 6; i++) {
    const x = i * .51;
    const top = spring + Math.sqrt(opening * opening - x * x) - .16;
    grating.push([x, top * .5 + .11, .49, i ? .10 : .19, top - .22, .15, 0, 0, .68 + (i + 6) % 4 * .10]);
  }
  for (const y of [1.08, 2.50, 3.92, 4.84]) grating.push([0, y, .59, 7.02, .14, .19]);
  grating.push([-1.78, 3.14, .61, 3.64, .115, .19, 0, .38]);
  grating.push([1.78, 3.14, .61, 3.64, .115, .19, 0, -.38]);
  boxes(gate, iron, grating);

  const amber = new THREE.MeshBasicMaterial({
    map: flame, color: 0xffad63, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const bracket = new THREE.CylinderGeometry(.25, .09, .31, 8);
  const torchFire = new THREE.PlaneGeometry(.86, 1.43);
  for (const side of [-1, 1]) {
    place(bracket, iron, gate, side * 5.1, 3.2, 1.58);
    place(torchFire, amber, gate, side * 5.1, 3.88, 1.66);
  }
  root.add(gate);
}

function timber() {
  const image = document.createElement('canvas');
  image.width = image.height = 256;
  const g = image.getContext('2d');
  g.fillStyle = '#786253';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5; i++) {
    const seam = i * 51;
    g.fillStyle = i % 2 ? '#8c7460' : '#705a4b';
    g.fillRect(seam + 2, 0, 48, 256);
    g.fillStyle = '#413429';
    g.fillRect(seam, 0, 2, 256);
  }
  for (let i = 0; i < 120; i++) {
    const x = (i * 53 + 23) % 256, y = (i * 73) % 256;
    g.strokeStyle = i % 3 ? '#39291d33' : '#e2bea137';
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + (i % 7) - 2, y + 22, x - 4, y + 39, x + 2, y + 70 + (i % 11) * 4);
    g.stroke();
  }
  const map = new THREE.CanvasTexture(image);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map, color: 0xc6b6a0, roughness: .92 });
}

function buildSupplyStops(root, walkRadius, stone, iron) {
  const supplies = new THREE.Group();
  supplies.name = 'perimeter-supply-stops';
  const wood = timber();
  const cask = new THREE.LatheGeometry([
    [.37, 0], [.41, .06], [.48, .34], [.49, .56], [.45, .81], [.38, .96], [.35, 1.0],
  ].map(pair => new THREE.Vector2(...pair)), 12);
  const lid = new THREE.CylinderGeometry(.36, .36, .043, 12);
  const hoop = new THREE.TorusGeometry(.45, .027, 5, 16);
  hoop.rotateX(HALF_TURN / 2);
  const chocks = [], planks = [], hardware = [];
  for (const [index, angle] of [-2.11, -1.02, .30, 1.67, 2.76].entries()) {
    const x = Math.cos(angle) * walkRadius, z = Math.sin(angle) * walkRadius;
    const stop = new THREE.Group();
    stop.position.set(x, .16, z);
    stop.rotation.y = -angle;
    const jar = new THREE.Group();
    jar.position.set(.08, .08, .72);
    if (index % 2) {
      jar.position.y = .52;
      jar.rotation.x = HALF_TURN / 2;
    }
    place(cask, wood, jar, 0, 0, 0);
    place(lid, wood, jar, 0, .98, 0);
    place(lid, wood, jar, 0, .02, 0);
    place(hoop, iron, jar, 0, .23, 0).scale.setScalar(.99);
    place(hoop, iron, jar, 0, .72, 0).scale.setScalar(1.03);
    stop.add(jar);
    supplies.add(stop);

    const tangent = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, -angle);
    const cx = x - tangent.x * .76, cz = z - tangent.z * .76;
    chocks.push([cx, .23, cz, .91, .17, 1.20, -angle]);
    planks.push([cx, .59, cz, .76, .61, .91, -angle, 0, .82 + index * .036]);
    for (const side of [-1, 1]) {
      hardware.push([cx + side * tangent.x * .32, .59, cz + side * tangent.z * .32, .80, .63, .044, -angle]);
    }
  }
  boxes(supplies, stone, chocks);
  boxes(supplies, wood, planks);
  boxes(supplies, iron, hardware);
  root.add(supplies);
  return supplies;
}

export function buildArenaProps(root, radius, walkRadius, materials, flame) {
  const { stone, trim, iron } = materials;
  buildPortcullis(root, radius, stone, trim, iron, flame);
  return buildSupplyStops(root, walkRadius + .51, trim, iron);
}
