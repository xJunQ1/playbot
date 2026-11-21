# -*- coding: utf-8 -*-
"""Headless acceptance check: screenshots + console errors + guard/parry window capture."""
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?autostart=1"
OUT = "tests"

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

    page.add_init_script("localStorage.setItem('souls-demo-settings', JSON.stringify({v: 5, showFrameData: true}));")
    page.goto(URL, wait_until="load")
    page.locator("#hud").wait_for(state="visible")

    # 1) initial frame
    page.screenshot(path=f"{OUT}/01-idle.png")

    # 2) light attack
    page.mouse.click(640, 360, button="left")
    page.wait_for_timeout(250)
    page.screenshot(path=f"{OUT}/02-attack.png")

    # 3) approach + heavy attack
    page.keyboard.down("w")
    page.wait_for_timeout(1400)
    page.keyboard.up("w")
    page.keyboard.press("f")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/03-heavy.png")

    # 4) roll
    page.keyboard.press("Shift")
    page.wait_for_timeout(200)
    page.screenshot(path=f"{OUT}/04-roll.png")

    # 5) lock on, wait for an active boss attack frame
    page.mouse.click(640, 360, button="middle")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/05-locked.png")

    captured = False
    for _ in range(120):
        page.wait_for_timeout(60)
        if page.evaluate("window.__dbg.boss.state === 'attack'"):
            page.screenshot(path=f"{OUT}/06-boss-attack.png")
            captured = True
            print("[captured boss attack frame]")
            break
    if not captured:
        page.screenshot(path=f"{OUT}/06-boss-attack.png")
        print("[no attack frame captured]")

    # 6) guard: freeze the frame first, otherwise the screenshot itself burns the 8-frame window
    page.mouse.down(button="right")
    page.wait_for_timeout(30)
    page.keyboard.press("F3")          # pause: freezes logic frame
    page.wait_for_timeout(120)
    parry_hud = page.inner_text("#combatDebug")
    page.screenshot(path=f"{OUT}/07-guard-parry.png")
    page.keyboard.press("F3")

    page.wait_for_timeout(600)
    page.keyboard.press("F3")
    page.wait_for_timeout(120)
    hold_hud = page.inner_text("#combatDebug")
    page.screenshot(path=f"{OUT}/08-guard-hold.png")
    page.keyboard.press("F3")
    page.mouse.up(button="right")
    page.wait_for_timeout(150)

    print("=== PARRY WINDOW HUD ===")
    print(parry_hud)
    print("=== STEADY GUARD HUD ===")
    print(hold_hud)

    # 7) frame-limit panel: total frames + warning column
    page.screenshot(path=f"{OUT}/10-panel-frames.png",
                    clip={"x": 990, "y": 0, "width": 290, "height": 720})

    # 7) soak test: hold guard and eat boss hits, verify damage reduction
    page.keyboard.press("r")
    page.wait_for_timeout(600)
    page.mouse.down(button="right")
    soak0 = int(page.locator("#playerLife").get_attribute("aria-valuenow"))
    page.wait_for_timeout(9000)
    soak1 = int(page.locator("#playerLife").get_attribute("aria-valuenow"))
    page.mouse.up(button="right")
    page.screenshot(path=f"{OUT}/09-guard-soak.png")
    print(f"=== GUARD SOAK: HP {soak0} -> {soak1} (delta {soak1 - soak0}) ===")

    fps_probe = page.evaluate("""() => new Promise(r => {
        let n = 0; const t0 = performance.now();
        const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); };
        requestAnimationFrame(f);
    })""")

    print(f"\n=== FPS probe: {fps_probe} frames/s ===")
    print("=== console ===")
    for l in logs[:40]:
        print(l)
    if not logs:
        print("(clean)")

    browser.close()
