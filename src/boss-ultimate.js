import * as THREE from 'three';
import { rigFor, poseLimb, orientJoint } from './grab-combo.js';

const blink = 18, charge = 240, drop = 15;
const release = blink + charge;
export const CATACLYSM = { blink, charge, release, impact: release + drop, recovery: 83, phaseDelay: 156 };
export const CATACLYSM_MOVE = {
  label: '天坠', arenaUltimate: true, swing: 'vertical',
  startup: CATACLYSM.impact, active: 1, recovery: CATACLYSM.recovery, cancelFrom: 0,
  damage: 1050, poise: 0, hitstun: 34, stamina: 0,
  hitbox: { offset: 0 },
};

const { smoothstep, lerp } = THREE.MathUtils;
const up = new THREE.Vector3(0, 1, 0);

export function cataclysmShelters(columns) {
  return columns.map(({ x, z, r }) => {
    const distance = Math.hypot(x, z);
    const radialX = x / distance, radialZ = z / distance;
    const center = distance + r * 1.35 + 1.13;
    return { x: radialX * center, z: radialZ * center, radialX, radialZ, width: r * 1.17, depth: 1.22 };
  });
}

export function cataclysmCovered(position, shelters) {
  return shelters.some(({ x, z, radialX, radialZ, width, depth }) => {
    const dx = position.x - x, dz = position.z - z;
    const lateral = (dx * radialZ - dz * radialX) / width;
    const longitudinal = (dx * radialX + dz * radialZ) / depth;
    return lateral ** 2 + longitudinal ** 2 <= 1;
  });
}

function openPalm(hand, forward, weight) {
  const find = name => hand.children.find(node => node.isBone && new RegExp(name + '1$','i').test(node.name));
  const middle = find('middle'), index = find('index'), pinky = find('pinky');
  if (!middle || !index || !pinky || weight <= 0) return;
  const finger = middle.position.clone().normalize();
  const across = index.position.clone().sub(pinky.position).projectOnPlane(finger).normalize();
  const palm = across.clone().cross(finger).normalize();
  const source = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, finger, palm));
  const aim = forward.clone().addScaledVector(up, .20).normalize();
  const side = aim.clone().cross(up).normalize();
  const raised = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, aim, side.clone().cross(aim)));
  orientJoint(hand, raised.multiply(source.invert()), weight);
  const pivot = new THREE.Vector3(), towards = new THREE.Vector3(), spread = new THREE.Vector3();
  const correction = new THREE.Quaternion(), orientation = new THREE.Quaternion();
  for (const [root, angle] of [[find('thumb'), .64], [index, .16], [middle, .01], [find('ring'), -.12], [pinky, -.32]]) {
    spread.copy(aim).addScaledVector(side, angle).normalize();
    let joint = root;
    for (let i = 0; i < 2 && joint; i++) {
      const next = joint.children.find(node => node.isBone);
      if (!next) break;
      joint.getWorldPosition(pivot);
      next.getWorldPosition(towards).sub(pivot).normalize();
      correction.setFromUnitVectors(towards, spread);
      orientJoint(joint, joint.getWorldQuaternion(orientation).premultiply(correction), weight * .70);
      joint = next;
    }
  }
}

export function poseCataclysm(boss, frame) {
  const forward = boss.forward;
  const pitch = new THREE.Vector3(forward.z, 0, -forward.x);
  const side = pitch.clone();
  const r = rigFor(boss);
  if (r.leftArm[0] && r.pelvis && side.dot(r.leftArm[0].getWorldPosition(new THREE.Vector3())
    .sub(r.pelvis.getWorldPosition(new THREE.Vector3()))) < 0) side.negate();
  const world = (lateral, depth, height) => boss.pos.clone().addScaledVector(side, lateral)
    .addScaledVector(forward, depth).addScaledVector(up, height);
  const { blink, release, impact } = CATACLYSM;
  const plant = smoothstep(frame, blink, blink + 13);
  const raise = smoothstep(frame, blink + 1, blink + 32);
  const drive = smoothstep(frame, release - 4, release + 9);
  const recover = smoothstep(frame, impact + 21, impact + 67);
  const stance = plant * (1 - recover);
  const scale = boss.binder ? 1 : boss.scale;
  const s = (lateral, depth, height) => world(lateral * scale, depth * scale, height * scale);
  const pivot = r.pelvis;
  const floor = boss.mesh.group.position.y;
  if (pivot && stance > 0) {
    const hips = pivot.getWorldPosition(new THREE.Vector3());
    boss.mesh.group.position.x += (boss.pos.x - hips.x) * stance;
    boss.mesh.group.position.z += (boss.pos.z - hips.z) * stance;
    boss.mesh.group.position.y -= (.031 + drive * .26) * stance;
  }
  const turn = new THREE.Quaternion();
  if (r.spine) {
    r.spine.getWorldQuaternion(turn);
    turn.premultiply(new THREE.Quaternion().setFromAxisAngle(pitch, lerp(-.08, .53, drive) * stance));
    turn.premultiply(new THREE.Quaternion().setFromAxisAngle(side.clone().cross(up), .16 * raise * (1 - drive)));
    orientJoint(r.spine, turn, stance);
  }
  if (r.head) {
    r.head.getWorldQuaternion(turn);
    turn.premultiply(new THREE.Quaternion().setFromAxisAngle(pitch, -.35 * raise * (1 - drive)));
    orientJoint(r.head, turn, stance);
  }
  poseLimb(r.rightLeg, s(-.43, -.13, .085), forward.clone().addScaledVector(side, -.28), stance);
  poseLimb(r.leftLeg, s(.46, .23, .085), forward.clone().addScaledVector(side, .27), stance);
  boss.binder?.groundPose(boss, 0);
  if (boss.binder) boss.binder.root.position.y += floor - boss.mesh.group.position.y;
  const breathing = .024 * Math.sin((frame - blink) * .16) * raise * (1 - drive);
  const target = s(lerp(.31,.39,drive), lerp(.11,.85,drive), lerp(2.45 + breathing,.44,drive));
  poseLimb(r.leftArm, target, side.clone().setY(-.35), raise * (1 - recover));
  const hand = r.leftArm[2];
  if (hand) openPalm(hand, forward, raise * (1 - drive) * (1 - recover));
  return hand?.getWorldPosition(new THREE.Vector3()) ?? target;
}
