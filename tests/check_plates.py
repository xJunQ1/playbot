# -*- coding: utf-8 -*-
"""Look at both actors from their own facing direction, and verify chest plate side."""
import math
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"

PLATE = """() => {
  const { player: p, boss: b } = window.__dbg;
  const V = p.pos.constructor;
  const probe = (a, label) => {
    const chest = a.mesh.spine.children.find(c => c.geometry?.parameters?.width === 0.235);
    const back = a.mesh.spine.children.find(c => c.geometry?.parameters?.width === 0.30);
    const cw = chest.getWorldPosition(new V());
    const bw = back.getWorldPosition(new V());
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const dot = (w) => {
      const dx = w.x - a.pos.x, dz = w.z - a.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      return +((dx * fx + dz * fz) / l).toFixed(3);
    };
    return { label, yawDeg: +(a.yaw * 180 / Math.PI).toFixed(1),
             chestDotForward: dot(cw), backDotForward: dot(bw),
             chestColor: '#' + chest.material.color.getHexString() };
  };
  return [probe(p, 'player'), probe(b, 'boss')];
}"""

LOOK = """(which) => {
  const { camera, player, boss } = window.__dbg;
  const a = which === 'boss' ? boss : player;
  const yaw = a.yaw, d = which === 'boss' ? 9 : 3.6;
  camera.position.set(a.pos.x + Math.sin(yaw) * d, which === 'boss' ? 3.4 : 1.55,
                      a.pos.z + Math.cos(yaw) * d);
  camera.lookAt(a.pos.x, which === 'boss' ? 2.2 : 1.05, a.pos.z);
  return which;
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

    print("=== chest / back plate vs forward axis ===")
    for row in page.evaluate(PLATE):
        print(" ", row)

    page.keyboard.press("F3")
    page.wait_for_timeout(200)

    page.evaluate(LOOK, "player")
    page.wait_for_timeout(250)
    page.screenshot(path="tests/14-player-face.png")

    page.evaluate(LOOK, "boss")
    page.wait_for_timeout(250)
    page.screenshot(path="tests/15-boss-face.png")

    if errs:
        print("errors:", errs)
    browser.close()
