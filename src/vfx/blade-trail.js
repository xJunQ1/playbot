// ═══════════════════════════════════════════════════════════
//  剑轨（Blade Trail）— 贴图版「紫月牙」
//  真实跟刃：每帧采样「刃根 / 刃尖」的世界坐标，把最近 trailLife 秒的采样
//  连成一条三角形带 —— 挥得快，同一时间窗内扫过的路径就长；挥得慢就短，
//  所以轨迹的长度 / 存留时间天然跟着剑的实际动作走。
//
//  贴图：UV 里 u = 沿时间（0 最老 → 1 最新），v = 沿刃身（0 刃根 → 1 刃尖），
//  用 free_slash_vfx 的 Slash Noise 月牙（取其亮度当遮罩）叠出月牙形轮廓，
//  再按紫色调染色 —— 观感接近 Unity 包里的紫月牙刀光。
// ═══════════════════════════════════════════════════════════
import * as THREE from 'three';
import { guardFromAO } from './ao-guard.js';

const TRAIL_VERT_SHADER = /* glsl */ `
  attribute float aAlpha;
  attribute float aAcross;
  attribute float aU;
  varying float vAlpha;
  varying float vAcross;
  varying float vU;
  void main() {
    vAlpha = aAlpha;
    vAcross = aAcross;
    vU = aU;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAG_SHADER = /* glsl */ `
  uniform vec3 uColorCore;
  uniform vec3 uColorEdge;
  uniform float uIntensity;
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform float uMapTile;
  varying float vAlpha;
  varying float vAcross;
  varying float vU;

  void main() {
    // 沿刃身：靠刃尖更亮
    float along = smoothstep(0.0, 1.0, vAcross);
    vec3 col = mix(uColorEdge, uColorCore, along);

    // 基础光带（没贴图时就是它）
    float band = 1.0 - abs(vAcross - 0.62) / 0.62;
    band = clamp(band, 0.0, 1.0);
    float a = vAlpha * (0.45 + 0.55 * along) * (0.40 + 0.60 * band);

    if (uUseMap > 0.5) {
      // 月牙贴图：u 沿时间平铺，v 沿刃身；取亮度当遮罩
      vec4 t = texture2D(uMap, vec2(vU * uMapTile, vAcross));
      float lum = max(max(t.r, t.g), t.b);
      // 月牙本身是亮弧 + 黑底，用 luminance 做遮罩比 alpha 稳
      float mask = pow(clamp(lum, 0.0, 1.0), 0.55);
      // 贴图只做「提亮」，不做硬遮罩：保留基础光带，月牙处更亮，
      // 这样既看得出月牙轮廓，又不会把整条轨迹抠成一缕
      a *= (0.50 + 0.85 * mask);
      // 更「电」：月牙处叠紫电高光，核心再点一层近白热
      col += vec3(0.80, 0.35, 1.15) * pow(mask, 1.15) * 1.5;
      col = mix(col, vec3(1.0, 0.94, 1.0), pow(mask, 3.0) * 0.55);
    }

    a *= uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(col * (0.7 + 0.6 * along), a);
  }
`;

export class BladeTrail {
  /**
   * @param scene
   * @param opts.maxSamples 采样上限（越多越长越顺）
   * @param opts.life 秒：采样存活时间，决定轨迹「拖多久」
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.maxSamples = opts.maxSamples ?? 64;
    this.life = opts.life ?? 0.24;
    this.samples = [];        // { base:Vector3, tip:Vector3, t:number }
    this.time = 0;
    this.enabled = true;

    const verts = this.maxSamples * 2;
    const geo = new THREE.BufferGeometry();
    this.posArr = new Float32Array(verts * 3);
    this.alphaArr = new Float32Array(verts);
    this.acrossArr = new Float32Array(verts);
    this.uArr = new Float32Array(verts);
    const idx = [];
    for (let i = 0; i < this.maxSamples - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaArr, 1));
    geo.setAttribute('aAcross', new THREE.BufferAttribute(this.acrossArr, 1));
    geo.setAttribute('aU', new THREE.BufferAttribute(this.uArr, 1));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColorCore: { value: new THREE.Color(0xffffff) },
        uColorEdge: { value: new THREE.Color(0xdfefff) },
        uIntensity: { value: 1.0 },
        uMap: { value: null },
        uUseMap: { value: 0 },
        uMapTile: { value: 1 },
      },
      vertexShader: TRAIL_VERT_SHADER,
      fragmentShader: TRAIL_FRAG_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;

    // 加色透明薄片不能被 AO 预通道当成实心几何（否则下方会糊一块黑斑）
    guardFromAO(this.mesh, this.material);
    this.geo = geo;
    scene.add(this.mesh);
  }

  setColors(core, edge) {
    this.material.uniforms.uColorCore.value.set(core);
    this.material.uniforms.uColorEdge.value.set(edge);
  }

  /** 套上月牙贴图（传 null 关闭） */
  setMap(texture, tile = 1) {
    this.material.uniforms.uMap.value = texture || null;
    this.material.uniforms.uUseMap.value = texture ? 1 : 0;
    this.material.uniforms.uMapTile.value = tile;
  }

  /** 每帧调用：刃根 / 刃尖世界坐标 */
  push(base, tip, dt) {
    if (!this.enabled) return;
    this.time += dt;
    const last = this.samples[this.samples.length - 1];
    // 位移太小就不新增采样，避免静止时堆一堆重合点
    if (!last || last.base.distanceToSquared(base) > 1e-6 || last.tip.distanceToSquared(tip) > 1e-6) {
      this.samples.push({ base: base.clone(), tip: tip.clone(), t: this.time });
      if (this.samples.length > this.maxSamples) this.samples.shift();
    }
    this._rebuild();
  }

  _rebuild() {
    const cutoff = this.time - this.life;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    const n = this.samples.length;
    const geo = this.geo;
    if (n < 2) { geo.setDrawRange(0, 0); return; }

    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const age = this.time - s.t;
      const fade = Math.max(0, 1 - age / this.life);
      const a = i * 6;
      this.posArr[a + 0] = s.base.x; this.posArr[a + 1] = s.base.y; this.posArr[a + 2] = s.base.z;
      this.posArr[a + 3] = s.tip.x;  this.posArr[a + 4] = s.tip.y;  this.posArr[a + 5] = s.tip.z;
      const v = i * 2;
      this.alphaArr[v + 0] = fade * 0.45;   // 刃根也亮，光带才铺满整条剑身
      this.alphaArr[v + 1] = fade * 0.72;
      this.acrossArr[v + 0] = 0;
      this.acrossArr[v + 1] = 1;
      const u = i / (n - 1);          // 0 最老 → 1 最新
      this.uArr[v + 0] = u;
      this.uArr[v + 1] = u;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aAcross.needsUpdate = true;
    geo.attributes.aU.needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
  }

  /** 没在挥剑时把轨迹尽快收掉 */
  release(dt) {
    this.time += dt;
    this._rebuild();
  }

  clear() {
    this.samples.length = 0;
    this.geo.setDrawRange(0, 0);
  }
}
