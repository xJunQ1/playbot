// ═══════════════════════════════════════════════════════════════
//  游戏内设置页：画质 / 显示 / 硬件信息
//  所有改动即时生效并写入 localStorage，下次打开自动恢复
// ═══════════════════════════════════════════════════════════════

const KEY = 'souls-demo-settings';
const DEFAULTS = {
  preset: 'high',
  res: 1,
  ao: 'off',      // off | low(8) | mid(16) | high(24)  —— 默认关：GTAO 会在舞台镂空装饰上糊黑斑
  shadow: true,
  decor: true,
  dpr: 2,
  fov: 60,
  sensitivity: 1,
  fps: true,
  showFrameData: false,
  sharp: 0.35,
  ss: 1.5,
  aa: 'smaa',
  fog: 0.42,
  bloom: 0.22,
};

const PRESETS = {
  low:  { res: 0.7, ao: 'off', decor: false },
  mid:  { res: 1.0, ao: 'off', decor: true },
  high: { res: 1.0, ao: 'off', decor: true },   // 预设「高」也不再开 AO（会出黑斑）
};

export function createSettings(ctx) {
  const { renderer, composer, gtao, camera, scene, STAGE, CFG, gpuName, keymap, defaultKeys, onKeymapChange, onPreset, onFrameDataVisibilityChange, sharpen, syncSharpen, bloom, smaa, fxaa } = ctx;

  // 设置表结构版本：v2 = 超采样 1.5x；v3 = FOV 默认 35；v4 = 环境光遮蔽默认关。
  // 老存档（没有 v 字段）里这几个键会丢掉，让新版默认值生效，其它个人项（体积、键位等）保留。
  const SCHEMA = 5;
  const RESET_ON_MIGRATE = ['ss', 'ao', 'aa', 'fov'];

  let state = Object.assign({}, DEFAULTS, (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!raw || typeof raw !== 'object') return {};
      if (Number(raw.v || 1) >= 4) return raw;
      const rest = { ...raw };
      for (const k of RESET_ON_MIGRATE) delete rest[k];
      delete rest.v;
      return rest;
    } catch { return {}; }
  })());
  if (state.v === 4 && state.fov === 35) state.fov = DEFAULTS.fov;
  state.sensitivity = Math.min(3, Math.max(0.2, Number(state.sensitivity) || 1));
  // URL 覆盖（方便 A/B 截图）：?sharp=0.6&ss=1.5&res=1.25
  (function applyUrlOverrides() {
    const q = new URLSearchParams(location.search);
    if (q.has('sharp')) state.sharp = Math.min(1, Math.max(0, parseFloat(q.get('sharp')) || 0));
    if (q.has('ss')) state.ss = Math.min(1.5, Math.max(1, parseFloat(q.get('ss')) || 1));
    if (q.has('res')) state.res = Math.min(1.5, Math.max(0.5, parseFloat(q.get('res')) || 1));
    if (q.has('aa')) state.aa = ['fxaa','smaa','off'].includes(q.get('aa')) ? q.get('aa') : state.aa;
    if (q.has('fog')) state.fog = Math.min(1, Math.max(0, parseFloat(q.get('fog')) || 0));
    if (q.has('bloom')) state.bloom = Math.min(1, Math.max(0, parseFloat(q.get('bloom')) || 0));
  })();
  let pausedBefore = false;

  const $ = (id) => document.getElementById(id);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ ...state, v: SCHEMA })); } catch { /* 隐私模式 */ } };

  // FOV 允许范围 30~80（30 是滑条下限，长焦视角；上限 80 是广角）
  const clampFov = (v) => Math.min(80, Math.max(30, Number.isFinite(+v) ? +v : 45));

  function apply() {
    state.fov = clampFov(state.fov);
    const ss = Math.min(1.5, Math.max(1.0, state.ss || 1));
    renderer.setPixelRatio(Math.min(devicePixelRatio, state.dpr) * state.res * ss);
    if (sharpen) {
      sharpen.material.uniforms.strength.value = state.sharp || 0;
      if (syncSharpen) syncSharpen();
    }

    // 抗锯齿三选一
    if (fxaa) fxaa.enabled = state.aa === 'fxaa';
    if (smaa) smaa.enabled = state.aa === 'smaa';

    // 雾：0 = 通透，1 = 浓雾
    const fog = scene && scene.fog;
    if (fog) {
      const t = Math.min(1, Math.max(0, state.fog ?? 0.42));
      // 舞台直径 ~44m：原来 30~700 的映射等于没有雾，舞台外直接露出近黑背景
      fog.near = 120 - t * 70;    // t=0 → 120m 几乎无雾；t=1 → 50m 浓雾
    }

    // 泛光：0 = 关
    if (bloom) {
      const b = Math.min(1, Math.max(0, state.bloom ?? 0));
      bloom.enabled = b > 0.005;
      bloom.strength = b * 0.8;
    }
    composer.setSize(innerWidth, innerHeight);

    gtao.enabled = state.ao !== 'off';
    gtao.updateGtaoMaterial({ samples: state.ao === 'low' ? 8 : state.ao === 'mid' ? 16 : 24 });
    gtao.setSize(innerWidth, innerHeight);

    if (renderer.shadowMap.enabled !== state.shadow) {
      renderer.shadowMap.enabled = state.shadow;
      scene.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
      });
    }

    STAGE.setDecor(state.decor);

    camera.fov = state.fov;
    camera.updateProjectionMatrix();

    const hud = document.getElementById('hud');
    if (hud) hud.classList.toggle('no-fps', !state.fps);

    onFrameDataVisibilityChange?.(state.showFrameData === true);
    if (onPreset) onPreset(state.preset);
    syncUi();
    save();
  }

  function syncUi() {
    document.querySelectorAll('#setPreset button').forEach((b) => {
      b.classList.toggle('on', b.dataset.q === state.preset);
    });
    const res = $('setRes');
    if (res) { res.value = state.res; const v = $('setResVal'); if (v) v.textContent = state.res.toFixed(2) + 'x'; }
    const ssSel = $('setSS');
    if (ssSel) ssSel.value = String(state.ss);
    const ao = $('setAO'); if (ao) ao.value = state.ao;
    const sh = $('setShadow');
    if (sh) sh.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === state.shadow));
    const de = $('setDecor');
    if (de) de.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === state.decor));
    const dpr = $('setDpr'); if (dpr) dpr.value = String(state.dpr);
    const fov = $('setFov');
    if (fov) { fov.value = state.fov; const v = $('setFovVal'); if (v) v.textContent = state.fov + '°'; }
    $('setSensitivity').value = state.sensitivity;
    $('setSensitivityVal').textContent = state.sensitivity.toFixed(1) + '×';
    const fps = $('setFps');
    if (fps) fps.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === state.fps));
    $('setFrameData')?.querySelectorAll('button').forEach((button) => {
      const selected = (button.dataset.v === '1') === (state.showFrameData === true);
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });

    const sharpValue = state.sharp ?? DEFAULTS.sharp;
    $('setSharp').value = sharpValue;
    $('setSharpVal').textContent = Math.round(sharpValue * 100) + '%';
    const aaSel = $('setAA'); if (aaSel) aaSel.value = state.aa || 'fxaa';
    const fogEl = $('setFog');
    if (fogEl) { fogEl.value = state.fog ?? 0.42; const fv = $('setFogVal'); if (fv) fv.textContent = Math.round((state.fog ?? 0.42) * 100) + '%'; }
    const bloomEl = $('setBloom');
    if (bloomEl) { bloomEl.value = state.bloom ?? 0.22; const bv = $('setBloomVal'); if (bv) bv.textContent = Math.round((state.bloom ?? 0.22) * 100) + '%'; }
    const gpuBox = $('gpuInfo');
    if (gpuBox) {
      const info = (typeof window !== 'undefined' && window.__gpuInfo) || null;
      const g = (info && info.renderer) || gpuName || 'unknown';
      const soft = /swiftshader|llvmpipe|software/i.test(g);
      const nv = /nvidia|geforce|rtx|gtx/i.test(g);
      const amd = /amd|radeon/i.test(g);
      const intel = /intel/i.test(g);
      const backend = /vulkan/i.test(g) ? 'Vulkan' : /d3d11|direct3d/i.test(g) ? 'D3D11' : /opengl|gl\b/i.test(g) ? 'OpenGL' : '未知';
      const fps = (window.__perf && window.__perf.fps) || 0;
      gpuBox.innerHTML =
        '<b>检测到的 GPU</b> ' + ((!info || info.masked) ? '<span class="warn">浏览器隐藏了显卡信息</span>' : g.slice(0, 96)) + '<br>' +
        '<b>状态</b> ' + (soft ? '<span class="warn">软件渲染（硬件加速未启用）</span>' : '硬件加速') +
        ' · <b>后端</b> ' + backend +
        ' · <b>AO 采样</b> ' + (state.ao === 'off' ? '关' : state.ao === 'low' ? 8 : state.ao === 'mid' ? 16 : 24) +
        ' · <b>FPS</b> ' + fps;
      const vs = $('vsyncState');
      if (vs) {
        if (!fps) vs.textContent = '—';
        else if (fps >= 90) vs.textContent = '已解锁（' + fps + ' fps）';
        else if (fps >= 54 && fps <= 66) vs.textContent = '疑似锁定 60 Hz';
        else vs.textContent = fps + ' fps';
      }
      const tips = $('flagInfo');
      if (tips) {
        let rec;
        if (soft) rec = '检测到软件渲染：看 chrome://gpu 是否 Hardware accelerated，关掉节能模式或远程桌面再试。';
        else if (nv || amd) rec = '独显已接管：用 tools\\run-hw-nosync.bat 可解锁垂直同步，实测 190~246 fps。';
        else if (intel) rec = '当前是核显：建议预设「中」或把 AO 调到「低/关」；tools\\run-hw.bat 仍可走 Vulkan。';
        else rec = '预设只切画质档，下面各项随时可以单独覆盖。';
        tips.innerHTML = '<b>建议</b> ' + rec;
      }
    }
  }

  // ── 按键重绑定 ────────────────────────────────────────────
  const KEY_LABELS = {
    fwd: '前进', back: '后退', left: '左移', right: '右移',
    roll: '翻滚', light: '轻击', heavy: '重击', block: '格挡', lock: '锁定目标', ultimate: '释放大招',
  };
  let recording = null;    // 正在录制的动作名

  function keyName(code) {
    if (!code) return '—';
    if (code.startsWith('Mouse')) return ['鼠标左键', '鼠标中键', '鼠标右键'][Number(code.slice(5))] || code;
    return code
      .replace(/^Key/, '')
      .replace(/^Arrow/, '↑↓←→'.slice(0, 0) + 'Arrow ')
      .replace('ShiftLeft', 'L-Shift').replace('ShiftRight', 'R-Shift')
      .replace('ControlLeft', 'L-Ctrl').replace('ControlRight', 'R-Ctrl')
      .replace('AltLeft', 'L-Alt').replace('AltRight', 'R-Alt')
      .replace('Space', 'Space').replace('Escape', 'Esc');
  }

  function renderKeys() {
    for (const key of document.querySelectorAll('#help [data-binding], #hud [data-binding]')) {
      const actions = key.dataset.binding.split(' ');
      const labels = actions.map(action => (keymap[action] ?? []).map(code =>
        keyName(code).replace('鼠标', '').replace(/^[LR]-Shift$/, 'Shift')
      ).join(' / '));
      key.textContent = labels.filter(Boolean).join(' ') || '未绑定';
    }
    const box = document.getElementById('keyList');
    if (!box || !keymap) return;
    box.innerHTML = '';
    for (const [action, label] of Object.entries(KEY_LABELS)) {
      const codes = keymap[action] || [];
      const row = document.createElement('div');
      row.className = 'krow';
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.textContent = recording === action ? '按键…' : (codes.map(keyName).join(' / ') || '未绑定');
      if (recording === action) btn.classList.add('rec');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        recording = recording === action ? null : action;
        window.__recordingKey = !!recording;
        renderKeys();
      });
      row.appendChild(name);
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function bindRecording() {
    function record(e) {
      if (!recording) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const code = e.type === 'keydown' ? e.code : 'Mouse' + e.button;
      if (code === 'Escape') { recording = null; window.__recordingKey = false; renderKeys(); return; }
      const action = recording;
      // 同一个键先从其它动作里摘掉
      for (const [a, codes] of Object.entries(keymap)) {
        if (a !== action && codes.includes(code)) keymap[a] = codes.filter((c) => c !== code);
      }
      keymap[action] = [code];
      recording = null;
      window.__recordingKey = false;
      if (onKeymapChange) onKeymapChange();
      renderKeys();
    }
    for (const event of ['keydown', 'click', 'auxclick']) addEventListener(event, record, true);
    $('settings').addEventListener('contextmenu', e => { if (recording) e.preventDefault(); });
  }
  // ── 复制启动命令（硬件选择 / 解锁垂直同步都由浏览器进程决定，页面内改不了）──
  function copyText(text, label) {
    const done = () => {
      const el = document.getElementById('flagInfo');
      if (el) el.innerHTML = '<b>' + label + '</b> 已复制到剪贴板，关掉浏览器后用命令行启动才会生效。';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  }

  function bindCopyButtons() {
    const gpuBtn = $('copyGpuCmd');
    if (gpuBtn) gpuBtn.addEventListener('click', () => {
      const sw = /nvidia|geforce|rtx|gtx|amd|radeon/i.test(gpuName || '') ? '--use-angle=vulkan' : '--use-angle=d3d11';
      copyText('start "" msedge.exe ' + sw + ' --enable-zero-copy --enable-gpu-rasterization --ignore-gpu-blocklist "http://127.0.0.1:5173/"', '独显启动命令');
    });
    const vsBtn = $('copyVsyncCmd');
    if (vsBtn) vsBtn.addEventListener('click', () => {
      copyText('start "" msedge.exe --use-angle=vulkan --disable-gpu-vsync --disable-frame-rate-limit "http://127.0.0.1:5173/"', '解锁垂直同步命令');
    });
  }
  // ── 原生壳（Electron）：显卡后端 / 垂直同步只能进程级切换，改完重启 ──
  const native = typeof window !== 'undefined' ? window.nativeShell : null;

  async function setupNative() {
    if (!native || !native.isElectron) return;
    const sec = document.getElementById('nativeSection');
    if (sec) sec.style.display = '';
    const angleEl = document.getElementById('nativeAngle');
    const vsEl = document.getElementById('nativeVsync');
    const infoEl = document.getElementById('nativeInfo');
    let cfg = { angle: 'vulkan', vsync: true };
    try { cfg = await native.getConfig(); } catch (e) { /* 忽略 */ }

    if (angleEl) {
      angleEl.value = cfg.angle || 'vulkan';
      angleEl.addEventListener('change', () => { if (infoEl) infoEl.textContent = '已修改，点「应用并重启」生效'; });
    }
    let vsync = cfg.vsync !== false;
    const paintVsync = () => {
      if (!vsEl) return;
      vsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === vsync));
    };
    if (vsEl) vsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      vsync = b.dataset.v === '1';
      paintVsync();
      if (infoEl) infoEl.textContent = '已修改，点「应用并重启」生效';
    }));
    paintVsync();

    let gpu = '';
    try { gpu = await native.getGpu(); } catch (e) { /* 忽略 */ }
    if (infoEl) {
      infoEl.innerHTML = '<b>当前</b> 后端 ' + (cfg.angle || 'vulkan') + ' · 垂直同步 ' + (vsync ? '开' : '关') +
        (gpu ? '<br><b>GPU</b> ' + String(gpu).slice(0, 92) : '');
    }

    const applyBtn = document.getElementById('nativeApply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      const next = { angle: (angleEl && angleEl.value) || 'vulkan', vsync };
      if (infoEl) infoEl.textContent = '正在重启…';
      native.relaunch(next);
    });
  }
  setupNative();
  let liveTimer = null;
  let previousFocus = null;
  function setOpen(open) {
    const el = $('settings');
    if (!el || el.classList.contains('open') === open) return;
    el.classList.toggle('open', open);
    if (open) {
      previousFocus = document.activeElement;
      ctx.onOpen();
      if (document.pointerLockElement) document.exitPointerLock();
      pausedBefore = CFG.paused;
      CFG.paused = true;
      apply();
      el.querySelector('[role=tab][aria-selected=true]')?.focus({ preventScroll: true });
      // 面板打开期间每秒刷新 GPU / FPS / 刷新模式读数
      if (!liveTimer) liveTimer = setInterval(syncUi, 1000);
    } else {
      recording = null;
      window.__recordingKey = false;
      renderKeys();
      CFG.paused = pausedBefore;
      const returnFocus = previousFocus === document.body ? $('gear') : previousFocus;
      returnFocus?.focus({ preventScroll: true });
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    }
  }

  function bindTabs(el) {
    const nav = el.querySelector('.settings-nav');
    const tabs = [...nav.querySelectorAll('[role=tab]')];
    const narrow = matchMedia('(max-width: 590px)');
    const syncOrientation = () => nav.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
    narrow.addEventListener('change', syncOrientation);
    syncOrientation();
    function select(tab) {
      for (const button of tabs) {
        const selected = button === tab;
        button.tabIndex = selected ? 0 : -1;
        button.setAttribute('aria-selected', String(selected));
        $(button.getAttribute('aria-controls')).hidden = !selected;
      }
      el.querySelector('.settings-content').scrollTop = 0;
      tab.focus();
    }
    for (const tab of tabs) tab.addEventListener('click', () => select(tab));
    nav.addEventListener('keydown', event => {
      if (recording) return;
      const active = tabs.indexOf(document.activeElement);
      if (active < 0) return;
      const direction = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
      if (!direction && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const index = direction ? (active + direction + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : tabs.length - 1;
      select(tabs[index]);
    });
    el.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || recording) return;
      const items = [...el.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), select, input, [role=tabpanel]')]
        .filter(element => element.getClientRects().length > 0);
      const end = event.shiftKey ? items[0] : items.at(-1);
      if (event.target !== end) return;
      event.preventDefault();
      (event.shiftKey ? items.at(-1) : items[0]).focus();
    });
  }

  function bind() {
    const el = $('settings');
    if (!el) return false;
    bindTabs(el);
    const gear = $('gear');
    if (gear) gear.addEventListener('click', () => setOpen(!el.classList.contains('open')));
    const close = $('setClose');
    if (close) close.addEventListener('click', () => setOpen(false));
    $('setDismiss')?.addEventListener('click', () => setOpen(false));
    const reset = $('setReset');
    if (reset) reset.addEventListener('click', () => {
      state = Object.assign({}, DEFAULTS);
      if (keymap && defaultKeys) {
        for (const k of Object.keys(keymap)) delete keymap[k];
        Object.assign(keymap, JSON.parse(JSON.stringify(defaultKeys)));
        if (onKeymapChange) onKeymapChange();
        renderKeys();
      }
      apply();
    });

    document.querySelectorAll('#setPreset button').forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.q];
      if (!p) return;
      state.preset = b.dataset.q;
      Object.assign(state, p);
      apply();
    }));

    const res = $('setRes');
    if (res) res.addEventListener('input', (e) => { state.res = parseFloat(e.target.value); state.preset = 'custom'; apply(); });
    const ssSel2 = $('setSS');
    if (ssSel2) ssSel2.addEventListener('change', (e) => {
      state.ss = Math.min(1.5, Math.max(1, parseFloat(e.target.value) || 1));
      state.preset = 'custom';
      apply();
    });
    const ao = $('setAO');
    if (ao) ao.addEventListener('change', (e) => { state.ao = e.target.value; apply(); });
    document.querySelectorAll('#setShadow button').forEach((b) => b.addEventListener('click', () => { state.shadow = b.dataset.v === '1'; apply(); }));
    document.querySelectorAll('#setDecor button').forEach((b) => b.addEventListener('click', () => { state.decor = b.dataset.v === '1'; apply(); }));
    document.querySelectorAll('#setFps button').forEach((b) => b.addEventListener('click', () => { state.fps = b.dataset.v === '1'; apply(); }));
    const frameData = $('setFrameData');
    if (frameData && onFrameDataVisibilityChange) {
      frameData.hidden = false;
      frameData.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', () => {
          state.showFrameData = button.dataset.v === '1';
          onFrameDataVisibilityChange(state.showFrameData);
          syncUi();
          save();
        });
      });
    }
    const aaSel = $('setAA');
    if (aaSel) aaSel.addEventListener('change', (e) => { state.aa = e.target.value; apply(); });
    $('setSharp').addEventListener('input', e => {
      state.sharp = Number(e.target.value);
      if (sharpen) {
        sharpen.material.uniforms.strength.value = state.sharp;
        syncSharpen?.();
      }
      syncUi();
      save();
    });
    const fogIn = $('setFog');
    if (fogIn) fogIn.addEventListener('input', (e) => { state.fog = parseFloat(e.target.value); apply(); });
    const bloomIn = $('setBloom');
    if (bloomIn) bloomIn.addEventListener('input', (e) => { state.bloom = parseFloat(e.target.value); apply(); });
    const dpr = $('setDpr');
    if (dpr) dpr.addEventListener('change', (e) => { state.dpr = parseFloat(e.target.value); apply(); });
    const fov = $('setFov');
    if (fov) fov.addEventListener('input', (e) => {
      camera.fov = state.fov = clampFov(e.target.value);
      camera.updateProjectionMatrix();
      syncUi();
      save();
    });
    $('setSensitivity').addEventListener('input', e => {
      state.sensitivity = Number(e.target.value);
      syncUi();
      save();
    });

    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(!el.classList.contains('open'));
    });

    renderKeys();
    bindRecording();
    bindCopyButtons();
    apply();
    return true;
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return false;
    state.preset = name;
    Object.assign(state, p);
    apply();
    return true;
  }

  return { state: () => state, apply, open: setOpen, bind, applyPreset };
}
