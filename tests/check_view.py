# -*- coding: utf-8 -*-
"""Front/back view: prove which way the actor is actually facing."""
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?autostart=1"

ORBIT = """(angleDeg) => {
  const { camera, player } = window.__dbg;
  const p = player.pos, yaw = player.yaw;
  const a = yaw + angleDeg * Math.PI / 180;
  camera.position.set(p.x + Math.sin(a) * 3.6, 1.55, p.z + Math.cos(a) * 3.6);
  camera.lookAt(p.x, 1.05, p.z);
  return { yawDeg: +(yaw * 180 / Math.PI).toFixed(1), camAngle: angleDeg };
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="load")
    page.wait_for_timeout(2500)

    # 冻结逻辑帧，这样相机不会每帧被 updateCamera 拉回去
    page.keyboard.press("F3")
    page.wait_for_timeout(200)

    # 玩家朝 -Z（面向 Boss）。角度 0 = 站在玩家身后，180 = 站在玩家正前方
    for deg, name in [(0, "behind"), (180, "front"), (90, "right-side")]:
        info = page.evaluate(ORBIT, deg)
        page.wait_for_timeout(250)
        page.screenshot(path=f"tests/13-view-{name}.png")
        print(f"  {name}: yaw={info['yawDeg']} cam={deg}")

    if errs:
        print("errors:", errs)
    browser.close()
