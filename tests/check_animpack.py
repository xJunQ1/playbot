# -*- coding: utf-8 -*-
"""Verify the Mixamo animation pack binds and plays on a Mixamo-skeleton character."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/xbot.glb&b=assets/xbot.glb&anim=1"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(12000)

    info = pg.evaluate("""() => {
      const p = window.__dbg.player;
      return {
        hasBinder: !!p.binder,
        clipCount: p.binder ? p.binder.clips.size : 0,
        names: p.binder ? [...p.binder.clips.keys()] : [],
        current: p.binder ? p.binder.currentName : null,
      };
    }""")
    print("=== ANIM PACK ===")
    print("binder:", info["hasBinder"], " clips:", info["clipCount"], " current:", info["current"])
    for n in info["names"]:
        print("   -", n)

    pg.screenshot(path="tests/30-animpack.png")

    pg.keyboard.press("F3")
    pg.wait_for_timeout(300)
    for st, mid in [("light1", "p_light1"), ("heavy", "p_heavy"), ("roll", None)]:
        pg.evaluate("""(a) => { const p = window.__dbg.player;
            p.setState(a.st, a.mid); }""", {"st": st, "mid": mid})
        pg.wait_for_timeout(260)
        cur = pg.evaluate("() => window.__dbg.player.binder?.currentName")
        print(f"  state={st:<8} -> {cur}")
    pg.screenshot(path="tests/31-animpack-slash.png")

    print("--- console ---")
    for l in logs[:15]:
        print(l)
    b.close()
