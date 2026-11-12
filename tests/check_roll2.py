# -*- coding: utf-8 -*-
"""Trigger a real roll and sample head height over time."""
from playwright.sync_api import sync_playwright

Q = "?p=assets/Y_Bot.glb&anim=1"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 900, "height": 700})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:5173/" + Q, wait_until="load")
    pg.wait_for_timeout(13000)

    # 冻结 Boss 的 AI，别让它插一脚
    pg.evaluate("""() => {
      const d = window.__dbg;
      d.boss.pos.set(0, 0, -14);      // 把 Boss 推远，避免打断
      d.player.pos.set(0, 0, 12);
      d.boss.setState('idle');
    }""")
    print("CFG.rollTotal =", pg.evaluate("() => window.__dbg.CFG.rollTotal"),
          " playerIframe =", pg.evaluate("() => window.__dbg.CFG.playerIframe"))

    print("clip info:", pg.evaluate("""() => {
      const p = window.__dbg.player;
      const c = p.binder?.clips.get('Dive_Roll');
      return c ? { name: c.name, dur: +c.duration.toFixed(2), frames: Math.round(c.duration*60) } : null;
    }"""))

    pg.keyboard.press("Shift")          # 触发翻滚
    samples = []
    for i in range(14):
        pg.wait_for_timeout(70)
        s = pg.evaluate("""() => {
          const p = window.__dbg.player;
          const V = p.pos.constructor;
          const h = p.mesh.group.getObjectByName('mixamorigHead');
          const b = p.binder;
          return {
            state: p.state, frame: Math.round(p.frame),
            headY: h ? +h.getWorldPosition(new V()).y.toFixed(2) : null,
            clipTime: b && b.current ? +b.current.time.toFixed(2) : null,
            clipName: b ? b.currentName : null,
          };
        }""")
        samples.append(s)
        bar = "#" * int(max(0, min(34, (s["headY"] or 0) * 20)))
        print(f"  {i*70:>4}ms  state={s['state']:<6} f={s['frame']:>2}  clip={s['clipName']}  t={s['clipTime']}  headY={s['headY']:<5} {bar}")
        if i == 4:
            pg.screenshot(path="tests/71-roll-mid.png")

    pg.screenshot(path="tests/72-roll-after.png")

    # 判定：playhead 有没有真的推进
    times = [s["clipTime"] for s in samples if s["clipTime"] is not None]
    heads = [s["headY"] for s in samples if s["headY"] is not None]
    print(f"\nclipTime range: {min(times) if times else '-'} .. {max(times) if times else '-'}")
    print(f"headY range  : {min(heads) if heads else '-'} .. {max(heads) if heads else '-'}")
    print("ROLLING" if heads and min(heads) < 0.9 else "NOT ROLLING")

    if errs:
        print("errors:", errs[:4])
    b.close()
