import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
  hoop.rotateX(Math.PI / 2);
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
      jar.rotation.x = Math.PI / 2;
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

export function buildArenaProps(root, walkRadius, materials) {
  const { trim, iron } = materials;
  return buildSupplyStops(root, walkRadius + .51, trim, iron);
}
