import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { guardFromAO } from './ao-guard.js';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const cyan = new THREE.Color(0x3bb8f2);

function echoMaterial() {
  return new THREE.ShaderMaterial({
    precision: 'highp', transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
    uniforms: { fade: { value: 1 }, time: { value: 0 } },
    vertexShader: `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 eye, surface;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        eye = -mvPosition.xyz;
        surface = normalMatrix * objectNormal;
      }`,
    fragmentShader: `
      uniform float fade, time;
      varying vec3 eye, surface;
      void main() {
        float edge = pow(1.0 - abs(dot(normalize(eye),normalize(surface))),2.2);
        float fibers = sin(gl_FragCoord.y * .19 + time * 20.) * .5 + .5;
        vec3 color = mix(vec3(.02,.24,.60),vec3(.27,.83,1.),edge);
        gl_FragColor = vec4(color,fade * (.22 + edge * .62) * (.78 + fibers * .22));
      }`,
  });
}

function prepareEcho(source, renderer) {
  const meshes = new THREE.Group();
  meshes.name = 'perfect-dodge-afterimage';
  const material = echoMaterial();
  const skeletons = new Map();
  const objects = [];
  function add(node) {
    if (node !== source && !node.visible) return;
    if (node.isMesh) {
      let ghost;
      if (node.isSkinnedMesh) {
        if (!skeletons.has(node.skeleton)) {
          const bones = node.skeleton.bones.map(() => new THREE.Bone());
          const skeleton = new THREE.Skeleton(bones, node.skeleton.boneInverses);
          skeleton.computeBoneTexture();
          renderer.initTexture(skeleton.boneTexture);
          skeletons.set(node.skeleton, { skeleton, attached: node.bindMode === THREE.AttachedBindMode });
        }
        ghost = new THREE.SkinnedMesh(node.geometry, material);
        ghost.bindMode = node.bindMode;
        ghost.bind(skeletons.get(node.skeleton).skeleton, node.bindMatrix);
      } else {
        ghost = new THREE.Mesh(node.geometry, material);
      }
      if (Array.isArray(node.material)) ghost.material = node.material.map(() => material);
      ghost.matrixAutoUpdate = false;
      ghost.frustumCulled = false;
      ghost.renderOrder = 16;
      guardFromAO(ghost, material);
      meshes.add(ghost);
      objects.push([node, ghost]);
    }
    for (const child of node.children) add(child);
  }
  add(source);
  return {
    meshes, material, strength: 0, age: 0,
    capture(displacement, strength) {
      this.age = 0;
      this.strength = strength;
      for (const [original, { skeleton, attached }] of skeletons) {
        for (let i = 0; i < skeleton.bones.length; i++) {
          const matrix = skeleton.bones[i].matrixWorld;
          if (original.bones[i]) matrix.copy(original.bones[i].matrixWorld);
          else matrix.identity();
          if (attached) offsetMatrix(matrix, displacement);
        }
      }
      for (const [node, ghost] of objects) {
        ghost.matrix.copy(node.matrixWorld);
        offsetMatrix(ghost.matrix, displacement);
        ghost.matrixWorldNeedsUpdate = true;
      }
    },
    dispose() {
      meshes.removeFromParent();
      material.dispose();
      for (const { skeleton } of skeletons.values()) skeleton.dispose();
    },
  };
}

function offsetMatrix(matrix, displacement) {
  matrix.elements[12] += displacement.x;
  matrix.elements[13] += displacement.y;
  matrix.elements[14] += displacement.z;
}

function makeWindTrail() {
  const bands = 9;
  const attributes = new Float32Array(bands * 6 * 3);
  const color = new Float32Array(attributes.length);
  for (let i = 0; i < bands; i++) {
    for (const [j, gain] of [0,.1,.8,.1,1,.8].entries()) {
      cyan.clone().multiplyScalar(gain).toArray(color,(i * 6 + j) * 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(attributes,3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(color,3));
  const material = new THREE.MeshBasicMaterial({
    precision: 'highp', vertexColors: true, side: THREE.DoubleSide, toneMapped: false,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
  });
  const mesh = guardFromAO(new THREE.Mesh(geometry,material),material);
  mesh.name = 'perfect-dodge-wind';
  mesh.frustumCulled = false;
  mesh.renderOrder = 15;
  mesh.visible = false;

  const side = new THREE.Vector3();
  const tail = new THREE.Vector3(), head = new THREE.Vector3(), mid = new THREE.Vector3();
  const top = new THREE.Vector3(), low = new THREE.Vector3();
  return {
    mesh,
    update(origin,current,direction,age) {
      const distance = current.distanceTo(origin);
      const length = clamp(distance + .28,.35,2.45);
      side.set(direction.z,0,-direction.x);
      for (let i = 0; i < bands; i++) {
        const fraction = i / (bands - 1);
        const height = .16 + fraction * 1.12;
        const offset = Math.sin(i * 2.4) * (.21 + fraction * .19);
        head.copy(current).addScaledVector(side,offset).addScaledVector(direction,-.17 - (i % 3) * .11);
        head.y += height;
        tail.copy(head).addScaledVector(direction,-length * (.47 + .53 * Math.sin(fraction * Math.PI)));
        tail.y -= .05;
        mid.copy(tail).lerp(head,.54);
        mid.y += .04 * Math.sin(i);
        const thickness = .009 + .014 * Math.sin(fraction * Math.PI);
        top.copy(mid).y += thickness;
        low.copy(mid).y -= thickness;
        for (const [j, point] of [tail,low,head,low,top,head].entries()) {
          point.toArray(attributes,(i * 6 + j) * 3);
        }
      }
      geometry.attributes.position.needsUpdate = true;
      material.opacity = .81 * smoothstep(age,0,.035) * (1 - smoothstep(age,.10,.44));
      mesh.visible = material.opacity > .005;
    },
  };
}

export class PerfectDodgeEffect {
  constructor(scene) {
    this.scene = scene;
    this.trail = makeWindTrail();
    scene.add(this.trail.mesh);
    this.echoes = [];
    this.pool = [];
    this.displacement = new THREE.Vector3();
    this.pass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
      vertexShader: 'varying vec2 p; void main(){ p=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float strength;
        varying vec2 p;
        void main() {
          vec2 d = p - .5;
          float mask = smoothstep(.24,.65,length(d)) * strength;
          vec4 s = texture2D(tDiffuse,p);
          vec3 edge = texture2D(tDiffuse,clamp(p - d * mask * .03,0.,1.)).rgb;
          float luma = dot(edge,vec3(.2126,.7152,.0722));
          vec3 blue = mix(edge,vec3(luma) * vec3(.71,.90,1.16),.56);
          gl_FragColor = vec4(mix(s.rgb,blue * .83,mask),s.a);
        }`,
    });
    this.pass.material.precision = 'highp';
    this.pass.enabled = false;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  }

  prepare(source, renderer, camera, target) {
    if (this.source === source) return;
    this.clear();
    for (const echo of this.pool) echo.dispose();
    this.source = source;
    this.pool = Array.from({ length: 3 }, () => prepareEcho(source, renderer));
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    try {
      for (const echo of this.pool) renderer.compile(echo.meshes, camera, this.scene);
      renderer.compile(this.trail.mesh, camera, this.scene);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
  }

  trigger(origin,direction) {
    this.clear();
    this.start = { origin: origin.clone(), direction: direction.clone(), age: 0, nextEcho: 0 };
  }

  update(dt, actor) {
    const active = this.start;
    if (active) {
      active.age += dt;
      const { age, origin, direction } = active;
      const position = actor.mesh.group.position;
      this.pass.enabled = !this.reducedMotion.matches && age < .34;
      this.pass.uniforms.strength.value = .79 * smoothstep(age,0,.046) * (1 - smoothstep(age,.09,.34));
      this.trail.update(origin, position, direction, age);
      if (active.nextEcho < this.pool.length && age >= active.nextEcho * .064) {
        const echo = this.pool[active.nextEcho];
        this.source.updateWorldMatrix(true, true);
        if (active.nextEcho === 0) this.displacement.copy(origin).sub(position);
        else this.displacement.copy(direction).multiplyScalar(-.17);
        echo.capture(this.displacement, lerp(.86,.43,active.nextEcho / 2));
        this.scene.add(echo.meshes);
        this.echoes.push(echo);
        active.nextEcho++;
      }
      if (age >= .44) this.start = null;
    }
    for (let i = this.echoes.length - 1; i >= 0; i--) {
      const echo = this.echoes[i];
      echo.age += dt;
      if (echo.age >= .42) {
        echo.meshes.removeFromParent();
        this.echoes.splice(i,1);
        continue;
      }
      echo.material.uniforms.time.value = echo.age;
      echo.material.uniforms.fade.value = echo.strength * smoothstep(echo.age,0,.032) * (1 - smoothstep(echo.age,.055,.42));
    }
  }

  clear() {
    this.start = null;
    this.pass.enabled = false;
    this.trail.mesh.visible = false;
    for (const echo of this.echoes) echo.meshes.removeFromParent();
    this.echoes.length = 0;
  }
}
