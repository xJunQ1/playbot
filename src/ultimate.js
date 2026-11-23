import * as THREE from 'three';

const SOURCE_END = 438;
const COMBO_TIMING = [[115, 115], [152, 192], [198, 265], [225, 302]];
const RETIME_OFFSET = 302 - 225;
export const ULTIMATE_STAGGER = 53;
export const FINISHER = { start: 329 - RETIME_OFFSET, hit: 338 - RETIME_OFFSET, end: 353 - RETIME_OFFSET, damage: 370, distance: 15.8, width: 1.10, duration: 37, ease: 1.18, fireTail: 72 };
export const ULTIMATE_CAMERA_RETURN = { start: FINISHER.hit + 1, end: FINISHER.hit + 14 };
export const ULTIMATE_CANCEL_FROM = FINISHER.end + 6;
export const ULTIMATE_END = FINISHER.end + 14;

// The original blade strokes are sampled at their contact poses.
export const ULTIMATE_CUTS = [
  { start: 16, hit: 22, end: 28, reach: 3.1, damage: 170 },
  { start: 31, hit: 35, end: 40, reach: 2.8, damage: 165 },
  { start: 52, hit: 60, end: 67, reach: 3.2, damage: 190 },
  { start: 83, hit: 90, end: 98, reach: 3.2, damage: 220 },
  { start: 100, hit: 106, end: 115, reach: 3.5, damage: 235 },
  { start: 220, hit: 225, end: 314 - RETIME_OFFSET, reach: 3.3, damage: 120, poise: 4 },
  FINISHER,
];

// These are the forward extensions of the right and left kicks, in that order.
export const ULTIMATE_KICKS = [
  { hit: COMBO_TIMING[1][0], reach: 3.5, damage: 65, poise: 3 },
  { hit: COMBO_TIMING[2][0], reach: 3.5, damage: 65, poise: 3 },
];

export function ultimateSourceFrame(frame) {
  if (frame <= COMBO_TIMING[0][0]) return frame;
  if (frame >= COMBO_TIMING.at(-1)[0]) return frame + RETIME_OFFSET;
  const next = COMBO_TIMING.findIndex(([time]) => time > frame);
  const [a, start] = COMBO_TIMING[next - 1];
  const [b, end] = COMBO_TIMING[next];
  const slope = (end - start) / (b - a);
  const tangent = ([t0, p0], [t1, p1]) => {
    const adjacent = (p1 - p0) / (t1 - t0);
    return 2 * slope * adjacent / (slope + adjacent);
  };
  const inRate = next === 1 ? 1 : tangent(COMBO_TIMING[next - 2], COMBO_TIMING[next - 1]);
  const outRate = next === COMBO_TIMING.length - 1 ? 1 : tangent(COMBO_TIMING[next], COMBO_TIMING[next + 1]);
  const t = (frame - a) / (b - a);
  return THREE.MathUtils.lerp(start, end, t * t * (3 - 2 * t))
    + (inRate * (1 - t) - outRate * t) * (b - a) * t * (1 - t);
}

export async function loadNativeClip(binder, url, key, duration) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Combat animation request failed (${response.status})`);
  const data = await response.json();
  const clip = THREE.AnimationClip.parse(data);
  if (!clip.validate() || Math.abs(clip.duration - duration) > .0001) {
    throw new Error('Invalid combat animation timing or transforms');
  }
  binder.clips.set(clip.name, clip);
  binder.clipMap[key] = clip.name;
  return data;
}

export async function loadPlayerUltimate(binder) {
  const data = await loadNativeClip(binder, 'assets/anims/PlayerUltimateSource.json', 'ultimate', SOURCE_END / 60);
  if (data.root?.length !== (SOURCE_END + 1) * 2 || data.release?.length !== 2 || data.waveStart?.length !== 2) {
    throw new Error('Invalid ultimate root motion');
  }
  return { path: data.root, release: data.release, waveStart: data.waveStart };
}

export function createUltimateCast(player, boss, viewYaw, viewPitch, motion) {
  const forward = boss.pos.clone().sub(player.pos).setY(0);
  if (forward.lengthSq() < .0001) forward.copy(player.forward);
  forward.normalize();
  return {
    forward, side: new THREE.Vector3(forward.z, 0, -forward.x),
    viewYaw, viewPitch, motion, previous: 0, hits: 0, wave: null, cameraReturned: false,
  };
}

export function ultimateStep(cast, frame, into) {
  if (!cast.motion) {
    const slip = THREE.MathUtils.smoothstep(frame, 8, 110) - THREE.MathUtils.smoothstep(frame - 1, 8, 110);
    return into.copy(cast.forward).multiplyScalar(slip);
  }
  const track = cast.motion.path;
  const current = ultimateSourceFrame(frame);
  const prior = ultimateSourceFrame(frame - 1);
  const offset = (sourceFrame, axis) => {
    const sample = Math.floor(sourceFrame);
    const i = sample * 2 + axis;
    return THREE.MathUtils.lerp(track[i], track[i + 2] ?? track[i], sourceFrame - sample);
  };
  return into.copy(cast.forward).multiplyScalar(offset(current, 1) - offset(prior, 1))
    .addScaledVector(cast.side, offset(current, 0) - offset(prior, 0));
}

export function ultimateFallbackPose(binder, frame) {
  const i = ULTIMATE_CUTS.findIndex(cut => frame >= cut.start - 7 && frame < cut.end + 8);
  const cut = ULTIMATE_CUTS[i];
  if (!cut) return { key: 'idle', fade: .11, groundFeet: true };
  const key = 'p_light' + (i % 4 + 1);
  const clip = binder.clips.get(binder.clipMap[key]);
  if (!clip) return { key: 'idle', groundFeet: true };
  const p = THREE.MathUtils.smoothstep(frame, cut.start - 7, cut.end + 7);
  return { key, sampleTime: p * clip.duration, fade: .105, groundFeet: true };
}

export function startFinisher(cast, start, target) {
  const { motion, side, forward } = cast;
  const direction = motion ? forward.clone().multiplyScalar(motion.release[1])
    .addScaledVector(side, motion.release[0]).normalize() : forward.clone();
  const origin = start.clone();
  const aim = target?.clone().sub(start).setY(0);
  if (aim && aim.lengthSq() > .0001) direction.copy(aim).normalize();
  const lead = motion ? motion.waveStart[1] * .72 : .9;
  // Keep the launch point behind the target, even at point-blank range.
  origin.addScaledVector(direction, aim ? Math.min(lead, Math.max(0, aim.length() - .95)) : lead);
  if (motion) {
    const tangent = new THREE.Vector3(direction.z, 0, -direction.x);
    origin.addScaledVector(tangent, motion.waveStart[0] * .72);
  }
  if (aim && aim.copy(target).sub(origin).setY(0).lengthSq() > .0001) direction.copy(aim).normalize();
  cast.wave = { origin, direction, struck: false, contact: null };
}

export function finisherRun(frame) {
  const t = THREE.MathUtils.clamp((frame - FINISHER.hit) / FINISHER.duration, 0, 1);
  return FINISHER.distance * (1 - (1 - t) ** FINISHER.ease);
}
