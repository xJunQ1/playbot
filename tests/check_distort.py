# -*- coding: utf-8 -*-
"""Diagnose skinning distortion: model alone vs model + anim pack."""
from playwright.sync_api import sync_playwright

CASES = [
    ("nopack", "?p=assets/xbot.glb"),
    ("pack",   "?p=assets/xbot.glb&anim=1"),
]

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    for tag, q in CASES:
        pg = b.new_page(viewport={"width": 1000, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        pg.goto("http://localhost:5173/" + q + "&autostart=1", wait_until="load")
        pg.wait_for_timeout(9000 if tag == "pack" else 5000)

        # 冻结 + 正面特写
        pg.keyboard.press("F3")
        pg.wait_for_timeout(250)
        pg.evaluate("""() => {
          const { camera, player } = window.__dbg;
          const p = player.pos, yaw = player.yaw;
          camera.position.set(p.x + Math.sin(yaw) * 3.0, 1.2, p.z + Math.cos(yaw) * 3.0);
          camera.lookAt(p.x, 0.95, p.z);
        }""")
        pg.wait_for_timeout(300)
        pg.screenshot(path=f"tests/40-{tag}-front.png")

        # 侧面
        pg.evaluate("""() => {
          const { camera, player } = window.__dbg;
          const p = player.pos, side = player.yaw + Math.PI / 2;
          camera.position.set(p.x + Math.sin(side) * 3.0, 1.2, p.z + Math.cos(side) * 3.0);
          camera.lookAt(p.x, 0.95, p.z);
        }""")
        pg.wait_for_timeout(250)
        pg.screenshot(path=f"tests/41-{tag}-side.png")

        info = pg.evaluate("""() => {
          const p = window.__dbg.player;
          const b = p.mesh.group;
          const V = p.pos.constructor;
          // 量一下包围盒，和 1.95m 目标身高对比
          let minY = 1e9, maxY = -1e9, spans = [];
          b.traverse((o) => {
            if (!o.isMesh) return;
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
            minY = Math.min(minY, bb.min.y);
            maxY = Math.max(maxY, bb.max.y);
          });
          return { meshHeight: +(maxY - minY).toFixed(2),
                   currentClip: p.binder ? p.binder.currentName : null,
                   hasBinder: !!p.binder };
        }""")
        print(f"[{tag}] {info}")
        if errs:
            print(f"  errors: {errs[:4]}")
        pg.close()
    b.close()
