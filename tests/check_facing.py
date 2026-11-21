# -*- coding: utf-8 -*-
"""Facing check: is the actor's forward axis actually pointing at the target?"""
import math
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?autostart=1"

PROBE = """() => {
  const { player: p, boss: b } = window.__dbg;
  const fwd = (a) => [Math.sin(a.yaw), Math.cos(a.yaw)];
  const ang = (a) => (a.yaw * 180 / Math.PI).toFixed(1);

  const [pfx, pfz] = fwd(p);
  const tx = b.pos.x - p.pos.x, tz = b.pos.z - p.pos.z;
  const tl = Math.hypot(tx, tz) || 1;
  const pDot = (pfx * tx / tl + pfz * tz / tl);

  const [bfx, bfz] = fwd(b);
  const ux = p.pos.x - b.pos.x, uz = p.pos.z - b.pos.z;
  const ul = Math.hypot(ux, uz) || 1;
  const bDot = (bfx * ux / ul + bfz * uz / ul);

  return {
    player: { yaw: ang(p), fwd: [pfx.toFixed(2), pfz.toFixed(2)], dotToBoss: pDot.toFixed(3) },
    boss:   { yaw: ang(b), fwd: [bfx.toFixed(2), bfz.toFixed(2)], dotToPlayer: bDot.toFixed(3) },
    // 鼻尖在角色局部空间的位置，用来判断「脸」朝哪
    playerNose: (() => {
      const n = p.mesh.head.children.find(c => c.geometry?.type === 'BoxGeometry');
      const w = n.getWorldPosition(new p.pos.constructor());
      return { x: +w.x.toFixed(2), z: +w.z.toFixed(2) };
    })(),
    playerHead: { x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2) },
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

    print("=== IDLE (spawn) ===")
    print(page.evaluate(PROBE))

    # 锁定后走一步，看向量是否跟着变
    page.mouse.click(640, 360, button="right")
    page.wait_for_timeout(300)
    page.keyboard.down("a")
    page.wait_for_timeout(1200)
    page.keyboard.up("a")
    page.wait_for_timeout(200)

    print("\n=== AFTER lock-on + strafe ===")
    print(page.evaluate(PROBE))

    # 面朝方向的局部 +Z 在世界里指向哪
    print("\n=== loc axis ===")
    print(page.evaluate("""() => {
      const p = window.__dbg.player;
      const V = p.pos.constructor;
      const f = p.mesh.group.getWorldDirection(new V());   // three 的「前」= -Z
      return { worldDir: [f.x.toFixed(2), f.z.toFixed(2)],
               note: 'getWorldDirection returns -Z axis' };
    }"""))

    if errs:
        print("\n=== pageerror ===")
        print("\n".join(errs))
    browser.close()
