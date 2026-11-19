import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT ?? 5173);
const TUNING_FILE = join(ROOT, 'data', 'tuning.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.hdr': 'image/vnd.radiance',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    // ── 调参持久化接口 ──────────────────────────────
    // GET  /api/tuning  → 返回 data/tuning.json（不存在则 {}）
    // POST /api/tuning  → 覆盖写入 data/tuning.json
    if (pathname === '/api/tuning') {
      if (req.method === 'GET') {
        const body = await readFile(TUNING_FILE, 'utf8').catch(() => '{}');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        try { JSON.parse(text); } catch { res.writeHead(400).end('bad json'); return; }
        await mkdir(join(ROOT, 'data'), { recursive: true });
        await writeFile(TUNING_FILE, text, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(405).end('method not allowed');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('404 ' + pathname); return; }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
}).listen(PORT, () => {
  console.log(`\n  souls-graybox  →  http://localhost:${PORT}\n  Ctrl+C 停止\n`);
});
