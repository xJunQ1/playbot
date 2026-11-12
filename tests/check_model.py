# -*- coding: utf-8 -*-
"""Load a real skinned model and check the binder actually plays clips."""
import json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173/"
Q = "?p=assets/hero.glb&ps=1.0&py=3.1416&b=assets/xbot.glb&bs=2.6&by=3.1416"

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

    page.goto(BASE + Q, wait_until="load")
    page.wait_for_timeout(6000)   # 等模型下载 + 绑定

    state = page.evaluate("""() => {
      const { player, boss } = window.__dbg;
      const info = (a) => ({
        binder: !!a.binder,
        clips: a.binder ? [...a.binder.clips.keys()] : [],
        current: a.binder ? a.binder.currentName : null,
        scale: a.mesh.group.scale.x,
      });
      return { player: info(player), boss: info(boss) };
    }""")
    print("=== BINDER STATE ===")
    print(json.dumps(state, ensure_ascii=False, indent=2))

    page.screenshot(path="tests/20-model-idle.png")

    # 走两步再打一拳，确认剪辑切换
    page.keyboard.down("w")
    page.wait_for_timeout(900)
    page.keyboard.up("w")
    page.screenshot(path="tests/21-model-walk.png")
    print("after walk:", page.evaluate("() => window.__dbg.player.binder?.currentName"))

    page.keyboard.press("j")
    page.wait_for_timeout(180)
    page.screenshot(path="tests/22-model-punch.png")
    print("after punch:", page.evaluate("() => window.__dbg.player.binder?.currentName"))

    print("=== console ===")
    for l in logs[:30]:
        print(l)
    if not logs:
        print("(clean)")
    browser.close()
