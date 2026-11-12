import fs from 'node:fs';
import path from 'node:path';

function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

const dir = process.argv[2] ?? 'assets/anim';
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.glb')).sort();

console.log(`\n${'animation'.padEnd(30)} ${'dur(s)'.padStart(7)} ${'tracks'.padStart(7)}  bones`);
console.log('-'.repeat(80));

let skeletonSample = null;
for (const f of files) {
  const g = readGlbJson(path.join(dir, f));
  const anim = g.animations?.[0];
  if (!anim) { console.log(`${f.padEnd(30)}  (no animation)`); continue; }

  // 时长 = 所有 input accessor 的 max 里的最大值
  let dur = 0;
  for (const s of anim.samplers) {
    const acc = g.accessors[s.input];
    if (acc?.max?.[0] > dur) dur = acc.max[0];
  }
  const bones = (g.skins?.[0]?.joints ?? []).length;
  const boneNames = (g.skins?.[0]?.joints ?? []).slice(0, 2).map((i) => g.nodes[i].name);

  if (skeletonSample === null) skeletonSample = boneNames;
  const same = JSON.stringify(boneNames) === JSON.stringify(skeletonSample) ? '' : '  <-- DIFFERENT RIG';

  console.log(`${f.replace('.glb', '').padEnd(30)} ${dur.toFixed(2).padStart(7)} ${String(anim.channels.length).padStart(7)}  ${bones}${same}`);
}

console.log('\nsample bone names:', skeletonSample);
