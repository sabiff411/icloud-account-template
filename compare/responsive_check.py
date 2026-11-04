#!/usr/bin/env python3
"""No horizontal scroll, and the chrome is where it should be, at every width.

Checks the replica at a width matrix (phones to desktop), on every route, and
reports:
  * document scrollWidth vs viewport (horizontal overflow)
  * the global header / local nav / footer boxes (height + y)
  * any element whose paint box extends past the viewport (informational; the
    design intentionally clips the ring artwork and the terms CTA)
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

MINE = "http://127.0.0.1:5173"
WIDTHS = [320, 360, 375, 390, 414, 480, 600, 734, 735, 768, 834, 1024, 1280, 1440, 1920]
ROUTES = [("login", "/sign-in"), ("loading", "/loading"), ("verify", "/verify"),
          ("terms", "/terms"), ("done", "/done")]

JS = """() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const vw = window.innerWidth;
  const overflowing = [];
  for (const el of document.querySelectorAll('main *, #globalnav *, #ac-localnav *, #ac-globalfooter *')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (b.right > vw + 0.5 || b.left < -0.5) {
      // ignore intentionally clipped artwork / the wider-than-content CTA
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/rings|animate-rings|tk-load|agree/i.test(cls)) continue;
      overflowing.push({ tag: el.tagName, cls: cls.slice(0, 60), left: +b.left.toFixed(1), right: +b.right.toFixed(1) });
    }
  }
  return {
    viewport: vw,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    header: r(document.querySelector('#globalnav')),
    local: r(document.querySelector('#ac-localnav')),
    footer: r(document.querySelector('#ac-globalfooter')),
    main: r(document.querySelector('main')),
    overflowing: overflowing.slice(0, 6),
    overflowCount: overflowing.length,
  };
}"""

def main():
    results = []
    bad = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in WIDTHS:
            ctx = browser.new_context(viewport={"width": width, "height": 900}, device_scale_factor=1)
            page = ctx.new_page()
            for name, path in ROUTES:
                page.goto(MINE + path, wait_until="networkidle")
                page.evaluate("() => document.fonts.ready")
                page.wait_for_timeout(250)
                d = page.evaluate(JS)
                d.update({"page": name, "width": width})
                if d["scrollWidth"] > d["viewport"]:
                    bad += 1
                results.append(d)
            ctx.close()
        browser.close()
    Path("compare/responsive.json").write_text(json.dumps(results, indent=1))

    print(f"{'page':8} {'vw':6} {'scrollW':7} {'header':20} {'local':20} {'footer':20} overflow")
    for r in results:
        h = "—" if not r["header"] else f'h{r["header"]["h"]:.0f}@y{r["header"]["y"]:.0f}'
        l = "—" if not r["local"] else f'h{r["local"]["h"]:.0f}@y{r["local"]["y"]:.0f}'
        f = "—" if not r["footer"] else f'h{r["footer"]["h"]:.0f}@y{r["footer"]["y"]:.0f}'
        flag = "" if r["scrollWidth"] <= r["viewport"] else "  <-- H-SCROLL"
        extra = f'  {r["overflowCount"]} el' if r["overflowCount"] else ""
        print(f'{r["page"]:8} {r["width"]:6} {r["scrollWidth"]:7} {h:20} {l:20} {f:20}{flag}{extra}')
    print("\nhorizontal overflow cases:", bad)
    return 0 if bad == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
