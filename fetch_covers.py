# -*- coding: utf-8 -*-
"""下载视频投稿的封面缩略图。

视频媒体本身不下载，但封面属于卡片元信息，本地化可避免外链失效。

B站 CDN 的图片支持「参数后缀」形式缩放：
    http://i2.hdslb.com/bfs/archive/xxx.jpg@320w_200h_1c.webp
    后缀必须拼在查询串之后，且扩展名要回到 .webp 才会真的转码。
若只拼 @320w_200h_1c 而保留 .jpg，CDN 会返回「缩小但仍为 jpg」的图；
若后缀写错，CDN 会静默返回原图——所以下载后必须校验尺寸与格式。
"""
import json
import os
import struct
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "data", "bilibili", "2094031249", "raw", "detail_cache.json")
DST = os.path.join(ROOT, "site", "assets", "images", "media")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 卡片里显示约 160×100，2 倍屏取 320×200
THUMB = "@320w_200h_1c.webp"
MAX_W = 640  # 超过这个宽度就认为 CDN 没走缩略图


def sniff(data):
    """返回 (格式, 宽, 高)，只依赖标准库。"""
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        fmt = data[12:16]
        if fmt == b"VP8X":
            return "webp", 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if fmt == b"VP8 ":
            return "webp", int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
        if fmt == b"VP8L":
            b = int.from_bytes(data[21:25], "little")
            return "webp", (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
        return "webp", -1, -1
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            m = data[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3):
                h = int.from_bytes(data[i + 5:i + 7], "big")
                w = int.from_bytes(data[i + 7:i + 9], "big")
                return "jpeg", w, h
            if m == 0xD8 or 0xD0 <= m <= 0xD9:
                i += 2
                continue
            i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
        return "jpeg", -1, -1
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return "?", -1, -1


def build_url(cover):
    """把原始封面地址转成缩略图地址。

    B站 CDN 的规则是「在完整路径（含扩展名）后面直接追加 @参数」：
        .../abc.jpg  ->  .../abc.jpg@320w_200h_1c.webp
    把 .jpg 去掉再拼会导致 404，必须原样保留。
    """
    base = cover.split("?", 1)[0]
    # 去掉可能已存在的 @xxx 后缀，避免重复追加
    if "@" in base.rsplit("/", 1)[-1]:
        base = base.rsplit("@", 1)[0]
    return base + THUMB


def main():
    force = "--force" in sys.argv
    os.makedirs(DST, exist_ok=True)
    cache = json.load(open(SRC, encoding="utf-8"))

    jobs = []
    for oid, v in cache.items():
        if not isinstance(v, dict):
            continue
        cover = ((v.get("video") or {}).get("cover") or "")
        if not cover:
            continue
        cover = "https:" + cover if cover.startswith("//") else cover
        name = cover.split("?", 1)[0].rsplit("/", 1)[-1].rsplit("@", 1)[0]
        base, _ = os.path.splitext(name)
        jobs.append((cover, base + THUMB))

    print(f"待处理封面 {len(jobs)} 张")
    ok = skip = fail = 0
    total = 0
    for i, (url, fn) in enumerate(jobs, 1):
        dst = os.path.join(DST, fn)
        if not force and os.path.exists(dst) and os.path.getsize(dst) > 0:
            with open(dst, "rb") as f:
                head = f.read(64 * 1024)
            kind, w, _ = sniff(head)
            if kind == "webp" and 0 < w <= MAX_W:
                skip += 1
                total += os.path.getsize(dst)
                continue
        try:
            req = urllib.request.Request(
                build_url(url),
                headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read(4 * 1024 * 1024)
            kind, w, h = sniff(data)
            # CDN 偶尔会回落原图：格式不是 webp 或尺寸过大就判定失败
            if kind != "webp" or not (0 < w <= MAX_W):
                fail += 1
                print(f"  未命中缩略图 {fn}: {kind} {w}x{h} {len(data)//1024}KB")
                continue
            with open(dst, "wb") as f:
                f.write(data)
            ok += 1
            total += len(data)
        except Exception as e:
            fail += 1
            print(f"  失败 {fn}: {e}")
        if i % 20 == 0 or i == len(jobs):
            print(f"  {i}/{len(jobs)} 新增 {ok} 跳过 {skip} 失败 {fail}")
        time.sleep(0.18)

    print(f"完成：新增 {ok}，已存在 {skip}，失败 {fail}，合计 {total / 1048576:.2f} MB")


if __name__ == "__main__":
    main()
