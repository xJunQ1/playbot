# -*- coding: utf-8 -*-
"""Run the clip analyzer and dump strike-frame data as JSON."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    pg = b.new_page(viewport={"width": 1100, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)

    pg.goto("http://localhost:5173/tools/analyze.html", wait_until="load")
    pg.wait_for_function("() => window.__DONE__ === true", timeout=120000)
    rows = pg.evaluate("() => window.__ANALYSIS__")

    print(f"{'clip':<30} {'dur':>5} {'frames':>6} {'accel':>6} {'strike':>6} {'active':>6} {'len':>4} {'peak':>6}")
    print("-" * 82)
    for r in rows:
        if "error" in r:
            print(f"{r['name']:<30} ERROR {r['error']}")
            continue
        print(f"{r['name']:<30} {r['duration']:>5} {r['frames']:>6} "
              f"{r['accelFrame']:>6} {r['strikeFrame']:>6} {r['activeStart']:>6} "
              f"{r.get('activeLen', '-'):>4} {r.get('peakSpeed', '-'):>6}")

    with open("tests/clip-analysis.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print("\nsaved -> tests/clip-analysis.json")

    pg.screenshot(path="tests/32-analyzer.png")
    if errs:
        print("\nerrors:", errs[:6])
    b.close()
