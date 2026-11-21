# -*- coding: utf-8 -*-
"""Drive the binder through every state and confirm the clip actually switches."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173/"
Q = "?autostart=1&p=assets/hero.glb&py=3.1416&b=assets/xbot.glb&by=3.1416"

STATES = ["idle", "move", "roll", "block", "light1", "heavy", "hitstun", "dead"]

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
    page.wait_for_timeout(6000)

    # 冻结逻辑，避免 AI 干扰
    page.keyboard.press("F3")
    page.wait_for_timeout(250)

    print("=== CLIP SWITCHING ===")
    ok = 0
    for st in STATES:
        page.evaluate("""(st) => {
          const p = window.__dbg.player;
          p.setState(st, st === 'heavy' ? 'p_heavy' : (st === 'light1' ? 'p_light1' : null));
        }""", st)
        page.wait_for_timeout(220)
        cur = page.evaluate("() => window.__dbg.player.binder?.currentName")
        mark = "ok " if cur else "MISS"
        if cur:
            ok += 1
        print(f"  {mark} state={st:<9} -> clip={cur}")

    print(f"\n  {ok}/{len(STATES)} states resolved to a clip")

    # 身高校准结果
    print("\n=== FIT ===")
    print(page.evaluate("""() => {
      const V = window.__dbg.player.pos.constructor;
      const box = (o) => { const b = new (o.geometry ? Object : Object)(); return null; };
      const p = window.__dbg.player, b = window.__dbg.boss;
      const h = (a) => {
        const bb = a.binder ? a.binder.root : null;
        return bb ? +bb.scale.y.toFixed(3) : null;
      };
      return { playerModelScaleY: h(p), bossModelScaleY: h(b) };
    }"""))

    page.screenshot(path="tests/23-model-states.png")
    print("\n=== console ===")
    for l in logs[:20]:
        print(l)
    if not logs:
        print("(clean)")
    browser.close()
