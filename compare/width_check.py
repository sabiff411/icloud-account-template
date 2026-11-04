#!/usr/bin/env python3
"""Pixel-check the responsive breakpoints that the reference also has:
600 (phone-ish), 768 (tablet), 834 (small desktop) — the widths where the
header, footer and widget switch layout."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops

ORIG = "http://127.0.0.1:5199"
MINE = "http://127.0.0.1:5173"
WIDTHS = [(600, 900), (768, 900), (834, 900)]
PAGES = [("login", "/sign-in?dev=1", "/sign-in"), ("verify", "/verify?dev=1", "/verify"),
         ("terms", "/terms?dev=1", "/terms"), ("done", "/done?dev=1", "/done"),
         ("loading", "/sign-in?dev=1", "/loading")]
OUT = Path("compare/width_shots")
OUT.mkdir(exist_ok=True)

FREEZE = """() => { const s=document.createElement('style');
  s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';
  document.head.appendChild(s); }"""
VEIL = """() => { const nibs=Array.from({length:8},(_,i)=>'<i class="tk-load__nib tk-load__nib-'+(i+1)+'"></i>').join('');
  const el=document.createElement('div'); el.className='tk-load'; el.innerHTML='<div class="tk-load__ring">'+nibs+'</div>';
  document.body.appendChild(el); }"""

def shot(browser, w, h, url, out, veil=False):
    ctx=browser.new_context(viewport={"width":w,"height":h}, device_scale_factor=1)
    pg=ctx.new_page(); pg.goto(url, wait_until="networkidle"); pg.evaluate("()=>document.fonts.ready"); pg.wait_for_timeout(500)
    if veil:
        pg.evaluate(VEIL); pg.wait_for_timeout(200); pg.evaluate("()=>{const v=document.querySelector('.tk-load'); if(v)v.style.opacity='1'}"); pg.wait_for_timeout(120)
    pg.evaluate(FREEZE); pg.wait_for_timeout(80); pg.screenshot(path=str(out), full_page=True); ctx.close()

def diff(a,b):
    A=Image.open(a).convert("RGB"); B=Image.open(b).convert("RGB")
    w=min(A.width,B.width); h=min(A.height,B.height)
    d=ImageChops.difference(A.crop((0,0,w,h)),B.crop((0,0,w,h))).convert("L")
    hist=d.histogram(); total=w*h
    return {"size_a":[A.width,A.height],"size_b":[B.width,B.height],
            "changed_px":sum(hist[9:]), "changed_pct":round(100*sum(hist[9:])/total,3),
            "mean_abs_pct":round(100*sum(i*n for i,n in enumerate(hist))/(255*total),4)}

rows=[]
with sync_playwright() as p:
    browser=p.chromium.launch()
    for w,h in WIDTHS:
        for name,opath,mpath in PAGES:
            oa=OUT/f"orig-{name}-{w}.png"; mb=OUT/f"mine-{name}-{w}.png"
            shot(browser,w,h,MINE+mpath,mb,veil=(name=="loading"))
            # best of two reference frames (the reference's iframe can jitter 1 px)
            best=None; bestd=None
            for i in range(2):
                t=OUT/f"_tmp-{name}-{w}-{i}.png"
                shot(browser,w,h,ORIG+opath,t,veil=(name=="loading"))
                dd=diff(t,mb)
                if best is None or dd["changed_px"]<bestd["changed_px"]:
                    best,bestd=t,dd
            Image.open(best).save(oa)
            for i in range(2):
                (OUT/f"_tmp-{name}-{w}-{i}.png").unlink(missing_ok=True)
            bestd.update({"page":name,"width":w}); rows.append(bestd)
            print(f'{name:8} {w}   changed {bestd["changed_pct"]:6}%   mean {bestd["mean_abs_pct"]:7}%   size {bestd["size_a"]} / {bestd["size_b"]}')
    browser.close()
Path("compare/width_summary.json").write_text(json.dumps(rows,indent=1))
