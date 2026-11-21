# -*- coding: utf-8 -*-
"""Capture the roll by continuous screenshots during natural playback."""
from playwright.sync_api import sync_playwright

Q = "?autostart=1&p=assets/Y_Bot.glb&anim=1"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 760, "height": 620})
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(13000)

    pg.evaluate("""() => {
      const d = window.__dbg;
      d.boss.pos.set(0, 0, -14);
      d.player.pos.set(0, 0, 12);
      d.boss.setState('idle');
      const { camera, player } = d;
      const p = player.pos, s = player.yaw + Math.PI / 2;
      camera.position.set(p.x + Math.sin(s) * 4.0, 1.2, p.z + Math.cos(s) * 4.0);
      camera.lookAt(p.x, 0.85, p.z);
    }""")
    pg.wait_for_timeout(400)

    pg.keyboard.press("Shift")

    shots = []
    for i in range(8):
        path = f"tests/74-roll-seq-{i}.png"
        pg.screenshot(path=path)
        st = pg.evaluate("() => { const p = window.__dbg.player; const V = p.pos.constructor; const h = p.mesh.group.getObjectByName('mixamorigHead'); return { s: p.state, f: Math.round(p.frame), y: h ? +h.getWorldPosition(new V()).y.toFixed(2) : null }; }")
        shots.append((i, st["s"], st["f"], st["y"]))
        print(f"  shot {i}: state={st['s']:<6} frame={st['f']:>2} headY={st['y']}")

    heads = [s[3] for s in shots if s[3] is not None]
    print(f"\nheadY range over shots: {min(heads)} .. {max(heads)}")
    print("翻滚可见" if min(heads) < 1.0 else "没抓到翻滚中段（截图太慢）")
    b.close()
