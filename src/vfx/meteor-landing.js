import * as THREE from 'three';
import { buildBasinGeometry, rimScale } from '../arena/impact-surface.js';
import { fracturedRock } from '../arena/weathered.js';
import { guardFromAO } from './ao-guard.js';
import { createDescentLightning, createIntroAftershock } from './intro-impacts.js';

const { smoothstep, lerp } = THREE.MathUtils;
const uvVertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

function sheet(width, height, fragmentShader, additive = false) {
  const material = new THREE.ShaderMaterial({
    precision: 'highp',
    uniforms: { time: { value: 0 }, strength: { value: 1 } },
    vertexShader: uvVertex, fragmentShader,
    transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = guardFromAO(new THREE.Mesh(new THREE.PlaneGeometry(width, height), material), material);
  mesh.renderOrder = additive ? 5 : 2;
  return mesh;
}

export function createMeteorLanding(scene, position, surface, { lava = false, radius = 2.10, shockRing = lava } = {}) {
  const root = new THREE.Group();
  root.name = lava ? 'boss-smash-lava-impact' : 'boss-meteor-landing';
  position = position.clone();
  root.position.copy(position);
  scene.add(root);

  const lightning = lava ? null : createDescentLightning(root);
  const aftershock = lava ? null : createIntroAftershock(root);

  const flare = sheet(6.5, 2.8, `
    varying vec2 vUv;
    uniform float strength;
    void main() {
      vec2 p = vUv*2.0-1.0;
      float streak = exp(-abs(p.y)*30.0-abs(p.x)*4.0);
      float bloom = exp(-length(p*vec2(2.2,1.0))*4.5);
      gl_FragColor = vec4(vec3(1.0,0.012,0.018)*(streak+bloom)
        + vec3(1.0,0.70,0.60)*pow(streak,2.0),strength);
    }`, true);
  flare.position.y = 0.25;
  root.add(flare);

  const crater = new THREE.Mesh(buildBasinGeometry(), lava ? surface.lavaBasin : surface.basin);
  crater.name = 'boss-impact-crater';
  crater.receiveShadow = true;
  root.add(crater);

  const shock = shockRing ? sheet(2, 2, `
    varying vec2 vUv;
    uniform float strength, time;
    void main() {
      vec2 p = vUv*2.0-1.0;
      float a = atan(p.y,p.x);
      float r = length(p) + 0.012*sin(a*13.0+time*6.0) + 0.007*sin(a*23.0);
      float rim = exp(-abs(r-0.85)*39.0);
      float dust = exp(-abs(r-0.72)*10.0)*(0.60+0.27*sin(a*11.0));
      gl_FragColor = vec4(vec3(1.0,0.10,0.055)*rim + vec3(0.62,0.19,0.14)*dust, strength);
    }`, true) : null;
  if (shock) {
    shock.rotation.x = -Math.PI/2;
    shock.position.y = 0.086;
    root.add(shock);
  }

  const rockGeometry = fracturedRock();
  const normals = rockGeometry.attributes.normal, positions = rockGeometry.attributes.position;
  const colors = [];
  for (let i = 0; i < normals.count; i++) {
    const shade = .81 + .16 * normals.getY(i) + .08 * Math.sin(positions.getX(i) * 19 + positions.getZ(i) * 11);
    colors.push(shade, shade * .95, shade * .91);
  }
  rockGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const count = 54;
  const rocks = new THREE.InstancedMesh(rockGeometry, surface.rock, count);
  rocks.name = 'boss-impact-rubble';
  rocks.frustumCulled = false;
  rocks.receiveShadow = true;
  rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(rocks);
  const dummy = new THREE.Object3D();
  const fragments = Array.from({ length: count }, (_, i) => {
    const noise = (i * 37 % 59) / 59;
    const angle = i * 2.39996 + noise * .35, flying = i >= 20;
    return { x: Math.cos(angle), z: Math.sin(angle), angle, flying,
      radius: flying ? 1.37 + noise * 1.65 : rimScale(angle) * (1.75 + noise * .62),
      size: flying ? .03 + noise * .13 : .08 + noise * .18,
      flight: .28 + noise * .63, height: .28 + noise * 1.50 };
  });

  return {
    update(age, sinceImpact, altitude, camera, opacity) {
      const airborne = sinceImpact < 0;
      lightning?.update(age,sinceImpact,altitude);
      aftershock?.update(sinceImpact,opacity);
      crater.visible = rocks.visible = !airborne;
      flare.visible = !airborne && sinceImpact < 0.30;
      if (flare.visible) {
        flare.quaternion.copy(camera.quaternion);
        flare.material.uniforms.strength.value = (lava ? 2.4 : 1.12)*(1-smoothstep(sinceImpact,0,0.30));
      }
      if (shock) shock.visible = !airborne && sinceImpact < 0.68;
      if (airborne) return;
      const footprint = opacity > 0 ? lerp(.72, radius, smoothstep(sinceImpact, 0, .19)) * Math.sqrt(opacity) : 0;
      surface.set(position, footprint);
      crater.visible = footprint > .001;
      crater.scale.set(footprint, Math.min(1, footprint), footprint);
      surface.heat.value = Math.exp(-(lava ? .42 : 1.8) * sinceImpact) * opacity;
      if (lava) surface.flow.value = sinceImpact;
      if (shock?.visible) {
        shock.scale.setScalar(0.45 + 4.2*(1-(1-sinceImpact/0.68)**2));
        shock.material.uniforms.time.value = sinceImpact;
        shock.material.uniforms.strength.value = 1.7*(1-smoothstep(sinceImpact,0,0.68));
      }
      fragments.forEach(({ x, z, angle, flying, radius, size, flight, height }, i) => {
        const t = Math.min(1, sinceImpact / flight);
        const reach = radius * (lava ? 1.27 : 1);
        const spread = flying ? lerp(.22, reach, t) : reach * lerp(.74, 1, smoothstep(t, 0, .43));
        const lift = flying ? height * 4 * t * (1 - t) : .14 * Math.sin(Math.PI * t);
        const scale = size * Math.min(1, opacity * 3);
        dummy.position.set(x * spread, lift + scale * .30 - .02 - (1 - opacity) * .28, z * spread);
        dummy.rotation.set(.21 + .33 * t, angle + .62 * t, (flying ? 2.3 * t : .68) * x);
        dummy.scale.set(scale * 1.25, scale * (flying ? .73 : .46), scale * .86);
        dummy.updateMatrix();
        rocks.setMatrixAt(i, dummy.matrix);
      });
      rocks.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      surface.set(position, 0);
      lightning?.dispose();
      root.removeFromParent();
      rocks.dispose();
      for (const mesh of root.children) {
        mesh.geometry.dispose();
        if (mesh !== crater && mesh !== rocks) mesh.material.dispose();
      }
    },
  };
}
