# -*- coding: utf-8 -*-
"""Idle / slash / run close-ups with retargeted Mixamo clips."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/xbot.glb&py=3.1416&anim=1"

CAM = """() => {
  const { camera, player } = window.__dbg;
  const p = player.pos, yaw = player.yaw;
  camera.position.set(p.x + Math.sin(yaw) * 3.0, 1.25, p.z + Math.cos(yaw) * 3.0);
  camera.lookAt(p.x, 0.98, p.z);
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 1000, "height": 800})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)

    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(12000)

    pg.keyboard.press("F3")          # 冻结逻辑
    pg.wait_for_timeout(300)

    # idle
    pg.evaluate("() => window.__dbg.player.setState('idle')")
    pg.wait_for_timeout(400)
    pg.evaluate(CAM)
    pg.wait_for_timeout(300)
    pg.screenshot(path="tests/43-idle-fixed.png")
    print("idle clip:", pg.evaluate("() => window.__dbg.player.binder?.currentName"))

    # 斜砍
    pg.evaluate("() => window.__dbg.player.setState('light1', 'p_light1')")
    pg.wait_for_timeout(420)
    pg.evaluate(CAM)
    pg.wait_for_timeout(250)
    pg.screenshot(path="tests/44-slash-fixed.png")
    print("slash clip:", pg.evaluate("() => window.__dbg.player.binder?.currentName"))

    # 跑动
    pg.evaluate("() => window.__dbg.player.setState('move')")
    pg.wait_for_timeout(400)
    pg.screenshot(path="tests/45-run-fixed.png")
    print("run clip:", pg.evaluate("() => window.__dbg.player.binder?.currentName"))

    if errs:
        print("console:", errs[:6])
    b.close()
