import * as THREE from 'three';
import { guardFromAO } from './ao-guard.js';
import { preparePoseEcho } from './perfect-dodge.js';
import { ULTIMATE_CUTS, ULTIMATE_KICKS, FINISHER, finisherRun } from '../ultimate.js';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const SWORD_CUTS = ULTIMATE_CUTS.filter(cut => cut !== FINISHER);
const KICK_ECHO_FRAMES = [-7, -3, 2];
const KICK_ECHO_PALETTE = { inner: [.27,.035,.65], rim: [.78,.37,1.] };

const NOISE = `
  float hash(vec2 v) {
    vec3 p=fract(vec3(v.xyx)*.1031);
    p+=dot(p,p.yzx+33.33);
    return fract((p.x+p.y)*p.z);
  }
  float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p);
    f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),
               mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
  }
  float bell(float x) { return exp(-x*x); }
`;

function lightMaterial(uniforms, vertexShader, fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false,
    toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    forceSinglePass: true, precision: 'highp',
  });
}

function createFlakes(root) {
  const count = 420;
  const positions = new Float32Array(count * 3);
  const gains = new Float32Array(count);
  const angles = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('gain', new THREE.BufferAttribute(gains,1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('angle', new THREE.BufferAttribute(angles,1).setUsage(THREE.DynamicDrawUsage));
  const uniforms = { intensity: { value: 1 }, pixels: { value: 1 } };
  const material = lightMaterial(uniforms, `
    uniform float pixels;
    attribute float gain,angle;
    varying float strength,rotation;
    void main() {
      vec4 view=modelViewMatrix*vec4(position,1.);
      strength=gain;
      rotation=angle;
      gl_Position=projectionMatrix*view;
      gl_PointSize=clamp(pixels*(3.5+gain*8.) / max(.95,-view.z*.19),1.,15.);
    }
  `, `
    uniform float intensity;
    varying float strength,rotation;
    void main() {
      if(strength<.004) discard;
      vec2 uv=gl_PointCoord-.5;
      float c=cos(rotation),s=sin(rotation);
      vec2 p=mat2(c,-s,s,c)*uv;
      float shard=1.-smoothstep(.26,.54,abs(p.x)*.76+abs(p.y)*3.0);
      float glint=exp(-dot(uv,uv)*26.);
      gl_FragColor=vec4(vec3(.88,.93,1.)*(shard*1.35+glint*.32),intensity*strength);
    }
  `);
  const mesh = guardFromAO(new THREE.Points(geometry, material), material);
  mesh.name = 'ultimate-silver-flakes';
  mesh.renderOrder = 18;
  mesh.frustumCulled = false;
  root.add(mesh);
  const flakes = Array.from({ length: count }, () => ({
    p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, age: 0, gain: 0,
  }));
  let cursor = 0, seed = 35617;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  return {
    emit(point, drift, power) {
      const i = cursor++ % count;
      const f = flakes[i];
      f.p.copy(point);
      f.v.copy(drift).multiplyScalar(.24 + random()*.54);
      f.v.x += (random()-.5)*2.8;
      f.v.z += (random()-.5)*2.8;
      f.v.y += random()*2.2 - .40;
      f.age = 0;
      f.life = .30 + random()*.64;
      f.gain = power*(.33 + random()*.67);
      angles[i] = random() * Math.PI;
    },
    update(dt, power, pixels) {
      uniforms.intensity.value = power;
      uniforms.pixels.value = pixels;
      for (let i=0; i<count; i++) {
        const f=flakes[i];
        f.age += dt;
        gains[i]=0;
        if (f.age >= f.life) continue;
        f.v.y -= dt * 3.0;
        f.p.addScaledVector(f.v,dt);
        f.p.y = Math.max(.075,f.p.y);
        f.p.toArray(positions,i*3);
        const t=f.age/f.life;
        gains[i]=f.gain*(1.-smoothstep(.06,1.,t));
      }
      for (const name of ['position','gain','angle']) geometry.attributes[name].needsUpdate = true;
    },
    clear() { for (const f of flakes) f.life = 0; },
  };
}


const CRYSTAL = `
  ${NOISE}

  // The gap between the nearest sites traces the edges of irregular facets.
  vec2 facets(vec2 p) {
    vec2 cell=floor(p), f=fract(p);
    float nearDist=9., nextDist=9., shade=0.;
    for(int y=-1;y<=1;y++) {
      for(int x=-1;x<=1;x++) {
        vec2 tile=vec2(float(x),float(y));
        vec2 id=cell+tile;
        vec2 offset=.15+.70*vec2(hash(id),hash(id+37.));
        vec2 r=tile+offset-f;
        float d=dot(r,r);
        if(d<nearDist) {
          nextDist=nearDist;
          nearDist=d;
          shade=hash(id+81.);
        } else {
          nextDist=min(nextDist,d);
        }
      }
    }
    return vec2(shade,nextDist-nearDist);
  }
`;

function crystalMaterial(finisher) {
  const uniforms = { power: { value: 0 }, age: { value: 0 }, head: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms, defines: finisher ? { FINISHER_CRYSTAL: 1 } : {},
    transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 viewPoint, viewNormal;
      void main() {
        vUv=uv;
        vec4 p=modelViewMatrix*vec4(position,1.);
        viewPoint=p.xyz;
        viewNormal=normalMatrix*normal;
        gl_Position=projectionMatrix*p;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 viewPoint, viewNormal;
      uniform float power,age,head;
      ${CRYSTAL}
      void main() {
        float u=vUv.x,v=vUv.y;
        #ifdef FINISHER_CRYSTAL
          float arcEnd=smoothstep(0.,.065,u)*(1.-smoothstep(.94,1.,u));
          float heat=.44+.56*(1.-smoothstep(.24,.93,u));
          float warp=noise(vec2(u*15.,v*8.));
          vec2 split=facets(vec2(u*10.1-v*2.3 + warp*.68,v*4.2+u*5.4));
          float inner=.28+.20*(split.x-.36);
          float life=1.;
        #else
          float lag=max(0.,head-u);
          float arcEnd=smoothstep(.0,.16,u)*(1.-smoothstep(.975,1.012,u));
          float heat=.49+.51*bell((lag-.12)*4.4);
          float warp=noise(vec2(u*23.,v*7.));
          vec2 split=facets(vec2(u*16.2-v*2.1 + warp*.58,v*3.6+u*4.9));
          float inner=.43+.17*(split.x-.29);
          float life=smoothstep(.0,.06,lag)*(1.-age*.26);
        #endif
        vec3 normal=viewNormal/max(.0001,length(viewNormal));
        float angle=clamp(abs(dot(normal,normalize(-viewPoint))),0.,1.);
        float facing=.53+.47*abs(dot(normal,normalize(vec3(-.37,.59,.78))));
        float glint=noise(vec2(u*61.+v*4.,v*11.0-age*2.));
        float rim=abs(v-(.938+.018*(warp-.5)));
        float edge=bell(rim*45.);
        float edgeAura=bell(rim*10.5);
        float seam=1.-smoothstep(.015,.12,split.y);
        float crack=seam*smoothstep(.30,.75,glint)*smoothstep(inner,.69,v);
        float vein=bell((v-.43-(warp-.5)*.34)*24.)*smoothstep(.43,.82,glint);
        float body=smoothstep(inner-.055,inner+.12,v);
        float cutout=smoothstep(.12,.36,split.x+v*.24);
        body*=mix(cutout,1.,smoothstep(.59,.96,v));

        #ifdef FINISHER_CRYSTAL
          vec3 cold=vec3(.045,.012,.12);
          vec3 crystal=vec3(.27,.046,.71);
          vec3 spark=vec3(.66,.24,1.22);
        #else
          vec3 cold=vec3(.043,.033,.11);
          vec3 crystal=vec3(.29,.19,.57);
          vec3 spark=vec3(.71,.48,1.08);
        #endif
        vec3 rock=mix(cold,crystal,split.x*split.x)*facing;
        rock+=crystal*(.12*glint+.10*angle+.14*(1.-angle)*body);
        vec3 color=rock*(.77+.30*heat);
        color+=spark*(crack*heat*.57+edgeAura*.53+vein*.24);
        color+=vec3(1.0,.89,1.17)*edge*(.7+heat*1.05);
        #ifndef FINISHER_CRYSTAL
          // Close sweeps soften before crossing the eye, revealing the two fighters.
          life*=smoothstep(.58,2.35,-viewPoint.z);
          body*=.68+.26*split.x;
        #endif
        float alpha=clamp(power*arcEnd*life*max(body*.92,edgeAura)*(1.-smoothstep(.984,1.,v)),0.,.97);
        if(alpha<.008) discard;
        gl_FragColor=vec4(color,alpha);
      }
    `,
  });
  return { material, uniforms };
}

function effectMesh(root, name, geometry, material, order) {
  const mesh = guardFromAO(new THREE.Mesh(geometry,material),material);
  mesh.name = name;
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  mesh.visible = false;
  root.add(mesh);
  return mesh;
}

// Two rounded faces share the cutting edge and the inside ridge. Sections
// are indexed in pairs, so both faces grow together as the blade sweeps.
function crystalGeometry(rows, columns) {
  const stride = columns + 1;
  const face = rows*stride;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(face*6),3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(face*4),2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(face*6),3).setUsage(THREE.DynamicDrawUsage));
  const indices = [];
  for (let row=0;row<rows-1;row++) {
    for (let col=0;col<columns;col++) {
      const a=row*stride+col, b=a+stride;
      indices.push(a,a+1,b,a+1,b+1,b,
        face+a,face+b,face+a+1,face+a+1,face+b,face+b+1);
    }
  }
  geometry.setIndex(indices);
  return geometry;
}

function crystalDepth(v) {
  return Math.sin(Math.PI*v)**.82;
}

// Each cut uses a ribbon swept by the actual sword. Extrusion follows the
// local curve normal, keeping the edge thin even as the weapon twists.
function makeBladeArc(root, cut, index) {
  const rows = 80, columns = 14;
  const stride = columns+1;
  const geometry = crystalGeometry(rows,columns);
  const { position, uv, normal } = geometry.attributes;
  const { material, uniforms } = crystalMaterial(false);
  const mesh = effectMesh(root,'ultimate-silver-arc-'+index,geometry,material,14);
  const samples = Array.from({length:rows},()=>({root:new THREE.Vector3(),tip:new THREE.Vector3(),time:0}));
  const wide = [1.35,1.15,1.31,1.38,1.46,1.68][index];
  let count = 0;
  const point = new THREE.Vector3(), axis = new THREE.Vector3(), tangent = new THREE.Vector3();
  const radial = new THREE.Vector3(), faceNormal = new THREE.Vector3();
  const inner = new THREE.Vector3(), outer = new THREE.Vector3();
  const curve = new THREE.CatmullRomCurve3();
  const outerCurve = new THREE.CatmullRomCurve3();
  return {
    mesh, cut,
    sample(frame, base, tip, flakes, drift) {
      if (count >= rows || (count && frame-samples[count-1].time < .30)) return;
      const s = samples[count];
      s.root.lerpVectors(base,tip,.38);
      s.tip.lerpVectors(base,tip,1+wide);
      s.tip.y = Math.max(.08,s.tip.y);
      s.time = frame;
      if (count) {
        const old = samples[count-1].tip;
        const distance = drift.copy(s.tip).sub(old).length();
        drift.multiplyScalar(4.5).clampLength(0,7.0);
        const emit = Math.min(6,Math.floor(distance*10));
        for (let i=0; i<emit; i++) {
          point.lerpVectors(old,s.tip,(i+.5)/emit).lerp(s.root,.07+(i%3)*.08);
          flakes.emit(point,drift,.84);
        }
      }
      count++;
    },
    update(frame, power) {
      const tail = smoothstep(frame,cut.end-1,cut.end+23);
      mesh.visible = count >= 2 && tail < 1;
      if (!mesh.visible) return;
      uniforms.power.value = power*.97*(1-tail);
      uniforms.age.value = tail;
      const progress = time => clamp((time-cut.start+1)/(cut.end-cut.start+1),0,1);
      uniforms.head.value = progress(samples[count-1].time)+tail*.13;
      const sections = Math.min(rows,(count-1)*3+1);
      const live = samples.slice(0,count);
      curve.points = live.map(s => s.root);
      outerCurve.points = live.map(s => s.tip);
      for (let row=0; row<sections; row++) {
        const t = row/(sections-1);
        const mark = t*(count-1);
        const lower = Math.min(count-2,Math.floor(mark));
        const u = progress(lerp(samples[lower].time,samples[lower+1].time,mark-lower));
        const taper = .56+.44*Math.sin(Math.PI*u);
        curve.getPoint(t,inner);
        outerCurve.getPoint(t,outer);
        outerCurve.getTangent(t,tangent);
        radial.subVectors(outer,inner);
        const width=Math.max(.05,radial.length()*taper);
        radial.normalize();
        axis.crossVectors(radial,tangent).normalize();
        for (let col=0; col<=columns; col++) {
          const v=col/columns;
          const height=(.105+index*.012)*taper;
          const depth=height*crystalDepth(v);
          const slope=height*Math.PI*.82*Math.cos(Math.PI*v)
            *Math.max(.09,Math.sin(Math.PI*v))**-.18/width;
          for (let face=0;face<2;face++) {
            const idx=(row+face*rows)*stride+col, sign=1-face*2;
            point.lerpVectors(inner,outer,1-(1-v)*taper).addScaledVector(axis,sign*depth);
            faceNormal.copy(axis).multiplyScalar(sign).addScaledVector(radial,-slope).normalize();
            position.setXYZ(idx,point.x,Math.max(.055,point.y),point.z);
            uv.setXY(idx,u,v);
            normal.setXYZ(idx,faceNormal.x,faceNormal.y,faceNormal.z);
          }
        }
      }
      position.needsUpdate = uv.needsUpdate = normal.needsUpdate = true;
      geometry.setDrawRange(0,(sections-1)*columns*12);
    },
    clear() { count=0;mesh.visible=false;geometry.setDrawRange(0,0); },
  };
}

// The forward belly stays at z=0, on the same path as the combat sweep.
function finisherProfile(u, v, point, side = 0) {
  const arc=Math.max(0,Math.sin(Math.PI*u**.89));
  const depth=-(1-arc**.91)*(1.95+u*1.58) - 1.85*(1-v)*arc**1.28;
  const bevel=side*.29*crystalDepth(v)*arc**.78;
  return point.set(depth*.53+(u-.44)*.38+bevel*.88,
    .068+u*3.12,depth*.93-bevel*.47);
}

function makeFinisher(root) {
  const rows = 84, columns = 18;
  const geometry = crystalGeometry(rows,columns);
  const { position, uv } = geometry.attributes;
  const point = new THREE.Vector3();
  for (let face=0;face<2;face++) {
    for (let row=0;row<rows;row++) {
      for (let col=0;col<=columns;col++) {
        const u=row/(rows-1), v=col/columns, i=(row+face*rows)*(columns+1)+col;
        finisherProfile(u,v,point,1-2*face);
        position.setXYZ(i,point.x,point.y,point.z);
        uv.setXY(i,u,v);
      }
    }
  }
  geometry.computeVertexNormals();
  const { material, uniforms } = crystalMaterial(true);
  const mesh = effectMesh(root,'ultimate-finisher-wave',geometry,material,16);
  return { mesh, uniforms };
}

function makeFinisherWake(root, index) {
  const uniforms = { power: { value: 0 }, age: { value: 0 } };
  const geometry = new THREE.PlaneGeometry(1,1,54,11);
  const { position, uv } = geometry.attributes;
  const point = new THREE.Vector3();
  for (let i=0;i<position.count;i++) {
    const u=uv.getX(i), v=uv.getY(i);
    finisherProfile(u,.38+v*.54,point,index ? -1 : 1);
    point.x += index ? -.34 : .18;
    point.z -= index ? .95 : .29;
    position.setXYZ(i,point.x,point.y*(index ? .86 : 1.02),point.z);
  }
  const material=lightMaterial(uniforms,`
    varying vec2 vUv;
    void main() {
      vUv=uv;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
    }
  `,`
    varying vec2 vUv;
    uniform float power,age;
    ${NOISE}
    void main() {
      float u=vUv.x,v=vUv.y;
      float fade=smoothstep(.02,.19,u)*(1.-smoothstep(.82,1.,u));
      float flow=noise(vec2(u*16.+age*1.8,v*4.));
      float body=bell((v-.62+(flow-.5)*.44)*5.);
      float edge=bell((v-.76+(flow-.5)*.20)*28.);
      float tear=smoothstep(.34,.69,noise(vec2(u*26.-v*2.,v*9.+age)));
      float alpha=power*fade*tear*(1.-smoothstep(.86,1.,v));
      gl_FragColor=vec4(vec3(.27,.055,.83)*(body*.86+edge*.65),alpha);
    }
  `);
  return {mesh:effectMesh(root,'ultimate-finisher-wake-'+index,geometry,material,15),uniforms};
}

function makeFinisherGroundLight(root) {
  const uniforms = { power: { value: 0 } };
  const geometry = new THREE.PlaneGeometry(3.6,5.2).rotateX(-Math.PI/2);
  const material=lightMaterial(uniforms,`
    varying vec2 vUv;
    void main() {
      vUv=uv;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
    }
  `,`
    varying vec2 vUv;
    uniform float power;
    ${NOISE}
    void main() {
      vec2 p=vUv*2.-1.;
      float envelope=1.-smoothstep(.17,1.,length(p));
      float streak=bell((p.x-(noise(p*vec2(2.,9.))-.5)*.30)*11.);
      float glow=envelope*envelope*(bell(p.x*4.)*.43+streak*.83);
      gl_FragColor=vec4(vec3(.43,.061,.80),glow*power);
    }
  `);
  return {mesh:effectMesh(root,'ultimate-finisher-floor-light',geometry,material,13),uniforms};
}

function makeCrystalShards(root) {
  const count=40;
  const geometry=new THREE.OctahedronGeometry(1);
  geometry.scale(.56,1.15,.39);
  geometry.computeVertexNormals();
  const material=new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: .42, metalness: .25,
    emissive: 0x5a14a3, emissiveIntensity: .64,
  });
  const mesh=guardFromAO(new THREE.InstancedMesh(geometry,material,count),material);
  mesh.name='ultimate-crystal-shards';
  mesh.frustumCulled=false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  const shards=Array.from({length:count},()=>({
    p:new THREE.Vector3(),v:new THREE.Vector3(),time:0,life:0,size:0,phase:0,
  }));
  const transform=new THREE.Object3D();
  const color=new THREE.Color();
  let cursor=0;
  mesh.count=0;
  return {
    emit(point, direction, size) {
      const shard=shards[cursor++%count];
      shard.p.copy(point);
      shard.v.copy(direction).multiplyScalar(.32+Math.random()*.42);
      shard.v.x+=(Math.random()-.5)*3.1;
      shard.v.y+=.2+Math.random()*1.7;
      shard.v.z+=(Math.random()-.5)*3.1;
      shard.phase=Math.random()*6.28;
      shard.size=size;
      shard.time=0;
      shard.life=.24+Math.random()*.28;
    },
    update(dt, power) {
      let visible=0;
      for (const shard of shards) {
        shard.time+=dt;
        if (shard.time>=shard.life) continue;
        shard.v.y-=dt*6.2;
        shard.p.addScaledVector(shard.v,dt);
        shard.p.y=Math.max(.075,shard.p.y);
        const age=shard.time/shard.life;
        const size=shard.size*(1-smoothstep(age,.46,1))*Math.min(1,power);
        transform.position.copy(shard.p);
        transform.rotation.set(shard.phase+age*2.6,shard.phase-age*3.2,age*2.1);
        transform.scale.set(size,size*(.97+.44*Math.sin(shard.phase)),size);
        transform.updateMatrix();
        color.setHSL(.74+Math.sin(shard.phase)*.036,.66,.27+.15*Math.cos(shard.phase));
        mesh.setMatrixAt(visible,transform.matrix);
        mesh.setColorAt(visible++,color);
      }
      mesh.count=visible;
      mesh.instanceMatrix.needsUpdate=true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    },
    clear() {
      for (const shard of shards) shard.life=0;
      mesh.count=0;
    },
  };
}

function makeFinisherImpact(root) {
  const uniforms = { power: { value: 0 } };
  const material = lightMaterial(uniforms,`
    varying vec2 vUv;
    void main() {
      vUv=uv;
      vec4 view=modelViewMatrix*vec4(0.,0.,0.,1.);
      view.xy+=position.xy*vec2(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz));
      gl_Position=projectionMatrix*view;
    }
  `,`
    varying vec2 vUv;
    uniform float power;
    void main() {
      vec2 p=(vUv-.5)*2.;
      vec2 ray=mat2(.96,.28,-.28,.96)*p;
      float core=exp(-dot(p,p)*90.);
      float slash=exp(-50.*abs(ray.x))*pow(max(0.,1.-abs(ray.y)),2.);
      float flare=exp(-58.*abs(ray.y))*pow(max(0.,1.-abs(ray.x)),4.);
      float glow=exp(-dot(p,p)*12.);
      vec3 light=vec3(.47,.16,1.)*glow*.69+vec3(1.,.92,.98)*(core*2.4+slash*.76+flare*.59);
      gl_FragColor=vec4(light,power);
    }
  `);
  const mesh = effectMesh(root,'ultimate-finisher-impact',new THREE.PlaneGeometry(1,1),material,17);
  return { mesh, uniforms };
}

export class UltimateEffect {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'ultimate-silver-wakes';
    scene.add(this.root);
    this.slashes = SWORD_CUTS.map((cut,i) => makeBladeArc(this.root,cut,i));
    this.crest = makeFinisher(this.root);
    this.wakes = [0,1].map(index => makeFinisherWake(this.root,index));
    this.groundLight = makeFinisherGroundLight(this.root);
    this.shards = makeCrystalShards(this.root);
    this.impact = makeFinisherImpact(this.root);
    this.kicks = [];
    this.flakes = createFlakes(this.root);
    this.point = new THREE.Vector3();
    this.drift = new THREE.Vector3();
    this.displacement = new THREE.Vector3();
    this.clear();
  }

  prepare(source, renderer) {
    if (this.source === source) return;
    for (const echoes of this.kicks) for (const echo of echoes) echo.dispose();
    this.source = source;
    this.kicks = ULTIMATE_KICKS.map((_,index) => KICK_ECHO_FRAMES.map((_,step) => {
      const echo = preparePoseEcho(source,renderer,'ultimate-kick-echo-'+index+'-'+step,KICK_ECHO_PALETTE);
      echo.meshes.visible = false;
      this.root.add(echo.meshes);
      return echo;
    }));
  }

  update(cast, frame, dt, intensity, pixels, base, tip) {
    this.root.visible = intensity>0;
    if (!this.root.visible) return;
    if (this.cast !== cast) {
      this.clear();
      this.root.visible = true;
      this.cast = cast;
    }
    for (const slash of this.slashes) {
      const {cut} = slash;
      if (dt>0 && base && tip && frame>=cut.start-1 && frame<=cut.end) {
        slash.sample(frame,base,tip,this.flakes,this.drift);
      }
      slash.update(frame,intensity);
    }
    this.updateFinisher(cast,frame,dt,intensity);
    this.updateKicks(cast,frame,intensity);
    this.flakes.update(dt,intensity,pixels);
    this.shards.update(dt,intensity);
  }

  updateFinisher(cast, frame, dt, intensity) {
    const { mesh, uniforms } = this.crest;
    const age = frame-FINISHER.hit;
    mesh.visible = !!cast.wave && age>=0 && age<=FINISHER.duration+10;
    this.updateFinisherImpact(cast.wave,frame,intensity);
    for (const wake of this.wakes) wake.mesh.visible = mesh.visible;
    this.groundLight.mesh.visible = mesh.visible;
    if (!mesh.visible) return;
    const { origin, direction } = cast.wave;
    mesh.position.copy(origin).addScaledVector(direction,finisherRun(frame));
    mesh.rotation.y = Math.atan2(direction.x,direction.z);
    uniforms.age.value = age/FINISHER.duration;
    const launch = 1-smoothstep(age,1,10);
    const fade = 1-smoothstep(age,FINISHER.duration-9,FINISHER.duration+6);
    uniforms.power.value = intensity*fade*(.97+.18*launch);
    for (const wake of this.wakes) {
      wake.mesh.position.copy(mesh.position);
      wake.mesh.rotation.y = mesh.rotation.y;
      wake.uniforms.age.value = uniforms.age.value;
      wake.uniforms.power.value = intensity*fade*(.68+.35*launch);
    }
    const floor=this.groundLight;
    floor.mesh.position.copy(mesh.position).addScaledVector(direction,-1.27);
    floor.mesh.position.y=.044;
    floor.mesh.rotation.y=mesh.rotation.y;
    floor.uniforms.power.value=intensity*fade*(.37+.55*launch);
    const tick = Math.floor(age);
    if (dt<=0 || tick===this.lastSparkFrame || age>=FINISHER.duration-7) return;
    this.lastSparkFrame = tick;
    this.drift.copy(direction).multiplyScalar(-3.1);
    for (let i=0;i<3;i++) {
      const u=.17+((i*7+tick*5)%19)/27;
      finisherProfile(u,.28+(i%2)*.31,this.point)
        .applyAxisAngle(mesh.up,mesh.rotation.y).add(mesh.position);
      this.flakes.emit(this.point,this.drift,.52+.40*launch);
      if (i===1 && tick%2===0) this.shards.emit(this.point,this.drift,.075+launch*.04);
    }
    if (tick===0) {
      for (let i=0;i<8;i++) {
        finisherProfile(.06+i*.033,.68,this.point)
          .applyAxisAngle(mesh.up,mesh.rotation.y).add(mesh.position);
        this.shards.emit(this.point,this.drift,.08+i*.008);
      }
    }
  }

  updateFinisherImpact(wave, frame, intensity) {
    const { mesh, uniforms } = this.impact;
    const contact = wave?.contact;
    const age = contact ? frame-contact.frame : -1;
    mesh.visible = age>=0 && age<9;
    if (!mesh.visible) return;
    mesh.position.copy(contact.position);
    mesh.position.y += 1.08;
    mesh.position.addScaledVector(wave.direction,-.23);
    mesh.scale.set(1.21+age*.11,1.6+age*.10,1);
    uniforms.power.value = intensity*(1-smoothstep(age,0,9));
    if (this.contactShown) return;
    this.contactShown = true;
    for (let i=0;i<19;i++) {
      const angle = i*2.39996;
      this.point.copy(mesh.position).y += (i%5-2)*.10;
      this.drift.copy(wave.direction).multiplyScalar(5.3);
      this.drift.x += Math.cos(angle)*(2.5+i%3);
      this.drift.z += Math.sin(angle)*(2.5+i%3);
      this.drift.y += (i%7-2.5)*1.12;
      this.flakes.emit(this.point,this.drift,.97);
      if (i<10) this.shards.emit(this.point,this.drift,.085+(i%4)*.024);
    }
  }

  updateKicks(cast, frame, intensity) {
    this.kicks.forEach((echoes,index) => {
      const sinceKick = frame-ULTIMATE_KICKS[index].hit;
      if (sinceKick < KICK_ECHO_FRAMES[0] || sinceKick > 22) return;
      // Capture at most one pose per render so low FPS cannot stack copies of
      // the same pose. Keep the earliest and latest silhouettes distinct.
      const step = KICK_ECHO_FRAMES.findLastIndex(mark => sinceKick >= mark);
      const echo = echoes[step];
      if (echo.frame === undefined) {
        this.source.updateWorldMatrix(true,true);
        this.displacement.copy(cast.forward).multiplyScalar(-.15-step*.17)
          .addScaledVector(cast.side,(index === 0 ? -1 : 1)*(.25+step*.14));
        echo.capture(this.displacement,step === 1 ? 1.32 : .95);
        echo.frame = frame;
        echo.meshes.visible = true;
      }
      for (const snapshot of echoes) {
        if (snapshot.frame === undefined) continue;
        const age = (frame-snapshot.frame)/60;
        snapshot.meshes.visible = age < .31;
        snapshot.material.uniforms.time.value = age;
        snapshot.material.uniforms.fade.value = intensity*snapshot.strength*(1-smoothstep(age,.018,.31));
      }
    });
    this.kicks.forEach((echoes,index) => {
      if (frame <= ULTIMATE_KICKS[index].hit + 22) return;
      for (const echo of echoes) echo.meshes.visible = false;
    });
  }

  clear() {
    this.root.visible = this.crest.mesh.visible = this.impact.mesh.visible = false;
    this.cast = null;
    this.contactShown = false;
    this.lastSparkFrame = -1;
    this.flakes.clear();
    this.shards.clear();
    this.groundLight.mesh.visible = false;
    for (const wake of this.wakes) wake.mesh.visible = false;
    for (const slash of this.slashes) slash.clear();
    for (const echoes of this.kicks) for (const echo of echoes) {
      echo.frame = undefined;
      echo.meshes.visible = false;
    }
  }
}
