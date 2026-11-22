import * as THREE from 'three';

export const METEOR = { launch: 52, lock: 64, apex: 88, landingFrame: 101, impact: 112, end: 175, height: 3.85, radius: 3.05 };
const { clamp, lerp, smoothstep } = THREE.MathUtils;

// If the timing is edited in the frame-data tools, keep animation, arc and
// warning on the same timeline. The actual impact still occurs at startup.
export function meteorFrame(move, frame) {
  if (frame <= move.startup) {
    const time = frame / Math.max(1, move.startup) * METEOR.landingFrame;
    if (time <= METEOR.apex) return time;
    return lerp(METEOR.apex, METEOR.impact,
      (time - METEOR.apex) / (METEOR.landingFrame - METEOR.apex));
  }
  return lerp(METEOR.impact, METEOR.end,
    clamp((frame - move.startup) / Math.max(1, move.active + move.recovery), 0, 1));
}

export function newMeteorSmash(boss) {
  return {
    origin: boss.pos.clone(), launchDirection: boss.forward,
    target: null, airborne: false, pilot: new THREE.Vector3(), frame: 0, ownerAction: boss.actionSequence,
  };
}

export function updateMeteorSmash(smash, boss, player, frame, face, lock) {
  smash.frame = frame;
  const { origin } = smash;
  if (frame < METEOR.launch) {
    face();
    smash.launchDirection.copy(boss.forward);
    return;
  }
  if (frame > METEOR.impact && smash.target && !smash.airborne) return;
  smash.airborne = frame < METEOR.impact;
  const rise = clamp((frame - METEOR.launch) / (METEOR.apex - METEOR.launch), 0, 1);
  const fall = clamp((frame - METEOR.apex) / (METEOR.impact - METEOR.apex), 0, 1);
  boss.pos.y = METEOR.height * (1 - (1 - rise) ** 2.55) * (1 - fall ** 1.7);
  if (!smash.target && frame >= METEOR.lock) {
    smash.target = player.pos.clone().setY(0);
    const direction = smash.target.clone().sub(origin).setY(0);
    if (direction.lengthSq() < .09) direction.copy(smash.launchDirection);
    direction.normalize();
    smash.land = smash.target.clone().addScaledVector(direction, -1.42);
    boss.yaw = Math.atan2(direction.x, direction.z);
    lock();
  }
  const height = boss.pos.y;
  smash.pilot.copy(origin).addScaledVector(smash.launchDirection, .66 * smoothstep(frame, METEOR.launch, METEOR.lock));
  if (smash.target) smash.pilot.lerp(smash.land, smoothstep(frame, METEOR.lock, METEOR.impact));
  boss.pos.copy(smash.pilot).setY(height);
  if (!smash.airborne) boss.clampToArena();
}
