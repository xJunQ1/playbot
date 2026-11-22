import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import recipe from '../../assets/vfx/parry/recipe.json' with { type: 'json' };
import { guardFromAO } from './ao-guard.js';

// Native adaptation of XSXB-Slash parry_fable and the November 17–18 renderer
// updates. Source and MIT notice are in assets/vfx/parry.
const asset = path => new URL('../../assets/vfx/parry/' + path, import.meta.url).href;
const { clamp, lerp, randFloat, smoothstep, degToRad } = THREE.MathUtils;
const sample = ([lo, hi]) => randFloat(lo, hi);
const tint = rgb => new THREE.Color().fromArray(rgb);
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

const billboardVertex = `
  uniform float spin;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float c = cos(spin), s = sin(spin);
    vec2 local = mat2(c, s, -s, c) * position.xy;
    vec4 center = modelViewMatrix * vec4(0., 0., 0., 1.);
    center.xy += local * length(modelViewMatrix[0].xyz);
    gl_Position = projectionMatrix * center;
  }`;

function billboard(geometry, root, fragmentShader, uniforms, order, alpha = false, depthTest = false) {
  const material = new THREE.ShaderMaterial({
    precision: 'highp', vertexShader: billboardVertex, fragmentShader,
    uniforms: { spin: { value: 0 }, ...uniforms },
    transparent: true, depthTest, depthWrite: false, toneMapped: false,
    blending: alpha ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  const mesh = guardFromAO(new THREE.Mesh(geometry, material), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  root.add(mesh);
  return mesh;
}

function sparkCloud(tier, floorDepth, mask, intensity, facing) {
  const { sparks, ribbon } = tier;
  const velocities = [], dynamics = [], trails = [], heats = [], exits = [];
  // Center of the invisible sphere is behind the defender in their local frame.
  const towardDefender = facing.clone().negate();
  const side = new THREE.Vector3().crossVectors(UP, towardDefender).normalize();
  const axis = towardDefender.addScaledVector(side, -.24347 / .96944).addScaledVector(UP, -.03028 / .96944).normalize();
  const tangentUp = new THREE.Vector3().crossVectors(axis, side).normalize();
  side.crossVectors(tangentUp, axis).normalize();
  for (const layer of sparks.tiers) {
    const count = Math.round(layer.count * Math.min(intensity, 1.35));
    for (let i = 0; i < count; i++) {
      const leader = ribbon.enabled && layer.name === 'arc' && i < ribbon.leaders;
      const angle = leader ? i / ribbon.leaders * TAU + randFloat(-.14, .14) : Math.random() * TAU;
      const y = randFloat(-.38, .96);
      const speed = leader ? randFloat(9.0, 12.2) : sample(layer.speed);
      if (leader) {
        const velocity = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangentUp, Math.sin(angle)).multiplyScalar(speed);
        velocities.push(...velocity.toArray());
      } else {
        const horizontal = speed * Math.sqrt(1 - y * y);
        velocities.push(Math.sin(angle) * horizontal, speed * (y > 0 ? y : y * .5), Math.cos(angle) * horizontal);
      }
      dynamics.push(sample(layer.drag), sparks.gravity * layer.gravity, sample(layer.life), sample(layer.cool));
      trails.push(leader ? ribbon.trailS : layer.streak, leader ? ribbon.widthM : sample(layer.width),
        leader ? 1.12 : layer.maxLen, layer.name === 'ember' ? layer.clip : 0);
      exits.push(leader ? Math.PI * .5 - degToRad(ribbon.sphereConeDeg) * randFloat(.48, 1) : 0);
      heats.push(sample(layer.heat));
    }
  }
  const strip = new THREE.PlaneGeometry(1, 1, 12, 1);
  const geometry = new THREE.InstancedBufferGeometry().copy(strip);
  strip.dispose();
  for (const [name, values, size] of [
    ['velocity', velocities, 3], ['dynamics', dynamics, 4], ['trail', trails, 4], ['heat0', heats, 1], ['exitAngle', exits, 1],
  ]) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(values), size));
  geometry.instanceCount = heats.length;
  const material = new THREE.ShaderMaterial({
    precision: 'highp', toneMapped: false,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: {
      age: { value: 0 }, floorDepth: { value: floorDepth }, bounce: { value: sparks.floorBounce },
      sphereAxis: { value: axis }, sphereRadius: { value: (ribbon.sphereRadiusM ?? .34) + .055 },
      mask: { value: mask }, hot: { value: tint(sparks.hot) }, mid: { value: tint(sparks.mid) },
      cool: { value: tint(sparks.cool) }, gain: { value: sparks.hdr * intensity },
      ribbonColor: { value: tint(ribbon.color) }, ribbonGain: { value: ribbon.hdr * intensity * .71 },
    },
    vertexShader: `
      attribute vec3 velocity;
      attribute vec4 dynamics, trail;
      attribute float heat0, exitAngle;
      uniform vec3 sphereAxis;
      uniform float age, floorDepth, bounce, sphereRadius;
      varying vec2 vUv;
      varying float heat, fade, ember, leader;
      vec3 path(float t) {
        vec3 p;
        if (exitAngle > 0.) {
          float speed = length(velocity), exitTime = exitAngle * sphereRadius / speed;
          vec3 tangent = velocity / speed;
          float theta = min(exitAngle, t * speed / sphereRadius);
          p = sphereRadius * (sphereAxis * (1. - cos(theta)) + tangent * sin(theta));
          float released = max(0., t - exitTime);
          vec3 departure = sphereAxis * sin(theta) + tangent * cos(theta);
          p += departure * speed * (1. - exp(-4.2 * released)) / 4.2;
          p.y -= .26 * released * released;
          // Ease into a floor skim instead of breaking the luminous ribbon.
          float clearance = p.y + floorDepth;
          p.y = -floorDepth + .5 * (clearance + sqrt(clearance * clearance + .0025));
        } else {
          float k = dynamics.x, drag = (1. - exp(-k * t)) / k;
          p = velocity * drag;
          p.y -= dynamics.y * (t - drag) / k;
          float penetration = max(0., -floorDepth - p.y);
          if (penetration > 0.) p.y = -floorDepth + bounce * penetration * exp(-2.5 * penetration);
        }
        return p;
      }
      void main() {
        vUv = uv;
        leader = step(.001, exitAngle);
        ember = trail.w;
        float speed = length(velocity) * exp(-dynamics.x * age);
        float tail = min(trail.x, trail.z / max(speed,.1));
        float t = max(0., age - (1. - uv.x) * tail);
        vec4 p = modelViewMatrix * vec4(path(t),1.);
        vec2 dir = (modelViewMatrix * vec4(path(t + .004) - path(t),0.)).xy;
        dir = normalize(dir + vec2(.000001,0.));
        float width = max(trail.y * length(modelViewMatrix[0].xyz), -p.z * .00065);
        if (ember > 0.) {
          p.xy += (uv - .5) * width * 3.;
        } else {
          width *= mix(1., .25 + .75 * pow(uv.x,.65), leader);
          p.xy += vec2(-dir.y,dir.x) * (uv.y - .5) * 2. * width;
        }
        gl_Position = projectionMatrix * p;
        heat = heat0 * exp(-age / dynamics.w);
        fade = (1. - smoothstep(.68,1.,age / dynamics.z)) * smoothstep(0.,.02,age) * smoothstep(.28,1.45,-p.z);
      }`,
    fragmentShader: `
      uniform sampler2D mask;
      uniform vec3 hot, mid, cool, ribbonColor;
      uniform float gain, ribbonGain;
      varying vec2 vUv;
      varying float heat, fade, ember, leader;
      void main() {
        float profile = 1. - smoothstep(.15,.5,abs(vUv.y - .5));
        if (ember > 0.) {
          float dotMask = texture2D(mask,vUv).r;
          if (dotMask < ember) discard;
          profile = dotMask;
        }
        vec3 color = mix(mix(cool, mid, smoothstep(.12,.7,heat)), hot, smoothstep(.7,1.,heat));
        vec3 spark = color * (gain * pow(heat,2.2) + 2.6 * heat);
        vec3 ribbon = ribbonColor * ribbonGain * (.1 + heat * heat) * pow(vUv.x,1.3);
        gl_FragColor = vec4(mix(spark,ribbon,leader), profile * fade);
      }`,
  });
  const mesh = guardFromAO(new THREE.Mesh(geometry, material), material);
  mesh.name = 'xsxb-spark-trails';
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  return mesh;
}

const maskFragment = `
  uniform sampler2D mask;
  uniform vec3 core, edge;
  uniform float contrast, gain;
  varying vec2 vUv;
  void main() {
    float value = texture2D(mask,vUv).r;
    vec3 color = mix(edge,core,smoothstep(.25,.9,value));
    gl_FragColor = vec4(color * gain, pow(value,contrast));
  }`;
const flashFragment = `
  uniform sampler2D mask;
  uniform vec3 core, edge;
  uniform float opacity, gain, blur;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2. - 1.);
    float value = texture2D(mask,vUv).r;
    float rim = 1. - smoothstep(1. - max(.02,blur * .92),1.,r - (value - .35) * .06);
    vec3 color = mix(edge,core,smoothstep(.30,.90,value * (1. - r * .4)));
    gl_FragColor = vec4(color * gain, value * rim * opacity);
  }`;
const haloFragment = `
  uniform vec3 color;
  uniform float gain;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2. - 1.;
    float r2 = dot(p,p);
    gl_FragColor = vec4(color * gain, exp(-r2 * 9.) * (1. - smoothstep(.6,1.,r2)));
  }`;
const needleFragment = `
  uniform vec3 color;
  uniform float gain;
  varying vec2 vUv;
  void main() {
    vec2 p = abs(vUv * 2. - 1.);
    float diamond = 1. - smoothstep(.7,1.,p.x + p.y * 35.);
    gl_FragColor = vec4(color * gain, diamond * (1. - p.x * .55));
  }`;
const smokeFragment = `
  uniform sampler2D mask;
  uniform vec3 color, warm;
  uniform float age, opacity;
  varying vec2 vUv;
  void main() {
    float maskValue = texture2D(mask,vUv).r;
    float edge = 1. - smoothstep(.30,.50,length(vUv - .5));
    float threshold = mix(.06,.86,pow(age,.84));
    float density = smoothstep(threshold,threshold + .19,maskValue * edge);
    float rim = 1. - smoothstep(threshold,threshold + .22,maskValue * edge);
    gl_FragColor = vec4(color + warm * rim * (1. - age) * .14, density * opacity);
  }`;

export class GuardImpact {
  constructor(scene) {
    this.scene = scene;
    this.quad = new THREE.PlaneGeometry(1, 1);
    const loader = new THREE.TextureLoader();
    this.masks = new Map();
    this.audioBuffers = new Map();
    this.voices = new Map();
    this.audioContext = null;
    const decoder = new OfflineAudioContext(1,1,48000);
    this.unlockAudio = () => {
      this.audioContext ??= new AudioContext();
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
    };
    window.addEventListener('pointerdown',this.unlockAudio,true);
    window.addEventListener('keydown',this.unlockAudio,true);
    for (const [name, tier] of Object.entries(recipe.tiers)) {
      for (const layer of [tier.star, tier.flash, tier.sparks, tier.smoke]) {
        if (layer.enabled && !this.masks.has(layer.texture)) {
          const mask = loader.load(asset(layer.texture));
          mask.colorSpace = THREE.NoColorSpace;
          this.masks.set(layer.texture, mask);
        }
      }
      if (tier.sfx.enabled) {
        fetch(asset(tier.sfx.file))
          .then(response => response.ok ? response.arrayBuffer() : null)
          .then(bytes => bytes && decoder.decodeAudioData(bytes))
          .then(buffer => { if (buffer && !this.disposed) this.audioBuffers.set(name, buffer); })
          .catch(() => {});
      }
    }
    this.light = new THREE.PointLight(0xffffff, 0, 6);
    scene.add(this.light);
    this.ndc = new THREE.Vector3();
    this.pass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null }, center: { value: new THREE.Vector2() }, aspect: { value: 1 },
        radius: { value: 0 }, strength: { value: 0 }, phase: { value: 0 }, waves: { value: 3 },
      },
      vertexShader: 'varying vec2 p; void main(){p=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 center;
        uniform float aspect, radius, strength, phase, waves;
        varying vec2 p;
        void main() {
          vec2 aspectUV = vec2(aspect,1.);
          vec2 d = (p - center) * aspectUV;
          float distance = length(d);
          float r = distance / max(.0001,radius);
          float front = mix(.08,.90,1. - (1. - phase) * (1. - phase));
          float spacing = 1.6 * mix(.05,.14,phase);
          float x = (front - r) / spacing;
          float wave = sin(x * 6.283185) * smoothstep(-.5,0.,x)
            * (1. - smoothstep(waves - .5,waves + .25,x)) * exp(-.35 * max(x,0.));
          float feather = 1. - smoothstep(.85,1.,r);
          vec2 offset = d / max(distance,.0001) / aspectUV * wave * strength * feather;
          vec4 color = texture2D(tDiffuse,clamp(p - offset,0.,1.));
          color.r = texture2D(tDiffuse,clamp(p - offset * 1.06,0.,1.)).r;
          color.b = texture2D(tDiffuse,clamp(p - offset * .94,0.,1.)).b;
          gl_FragColor = color;
        }`,
    });
    this.pass.material.precision = 'highp';
    this.pass.enabled = false;
  }

  playSound(name, soundConfig) {
    const buffer = this.audioBuffers.get(name);
    if (!buffer || !navigator.userActivation.hasBeenActive) return;
    this.unlockAudio();
    const context = this.audioContext;
    if (this.voices.size >= 6) this.stopVoice(this.voices.keys().next().value);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = name === 'perfect' ? .54 : .45;
    source.connect(gain).connect(context.destination);
    this.voices.set(source,{ gain, name });
    source.onended = () => this.stopVoice(source,false);
    // Decoded audio supports a sample offset even on the desktop HTTP server,
    // which serves whole WAV files without byte ranges for media seeking.
    source.start(0,Math.min(soundConfig.peakOffsetS,buffer.duration));
  }

  // Reproject after the game updates its camera, including during hitstop.
  updateView(camera) {
    if (!this.ripple || !camera) return;
    const { origin, age, config, scale, intensity } = this.ripple;
    const progress = age / config.lifeS;
    camera.updateMatrixWorld();
    this.ndc.copy(origin).project(camera);
    this.pass.enabled = progress < 1 && Math.abs(this.ndc.z) < 1;
    if (!this.pass.enabled) return;
    const u = this.pass.uniforms;
    u.center.value.set(this.ndc.x * .5 + .5, this.ndc.y * .5 + .5);
    u.aspect.value = camera.aspect;
    const depth = -this.ndc.copy(origin).applyMatrix4(camera.matrixWorldInverse).z;
    u.radius.value = config.radiusM * scale * camera.projectionMatrix.elements[5] / (2 * Math.max(.1,depth));
    u.phase.value = progress;
    u.waves.value = config.waves ?? 3;
    u.strength.value = config.strengthPx720 / 720 * Math.pow(1 - progress,1.4) * smoothstep(age,0,.015) * intensity * .70;
  }

  burst(actor, name, camera, intensity, attacker, contact) {
    const tier = recipe.tiers[name];
    const scale = clamp(actor.scale ?? 1, .8, 1.45);
    const facing = attacker ? attacker.pos.clone().sub(actor.pos).setY(0) : new THREE.Vector3();
    if (facing.lengthSq() < .0001) facing.set(Math.sin(actor.yaw),0,Math.cos(actor.yaw));
    facing.normalize();

    const origin = contact?.point ?? actor.pos.clone().addScaledVector(facing,.55 * scale);
    if (!contact) {
      origin.x -= .23 * scale * facing.z;
      origin.z += .23 * scale * facing.x;
      origin.y += 1.25 * scale;
    }
    const root = new THREE.Group();
    root.name = 'guard-impact-' + name;
    root.position.copy(origin);
    root.scale.setScalar(scale);
    this.scene.add(root);
    const star = billboard(this.quad, root, maskFragment, {
      mask: { value: this.masks.get(tier.star.texture) }, core: { value: tint(tier.star.core) },
      edge: { value: tint(tier.star.edge) }, contrast: { value: tier.star.contrastPow }, gain: { value: 0 },
    }, 15);
    star.name = 'xsxb-star';
    const flash = billboard(this.quad, root, flashFragment, {
      mask: { value: this.masks.get(tier.flash.texture) }, core: { value: tint(tier.flash.core) },
      edge: { value: tint(tier.flash.color) }, opacity: { value: 0 },
      gain: { value: (.35 + tier.flash.hdr * .22) * intensity }, blur: { value: tier.flash.blur },
    }, 11, true);
    const halo = billboard(this.quad, root, haloFragment, {
      color: { value: tint(tier.light.color) }, gain: { value: 0 },
    }, 10);
    halo.scale.setScalar((1.65 + 1.1 * tier.light.glow.amount) * tier.light.glow.sizeMul);
    const cloud = sparkCloud(tier, Math.max(.08,origin.y / scale), this.masks.get(tier.sparks.texture), intensity, facing);
    root.add(cloud);

    const spin = contact && camera ? bladeScreenAngle(contact.axis, camera) : randFloat(-.45,.45);
    const needles = [];
    for (let i = 0; i < 2; i++) {
      const ray = billboard(this.quad, root, needleFragment, {
        gain: { value: 0 }, color: { value: tint(tier.star.edge).lerp(new THREE.Color(0xffffff),.39) },
      }, 14);
      ray.material.uniforms.spin.value = spin + .31 + i * 1.24;
      needles.push(ray);
    }
    const smoke = [];
    for (let i = 0; tier.smoke.enabled && i < tier.smoke.puffs; i++) {
      const puff = billboard(this.quad, root, smokeFragment, {
        mask: { value: this.masks.get(tier.smoke.texture) }, color: { value: tint(tier.smoke.color).lerp(tint([.045,.036,.031]),.65) },
        warm: { value: tint(tier.light.color) }, age: { value: 0 }, opacity: { value: 0 },
      }, 9, true, true);
      puff.position.randomDirection().multiplyScalar(.03);
      puff.material.uniforms.spin.value = Math.random() * TAU;
      smoke.push({ puff, size: randFloat(.42,.67) * tier.smoke.sizeMul, life: randFloat(.30,.68) * tier.smoke.lifeMul, delay: randFloat(0,.03) });
    }

    let debris;
    const shards = [];
    const transform = new THREE.Object3D();
    if (tier.debris.enabled) {
      const config = tier.debris;
      const metal = new THREE.MeshStandardMaterial({ color: 0x66554a, metalness: .57, roughness: .46 });
      debris = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0), metal, config.count);
      debris.frustumCulled = false;
      root.add(debris);
      for (let i = 0; i < config.count; i++) {
        const velocity = new THREE.Vector3().randomDirection().multiplyScalar(sample(config.speedMS) * config.speedMul);
        velocity.y = Math.abs(velocity.y);
        shards.push({ velocity, size: sample(config.sizeM) * config.sizeMul, spin: randFloat(-18,18) });
      }
    }

    this.playSound(name,tier.sfx);
    this.lightOwner = root;
    this.light.position.copy(origin);
    if (camera) this.light.position.addScaledVector(camera.position.clone().sub(origin).normalize(), tier.light.offsetTowardsCamM);
    this.light.distance = tier.light.rangeM * scale;
    this.light.color.fromArray(tier.light.color).lerp(new THREE.Color(0xffffff),.24);
    const ripple = tier.refraction.enabled ? { origin, config: tier.refraction, scale, intensity, age: 0 } : null;
    if (ripple) this.ripple = ripple;
    const duration = Math.max(...tier.sparks.tiers.map(layer => layer.life[1]));
    let age = .014; // Already visible on the first frozen impact frame.
    const dispose = () => {
      root.removeFromParent();
      root.traverse(object => object.material?.dispose());
      cloud.geometry.dispose();
      if (debris) {
        debris.geometry.dispose();
        debris.dispose();
      }
      if (this.lightOwner === root) {
        this.light.intensity = 0;
        this.lightOwner = null;
      }
      if (ripple && this.ripple === ripple) {
        this.pass.enabled = false;
        this.ripple = null;
      }
    };
    const update = dt => {
      age += dt;
      if (age >= duration) {
        dispose();
        return false;
      }
      const s = tier.star, f = tier.flash, l = tier.light;
      const starGain = smoothstep(age,0,.012) * Math.exp(-age / (s.lifeS * .38));
      star.visible = age < s.lifeS * 1.8;
      star.scale.setScalar(s.sizeM * (.5 + .5 * smoothstep(age,0,.02)) * (1 + .35 * age / s.lifeS));
      star.material.uniforms.spin.value = spin + age * .6;
      star.material.uniforms.gain.value = s.hdr * starGain * intensity;
      flash.visible = age < f.lifeS * 1.75;
      const growth = 1 - Math.exp(-age / Math.max(.014,f.lifeS * .42));
      flash.scale.setScalar(f.sizeM * lerp(Math.max(.2,1 - .55 * f.expand), 1 + .45 * f.expand, growth));
      flash.material.uniforms.opacity.value = f.opacity * .62 * Math.pow(Math.max(0,1 - age / (1.75 * f.lifeS)),1.35);
      halo.material.uniforms.gain.value = (.16 + .34 * l.glow.amount) * Math.exp(-age / (l.decayS * 1.95)) * intensity;
      for (const [index, ray] of needles.entries()) {
        ray.visible = age < .105;
        ray.scale.setScalar((name === 'perfect' ? 1.85 : 1.21) * (index ? .64 : 1) * (.5 + .5 * smoothstep(age,0,.022)));
        ray.material.uniforms.gain.value = (name === 'perfect' ? 12 : 7.5) * Math.exp(-age / .029) * intensity;
      }
      cloud.material.uniforms.age.value = age;
      for (const { puff, size, life, delay } of smoke) {
        const progress = clamp((age - delay) / life,0,1);
        puff.visible = age >= delay && progress < 1;
        puff.scale.setScalar(size * (.55 + 1.5 * Math.sqrt(progress)));
        puff.material.uniforms.age.value = progress;
        puff.material.uniforms.opacity.value = tier.smoke.opacity * .61 * smoothstep(age - delay,0,.048) * (1 - progress);
      }
      if (debris) {
        for (let i = 0; i < shards.length; i++) {
          const { velocity, size, spin } = shards[i];
          transform.position.copy(velocity).multiplyScalar(age);
          transform.position.y = Math.max(-origin.y / scale + size, transform.position.y - 4.9 * age * age);
          transform.rotation.set(spin * age,i + spin * .6 * age,i);
          transform.scale.set(3 * size,.45 * size,size).multiplyScalar(Math.min(1,(duration - age) * 5));
          transform.updateMatrix();
          debris.setMatrixAt(i,transform.matrix);
        }
        debris.instanceMatrix.needsUpdate = true;
      }
      if (this.lightOwner === root) this.light.intensity = l.intensity * intensity * .74 * Math.exp(-age / l.decayS);
      if (ripple) ripple.age = age;
      return true;
    };
    update(0);
    return { update, dispose };
  }

  stopVoice(source, stop = true) {
    const voice = this.voices.get(source);
    if (!voice) return;
    this.voices.delete(source);
    source.onended = null;
    if (stop) source.stop();
    source.disconnect();
    voice.gain.disconnect();
  }

  resetAudio() {
    for (const source of this.voices.keys()) this.stopVoice(source);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('pointerdown',this.unlockAudio,true);
    window.removeEventListener('keydown',this.unlockAudio,true);
    this.resetAudio();
    this.audioContext?.close().catch(() => {});
    this.audioBuffers.clear();
    this.light.removeFromParent();
    this.light.dispose();
    this.pass.dispose();
    this.quad.dispose();
    for (const map of this.masks.values()) map.dispose();
  }
}

function bladeScreenAngle(axis, camera) {
  const direction = axis.clone().transformDirection(camera.matrixWorldInverse);
  return Math.atan2(direction.y,direction.x);
}
