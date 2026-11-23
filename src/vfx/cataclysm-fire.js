import * as THREE from 'three';
import { guardFromAO } from './ao-guard.js';

const SPREAD_SECONDS = .98;
const BURN_SECONDS = 2.35;

const noiseGLSL = `
  float hash(vec2 p) {
    vec3 n=fract(vec3(p.xyx)*.1031);
    n+=dot(n,n.yzx+33.33);
    return fract((n.x+n.y)*n.z);
  }
  float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p);
    f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),
               mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
  }
  float turbulence(vec2 p) {
    return .57*noise(p)+.29*noise(p*2.17+4.)+.14*noise(p*4.43-5.);
  }
`;

const speedGLSL = `
  uniform float time, power, radius, spread;
  float arrival(float d) {
    float progress=clamp((d-1.7)/(radius+.55-1.7),0.,1.);
    return spread*(1.-pow(1.-progress,1./1.48));
  }
`;

const coverGLSL = `
  #if COVER_COUNT > 0
  uniform vec4 coverFrame[COVER_COUNT];
  uniform vec2 coverSize[COVER_COUNT];
  #endif
  float exposure(vec2 p) {
    float result=1.;
    #if COVER_COUNT > 0
    for(int i=0;i<COVER_COUNT;i++) {
      vec2 d=p-coverFrame[i].xy, radial=coverFrame[i].zw;
      vec2 local=vec2(dot(d,vec2(radial.y,-radial.x)),dot(d,radial))/coverSize[i];
      result=min(result,smoothstep(.68,1.37,dot(local,local)));
    }
    #endif
    return result;
  }
`;

const floorVertex = `
  varying vec2 vFloor;
  void main() {
    vFloor=position.xz;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }
`;

const floorFragment = `
  ${noiseGLSL}
  ${speedGLSL}
  ${coverGLSL}
  varying vec2 vFloor;
  void main() {
    float d=length(vFloor);
    float burn=time-arrival(d);
    if(d>radius || burn<0. || burn>1.36) discard;

    vec2 radial=vFloor/max(d,.01);
    vec2 advect=vFloor-radial*burn*1.9;
    float grade=turbulence(advect*1.95);
    float charred=turbulence(vFloor*3.1+14.);
    float freckle=noise(vFloor*13.-time*radial*3.7);
    float flame=smoothstep(.25,.83,grade*.8+freckle*.29);
    float ignite=smoothstep(0.,.095,burn);
    float cooling=1.-smoothstep(.19,1.36,burn);
    float hot=pow(flame,1.69)*ignite*cooling;
    float crust=smoothstep(.37,.63,charred)*ignite*cooling;
    vec3 base=mix(vec3(.078,.016,.013),vec3(.35,.035,.012),crust);
    vec3 glow=mix(vec3(.83,.085,.007),vec3(1.32,.42,.045),hot);
    gl_FragColor=vec4(base+glow*hot,power*(.17*crust+.57*hot)*exposure(vFloor));
  }
`;

const tongueVertex = `
  ${noiseGLSL}
  ${speedGLSL}
  ${coverGLSL}
  uniform float smoke;
  attribute vec4 plume;
  varying vec2 vUv;
  varying float seed, life, eyeDistance;
  void main() {
    float angle=plume.x;
    seed=plume.y;
    vUv=uv;
    float front=clamp(time/spread,0.,1.);
    front=1.-pow(1.-front,1.48);
    float head=mix(1.7,radius+.55,front);
    float band=plume.z*mix(1.4,5.4,front)+smoke*1.2;
    float a=angle+.028*sin(seed*47.+time*4.);
    vec2 dir=vec2(cos(a),sin(a));
    float rough=noise(vec2(seed*93.,time*.83));
    float surge=noise(dir*4.1+vec2(time*.38,time*.28));
    float d=clamp(head-band+(surge-.5)*3.0+(rough-.5)*.81,.43,radius-.16);
    float burn=time-arrival(d);
    float rise=smoothstep(-.025,.14,burn);
    life=rise*(1.-smoothstep(.35+smoke*.27,1.06+smoke*.58,burn))*exposure(dir*d);
    float swell=.58+rough*.55+.24*sin(time*9.+seed*38.);
    float height=(.63+seed*1.54+smoke*.88)*swell*(.58+life*.42);
    float v=uv.y;
    float lean=v*(.2+v*.94)*(.6+seed*.66);
    vec2 tangent=vec2(-dir.y,dir.x);
    vec2 axis=mix(tangent,normalize(tangent*.30+dir),plume.w);
    float width=(.45+seed*.58+smoke*.45)*mix(.75,1.65,front);
    vec2 plane=dir*(d+lean)+tangent*sin(seed*33.+v*3.2+time*5.)*v*.50;
    plane+=axis*(uv.x-.5)*width*2.;
    vec3 pos=vec3(plane.x,.08+v*height,plane.y);
    vec4 view=modelViewMatrix*vec4(pos,1.);
    eyeDistance=-view.z;
    gl_Position=projectionMatrix*view;
  }
`;

const tongueFragment = `
  ${noiseGLSL}
  uniform float time, power, smoke;
  varying vec2 vUv;
  varying float seed, life, eyeDistance;
  void main() {
    if(life<=.001) discard;
    float y=vUv.y;
    vec2 p=vec2(vUv.x*5.+seed*219.,y*3.3-time*4.);
    float billow=turbulence(p+vec2(noise(p.yx+13.)*1.9,0.));
    float licks=noise(p*1.91+vec2(billow*2.1,-time*.7));
    float drift=(billow-.5)*.44+(licks-.5)*.25;
    float x=abs(vUv.x-.5+drift*y);
    float tip=.52+.45*turbulence(vec2(seed*181.+vUv.x*4.,time*3.));
    float width=mix(.46,.13,y)+smoke*.035;
    float borders=smoothstep(.015,.17,min(vUv.x,1.-vUv.x));
    float shape=borders*(1.-smoothstep(width*.41,width,x))*(1.-smoothstep(tip-.21,tip,y));
    float ignition=smoothstep(.22,.73,billow*.69+licks*.46 + (1.-y)*.21);
    float holes=smoothstep(.13,.63,billow+(1.-y)*.30);
    float mask=shape*mix(ignition,holes,smoke)*smoothstep(0.,.12,y);
    float filaments=noise(p*vec2(4.3,1.6)+vec2(billow*1.5,-time*.80));
    float hot=smoothstep(.53,.97,ignition*.76+filaments*.27+(1.-y)*.17);
    vec3 flame=mix(vec3(.48,.021,.003),vec3(1.18,.227,.015),hot);
    flame=mix(flame,vec3(1.38,.74,.206),hot*hot*(1.-y)*.54);
    vec3 ash=mix(vec3(.048,.016,.014),vec3(.16,.036,.016),billow);
    float fade=smoothstep(1.35,3.65,eyeDistance);
    gl_FragColor=vec4(mix(flame,ash,smoke),power*life*mask*fade*mix(.78,.54,smoke));
  }
`;

const emberVertex = `
  ${speedGLSL}
  uniform float viewScale;
  attribute vec4 spark;
  varying float shine, seed;
  void main() {
    seed=spark.y;
    float age=time-arrival(spark.z)-spark.w*.16;
    shine=smoothstep(0.,.075,age)*(1.-smoothstep(.32,.51+seed*.62,age));
    float d=min(radius+.24,spark.z+max(age,0.)*(.9+seed*6.4));
    float a=spark.x+age*(spark.w-.5)*.53;
    float y=max(.09,age*(1.1+seed*5.6)-age*age*2.4);
    vec4 view=modelViewMatrix*vec4(cos(a)*d,y,sin(a)*d,1.);
    gl_Position=projectionMatrix*view;
    gl_PointSize=shine>0. ? clamp(viewScale*(2.0+5.5*seed)/max(1.,-view.z),1.,8.) : 0.;
  }
`;

const emberFragment = `
  uniform float power;
  varying float shine, seed;
  void main() {
    vec2 uv=(gl_PointCoord-.5)*vec2(3.7,2.1);
    float core=exp(-dot(uv,uv)*3.5)*(1.-smoothstep(.35,.5,abs(gl_PointCoord.y-.5)));
    gl_FragColor=vec4(mix(vec3(1.,.19,.014),vec3(1.,.89,.44),core),core*shine*power);
  }
`;

function material(uniforms, vertexShader, fragmentShader, blending = THREE.NormalBlending) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, blending,
    precision: 'highp', transparent: true, depthWrite: false, toneMapped: false,
    side: THREE.DoubleSide, forceSinglePass: true,
  });
}

function plumes(tracks, bands) {
  const quad = new THREE.PlaneGeometry(2, 1, 3, 5);
  const geometry = new THREE.InstancedBufferGeometry().copy(quad);
  quad.dispose();
  const values = [];
  for (let i = 0; i < tracks; i++) {
    for (let band = 0; band < bands; band++) {
      const seed = (1 + (i * 43 + band * 67) % 233) / 234;
      const angle = (i + seed*.87 + band*.37)/tracks * Math.PI * 2;
      const lane = (band + seed*.86)/bands;
      values.push(angle,seed,lane,0, angle,seed,lane,1);
    }
  }
  geometry.setAttribute('plume', new THREE.InstancedBufferAttribute(new Float32Array(values),4));
  geometry.instanceCount = values.length / 4;
  return geometry;
}

export function createCataclysmFire(radius, shelters) {
  const root = new THREE.Group();
  root.name = 'cataclysm-fire-surge';
  const uniforms = {
    time: { value: 0 }, power: { value: 0 }, radius: { value: radius }, spread: { value: SPREAD_SECONDS },
    coverFrame: { value: shelters.map(({x,z,radialX,radialZ}) => new THREE.Vector4(x,z,radialX,radialZ)) },
    coverSize: { value: shelters.map(({width,depth}) => new THREE.Vector2(width,depth)) },
  };

  const floor = new THREE.PlaneGeometry(radius*2,radius*2).rotateX(-Math.PI/2).translate(0,.089,0);
  const floorMaterial = material(uniforms, floorVertex, floorFragment);
  floorMaterial.defines.COVER_COUNT = shelters.length;
  const ground = guardFromAO(new THREE.Mesh(floor,floorMaterial),floorMaterial);
  ground.name = 'cataclysm-burning-ground';
  ground.renderOrder = 10;
  root.add(ground);

  for (const smoke of [1,0]) {
    const shader = material({ ...uniforms, smoke: { value: smoke } }, tongueVertex, tongueFragment);
    shader.defines.COVER_COUNT = shelters.length;
    const volume = guardFromAO(new THREE.Mesh(plumes(smoke ? 68 : 136,smoke ? 2 : 3),shader),shader);
    volume.name = smoke ? 'cataclysm-hot-ash' : 'cataclysm-rolling-flames';
    volume.frustumCulled = false;
    volume.renderOrder = smoke ? 11 : 12;
    root.add(volume);
  }

  const emberGeo = new THREE.BufferGeometry();
  const emberCount = 384;
  const sparks = [];
  for (let i = 0; i < emberCount; i++) {
    const seed = (i*31%191)/191;
    sparks.push(i*2.39996323,seed,1.8+(radius-2.05)*Math.sqrt((i*79%389)/389),(i*151%383)/383);
  }
  emberGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(emberCount*3),3));
  emberGeo.setAttribute('spark', new THREE.Float32BufferAttribute(sparks,4));
  const viewScale = { value: 10 };
  const emberMaterial = material({ ...uniforms, viewScale },emberVertex,emberFragment,THREE.AdditiveBlending);
  const embers = guardFromAO(new THREE.Points(emberGeo,emberMaterial),emberMaterial);
  embers.name = 'cataclysm-blown-embers';
  embers.frustumCulled = false;
  embers.renderOrder = 13;
  root.add(embers);

  return {
    root,
    update(age, intensity, pixelRatio) {
      root.visible = age < BURN_SECONDS && intensity > 0;
      if (!root.visible) return;
      uniforms.time.value = age;
      uniforms.power.value = Math.min(1,intensity);
      viewScale.value = 10*pixelRatio;
    },
  };
}
