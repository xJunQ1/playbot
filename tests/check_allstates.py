# -*- coding: utf-8 -*-
"""Capture every state close-up so distortion is visible per action."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/Y_Bot.glb&anim=1"

# 相机放在 forward 方向 = 角色正前方，能直接看出朝向对不对
CAM_FRONT = """() => {
  const { camera, player } = window.__dbg;
  const p = player.pos, yaw = player.yaw;
  camera.position.set(p.x + Math.sin(yaw) * 3.2, 1.25, p.z + Math.cos(yaw) * 3.2);
  camera.lookAt(p.x, 0.98, p.z);
}"""
CAM_SIDE = """() => {
  const { camera, player } = window.__dbg;
  const p = player.pos, s = player.yaw + Math.PI / 2;
  camera.position.set(p.x + Math.sin(s) * 3.2, 1.15, p.z + Math.cos(s) * 3.2);
  camera.lookAt(p.x, 0.95, p.z);
}"""

STATES = [
    ("idle", "idle", None, 400, CAM_FRONT),
    ("run", "move", None, 400, CAM_SIDE),
    ("light1", "light1", "p_light1", 300, CAM_SIDE),
    ("light1-mid", "light1", "p_light1", 700, CAM_SIDE),
    ("heavy", "heavy", "p_heavy", 700, CAM_SIDE),
    ("roll", "roll", None, 250, CAM_SIDE),
    ("block", "block", None, 250, CAM_FRONT),
    ("dead", "dead", None, 1200, CAM_SIDE),
]

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 900, "height": 760})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(12000)

    pg.keyboard.press("F3")     # 冻结，避免 AI 干扰
    pg.wait_for_timeout(300)

    for i, (tag, st, mid, wait, cam) in enumerate(STATES):
        pg.evaluate("""(a) => { const p = window.__dbg.player; p.setState(a.st, a.mid); }""",
                    {"st": st, "mid": mid})
        pg.wait_for_timeout(wait)
        pg.evaluate(cam)
        pg.wait_for_timeout(260)
        pg.screenshot(path=f"tests/5{i}-state-{tag}.png")
        clip = pg.evaluate("() => window.__dbg.player.binder?.currentName")
        print(f"  {tag:<12} -> {clip}")

    if errs:
        print("errors:", errs[:5])
    b.close()
