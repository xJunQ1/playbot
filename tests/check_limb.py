# -*- coding: utf-8 -*-
"""Limb-direction check: from the side, is the knee / elbow bending forward?"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"

SIDE_CAM = """(which) => {
  const { camera, player, boss } = window.__dbg;
  const a = which === 'boss' ? boss : player;
  const side = a.yaw + Math.PI / 2;
  const d = which === 'boss' ? 8 : 3.4;
  camera.position.set(a.pos.x + Math.sin(side) * d, which === 'boss' ? 2.4 : 1.1,
                      a.pos.z + Math.cos(side) * d);
  camera.lookAt(a.pos.x, which === 'boss' ? 1.8 : 0.95, a.pos.z);
}"""

JOINTS = """() => {
  const { player: p } = window.__dbg;
  const V = p.pos.constructor;
  const w = (o) => { const v = o.getWorldPosition(new V()); return { z: +v.z.toFixed(3), y: +v.y.toFixed(3) }; };
  // 右腿：髋 = hips, 膝 = legR 末端（shinR 的 origin）, 踝 = foot
  const legR = p.mesh.legR, shinR = p.mesh.shinR;
  return {
    hipsY: +p.mesh.hips.getWorldPosition(new V()).y.toFixed(3),
    knee: w(shinR),
    ankle: (() => { const f = p.footIK.feet[0].current;
                    return { z: +f.z.toFixed(3), y: +f.y.toFixed(3) }; })(),
    legRot: +legR.rotation.x.toFixed(3),
    shinRot: +shinR.rotation.x.toFixed(3),
    armXRot: +p.mesh.armR.rotation.x.toFixed(3),
    bodyZ: +p.pos.z.toFixed(3),
  };
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

    # 走两步，让摆动腿抬起来，然后冻结
    page.keyboard.down("w")
    page.wait_for_timeout(700)
    page.keyboard.press("F3")
    page.keyboard.up("w")
    page.wait_for_timeout(200)

    print("=== WALK FRAME (frozen) ===")
    j = page.evaluate(JOINTS)
    print(" ", j)
    print(f"  knee.z {j['knee']['z']:.2f} vs ankle.z {j['ankle']['z']:.2f} "
          f"-> knee {'AHEAD of' if j['knee']['z'] > j['ankle']['z'] else 'BEHIND'} ankle")
    print(f"  legRot {j['legRot']:+.3f}  (negative = thigh forward)")

    page.evaluate(SIDE_CAM, "player")
    page.wait_for_timeout(250)
    page.screenshot(path="tests/16-walk-side.png")

    # 攻击：在判定帧冻结，看手臂朝哪
    page.evaluate("() => window.__dbg.CFG.paused = false")
    page.keyboard.press("F3")
    page.wait_for_timeout(150)
    page.keyboard.press("k")
    for _ in range(40):
        page.wait_for_timeout(30)
        if "heavy" in page.inner_text("#hud"):
            break
    page.keyboard.press("F3")
    page.wait_for_timeout(200)
    page.evaluate(SIDE_CAM, "player")
    page.wait_for_timeout(250)
    page.screenshot(path="tests/17-heavy-side.png")
    print("\n=== HEAVY (frozen) ===", page.evaluate(JOINTS))

    if errs:
        print("errors:", errs)
    browser.close()
