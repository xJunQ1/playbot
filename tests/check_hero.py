# -*- coding: utf-8 -*-
"""Close-up of the skinned model, no boss, camera parked in front."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173/"
Q = "?p=assets/hero.glb&py=3.1416"

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE + Q, wait_until="load")
    page.wait_for_timeout(5000)

    page.keyboard.press("F3")          # 冻结
    page.wait_for_timeout(250)

    page.evaluate("""() => {
      const { camera, player } = window.__dbg;
      const p = player.pos, yaw = player.yaw;
      camera.position.set(p.x + Math.sin(yaw) * 3.2, 1.35, p.z + Math.cos(yaw) * 3.2);
      camera.lookAt(p.x, 1.0, p.z);
    }""")
    page.wait_for_timeout(300)
    page.screenshot(path="tests/24-hero-idle.png")

    # 切到攻击剪辑看一眼
    page.evaluate("() => window.__dbg.player.setState('light1', 'p_light1')")
    page.wait_for_timeout(260)
    page.screenshot(path="tests/25-hero-punch.png")
    print("clip:", page.evaluate("() => window.__dbg.player.binder?.currentName"))

    page.evaluate("() => window.__dbg.player.setState('move')")
    page.wait_for_timeout(300)
    page.screenshot(path="tests/26-hero-run.png")
    print("clip:", page.evaluate("() => window.__dbg.player.binder?.currentName"))

    if errs:
        print("errors:", errs)
    browser.close()
