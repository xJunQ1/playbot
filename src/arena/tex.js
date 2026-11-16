import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────
//  程序化贴图：全部用 canvas 画，不依赖任何外部图片
//  参考图是「紫色雾 + 暗石板 + 金色魔法阵 + 猩红布幔」，
//  这里所有颜色都按这张图的取样值来定
// ─────────────────────────────────────────────────────────────

const rnd = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)(20261116);

function canvas(size, h) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h ?? size;
  return c;
}

function tex(c, { srgb = true, repeat = 1, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  return t;
}

/** 台面：同心环状石板 + 勾缝 + 污渍 + 猩红渗色 */
export function makeFloorTexture(size = 2048, meters = 44) {
  const c = canvas(size), g = c.getContext('2d');
  const px = size / meters;
  const cx = size / 2, cy = size / 2;

  g.fillStyle = '#3a3648';
  g.fillRect(0, 0, size, size);

  // 同心石板：每一圈是一环，环内再按角度切段
  const ring = 0.62 * px;
  for (let r = 0.2 * px; r < (meters / 2) * px; r += ring) {
    const n = Math.max(18, Math.round((Math.PI * 2 * r) / (ring * 2.4)));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const v = 0.9 + rnd() * 0.22;
      const base = [58, 54, 70];
      g.fillStyle = `rgb(${Math.round(base[0] * v)},${Math.round(base[1] * v)},${Math.round(base[2] * v)})`;
      g.beginPath();
      g.arc(cx, cy, r + ring * 0.92, a0, a1);
      g.arc(cx, cy, r, a1, a0, true);
      g.closePath();
      g.fill();
    }
  }

  // 勾缝
  g.strokeStyle = 'rgba(18,15,24,0.8)';
  g.lineWidth = Math.max(1, px * 0.03);
  for (let r = 0.2 * px; r < (meters / 2) * px; r += ring) {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  }
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * ring * 0.6, cy + Math.sin(a) * ring * 0.6);
    g.lineTo(cx + Math.cos(a) * (meters / 2) * px, cy + Math.sin(a) * (meters / 2) * px);
    g.stroke();
  }

  // 石面脏迹：一堆半透明斑块
  for (let i = 0; i < 900; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (meters / 2) * px;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const rad = (0.08 + rnd() * 0.5) * px;
    const dark = rnd() > 0.45;
    g.fillStyle = dark ? `rgba(16,13,22,${0.03 + rnd() * 0.07})` : `rgba(150,142,170,${0.02 + rnd() * 0.04})`;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }

  // 猩红渗色：只压在最外一圈，参考图里血迹沿边缘最重、中心是干净的
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = (0.72 + rnd() * 0.26) * (meters / 2) * px;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const rad = (0.5 + rnd() * 2.0) * px;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(110,8,24,0.3)');
    gr.addColorStop(0.55, 'rgba(88,6,20,0.12)');
    gr.addColorStop(1, 'rgba(60,4,14,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }

  return tex(c, { aniso: 16 });
}

/** 金色魔法阵：透明底，只画线，叠在台面上做加法混合 */
export function makeMagicTexture(size = 4096, meters = 44, scale = 1) {
  const c = canvas(size), g = c.getContext('2d');
  const px = size / meters;
  const cx = size / 2, cy = size / 2;
  // scale 用来让法阵跟着台面半径走：台面放大时法阵同比放大，不会缩在中间
  const R = (m) => m * scale * px;

  g.translate(cx, cy);
  g.lineCap = 'round';

  const gold = (w, a = 1) => {
    g.strokeStyle = `rgba(240,206,146,${a})`;
    g.lineWidth = w;
    g.shadowColor = 'rgba(255,206,130,0.9)';
    g.shadowBlur = w * 4;
  };
  const ring = (r, w = 3, a = 1) => {
    gold(w, a); g.beginPath(); g.arc(0, 0, R(r), 0, Math.PI * 2); g.stroke();
  };
  /** 正多边形（八芒星 = 两个正方形叠出来的，参考图正中就是这个结构） */
  const polygon = (n, r, rot = 0, w = 2.4, a = 1) => {
    gold(w, a);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(ang) * R(r), y = Math.sin(ang) * R(r);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.stroke();
  };

  // 外沿：粗环 + 内细环 + 齿状刻度
  ring(20.75, 4.2); ring(20.2, 1.8, 0.6);
  ring(17.4, 2.4, 0.9);
  // 主阵：参考图是「每一道粗环旁边跟一道细环」，六道环套下来才有法阵的密度
  ring(15.65, 1.5, 0.6);
  ring(13.6, 2.6); ring(13.1, 1.4, 0.55);
  ring(10.4, 3.0); ring(9.95, 1.4, 0.55);
  ring(7.35, 2.4, 0.95);
  ring(5.6, 1.6, 0.6);
  ring(4.55, 2.2, 0.9);
  ring(2.4, 3.0);

  // 八芒星：两个正方形（一大一小）
  polygon(4, 10.35, 0, 2.6);
  polygon(4, 10.35, Math.PI / 4, 2.6);
  polygon(4, 7.35, 0, 2.0, 0.9);
  polygon(4, 7.35, Math.PI / 4, 2.0, 0.9);

  // 外环上的符文刻度（长刻度每 6 个一根）
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const long = i % 6 === 0;
    const r0 = long ? 17.5 : 17.85, r1 = 18.9;
    gold(long ? 2.6 : 1.2, long ? 0.9 : 0.45);
    g.beginPath();
    g.moveTo(Math.cos(a) * R(r0), Math.sin(a) * R(r0));
    g.lineTo(Math.cos(a) * R(r1), Math.sin(a) * R(r1));
    g.stroke();
  }

  // 主阵到外环之间的细辐条
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2 + Math.PI / 144;
    gold(1.0, 0.28);
    g.beginPath();
    g.moveTo(Math.cos(a) * R(13.55), Math.sin(a) * R(13.55));
    g.lineTo(Math.cos(a) * R(17.35), Math.sin(a) * R(17.35));
    g.stroke();
  }

  // 中心徽记：八芒小星 + 宝石
  polygon(4, 2.1, 0, 2.2, 0.95);
  polygon(4, 2.1, Math.PI / 4, 2.2, 0.95);
  gold(2.2, 0.9);
  g.beginPath();
  g.moveTo(0, -R(1.35)); g.lineTo(R(0.62), 0); g.lineTo(0, R(1.35)); g.lineTo(-R(0.62), 0);
  g.closePath(); g.stroke();

  return tex(c, { aniso: 16, repeat: 1 });
}

/** 猩红布幔：渐变布面 + 徽记 + 破口 */
export function makeBannerTexture() {
  const w = 256, h = 768;
  const c = canvas(w, h), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#8c1226');
  gr.addColorStop(0.35, '#a3182f');
  gr.addColorStop(0.75, '#6d0d1d');
  gr.addColorStop(1, '#3d0611');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);

  // 纵向褶皱
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w, ww = 4 + rnd() * 22;
    g.fillStyle = rnd() > 0.5 ? `rgba(255,120,140,${0.03 + rnd() * 0.05})` : `rgba(0,0,0,${0.05 + rnd() * 0.08})`;
    g.fillRect(x, 0, ww, h);
  }

  // 徽记：向上收拢的尖顶十字 + 环
  g.strokeStyle = 'rgba(232,196,148,0.85)';
  g.lineWidth = 6;
  g.beginPath(); g.arc(w / 2, h * 0.3, 52, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(w / 2, h * 0.19); g.lineTo(w / 2, h * 0.42);
  g.moveTo(w / 2 - 40, h * 0.29); g.lineTo(w / 2 + 40, h * 0.29);
  g.stroke();

  // 下摆破口
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    const x = (i / 14) * w + rnd() * 14;
    const hh = 20 + rnd() * 70;
    g.beginPath(); g.moveTo(x, h); g.lineTo(x + 20, h - hh); g.lineTo(x + 44, h); g.closePath(); g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  return tex(c);
}

/** 火焰 / 灵火：径向渐变 + 竖向拉长 */
export function makeFlameTexture(color = [255, 190, 120]) {
  const s = 256, c = canvas(s), g = c.getContext('2d');
  const gr = g.createRadialGradient(s / 2, s * 0.62, 0, s / 2, s * 0.62, s * 0.5);
  gr.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},1)`);
  gr.addColorStop(0.25, `rgba(${color[0]},${Math.round(color[1] * 0.72)},${Math.round(color[2] * 0.4)},0.75)`);
  gr.addColorStop(0.6, `rgba(210,60,40,0.22)`);
  gr.addColorStop(1, 'rgba(120,10,20,0)');
  g.fillStyle = gr;
  g.beginPath(); g.ellipse(s / 2, s * 0.6, s * 0.34, s * 0.46, 0, 0, Math.PI * 2); g.fill();
  return tex(c);
}

/** 雾团：一堆软斑，做云海 */
export function makeCloudTexture() {
  const s = 512, c = canvas(s), g = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + (rnd() - 0.5) * s * 0.66;
    const y = s / 2 + (rnd() - 0.5) * s * 0.5;
    const r = s * (0.08 + rnd() * 0.22);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(226,214,232,${0.16 + rnd() * 0.12})`);
    gr.addColorStop(1, 'rgba(200,186,214,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return tex(c);
}

/** 猩红枝叶：一簇小叶片，用于场边灌木 */
export function makeLeafTexture() {
  const s = 256, c = canvas(s), g = c.getContext('2d');
  for (let i = 0; i < 90; i++) {
    const x = rnd() * s, y = rnd() * s;
    const a = rnd() * Math.PI, l = 6 + rnd() * 13, w = 3 + rnd() * 6;
    g.save(); g.translate(x, y); g.rotate(a);
    const shade = 0.55 + rnd() * 0.45;
    g.fillStyle = `rgba(${Math.round(150 * shade + 40)},${Math.round(16 * shade)},${Math.round(34 * shade + 8)},${0.5 + rnd() * 0.4})`;
    g.beginPath(); g.ellipse(0, 0, l, w, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  return tex(c);
}

/** 粗石面：柱、雕像、台阶 */
export function makeStoneTexture(size = 512, tint = [64, 58, 74]) {
  const c = canvas(size), g = c.getContext('2d');
  g.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 1400; i++) {
    const v = 0.7 + rnd() * 0.6;
    g.fillStyle = `rgba(${Math.round(tint[0] * v)},${Math.round(tint[1] * v)},${Math.round(tint[2] * v)},${0.12 + rnd() * 0.2})`;
    const r = 1 + rnd() * 9;
    g.beginPath(); g.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2); g.fill();
  }
  // 裂纹
  g.strokeStyle = 'rgba(14,12,18,0.5)';
  for (let i = 0; i < 22; i++) {
    g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath();
    let x = rnd() * size, y = rnd() * size;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 90; y += (rnd() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
  }
  return tex(c, { repeat: 2 });
}

/**
 * 从灰度高度图生成法线贴图：把现成的石面贴图当高度用，Sobel 求梯度。
 * 这是「不像塑料/积木」最省事的一步：平面一旦有法线细节，轮廓再简单也像石头。
 */
export function makeNormalMap(src, strength = 2.2) {
  const w = src.width, h = src.height;
  const c = canvas(w, h), g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const data = g.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  const out = g.createImageData(w, h);
  const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
/**
 * 浮雕高度图：一个开间（壁柱 + 尖拱盲窗 + 拱肩卷草 + 束带 + 锯齿檐带）。
 * 灰度就是高度：0 = 最深凹槽，1 = 最高凸起。配合 makeNormalMap 用。
 */
export function makeReliefTile(size = 1024) {
  const c = canvas(size), g = c.getContext('2d');
  const S = size;
  const px = (v) => v * S;

  // 底：石材基面
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, S, S);

  // 石面细微起伏，避免法线是死平的
  for (let i = 0; i < 1200; i++) {
    const v = 110 + Math.random() * 50;
    g.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},${0.05 + Math.random() * 0.08})`;
    g.beginPath();
    g.arc(Math.random() * S, Math.random() * S, 2 + Math.random() * 14, 0, Math.PI * 2);
    g.fill();
  }

  const rect = (x, y, w, h, v) => {
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(px(x), px(y), px(w), px(h));
  };
  const vline = (x, y0, y1, w, v) => rect(x - w / 2, y0, w, y1 - y0, v);

  // ① 两侧壁柱（凸）+ 柱身凹槽（三条竖槽）
  rect(0.00, 0.00, 0.13, 1.00, 168);
  rect(0.87, 0.00, 0.13, 1.00, 168);
  for (const x of [0.045, 0.075, 0.105]) vline(x, 0.10, 0.92, 0.012, 96);
  for (const x of [0.915, 0.945, 0.975]) vline(x, 0.10, 0.92, 0.012, 96);
  // 柱头 / 柱础
  rect(0.00, 0.02, 0.15, 0.05, 205);
  rect(0.85, 0.02, 0.15, 0.05, 205);
  rect(0.00, 0.90, 0.15, 0.06, 205);
  rect(0.85, 0.90, 0.15, 0.06, 205);

  // ② 中央尖拱盲窗：外凸券线 + 内部深凹
  const cx = 0.5, springY = 0.44, archR = 0.30, topY = 0.16;
  g.fillStyle = 'rgb(58,58,58)';
  g.beginPath();
  g.moveTo(px(cx - archR), px(0.86));
  g.lineTo(px(cx - archR), px(springY));
  g.quadraticCurveTo(px(cx - archR * 0.75), px(topY + 0.06), px(cx), px(topY));
  g.quadraticCurveTo(px(cx + archR * 0.75), px(topY + 0.06), px(cx + archR), px(springY));
  g.lineTo(px(cx + archR), px(0.86));
  g.closePath();
  g.fill();

  // 券线（凸起）
  g.strokeStyle = 'rgb(206,206,206)';
  g.lineWidth = px(0.026);
  g.beginPath();
  g.moveTo(px(cx - archR), px(0.86));
  g.lineTo(px(cx - archR), px(springY));
  g.quadraticCurveTo(px(cx - archR * 0.75), px(topY + 0.06), px(cx), px(topY));
  g.quadraticCurveTo(px(cx + archR * 0.75), px(topY + 0.06), px(cx + archR), px(springY));
  g.lineTo(px(cx + archR), px(0.86));
  g.stroke();

  // ③ 盲窗里的四叶饰（凸）
  for (const [ox, oy] of [[-0.10, 0.60], [0.10, 0.60], [-0.10, 0.76], [0.10, 0.76]]) {
    g.fillStyle = 'rgb(186,186,186)';
    g.beginPath();
    g.arc(px(cx + ox), px(oy), px(0.065), 0, Math.PI * 2);
    g.fill();
  }
  // 中心圆凸
  g.fillStyle = 'rgb(210,210,210)';
  g.beginPath();
  g.arc(px(cx), px(0.68), px(0.045), 0, Math.PI * 2);
  g.fill();

  // ④ 拱肩卷草：两侧各一对螺旋
  const spiral = (x, y, r, dir, v) => {
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = px(0.018);
    g.beginPath();
    for (let a = 0; a < Math.PI * 3.4; a += 0.12) {
      const rr = r * (1 - a / (Math.PI * 4.2));
      const px2 = x + Math.cos(a * dir) * rr;
      const py2 = y + Math.sin(a * dir) * rr;
      a === 0 ? g.moveTo(px(px2), px(py2)) : g.lineTo(px(px2), px(py2));
    }
    g.stroke();
  };
  spiral(0.24, 0.28, 0.10, 1, 196);
  spiral(0.76, 0.28, 0.10, -1, 196);
  spiral(0.20, 0.20, 0.06, -1, 176);
  spiral(0.80, 0.20, 0.06, 1, 176);

  // ⑤ 底部束带 + 齿饰
  rect(0.13, 0.86, 0.74, 0.05, 190);
  rect(0.13, 0.91, 0.74, 0.03, 96);
  for (let i = 0; i < 12; i++) rect(0.15 + i * 0.058, 0.945, 0.03, 0.03, 200);

  // ⑥ 顶部锯齿檐带
  g.strokeStyle = 'rgb(200,200,200)';
  g.lineWidth = px(0.014);
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const x0 = 0.13 + i * 0.046;
    g.moveTo(px(x0), px(0.10));
    g.lineTo(px(x0 + 0.023), px(0.045));
    g.lineTo(px(x0 + 0.046), px(0.10));
  }
  g.stroke();

  // ⑦ 圆凸钉（一排小凸起）
  for (let i = 0; i < 5; i++) {
    g.fillStyle = 'rgb(215,215,215)';
    g.beginPath();
    g.arc(px(0.2 + i * 0.15), px(0.135), px(0.016), 0, Math.PI * 2);
    g.fill();
  }

  // 轻微模糊，避免法线出现硬阶梯
  return c;
}
/** 把浮雕灰度正片叠底到石材上，得到「已经吃进阴影」的墙面颜色图 */
export function makeReliefAlbedo(relief, stone, tint = '140,132,168', tintAlpha = 0.32) {
  const w = stone.width, h = stone.height;
  const c = canvas(w, h), g = c.getContext('2d');
  g.drawImage(stone, 0, 0, w, h);

  const tmp = canvas(w, h), tg = tmp.getContext('2d');
  tg.drawImage(relief, 0, 0, w, h);

  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = 0.85;
  g.drawImage(tmp, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  g.fillStyle = `rgba(${tint},${tintAlpha})`;
  g.globalCompositeOperation = 'overlay';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  return tex(c);
}
/**
 * 地面浮雕高度图：石板分块 + 倒角勾缝 + 缺角 + 磨损。
 * 灰度即高度：0 深、1 高。铺在台面法线上，低头看才有石板的厚度。
 */
export function makeFloorRelief(size = 1024, cells = 4) {
  const c = canvas(size), g = c.getContext('2d');
  const S = size, step = S / cells, gap = S * 0.012;

  g.fillStyle = 'rgb(64,64,64)';       // 勾缝底（凹）
  g.fillRect(0, 0, S, S);

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = i * step + gap, y = j * step + gap;
      const w = step - gap * 2, h = step - gap * 2;
      const v = 150 + Math.random() * 40;

      // 板面：中间略高，四周收边（模拟微鼓的石板）
      const grd = g.createRadialGradient(x + w / 2, y + h / 2, w * 0.1, x + w / 2, y + h / 2, w * 0.72);
      grd.addColorStop(0, `rgb(${v + 18 | 0},${v + 18 | 0},${v + 18 | 0})`);
      grd.addColorStop(0.75, `rgb(${v | 0},${v | 0},${v | 0})`);
      grd.addColorStop(1, `rgb(${v - 34 | 0},${v - 34 | 0},${v - 34 | 0})`);
      g.fillStyle = grd;
      g.beginPath();
      g.roundRect(x, y, w, h, S * 0.006);
      g.fill();

      // 左上倒角高光 / 右下倒角阴影
      g.strokeStyle = 'rgba(225,225,225,0.55)';
      g.lineWidth = S * 0.006;
      g.beginPath();
      g.moveTo(x + w * 0.04, y + h - w * 0.04);
      g.lineTo(x + w * 0.04, y + w * 0.04);
      g.lineTo(x + w - w * 0.04, y + w * 0.04);
      g.stroke();

      g.strokeStyle = 'rgba(40,40,40,0.6)';
      g.beginPath();
      g.moveTo(x + w - w * 0.04, y + w * 0.04);
      g.lineTo(x + w - w * 0.04, y + h - w * 0.04);
      g.lineTo(x + w * 0.04, y + h - w * 0.04);
      g.stroke();

      // 缺角 / 崩边
      for (let k = 0; k < 3; k++) {
        if (Math.random() > 0.55) continue;
        g.fillStyle = 'rgba(50,50,50,0.75)';
        g.beginPath();
        g.arc(x + Math.random() * w, y + Math.random() * h, S * (0.004 + Math.random() * 0.012), 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // 整体磨损：几块淡的大斑，避免 4×4 太规整
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = S * (0.02 + Math.random() * 0.09);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() > 0.5;
    grd.addColorStop(0, dark ? 'rgba(60,60,60,0.25)' : 'rgba(210,210,210,0.18)');
    grd.addColorStop(1, 'rgba(128,128,128,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  return c;
}

/**
 * 柱身浮雕高度图：竖向凹槽（fluting）+ 上下柱头束带 + 裂纹。
 * 圆柱 UV 是「一圈 × 一段」，所以横向一条槽会自然变成柱身的一道凹槽。
 */
export function makeColumnRelief(size = 512) {
  const c = canvas(size), g = c.getContext('2d');
  const S = size;

  g.fillStyle = 'rgb(150,150,150)';
  g.fillRect(0, 0, S, S);

  // 竖向凹槽：8 道，边缘带柔和过渡（避免法线出现刀切边）
  const flutes = 8;
  for (let i = 0; i < flutes; i++) {
    const cx = ((i + 0.5) / flutes) * S;
    const w = S / flutes * 0.44;
    const grd = g.createLinearGradient(cx - w, 0, cx + w, 0);
    grd.addColorStop(0, 'rgba(150,150,150,0)');
    grd.addColorStop(0.28, 'rgba(78,78,78,0.95)');
    grd.addColorStop(0.72, 'rgba(78,78,78,0.95)');
    grd.addColorStop(1, 'rgba(150,150,150,0)');
    g.fillStyle = grd;
    g.fillRect(cx - w, 0, w * 2, S);

    // 槽间的棱（微凸）
    const ridgeX = (i / flutes) * S;
    g.fillStyle = 'rgba(205,205,205,0.5)';
    g.fillRect(ridgeX - S * 0.006, 0, S * 0.012, S);
  }

  // 上柱头 / 下柱础：横向束带
  const bands = [
    [0.02, 0.06, 215], [0.085, 0.025, 96], [0.115, 0.05, 205],
    [0.86, 0.05, 205], [0.915, 0.03, 92], [0.95, 0.045, 215],
  ];
  for (const [y, h, v] of bands) {
    g.fillStyle = `rgba(${v},${v},${v},1)`;
    g.fillRect(0, y * S, S, h * S);
  }

  // 横向裂纹 / 缺石
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = 'rgba(58,58,58,0.8)';
    g.lineWidth = 0.8 + Math.random() * 2.2;
    g.beginPath();
    let x = Math.random() * S, y = 0.16 * S + Math.random() * 0.66 * S;
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (Math.random() - 0.5) * S * 0.12;
      y += (Math.random() - 0.5) * S * 0.06;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  return c;
}
/**
 * 柱头浮雕高度图：一圈茛苕叶（acanthus）+ 下方的珠饰带 + 顶部的卵箭饰。
 * 圆柱 UV 一圈 = 一张图，所以这里是「环向排布」：叶尖朝上。
 */
export function makeCapitalRelief(size = 512) {
  const c = canvas(size), g = c.getContext('2d');
  const S = size;

  g.fillStyle = 'rgb(120,120,120)';    // 叶间底（凹）
  g.fillRect(0, 0, S, S);

  // 在一片叶子的局部坐标里画：叶柄 → 主脉 → 两侧裂片 → 叶尖
  const leaf = (cx, baseY, w, h, tilt) => {
    g.save();
    g.translate(cx, baseY);
    g.rotate(tilt);
    // 叶片主体（凸起）
    g.fillStyle = 'rgb(196,196,196)';
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-w, -h * 0.45, -w * 0.42, -h * 0.92);
    g.quadraticCurveTo(0, -h * 1.04, w * 0.42, -h * 0.92);
    g.quadraticCurveTo(w, -h * 0.45, 0, 0);
    g.closePath();
    g.fill();

    // 主脉（凹）
    g.strokeStyle = 'rgb(120,120,120)';
    g.lineWidth = S * 0.006;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(0, -h * 0.5, 0, -h * 0.98);
    g.stroke();

    // 侧裂片：每侧 3 条弧，越往上越小
    for (let k = 0; k < 3; k++) {
      const yy = -h * (0.22 + k * 0.26);
      const len = w * (0.85 - k * 0.18);
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.moveTo(0, yy);
        g.quadraticCurveTo(sgn * len * 0.6, yy - h * 0.04, sgn * len, yy - h * 0.16);
        g.stroke();
      }
    }
    // 叶尖高光
    g.fillStyle = 'rgb(226,226,226)';
    g.beginPath();
    g.ellipse(0, -h * 0.95, w * 0.12, h * 0.05, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };

  // 一圈大叶（8 片）+ 一圈错位的小叶（8 片）
  const n = 8;
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * S;
    leaf(x, S * 0.80, S * 0.062, S * 0.50, (i % 2 ? 0.05 : -0.05));
  }
  for (let i = 0; i < n; i++) {
    const x = (i / n) * S;
    leaf(x, S * 0.88, S * 0.042, S * 0.34, (i % 2 ? -0.04 : 0.04));
  }

  // 底部珠饰带：一排小圆珠（凸）
  for (let i = 0; i < 24; i++) {
    const x = (i / 24) * S + S * 0.02;
    g.fillStyle = 'rgb(214,214,214)';
    g.beginPath();
    g.arc(x, S * 0.93, S * 0.016, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgb(96,96,96)';
    g.beginPath();
    g.arc(x + S * 0.021, S * 0.93, S * 0.009, 0, Math.PI * 2);
    g.fill();
  }

  // 顶部卵箭饰：一排半圆 + 箭尖
  for (let i = 0; i < 16; i++) {
    const x = ((i + 0.5) / 16) * S;
    g.fillStyle = 'rgb(206,206,206)';
    g.beginPath();
    g.ellipse(x, S * 0.12, S * 0.024, S * 0.045, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgb(102,102,102)';
    g.beginPath();
    g.moveTo(x - S * 0.006, S * 0.055);
    g.lineTo(x, S * 0.028);
    g.lineTo(x + S * 0.006, S * 0.055);
    g.closePath();
    g.fill();
  }

  return c;
}
/** 做旧黄铜：颜色图（金 + 暗绿锈斑 + 纵向流痕）+ 粗糙度图 */
export function makeBrassTextures(size = 512) {
  const color = canvas(size), g = color.getContext('2d');
  const rough = canvas(size), r = rough.getContext('2d');

  g.fillStyle = '#c9a25e';
  g.fillRect(0, 0, size, size);
  r.fillStyle = 'rgb(88,88,88)';         // 底：比较光滑
  r.fillRect(0, 0, size, size);

  // 锈斑：暗绿褐色，圆斑 + 流痕
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const rad = size * (0.02 + Math.random() * 0.09);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(58,44,26,0.55)');
    gr.addColorStop(0.6, 'rgba(74,58,32,0.28)');
    gr.addColorStop(1, 'rgba(120,96,52,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();

    const rr = r.createRadialGradient(x, y, 0, x, y, rad);
    rr.addColorStop(0, 'rgba(215,215,215,0.85)');
    rr.addColorStop(1, 'rgba(90,90,90,0)');
    r.fillStyle = rr;
    r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }

  // 纵向流痕（雨水冲刷的痕迹）
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const w = 1 + Math.random() * 3;
    const h = size * (0.2 + Math.random() * 0.6);
    const y = Math.random() * size;
    g.fillStyle = `rgba(70,52,26,${0.05 + Math.random() * 0.12})`;
    g.fillRect(x, y, w, h);
    r.fillStyle = `rgba(200,200,200,${0.1 + Math.random() * 0.2})`;
    r.fillRect(x, y, w, h);
  }

  // 高光擦亮区：几块亮金
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const rad = size * (0.01 + Math.random() * 0.04);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(240,214,150,0.5)');
    gr.addColorStop(1, 'rgba(240,214,150,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();

    const rr = r.createRadialGradient(x, y, 0, x, y, rad);
    rr.addColorStop(0, 'rgba(40,40,40,0.9)');
    rr.addColorStop(1, 'rgba(40,40,40,0)');
    r.fillStyle = rr;
    r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }

  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  return { map, roughnessMap };
}

/**
 * 小石柱（城齿）浮雕：竖向凹槽 + 中部菱形网格 + 顶部一圈珠饰。
 * 比柱身更密，因为这种构件本身就小，花纹要更碎才看得见。
 */
export function makePostRelief(size = 512) {
  const c = canvas(size), g = c.getContext('2d');
  const S = size;

  g.fillStyle = 'rgb(138,138,138)';
  g.fillRect(0, 0, S, S);

  // 竖向凹槽（12 道）
  const n = 12;
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * S;
    const w = S / n * 0.30;
    const gr = g.createLinearGradient(x - w, 0, x + w, 0);
    gr.addColorStop(0, 'rgba(138,138,138,0)');
    gr.addColorStop(0.5, 'rgba(70,70,70,0.95)');
    gr.addColorStop(1, 'rgba(138,138,138,0)');
    g.fillStyle = gr;
    g.fillRect(x - w, S * 0.16, w * 2, S * 0.62);
  }

  // 中部菱形网格（凸起的棱）
  g.strokeStyle = 'rgb(206,206,206)';
  g.lineWidth = S * 0.012;
  for (let i = -6; i <= 6; i++) {
    g.beginPath();
    g.moveTo(i * S * 0.16, S * 0.18);
    g.lineTo(i * S * 0.16 + S * 0.30, S * 0.78);
    g.stroke();
    g.beginPath();
    g.moveTo(i * S * 0.16, S * 0.78);
    g.lineTo(i * S * 0.16 + S * 0.30, S * 0.18);
    g.stroke();
  }

  // 顶部珠饰带 + 底部束带
  for (let i = 0; i < 20; i++) {
    g.fillStyle = 'rgb(222,222,222)';
    g.beginPath();
    g.arc((i / 20) * S + S * 0.025, S * 0.10, S * 0.014, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgb(196,196,196)';
  g.fillRect(0, S * 0.02, S, S * 0.04);
  g.fillStyle = 'rgb(96,96,96)';
  g.fillRect(0, S * 0.88, S, S * 0.03);
  g.fillStyle = 'rgb(196,196,196)';
  g.fillRect(0, S * 0.93, S, S * 0.05);

  return c;
}
/** 地面裂缝贴花：透明底上画带分叉的裂纹（近看地面才不只是贴图） */
export function makeCrackTexture(size = 512) {
  const c = canvas(size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.lineCap = 'round';

  const branch = (x, y, ang, len, width, depth) => {
    if (depth <= 0 || len < 4) return;
    const x2 = x + Math.cos(ang) * len;
    const y2 = y + Math.sin(ang) * len;
    g.strokeStyle = `rgba(14,10,18,${0.55 + Math.random() * 0.3})`;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo((x + x2) / 2 + (Math.random() - 0.5) * 12, (y + y2) / 2 + (Math.random() - 0.5) * 12, x2, y2);
    g.stroke();
    if (Math.random() < 0.55) branch(x2, y2, ang + (Math.random() - 0.5) * 1.1, len * 0.66, width * 0.72, depth - 1);
    if (Math.random() < 0.35) branch(x2, y2, ang + (Math.random() - 0.5) * 1.4, len * 0.5, width * 0.6, depth - 1);
  };

  for (let i = 0; i < 5; i++) {
    const x = size * (0.15 + Math.random() * 0.7);
    const y = size * (0.15 + Math.random() * 0.7);
    for (let k = 0; k < 3; k++) {
      branch(x, y, Math.random() * Math.PI * 2, size * (0.12 + Math.random() * 0.22), 2.4, 5);
    }
  }
  // 边缘压暗，贴花和地面过渡更自然
  const grd = g.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size * 0.52);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}