import * as THREE from 'three';

const noise = `
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 h = fract(sin(dot(i, vec2(127.1, 311.7)) + vec4(0.0, 127.1, 311.7, 438.8)) * 43758.5453);
  return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
}`;

export function chippedStone(radiusTop, radiusBottom, height, depth = 0.09, flutes = 0, cut = 0) {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, flutes * 6 || 22, 5);
  const points = geometry.attributes.position;
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), z = points.getZ(i);
    const radius = Math.hypot(x, z);
    if (radius < 0.0001) continue;
    const a = Math.atan2(z, x), t = y / height + 0.5;
    const wear = Math.sin(a * 7 + t * 13) * Math.cos(a * 11 - t * 9);
    const groove = flutes ? (1 - Math.cos(a * flutes)) * .5 : 0;
    const scale = 1 + wear * depth - groove * .043;
    const broken = cut * Math.pow(t, 6) * (.50 + .25 * Math.sin(a * 4) + .25 * Math.cos(a * 7));
    points.setXYZ(i, x * scale, y - broken, z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function fracturedRock() {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + .20 * Math.sin(x * 10 + z * 6) * Math.cos(y * 7 - z * 8);
    p.setXYZ(i, x * k + y * .21, y * k, z * k - y * .13);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function carvedRobe() {
  const profile = [[1.92, 0], [1.94, .22], [1.63, 1.15], [1.40, 2.7], [1.03, 4.35],
    [.94, 5.05], [1.34, 5.72], [1.38, 6.20], [.78, 6.55]].map(p => new THREE.Vector2(...p));
  const geometry = new THREE.LatheGeometry(profile, 70);
  const points = geometry.attributes.position;
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), z = points.getZ(i), a = Math.atan2(z, x);
    const fold = Math.sin(a * 11 + y * .29) * .12 + Math.cos(a * 17 - y * .67) * .055;
    const weight = 1 - THREE.MathUtils.smoothstep(y, 0.2, 5.9) * .77;
    points.setXYZ(i, x * (1 + fold * weight) + Math.sin(y * .65) * .18,
      y + Math.sin(a * 6) * .045, (z * (1 + fold * weight) + Math.sin(a * 3 + y) * .04) * .77);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function wovenCloth(map, wind) {
  const material = new THREE.MeshStandardMaterial({
    map, roughness: .96, alphaTest: .46, side: THREE.DoubleSide, emissive: 0x230810, emissiveIntensity: .44,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.windTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float freeHem = pow(1.0 - uv.y, 1.45);
        float gust = windTime * 1.45 + dot(modelMatrix[3].xz, vec2(.38,.21));
        float wave = gust + uv.x * 4.4 - uv.y * 6.1;
        objectNormal.x -= (cos(wave) * 0.52 * freeHem + cos(uv.x * 22.0) * 0.43);
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.x += freeHem * sin(gust * .54 + uv.y * 3.2) * .22;
        transformed.z += (sin(wave) * .37 + .12 * sin(gust * .67 - uv.y * 8.0)) * freeHem
          + sin(uv.x * 22.0) * (.039 + .028 * freeHem);
      `);
  };
  return material;
}

export function brazierFlame(clock, blood) {
  return new THREE.ShaderMaterial({
    precision: 'highp', transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { time: clock, blood },
    vertexShader: `
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv=uv;
        vSeed=dot(modelMatrix[3].xz,vec2(.31,.73));
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      varying float vSeed;
      uniform float time, blood;
      ${noise}
      void main() {
        vec2 uv=vUv;
        float t=time+vSeed, y=uv.y, x=uv.x-.5;
        float wind=(noise(vec2(t*1.5-y*3.2, vSeed))-.43)*y*.45;
        float d=noise(vec2((x-wind)*8.0,y*7.3-t*3.8));
        float tendrils=noise(vec2((x-wind)*16.0+5.1,y*10.5-t*5.1));
        float width=mix(.38,.022,smoothstep(0.0,.71,y));
        float flame=(width-abs(x-wind))*4.3 + (d-.45)*.61 + (tendrils-.5)*.23 - y*.76;
        float alpha=smoothstep(0.0,.33,flame)*smoothstep(0.,.08,y)*(1.0-smoothstep(.51,.78,y));
        float core=smoothstep(.16, .81, flame);
        vec3 cool=mix(vec3(1.0,.145,.017),vec3(1.0,.035,.12),blood);
        vec3 warm=mix(vec3(1.0,.75,.22),vec3(1.0,.37,.40),blood);
        vec3 light=mix(cool,warm,core);
        float smoke=(1.-smoothstep(.04,.40,abs(x-wind)))
          * smoothstep(.35,.67,y)*(1.-smoothstep(.68,1.,y)) * d * .22;
        gl_FragColor=vec4(mix(vec3(.19,.16,.19),light,alpha/(alpha+smoke+.001)),alpha+smoke);
      }`,
  });
}

export function cloudLayer(radius, color, clock, blood, opacity, drift) {
  const material = new THREE.ShaderMaterial({
    precision: 'highp', transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { color: { value: new THREE.Color(color) }, time: clock, blood, opacity: { value: opacity },
      drift: { value: drift } },
    vertexShader: `
      varying vec2 vCloud;
      void main(){
        vCloud=position.xy;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: `
      varying vec2 vCloud;
      uniform float time, blood, opacity, drift;
      uniform vec3 color;
      ${noise}
      void main(){
        vec2 p=vCloud*.021+vec2(time*.045*drift, time*.021)+vec2(drift*9.,-drift*5.);
        float cloud=.61*noise(p)+.29*noise(p*2.4+12.0)+.10*noise(p*6.0);
        float a=smoothstep(.32,.75,cloud)*opacity*(1.-smoothstep(380.,740.,length(vCloud)));
        vec3 tint=mix(color,vec3(.29,.11,.17),blood*.56);
        gl_FragColor=vec4(tint*(.72+.44*cloud),a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), material);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}
