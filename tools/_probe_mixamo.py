# -*- coding: utf-8 -*-
"""Headless probe: can we load Mixamo, and what does the DOM look like?"""
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://www.mixamo.com"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:120]}"))
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

    try:
        pg.goto(BASE, wait_until="domcontentloaded", timeout=45000)
    except Exception as e:
        print("goto failed:", e)
        b.close()
        raise SystemExit(1)

    time.sleep(6)
    print("url      :", pg.url)
    print("title    :", pg.title())

    info = pg.evaluate("""() => {
        const out = { inputs: [], buttons: [], text: '' };
        document.querySelectorAll('input').forEach(el => out.inputs.push({
            type: el.type, ph: el.placeholder || '', name: el.name || '', cls: (el.className||'').toString().slice(0,60)
        }));
        document.querySelectorAll('button, [role=button], a[class*=btn], a[class*=sign]').forEach(el => {
            const t = (el.innerText || '').trim();
            if (t) out.buttons.push({ tag: el.tagName, text: t.slice(0,40), cls: (el.className||'').toString().slice(0,60) });
        });
        out.text = (document.body.innerText || '').slice(0, 600);
        return out;
    }""")

    print("\n--- inputs ---")
    for i in info["inputs"][:10]:
        print(" ", i)
    print("\n--- buttons ---")
    for x in info["buttons"][:15]:
        print(" ", x)
    print("\n--- body text ---")
    print(info["text"][:500])

    (ROOT / "tools" / "mixamo-probe.json").write_text(
        json.dumps({"url": pg.url, "title": pg.title(), **info}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    pg.screenshot(path=str(ROOT / "tools" / "mixamo-probe.png"))
    print("\nsaved tools/mixamo-probe.json + mixamo-probe.png")
    print("console:", logs[:6] if logs else "(clean)")
    b.close()
