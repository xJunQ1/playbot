import * as THREE from 'three';
import { BladeTrail } from './blade-trail.js';
import { guardFromAO } from './ao-guard.js';
import { ULTIMATE_CUTS, FINISHER, finisherRun } from '../ultimate.js';

const { smoothstep, clamp } = THREE.MathUtils;
const NOISE = `
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p);
  vec4 h=fract(sin(dot(i,vec2(127.1,311.7))+vec4(0.,127.1,311.7,438.8))*43758.5453);
  f=f*f*(3.-2.*f);
  return mix(mix(h.x,h.y,f.x),mix(h.z,h.w,f.x),f.y);
}`;

function silverTrail(root, life, order, core) {
  const trail = new BladeTrail(root, { life, maxSamples: 64 });
  const material = trail.material;
  material.toneMapped = false;
  material.uniforms.clock = { value: 0 };
  material.uniforms.core = { value: core };
  material.fragmentShader = `
    varying float vAlpha, vAcross, vU;
    uniform float uIntensity, clock, core;
    ${NOISE}
    void main() {
      float x=vU, y=vAcross;
      float fleck=noise(vec2(x*76.-clock*6.,y*14.8));
      float gust=noise(vec2(x*21.+clock*2.,y*9.));
      float edge=.86 + sin(x*53.-clock*2.)*.009 + (gust-.5)*.046;
      float bright=exp(-pow(abs((y-edge)*49.),2.));
      float halo=exp(-pow(abs((y-edge)*10.),2.));
      float strands=pow(.5+.5*cos(y*58.+(gust-.5)*5.+x*9.),8.);
      strands*=smoothstep(.29,.82,fleck)*smoothstep(.12,.44,y)*(1.-smoothstep(.76,.98,y));
      float haze=smoothstep(.32,.82,gust)*sin(3.14159*y);
      vec3 cold=vec3(.39,.59,.87);
      vec3 silver=vec3(.84,.93,1.);
      float tail=smoothstep(0., .16,x) * (1.-smoothstep(.988,1.,x)*.20);
      vec3 color=silver*(bright*(1.1+core*.6)+halo*.38) + cold*(strands*1.76+haze*.28);
      gl_FragColor=vec4(color, clamp(vAlpha*tail*uIntensity*1.75,0.,1.));
    }`;
  trail.mesh.renderOrder = order;
  return trail;
}

function makeCrest(root, echo) {
  const uniforms = { power: { value: 0 }, time: { value: 0 }, echo: { value: echo } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      uniform float time,echo;
      void main() {
        vUv=uv;
        float k=uv.x, d=uv.y;
        float bell=sin(k*3.14159);
        float y=.11+k*(3.82+time*.74);
        float x=(k-.50) * (-3.92-time*.60) + bell*(.89+echo*.28);
        float z=bell*1.18 - d*(.31+.75*bell) - echo*.62;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(x,y,z,1.);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float power,time,echo;
      ${NOISE}
      void main() {
        float k=vUv.x, d=vUv.y;
        float edge=.11+(noise(vec2(k*21.+echo,d*4.))-.5)*.07;
        float dist=(d-edge)*39.;
        float ridge=exp(-dist*dist);
        float flare=exp(-abs(d-edge)*7.);
        float smoke=clamp(noise(vec2(k*37.+echo*6.,d*9.-time*8.)),0.,1.);
        float fiber=.5+.5*cos(d*41.+k*12.+smoke*3.);
        fiber*=fiber;
        fiber*=fiber;
        float fil=fiber*fiber*smoke*smoke*(1.-d);
        float tails=smoothstep(0.,.105,k)*(1.-smoothstep(.78,1.,k));
        vec3 steel=vec3(.44,.64,1.), white=vec3(.92,.97,1.);
        vec3 color=white*(ridge*1.85+flare*.56)+steel*(fil*1.12+flare*.38);
        float alpha=clamp(power*tails*(.37+.63*max(flare,fil)),0.,1.);
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const mesh = guardFromAO(new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 70, 12), mat), mat);
  mesh.renderOrder = 16;
  mesh.frustumCulled = false;
  root.add(mesh);
  return { mesh, uniforms };
}

function sparkCloud(root) {
  const count = 210;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const glow = new Float32Array(count);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('shine', new THREE.BufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage));
  const uniforms = { strength: { value: 1 }, pixels: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform float pixels;
      attribute float shine;
      varying float vLight;
      void main() {
        vec4 view=modelViewMatrix*vec4(position,1.);
        vLight=shine;
        gl_Position=projectionMatrix*view;
        gl_PointSize=shine>0. ? clamp(pixels*(2.+shine*7.) / max(1.,-view.z*.17),1.,13.) : 0.;
      }`,
    fragmentShader: `
      varying float vLight;
      uniform float strength;
      void main() {
        vec2 p=(gl_PointCoord-.5)*vec2(1.1,1.8);
        float glow=exp(-dot(p,p)*13.)*(1.-smoothstep(.26,.55,length(p)));
        gl_FragColor=vec4(vec3(.73,.86,1.)*(.7+2.*glow), glow*vLight*strength);
      }`,
  });
  const mesh = guardFromAO(new THREE.Points(geometry, mat), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 17;
  root.add(mesh);
  const cells = Array.from({ length: count }, () => ({
    pos: new THREE.Vector3(), speed: new THREE.Vector3(), ttl: 0, life: 1, size: 1,
  }));
  let cursor = 0, seed = 30909;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  return {
    emit(base, tip, velocity, amount) {
      for (let i = 0; i < amount; i++) {
        const s = cells[cursor++ % count];
        s.pos.lerpVectors(base, tip, .43 + .57 * random());
        s.speed.copy(velocity).multiplyScalar(.055 + .18 * random());
        s.speed.x += (random() - .5) * 3.1;
        s.speed.z += (random() - .5) * 3.1;
        s.speed.y += random() * 2.9 - .72;
        s.ttl = s.life = .14 + .64 * random();
        s.size = .31 + .69 * random();
      }
    },
    update(dt, intensity, pixels) {
      uniforms.strength.value = intensity;
      uniforms.pixels.value = pixels;
      for (let i = 0; i < count; i++) {
        const s = cells[i];
        s.ttl -= dt;
        glow[i] = 0;
        if (s.ttl <= 0) continue;
        s.speed.y -= dt * 4;
        s.pos.addScaledVector(s.speed, dt);
        s.pos.y = Math.max(.07, s.pos.y);
        s.pos.toArray(positions, i * 3);
        glow[i] = (s.ttl / s.life) * s.size;
      }
      geometry.attributes.position.needsUpdate = geometry.attributes.shine.needsUpdate = true;
    },
    clear() { cells.forEach(s => { s.ttl = 0; }); },
  };
}

export class UltimateEffect {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'ultimate-silver-wakes';
    scene.add(this.root);
    this.inner = silverTrail(this.root, .19, 14, 1);
    this.inner.mesh.name = 'ultimate-physical-blade-trail';
    this.air = silverTrail(this.root, .31, 13, .25);
    this.air.mesh.name = 'ultimate-silver-filaments';
    this.crest = new THREE.Group();
    this.crest.name = 'ultimate-finisher-wave';
    this.root.add(this.crest);
    this.crestParts = [makeCrest(this.crest, 0), makeCrest(this.crest, 1), makeCrest(this.crest, 2)];
    this.sparks = sparkCloud(this.root);
    this.leading = new THREE.Vector3();
    this.innerRoot = new THREE.Vector3();
    this.wakeRoot = new THREE.Vector3();
    this.previousTip = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.clear();
  }

  update(cast, frame, dt, intensity, pixels, base, tip) {
    this.root.visible = intensity > 0;
    if (dt > 0 && base && tip) {
      const strike = ULTIMATE_CUTS.find(cut => frame >= cut.start && frame <= cut.end);
      const attack = strike === FINISHER ? 1.55 : strike ? 1 : .28;
      if (this.sampled) this.velocity.copy(tip).sub(this.previousTip).divideScalar(Math.max(dt, .009)).clampLength(0, 41);
      else this.velocity.set(0, 0, 0);
      const speed = this.velocity.length();
      this.previousTip.copy(tip);
      this.sampled = true;
      if (strike || speed > 1.8) {
        this.innerRoot.lerpVectors(base, tip, .27);
        this.wakeRoot.lerpVectors(base, tip, .48);
        const reach = 1 + attack * (.25 + .75 * clamp(speed / 19, 0, 1));
        this.leading.lerpVectors(base, tip, reach);
        this.leading.y = Math.max(.072, this.leading.y);
        this.inner.push(this.innerRoot, tip, dt);
        this.air.push(this.wakeRoot, this.leading, dt);
        this.sparks.emit(this.innerRoot, this.leading, this.velocity,
          Math.min(15, Math.round(Math.min(1, dt * 54) * attack * (2 + speed * .26))));
      } else this.fade(dt);
      this.inner.material.uniforms.uIntensity.value = intensity * (.29 + .78 * attack);
      this.air.material.uniforms.uIntensity.value = intensity * (.16 + .86 * attack);
    } else if (dt > 0) this.fade(dt);
    for (const t of [this.inner, this.air]) t.material.uniforms.clock.value = frame / 60;
    this.sparks.update(dt, intensity, pixels);

    const age = frame - FINISHER.hit;
    this.crest.visible = !!cast.wave && age >= 0 && age <= FINISHER.duration + 10;
    if (!this.crest.visible) return;
    const { direction, origin } = cast.wave;
    this.crest.position.copy(origin).addScaledVector(direction, finisherRun(frame));
    this.crest.rotation.y = Math.atan2(direction.x, direction.z);
    this.crestParts.forEach(({ mesh, uniforms }, i) => {
      mesh.position.z = i * -.49;
      mesh.scale.setScalar(1 + i * .035);
      uniforms.time.value = age / FINISHER.duration;
      uniforms.power.value = intensity * (1 - smoothstep(age, FINISHER.duration - 2, FINISHER.duration + 10)) *
        (1 - i * .315);
    });
  }

  fade(dt) {
    this.inner.release(dt);
    this.air.release(dt);
  }

  clear() {
    this.root.visible = this.crest.visible = false;
    this.sampled = false;
    this.inner.clear();
    this.air.clear();
    this.sparks.clear();
  }
}
