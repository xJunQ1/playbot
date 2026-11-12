# -*- coding: utf-8 -*-
"""
Mixamo 半自动下载器。

用法：
    python tools/mixamo.py

流程：
    1. 弹出一个可见的浏览器，打开 www.mixamo.com
    2. 你手动登录（脚本不碰密码）
    3. 登录完成后回终端按回车
    4. 脚本自动搜索并下载下面的动画，存到 assets/in/

失败时会把 DOM 结构和截图写到 tools/ 下，交给开发者修选择器。
"""
import os
import re
import sys
import time
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "in"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 文件名 -> Mixamo 搜索词。文件名就是 SOULS_PACK 的键，别改。
TARGETS = [
    ("hero",                        "Y Bot",                    "character"),
    ("Idle",                        "Idle",                     "motion"),
    ("Walking",                     "Walk",                     "motion"),
    ("Running",                     "Run",                      "motion"),
    ("Dive_Roll",                   "Dodge",                    "motion"),
    ("Blocking",                    "Blocking",                 "motion"),
    ("Getting_Hit_Backwards",       "Hit Reaction",             "motion"),
    ("Death",                       "Death",                    "motion"),
    ("Stable_Sword_Inward_Slash",   "Sword And Shield Slash",   "motion"),
    ("Stable_Sword_Outward_Slash",  "Sword Slash",              "motion"),
    ("Great_Sword_Slash",           "Great Sword Slash",        "motion"),
    ("Great_Sword_Attack",          "Great Sword Attack",       "motion"),
    ("Standing_Dodge_Forward",      "Dodge Forward",            "motion"),
]

BASE = "https://www.mixamo.com"
SEARCH_URL = BASE + "/#/?page=1&query={q}&type=Motion%2CMotionPack"
CHAR_URL = BASE + "/#/?page=1&query={q}&type=Character"

report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "steps": [], "downloads": []}


def log(msg):
    print(msg, flush=True)
    report["steps"].append(msg)


def dump(page, tag):
    """失败时保存诊断信息"""
    try:
        html = page.content()
        (ROOT / "tools" / f"mixamo-dom-{tag}.html").write_text(html, encoding="utf-8")

        # 收集所有可点击元素的文本和 class，方便定位
        items = page.evaluate("""() => {
            const out = [];
            document.querySelectorAll('button, [role=button], a, [class*=thumb], [class*=card], img[alt]').forEach(el => {
                const t = (el.innerText || el.alt || '').trim().slice(0, 60);
                if (t) out.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), text: t });
            });
            return out.slice(0, 120);
        }""")
        (ROOT / "tools" / f"mixamo-elements-{tag}.json").write_text(
            json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
        page.screenshot(path=str(ROOT / "tools" / f"mixamo-{tag}.png"), full_page=False)
        log(f"  [dump] 已保存 mixamo-dom-{tag}.html / mixamo-elements-{tag}.json / mixamo-{tag}.png")
    except Exception as e:
        log(f"  [dump] 失败: {e}")


def set_dropdown(page, label, option):
    """Mixamo 的下拉是自定义组件：点开、选中文本"""
    try:
        box = page.locator(f"text={label}").first
        box.click(timeout=4000)
        time.sleep(0.35)
        page.locator(f"text={option}").first.click(timeout=4000)
        time.sleep(0.3)
        return True
    except Exception:
        return False


def download_one(page, name, query, kind, idx):
    dest = OUT_DIR / f"{name}.fbx"
    if dest.exists():
        log(f"[{idx}] {name} 已存在，跳过")
        return True

    url = (CHAR_URL if kind == "character" else SEARCH_URL).format(q=query.replace(" ", "%20"))
    log(f"[{idx}] {name}  ← 搜索 '{query}'")
    page.goto(url, wait_until="domcontentloaded")
    time.sleep(3.0)

    # 点第一个结果
    card = None
    for sel in ["[class*=thumb]", "[class*=card]", "img[alt]", ".grid img"]:
        try:
            c = page.locator(sel).first
            if c.count() > 0:
                card = c
                break
        except Exception:
            continue
    if card is None:
        dump(page, f"{idx}-{name}-noclick")
        log("  ✗ 找不到结果卡片")
        return False

    try:
        card.click(timeout=6000)
        time.sleep(2.2)
    except Exception as e:
        dump(page, f"{idx}-{name}-clickfail")
        log(f"  ✗ 点击失败: {e}")
        return False

    # 下载按钮
    try:
        page.get_by_text("Download", exact=False).first.click(timeout=6000)
        time.sleep(1.6)
    except Exception:
        dump(page, f"{idx}-{name}-nodownload")
        log("  ✗ 找不到 Download 按钮")
        return False

    # 面板设置
    if kind == "character":
        set_dropdown(page, "Skin", "With Skin")
        set_dropdown(page, "Pose", "T-pose")
    else:
        set_dropdown(page, "Skin", "Without Skin")
        set_dropdown(page, "Pose", "T-pose")

    # 真正下载
    try:
        with page.expect_download(timeout=45000) as dl:
            page.get_by_text("Download", exact=False).last.click(timeout=6000)
        d = dl.value
        d.save_as(str(dest))
        size = dest.stat().st_size // 1024
        log(f"  ✓ {dest.name}  {size}KB")
        report["downloads"].append({"name": name, "file": dest.name, "kb": size})
        return True
    except Exception as e:
        dump(page, f"{idx}-{name}-dlfail")
        log(f"  ✗ 下载失败: {e}")
        return False


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, args=["--start-maximized"])
        ctx = browser.new_context(accept_downloads=True, viewport=None)
        page = ctx.new_page()

        log("打开 www.mixamo.com …")
        page.goto(BASE, wait_until="domcontentloaded")
        time.sleep(2)

        print("\n" + "=" * 62)
        print(" 浏览器已打开。请在里面完成：")
        print("   1. 点右上角 SIGN IN，用你注册好的 Adobe 账号登录")
        print("   2. 确认能看到动画网格（说明登录成功）")
        print("   3. 回到这个终端，按回车开始自动下载")
        print("=" * 62 + "\n")
        input(">>> 登录完成后按回车 ")

        # 确认已经登录：能看到搜索框或卡片
        time.sleep(2)
        dump(page, "after-login")

        ok = 0
        for i, (name, query, kind) in enumerate(TARGETS, 1):
            try:
                if download_one(page, name, query, kind, i):
                    ok += 1
            except Exception as e:
                log(f"[{i}] {name} 异常: {e}")

        log(f"\n完成 {ok}/{len(TARGETS)}")

        (ROOT / "tools" / "mixamo-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        print("\n浏览器保持打开，看看下载结果。按回车关闭。")
        input()
        browser.close()


if __name__ == "__main__":
    main()
