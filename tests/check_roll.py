# -*- coding: utf-8 -*-
"""Capture the roll at several frames to confirm it actually tumbles."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/Y_Bot.glb&anim=1"
CAM = """() => {
  const { camera, player } = window.__dbg;
  const p = player.pos, s = player.yaw + Math.PI / 2;
  camera.position.set(p.x + Math.sin(s) * 3.4, 1.0, p.z + Math.cos(s) * 3.4);
  camera.lookAt(p.x, 0.8, p.z);
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 900, "height": 700})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(13000)

    pg.keyboard.press("F3")
    pg.wait_for_timeout(300)

    for f in [0, 10, 20, 30, 40, 50]:
        pg.evaluate("""(f) => {
          const p = window.__dbg.player;
          p.setState('roll');
          p.frame = f;
        }""", f)
        pg.wait_for_timeout(260)
        pg.evaluate(CAM)
        pg.wait_for_timeout(180)
        pg.screenshot(path=f"tests/70-roll-f{f:02d}.png")
        head = pg.evaluate("""() => {
          const p = window.__dbg.player;
          const V = p.pos.constructor;
          const h = p.mesh.group.getObjectByName('mixamorigHead');
          if (!h) return null;
          return +h.getWorldPosition(new V()).y.toFixed(2);
        }""")
        print(f"  frame {f:>2}  headY={head}")

    if errs:
        print("errors:", errs[:4])
    b.close()
