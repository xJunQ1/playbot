# -*- coding: utf-8 -*-
"""Final acceptance: Y_Bot + same-source Mixamo pack."""
import json
from playwright.sync_api import sync_playwright

Q = "?autostart=1&p=assets/Y_Bot.glb&b=assets/Y_Bot.glb&anim=1&bh=4.0"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    pg.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))
    pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)

    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(14000)

    info = pg.evaluate("""() => {
      const { player, boss, CFG, MOVES } = window.__dbg;
      const V = player.pos.constructor;
      const g = (n) => { const o = player.mesh.group.getObjectByName(n); if (!o) return null;
                         const w = o.getWorldPosition(new V()); return w.x; };
      const L = g('mixamorigLeftArm'), R = g('mixamorigRightArm');
      const fwd = { x: Math.sin(player.yaw), z: Math.cos(player.yaw) };
      const facingZ = (L !== null && R !== null) ? (L - R) > 0 ? '+Z' : '-Z' : '?';
      const want = fwd.z < -0.5 ? '-Z' : (fwd.z > 0.5 ? '+Z' : '?');

      const clips = player.binder ? [...player.binder.clips.keys()] : [];
      // 每招的 timeScale
      const scales = {};
      for (const [st, mid] of Object.entries({ light1:'p_light1', light2:'p_light2', heavy:'p_heavy' })) {
        player.setState(st, mid);
        player.binder.update(player, 0.016);
        const a = player.binder.current;
        const clip = a ? a.getClip() : null;
        const mv = MOVES[mid];
        scales[mid] = {
          clip: player.binder.currentName,
          clipFrames: clip ? Math.round(clip.duration * 60) : null,
          table: mv.startup + mv.active + mv.recovery,
          timeScale: a ? +a.getEffectiveTimeScale().toFixed(2) : null,
        };
      }
      const box = new V();
      const bb = new (player.mesh.group.constructor === Object ? Object : Object)();
      return {
        hasBinder: !!player.binder, clipCount: clips.length,
        facing: facingZ, want, facingOk: facingZ === want,
        playerH: +(player.mesh.group.scale.x).toFixed(2),
        scales,
      };
    }""")

    print("=== FINAL ===")
    print("binder:", info["hasBinder"], " clips:", info["clipCount"])
    print("facing:", info["facing"], "want:", info["want"], "->", "OK" if info["facingOk"] else "MISMATCH")
    print("\nclip vs frame table:")
    for k, v in info["scales"].items():
        print(f"  {k:<8} {str(v['clip']):<30} clip={v['clipFrames']:>4}f  table={v['table']:>3}f  scale={v['timeScale']}")

    pg.keyboard.press("F3")
    pg.wait_for_timeout(300)
    pg.evaluate("""() => {
      const { camera, player } = window.__dbg;
      camera.position.set(player.pos.x, 2.2, player.pos.z + 5.5);
      camera.lookAt(player.pos.x, 1.0, player.pos.z);
    }""")
    pg.wait_for_timeout(300)
    pg.screenshot(path="tests/60-final.png")

    if errs:
        print("\nconsole:", errs[:6])
    else:
        print("\nconsole: clean")
    b.close()
