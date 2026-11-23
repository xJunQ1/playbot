import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CATACLYSM } from '../boss-ultimate.js';
import { fracturedRock } from '../arena/weathered.js';
import { guardFromAO } from './ao-guard.js';
import { createMeteorLanding } from './meteor-landing.js';
import { createCataclysmFire } from './cataclysm-fire.js';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const TAU = Math.PI * 2;
const IMPACT_ORIGIN = new THREE.Vector3();
const IMPACT_LIGHT = new THREE.Vector3(0, 2.65, 0);
const vertex = `
  varying vec2 vUv;
  void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
`;

const warning = `
  uniform float time, power;
  varying vec2 vUv;
  void main() {
    vec2 p=vUv*2.-1.;
    float r=length(p), a=atan(p.y,p.x);
    float rim=exp(-abs(r-.912)*260.);
    float halo=exp(-abs(r-.918)*55.);
    float drag=pow(.5+.5*cos((r+time*.24)*79.),12.);
    float grain=sin(p.x*407.+p.y*279.)*sin(p.x*233.-p.y*303.);
    float glyph=step(.80,cos(a*72.))*exp(-abs(r-.891)*143.);
    float surge=(.08+.07*time+.012*grain+drag*.049)*step(r,.99);
    vec3 red=vec3(1.,.022,.037), hot=vec3(1.,.25,.19);
    gl_FragColor=vec4(red*(surge+halo*.37)+hot*(rim*.91+glyph*.55),power);
  }
`;

const shelter = `
  uniform float time, power;
  varying vec2 vUv;
  void main() {
    vec2 p=vUv*2.-1.;
    float r=length(p);
    if (r>1.) discard;
    float rim=exp(-abs(r-.968)*49.);
    float sweep=exp(-abs(r-fract(time*2.8))*18.)*(1.-r);
    float hatching=pow(.5+.5*cos((p.x+p.y)*39.),10.);
    vec3 fill=vec3(.018,.32,.14);
    vec3 edge=vec3(.44,1.,.62);
    gl_FragColor=vec4(fill+edge*(rim*.83+sweep*.37+hatching*.08),power*.89);
  }
`;

const surfaceVertex = `
  varying vec3 vRock, vNormal;
  void main() {
    vRock=position;
    vNormal=normalize(normalMatrix*normal);
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }
`;

const magma = `
  uniform float time, power;
  varying vec3 vRock, vNormal;
  vec3 hash3(vec3 p) {
    return fract(sin(vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),
      dot(p,vec3(113.5,271.9,124.6))))*43758.5453);
  }
  void main() {
    vec3 p=vRock*5.2;
    p+=sin(p.yzx*3.6)*.18+sin(p.zxy*8.1)*.071;
    vec3 cell=floor(p), local=fract(p);
    float d=10., second=10., rockSeed=0.;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++) {
      vec3 n=vec3(float(x),float(y),float(z));
      vec3 h=hash3(cell+n), delta=n+.18+h*.64-local;
      float ds=dot(delta,delta);
      if(ds<d) { second=d; d=ds; rockSeed=h.x; }
      else if(ds<second) { second=ds; }
    }
    float gap=second-d;
    float flow=.54+.46*sin(p.y*3.0+p.x*2.5+time*5.+rockSeed*1.4);
    float hot=1.-smoothstep(.012,.059+flow*.026,gap);
    float heat=exp(-gap*8.4);
    float grit=sin(p.x*63.+sin(p.y*55.))*sin(p.z*72.-p.y*51.);
    float shade=.43+.57*max(0.,dot(normalize(vNormal), normalize(vec3(-.45,.74,.55))));
    vec3 stone=mix(vec3(.036,.017,.023),vec3(.162,.082,.073),rockSeed);
    vec3 c=stone*shade*(.92+grit*.24);
    c+=vec3(.88,.048,.016)*heat*(.40+.48*flow)*power;
    c+=vec3(1.32,.39,.071)*hot*(.48+flow*.86)*power;
    c+=vec3(.7,.28,.075)*pow(hot,4.)*flow*power;
    gl_FragColor=vec4(c,1.);
  }
`;

const pressure = {
  uniforms: {
    tDiffuse: { value: null }, center: { value: new THREE.Vector2() }, ratio: { value: 1 },
    extent: { value: .2 }, power: { value: 0 }, time: { value: 0 }, flash: { value: 0 },
  },
  vertexShader: vertex,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 center;
    uniform float ratio, extent, power, time, flash;
    varying vec2 vUv;
    void main() {
      vec2 aspect=vec2(ratio,1.);
      vec2 p=(vUv-center)*aspect;
      float d=length(p), a=atan(p.y,p.x);
      float warped=d+sin(a*7.+time*5.)*.015+sin(a*15.-time*9.)*.009;
      float band=(warped-extent)*11.;
      float wave=sin(band*9.82+time*23.)*exp(-band*band);
      float heat=sin(d*170.-time*31.+cos(a*8.))*exp(-d*8.)*.34;
      vec2 shift=p/max(d,.0001)/aspect*(wave+heat)*power;
      vec2 uv=clamp(vUv+shift,.002,.998);
      vec3 c=texture2D(tDiffuse,uv).rgb;
      c.r=mix(c.r,texture2D(tDiffuse,clamp(uv+shift*.45,.002,.998)).r,.42);
      c=mix(c,vec3(1.,.985,.966),flash);
      gl_FragColor=vec4(c,1.);
    }
  `,
};

function panel(name, shader, y, order, blending = THREE.AdditiveBlending) {
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, power: { value: 1 } },
    vertexShader: vertex, fragmentShader: shader, blending, precision: 'highp',
    transparent: true, depthWrite: false, toneMapped: false,
  });
  const mesh = guardFromAO(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material), material);
  mesh.name = name;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = order;
  return mesh;
}

function rockCloud(name, geometry, material, count) {
  const rocks = new THREE.InstancedMesh(geometry, material, count);
  rocks.name = name;
  rocks.frustumCulled = false;
  rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const shade = (i * 17 % 37) / 36;
    rocks.setColorAt(i, color.setRGB(.32 + shade * .50, .15 + shade * .52, .12 + shade * .48));
  }
  return rocks;
}

export class BossCataclysmEffect {
  constructor(scene, surface, radius, shelters) {
    this.scene = scene;
    this.surface = surface;
    this.root = new THREE.Group();
    this.root.name = 'boss-cataclysm';
    scene.add(this.root);

    this.alert = panel('cataclysm-arena-warning', warning, .106, 10);
    this.alert.scale.setScalar(radius);
    this.shelterRings = shelters.map(({ x, z, radialX, radialZ, width, depth }) => {
      const ring = panel('cataclysm-pillar-shelter', shelter, .110, 11, THREE.NormalBlending);
      ring.position.set(x, .110, z);
      ring.rotateZ(Math.atan2(-radialX, -radialZ));
      ring.scale.set(width, depth, 1);
      return ring;
    });
    this.fire = createCataclysmFire(radius, shelters);
    const stone = surface.rock.clone();
    stone.vertexColors = false;
    stone.emissive.setHex(0xc72a0e);
    stone.emissiveIntensity = .067;
    const rubble = fracturedRock();
    this.suction = rockCloud('cataclysm-rising-stone', rubble, stone, 112);
    this.ejecta = rockCloud('cataclysm-blast-debris', rubble, stone, 116);
    const magmaMaterial = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, power: { value: 0 } },
      vertexShader: surfaceVertex, fragmentShader: magma, precision: 'highp', toneMapped: false,
    });
    this.meteor = guardFromAO(new THREE.Mesh(fracturedRock(), magmaMaterial), magmaMaterial);
    this.meteor.name = 'cataclysm-magma-meteor';
    this.glow = new THREE.PointLight(0xff3a15, 0, 24, 2);
    this.root.add(this.alert, ...this.shelterRings, this.fire.root, this.suction, this.ejecta, this.meteor);
    scene.add(this.glow);

    this.pass = new ShaderPass(pressure);
    this.dummy = new THREE.Object3D();
    this.meteorOrigin = new THREE.Vector3(0, 8, 0);
    this.landing = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.projected = new THREE.Vector3();
    this.clear();
  }

  impact(intensity) {
    this.clearCrater();
    this.age = 0;
    if (intensity > 0) {
      this.crater = createMeteorLanding(this.scene, IMPACT_ORIGIN, this.surface, { lava: true, radius: 4.45, shockRing: false });
    }
  }

  clearCrater() {
    this.crater?.dispose();
    this.crater = null;
  }

  clear() {
    this.clearCrater();
    this.age = Infinity;
    this.root.visible = false;
    this.pass.enabled = false;
    this.glow.intensity = 0;
    this.meteorOrigin.set(0, 8, 0);
  }

  update(frame, hand, camera, dt, intensity, shakeScale, pixelRatio) {
    const { blink, charge, release, impact } = CATACLYSM;
    const charging = frame >= blink && frame < impact;
    const warning = frame >= 0 && frame < impact;
    const progress = clamp((frame - blink) / charge, 0, 1);
    const falling = clamp((frame - release) / (impact - release), 0, 1) ** 1.65;
    const build = smoothstep(progress, 0, .94);
    const showMeteor = charging && intensity > 0;
    this.age += dt;
    this.fire.update(this.age, intensity, pixelRatio);
    this.root.visible = warning || this.fire.root.visible || this.age < 1.43;
    this.alert.visible = warning;
    this.alert.material.uniforms.time.value = progress;
    this.alert.material.uniforms.power.value = .71 + progress * .26;
    for (const ring of this.shelterRings) {
      ring.visible = warning;
      ring.material.uniforms.time.value = progress;
    }
    this.suction.visible = showMeteor && frame < release;
    this.meteor.visible = showMeteor;
    if (showMeteor) {
      if (hand && frame <= release) this.meteorOrigin.copy(hand).setY(hand.y + lerp(3.25, 5.09, build));
      const radius = lerp(.20, 3.08, build);
      this.center.copy(this.meteorOrigin).lerp(this.landing.set(0, radius * .87, 0), falling);
      this.meteor.position.copy(this.center);
      this.meteor.scale.set(radius * 1.10, radius, radius * .90);
      this.meteor.rotation.set(.18 + frame * .004, frame * .012, -.30 + frame * .0045);
      this.meteor.material.uniforms.time.value = frame / 60;
      this.meteor.material.uniforms.power.value = (.7 + build * .95) * intensity;
      if (this.suction.visible) this.updateRubble(this.suction, (frame - blink) * (1 + .26 * progress ** 4), build, false);
    }
    this.glow.position.copy(showMeteor ? this.center : IMPACT_LIGHT);
    this.glow.intensity = intensity * (showMeteor ? 15 + 140 * build : 720 * Math.exp(-this.age * 6.5));
    this.ejecta.visible = this.age < 1.43 && intensity > 0;
    if (this.ejecta.visible) this.updateRubble(this.ejecta, this.age, 1, true);
    if (this.crater) {
      if (this.age >= 5.8 || intensity <= 0) this.clearCrater();
      else this.crater.update(this.age, this.age, 0, camera, Math.min(1, intensity) * (1 - smoothstep(this.age, 3.5, 5.8)));
    }

    const u = this.pass.uniforms;
    u.flash.value = intensity > 0 ? Math.min(1, intensity * (shakeScale > .65 ? 1.1 : .69))
      * (1 - smoothstep(this.age, .031, .26)) : 0;
    u.power.value = 0;
    if (showMeteor) {
      this.projected.copy(this.center).project(camera);
      if (Math.abs(this.projected.z) <= 1) {
        u.center.value.set(this.projected.x * .5 + .5, this.projected.y * .5 + .5);
        u.ratio.value = camera.aspect;
        u.time.value = frame / 60;
        u.extent.value = .09 + build * .16;
        u.power.value = intensity * Math.min(1, shakeScale) * (.007 + build * .014);
      }
    }
    this.pass.enabled = u.flash.value > .001 || u.power.value > .0005;
  }

  updateRubble(rocks, time, build, exploding) {
    const { dummy } = this;
    for (let i = 0; i < rocks.count; i++) {
      const seed = (i * 43 % 113) / 112;
      const phase = (i * 73 % 113) / 113;
      const angle = i * 2.39996323;
      let radius, y, size, twist, x, z;
      if (exploding) {
        const flight = time - phase * .095;
        radius = 1.6 + Math.max(0, flight) * (4.6 + 16 * phase);
        y = Math.max(.12, .21 + flight * (1.5 + 9.8 * seed) - flight * flight * 8.6);
        twist = angle + flight * .37;
        size = (.052 + .23 * seed) * (flight >= 0 ? 1 - smoothstep(flight, .68 + seed * .19, 1.32) : 0);
        x = Math.cos(twist) * radius;
        z = Math.sin(twist) * radius;
      } else {
        const elapsed = time - phase * 143;
        const t = THREE.MathUtils.euclideanModulo(Math.max(0, elapsed), 64 + seed * 46) / (64 + seed * 46);
        const lift = smoothstep(t, 0, 1);
        radius = lerp(3.2 + 10.4 * seed, .17 + 2.38 * build, lift);
        y = lerp(.09, this.center.y + (seed - .5) * 4.5 * build, t ** 1.15);
        twist = angle + t * (1.9 + phase * 1.2);
        size = (.065 + .29 * seed * seed) * smoothstep(t, .01, .13) * (1 - smoothstep(t, .82, 1));
        x = Math.cos(twist) * radius + this.center.x * lift;
        z = Math.sin(twist) * radius + this.center.z * lift;
      }
      dummy.position.set(x, y, z);
      dummy.rotation.set(seed + twist, phase * TAU + time * (exploding ? 9 : .07), twist * 2);
      dummy.scale.set(size * 1.52, size * .76, size);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
  }
}
