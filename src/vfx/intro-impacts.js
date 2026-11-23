import * as THREE from 'three';
import { guardFromAO } from './ao-guard.js';

const { clamp, smoothstep } = THREE.MathUtils;
const noise = `
  float hash(vec2 p) {
    vec3 q=fract(vec3(p.xyx)*.1031);
    q+=dot(q,q.yzx+33.33);
    return fract((q.x+q.y)*q.z);
  }
  float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p);
    f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
      mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
  }
  float bell(float x) { return exp(-x*x); }
`;
const uvVertex = `
  varying vec2 vUv;
  void main() {
    vUv=uv;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }
`;

function light(root, name, geometry, uniforms, vertexShader, fragmentShader, order) {
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide, forceSinglePass: true,
    precision: 'highp', blending: THREE.AdditiveBlending,
  });
  const mesh = guardFromAO(new THREE.Mesh(geometry,material),material);
  mesh.name = name;
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  mesh.visible = false;
  root.add(mesh);
  return mesh;
}

export function createDescentLightning(root) {
  const positions=[], profiles=[], timings=[], indices=[];
  const tangent=new THREE.Vector3(), axis=new THREE.Vector3(), cross=new THREE.Vector3();
  const normal=new THREE.Vector3(), point=new THREE.Vector3();
  const right=new THREE.Vector3(1,0,0), forward=new THREE.Vector3(0,0,1);
  let state=187021;
  const random=()=> (state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296;

  // Two perpendicular surfaces give each channel a visible core from
  // different angles. Both stay anchored in arena space during descent.
  function arc(path, startTime, travelTime, width, returnWeight) {
    const phase=random();
    for (let face=0;face<2;face++) {
      const first=positions.length/3;
      for (let i=0;i<path.length;i++) {
        const t=i/(path.length-1);
        tangent.subVectors(path[Math.min(i+1,path.length-1)],path[Math.max(0,i-1)]).normalize();
        axis.crossVectors(tangent,right);
        if (axis.lengthSq()<.1) axis.crossVectors(tangent,forward);
        axis.normalize();
        cross.crossVectors(tangent,axis);
        const span=2.25*width*(.35+.65*Math.sin(Math.PI*t))*(1-.27*t);
        for (const side of [-1,1]) {
          normal.copy(face===0 ? axis : cross).multiplyScalar(side*span);
          point.copy(path[i]).add(normal);
          positions.push(point.x,point.y,point.z);
          profiles.push(side,t,phase);
          timings.push(startTime+t*travelTime,returnWeight);
        }
        if (i>0) {
          const k=first+i*2;
          indices.push(k-2,k-1,k,k-1,k+1,k);
        }
      }
    }
  }

  const strikes=[
    { start:-.652, fall:.24, floor:6.0, height:21.2, trunk:.074, back:0 },
    { start:-.620, fall:.25, floor:4.4, height:17.5, trunk:.049, back:0 },
    { start:-.578, fall:.24, floor:4.8, height:19.6, trunk:.045, back:0 },
    { start:-.525, fall:.32, floor:2.3, height:20.3, trunk:.059, back:0 },
    { start:-.504, fall:.37, floor:1.25,height:17.6, trunk:.051, back:0 },
    { start:-.459, fall:.31, floor:2.9, height:18.7, trunk:.043, back:0 },
    { start:-.433, fall:.433,floor:.05, height:20.1, trunk:.132, back:1 },
    { start:-.390, fall:.40, floor:.10, height:16.3, trunk:.079, back:.76 },
    { start:-.330, fall:.35, floor:.17, height:18.9, trunk:.066, back:.55 },
    { start:-.285, fall:.315,floor:.22, height:15.7, trunk:.052, back:.40 },
  ];
  for (let i=0;i<strikes.length;i++) {
    const {start,fall,floor,height,trunk,back}=strikes[i];
    const angle=i*2.39996+random();
    const x=Math.cos(angle), z=Math.sin(angle);
    const path=Array.from({length:35},(_,j)=>{
      const t=j/34, upper=1-t;
      const spread=.12+3.34*upper**1.43;
      const rough=.07+.56*upper;
      const sway=Math.sin(t*7.9+angle)*upper*.64;
      return new THREE.Vector3(
        x*spread+z*sway+(random()-.5)*rough,
        floor+(height-floor)*upper,
        z*spread-x*sway+(random()-.5)*rough);
    });
    arc(path,start,fall,trunk,back);

    for (let j=0;j<6;j++) {
      const k=5+j*4+(i%3), junction=path[k];
      const angle=2.39996*j+i*.78+random();
      const spread=.66+random()*2.23;
      const drop=-.36-random()*2.85;
      const branch=[junction];
      for (let n=1;n<=7;n++) {
        const t=n/7;
        branch.push(new THREE.Vector3(junction.x+Math.cos(angle)*spread*t+(random()-.5)*.32,
          Math.max(.09,junction.y+t*drop+(random()-.5)*.21),
          junction.z+Math.sin(angle)*spread*t+(random()-.5)*.32));
      }
      const forkStart=start+fall*k/34+.009+random()*.027;
      const forkTime=.042+random()*.084;
      arc(branch,forkStart,forkTime,.023+random()*.037,0);
      if (j%2===0) {
        const snag=branch[3];
        const twig=[snag,
          new THREE.Vector3(snag.x+.42*x,snag.y-.21,snag.z+.42*z),
          new THREE.Vector3(snag.x+.91*x,Math.max(.09,snag.y-.72),snag.z+.91*z)];
        arc(twig,forkStart+forkTime*3/7+.01,.036,.018,0);
      }
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('boltProfile',new THREE.Float32BufferAttribute(profiles,3));
  geometry.setAttribute('boltTiming',new THREE.Float32BufferAttribute(timings,2));
  geometry.setIndex(indices);
  const uniforms={ impactClock:{value:0} };
  const mesh=light(root,'boss-intro-red-lightning',geometry,uniforms,`
    attribute vec3 boltProfile;
    attribute vec2 boltTiming;
    varying vec3 arcProfile;
    varying vec2 sequence;
    void main() {
      arcProfile=boltProfile;
      sequence=boltTiming;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
    }
  `,`
    ${noise}
    uniform float impactClock;
    varying vec3 arcProfile;
    varying vec2 sequence;
    void main() {
      float x=abs(arcProfile.x), u=arcProfile.y, phase=arcProfile.z;
      float elapsed=impactClock-sequence.x;
      float ignition=smoothstep(-.009,.002,elapsed);
      float fading=1.-smoothstep(.028,.12,elapsed);
      float leader=ignition*fading;
      float reflected=impactClock-(.014+.091*(1.-u));
      float afterglow=sequence.y*smoothstep(-.004,.010,reflected)*(1.-smoothstep(.014,.081,reflected));
      float intensity=max(leader,1.48*afterglow);
      float filament=bell(x*4.9);
      float corona=bell(x*2.2);
      float hotHead=bell(elapsed*41.)*ignition;
      float crackle=.67+.33*noise(vec2(u*68.-impactClock*70.,phase*19.));
      float tipFade=1.-smoothstep(.89,1.,u);
      float ends=smoothstep(0.,.038,u)*mix(tipFade,1.,step(.35,sequence.y));
      float alpha=intensity*ends*crackle*(1.-smoothstep(.71,1.,x));
      if(alpha<.005) discard;
      vec3 color=vec3(.94,.009,.038)*(corona*.59+filament*.66)
        +vec3(1.65,.31,.16)*filament*(.29+hotHead*.94+afterglow*.61);
      gl_FragColor=vec4(color,alpha);
    }
  `,7);

  const illumination = new THREE.PointLight(0xff2037,0,11,2);
  mesh.add(illumination);
  return {
    update(age, impact, altitude) {
      mesh.visible=impact<.205;
      illumination.intensity=0;
      if (!mesh.visible) return;
      uniforms.impactClock.value=impact;
      const landing=impact>=0 ? 1-smoothstep(impact,.012,.145) : 0;
      const descent=impact<0 ? 1-smoothstep(-impact,0,.33) : 0;
      illumination.position.y=altitude+.38;
      illumination.intensity=4.1*descent*(.85+.15*Math.sin(age*218))+29*landing;
    },
    dispose() {
      geometry.dispose();
      mesh.material.dispose();
      mesh.removeFromParent();
    },
  };
}

export function createIntroAftershock(root) {
  const duration=1.12;
  const uniforms={ time:{value:0}, power:{value:0}, front:{value:0} };
  const ground=light(root,'boss-intro-aftershock-ground',
    new THREE.PlaneGeometry(16,16).rotateX(-Math.PI/2),uniforms,uvVertex,`
      ${noise}
      uniform float time,power,front;
      varying vec2 vUv;
      void main() {
        vec2 p=(vUv-.5)*16.;
        float r=length(p);
        vec2 d=p/max(r,.001);
        float fractured=noise(d*16.+r*.97);
        float chipped=noise(d*38.+r*1.52);
        float offset=r-front+(fractured-.5)*.32+(chipped-.5)*.13;
        float crest=bell(offset*12.)*smoothstep(.18,.68,chipped);
        float body=bell((offset+.23)*3.2)*(.22+.78*fractured);
        float echo=bell((offset+.79)*5.5)*smoothstep(.27,.70,noise(d*22.+2.));
        float spokes=bell((noise(d*23.+r*.18)-.5)*18.)*smoothstep(.03,.30,r);
        float fracturedGround=spokes*bell((offset+.34)*2.4)*smoothstep(.24,.57,chipped);
        float sparks=pow(noise(p*17.+time*3.),12.)*bell((offset+.28)*3.);
        vec3 red=vec3(.78,.021,.050);
        vec3 ember=vec3(1.10,.18,.088);
        vec3 light=red*(body*.75+echo*.91+fracturedGround*1.08)
          + ember*(crest*1.06+sparks*1.65);
        gl_FragColor=vec4(light,power);
      }
    `,4);
  ground.position.y=.072;
  const curtain=light(root,'boss-intro-aftershock-pressure',
    new THREE.CylinderGeometry(1,1,1,112,7,true),uniforms,`
      varying vec2 vUv;
      varying vec2 bearing;
      void main() {
        vUv=uv;
        bearing=position.xz;
        vec3 p=position;
        p.xz *= 1.+(sin(102.*uv.x)+.5*sin(163.*uv.x))*.016 + uv.y*.064;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
      }
    `,`
      ${noise}
      uniform float time,power;
      varying vec2 vUv;
      varying vec2 bearing;
      void main() {
        float h=vUv.y;
        float roll=noise(bearing*15.+vec2(h*1.9,time*5.8));
        float grit=noise(bearing*49.+vec2(h*9.4-time*4.,time*2.));
        float tips=.27+.64*roll;
        float falloff=smoothstep(0.,.07,h)*(1.-smoothstep(tips-.18,tips+.17,h));
        float cuts=smoothstep(.30,.69,grit);
        float edge=bell((h-.14-roll*.43)*15.)*cuts;
        float dust=falloff*(.19+.63*roll);
        vec3 light=vec3(.72,.032,.047)*dust + vec3(1.13,.17,.07)*edge*.66;
        gl_FragColor=vec4(light,power*falloff*(.54+.34*cuts));
      }
    `,6);
  return {
    update(age, opacity) {
      ground.visible = curtain.visible = age>=0 && age<duration && opacity>0;
      if (!ground.visible) return;
      const t=clamp(age/duration,0,1);
      const front=.52+6.9*(1-(1-t)**2.55);
      const punch=Math.exp(-5.3*t);
      const height=.26+.80*punch;
      curtain.scale.set(front,height,front);
      curtain.position.y=.055+height*.50;
      uniforms.front.value=front;
      uniforms.time.value=age;
      uniforms.power.value=opacity*(1-smoothstep(t,.17,1))*(.83+punch*.56);
    },
  };
}
