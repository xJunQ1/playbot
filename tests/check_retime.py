# -*- coding: utf-8 -*-
"""Check clip duration vs frame-table length, and confirm timeScale is sane."""
from playwright.sync_api import sync_playwright

Q = "?autostart=1&p=assets/xbot.glb&b=assets/xbot.glb&anim=1"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)

    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(11000)
    pg.keyboard.press("F3")
    pg.wait_for_timeout(300)

    report = pg.evaluate("""() => {
      const d = window.__dbg;
      const out = [];
      const map = { light1: 'p_light1', light2: 'p_light2', heavy: 'p_heavy' };
      for (const [st, mid] of Object.entries(map)) {
        d.player.setState(st, mid);
        const b = d.player.binder;
        // 触发一次 clip 切换
        b.update(d.player, 0.016);
        const act = b.current;
        const clip = act ? act.getClip() : null;
        const move = d.MOVES[mid];
        const total = move.startup + move.active + move.recovery;
        out.push({
          state: st, clip: b.currentName,
          clipFrames: clip ? Math.round(clip.duration * 60) : null,
          tableFrames: total,
          timeScale: act ? +act.getEffectiveTimeScale().toFixed(2) : null,
          startup: move.startup, active: move.active, recovery: move.recovery,
        });
      }
      return out;
    }""")

    print(f"{'state':<8} {'clip':<28} {'clipF':>6} {'table':>6} {'scale':>6}  s/a/r")
    print("-" * 74)
    for r in report:
        print(f"{r['state']:<8} {str(r['clip']):<28} {str(r['clipFrames']):>6} "
              f"{r['tableFrames']:>6} {str(r['timeScale']):>6}  "
              f"{r['startup']}/{r['active']}/{r['recovery']}")

    pg.screenshot(path="tests/33-retimed.png")
    if logs:
        print("\n--- console ---")
        for l in logs[:10]:
            print(l)
    b.close()
