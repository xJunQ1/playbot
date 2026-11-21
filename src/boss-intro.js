import * as THREE from 'three';
import { orientJoint, poseLimb } from './grab-combo.js';
import { createMeteorLanding } from './vfx/meteor-landing.js';

const IMPACT = 0.64;
const RISE = IMPACT + 0.83;
const STANDING = RISE + 1.30;
const RECOVER = STANDING + 0.28;
const HANDOFF = RECOVER + 0.82;
const END = HANDOFF + 2;
const UP = new THREE.Vector3(0, 1, 0);
const { smoothstep, lerp, degToRad, radToDeg } = THREE.MathUtils;

function altitude(age) {
  const t = Math.min(1, age / IMPACT);
  return 11.5 * (1 - 0.24*t - 0.76*t*t);
}

export function tintBossFace(root) {
  // Skin and white hair share an atlas. Head weights and warm texels together
  // isolate the skin while keeping its painted detail and the stage lighting.
  root.traverse(mesh => {
    if (!mesh.isSkinnedMesh || !mesh.material.isMeshStandardMaterial || !mesh.material.map) return;
    const head = mesh.skeleton.bones.findIndex(bone => /^(mixamorig[:_]?)?head$/i.test(bone.name));
    if (head < 0) return;
    const material = mesh.material.clone();
    material.onBeforeCompile = shader => {
      shader.uniforms.bossHeadIndex = { value: head };
      shader.vertexShader = 'uniform float bossHeadIndex;\nvarying float vBossHeadWeight;\n'
        + shader.vertexShader.replace('#include <skinning_vertex>', `
          #include <skinning_vertex>
          vBossHeadWeight = dot(skinWeight, 1.0 - step(vec4(0.5), abs(skinIndex - bossHeadIndex)));
        `);
      shader.fragmentShader = 'varying float vBossHeadWeight;\n' + shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `float skin = smoothstep(0.065, 0.115, diffuseColor.r - diffuseColor.b)
          * smoothstep(0.40, 0.72, diffuseColor.g) * smoothstep(0.25, 0.85, vBossHeadWeight);
        outgoingLight *= mix(vec3(1.0), vec3(0.68, 0.56, 0.43), skin);
        #include <opaque_fragment>`
      );
    };
    mesh.material = material;
  });
}
export function createBossIntro(scene, boss, camera, impactSurface) {
  const { binder, weapon } = boss;
  if (!binder || !weapon?.parent) return null;
  const bones = new Map();
  binder.root.traverse(node => {
    if (node.isBone) bones.set(node.name.toLowerCase().replace(/^mixamorig[:_]?/, ''), node);
  });
  const bone = (name, alias) => bones.get(name) ?? bones.get(alias);
  const arm = [bone('rightarm', 'r_upperarm'), bone('rightforearm', 'r_forearm'), weapon.parent];
  const freeArm = [bone('leftarm', 'l_upperarm'), bone('leftforearm', 'l_forearm'), bone('lefthand', 'l_hand')];
  const legs = [
    [bone('rightupleg', 'r_thigh'), bone('rightleg', 'r_calf'), bone('rightfoot', 'r_foot')],
    [bone('leftupleg', 'l_thigh'), bone('leftleg', 'l_calf'), bone('leftfoot', 'l_foot')],
  ];
  const pelvis = bone('hips', 'pelvis');
  const spine = bones.get('spine');
  const head = bones.get('head');
  if (![...arm, ...freeArm, ...legs.flat()].every(Boolean)) return null;

  boss.syncMesh();
  binder.update(boss, 0);
  const pos = joint => joint.getWorldPosition(new THREE.Vector3());
  const reach = pos(arm[0]).distanceTo(pos(arm[1])) + pos(arm[1]).distanceTo(pos(arm[2]));
  const forward = boss.forward;
  const side = new THREE.Vector3(forward.z,0,-forward.x);
  if (side.dot(pos(arm[0]).sub(pos(freeArm[0]))) < 0) side.negate();
  const turn = Math.sign(new THREE.Vector3().crossVectors(side, forward).y);
  const pitchAxis = new THREE.Vector3().crossVectors(UP, forward).normalize();
  const feet = legs.map(leg => ({
    leg, rest: pos(leg[2]), rotation: leg[2].getWorldQuaternion(new THREE.Quaternion()),
  }));
  const hip = pos(legs[0][0]);
  const thigh = hip.distanceTo(pos(legs[0][1]));
  const shin = pos(legs[0][1]).distanceTo(feet[0].rest);
  // Knee contact is scaled to this rig. The near ankle folds behind the knee.
  const kneeY = 0.115;
  const compression = hip.y - boss.pos.y - thigh*0.91 - kneeY;
  const backAnkle = hip.clone().addScaledVector(forward, thigh*0.41 - shin*0.98);
  backAnkle.y = feet[0].rest.y + 0.08;
  const frontAnkle = feet[1].rest.clone().addScaledVector(forward, thigh*0.83);

  const target = new THREE.Vector3(), bend = new THREE.Vector3();
  const worldRotation = new THREE.Quaternion(), rotation = new THREE.Quaternion();
  const gamePosition = camera.position.clone(), gameRotation = camera.quaternion.clone();
  const cameraTarget = new THREE.Vector3();
  const landing = createMeteorLanding(scene, boss.pos, impactSurface);
  const modelVisible = binder.root.visible;
  binder.root.visible = false;
  let age = 0;

  return {
    get age() { return age; },
    get finished() { return age >= END; },
    get landed() { return age >= IMPACT; },
    advance(dt) {
      age = Math.min(END, age + dt);
    },
    pose(dt) {
      const landingTime = age - IMPACT;
      landing.update(age,landingTime,altitude(age),camera,1-smoothstep(age,HANDOFF+0.15,END-0.18));
      binder.root.visible = modelVisible && landingTime >= 0;
      if (landingTime < 0) return;
      binder.update(boss,dt);
      const rise = smoothstep(age, RISE, STANDING);
      const kneel = (0.69 + 0.31 * smoothstep(age, IMPACT - 0.10, IMPACT + 0.065)) * (1 - rise);
      const control = 1 - smoothstep(age, RECOVER, HANDOFF);
      const rearStep = smoothstep(age, RISE + 0.10, STANDING - 0.12);
      const reset = smoothstep(age, RECOVER, HANDOFF - 0.08);
      const hipYaw = -0.20 * rise * turn;
      const chestYaw = 0.09 * rise * turn;
      boss.mesh.group.position.addScaledVector(side, thigh * 0.10 * rise * control);
      boss.mesh.group.position.y -= compression * kneel + thigh * 0.15 * rise * control;

      if (control > 0 && pelvis) {
        pelvis.getWorldQuaternion(worldRotation);
        rotation.setFromAxisAngle(UP, hipYaw);
        orientJoint(pelvis, worldRotation.premultiply(rotation), control);
      }
      if (control > 0 && spine) {
        spine.getWorldQuaternion(worldRotation);
        rotation.setFromAxisAngle(UP, chestYaw);
        worldRotation.premultiply(rotation);
        rotation.setFromAxisAngle(pitchAxis, 0.37 * kneel - 0.08 * rise);
        orientJoint(spine, worldRotation.premultiply(rotation), control);
        if (head) {
          head.getWorldQuaternion(worldRotation);
          rotation.setFromAxisAngle(UP, -0.73 * (hipYaw + chestYaw));
          worldRotation.premultiply(rotation);
          rotation.setFromAxisAngle(pitchAxis, -0.08 * rise);
          orientJoint(head, worldRotation.premultiply(rotation), control);
        }
      }
      feet.forEach(({ leg, rest, rotation: restRotation }, i) => {
        if (control <= 0) return;
        if (i === 0) {
          target.copy(rest).lerp(backAnkle, 1 - rearStep)
            .addScaledVector(side, thigh * 0.34 * rearStep)
            .addScaledVector(forward, -thigh * 0.16 * rearStep);
          target.y += thigh * 0.27 * Math.sin(Math.PI * rearStep);
        } else {
          target.copy(frontAnkle);
        }
        target.lerp(rest, reset);
        target.y += thigh * 0.20 * Math.sin(Math.PI * reset);
        const footWeight = 1 - smoothstep(age, HANDOFF - 0.08, HANDOFF);
        const toeYaw = (i === 0 ? -0.16 * rearStep : 0) * turn * (1 - reset);
        poseLimb(leg, target, bend.copy(forward).applyAxisAngle(UP, toeYaw), footWeight);
        worldRotation.setFromAxisAngle(pitchAxis, i === 0 ? 0.90 * kneel : 0);
        rotation.setFromAxisAngle(UP, toeYaw);
        orientJoint(leg[2], worldRotation.premultiply(rotation).multiply(restRotation), footWeight);
      });

      if (control > 0) {
        // Keep the wrist beside the hip so the shared drag pose trails behind the knee.
        arm[0].getWorldPosition(target).addScaledVector(side, reach * lerp(0.42, 0.25, rise))
          .addScaledVector(forward, reach * lerp(-0.19, -0.05, rise)).y -= reach * lerp(0.72, 0.86, rise);
        poseLimb(arm, target, bend.copy(side).setY(-0.65), control);

        freeArm[0].getWorldPosition(target)
          .addScaledVector(side, -reach * 0.24)
          .addScaledVector(forward, reach * lerp(0.42, 0.10, rise));
        target.y -= reach * lerp(0.78, 0.89, rise);
        poseLimb(freeArm, target, bend.copy(side).negate().setY(-0.52), control);
      }
    },
    frameCamera(camera, gameFov) {
      const high = altitude(age)/11.5;
      const wide = 1 - smoothstep(age, IMPACT + 0.27, STANDING);
      const halfLens = Math.tan(degToRad(25));
      const standing = smoothstep(age, RISE, STANDING);
      const halfWidth = lerp(2.35, 3.8, wide);
      const nearMargin = lerp(1.40,2.25,wide);
      const depth = THREE.MathUtils.clamp(nearMargin+halfWidth/(halfLens*camera.aspect),4.25,14)+0.9*wide;
      cameraTarget.copy(boss.pos).addScaledVector(forward,0.24);
      cameraTarget.y += 1.14 + 10.7 * high + 0.13 * standing;
      camera.position.copy(boss.pos).addScaledVector(forward,depth)
        .addScaledVector(side,depth * (0.26 + 0.14 * wide - 0.06 * standing));
      camera.position.y += 1.27 + 2.83 * wide + 4.2 * high;
      const jolt = age-IMPACT;
      if (jolt >= 0 && jolt < 0.67) {
        const envelope = (1-smoothstep(jolt,0,0.67))*Math.exp(-3.4*jolt);
        camera.position.addScaledVector(side,0.20*Math.sin(57*jolt)*envelope);
        camera.position.y += 0.18*Math.cos(51*jolt)*envelope;
        cameraTarget.y -= 0.18*Math.cos(51*jolt)*envelope;
      }
      camera.lookAt(cameraTarget);
      const blend = smoothstep(age,HANDOFF,END);
      camera.position.lerp(gamePosition,blend).addScaledVector(side,1.65*Math.sin(Math.PI*blend));
      camera.quaternion.slerp(gameRotation,blend);
      const cinematicFov = radToDeg(2*Math.atan(Math.max(halfLens,halfWidth/((depth-nearMargin)*camera.aspect))));
      const fov = lerp(cinematicFov,gameFov,blend);
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    },
    dispose() {
      landing.dispose();
      binder.root.visible = modelVisible;
      boss.syncMesh();
    },
  };
}
