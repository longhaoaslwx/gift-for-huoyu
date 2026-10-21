# -*- coding: utf-8 -*-
"""为动态配图生成「列表缩略图 + 灯箱大图」两档 WebP。

原图动辄 3–5 MB，站点里列表只显示约 180px、灯箱最多 1100px 宽，
直接引用原图会让首屏与归档页加载量爆炸。

B站 CDN 支持路径后缀缩放：
    .../abc.jpg@480w_1c.webp   -> 宽 480 的 WebP
    .../abc.jpg@1080w_1c.webp  -> 宽 1080 的 WebP
后缀必须拼在完整文件名（含 .jpg）之后，扩展名的 .webp 才会触发转码，
写错时 CDN 会静默返回原图，所以下载后必须校验格式与宽度。

输出命名沿用原始文件名（去掉扩展名）：
    <stem>@480w_1c.webp   列表缩略图
    <stem>@1080w_1c.webp  灯箱大图
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "data", "bilibili", "2094031249", "dynamics", "all.json")
DST = os.path.join(ROOT, "site", "assets", "images", "media")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

VARIANTS = [("@480w_1c.webp", 480), ("@1080w_1c.webp", 1080)]


def sniff(data):
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        fmt = data[12:16]
        if fmt == b"VP8X":
            return "webp", 1 + int.from_bytes(data[24:27], "little")
        if fmt == b"VP8 ":
            return "webp", int.from_bytes(data[26:28], "little") & 0x3FFF
        if fmt == b"VP8L":
            b = int.from_bytes(data[21:25], "little")
            return "webp", (b & 0x3FFF) + 1
        return "webp", -1
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg", -1
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", int.from_bytes(data[16:20], "big")
    return "?", -1


def fetch(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(8 * 1024 * 1024)


def main():
    force = "--force" in sys.argv
    os.makedirs(DST, exist_ok=True)
    posts = json.load(open(SRC, encoding="utf-8"))

    urls = []
    seen = set()
    for p in posts:
        for u in (p.get("images") or []):
            if u.startswith("//"):
                u = "https:" + u
            if u not in seen:
                seen.add(u)
                urls.append(u)

    print(f"待处理配图 {len(urls)} 张，每张 2 档")
    ok = skip = fail = 0
    total = 0
    for i, u in enumerate(urls, 1):
        base = u.split("?", 1)[0]
        stem = base.rsplit("/", 1)[-1]
        if "@" in stem:
            base = base.rsplit("@", 1)[0]
            stem = base.rsplit("/", 1)[-1]
        stem = os.path.splitext(stem)[0]

        for suf, want_w in VARIANTS:
            fn = stem + suf
            dst = os.path.join(DST, fn)
            if not force and os.path.exists(dst) and os.path.getsize(dst) > 0:
                with open(dst, "rb") as f:
                    kind, w = sniff(f.read(64 * 1024))
                if kind == "webp" and 0 < w <= want_w:
                    skip += 1
                    total += os.path.getsize(dst)
                    continue
            try:
                data = fetch(base + suf)
                kind, w = sniff(data)
                if kind != "webp" or not (0 < w <= want_w):
                    fail += 1
                    print(f"  未命中 {fn}: {kind} w={w} {len(data)//1024}KB")
                    continue
                with open(dst, "wb") as f:
                    f.write(data)
                ok += 1
                total += len(data)
            except Exception as e:
                fail += 1
                print(f"  失败 {fn}: {e}")
            time.sleep(0.12)

        if i % 15 == 0 or i == len(urls):
            print(f"  {i}/{len(urls)} 新增 {ok} 跳过 {skip} 失败 {fail}")

    print(f"完成：新增 {ok}，已存在 {skip}，失败 {fail}，合计 {total / 1048576:.2f} MB")


if __name__ == "__main__":
    main()
