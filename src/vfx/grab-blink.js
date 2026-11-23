import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { guardFromAO } from './ao-guard.js';

const { clamp, lerp, smoothstep, degToRad } = THREE.MathUtils;
const TRAIL_FRAMES = 17;
const SEGMENTS = TRAIL_FRAMES + 1;
const SUBSTEPS = 16;
const KNOT_SPACING = .64;
const LEADER_KNOTS = [
  [-.10, .45], [.25, -.15], [.02, .07], [-.36, -.22],
  [.41, .19], [-.19, -.31], [.28, -.12], [-.29, .24],
];
const BRANCH_TIMING = [0, .27, .58, 1];
const TWIG_TIMING = [0, .41, 1];
const STRIP_VERTICES = (SUBSTEPS + 1) * 2;
const ARC_VERTICES = 2 * STRIP_VERTICES;
const ARCS_PER_SEGMENT = 3;
const SEGMENT_VERTICES = ARCS_PER_SEGMENT * ARC_VERTICES;

const vertex = `
  varying vec2 vUv;
  void main() {
    vUv=uv;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }
`;

const refraction = {
  uniforms: {
    tDiffuse: { value: null },
    boltMask: { value: null },
    head: { value: new THREE.Vector2() },
    tail: { value: new THREE.Vector2() },
    pulse: { value: new THREE.Vector2() },
    aspect: { value: 1 },
    radius: { value: .1 },
    wave: { value: .1 },
    travel: { value: 0 },
    burst: { value: 0 },
    protect: { value: 0 },
    time: { value: 0 },
  },
  vertexShader: vertex,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse, boltMask;
    uniform vec2 head, tail, pulse;
    uniform float aspect, radius, wave, travel, burst, time, protect;
    void main() {
      vec2 scale=vec2(aspect,1.);
      vec2 p=vUv*scale;
      vec2 span=(head-tail)*scale;
      float along=clamp(dot(p-tail*scale,span)/max(dot(span,span),.0001),0.,1.);
      vec2 across=p-(tail*scale+along*span);
      float r=length(across);
      float distanceFromRoute=r/radius;
      float flank=smoothstep(.44,.66,distanceFromRoute);
      float envelope=(distanceFromRoute-.69)*3.4;
      float wake=flank*exp(-envelope*envelope)*smoothstep(.06,.72,along+.22);
      float folds=sin(r*77.-along*6.+time*1.25)*.82+sin(r*142.+along*7.-time*.7)*.18;
      vec2 shift=across/max(r,.018)*folds*wake*travel;

      vec2 toPulse=p-pulse*scale;
      float d=length(toPulse);
      float ridge=(d-wave)/max(radius*.36,.012);
      float ring=exp(-ridge*ridge)*sin(ridge*2.1);
      shift+=toPulse/max(d,.012)*ring*burst*mix(1.,flank,protect);

      vec2 offset=shift/scale;
      // Keep both the original bolt and samples that would drag it into the wake sharp.
      float coverage=max(texture2D(boltMask,vUv).r,
        max(texture2D(boltMask,vUv+offset).r,texture2D(boltMask,vUv+offset*1.18).r));
      offset *= 1.-smoothstep(.08,.52,coverage);
      vec2 uv=clamp(vUv+offset,.001,.999);
      vec3 color=texture2D(tDiffuse,uv).rgb;
      color.r=mix(color.r,texture2D(tDiffuse,clamp(uv+offset*.18,.001,.999)).r,.36);
      gl_FragColor=vec4(color,1.);
    }
  `,
};

function glow(root, name, geometry, uniforms, vertexShader, fragmentShader) {
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, depthWrite: false, toneMapped: false,
    side: THREE.DoubleSide, forceSinglePass: true,
    precision: 'highp', blending: THREE.AdditiveBlending,
  });
  const mesh = guardFromAO(new THREE.Mesh(geometry, material), material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  root.add(mesh);
  return mesh;
}

const trailVertex = `
  attribute vec3 profile;
  varying vec3 vProfile;
  void main() {
    vProfile=profile;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }
`;

class BlinkRefractionPass extends ShaderPass {
  constructor(trail) {
    super(refraction);
    this.material.precision = 'highp';
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.uniforms.boltMask.value = this.maskTarget.texture;
    this.maskScene = new THREE.Scene();
    this.maskMaterial = new THREE.ShaderMaterial({
      uniforms: trail.uniforms, vertexShader: trailVertex, precision: 'highp',
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
      transparent: true, forceSinglePass: true, blending: THREE.AdditiveBlending,
      fragmentShader: `
        varying vec3 vProfile;
        uniform float clock,life;
        void main() {
          float age=clock-vProfile.y;
          if(age<-.05 || age>life) discard;
          gl_FragColor=vec4(vec3(1.-smoothstep(.72,1.,abs(vProfile.x))),1.);
        }
      `,
    });
    const mask = new THREE.Mesh(trail.geometry, this.maskMaterial);
    mask.frustumCulled = false;
    this.maskScene.add(mask);
    this.clearColor = new THREE.Color();
    this.enabled = false;
  }

  setSize(width, height) {
    this.maskTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
  }

  render(renderer, writeBuffer, readBuffer) {
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.maskTarget);
      renderer.clear(true, false, false);
      renderer.render(this.maskScene, this.viewCamera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this.clearColor, previousAlpha);
    }
    super.render(renderer, writeBuffer, readBuffer);
  }

  dispose() {
    this.maskMaterial.dispose();
    this.maskTarget.dispose();
    super.dispose();
  }
}

function makeTrail(root) {
  const positions = new Float32Array(SEGMENTS * SEGMENT_VERTICES * 3);
  const profiles = new Float32Array(SEGMENTS * SEGMENT_VERTICES * 3);
  const indices = [];
  for (let offset = 0; offset < SEGMENTS * SEGMENT_VERTICES; offset += STRIP_VERTICES) {
    for (let step = 0; step < SUBSTEPS; step++) {
      const i = offset + step * 2;
      indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const profile = new THREE.BufferAttribute(profiles, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('profile', profile);
  geometry.setIndex(indices);
  const uniforms = { clock: { value: 0 }, power: { value: 0 }, life: { value: TRAIL_FRAMES } };
  glow(root, 'boss-grab-lightning', geometry, uniforms, trailVertex, `
    varying vec3 vProfile;
    uniform float clock,power,life;
    void main() {
      float age=clock-vProfile.y;
      if(age<-.05 || age>life) discard;
      float x=abs(vProfile.x), energy=vProfile.z;
      float fade=exp(-max(0.,age-.7)*mix(.70,.36,energy))*(1.-smoothstep(5.,life,age));
      float tip=exp(-age*age*1.45);
      float core=1.-smoothstep(.20,.29,x);
      float edge=1.-smoothstep(.42,.54,x);
      float halo=(1.-smoothstep(.50,.95,x))*.16;
      float alpha=power*energy*fade;
      vec3 red=vec3(1.35,.010,.045);
      vec3 hot=vec3(1.6,.43,.32);
      gl_FragColor=vec4(red*(edge*.80+halo)+hot*core*(.64+tip*.82),alpha);
    }
  `);
  return { geometry, uniforms, position, profile };
}

function writeArc(trail, index, points, timing, start, duration, width, energy, axisX, axisZ) {
  const { position, profile } = trail;
  for (let face = 0; face < 2; face++) {
    for (let step = 0; step <= SUBSTEPS; step++) {
      const vertex = Math.min(step, timing.length - 1);
      const t = timing[vertex];
      const point = points[vertex];
      const span = energy < 1 ? width * lerp(1, .08, t) : width;
      for (const sign of [-1, 1]) {
        const lateral = face === 0 ? sign * span : 0;
        const vertical = face === 1 ? sign * span : 0;
        position.setXYZ(index, point.x + lateral * axisX, point.y + vertical, point.z + lateral * axisZ);
        profile.setXYZ(index++, sign, start + duration * t, energy);
      }
    }
  }
}

function makePulse(root, name, geometry) {
  const uniforms = { age: { value: 0 }, power: { value: 0 } };
  const mesh = glow(root, name, geometry, uniforms, vertex, `
    uniform float age,power;
    varying vec2 vUv;
    void main() {
      vec2 p=vUv*2.-1.;
      float r=length(p), a=atan(p.y,p.x);
      float irregularity=.013*sin(a*13.+age*.8)+.017*cos(a*23.-age*.31);
      float offset=r+irregularity-(.16+.053*age);
      float crest=exp(-offset*offset*1450.);
      float echo=exp(-pow((offset+.106)*12.,2.))*.48;
      float flare=exp(-r*8.)*exp(-age*.42);
      float fracture=smoothstep(-.36,.90,sin(a*17.+sin(a*6.)*2.1));
      float embers=fracture*exp(-pow((offset-.052)*9.,2.));
      vec3 red=vec3(1.,.012,.059), hot=vec3(1.20,.29,.21);
      gl_FragColor=vec4(red*(echo+embers*.71+flare*2.8)+hot*crest*(.37+fracture*.63),power);
    }
  `);
  return { mesh, uniforms };
}

function uneven(index, seed) {
  const value = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function updatePulse({ mesh, uniforms }, age, intensity, lifetime) {
  const power = intensity * (1 - smoothstep(age, 1, lifetime));
  mesh.visible = power > 0;
  if (mesh.visible) {
    uniforms.age.value = age;
    uniforms.power.value = power;
  }
}

export class BossGrabBlink {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'boss-grab-blink';
    this.trail = makeTrail(this.root);
    const ground = new THREE.PlaneGeometry(4.8, 4.8).rotateX(-Math.PI / 2);
    this.departure = makePulse(this.root, 'boss-grab-departure', ground);
    this.arrival = makePulse(this.root, 'boss-grab-arrival', ground);
    this.light = new THREE.PointLight(0xff2847, 0, 6, 2);
    scene.add(this.root, this.light);
    this.pass = new BlinkRefractionPass(this.trail);
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.last = new THREE.Vector3();
    this.heading = new THREE.Vector3();
    this.side = new THREE.Vector3();
    this.projected = new THREE.Vector3();
    this.wake = new THREE.Vector3();
    this.leaderTiming = [];
    this.mainArc = Array.from({ length: SUBSTEPS + 1 }, () => new THREE.Vector3());
    this.branchArc = BRANCH_TIMING.map(() => new THREE.Vector3());
    this.twigArc = TWIG_TIMING.map(() => new THREE.Vector3());
    this.clear();
  }

  begin(position, yaw, frame) {
    this.started = frame;
    this.ended = null;
    this.dashing = true;
    this.count = 0;
    this.travelled = 0;
    this.nextFork = .32;
    this.forkCount = 0;
    this.last.copy(position);
    this.heading.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.side.set(this.heading.z, 0, -this.heading.x);
    this.departure.mesh.position.copy(position).setY(.093);
    this.trail.geometry.setDrawRange(0, 0);
  }

  trace(position, frame) {
    if (!this.dashing) return;
    const dx = position.x - this.last.x, dz = position.z - this.last.z;
    const distance = Math.hypot(dx, dz);
    if (distance < .008) return;
    // Stamp a single leader onto the collision-resolved route. Forks start
    // at a sampled vertex of that same leader and ignite slightly later.
    const { position: vertices, profile, geometry } = this.trail;
    const index = (this.count % SEGMENTS) * SEGMENT_VERTICES;
    const timing = this.leaderTiming;
    timing.length = 0;
    timing.push(0);
    const firstKnot = Math.floor((this.travelled + 1e-6) / KNOT_SPACING) + 1;
    for (let knot = firstKnot; timing.length < SUBSTEPS; knot++) {
      const t = (KNOT_SPACING * knot - this.travelled) / distance;
      if (t >= 1 - 1e-6) break;
      timing.push(t);
    }
    timing.push(1);

    // Share the exact same straight line between elbows, even across tick boundaries.
    for (const [step, t] of timing.entries()) {
      const metres = this.travelled + distance * t;
      const knot = metres / KNOT_SPACING;
      const before = LEADER_KNOTS[Math.floor(knot) % LEADER_KNOTS.length];
      const after = LEADER_KNOTS[(Math.floor(knot) + 1) % LEADER_KNOTS.length];
      const fraction = knot - Math.floor(knot);
      const lateral = .16 + lerp(before[0], after[0], fraction);
      const y = 1.30 + lerp(before[1], after[1], fraction);
      this.mainArc[step].set(
        this.last.x + dx * t + this.side.x * lateral, y,
        this.last.z + dz * t + this.side.z * lateral,
      );
    }
    writeArc(this.trail, index, this.mainArc, timing, frame - 1, 1, .21, 1, this.side.x, this.side.z);
    const branchStart = index + ARC_VERTICES;
    if (this.nextFork <= this.travelled + distance) {
      const step = timing.length - 2;
      this.writeFork(branchStart, this.mainArc[step], frame - 1 + timing[step]);
      this.nextFork = this.travelled + distance + .46 + .36 * uneven(this.forkCount, 4);
    } else {
      // Wrapped slots may still contain branches from an older span.
      for (let i = branchStart; i < index + SEGMENT_VERTICES; i++) profile.setY(i, -1000);
    }

    this.last.copy(position);
    this.travelled += distance;
    this.count++;
    vertices.needsUpdate = profile.needsUpdate = true;
    geometry.setDrawRange(0, Math.min(this.count, SEGMENTS) * ARCS_PER_SEGMENT * 2 * SUBSTEPS * 6);
  }

  writeFork(index, origin, frame) {
    const seed = this.forkCount++;
    const direction = seed % 2 ? -1 : 1;
    const span = direction * (.67 + uneven(seed, 25) * .51);
    const rise = (seed % 3 === 2 ? -.65 : .82) * (.65 + uneven(seed, 18) * .42);
    const rake = .30 + .39 * uneven(seed, 8);
    const [base, firstElbow, secondElbow, tip] = this.branchArc;
    base.copy(origin);
    firstElbow.copy(origin).addScaledVector(this.side, span * .36).addScaledVector(this.heading, rake * .75);
    firstElbow.y += rise * .53;
    secondElbow.copy(origin).addScaledVector(this.side, span * .66).addScaledVector(this.heading, rake * .36);
    secondElbow.y += rise * .46;
    tip.copy(origin).addScaledVector(this.side, span).addScaledVector(this.heading, rake);
    tip.y += rise;
    writeArc(this.trail, index, this.branchArc, BRANCH_TIMING, frame + .24, .93, .112, .68, this.heading.x, this.heading.z);

    const [joint, twigElbow, twigTip] = this.twigArc;
    joint.copy(secondElbow);
    twigElbow.copy(joint).addScaledVector(this.side, span * .21).addScaledVector(this.heading, -.31);
    twigElbow.y -= .06;
    twigTip.copy(joint).addScaledVector(this.side, span * .46).addScaledVector(this.heading, -.37);
    twigTip.y += .19;
    writeArc(this.trail, index + ARC_VERTICES, this.twigArc, TWIG_TIMING, frame + .79, .64, .065, .42, this.heading.x, this.heading.z);
  }

  finish(position, frame) {
    this.dashing = false;
    this.ended = frame;
    this.arrival.mesh.position.copy(position).setY(.097);
  }

  update(frame, position, intensity, camera) {
    if (this.ended !== null && frame - this.ended > TRAIL_FRAMES) this.clear();
    this.root.visible = this.started !== null && intensity > 0;
    this.pass.enabled = false;
    if (!this.root.visible) {
      this.light.intensity = 0;
      return false;
    }

    const launchAge = frame - this.started;
    const arrivalAge = this.ended === null ? Infinity : Math.max(0, frame - this.ended);
    const launch = 1 - smoothstep(launchAge, 1, 14);
    const arrival = 1 - smoothstep(arrivalAge, 1, 15);
    this.trail.uniforms.clock.value = frame;
    this.trail.uniforms.power.value = intensity;
    updatePulse(this.departure, launchAge, intensity * .85, 14);
    updatePulse(this.arrival, arrivalAge, intensity, 15);
    this.light.position.copy(this.dashing ? position : this.arrival.mesh.position).setY(1.14);
    this.light.intensity = intensity * (this.dashing ? 5.2 + launch * 7 : arrival * 17);
    if (!this.reducedMotion.matches) this.updateRefraction(position, launchAge, arrivalAge, intensity, camera);

    return this.dashing;
  }

  project(point, lift, camera, target) {
    this.projected.copy(point).setY(lift).project(camera);
    target.set(this.projected.x * .5 + .5, this.projected.y * .5 + .5);
    return Math.abs(this.projected.z) < 1;
  }

  updateRefraction(position, launchAge, arrivalAge, intensity, camera) {
    const u = this.pass.uniforms;
    camera.updateMatrixWorld();
    this.pass.viewCamera = camera;
    this.wake.copy(position).addScaledVector(this.heading, -Math.min(2.5, this.travelled));
    const onscreen = this.project(position, 1.16, camera, u.head.value);
    if (!this.project(this.wake, 1.10, camera, u.tail.value)) u.tail.value.copy(u.head.value);

    const arrived = Number.isFinite(arrivalAge);
    const age = arrived ? arrivalAge : launchAge;
    const origin = arrived ? this.arrival.mesh.position : this.departure.mesh.position;
    const pulseVisible = this.project(origin, .45, camera, u.pulse.value);
    const metres = camera.position.distanceTo(this.dashing ? position : origin);
    const size = clamp(.76 / Math.max(1.4, metres) / Math.tan(degToRad(camera.fov * .5)), .06, .36);

    u.aspect.value = camera.aspect;
    u.time.value = launchAge;
    u.radius.value = size;
    u.wave.value = size * (.27 + .12 * age);
    u.travel.value = onscreen && this.dashing ? intensity * .018 * smoothstep(this.travelled, .08, 1.4) : 0;
    u.burst.value = pulseVisible ? intensity * (arrived ? .027 : .021) * (1 - smoothstep(age, 1, 13)) : 0;
    u.protect.value = onscreen ? 1 - smoothstep(arrivalAge, 1, 6) : 0;
    if (onscreen && this.dashing) u.protect.value = 1;
    this.pass.enabled = u.travel.value + u.burst.value > .0003;
  }

  clear() {
    this.dashing = false;
    this.started = this.ended = null;
    this.root.visible = false;
    this.trail.geometry.setDrawRange(0, 0);
    this.light.intensity = 0;
    this.pass.enabled = false;
  }
}
