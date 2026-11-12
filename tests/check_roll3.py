# -*- coding: utf-8 -*-
"""Fine-grained state sampling to find what resets the roll."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/Y_Bot.glb&anim=1"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 800, "height": 600})
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(13000)

    # 隔离：Boss 推远，并在页面里装一个 setState 探针
    pg.evaluate("""() => {
      const d = window.__dbg;
      d.boss.pos.set(0, 0, -14);
      d.player.pos.set(0, 0, 12);
      d.boss.setState('idle');

      window.__log = [];
      const p = d.player;
      const orig = p.setState.bind(p);
      p.setState = function (n, m) {
        window.__log.push({ t: performance.now(), from: p.state, to: n, frame: Math.round(p.frame) });
        return orig(n, m);
      };
    }""")

    pg.keyboard.press("Shift")
    pg.wait_for_timeout(1200)

    log = pg.evaluate("() => window.__log")
    print("=== setState calls during roll ===")
    for r in log:
        print(f"  {r['from']:<10} -> {r['to']:<10} at frame {r['frame']}")

    print("\nfinal:", pg.evaluate("() => ({ state: window.__dbg.player.state, frame: Math.round(window.__dbg.player.frame), rollTotal: window.__dbg.CFG.rollTotal })"))
    b.close()
