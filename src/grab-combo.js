import * as THREE from 'three';
import { GRAB_TIMING, grabContactFrame, grabLastContactFrame } from './frame-data.js';

const TOSS_REACTION_FRAME = 27; // 受击底层动画接上抛空时的采样点。
const KICK_BLEND = 7;
const KICK_CONTACT_TIME = 25 / 60; // 从源 FBX 第 34 帧起剪，第 59 帧右脚经过身前。
const GET_UP = { start: 14, blend: 10, struggle: 84, play: 120, settle: 10 };
const GET_UP_GROUNDED = GET_UP.start + GET_UP.blend;
const GET_UP_PLAY = GET_UP_GROUNDED + GET_UP.struggle;
const GET_UP_IDLE = GET_UP_PLAY + GET_UP.play;
const smooth = THREE.MathUtils.smoothstep;
export const GRAB_REACH = { standOff: .60, near: .32, side: .33 };
export const GRAB_HAND_RADIUS = .10;
const GRAB_TORSO_RADIUS = .16;

function grabSideTolerance(boss) {
  return Math.min(GRAB_REACH.side, boss.move.hitbox.radius * boss.scale);
}

export function grabReachBounds(boss, target) {
  const { x, z } = boss.forward;
  const dx = target.x - boss.pos.x, dz = target.z - boss.pos.z;
  const lateral = dx * z - dz * x;
  if (Math.abs(lateral) > grabSideTolerance(boss) || Math.abs(target.y - boss.pos.y) > .25) return null;
  // A cross-body reach loses forward extension as the target moves away from the left shoulder.
  const fromShoulder = lateral - .16;
  const far = .23 + Math.sqrt(Math.max(0, .50 ** 2 - fromShoulder ** 2));
  return { gap: dx * x + dz * z, far };
}

export function inGrabReach(boss, target) {
  const reach = grabReachBounds(boss, target);
  return !!reach && reach.gap >= GRAB_REACH.near && reach.gap <= reach.far;
}

function grabTorso(player, position, yaw = player.yaw) {
  const x = Math.sin(yaw), z = Math.cos(yaw);
  const side = .025 * player.scale, front = .10 * player.scale;
  return new THREE.Vector3(
    position.x + z * side + x * front,
    position.y + player.hurt.height * player.scale * .735,
    position.z - x * side + z * front,
  );
}

// The hand uses the same curve for the pose and the combat contact test.
export function grabHandPosition(boss, player, position = player.pos, yaw = player.yaw, frame = boss.frame) {
  const { move } = boss;
  const forward = boss.forward;
  const dashEnd = move.startup + move.active;
  const hand = grabPoint(boss, forward, .36, .29, 1.29);
  const target = inGrabReach(boss, position)
    ? grabTorso(player, position, yaw).addScaledVector(forward, -.10)
    : grabPoint(boss, forward, .19, .43, 1.38);
  const extension = smooth(frame, dashEnd, grabContactFrame(move));
  const lastContact = grabLastContactFrame(move);
  const retract = 1 - smooth(frame, lastContact, lastContact + 6);
  return hand.lerp(target, extension * retract);
}

export function grabTouchesTorso(boss, hand, player, position, yaw = player.yaw) {
  const forward = boss.forward;
  const torso = grabTorso(player, position, yaw);
  const facing = (torso.x - boss.pos.x) * forward.x + (torso.z - boss.pos.z) * forward.z;
  if (facing <= .18) return false;
  const dy = Math.max(0, Math.abs(hand.y - torso.y) - .14 * player.scale);
  return (hand.x - torso.x) ** 2 + (hand.z - torso.z) ** 2 + dy ** 2
    <= (GRAB_HAND_RADIUS + GRAB_TORSO_RADIUS * player.scale) ** 2;
}

export function grabSweepsTorso(boss, hand, player, sweep, probe) {
  if (sweep.distanceSq() <= 1e-8) return grabTouchesTorso(boss, hand, player, sweep.end);
  const torsoOffset = grabTorso(player, sweep.start).sub(sweep.start);
  sweep.closestPointToPoint(probe.copy(hand).sub(torsoOffset), true, probe);
  return grabTouchesTorso(boss, hand, player, probe);
}

export function grabBossAnimation(boss) {
  if (!boss.grabConnected || !boss.binder?.clipMap.grabKick) return;
  const { kickStart, kick, followThrough } = GRAB_TIMING;
  const elapsed = boss.frame - boss.grabHitFrame;
  if (elapsed < kickStart) return;
  if (elapsed > followThrough) return { key: 'idle', fade: KICK_BLEND / 60 };
  const duration = boss.binder.clips.get(boss.binder.clipMap.grabKick).duration;
  const sampleTime = elapsed <= kick
    ? THREE.MathUtils.mapLinear(elapsed, kickStart, kick, 0, KICK_CONTACT_TIME)
    : THREE.MathUtils.mapLinear(elapsed, kick, followThrough, KICK_CONTACT_TIME, duration);
  return { key: 'grabKick', sampleTime, fade: KICK_BLEND / 60 };
}

export function grabRecoveryFrames(sequence) {
  return sequence.getUp ? GET_UP_IDLE + GET_UP.settle : GRAB_TIMING.wallStun;
}

export function grabGetUpProgress(sequence) {
  const end = grabRecoveryFrames(sequence) - 1;
  const turnFrames = sequence.getUp ? Math.round(GET_UP.play * 0.24) + GET_UP.settle : 10;
  return smooth(sequence.age, end - turnFrames, end);
}

function grabDeathClip(player) {
  const binder = player.binder;
  if (player.hp <= 0 && binder) return binder.clips.get(binder.clipMap.dead);
}

function getUpClipProgress(age) {
  return THREE.MathUtils.clamp((age - GET_UP_PLAY) / (GET_UP.play - 1), 0, 1);
}

export function grabWallCameraFocus(sequence) {
  return sequence.getUp
    ? 1 - smooth(getUpClipProgress(sequence.age), 0.37, 0.88)
    : 1 - grabGetUpProgress(sequence);
}

export function grabPlayerAnimation(player, sequence, logicFrame) {
  if (sequence.phase === 'wall') {
    const { age, getUp } = sequence;
    if (getUp && age >= GET_UP_IDLE) return { key: 'idle', fade: GET_UP.settle / 60 };
    if (getUp && age >= GET_UP.start) {
      const duration = player.binder.clips.get(player.binder.clipMap.grabGetUp).duration;
      const progress = getUpClipProgress(age);
      return { key: 'grabGetUp', sampleTime: duration * progress, fade: GET_UP.blend / 60 };
    }
    const death = grabDeathClip(player);
    if (death && age >= GET_UP.start) {
      // 撞墙已完成倒地，直接过渡到死亡动画的最终姿势。
      return { key: 'dead', sampleTime: death.duration, fade: GET_UP.blend / 60 };
    }
    if (!getUp && player.hp > 0 && grabGetUpProgress(sequence) > 0) return { key: 'idle' };
  }
  const elapsed = logicFrame - sequence.startFrame;
  const { pull, toss } = GRAB_TIMING;
  const reactionFrame = elapsed <= pull ? elapsed : elapsed <= toss
    ? THREE.MathUtils.mapLinear(elapsed, pull, toss, pull, TOSS_REACTION_FRAME)
    : TOSS_REACTION_FRAME + elapsed - toss;
  return { sampleTime: reactionFrame / 60 };
}

export function clampToWall(point, radius) {
  const distance = Math.hypot(point.x, point.z);
  if (distance > radius) {
    point.x *= radius / distance;
    point.z *= radius / distance;
  }
  return point;
}

// Find the contact along the launch ray, including when it starts at the rail.
export function launchContact(origin, direction, radius) {
  const projection = origin.x * direction.x + origin.z * direction.z;
  const remaining = radius ** 2 - origin.x ** 2 - origin.z ** 2;
  const distance = Math.max(0, Math.sqrt(Math.max(0, projection ** 2 + remaining)) - projection);
  return { distance, point: origin.clone().addScaledVector(direction, distance) };
}

export function grabPoint(boss, direction, side, front, height) {
  return new THREE.Vector3(
    boss.pos.x + direction.z * side + direction.x * front,
    boss.pos.y + height,
    boss.pos.z - direction.x * side + direction.z * front,
  );
}

const rigCache = new WeakMap();
const adjusted = new Map();
const point = new THREE.Vector3();
const orientation = new THREE.Quaternion();
const delta = new THREE.Quaternion();

export function restoreGrabJoints() {
  for (const [joint, quaternion] of adjusted) joint.quaternion.copy(quaternion);
  adjusted.clear();
}

export function rigFor(actor) {
  const source = actor.binder?.root ?? actor.mesh.group;
  if (rigCache.has(source)) return rigCache.get(source);
  const bones = new Map();
  source.traverse(node => {
    if (node.isBone) bones.set(node.name.toLowerCase().replace(/^mixamorig[:_]?/, ''), node);
  });
  const get = (standard, alternate) => bones.get(standard) ?? bones.get(alternate);
  const mesh = actor.mesh;
  const rig = actor.binder ? {
    spine: get('spine', 'spine_01'),
    chest: get('spine2', 'spine_03') ?? get('spine1', 'spine_02'),
    head: get('head', 'neck_02'),
    pelvis: get('hips', 'pelvis'),
    toes: [get('lefttoebase', 'l_toebase'), get('righttoebase', 'r_toebase')],
    leftArm: [get('leftarm', 'l_upperarm'), get('leftforearm', 'l_forearm'), get('lefthand', 'l_hand')],
    rightLeg: [get('rightupleg', 'r_thigh'), get('rightleg', 'r_calf'), get('rightfoot', 'r_foot')],
    leftLeg: [get('leftupleg', 'l_thigh'), get('leftleg', 'l_calf'), get('leftfoot', 'l_foot')],
  } : {
    spine: mesh.spine,
    chest: mesh.chest,
    head: mesh.head,
    pelvis: mesh.hips,
    leftArm: [mesh.armL, mesh.foreL, mesh.handL],
    rightLeg: [mesh.legR, mesh.shinR, mesh.footR],
    leftLeg: [mesh.legL, mesh.shinL, mesh.footL],
  };
  rigCache.set(source, rig);
  return rig;
}

function centerPelvis(actor, pelvis, weight = 1) {
  if (!pelvis || weight <= 0) return;
  pelvis.getWorldPosition(point);
  // Control the model's horizontal position while retaining the animation's height.
  actor.mesh.group.position.x += (actor.pos.x - point.x) * weight;
  actor.mesh.group.position.z += (actor.pos.z - point.z) * weight;
}

function worldRotate(joint, rotation, weight) {
  if (!adjusted.has(joint)) adjusted.set(joint, joint.quaternion.clone());
  joint.parent.getWorldQuaternion(orientation);
  const localDelta = orientation.clone().invert().multiply(rotation).multiply(orientation);
  joint.quaternion.slerp(localDelta.multiply(joint.quaternion), weight);
}

function aimAt(joint, child, target, weight) {
  const origin = joint.getWorldPosition(new THREE.Vector3());
  const from = child.getWorldPosition(point).sub(origin).normalize();
  const to = target.clone().sub(origin).normalize();
  if (from.lengthSq() > 0 && to.lengthSq() > 0) {
    worldRotate(joint, delta.setFromUnitVectors(from, to), weight);
  }
}

export function orientJoint(joint, worldRotation, weight) {
  if (weight <= 0) return;
  joint.getWorldQuaternion(orientation);
  delta.copy(orientation).invert().premultiply(worldRotation);
  worldRotate(joint, delta, weight);
}

export function setJointLocalRotation(joint, rotation) {
  if (!adjusted.has(joint)) adjusted.set(joint, joint.quaternion.clone());
  joint.quaternion.copy(rotation);
}

// Align the index side of the fist with the guard, and the knuckles with the
// forearm. Resolve axial roll at the forearm before bending the wrist.
export function swordGripPose(hand) {
  const finger = name => hand.children.find(n => n.name.toLowerCase().endsWith('hand' + name + '1'));
  const index = finger('index'), pinky = finger('pinky'), middle = finger('middle');
  if (!index || !pinky || !middle || !hand.parent?.isBone) return null;
  const thumb = index.position.clone().sub(pinky.position).normalize();
  const along = middle.position.clone().projectOnPlane(thumb).normalize();
  const cross = new THREE.Vector3(), basis = new THREE.Matrix4();
  const local = new THREE.Quaternion().setFromRotationMatrix(
    basis.makeBasis(thumb, along, cross.crossVectors(thumb, along))
  ).invert();
  const fore = hand.parent;
  const axis = new THREE.Vector3(), fingers = new THREE.Vector3(), old = new THREE.Vector3();
  const desired = new THREE.Quaternion(), twist = new THREE.Quaternion(), q = new THREE.Quaternion();
  let previousRoll = 0;
  return (towardGuard, weight) => {
    if (weight <= 0) return;
    hand.getWorldPosition(axis).sub(fore.getWorldPosition(old)).normalize();
    fingers.copy(axis).projectOnPlane(towardGuard);
    if (fingers.lengthSq() < 1e-5) return;
    fingers.normalize();
    desired.setFromRotationMatrix(basis.makeBasis(towardGuard, fingers,
      cross.crossVectors(towardGuard, fingers))).multiply(local);
    old.copy(thumb).applyQuaternion(hand.getWorldQuaternion(q)).projectOnPlane(axis);
    fingers.copy(towardGuard).projectOnPlane(axis);
    const raw = Math.atan2(axis.dot(cross.crossVectors(old, fingers)), old.dot(fingers));
    const delta = THREE.MathUtils.euclideanModulo(raw - previousRoll + Math.PI, 2 * Math.PI) - Math.PI;
    previousRoll = THREE.MathUtils.clamp(previousRoll + delta, -Math.PI, Math.PI);
    twist.setFromAxisAngle(axis, THREE.MathUtils.clamp(previousRoll, -1.3, 1.3));
    orientJoint(fore, fore.getWorldQuaternion(q).premultiply(twist), weight);
    orientJoint(hand, desired, weight);
  };
}

export function poseLimb(limb, target, bend, weight) {
  const [upper, lower, tip] = limb;
  if (!upper || !lower || !tip || weight <= 0) return;
  const start = upper.getWorldPosition(new THREE.Vector3());
  const middle = lower.getWorldPosition(new THREE.Vector3());
  const end = tip.getWorldPosition(new THREE.Vector3());
  const a = start.distanceTo(middle), b = middle.distanceTo(end);
  if (Math.min(a,b) < 1e-4) return;

  const direction = target.clone().sub(start);
  const reach = THREE.MathUtils.clamp(direction.length(), Math.abs(a-b) + 0.001, a+b-0.001);
  if (direction.lengthSq() < 1e-8) return;
  direction.normalize();
  bend.addScaledVector(direction, -bend.dot(direction)).normalize();
  const along = (a*a - b*b + reach*reach) / (2*reach);
  const sideways = Math.sqrt(Math.max(0, a*a - along*along));
  middle.copy(start).addScaledVector(direction,along).addScaledVector(bend,sideways);
  end.copy(start).addScaledVector(direction, reach);
  aimAt(upper, lower, middle, weight);
  aimAt(lower, tip, end, weight);
}

function playerGripTarget(player, forward) {
  const chest = rigFor(player).chest;
  const target = chest
    ? chest.getWorldPosition(new THREE.Vector3())
    : player.mesh.group.position.clone().addScaledVector(THREE.Object3D.DEFAULT_UP, 1.35);
  return target.addScaledVector(forward, -.10);
}

export function poseBossGrab(boss, player, sequence) {
  if (!boss.move?.grab) return;
  const rig = rigFor(boss);
  const { frame, move } = boss;
  const forward = boss.forward;
  const side = new THREE.Vector3(forward.z, 0, -forward.x);
  const dashEnd = move.startup + move.active;
  const contactFrame = grabContactFrame(move);
  const elapsed = frame - (boss.grabHitFrame ?? contactFrame);
  const smooth = THREE.MathUtils.smoothstep;
  const visualScale = boss.binder ? 1 : boss.scale;
  const world = (x, z, y) => grabPoint(boss, forward, x * visualScale, z * visualScale, y * visualScale);
  const ready = smooth(frame, 0, move.startup * 0.78);
  const missed = boss.grabConnected ? 0 : smooth(frame - grabLastContactFrame(move), 0, GRAB_TIMING.missRecovery);
  const settle = smooth(elapsed, GRAB_TIMING.followThrough, GRAB_TIMING.recover);
  const upperWeight = ready * (1 - missed) * (1 - settle);
  centerPelvis(boss, rig.pelvis, upperWeight);
  const rush = smooth(frame, move.startup - 6, move.startup + 2) * (1 - smooth(elapsed, 0, 10));
  const authoredKick = boss.binder?.clipMap.grabKick;
  const gripWeight = upperWeight * (1 - (authoredKick && boss.grabConnected
    ? smooth(elapsed, GRAB_TIMING.kickStart, GRAB_TIMING.kickStart + KICK_BLEND) : 0));
  const kick = authoredKick ? 0 : smooth(elapsed, GRAB_TIMING.kick - 10, GRAB_TIMING.kick)
    * (1 - smooth(elapsed, GRAB_TIMING.kick + 2, GRAB_TIMING.followThrough));

  if (rig.spine) {
    const lean = (0.17 * rush - (boss.grabConnected ? 0.18 * kick : 0)) * upperWeight;
    worldRotate(rig.spine, delta.setFromAxisAngle(side, lean), 1);
  }

  const followStep = Math.sin(smooth(frame, dashEnd, contactFrame) * Math.PI)
    * smooth(boss.grabStep?.travelled ?? 0, .012, .28);
  if ((!boss.grabConnected && frame >= move.startup - 5) || followStep > 1e-4) {
    const rushStride = Math.sin(smooth(frame, move.startup - 5, dashEnd + 1) * Math.PI);
    const stride = Math.max(rushStride, followStep);
    poseLimb(rig.rightLeg, world(-0.16, 0.50 * stride, 0.10 + 0.17 * stride),
      forward.clone(), upperWeight * stride);
    poseLimb(rig.leftLeg, world(0.16, -0.27 * stride, 0.10), forward.clone(), upperWeight * stride);
  } else if (boss.grabConnected) {
    const target = world(-0.12, 0.18 + 0.77 * kick, 0.12 + 1.03 * kick);
    poseLimb(rig.rightLeg, target, forward.clone().setY(0.55), kick);
  }
  boss.binder?.groundPose(boss, 0);

  const windup = smooth(frame, move.startup - 8, dashEnd);
  const hand = !boss.grabConnected && frame >= dashEnd && move.active > 0
    ? grabHandPosition(boss, player)
    : world(0.36, 0.12 + 0.17 * windup, 0.92 + 0.37 * windup);
  if (boss.grabConnected && rig.chest) {
    const lift = smooth(elapsed, GRAB_TIMING.pull, GRAB_TIMING.lift);
    const grip = rig.chest.getWorldPosition(new THREE.Vector3())
      .addScaledVector(forward, 0.49 * visualScale)
      .addScaledVector(side, 0.19 * visualScale);
    grip.y += (0.05 + 0.25 * lift) * visualScale;
    if (elapsed <= GRAB_TIMING.toss) {
      hand.copy(grip);
    } else {
      const release = 1 - smooth(elapsed, GRAB_TIMING.toss, GRAB_TIMING.toss + 11);
      grip.y += 0.20 * visualScale * smooth(elapsed, GRAB_TIMING.toss, GRAB_TIMING.toss + 5);
      hand.lerp(grip, release);
    }
  }
  if (boss.grabConnected && (sequence?.phase === 'held' || sequence?.phase === 'toss')) {
    const hold = 1 - smooth(elapsed, GRAB_TIMING.toss, GRAB_TIMING.toss + 7);
    hand.lerp(playerGripTarget(player, forward), hold);
  }
  poseLimb(rig.leftArm, hand, side.clone().setY(-0.6), gripWeight);
}

function flightTilt(age) {
  return -0.36 - 0.86 * smooth(age, 0, 12);
}

function foldOnKick(rig, sequence) {
  const inFlight = sequence.phase === 'flight';
  const atWall = sequence.phase === 'wall' && sequence.flightFrames !== undefined;
  if ((!inFlight && !atWall) || !rig.pelvis || !rig.spine || !rig.chest) return;
  const age = atWall ? sequence.flightFrames + sequence.age : sequence.age;
  const impulse = (0.76 + 0.24 * smooth(age, 0, 3)) * (1 - smooth(age, 4, 22));
  const weight = impulse * (atWall ? 1 - smooth(sequence.age, 1, 9) : 1);
  if (weight <= 0) return;

  // 腰部先沿击飞方向运动，胸和脚稍滞后，合在一起形成 V 形。骨长由 IK 保持。
  const back = sequence.direction.clone().negate();
  const side = new THREE.Vector3(back.z, 0, -back.x);
  const chest = rig.spine.getWorldPosition(new THREE.Vector3()).addScaledVector(back, 0.62);
  chest.y += 0.43;
  aimAt(rig.spine, rig.chest, chest, weight);
  const hips = rig.pelvis.getWorldPosition(new THREE.Vector3());
  const left = hips.clone().addScaledVector(back, 0.69).addScaledVector(side, 0.23);
  const right = hips.clone().addScaledVector(back, 0.79).addScaledVector(side, -0.21);
  left.y += 0.22;
  right.y += 0.11;
  poseLimb(rig.leftLeg, left, back.clone().setY(1.6), weight);
  poseLimb(rig.rightLeg, right, back.clone().setY(1.6), weight);
}

function poseHeldStruggle(rig, sequence) {
  if (sequence.phase !== 'held') return;
  const { age, direction } = sequence;
  const { lift, toss } = GRAB_TIMING;
  const effort = smooth(age, lift - 8, lift + 4) * (1 - smooth(age, toss - 12, toss));
  if (effort <= 0) return;

  const sway = Math.sin((age - lift) * Math.PI / 14);
  const towardBoss = direction.clone().negate();
  const side = new THREE.Vector3(direction.z, 0, -direction.x);
  if (rig.spine) {
    worldRotate(rig.spine, delta.setFromAxisAngle(direction, 0.32 * sway * effort), 1);
  }

  // 双腿交替收起，空着的手去拉握住胸前的手；胸口最后再对到 Boss 手骨。
  for (const [leg, curl] of [[rig.leftLeg, (1 + sway) / 2], [rig.rightLeg, (1 - sway) / 2]]) {
    if (!leg[2]) continue;
    const target = leg[2].getWorldPosition(new THREE.Vector3()).addScaledVector(towardBoss, 0.27);
    target.y += 0.31;
    poseLimb(leg, target, towardBoss.clone().setY(0.38), effort * (0.12 + 0.88 * curl));
  }
  if (rig.chest) {
    const target = rig.chest.getWorldPosition(new THREE.Vector3()).addScaledVector(side, -0.13);
    target.y += 0.05;
    poseLimb(rig.leftArm, target, side.clone().negate().setY(-0.45), effort * 0.82);
  }
}

function poseGroundStruggle(rig, sequence) {
  if (sequence.phase !== 'wall' || !sequence.getUp) return;
  const progress = (sequence.age - GET_UP_GROUNDED) / GET_UP.struggle;
  if (progress <= 0 || progress >= 1) return;

  const forward = sequence.direction;
  const side = new THREE.Vector3(forward.z, 0, -forward.x);
  const knee = smooth(progress, 0, 0.29) * (1 - smooth(progress, 0.57, 1));
  const brace = smooth(progress, 0.12, 0.42) * (1 - smooth(progress, 0.49, 0.88));
  const palm = smooth(progress, 0, 0.26) * (1 - smooth(progress, 0.64, 1));

  // 先屈膝、用左手试着撑地，肩膀稍抬后回落，再由起身动画接续。
  const foot = rig.rightLeg[2];
  if (foot) {
    const target = foot.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 0.34);
    target.y = Math.max(0.10, target.y + 0.06);
    poseLimb(rig.rightLeg, target, new THREE.Vector3(0, 1, 0), knee);
  }
  if (rig.spine) {
    worldRotate(rig.spine, delta.setFromAxisAngle(side, -0.52 * brace), 1);
  }
  const hand = rig.leftArm[2];
  if (hand) {
    const target = hand.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 0.16);
    target.y = 0.07;
    poseLimb(rig.leftArm, target, side.clone().negate().setY(0.7), palm);
  }
}

export function poseGrabVictim(player, sequence) {
  if (!sequence) return;
  const group = player.mesh.group;
  const smooth = THREE.MathUtils.smoothstep;
  let tilt;
  let lower = 0;
  let centerWeight = 1;
  let groundWeight = 0;
  let groundedAnimation = false;
  if (sequence.phase === 'held') {
    tilt = 0.18 * smooth(sequence.age, GRAB_TIMING.pull, GRAB_TIMING.lift);
    centerWeight = 0;
  } else if (sequence.phase === 'toss') {
    tilt = THREE.MathUtils.lerp(0.18, -0.36, smooth(sequence.age, GRAB_TIMING.toss, GRAB_TIMING.kick));
    centerWeight = smooth(sequence.age, GRAB_TIMING.toss, GRAB_TIMING.toss + 10);
  } else if (sequence.phase === 'flight') {
    tilt = flightTilt(sequence.age);
  } else {
    const { age, getUp } = sequence;
    const death = grabDeathClip(player);
    groundedAnimation = getUp || !!death;
    const impact = smooth(age, 0, getUp ? 11 : 9);
    const key = getUp ? 'grabGetUp' : 'dead';
    const binder = player.binder;
    const playing = groundedAnimation && binder.currentName === binder.clipMap[key];
    const blend = playing ? binder.current.getEffectiveWeight() : 0;
    const animated = age >= GET_UP_IDLE ? 1 : blend;
    const fall = groundedAnimation ? 1 - animated : 1 - grabGetUpProgress(sequence);
    const landingTilt = groundedAnimation ? -1.60 : -1.25;
    tilt = THREE.MathUtils.lerp(flightTilt(sequence.flightFrames ?? 0), landingTilt, impact) * fall;
    lower = 0.72 * impact * fall;
    const settleFrame = getUp ? GET_UP_PLAY : GET_UP_GROUNDED;
    groundWeight = groundedAnimation ? impact * (1 - smooth(age, settleFrame, settleFrame + 6)) : 0;
    centerWeight = getUp ? 1 - smooth(age, GET_UP_IDLE, grabRecoveryFrames(sequence) - 1) : fall;
  }
  // Keep the rotation pivot around the waist while the combat position stays at the feet.
  const waist = 0.94;
  point.set(0, waist, 0).applyQuaternion(group.quaternion);
  group.position.add(point);
  group.rotateX(tilt);
  point.set(0, waist, 0).applyQuaternion(group.quaternion);
  group.position.sub(point);
  group.position.y -= lower;
  const rig = rigFor(player);
  centerPelvis(player, rig.pelvis, centerWeight);
  if (groundWeight > 0 && rig.pelvis) {
    rig.pelvis.getWorldPosition(point);
    group.position.y += (0.15 + player.pos.y - point.y) * groundWeight;
  }
  foldOnKick(rig, sequence);
  poseHeldStruggle(rig, sequence);
  poseGroundStruggle(rig, sequence);
  if (groundWeight > 0) {
    let lowest = 0.012;
    for (const toe of rig.toes) {
      if (toe) lowest = Math.min(lowest, toe.getWorldPosition(point).y);
    }
    group.position.y += 0.012 - lowest;
  }
  if (sequence.phase === 'wall' && !groundedAnimation) group.position.y = Math.max(0, group.position.y);
}
