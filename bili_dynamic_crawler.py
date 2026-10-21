#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B 站 UP 主动态采集器（文本 + 图片 + 发布时间）

特性
----
1. 分页遍历：opia/feed/space 以 offset 翻页直至 has_more=False，覆盖全部历史动态
2. 精确时间：opus/detail 逐条补 pub_ts（清单接口的 pub_time 为空）
3. 跳过视频：DYNAMIC_TYPE_AV / DYNAMIC_TYPE_PGC / 正文含视频卡片的条目一律过滤
4. 仅保留：正文文本、全部图片链接、发布时间、动态链接、互动统计
5. 限速与重试：随机间隔 + 指数退避 + 412/-352 风控冷却 + WBI 签名刷新
6. 断点续跑：清单与详情缓存落盘，中断后重跑不重复请求
7. 目录可追溯：
     data/bilibili/2094031249/
        index.json              汇总 + 按年份分片索引 + 按 ID 索引骨架
        dynamics/all.json       全部动态（扁平数组）
        dynamics/year_2026.json 按发布年份分片
        raw/opus_list.json      接口原始清单（可追溯）
        raw/detail_cache.json   详情缓存
        run_log.json            运行元数据

用法
----
    python bili_dynamic_crawler.py                     # 全流程
    python bili_dynamic_crawler.py --stage list        # 仅翻页取清单
    python bili_dynamic_crawler.py --stage detail      # 仅补详情（可续跑）
    python bili_dynamic_crawler.py --stage build       # 仅汇总输出
    python bili_dynamic_crawler.py --uid 2094031249 --pace 2.0
"""

import argparse
import datetime
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ------------------------------------------------ 常量
DEFAULT_UID = 2094031249
# 默认数据目录跟随脚本位置，保证在 Windows 本地与 GitHub Actions
# （Linux runner）上行为一致；也可用 --data-dir 显式覆盖。
DEFAULT_DATA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi"
RELSTAT_URL = "https://api.bilibili.com/x/relation/stat"
OPUS_FEED_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/feed/space"
FEED_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
OPUS_DETAIL_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail"
# 老接口：opus/detail 对「进入 opus 体系之前」的历史动态会返回空 item，
# 而 desktop/v1/detail 仍能取到这些条目（返回体在根级的 item 字段）
DESKTOP_DETAIL_URL = "https://api.bilibili.com/x/polymer/web-dynamic/desktop/v1/detail"

# 纯视频投稿类动态：无正文、无图，按需求跳过
VIDEO_DYNAMIC_TYPES = {"DYNAMIC_TYPE_AV", "DYNAMIC_TYPE_PGC", "DYNAMIC_TYPE_LIVE_RCMD"}

# B 站 WBI mixin_key 重排表
MIXIN_KEY_ORDER = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 57, 22, 25, 54, 21, 56, 51, 20, 4, 11, 34, 44, 52, 6, 59, 60,
    36, 30, 63, 62,
]

# opus_id 内置发布时间：pub_ts = (opus_id >> 32) + OPUS_ID_TS_OFFSET
# 已用 601 条真实 pub_ts 验证，偏差 0 秒。
# 因此发布时间无需请求详情接口，可直接从 ID 解码。
OPUS_ID_TS_OFFSET = 1498838400  # 对应 2025-01-01 00:00:00

# 站点面向中文读者，全部时间一律按北京时间（固定 +08:00）输出。
# 不用 time.localtime()：GitHub Actions runner 是 UTC 时区，会把每条
# pub_time 拧成 UTC，导致本地与 CI 产出的数据不一致、跨日的动态还会
# 被归错月份。
CST = datetime.timezone(datetime.timedelta(hours=8))

# 需要跳过的动态类型（视频、番剧、课程等非图文内容）
SKIP_TYPES = {
    "DYNAMIC_TYPE_AV",
    "DYNAMIC_TYPE_PGC",
    "DYNAMIC_TYPE_PGC_UNION",
    "DYNAMIC_TYPE_COURSES",
    "DYNAMIC_TYPE_COURSES_SEASON",
    "DYNAMIC_TYPE_COURSES_BATCH",
    "DYNAMIC_TYPE_LIVE",
    "DYNAMIC_TYPE_LIVE_RCMD",
}

# 需要跳过的 major 类型（正文主体为视频/番剧/直播等）
SKIP_MAJOR_TYPES = {
    "MAJOR_TYPE_ARCHIVE",
    "MAJOR_TYPE_PGC",
    "MAJOR_TYPE_COURSES",
    "MAJOR_TYPE_LIVE",
    "MAJOR_TYPE_LIVE_RCMD",
    "MAJOR_TYPE_MUSIC",
    "MAJOR_TYPE_MEDIALIST",
    "MAJOR_TYPE_UGC_SEASON",
}


def log(msg):
    print(msg, flush=True)


def jdump(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ------------------------------------------------ HTTP 客户端
class BiliClient:
    """封装 WBI 签名、设备指纹、限速与风控退避。"""

    def __init__(self, pace=1.5):
        self.cookie = ""
        self.mixin_key = ""
        self.blocked_until = 0.0
        self.pace = pace
        self._last_call = 0.0
        self.request_count = 0

    # ---- 请求头
    def _headers(self, referer):
        return {
            "User-Agent": UA,
            "Referer": referer,
            "Origin": "https://space.bilibili.com",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": self.cookie,
        }

    def _throttle(self):
        """基础限速：保证两次请求之间至少间隔 pace + 随机抖动。"""
        gap = self.pace + random.uniform(0, 0.8)
        elapsed = time.time() - self._last_call
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_call = time.time()

    def raw_get(self, url, params=None, referer="https://space.bilibili.com/"):
        if params:
            url = url + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=self._headers(referer))
        with urllib.request.urlopen(req, timeout=20) as resp:
            self.request_count += 1
            return json.loads(resp.read().decode("utf-8"))

    # ---- 会话初始化：设备指纹 + WBI 密钥
    def init(self, refresh_buvid=True):
        if refresh_buvid or not self.cookie:
            spi = self.raw_get(SPI_URL, referer="https://www.bilibili.com/")
            self.cookie = (
                f"buvid3={spi['data']['b_3']}; buvid4={spi['data']['b_4']}; "
                f"b_nut={int(time.time())}; buvid_fp_status=0; CURRENT_FNVAL=4048"
            )
            log(f"  [session] buvid3={spi['data']['b_3'][:24]}...")
        nav = self.raw_get(NAV_URL, referer="https://www.bilibili.com/")
        wbi = (nav.get("data") or {}).get("wbi_img")
        if not wbi:
            raise RuntimeError(f"WBI 密钥获取失败: {nav.get('code')} {nav.get('message')}")
        raw = (os.path.basename(wbi["img_url"]).split(".")[0]
               + os.path.basename(wbi["sub_url"]).split(".")[0])
        self.mixin_key = "".join(raw[i] for i in MIXIN_KEY_ORDER)[:32]
        log("  [session] WBI 密钥已刷新")

    # ---- WBI 签名
    def sign(self, params):
        params = dict(params)
        params["wts"] = str(int(time.time()))
        items = []
        for k in sorted(params):
            v = str(params[k])
            for ch in "!'()*-._~":
                v = v.replace(ch, "")
            items.append((k, v))
        query = urllib.parse.urlencode(items)
        params["w_rid"] = hashlib.md5((query + self.mixin_key).encode()).hexdigest()
        return params

    # ---- 带退避重试的调用
    def call(self, url, params, referer, max_retry=3, tag=""):
        for attempt in range(1, max_retry + 1):
            now = time.time()
            if now < self.blocked_until:
                wait = self.blocked_until - now
                log(f"    [{tag}] 风控冷却中，等待 {wait:.0f}s")
                time.sleep(wait)
            self._throttle()
            try:
                r = self.raw_get(url, self.sign(params), referer)
            except urllib.error.HTTPError as e:
                if e.code == 412:
                    self.blocked_until = time.time() + 40 * attempt
                    log(f"    [{tag}] HTTP 412 风控，冷却 {40 * attempt}s")
                    continue
                log(f"    [{tag}] HTTP {e.code}，{2 * attempt}s 后重试")
                time.sleep(2 * attempt)
                continue
            except Exception as e:  # noqa: BLE001
                log(f"    [{tag}] {type(e).__name__}，{2 * attempt}s 后重试")
                time.sleep(2 * attempt)
                continue

            code = r.get("code")
            if code == 0:
                return 0, (r.get("data") or {})
            if code in (-352, -412, -799, -509):
                self.blocked_until = time.time() + 25 * attempt
                log(f"    [{tag}] code={code} 风控，冷却 {25 * attempt}s")
                continue
            if code == -101:
                log(f"    [{tag}] code=-101 需要登录态")
                return code, {}
            return code, {}
        return -1, {}


# ------------------------------------------------ 路径
class Paths:
    def __init__(self, uid, data_dir):
        self.root = os.path.join(data_dir, "bilibili", str(uid))
        self.dyn_dir = os.path.join(self.root, "dynamics")
        self.raw_dir = os.path.join(self.root, "raw")
        self.list_json = os.path.join(self.raw_dir, "opus_list.json")
        self.detail_json = os.path.join(self.raw_dir, "detail_cache.json")
        self.all_json = os.path.join(self.dyn_dir, "all.json")
        self.index_json = os.path.join(self.root, "index.json")
        self.runlog_json = os.path.join(self.root, "run_log.json")
        self.media_dir = os.path.join(self.root, "media")

    def ensure(self):
        for d in (self.root, self.dyn_dir, self.raw_dir):
            os.makedirs(d, exist_ok=True)

    def year_json(self, year):
        return os.path.join(self.dyn_dir, f"year_{year}.json")


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            log(f"  [warn] 缓存损坏，忽略: {path}")
    return default


# ------------------------------------------------ 阶段 1：翻页取清单
def stage_list(uid, paths, client, max_pages=None):
    log("\n[1/4] 翻页抓取动态清单 (opus/feed/space)")
    items, offset, page, fails = [], "", 0, 0

    while True:
        page += 1
        if max_pages and page > max_pages:
            log(f"  [list] 达到页数上限 {max_pages}，停止")
            break
        p = {"host_mid": uid, "type": "all"}
        if offset:
            p["offset"] = offset
        else:
            p["page"] = 1

        code, data = client.call(
            OPUS_FEED_URL, p,
            f"https://space.bilibili.com/{uid}/article",
            tag=f"list p{page}")

        if code != 0:
            fails += 1
            log(f"  [warn] 第 {page} 页失败 code={code}（连续 {fails} 次）")
            if fails >= 3:
                log("  [error] 连续失败，停止翻页（已抓数据保留）")
                break
            client.init(refresh_buvid=False)
            continue

        batch = data.get("items") or []
        if not batch:
            log("  [list] 空页，判定到达末尾")
            break

        fails = 0
        items.extend(batch)
        log(f"  [list] 第 {page} 页 +{len(batch)}，累计 {len(items)}")

        offset = data.get("offset") or ""
        if not data.get("has_more") or not offset:
            log("  [list] has_more=False，全部历史动态已遍历完毕")
            break

        # 每 10 页刷新一次签名密钥，降低失效与风控概率
        if page % 10 == 0:
            client.init(refresh_buvid=False)

    jdump(items, paths.list_json)
    log(f"  [list] 已保存 {len(items)} 条 -> {paths.list_json}")
    return items


# ------------------------------------------------ 阶段 2：逐条补详情
def parse_video_card(item):
    """提取视频投稿类动态的视频卡片信息。

    视频本身不下载，只保留标题、跳转链接、BV 号、封面与时长。
    opus/detail 的卡片在 modules[].module_dynamic.major.archive；
    desktop/detail 的卡片在 module_desc.items[] 或 major.archive。
    """
    card = {"title": "", "url": "", "bvid": "", "cover": "", "duration": None,
            "desc": "", "aid": "", "stat": {}}

    def take(major):
        # opus/detail: module_dynamic.dyn_archive（视频投稿专用）
        # 另有 major.archive（新结构），两者字段一致，取到一个即可
        for src in ((major or {}).get("dyn_archive"),
                    (major or {}).get("archive")):
            if not isinstance(src, dict) or not src:
                continue
            card["title"] = card["title"] or (src.get("title") or "")
            card["bvid"] = card["bvid"] or (src.get("bvid") or "")
            card["aid"] = card["aid"] or (src.get("aid") or "")
            card["cover"] = card["cover"] or (src.get("cover") or "")
            card["duration"] = card["duration"] or src.get("duration_text")
            card["desc"] = card["desc"] or (src.get("desc") or "")
            if src.get("stat"):
                card["stat"] = card["stat"] or src["stat"]
            if not card["url"] and src.get("jump_url"):
                card["url"] = src["jump_url"]

    for m in item.get("modules") or []:
        mt = m.get("module_type")
        if mt == "MODULE_TYPE_DYNAMIC":
            # dyn_archive 直接挂在 module_dynamic 下；major 是另一套新结构
            dyn = m.get("module_dynamic") or {}
            take(dyn)
            take(dyn.get("major") or {})
        elif mt == "MODULE_TYPE_DESC":
            d = m.get("module_desc") or {}
            # desktop 侧卡片常以 items[] 的 type=video 形式出现
            for it in (d.get("items") or []):
                if (it.get("type") or "") == "video" or it.get("bvid"):
                    card["title"] = card["title"] or (it.get("title") or "")
                    card["url"] = card["url"] or (it.get("jump_url") or "")
                    card["bvid"] = card["bvid"] or (it.get("bvid") or "")
                    card["cover"] = card["cover"] or (it.get("src") or it.get("cover") or "")
                    card["duration"] = card["duration"] or it.get("duration_text")
                    card["desc"] = card["desc"] or (it.get("desc") or "")
            # 部分 desktop 返回把卡片放在 module_desc.major 下
            take((d.get("major") or {}))

    if not card["url"] and card["bvid"]:
        card["url"] = "https://www.bilibili.com/video/" + card["bvid"]
    if card["url"].startswith("//"):
        card["url"] = "https:" + card["url"]
    return card


def parse_detail(item):
    """解析 opus/detail 或 desktop/detail 的 modules 数组。

    返回 (pub_ts, text, images, stat, official, dyn_type, forward_text, video)。
    forward_text 是转发动态时被转发的原动态正文（DYNAMIC_TYPE_FORWARD 才有）；
    video 是视频投稿类动态的卡片信息（视频媒体不下载，只留链接）。
    """

    pub_ts, text, images, stat, official = None, "", [], {}, ""
    dyn_type, forward_text = item.get("type") or "", ""
    for m in item.get("modules") or []:
        mt = m.get("module_type")
        if mt == "MODULE_TYPE_AUTHOR":
            a = m.get("module_author") or {}
            try:
                pub_ts = int(a.get("pub_ts"))
            except (TypeError, ValueError):
                pub_ts = None
            official = ((a.get("official") or {}).get("title")) or ""
        elif mt == "MODULE_TYPE_CONTENT":
            paras = ((m.get("module_content") or {}).get("paragraphs")) or []
            chunks = []
            for para in paras:
                nodes = ((para.get("text") or {}).get("nodes")) or []
                words = "".join((n.get("word") or {}).get("words", "") for n in nodes)
                if words:
                    chunks.append(words)
                pic = para.get("pic")
                if isinstance(pic, dict):
                    for key in ("pics", "items"):
                        for p in (pic.get(key) or []):
                            u = p.get("url") or p.get("src")
                            if u and u not in images:
                                images.append(u)
            # 段落之间用空行连接，保持原文的分段观感
            if chunks:
                text = "\n\n".join(chunks)
        elif mt == "MODULE_TYPE_DYNAMIC":
            # 转发动态：被转发的原动态正文放在 module_dynamic.desc
            d = m.get("module_dynamic") or {}
            desc = d.get("desc") or {}
            if isinstance(desc, dict):
                chunks = []
                for para in desc.get("rich_text_nodes") or []:
                    w = (para.get("text") or "")
                    if w:
                        chunks.append(w)
                forward_text = "".join(chunks)
                major = d.get("major") or {}
                for key in ("draw", "opus"):
                    mm = major.get(key) or {}
                    for p in (mm.get("items") or []):
                        u = p.get("src") or p.get("url")
                        if u and u not in images:
                            images.append(u)
        elif mt == "MODULE_TYPE_DESC":
            # desktop/detail 用的是 DESC 模块（结构同 CONTENT，但只有 desc 字段）
            d = m.get("module_desc") or {}
            chunks = []
            for node in d.get("rich_text_nodes") or []:
                w = node.get("text") or ""
                if w:
                    chunks.append(w)
            words = "".join(chunks).strip()
            if words:
                text = words
            # items[] 里若带 bvid，说明是视频卡片的前缀图，不是动态配图
            for p in (d.get("items") or []):
                if p.get("bvid") or (p.get("type") == "video"):
                    continue
                u = p.get("src") or p.get("url")
                if u and u not in images:
                    images.append(u)
        elif mt == "MODULE_TYPE_STAT":
            s = m.get("module_stat") or {}
            stat = {k: (s.get(k) or {}).get("count")
                    for k in ("like", "comment", "forward")}
    # \u200b 必须在 strip 之前清掉：不少动态正文以零宽空格开头，
    # 否则 strip 后仍残留该字符、或者（若先 strip）被误判为空
    text = text.replace("\u200b", "").strip()
    forward_text = forward_text.replace("\u200b", "").strip()
    # 视频投稿类动态：正文就是视频卡片上的文案（archive.desc），
    # 媒体不下载，但文案与视频链接都要完整保留
    video = parse_video_card(item) if dyn_type in VIDEO_DYNAMIC_TYPES else None
    if video:
        vd = (video.get("desc") or "").replace("\u200b", "").strip()
        if vd and vd not in text:
            text = (text + "\n\n" + vd).strip() if text else vd
    return pub_ts, text, images, stat, official, dyn_type, forward_text, video


def fetch_item(client, oid, tag=""):
    """按顺序尝试两个详情接口，返回 (code, item)。

    opus/detail 覆盖 2023 年之后进入 opus 体系的动态；更早的动态它返回
    code=0 但 item 为空，此时回落到 desktop/v1/detail（返回体在根级 item）。
    """
    code, data = client.call(
        OPUS_DETAIL_URL,
        {"id": oid, "timezone_offset": "-480", "web_location": "333.1007"},
        f"https://www.bilibili.com/opus/{oid}",
        max_retry=2, tag=tag)

    if code != 0:
        return code, None

    item = data.get("item") or {}
    if item:
        return 0, item

    # 老动态：换 desktop 接口再试一次
    code2, data2 = client.call(
        DESKTOP_DETAIL_URL,
        {"id": oid, "timezone_offset": "-480"},
        f"https://t.bilibili.com/{oid}",
        max_retry=2, tag=tag + "/desktop")
    if code2 != 0:
        return 0, {}          # 老接口也没取到，但 opus 侧确实无错，按“空”处理
    return 0, (data2.get("item") or {})


def stage_detail(uid, paths, client, limit=None, id_file=None, retry_failed=False):
    log("\n[2/4] 逐条补全详情（发布时间 / 全部图片 / 正文）")
    items = load_json(paths.list_json, [])

    cache = load_json(paths.detail_json, {})
    if cache:
        log(f"  [detail] 复用缓存 {len(cache)} 条")

    if id_file:
        # 从外部 id 清单补齐：列表接口只暴露近期 605 条，
        # 历史动态需靠外部 id 源 + 详情接口逐条取回（详情接口对全量历史均可用）
        ext = load_json(id_file, [])
        ids = [str(x["id"] if isinstance(x, dict) else x) for x in ext]
        log(f"  [detail] 外部 id 清单 {len(ids)} 条 ← {id_file}")
    else:
        if not items:
            log("  [error] 缺少清单文件，请先执行 --stage list，或改用 --id-file")
            return {}
        ids = [x["opus_id"] for x in items if x.get("opus_id")]

    def need(oid):
        """判断某条是否还需要抓：缺失、上次失败（且允许重试）、或空壳待复核。"""
        v = cache.get(oid)
        if v is None:
            return True
        if not isinstance(v, dict):
            return True
        if v.get("failed") and not v.get("invisible") and retry_failed:
            return True
        # 空壳：既无正文也无图、且没判定类型 —— 需要用 desktop 接口复核
        if (not v.get("failed") and not v.get("text") and not v.get("images")
                and not v.get("dyn_type")):
            return True
        # 视频投稿类：早期被整条排除，缓存里没有 video 卡片，需要重抓以补链接与文案
        if (v.get("dyn_type") in VIDEO_DYNAMIC_TYPES
                and not (v.get("video") or {}).get("url")):
            return True
        return False

    todo = [oid for oid in ids if need(oid)]
    if limit:
        todo = todo[:limit]
    log(f"  [detail] 待处理 {len(todo)} 条（间隔约 {client.pace}s）")

    for i, oid in enumerate(todo, 1):
        code, item = fetch_item(client, oid, tag=f"detail {i}")

        if code == 0 and item is not None:
            (pub_ts, text, images, stat, official,
             dyn_type, fwd, video) = parse_detail(item)
            cache[oid] = {
                "pub_ts": pub_ts,
                "text": text,
                "images": images,
                "stat": stat,
                "official_title": official,
                "dyn_type": dyn_type,
                "forward_text": fwd,
            }
            if video:
                cache[oid]["video"] = video
        else:
            # 4101152 = 动态不可见（作者删除 / 转为私密 / 被屏蔽），属终态，不再重试
            cache[oid] = {"pub_ts": None, "failed": True, "error_code": code,
                          "invisible": code == 4101152}

        if i % 20 == 0 or i == len(todo):
            jdump(cache, paths.detail_json)
            ok = sum(1 for v in cache.values() if v.get("pub_ts"))
            log(f"  [detail] {i}/{len(todo)}，已有时间 {ok} 条，缓存已保存")

    jdump(cache, paths.detail_json)
    ok = sum(1 for v in cache.values() if v.get("pub_ts"))
    log(f"  [detail] 完成：缓存 {len(cache)} 条，其中 {ok} 条含发布时间")
    return cache


# ------------------------------------------------ 阶段 3：过滤与汇总
def decode_ts_from_opus_id(opus_id):
    """从 opus_id 解码发布时间戳。公式经 601 条实测记录验证，偏差 0 秒。"""
    try:
        return (int(opus_id) >> 32) + OPUS_ID_TS_OFFSET
    except (TypeError, ValueError):
        return None


def build_records(items, cache):
    """合并清单与详情，跳过视频类动态，仅保留文本+图片+时间。

    清单只覆盖列表接口可返回的近期动态；经 --id-file 补齐的历史动态
    只存在于 cache 中，因此这里需要把 cache 里超出清单的 id 一并纳入。
    """
    records, skipped = [], {"video_media_skipped": 0, "empty_after_filter": 0,
                            "invisible": 0}

    listed = set(str(o.get("opus_id")) for o in items if o.get("opus_id"))
    extra = [{"opus_id": oid} for oid in cache
             if oid not in listed and (cache[oid] or {}).get("text") not in (None, "")]
    if extra:
        log(f"  [build] 清单外补齐 {len(extra)} 条（来自缓存）")

    for o in items + extra:
        oid = str(o.get("opus_id") or "")
        if not oid:
            continue

        # 判断是否为视频类动态（清单中一般不带 type，用详情/封面特征辅助）
        c = cache.get(oid) or {}
        badge = o.get("badge")
        badge_text = (badge or {}).get("text") if isinstance(badge, dict) else ""

        # 按详情接口给的动态类型识别视频投稿：正文照样保留，只跳过媒体下载
        dyn_type = c.get("dyn_type") or ""

        text = (c.get("text") or "").strip()
        if not text:
            # 列表接口的 content 是最可靠的兜底来源：
            # 详情接口失败 / 空壳时，列表里往往仍留有完整正文
            text = (o.get("content") or "").replace("\u200b", "").strip()

        images = list(c.get("images") or [])

        cover = o.get("cover") or {}
        cover_urls = [p.get("url") for p in (cover.get("pics") or []) if p.get("url")]
        if not cover_urls and cover.get("url"):
            cover_urls = [cover["url"]]
        for u in cover_urls:
            if u not in images:
                images.append(u)

        # 统一图片链接协议为 https，避免下游混合内容问题
        images = [("https:" + u) if u.startswith("//") else
                  ("https://" + u[len("http://"):]) if u.startswith("http://") else u
                  for u in images]

        # 视频投稿类动态不再整条丢弃：正文与卡片信息照常保留，
        # 只是媒体本身不下载，靠 video.url / video.bvid 回溯
        video = c.get("video") if dyn_type in VIDEO_DYNAMIC_TYPES else None
        if video and video.get("cover"):
            cv = video["cover"]
            cv = "https:" + cv if cv.startswith("//") else cv
            video["cover"] = cv
            # 封面只作为视频卡片的元信息保留，不混进 images（images 代表动态配图）
        if badge_text in ("视频", "投稿视频") and not video:
            video = {"title": "", "url": "", "bvid": "", "cover": "", "duration": None}

        ts = c.get("pub_ts")
        try:
            ts = int(ts) if ts else None
        except (TypeError, ValueError):
            ts = None
        # 详情未返回时，从 opus_id 高位解码发布时间（精度到秒，已实测零偏差）
        if not ts:
            ts = decode_ts_from_opus_id(oid)

        like_raw = ((o.get("stat") or {}).get("like") or "").strip()
        stat = c.get("stat") or {}
        if not stat.get("like") and like_raw.isdigit():
            stat = {"like": int(like_raw), "comment": None, "forward": None}

        # 纯视频投稿可能既无正文也无配图，此时只要拿到视频卡片就应当保留
        has_video_link = bool(video and (video.get("url") or video.get("bvid")))
        if not text and not images and not has_video_link:
            if c.get("failed"):
                skipped["invisible"] += 1
            else:
                skipped["empty_after_filter"] += 1
            continue

        if has_video_link:
            skipped["video_media_skipped"] += 1

        records.append({
            "id": oid,
            "url": "https://www.bilibili.com/opus/" + oid,
            "pub_ts": ts,
            "pub_time": datetime.datetime.fromtimestamp(
                ts, CST).strftime("%Y-%m-%d %H:%M:%S") if ts else None,
            "type": "video" if has_video_link else "text",
            "text": text,
            "images": images,
            "image_count": len(images),
            "video": video if has_video_link else None,
            "stats": stat,
            "official_title": c.get("official_title") or "",
        })

    records.sort(key=lambda r: (r["pub_ts"] is None, -(r["pub_ts"] or 0)))
    return records, skipped


def download_images(paths, records, pace=0.35, max_bytes=30 * 1024 * 1024):
    """把记录中的图片下载到 media/ 目录，文件名取 URL 的最后一段。

    已存在的文件跳过，支持中断续跑。返回统计信息。
    """
    os.makedirs(paths.media_dir, exist_ok=True)

    urls = []
    for r in records:
        # 只下载动态配图；视频封面属于视频卡片元信息，随视频媒体一并跳过
        for u in r.get("images") or []:
            if u and u not in urls:
                urls.append(u)

    log(f"  [media] 共 {len(urls)} 个唯一图片链接，目标目录 {paths.media_dir}")
    ok = skip = fail = 0
    total_bytes = 0

    for i, u in enumerate(urls, 1):
        fname = urllib.parse.urlparse(u).path.rsplit("/", 1)[-1] or ""
        if not fname or "." not in fname:
            fname = hashlib.md5(u.encode("utf-8")).hexdigest() + ".jpg"
        dest = os.path.join(paths.media_dir, fname)

        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            skip += 1
            total_bytes += os.path.getsize(dest)
            continue

        try:
            req = urllib.request.Request(u, headers={
                "User-Agent": UA,
                "Referer": "https://www.bilibili.com/",
            })
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError("超过大小上限")
            with open(dest, "wb") as f:
                f.write(data)
            ok += 1
            total_bytes += len(data)
        except Exception as exc:
            fail += 1
            log(f"  [media] 失败 {fname}: {exc}")

        if i % 20 == 0 or i == len(urls):
            log(f"  [media] {i}/{len(urls)}  新增 {ok} 跳过 {skip} 失败 {fail}")
        time.sleep(pace)

    log(f"  [media] 完成：新增 {ok}，已存在 {skip}，失败 {fail}，"
        f"合计 {total_bytes / 1048576:.1f} MB")
    return {"total": len(urls), "downloaded": skip + ok, "newly": ok, "skipped": skip,
            "failed": fail, "bytes": total_bytes}


def build_integrity(dated, gap_days=60):
    """自动检测时间断层，并把接口可返回的边界记录出来，便于人工复核。"""
    gaps = []
    desc = sorted(dated, key=lambda r: r["pub_ts"])
    for a, b in zip(desc, desc[1:]):
        days = (b["pub_ts"] - a["pub_ts"]) / 86400.0
        if days >= gap_days:
            gaps.append({
                "from": a["pub_time"][:10],
                "to": b["pub_time"][:10],
                "days": int(days),
                "from_id": a["id"],
                "to_id": b["id"],
            })
    return {
        "gap_threshold_days": gap_days,
        "gap_count": len(gaps),
        "gaps": gaps,
        "time_decode": {
            "formula": "pub_ts = (opus_id >> 32) + %d" % OPUS_ID_TS_OFFSET,
            "note": "非详情来源的时间均由 ID 解码，精度到秒",
        },
        "caveat": ("断层区间经探测为服务端分页游标不可达（指定 offset 会被强制回落到边界条目），"
                   "并非本脚本漏抓；登录态、网页端渲染均无法突破该上限"),
    }


def verify_against_web(uid, records, host_name=None, pace=0.9):
    """独立复核：走网页端（space 动态页）所消费的同一接口，完整翻页后与本地数据集比对。

    返回值供 index.json 的 integrity.web_cross_check 使用。
    复核只读，不改动本地数据。
    """
    referer = "https://space.bilibili.com/%d/dynamic" % uid
    seen, order = set(), []
    offset, page, fails = "", 0, 0

    while page < 80:
        page += 1
        params = {
            "host_mid": str(uid),
            "offset": offset,
            "timezone_offset": -480,
            "features": "itemOpusStyle",
        }
        code, data = 0, {}
        # 该接口无需 WBI 签名，独立轻量请求，避免与签名逻辑耦合
        try:
            req = urllib.request.Request(
                OPUS_FEED_URL + "?" + urllib.parse.urlencode(params),
                headers={"User-Agent": UA, "Referer": referer},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            code = body.get("code")
            data = body.get("data") or {}
        except Exception as exc:
            fails += 1
            log("    网页复核第 %d 页异常: %s" % (page, exc))
            if fails >= 3:
                break
            time.sleep(2)
            continue

        if code != 0:
            fails += 1
            log("    网页复核第 %d 页 code=%s" % (page, code))
            if fails >= 3:
                break
            time.sleep(2)
            continue

        fails = 0
        items = data.get("items") or []
        new = [it for it in items if it.get("opus_id") not in seen]
        for it in new:
            seen.add(it.get("opus_id"))
            order.append(it.get("opus_id"))

        if not items:
            break
        offset = data.get("offset") or ""
        if not data.get("has_more") or not offset:
            break
        time.sleep(pace)

    local_ids = set(r["id"] for r in records)
    web_ids = set(i for i in order if i)
    only_web = sorted(web_ids - local_ids)
    only_local = sorted(local_ids - web_ids)

    return {
        "checked_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "网页端动态页同一数据源 opus/feed/space（完整翻页）",
        "web_total": len(web_ids),
        "local_total": len(local_ids),
        "intersection": len(web_ids & local_ids),
        "only_in_web": only_web[:20],
        "only_in_web_count": len(only_web),
        "only_in_local": only_local[:20],
        "only_in_local_count": len(only_local),
        "conclusion": (
            "网页端可达总数与本地数据集完全一致"
            if not only_web and not only_local
            else "存在差异，见 only_in_web / only_in_local"
        ),
    }


def stage_build(uid, paths, client, host_name=None, no_web_check=False):
    log("\n[3/4] 汇总输出（跳过视频、仅保留文本与图片）")
    items = load_json(paths.list_json, [])
    cache = load_json(paths.detail_json, {})
    records, skipped = build_records(items, cache)

    # 存量合并保护：列表接口对部分网络环境只放行近期约 600 条，历史动态
    # 依赖 raw/detail_cache.json 兜底；万一缓存损坏/缺失，这里也要保证
    # 已入库的全量数据不被本次结果砍小。以 id 为键，本次记录覆盖同 id，
    # 存量中本次未覆盖到的记录原样保留。
    existing = load_json(paths.all_json, [])
    if existing:
        fresh_ids = {str(r["id"]) for r in records}
        kept = [r for r in existing
                if r.get("id") and str(r["id"]) not in fresh_ids]
        if kept:
            log(f"  [build] 合并存量 {len(kept)} 条（本次清单未覆盖）→ "
                f"{len(records)} + {len(kept)} = {len(records) + len(kept)} 条")
            records = sorted(records + kept,
                             key=lambda r: (r["pub_ts"] is None, -(r["pub_ts"] or 0)))

    by_year = {}
    for r in records:
        year = (r["pub_time"] or "unknown")[:4]
        if not year.isdigit():
            year = "unknown"
        by_year.setdefault(year, []).append(r)

    jdump(records, paths.all_json)
    for year, rs in by_year.items():
        jdump(rs, paths.year_json(year))

    # 索引：便于按时间 / ID 检索
    dated = [r for r in records if r["pub_ts"]]
    earliest = dated[-1] if dated else None
    latest = dated[0] if dated else None
    index = {
        "uid": uid,
        "host_name": host_name or "",
        "host_url": f"https://space.bilibili.com/{uid}/dynamic",
        "generated_at": datetime.datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "total_records": len(records),
        "with_time": len(dated),
        "without_time": len(records) - len(dated),
        "with_images": sum(1 for r in records if r["images"]),
        "total_images": sum(len(r["images"]) for r in records),
        "skipped": skipped,
        "time_range": {
            "earliest": earliest["pub_time"] if earliest else None,
            "latest": latest["pub_time"] if latest else None,
        },
        "files": {
            "all": os.path.relpath(paths.all_json, paths.root).replace("\\", "/"),
            "by_year": {y: f"dynamics/year_{y}.json" for y in sorted(by_year, reverse=True)},
            "raw_list": "raw/opus_list.json",
            "raw_detail": "raw/detail_cache.json",
        },
        "year_stats": {y: len(rs) for y, rs in sorted(by_year.items(), reverse=True)},
        "integrity": build_integrity(dated),
        "id_index": [{"id": r["id"], "pub_time": r["pub_time"], "year": (r["pub_time"] or "unknown")[:4]}
                     for r in records],
    }

    # 独立复核：网页端同一数据源完整翻页，与本地数据集逐 ID 比对
    if not no_web_check:
        log("  [build] 网页端交叉复核中（同一数据源完整翻页）…")
        try:
            index["integrity"]["web_cross_check"] = verify_against_web(
                uid, records, host_name=host_name
            )
            wc = index["integrity"]["web_cross_check"]
            log(f"  [build] 复核结果：网页 {wc['web_total']} 条 / 本地 {wc['local_total']} 条 / "
                f"交集 {wc['intersection']} 条 → {wc['conclusion']}")
        except Exception as exc:
            log(f"  [build] 网页复核失败（不影响主数据）：{exc}")
            index["integrity"]["web_cross_check"] = {"error": str(exc)}

    jdump(index, paths.index_json)

    log(f"  [build] 有效动态 {len(records)} 条（其中 {skipped['video_media_skipped']} 条为视频投稿，"
        f"仅保留文案与视频链接、不下载媒体）")
    log(f"  [build] 含时间 {len(dated)} 条，含图片 {index['with_images']} 条，"
        f"图片总数 {index['total_images']}")
    log(f"  [build] 时间范围 {index['time_range']['earliest']} ~ {index['time_range']['latest']}")
    return index


# ------------------------------------------------ 阶段 4：运行日志
def stage_log(paths, index, client, elapsed, args):
    log("\n[4/4] 写入运行元数据")
    meta = {
        "script": os.path.basename(__file__),
        "python": sys.version.split()[0],
        "argv": sys.argv,
        "uid": args.uid,
        "started_at": datetime.datetime.fromtimestamp(
            time.time() - elapsed, CST).strftime("%Y-%m-%d %H:%M:%S"),
        "finished_at": datetime.datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": round(elapsed, 1),
        "http_requests": client.request_count,
        "pace_seconds": client.pace,
        "api": {
            "list": OPUS_FEED_URL,
            "detail": OPUS_DETAIL_URL,
            "feed": FEED_URL,
        },
        "result": {
            "total_records": index.get("total_records"),
            "with_time": index.get("with_time"),
            "skipped": index.get("skipped"),
        },
        "notes": [
            "清单接口 opus/feed/space 的 pub_time 字段为空，发布时间取自 opus/detail",
            "详情接口对单条动态返回完整段落文本与全部图片 URL",
            "video/番剧/直播类动态已按类型与徽标过滤",
            "所有请求均经过 WBI 签名与 buvid 设备指纹，并含限速与指数退避",
        ],
    }
    jdump(meta, paths.runlog_json)
    log(f"  [log] {paths.runlog_json}")


# ------------------------------------------------ 入口
def main():
    ap = argparse.ArgumentParser(description="B 站 UP 主动态采集器")
    ap.add_argument("--uid", type=int, default=DEFAULT_UID)
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    ap.add_argument("--stage", default="all",
                    choices=["all", "list", "detail", "build"])
    ap.add_argument("--pace", type=float, default=1.5,
                    help="请求最小间隔秒数（默认 1.5）")
    ap.add_argument("--limit", type=int, default=None,
                    help="本次最多补多少条详情（调试用）")
    ap.add_argument("--max-pages", type=int, default=None,
                    help="清单最多翻多少页（调试用）")
    ap.add_argument("--id-file", default=None,
                    help="外部 opus_id 清单（JSON 数组），用于补齐列表接口不暴露的历史动态")
    ap.add_argument("--download-images", action="store_true",
                    help="把图片下载到 media/ 目录（默认仅保留链接）")
    ap.add_argument("--host-name", default="")
    ap.add_argument("--no-web-check", action="store_true",
                    help="跳过构建阶段的网页端交叉复核（省约 30 次请求）")
    ap.add_argument("--retry-failed", action="store_true",
                    help="重试此前标记为失败的条目（不含已确认不可见的）")
    a = ap.parse_args()

    t0 = time.time()
    paths = Paths(a.uid, a.data_dir)
    paths.ensure()

    log("=" * 64)
    log(f"B 站动态采集  UID={a.uid}")
    log(f"输出目录     {paths.root}")
    log(f"请求间隔     {a.pace}s（含随机抖动）")
    log("=" * 64)

    client = BiliClient(pace=a.pace)
    if a.stage in ("all", "list", "detail", "build"):
        client.init()

    if a.stage in ("all", "list"):
        stage_list(a.uid, paths, client, max_pages=a.max_pages)
    if a.stage in ("all", "detail"):
        stage_detail(a.uid, paths, client, limit=a.limit, id_file=a.id_file,
                     retry_failed=a.retry_failed)
    if a.stage in ("all", "build"):
        index = stage_build(a.uid, paths, client, host_name=a.host_name,
                            no_web_check=a.no_web_check)
        if a.download_images:
            records = load_json(paths.all_json, [])
            index["media"] = download_images(paths, records)
            jdump(index, paths.index_json)
        stage_log(paths, index, client, time.time() - t0, a)

    log("\n完成。目录结构：")
    for root, dirs, files in os.walk(paths.root):
        rel = os.path.relpath(root, paths.root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        log("  " * depth + (os.path.basename(root) if rel != "." else f"bilibili/{a.uid}/"))
        for f in sorted(files):
            size = os.path.getsize(os.path.join(root, f))
            unit = "KB" if size < 1024 * 1024 else "MB"
            val = size / 1024 if unit == "KB" else size / 1024 / 1024
            log("  " * (depth + 1) + f"- {f}  ({val:.1f} {unit})")


if __name__ == "__main__":
    main()
