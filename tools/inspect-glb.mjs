import fs from 'node:fs';
import path from 'node:path';

/** 直接读 GLB 的 JSON chunk，不用三维库，也不需要 DOM */
function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb: ' + file); // 'glTF'
  const jsonLen = buf.readUInt32LE(12);
  const jsonStr = buf.subarray(20, 20 + jsonLen).toString('utf8');
  return JSON.parse(jsonStr);
}

const dir = process.argv[2] ?? 'assets';
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.glb'))) {
  const full = path.join(dir, f);
  try {
    const g = readGlbJson(full);
    const anims = (g.animations ?? []).map((a) => a.name);
    const skins = (g.skins ?? []).length;
    const joints = g.skins?.[0]?.joints?.length ?? 0;
    const meshes = (g.meshes ?? []).length;
    const tris = (g.meshes ?? []).reduce((s, m) => s + (m.primitives ?? []).length, 0);

    console.log(`\n=== ${f} (${Math.round(fs.statSync(full).size / 1024)}KB) ===`);
    console.log(`  skins: ${skins}, joints: ${joints}, meshes: ${meshes}, primitives: ${tris}`);
    console.log(`  animations (${anims.length}):`);
    for (const a of anims) console.log(`    - ${a}`);
  } catch (e) {
    console.log(`\n=== ${f} === read failed: ${e.message}`);
  }
}
