import fs from 'node:fs';
const p = 'E:/jianmo/女性角色3d模型.glb';
const fd = fs.openSync(p, 'r');
const st = fs.statSync(p);
const head = Buffer.alloc(20);
fs.readSync(fd, head, 0, 20, 0);
const magic = head.toString('utf8', 0, 4);
const jlen = head.readUInt32LE(12);
const jtype = head.toString('utf8', 16, 20);
const jbuf = Buffer.alloc(jlen);
fs.readSync(fd, jbuf, 0, jlen, 20);
fs.closeSync(fd);
console.log('magic:', magic, ' jsonChunk:', jlen, 'bytes type:', jtype);
const g = JSON.parse(jbuf.toString('utf8'));
console.log('文件', (st.size / 1048576).toFixed(1) + 'MB');
console.log('nodes:', (g.nodes || []).length, ' meshes:', (g.meshes || []).length,
            ' skins:', (g.skins || []).length, ' anims:', (g.animations || []).length);
console.log('materials:', (g.materials || []).length, ' images:', (g.images || []).length);
let tris = 0;
for (const m of (g.meshes || [])) for (const pr of (m.primitives || [])) {
  const a = g.accessors[pr.indices]; if (a) tris += a.count / 3;
}
console.log('triangles:', Math.round(tris));
if ((g.skins || []).length) {
  const sk = g.skins[0];
  const names = sk.joints.map(i => g.nodes[i].name);
  console.log('joints:', sk.joints.length);
  console.log('前 18 根骨骼:');
  names.slice(0, 18).forEach((n, i) => console.log('  ' + String(i).padStart(2) + '  ' + n));
  console.log('mixamorig* 骨骼数:', names.filter(n => /mixamorig/i.test(n)).length);
  for (const c of ['Hips', 'Spine', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg', 'Head', 'LeftForeArm', 'RightForeArm'])
    console.log('  含 ' + c + ':', names.some(n => n.includes(c)));
} else {
  console.log('!! 没有 skin —— 静态模型，无法播放骨骼动画');
}
