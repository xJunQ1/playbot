import * as THREE from 'three';
import { guardFromAO } from './ao-guard.js';

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

export function createMeteorLanding(scene, position) {
  const root = new THREE.Group();
  root.name = 'boss-meteor-landing';
  root.position.copy(position);
  scene.add(root);

  // A camera-facing plume with a white-hot core and thinner, curling red filaments.
  const plume = sheet(6.1, 8.8, `
    varying vec2 vUv;
    uniform float time, strength;
    void main() {
      float y = vUv.y, x = vUv.x * 2.0 - 1.0;
      float h = max(0.0, y - 0.12);
      float head = length(vec2(x * 1.45, (y - 0.12) * 5.7));
      x += (sin(15.0*y - 9.0*time) + 0.5*sin(27.0*y + 12.0*time)) * h * 0.13;
      float line = exp(-abs(x) / (0.032 + 0.110 * (1.0-y))) * smoothstep(0.06, 0.14, y);
      float ember = exp(-abs(abs(x) - (0.13 + h*0.30 + 0.045*sin(26.0*y - 13.0*time))) * 47.0);
      float fade = 1.0 - smoothstep(0.46, 0.99, y);
      float flame = (line + 0.38 * ember * smoothstep(0.09, 0.24, y)) * fade;
      float glow = exp(-3.6*head) + exp(-abs(x)*5.0) * fade * smoothstep(0.06,0.14,y);
      float core = exp(-head*8.0) + line*line*fade;
      vec3 light = vec3(1.0,0.009,0.026)*(glow*0.70 + flame) + vec3(1.0,0.83,0.76)*core*1.45;
      float feather = smoothstep(0.0,0.10,y) * (1.0-smoothstep(0.78,1.0,abs(vUv.x*2.0-1.0)));
      gl_FragColor = vec4(light, strength*feather);
    }`, true);
  plume.name = 'boss-meteor-tail';
  root.add(plume);

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

  const crater = sheet(5.3, 5.3, `
    varying vec2 vUv;
    uniform float time, strength;
    void main() {
      vec2 p = vUv*2.0 - 1.0;
      float a = atan(p.y,p.x), r = length(p);
      float rim = 0.70 + 0.045*sin(7.0*a) + 0.034*sin(13.0*a+0.6) + 0.025*sin(23.0*a);
      float grain = fract(sin(dot(floor(p*130.0),vec2(17.1,31.7)))*437.13);
      float basin = 1.0 - smoothstep(rim-0.15,rim,r);
      float lip = 1.0-smoothstep(0.01,0.085,abs(r-rim+0.035));
      float seam = abs(sin(a*8.0 + 1.3*sin(a*3.0) + 0.75*sin(r*17.0+a)));
      float cracks = (1.0-smoothstep(0.014,0.09,seam))*smoothstep(0.12,0.46,r)*(1.0-smoothstep(rim,rim+0.23,r));
      float heat = exp(-1.7*time);
      vec3 color = mix(vec3(0.045,0.027,0.045), vec3(0.17,0.11,0.14),r) * (0.7 + grain*0.42);
      color += lip * (0.25 + 0.15*sin(a-1.0))*vec3(0.66,0.46,0.45);
      color = mix(color,vec3(0.016,0.004,0.008) + heat*vec3(1.0,0.048,0.007),cracks);
      float alpha = max(max(basin*0.94,lip),cracks);
      gl_FragColor = vec4(color, alpha*strength);
    }`);
  crater.name = 'boss-impact-crater';
  crater.rotation.x = -Math.PI/2;
  crater.position.y = 0.052;
  root.add(crater);

  const shock = sheet(2, 2, `
    varying vec2 vUv;
    uniform float strength, time;
    void main() {
      vec2 p = vUv*2.0-1.0;
      float a = atan(p.y,p.x);
      float r = length(p) + 0.012*sin(a*13.0+time*6.0) + 0.007*sin(a*23.0);
      float rim = exp(-abs(r-0.85)*39.0);
      float dust = exp(-abs(r-0.72)*10.0)*(0.60+0.27*sin(a*11.0));
      gl_FragColor = vec4(vec3(1.0,0.10,0.055)*rim + vec3(0.62,0.19,0.14)*dust, strength);
    }`, true);
  shock.rotation.x = -Math.PI/2;
  shock.position.y = 0.086;
  root.add(shock);

  const rockGeometry = new THREE.IcosahedronGeometry(1,0);
  // Baked facet colors keep the broken stone readable against the arena's dark floor.
  const normals = rockGeometry.getAttribute('normal');
  const colors = [], color = new THREE.Color();
  for (let i = 0; i < normals.count; i++) {
    const light = 0.71+0.29*normals.getY(i)+0.13*normals.getX(i);
    color.setHex(0x67536c).multiplyScalar(light);
    colors.push(color.r,color.g,color.b);
  }
  rockGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const rockMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, precision: 'highp' });
  const count = 62;
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, count);
  rocks.name = 'boss-impact-rubble';
  rocks.frustumCulled = false;
  rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(rocks);
  const dummy = new THREE.Object3D();
  const fragments = Array.from({length:count}, (_,i) => {
    const angle = i*2.39996, chip = i >= 32;
    const noise = (i*37 % 59)/59;
    return { x: Math.cos(angle), z: Math.sin(angle), angle, chip,
      radius: (chip ? 0.75 : 1.75) + noise*(chip ? 1.65 : 0.49),
      size: chip ? 0.055 + noise*0.13 : 0.12 + noise*0.20,
      flight: 0.45 + noise*0.48, height: 0.42 + noise*1.1 };
  });

  return {
    update(age, sinceImpact, altitude, camera, opacity) {
      const airborne = sinceImpact < 0;
      plume.visible = sinceImpact < 0.20;
      if (plume.visible) {
        plume.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,
          Math.atan2(camera.position.x-position.x, camera.position.z-position.z));
        plume.position.y = altitude + 4.24;
        plume.material.uniforms.time.value = age;
        plume.material.uniforms.strength.value = 1.30*(1-smoothstep(sinceImpact,0,0.20));
      }
      crater.visible = rocks.visible = !airborne;
      flare.visible = !airborne && sinceImpact < 0.30;
      if (flare.visible) {
        flare.quaternion.copy(camera.quaternion);
        flare.material.uniforms.strength.value = 2.4*(1-smoothstep(sinceImpact,0,0.30));
      }
      shock.visible = !airborne && sinceImpact < 0.68;
      if (airborne) return;
      crater.scale.setScalar(lerp(0.43,1,smoothstep(sinceImpact,0,0.15)));
      crater.material.uniforms.strength.value = opacity;
      crater.material.uniforms.time.value = sinceImpact;
      if (shock.visible) {
        shock.scale.setScalar(0.45 + 4.2*(1-(1-sinceImpact/0.68)**2));
        shock.material.uniforms.time.value = sinceImpact;
        shock.material.uniforms.strength.value = 1.7*(1-smoothstep(sinceImpact,0,0.68));
      }
      fragments.forEach(({x,z,angle,chip,radius,size,flight,height},i) => {
        const t = Math.min(1,sinceImpact/flight);
        const spread = chip ? lerp(0.38,radius+0.9,t) : radius*lerp(0.80,1,smoothstep(t,0,0.42));
        const lift = chip ? height*4*t*(1-t) : 0.11*Math.sin(Math.PI*t);
        dummy.position.set(x*spread,0.04+lift+size*0.17-(1-opacity)*size*1.8,z*spread);
        dummy.rotation.set(0.27+0.63*t,angle+0.82*t,(chip ? 2.6*t : 0.32)*x);
        dummy.scale.set(size*1.30,size*0.52,size*0.93);
        dummy.updateMatrix();
        rocks.setMatrixAt(i,dummy.matrix);
      });
      rocks.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      rocks.dispose();
      for (const mesh of root.children) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
