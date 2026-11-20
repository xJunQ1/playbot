import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import recipe from '../../assets/vfx/parry/recipe.json' with { type: 'json' };
import { guardFromAO } from './ao-guard.js';

// XsxB-Slash / examples/parry_fable. Masks and RGB values in the recipe are linear.
const asset = file => new URL('../../assets/vfx/parry/' + file, import.meta.url).href;
const sample = ([lo, hi]) => THREE.MathUtils.randFloat(lo, hi);
const tint = rgb => new THREE.Color().fromArray(rgb);

// Each instance is a strip along a ballistic path. The long strips used by
// perfect deflections share the spark draw call and follow the same trajectory.
function sparkCloud(tier, origin, scale, mask, intensity, yaw) {
  const spark = tier.sparks;
  const velocities = [], dynamics = [], trails = [], heats = [];
  for (const layer of spark.tiers) {
    const count = Math.round(layer.count * Math.min(intensity, 1.5));
    for (let i = 0; i < count; i++) {
      const ribbon = tier.ribbon.enabled && layer.name === 'arc' && i < tier.ribbon.leaders;
      const angle = ribbon ? yaw + Math.PI * 0.5 + THREE.MathUtils.randFloatSpread(1.4) : Math.random() * Math.PI * 2;
      const y = THREE.MathUtils.randFloat(ribbon ? 0.12 : -0.35, 0.96);
      const speed = sample(layer.speed), horizontal = speed * Math.sqrt(1 - y*y);
      velocities.push(Math.sin(angle)*horizontal, speed*y, Math.cos(angle)*horizontal);
      dynamics.push(sample(layer.drag), spark.gravity*layer.gravity, sample(layer.life), sample(layer.cool));
      trails.push(ribbon ? tier.ribbon.trailS : layer.streak, ribbon ? tier.ribbon.widthM : sample(layer.width),
        ribbon ? 2 : layer.maxLen, layer.name === 'ember' ? 1 : 0);
      heats.push(sample(layer.heat));
    }
  }
  const strip = new THREE.PlaneGeometry(1, 1, 6, 1);
  const geometry = new THREE.InstancedBufferGeometry().copy(strip);
  strip.dispose();
  for (const [name, values, size] of [['velocity',velocities,3],['dynamics',dynamics,4],['trail',trails,4],['heat0',heats,1]]) {
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(values), size));
  }
  geometry.instanceCount = heats.length;
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: {
      age: {value:0}, floorDepth:{value:origin.y/scale}, bounce:{value:spark.floorBounce},
      mask:{value:mask}, hot:{value:tint(spark.hot)}, mid:{value:tint(spark.mid)}, cool:{value:tint(spark.cool)},
      gain:{value:spark.hdr*intensity}
    },
    vertexShader: `
      attribute vec3 velocity;
      attribute vec4 dynamics, trail;
      attribute float heat0;
      uniform float age, floorDepth, bounce;
      varying vec2 vUv;
      varying float heat, fade, ember;
      vec3 path(float t) {
        float k = dynamics.x, drag = (1. - exp(-k*t))/k;
        vec3 p = velocity*drag;
        p.y -= dynamics.y*(t-drag)/k;
        float penetration=max(0.,-floorDepth-p.y);
        if (penetration>0.) p.y=-floorDepth+bounce*penetration*exp(-2.5*penetration);
        return p;
      }
      void main() {
        vUv=uv; ember=trail.w;
        float speed=length(velocity)*exp(-dynamics.x*age);
        float tail=min(trail.x,trail.z/max(speed,0.1));
        float t=max(0.,age-(1.-uv.x)*tail);
        vec4 p=modelViewMatrix*vec4(path(t),1.);
        vec2 dir=(modelViewMatrix*vec4(path(t+.004)-path(t),0.)).xy;
        dir=normalize(dir+vec2(.000001,0.));
        float width=max(trail.y*length(modelViewMatrix[0].xyz)*2.,-p.z*.001);
        p.xy+=vec2(-dir.y,dir.x)*(uv.y-.5)*2.*width;
        if (ember>.5) p.xy+=dir*(uv.x-.5)*width*2.;
        gl_Position=projectionMatrix*p;
        heat=heat0*exp(-age/dynamics.w);
        fade=1.-smoothstep(.68,1.,age/dynamics.z);
      }`,
    fragmentShader: `
      uniform sampler2D mask;
      uniform vec3 hot, mid, cool;
      uniform float gain;
      varying vec2 vUv;
      varying float heat, fade, ember;
      void main() {
        float profile=1.-smoothstep(.22,.5,abs(vUv.y-.5));
        if (ember>.5) profile=texture2D(mask,vUv).r;
        vec3 color=mix(mix(cool,mid,smoothstep(.12,.70,heat)),hot,smoothstep(.70,1.,heat));
        gl_FragColor=vec4(color*(gain*pow(heat,2.2)+2.6*heat),profile*fade);
      }`
  });
  const mesh=guardFromAO(new THREE.Mesh(geometry,material),material);
  mesh.frustumCulled=false;
  mesh.renderOrder=12;
  return mesh;
}

export class GuardImpact {
  constructor(scene) {
    this.scene=scene;
    const loader=new THREE.TextureLoader();
    this.masks=new Map();
    this.audio={};
    for (const [name,tier] of Object.entries(recipe.tiers)) {
      for (const layer of [tier.star,tier.flash,tier.sparks,tier.smoke]) {
        if (layer.enabled && !this.masks.has(layer.texture)) this.masks.set(layer.texture,loader.load(asset(layer.texture)));
      }
      const sound=new Audio(asset(tier.sfx.file));
      sound.preload='auto';
      sound.volume=0.5;
      this.audio[name]=sound;
    }
    this.light=new THREE.PointLight(0xffffff,0,6);
    scene.add(this.light);
    this.pass=new ShaderPass({
      uniforms:{tDiffuse:{value:null},center:{value:new THREE.Vector2()},aspect:{value:1},radius:{value:0},strength:{value:0}},
      vertexShader:'varying vec2 p; void main(){p=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:`uniform sampler2D tDiffuse; uniform vec2 center; uniform float aspect,radius,strength; varying vec2 p;
        void main(){vec2 d=(p-center)*vec2(aspect,1.);float r=length(d);
          float band=(r-radius)/max(radius*.16,.008);
          vec2 offset=d/max(r,.001)/vec2(aspect,1.)*band*exp(-band*band)*strength;
          gl_FragColor=texture2D(tDiffuse,clamp(p+offset,0.,1.));}`
    });
    this.pass.enabled=false;
  }

  burst(actor, name, camera, intensity, attacker) {
    const tier=recipe.tiers[name];
    const scale=THREE.MathUtils.clamp(actor.scale ?? 1,0.8,1.65);
    const facing=attacker ? attacker.pos.clone().sub(actor.pos).setY(0) : new THREE.Vector3();
    if (facing.lengthSq()<0.0001) facing.set(Math.sin(actor.yaw),0,Math.cos(actor.yaw));
    facing.normalize();
    const origin=actor.pos.clone().addScaledVector(facing,.55*scale);
    // Place the contact just to the weapon side so it reads from behind the defender.
    origin.x-=.23*scale*facing.z;
    origin.z+=.23*scale*facing.x;
    origin.y+=1.25*scale;
    const root=new THREE.Group();
    root.name='guard-impact-'+name;
    root.position.copy(origin);
    root.scale.setScalar(scale);
    this.scene.add(root);
    const makeSprite=(layer,smoke=false)=>{
      const mat=new THREE.SpriteMaterial({
        alphaMap:this.masks.get(layer.texture),color:smoke?tint(layer.color):tint(layer.core),
        transparent:true,depthWrite:false,depthTest:smoke,
        blending:smoke || layer===tier.flash ? THREE.NormalBlending : THREE.AdditiveBlending
      });
      if (smoke) {
        mat.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>',
            '#include <alphamap_fragment>\ndiffuseColor.a *= 1. - smoothstep(.17,.49,length(vAlphaMapUv-.5));');
        };
      } else if (layer===tier.flash) {
        mat.onBeforeCompile = shader => {
          shader.uniforms.flashCore={value:tint(layer.core)};
          shader.uniforms.flashEdge={value:tint(layer.color)};
          shader.uniforms.flashGain={value:(.35+.22*layer.hdr)*intensity/.62};
          shader.fragmentShader='uniform vec3 flashCore,flashEdge; uniform float flashGain;\n'+shader.fragmentShader.replace(
            '#include <alphamap_fragment>', `
              float maskValue=texture2D(alphaMap,vAlphaMapUv).g;
              float r=length(vAlphaMapUv-.5)*2.;
              float edge=1.-smoothstep(.76,1.,r-(maskValue-.35)*.06);
              diffuseColor.a*=maskValue*edge*.62;
              diffuseColor.rgb=flashGain*mix(flashEdge,flashCore,smoothstep(.3,.9,maskValue*(1.-r*.4)));`);
        };
      }
      const sprite=guardFromAO(new THREE.Sprite(mat),mat);
      sprite.renderOrder=smoke?9:14;
      root.add(sprite);
      return sprite;
    };
    const star=makeSprite(tier.star),flash=makeSprite(tier.flash);
    const cloud=sparkCloud(tier,origin,scale,this.masks.get(tier.sparks.texture),intensity,actor.yaw);
    root.add(cloud);
    const smoke=[];
    for (let i=0;tier.smoke.enabled && i<tier.smoke.puffs;i++) {
      const sprite=makeSprite(tier.smoke,true);
      sprite.material.rotation=Math.random()*2*Math.PI;
      const drift=new THREE.Vector3().randomDirection().multiplyScalar(.8);
      drift.y=Math.abs(drift.y)+.12;
      smoke.push({sprite,drift});
    }
    let debris;
    const shards=[];
    const transform=new THREE.Object3D();
    if (tier.debris.enabled) {
      const config=tier.debris;
      const metal=new THREE.MeshStandardMaterial({color:0x66554a,metalness:.72,roughness:.38});
      debris=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),metal,config.count);
      debris.frustumCulled=false;
      root.add(debris);
      for (let i=0;i<config.count;i++) {
        const velocity=new THREE.Vector3().randomDirection().multiplyScalar(sample(config.speedMS)*config.speedMul);
        velocity.y=Math.abs(velocity.y);
        shards.push({velocity,size:sample(config.sizeM)*config.sizeMul,spin:THREE.MathUtils.randFloat(-18,18)});
      }
    }
    const sound=this.audio[name];
    sound.currentTime=tier.sfx.peakOffsetS;
    sound.play().catch(()=>{});
    this.lightOwner=root;
    this.light.position.copy(origin);
    this.light.distance=tier.light.rangeM*scale;
    this.light.color.fromArray(tier.light.color);
    if (tier.refraction.enabled) this.rippleOwner=root;
    const ndc=new THREE.Vector3();
    const duration=Math.max(...tier.sparks.tiers.map(layer=>layer.life[1]));
    let age=.014; // Show contact on the first frame, including during hitstop.
    const dispose=()=>{
      root.removeFromParent();
      root.traverse(o=>o.material?.dispose());
      cloud.geometry.dispose();
      if (debris) { debris.geometry.dispose(); debris.dispose(); }
      if (this.lightOwner===root) {this.light.intensity=0;this.lightOwner=null;}
      if (this.rippleOwner===root) {this.pass.enabled=false;this.rippleOwner=null;}
    };
    const update=dt=>{
      age+=dt;
      if (age>=duration) {dispose();return false;}
      for (const [sprite,layer] of [[star,tier.star],[flash,tier.flash]]) {
        const t=age/layer.lifeS;
        sprite.visible=t<1.75;
        sprite.scale.setScalar(layer.sizeM*(1+.35*Math.min(t,1)));
        sprite.material.color.fromArray(layer===tier.star?layer.edge:layer.color).lerp(tint(layer.core),Math.exp(-6*t));
        sprite.material.color.multiplyScalar(layer.hdr*intensity);
        sprite.material.opacity=layer===tier.star?Math.exp(-t/.38):(layer.opacity*Math.pow(Math.max(0,1-t/1.75),1.35));
      }
      cloud.material.uniforms.age.value=age;
      if (debris) {
        for (let i=0;i<shards.length;i++) {
          const {velocity,size,spin}=shards[i];
          transform.position.copy(velocity).multiplyScalar(age);
          transform.position.y=Math.max(-origin.y/scale+size,transform.position.y-4.9*age*age);
          transform.rotation.set(spin*age,i+spin*.6*age,i);
          transform.scale.set(3*size,.45*size,size).multiplyScalar(Math.min(1,(duration-age)*5));
          transform.updateMatrix();
          debris.setMatrixAt(i,transform.matrix);
        }
        debris.instanceMatrix.needsUpdate=true;
      }
      for (const {sprite,drift} of smoke) {
        sprite.position.copy(drift).multiplyScalar(age+.07);
        sprite.scale.setScalar((.12+age*.52)*tier.smoke.sizeMul);
        sprite.material.opacity=tier.smoke.opacity*Math.exp(-age*4)*Math.min(age*24,1);
      }
      if (this.lightOwner===root) this.light.intensity=tier.light.intensity*intensity*Math.exp(-age/tier.light.decayS);
      if (this.rippleOwner===root && camera) {
        const t=age/tier.refraction.lifeS;
        ndc.copy(origin).project(camera);
        this.pass.enabled=t<1 && Math.abs(ndc.z)<1;
        const u=this.pass.uniforms;
        u.center.value.set(ndc.x*.5+.5,ndc.y*.5+.5);
        u.aspect.value=camera.aspect;
        const depth=-origin.clone().applyMatrix4(camera.matrixWorldInverse).z;
        u.radius.value=tier.refraction.radiusM*scale*t*camera.projectionMatrix.elements[5]/(2*Math.max(.1,depth));
        u.strength.value=tier.refraction.strengthPx720/720*Math.pow(Math.max(0,1-t),2)*intensity;
      }
      return true;
    };
    update(0);
    return {update,dispose};
  }

  dispose() {
    this.light.removeFromParent();
    this.light.dispose();
    this.pass.dispose();
    for (const map of this.masks.values()) map.dispose();
    for (const sound of Object.values(this.audio)) sound.pause();
  }
}
