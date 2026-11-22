import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createMeteorLanding } from './meteor-landing.js';
import { fracturedRock } from '../arena/weathered.js';
import { guardFromAO } from './ao-guard.js';
import { METEOR } from '../meteor-smash.js';

const { clamp, smoothstep } = THREE.MathUtils;
const vertex = `
  varying vec2 vUv;
  void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
`;
const RippleShader = {
  uniforms: {
    tDiffuse: { value: null }, center: { value: new THREE.Vector2() },
    radius: { value: 0 }, power: { value: 0 }, time: { value: 0 }, ratio: { value: 1 },
  },
  vertexShader: vertex,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 center;
    uniform float radius,power,time,ratio;
    varying vec2 vUv;
    void main() {
      vec2 scale=vec2(ratio,1.);
      vec2 v=(vUv-center)*scale;
      float r=length(v);
      vec2 dir=v/max(r,.0001)/scale;
      float arc=sin(r*78.-time*18.)*exp(-pow(abs((r-radius)*14.),2.));
      float echo=sin(r*52.-time*22.)*exp(-pow(abs((r-radius*.64)*9.),2.))*.38;
      vec2 shift=dir*(arc+echo)*power;
      vec2 uv=clamp(vUv+shift,.002,.998);
      vec3 c=texture2D(tDiffuse,uv).rgb;
      c.r=mix(c.r,texture2D(tDiffuse,clamp(uv+shift*.30,.002,.998)).r,.38);
      gl_FragColor=vec4(c,1.);
    }`,
};

function groundPanel(root, name, fragmentShader, order) {
  const uniforms = { time: { value: 0 }, power: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: vertex, fragmentShader,
    transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = guardFromAO(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material), material);
  mesh.name = name;
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = order;
  root.add(mesh);
  return { mesh, uniforms };
}

const warningFragment = `
  uniform float time,power;
  varying vec2 vUv;
  void main() {
    vec2 p=vUv*2.-1.;
    float r=length(p), a=atan(p.y,p.x);
    float rim=exp(-pow(abs((r-.968)*75.),2.));
    float edge=exp(-pow(abs((r-.948)*23.),2.));
    float fill=(1.-smoothstep(.82,.982,r))*(.14+.20*time);
    float clock=exp(-abs(r-mix(.45,.93,time))*57.)*.48;
    float marks=step(.79,cos(a*32.))*exp(-abs(r-.898)*72.);
    float pulse=.84+.16*sin(time*19.);
    vec3 red=vec3(1.,.025,.045);
    vec3 white=vec3(1.,.40,.27);
    gl_FragColor=vec4(red*(edge*.79+fill+clock*.33)+white*(rim*.89+marks*.5),power*pulse);
  }`;

const pressureFragment = `
  uniform float time,power;
  varying vec2 vUv;
  void main() {
    vec2 p=vUv*2.-1.;
    float r=length(p), a=atan(p.y,p.x);
    float wobble=sin(a*12.+time*9.)*.022+sin(a*22.-time*12.)*.011;
    float wind=exp(-abs(r-.76+wobble)*29.);
    float arcs=pow(.5+.5*cos(r*27.+time*13.+wobble*24.),6.);
    float wings=pow(.5+.5*sin(a*7.+r*17.-time*10.),3.);
    float shape=smoothstep(.04,.28,r)*(1.-smoothstep(.82,1.,r));
    float glow=exp(-r*5.);
    vec3 ember=vec3(1.,.092,.025), gold=vec3(1.,.50,.20);
    gl_FragColor=vec4(ember*(arcs*wings*shape*.91+glow*.65)+gold*wind*shape*.92,power);
  }`;

export class BossSmashEffect {
  constructor(scene, surface) {
    this.scene = scene;
    this.surface = surface;
    this.root = new THREE.Group();
    this.root.name = 'boss-smash-pressure';
    scene.add(this.root);
    this.warning = groundPanel(this.root, 'boss-smash-lock-ring', warningFragment, 11);
    this.warning.mesh.scale.setScalar(METEOR.radius / .968);
    this.pressure = groundPanel(this.root, 'boss-smash-charge-coil', pressureFragment, 10);
    this.launch = groundPanel(this.root, 'boss-smash-takeoff-wave', pressureFragment, 10);
    const fragments = surface.rock.clone();
    fragments.vertexColors = false;
    const debris = new THREE.InstancedMesh(fracturedRock(), fragments, 22);
    debris.frustumCulled = false;
    debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(debris);
    this.debris = debris;
    this.dummy = new THREE.Object3D();
    this.projected = new THREE.Vector3();
    this.pass = new ShaderPass(RippleShader);
    this.pass.enabled = false;
    this.clear();
  }

  impact(position, intensity) {
    if (intensity <= 0) return;
    this.crater?.dispose();
    this.crater = createMeteorLanding(this.scene, position, this.surface, { lava: true, radius: 2.76 });
    this.craterOrigin = position.clone();
    this.impactAge = 0;
  }

  update(smash, frame, dt, intensity, camera) {
    this.root.visible = !!smash;
    const warning = this.warning;
    warning.mesh.visible = !!smash?.target && frame < METEOR.impact;
    if (warning.mesh.visible) {
      warning.mesh.position.copy(smash.target).setY(.078);
      warning.uniforms.time.value = clamp((frame - METEOR.lock) / (METEOR.impact - METEOR.lock), 0, 1);
      warning.uniforms.power.value = .92;
    }

    const step = frame - METEOR.launch;
    const charged = !!smash && frame > 0 && frame < METEOR.launch && intensity > 0;
    const rising = !!smash && step >= 0 && step < 25 && intensity > 0;
    const force = smoothstep(frame, 3, METEOR.launch - 3);
    const blast = 1 - smoothstep(step, 1, 25);
    this.pressure.mesh.visible = charged;
    this.launch.mesh.visible = rising;
    this.debris.visible = charged || rising;
    if (charged) {
      this.pressure.mesh.position.copy(smash.origin).setY(.098);
      this.pressure.mesh.scale.setScalar(1.5 + 1.7 * force);
      this.pressure.uniforms.time.value = frame / 60;
      this.pressure.uniforms.power.value = intensity * (.22 + 1.1 * force);
    }
    if (rising) {
      this.launch.mesh.position.copy(smash.origin).setY(.111);
      this.launch.mesh.scale.setScalar(.8 + 5.5 * (1 - (1 - step / 25) ** 2));
      this.launch.uniforms.time.value = step / 60;
      this.launch.uniforms.power.value = intensity * blast * 1.65;
    }
    if (this.debris.visible) this.updateDebris(smash.origin, force, Math.max(0, step));

    if (this.crater) {
      this.impactAge += dt;
      if (this.impactAge >= 6.8 || intensity <= 0) {
        this.crater.dispose();
        this.crater = null;
      } else {
        const alpha = Math.min(1, intensity) * (1 - smoothstep(this.impactAge, 5.2, 6.8));
        this.crater.update(this.impactAge, this.impactAge, 0, camera, alpha);
      }
    }

    const impactPulse = this.crater && this.impactAge < .33;
    const location = (charged || rising) ? smash.origin : impactPulse ? this.craterOrigin : null;
    this.pass.enabled = false;
    if (location && intensity > 0) {
      this.projected.copy(location).addScaledVector(THREE.Object3D.DEFAULT_UP, .42).project(camera);
      if (this.projected.z < -1 || this.projected.z > 1) return;
      const u = this.pass.uniforms;
      u.center.value.set(this.projected.x * .5 + .5, this.projected.y * .5 + .5);
      u.ratio.value = camera.aspect;
      u.time.value = charged || rising ? frame / 60 : this.impactAge;
      u.radius.value = charged ? .145 + force * .05 : rising ? (.06 + step * .015) : .07 + this.impactAge * .85;
      u.power.value = intensity * (charged ? force * .010 : rising ? blast * .021 : .024 * (1 - this.impactAge / .33));
      this.pass.enabled = u.power.value > .0003;
    }
  }

  updateDebris(origin, force, step) {
    const { debris, dummy } = this;
    for (let i = 0; i < debris.count; i++) {
      const angle = i * 2.39996 + force * .8;
      const spread = (1.12 + (i % 8) * .15) * (1 - force * .34) + .125 * step;
      const y = Math.max(.05, force * (.14 + (i % 7) * .19) + .075 * step - .0038 * step * step);
      const size = (.06 + (i % 6) * .029) * smoothstep(force, .10, .52) * (1 - smoothstep(step, 10, 25));
      dummy.position.set(origin.x + Math.cos(angle) * spread, y, origin.z + Math.sin(angle) * spread);
      dummy.rotation.set(i * .51 + step * .13, angle, force * 1.2 + step * .17);
      dummy.scale.set(size * 1.35, size, size);
      dummy.updateMatrix();
      debris.setMatrixAt(i, dummy.matrix);
    }
    debris.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.crater?.dispose();
    this.crater = null;
    this.root.visible = false;
    this.pass.enabled = false;
  }
}
