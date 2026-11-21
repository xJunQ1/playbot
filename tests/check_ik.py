# -*- coding: utf-8 -*-
"""Foot-IK verification.

判据：移动过程中，处于「支撑期」(swinging=false) 的脚，世界坐标应该几乎不动。
  有 IK  → 支撑脚位移 ~0
  无 IK  → 支撑脚跟着身体漂移 ~0.2m/采样
"""
import json
import math
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?autostart=1"

SAMPLE = """() => {
  const p = window.__dbg.player;
  return {
    body: { x: p.pos.x, z: p.pos.z },
    feet: p.footIK.feet.map(f => ({
      x: f.current.x, z: f.current.z, y: f.current.y,
      swinging: f.swinging,
      legRot: f.side > 0 ? window.__dbg.player.mesh.legR.rotation.x
                         : window.__dbg.player.mesh.legL.rotation.x,
      shinRot: f.side > 0 ? window.__dbg.player.mesh.shinR.rotation.x
                          : window.__dbg.player.mesh.shinL.rotation.x,
    })),
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

    page.goto(URL, wait_until="load")
    page.wait_for_timeout(3000)

    # 先站定 1 秒，让脚归位
    page.wait_for_timeout(900)

    page.keyboard.down("w")
    page.wait_for_timeout(150)
    samples = []
    for _ in range(45):
        samples.append(page.evaluate(SAMPLE))
        page.wait_for_timeout(45)
    page.keyboard.up("w")
    page.wait_for_timeout(400)

    # 分析：支撑期脚的位移
    drift_stance = []
    drift_body = []
    swings = 0
    for a, b in zip(samples, samples[1:]):
        body_d = math.dist((a["body"]["x"], a["body"]["z"]), (b["body"]["x"], b["body"]["z"]))
        drift_body.append(body_d)
        # 只在「确实在移动」的采样段统计：停止时收脚不算滑步
        if body_d < 0.02:
            continue
        for fa, fb in zip(a["feet"], b["feet"]):
            if fa["swinging"] or fb["swinging"]:
                swings += 1
                continue
            drift_stance.append(math.dist((fa["x"], fa["z"]), (fb["x"], fb["z"])))

    def stat(name, xs):
        if not xs:
            print(f"  {name}: no samples")
            return
        xs_sorted = sorted(xs)
        n = len(xs_sorted)
        print(f"  {name}: n={n}  mean={sum(xs)/n*1000:.1f}mm  "
              f"p50={xs_sorted[n//2]*1000:.1f}mm  max={xs_sorted[-1]*1000:.1f}mm")

    print("=== FOOT IK ===")
    stat("body step per sample ", drift_body)
    stat("stance-foot drift     ", drift_stance)
    print(f"  swing samples: {swings}")

    # 腿角度是否真的在变（IK 在驱动）
    legrots = [s["feet"][0]["legRot"] for s in samples]
    print(f"  legR rotation.x range: {min(legrots):.3f} .. {max(legrots):.3f}")

    # 最终静止：两只脚应回到身体两侧
    page.keyboard.down("s")
    page.wait_for_timeout(200)
    page.keyboard.up("s")
    page.wait_for_timeout(1200)
    final = page.evaluate(SAMPLE)
    for i, f in enumerate(final["feet"]):
        d = math.dist((f["x"], f["z"]), (final["body"]["x"], final["body"]["z"]))
        print(f"  foot{i} distance from body after rest: {d:.3f}m  (expect ~0.16)")

    page.screenshot(path="tests/11-footik.png")
    print("=== console ===")
    for l in logs[:20]:
        print(l)
    if not logs:
        print("(clean)")
    browser.close()
