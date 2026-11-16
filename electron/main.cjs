// ═══════════════════════════════════════════════════════════════
//  Electron 壳：把「显卡后端 / 垂直同步」变成应用级开关
//  这些参数必须在 app ready 之前追加到命令行，所以配置存在磁盘上，
//  页面里改完 → 写配置 → 重启应用 → 生效。
// ═══════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(process.env.APPDATA || ROOT, 'souls-demo', 'gpu-config.json');
const SMOKE = process.argv.includes('--smoke');

const DEFAULTS = { angle: 'vulkan', vsync: true, dpr: 1 };
function readConfig() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULTS); }
}
function writeConfig(cfg) {
  try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
  catch (e) { /* 忽略 */ }
}

const cfg = readConfig();

// ── 这些开关必须在 ready 之前设置
if (cfg.angle && cfg.angle !== 'default') {
  app.commandLine.appendSwitch('use-angle', cfg.angle);
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
if (!cfg.vsync) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-gpu-rasterization');

// ── 内置静态服务器（省掉外部 node serve.mjs）
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

let win = null;
async function createWindow() {
  const port = await startServer();
  win = new BrowserWindow({
    width: 1600, height: 900, backgroundColor: '#0b0c0e',
    title: '浮空要塞 · 类魂 demo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, level, msg) => { const s = String(msg); if (level >= 1 || /error|fail|undefined|not a/i.test(s)) console.log('[page' + level + '] ' + s.slice(0, 400)); });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[gone] ' + JSON.stringify(d)));
  await win.loadURL(`http://127.0.0.1:${port}/`);
  return port;
}

ipcMain.handle('shell:getConfig', () => cfg);
ipcMain.handle('shell:relaunch', (_e, next) => {
  const merged = Object.assign({}, cfg, next || {});
  writeConfig(merged);
  // 重新启动，带上新参数
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('shell:gpu', async () => {
  try { return await win.webContents.executeJavaScript('window.__gpu || ""'); } catch { return ''; }
});

app.whenReady().then(async () => {
  await createWindow();
  if (SMOKE) {
    setTimeout(async () => {
      try {
      const probe = await win.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        return {
          renderer: (() => { const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })(),
          fragUniforms: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
          vertUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
          varyings: gl.getParameter(gl.MAX_VARYING_VECTORS),
          texUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
          gpu: window.__gpu || '',
        };
      })()`);
      console.log('PROBE ' + JSON.stringify(probe));
        if (process.env.DSH_OPEN_SETTINGS) {
          await win.webContents.executeJavaScript("document.getElementById('gear').click()");
          await new Promise((r) => setTimeout(r, 800));
        }
        const img = await win.webContents.capturePage();
        const out = path.join(ROOT, 'docs', 'electron-smoke.png');
        fs.writeFileSync(out, img.toPNG());
        console.log('SMOKE_OK ' + out);
      } catch (e) { console.log('SMOKE_FAIL ' + e.message); }
      app.exit(0);
    }, 6000);
  }
});

app.on('window-all-closed', () => app.quit());
