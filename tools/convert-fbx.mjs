#!/usr/bin/env node
/**
 * 把 Mixamo 下载的 FBX 批量转成 GLB。
 *
 * 用法：
 *   1. Mixamo 下的 .fbx 全丢进 assets/in/
 *   2. node tools/convert-fbx.mjs
 *   3. 结果落在 assets/<原名>.glb
 *
 * --anim-framerate bake60 把动画烘到 60fps，和帧表同频，
 * 免得后面 timeScale 被强行拉成 1.5x / 0.8x。
 */
import { readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inDir = join(root, 'assets', 'in');
const outDir = join(root, 'assets');
const exe = join(root, 'node_modules', 'fbx2gltf', 'bin', 'Windows_NT', 'FBX2glTF.exe');

if (!existsSync(exe)) {
  console.error('找不到 FBX2glTF：', exe);
  console.error('先跑： npm install fbx2gltf');
  process.exit(1);
}

if (!existsSync(inDir)) mkdirSync(inDir, { recursive: true });

const files = readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.fbx'));
if (files.length === 0) {
  console.log(`assets/in 里没有 .fbx。把 Mixamo 下载的文件放进 ${inDir} 再跑。`);
  process.exit(0);
}

let ok = 0;
let fail = 0;

for (const f of files) {
  const src = join(inDir, f);
  const name = f.replace(/\.fbx$/i, '');
  const out = join(outDir, name);
  process.stdout.write(`→ ${f}  `);

  const r = spawnSync(exe, ['-i', src, '-o', out, '-b', '--anim-framerate', 'bake60'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const glb = `${out}.glb`;
  if (existsSync(glb)) {
    const kb = Math.round(statSync(glb).size / 1024);
    console.log(`ok  ${name}.glb  ${kb}KB`);
    ok++;
  } else {
    console.log('FAIL');
    const msg = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    if (msg) console.log('   ', msg);
    fail++;
  }
}

console.log(`\n完成：${ok} 成功，${fail} 失败`);

// 列出每个 glb 的动画名，方便对照 CLIP_MAP
if (ok > 0) {
  console.log('\n--- 动画清单 ---');
  const inspect = spawnSync(process.execPath, [join(root, 'tools', 'inspect-anims.mjs'), outDir], {
    stdio: 'inherit',
  });
}
