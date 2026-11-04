#!/usr/bin/env python3
"""Compare the page chrome (global nav, local nav, footer, document height)
between the reference and the replica across breakpoints."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ORIG = "http://127.0.0.1:5199"
MINE = "http://127.0.0.1:5173"
WIDTHS = [320, 390, 414, 600, 734, 735, 768, 834, 1024, 1440]
PAGES = [("login", "/sign-in?dev=1", "/sign-in"), ("verify", "/verify?dev=1", "/verify"),
         ("terms", "/terms?dev=1", "/terms"), ("done", "/done?dev=1", "/done")]

JS = """() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect(); return [+r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]; };
  return {
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    header: box('#globalnav'), local: box('#ac-localnav'),
    footer: box('#ac-globalfooter'), main: box('main'),
    navList: box('#globalnav ul'),
    localTitle: box('#ac-localnav a'),
    footerShop: box('#ac-globalfooter > div > div > div'),
  };
}"""

def measure(browser, url, width):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    page.goto(url, wait_until="networkidle")
    page.evaluate("() => document.fonts.ready")
    page.wait_for_timeout(300)
    page.evaluate("() => window.scrollTo(0, 0)")
    d = page.evaluate(JS)
    ctx.close()
    return d

rows, mismatches = [], 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in WIDTHS:
        for name, opath, mpath in PAGES:
            a = measure(browser, ORIG + opath, width)
            b = measure(browser, MINE + mpath, width)
            for key in ("header", "local", "footer", "main", "doc"):
                if a[key] != b[key]:
                    mismatches += 1
                    rows.append({"width": width, "page": name, "key": key, "orig": a[key], "mine": b[key]})
    browser.close()

Path("compare/chrome.json").write_text(json.dumps({"mismatches": mismatches, "rows": rows}, indent=1))
print(f"chrome mismatches: {mismatches} across {len(WIDTHS)*len(PAGES)} page/width pairs")
for r in rows:
    print(f'  {r["width"]} {r["page"]} {r["key"]}: orig={r["orig"]} mine={r["mine"]}')
