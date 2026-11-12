# -*- coding: utf-8 -*-
"""Freeze the roll at specific clip times and capture."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/Y_Bot.glb&anim=1"
CAM = """() => {
  const { camera, player } = window.__dbg;
  const p = player.pos, s = player.yaw + Math.PI / 2;
  camera.position.set(p.x + Math.sin(s) * 3.6, 1.1, p.z + Math.cos(s) * 3.6);
  camera.lookAt(p.x, 0.75, p.z);
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 900, "height": 700})
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(13000)

    pg.evaluate("""() => {
      const d = window.__dbg;
      d.boss.pos.set(0, 0, -14);
      d.player.pos.set(0, 0, 12);
      d.boss.setState('idle');
    }""")
    # 冻结逻辑，这样 state 不会被 tick 切回 idle
    pg.evaluate("() => { window.__dbg.CFG.paused = true; }")
    pg.wait_for_timeout(120)
    pg.evaluate("() => { const p = window.__dbg.player; p.setState('roll'); p.binder.update(p, 0.016); }")
    pg.wait_for_timeout(200)

    # 冻结在当前翻滚，然后手动定位 playhead
    for t in [0.10, 0.25, 0.40, 0.55, 0.70]:
        info = pg.evaluate("""(t) => {
          const p = window.__dbg.player;
          const b = p.binder;
          if (!b || !b.current) return null;
          b.current.time = t;
          b.mixer.update(0);
          const V = p.pos.constructor;
          const h = p.mesh.group.getObjectByName('mixamorigHead');
          return { t: +b.current.time.toFixed(2), clip: b.currentName,
                   headY: h ? +h.getWorldPosition(new V()).y.toFixed(2) : null };
        }""", t)
        pg.wait_for_timeout(220)
        pg.evaluate(CAM)
        pg.wait_for_timeout(180)
        pg.screenshot(path=f"tests/73-roll-t{str(t).replace('.','')}.png")
        print(f"  t={t}  headY={info['headY'] if info else '-'}  clip={info['clip'] if info else '-'}")

    b.close()
