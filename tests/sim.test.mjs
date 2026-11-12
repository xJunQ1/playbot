import { CFG, MOVES, totalFrames, motionAt, dumpJSON } from '../src/frame-data.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\n[帧表]');
ok('p_heavy 总帧 = 80', totalFrames(MOVES.p_heavy) === 80, totalFrames(MOVES.p_heavy));
ok('b_sweep 总帧 = 90', totalFrames(MOVES.b_sweep) === 90, totalFrames(MOVES.b_sweep));
ok('b_charge 判定落在起手后', MOVES.b_charge.startup === 13 && MOVES.b_charge.active === 10);

console.log('\n[motion 曲线]');
ok('motionAt 起点为 0', motionAt(MOVES.b_sweep, 0) === 0);
ok('motionAt 动画结束后保持终值', motionAt(MOVES.b_charge, 200) === 5.6, motionAt(MOVES.b_charge, 200));
ok('motionAt 单调不减（sweep）', (() => {
  let prev = -1;
  for (let f = 0; f <= 90; f++) { const d = motionAt(MOVES.b_sweep, f); if (d < prev - 1e-9) return false; prev = d; }
  return true;
})());

console.log('\n[判定几何]');
function cylinderHit(aPos, aR, aY0, aY1, bPos, bR, bY0, bY1) {
  const dx = aPos.x - bPos.x, dz = aPos.z - bPos.z;
  if (dx * dx + dz * dz > (aR + bR) * (aR + bR)) return false;
  return aY1 > bY0 && aY0 < bY1;
}
const V = (x, z) => ({ x, z });
ok('正前方命中', cylinderHit(V(0, 2), 1.2, 0, 3, V(0, 0), 0.8, 0, 2));
ok('超出半径不中', cylinderHit(V(0, 6), 1.0, 0, 3, V(0, 0), 0.8, 0, 2) === false);
ok('高度区间不重叠不中', cylinderHit(V(0, 1), 1.0, 5, 7, V(0, 0), 0.8, 0, 2) === false);
ok('贴边判定', cylinderHit(V(0, 1.75), 1.0, 0, 2, V(0, 0), 0.8, 0, 2));

console.log('\n[AI 权重]');
const pick = (dist, recent = []) => {
  const pool = [];
  for (const [id, m] of Object.entries(MOVES)) {
    if (!id.startsWith('b_')) continue;
    if (dist < m.minRange || dist > m.maxRange) continue;
    if (recent.includes(id)) continue;
    const mid = (m.minRange + m.maxRange) / 2;
    const half = Math.max(1, (m.maxRange - m.minRange) / 2);
    const bias = Math.max(0.15, 1 - (Math.abs(dist - mid) / half) * 0.7);
    pool.push({ id, w: m.weight * bias });
  }
  return pool;
};
const far = pick(12);
ok('远距离突进权重最高', far.sort((a, b) => b.w - a.w)[0].id === 'b_charge',
  JSON.stringify(far));
ok('贴身有 sweep/slam/roar', pick(2).length >= 3, pick(2).length);
ok('三连禁止生效', pick(2, ['b_sweep', 'b_slam', 'b_roar']).length === 0);
ok('每个距离至少 1 招', [0.5, 2, 4, 6, 8, 12, 15].every(d => pick(d).length > 0));

console.log('\n[配置导出]');
const json = JSON.parse(dumpJSON());
ok('导出含 CFG 与 MOVES', !!json.CFG && !!json.MOVES);
ok('导出可回读帧数', json.MOVES.b_slam.startup === 38);

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
