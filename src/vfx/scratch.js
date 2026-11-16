// ─────────────────────────────────────────────────────────────
//  贴地划痕：拖刀时刀刃在地面留下的光带
//
//  · emit(x, z)  追加一个落点（距离太小会自动忽略，避免原地堆点）
//  · update(dt)  点按年龄衰减，超过 life 的整段丢掉
//  · clear()     重开时清空
//
//  一条预分配的三角带（最多 maxPoints 个点），每帧只改 position/color
//  和 drawRange，不重新建几何体，所以没有 GC 抖动。
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';

export class GroundScratch {
  constructor(scene, opts = {}) {
    this.life = opts.life ?? 1.6;        // 痕迹存在多久（秒）
    this.width = opts.width ?? 0.09;     // 宽度（米）
    this.strength = opts.strength ?? 0.34;
    this.minStep = opts.minStep ?? 0.05; // 多少米记一个点
    this.maxPoints = opts.maxPoints ?? 160;
    this.y = opts.y ?? 0.02;

    this.baseColor = new THREE.Color(opts.color ?? 0x8c1a08);
    this.hotColor = new THREE.Color(opts.hotColor ?? 0xff5a1e);

    this.pts = [];

    const max = this.maxPoints;
    this.posArr = new Float32Array(max * 2 * 3);
    this.colArr = new Float32Array(max * 2 * 3);

    const idx = new Uint16Array((max - 1) * 6);
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[i * 6 + 0] = a; idx[i * 6 + 1] = b; idx[i * 6 + 2] = c;
      idx[i * 6 + 3] = b; idx[i * 6 + 4] = d; idx[i * 6 + 5] = c;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    this.geo = geo;
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get count() { return this.pts.length; }

  emit(x, z) {
    const last = this.pts[this.pts.length - 1];
    if (last) {
      const dx = x - last.x, dz = z - last.z;
      if (dx * dx + dz * dz < this.minStep * this.minStep) return;
    }
    this.pts.push({ x, z, age: 0 });
    if (this.pts.length > this.maxPoints) this.pts.shift();
  }

  update(dt) {
    const n0 = this.pts.length;
    if (n0 === 0) { this.mesh.visible = false; return; }

    if (dt > 0) {
      for (const p of this.pts) p.age += dt;
      while (this.pts.length && this.pts[0].age > this.life) this.pts.shift();
    }

    const n = this.pts.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); this.mesh.visible = false; return; }

    const halfW = this.width * 0.5;

    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      const prev = this.pts[i > 0 ? i - 1 : 0];
      const next = this.pts[i < n - 1 ? i + 1 : n - 1];

      let dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;

      // 只有尾端收尖；头部（贴着刀刃）保持满宽，才不会变成叶子形
      const t = n === 1 ? 1 : i / (n - 1);   // 0 = 最老，1 = 最新
      const taper = Math.min(1, t * 4 + 0.12);
      const w = halfW * (0.30 + 0.70 * taper);

      // 越新越亮、偏白热；越老越暗、偏暗红
      const k = Math.max(0, 1 - p.age / this.life);
      const a = Math.pow(k, 2.0) * this.strength;

      const b = i * 6;
      this.posArr[b + 0] = p.x + nx * w;
      this.posArr[b + 1] = this.y;
      this.posArr[b + 2] = p.z + nz * w;
      this.posArr[b + 3] = p.x - nx * w;
      this.posArr[b + 4] = this.y;
      this.posArr[b + 5] = p.z - nz * w;

      const r = (this.baseColor.r * 0.35 + this.hotColor.r * 0.65 * k) * a;
      const g = (this.baseColor.g * 0.35 + this.hotColor.g * 0.65 * k) * a;
      const bl = (this.baseColor.b * 0.35 + this.hotColor.b * 0.65 * k) * a;

      this.colArr[b + 0] = r; this.colArr[b + 1] = g; this.colArr[b + 2] = bl;
      this.colArr[b + 3] = r; this.colArr[b + 4] = g; this.colArr[b + 5] = bl;
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }

  clear() {
    this.pts.length = 0;
    this.geo.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  dispose() {
    this.clear();
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
