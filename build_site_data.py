# -*- coding: utf-8 -*-
"""把 dynamics/all.json 压缩为站点前端用的轻量数据集。

产出：
  assets/data/posts.json   每条动态的精简记录（含年/月/日/时刻、正文、图、视频卡、互动）
  assets/data/meta.json    汇总统计（年表、月表、热词、首尾、互动榜等）

只保留展示需要的字段，并做一次全局去重（同 ID 只留一条）。
"""
import datetime
import json
import os
import re
import shutil
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "data", "bilibili", "2094031249")
OUT = os.path.join(ROOT, "site", "assets", "data")
MEDIA_SRC = os.path.join(SRC, "media")
MEDIA_DST = os.path.join(ROOT, "site", "assets", "images", "media")
TRANS = os.path.join(ROOT, "translation", "ja2zh.json")

# 全部时间按北京时间（固定 +08:00）处理：动态归属的月份牌、时段/星期
# 统计都由此派生，GitHub Actions runner 是 UTC 时区，用本地时间会让
# 本地与 CI 的产出不一致，跨日的动态还会被归错月份。
CST = datetime.timezone(datetime.timedelta(hours=8))


def load(p, d=None):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def short_img(url):
    """图片在 media 目录里以两档 WebP 存在（480 列表 / 1080 灯箱）。

    返回 (thumb, full)，前端列表用 thumb、灯箱用 full。
    """
    if not url:
        return "", ""
    name = url.rsplit("/", 1)[-1].rsplit("@", 1)[0]
    stem = os.path.splitext(name)[0]
    return stem + "@480w_1c.webp", stem + "@1080w_1c.webp"


def video_cover_name(url):
    """视频封面在媒体目录里以 @320w_200h_1c.webp 的缩略图形式存在。"""
    if not url:
        return ""
    name = url.rsplit("/", 1)[-1].rsplit("@", 1)[0]
    base, _ = os.path.splitext(name)
    return base + "@320w_200h_1c.webp"


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(MEDIA_DST, exist_ok=True)

    records = load(os.path.join(SRC, "dynamics", "all.json"))
    index = load(os.path.join(SRC, "index.json"))

    # 中文译文：ja2zh.json 可能不完整，缺的条目前端会隐藏翻译按钮
    # AI-TRANS｜下面注入 posts.json 的 zh 字段全部是 AI 机器翻译（Google 引擎 + 术语表），
    # 未经人工逐条校对，含义可能不准确；人工确认过的只有 translation/fixes.json 里登记的
    # 少数条目。原文字段 text 才是真值，zh 仅作阅读辅助。标注清单见 translation/ai_notice.json。
    zh_map = {}
    if os.path.exists(TRANS):
        zh_map = load(TRANS)
        print(f"译文 {len(zh_map)} 条")

    seen, posts = set(), []
    for r in records:
        pid = str(r["id"])
        if pid in seen:
            continue
        seen.add(pid)
        ts = int(r["pub_ts"])
        d = datetime.datetime.fromtimestamp(ts, CST)
        video = r.get("video") or None
        if video:
            video = {
                "title": video.get("title") or "",
                "bvid": video.get("bvid") or "",
                "url": video.get("url") or "",
                "cover": video_cover_name(video.get("cover")),
                "duration": video.get("duration") or "",
            }
        st = r.get("stats") or {}
        # imgs 每项是 [thumb, full] 两档，索引 0 给列表、1 给灯箱
        imgs = [list(short_img(u)) for u in (r.get("images") or [])]
        ja = r.get("text") or ""
        zh = (zh_map.get(pid) or "").strip()
        # 译文与原文相同说明原文本来就是中文，不需要翻译按钮
        if zh and re.sub(r"\s+", "", zh) == re.sub(r"\s+", "", ja):
            zh = ""
        posts.append({
            "id": pid,
            "ts": ts,
            "y": d.year, "m": d.month, "d": d.day,
            "hh": d.hour, "mm": d.minute,
            "wd": d.weekday(),
            "text": ja,
            "zh": zh,
            "imgs": imgs,
            "video": video,
            "like": st.get("like") or 0,
            "cmt": st.get("comment") or 0,
            "fwd": st.get("forward") or 0,
        })

    posts.sort(key=lambda p: p["ts"])

    # ---- 年月聚合
    by_ym = defaultdict(list)
    for p in posts:
        by_ym[f"{p['y']}-{p['m']:02d}"].append(p)

    months = []
    for ym in sorted(by_ym):
        ps = by_ym[ym]
        y, mo = map(int, ym.split("-"))
        months.append({
            "ym": ym,
            "y": y,
            "m": mo,
            "n": len(ps),
            "chars": sum(len(p["text"]) for p in ps),
            "like": sum(p["like"] for p in ps),
            "imgs": sum(len(p["imgs"]) for p in ps),
            "videos": sum(1 for p in ps if p["video"]),
            "first": ps[0]["ts"],
            "last": ps[-1]["ts"],
        })

    # ---- 每月心情
    # 用当月全部文案判语气。原文(日文)最能反映她真实的口吻，
    # 译文经过机翻会磨平语气词和颜文字的方向，所以这里用原文。
    from mood import month_mood, rank_months
    raw = {}
    for mrec in months:
        ps = by_ym[mrec["ym"]]
        mood, detail = month_mood([p["text"] for p in ps])
        raw[mrec["ym"]] = mood
        mrec["mood"] = round(mood, 4)
        mrec["mood_d"] = detail
    spread = rank_months(raw)
    for mrec in months:
        mrec["mood01"] = spread[mrec["ym"]]
    print("心情 min/max/avg: "
          f"{min(raw.values()):.3f} / {max(raw.values()):.3f} / {sum(raw.values())/len(raw):.3f}")

    years = []
    by_y = defaultdict(list)
    for p in posts:
        by_y[p["y"]].append(p)
    for y in sorted(by_y):
        ps = by_y[y]
        years.append({
            "y": y,
            "n": len(ps),
            "chars": sum(len(p["text"]) for p in ps),
            "like": sum(p["like"] for p in ps),
            "imgs": sum(len(p["imgs"]) for p in ps),
            "videos": sum(1 for p in ps if p["video"]),
            "first": ps[0]["ts"],
            "last": ps[-1]["ts"],
        })

    # ---- 小时热力（0-23）
    hours = [0] * 24
    for p in posts:
        hours[p["hh"]] += 1

    # ---- 星期
    wds = [0] * 7
    for p in posts:
        wds[p["wd"]] += 1

    # ---- 热词
    # 只在中文译文上统计：日文假名没有可靠分词，按 3~5 字滑窗会切出
    # 「さ んが」「か らやる」这种碎片，词云全是噪声。
    # 译文经术语表统一后「配信」已是「直播」，反而更准确。
    # 切词用「词表最长匹配 + 残余二元组」：纯二元组会把「开播了」拆出
    # 「天开播」「开播了」，噪声很大。
    VOCAB = """直播 视频 游戏 动态 弹幕 观众 封面 剪辑 职人 联动 舰长 周边 活动
    更新 补丁 维护 录播 杂谈 恐怖游戏 任天堂直面会 宝可梦 皮卡丘 卡比 马力欧
    勇者斗恶龙 怪物猎人 零式 副本 抽卡 粉丝 角色 插画 剧情 系列 内容 圣诞 万圣节
    春节 北京时间 国服 日服 国际服 生日 纪念 感谢 支持 观看 通知 预告 预约
    电脑 手机 网络 日本 中国 朋友 工作 休息 时间 晚上 早上 周末 天气 温度 秋天
    冬天 春天 夏天 新作 发售 第一次 一年 两周 三天 遗憾 开心 期待 紧张 惊讶
    初配信 出道 二周年 三周年 周年 新衣装 3D 收录 录音 歌唱 企划 企画 团队
    报酬 收益 观众 直播间 关注 投稿 频道 名字 翻译 中文 日语 日本语
    故事 主线 支线 活动 季节 更新 版本 服务器 玩家 体验 感想 报告 日记
    """.split()
    VOCAB = sorted(set(VOCAB), key=len, reverse=True)
    MAXW = max(len(w) for w in VOCAB)

    stop = set("""的 了 是 在 我 也 就 都 和 这 那 你 他 她 们 有 没 不 很 要 会 说 吗 呢 啊
    吧 呀 哦 嗯 么 什么 因为 所以 但是 而且 还是 已经 可以 这样 那样 一个 一下 今天 明天
    现在 大家 觉得 时候 真的 感觉 应该 可能 如果 比较 一起 一直 有点 非常 谢谢 希望
    我们 你们 这个 那个 没有 就是 也是 还有 自己 之后 之前 昨天 这次 下次
    一些 这种 怎么样 为什么 然后 好像 知道 需要 开始 结束 今年 去年 明年""".split())

    def cut(txt):
        """词表最长匹配，未命中的中文字串不产出（宁可少词，不要碎片）。"""
        out = []
        i, n = 0, len(txt)
        while i < n:
            hit = None
            for L in range(min(MAXW, n - i), 1, -1):
                seg = txt[i:i + L]
                if seg in VOCAB:
                    hit = seg
                    break
            if hit:
                out.append(hit)
                i += len(hit)
            else:
                i += 1
        return out

    words = Counter()
    for p in posts:
        txt = p["zh"] if p.get("zh") else p["text"]
        for w in cut(txt):
            if w not in stop:
                words[w] += 1
        # 英文/数字专名：FF14、DLC、B站 这类整词更可读
        for w in re.findall(r"[A-Za-z]{2,}\d*", txt):
            if len(w) >= 2:
                words[w] += 1

    # ---- 互动榜
    # 她的高赞动态里有大量「同一句固定文案」的复制粘贴，例如每条开头都是
    # 「動画は切り抜き職人さんが、サムネはXXXさんが作ってくれました。」
    # 只差署名。直接按赞排序会让榜单前几名全是这句模板，
    # 所以这里用「去掉人名/数字后的模板指纹」做去重。
    def tpl_key(t):
        s = re.sub(r"\s+", "", t)
        # 她固定使用的片头：動画は切り抜き職人さんが、サムネはXXXさんが作ってくれました。
        # 变体很多（标点、署名、語尾），只要命中就统一归成同一个指纹。
        if "切り抜き職人" in s and "作ってくれました" in s:
            # 片头之后的正文才是这条动态真正的内容
            tail = s.split("作ってくれました", 1)[-1]
            tail = re.sub(r"^[!！。、,，]*(さん)?", "", tail)
            return "PREFIX切り抜き::" + tail[:40]
        # 通用：抹掉数字与链接，避免「第 12 次」这类小差别造成误判
        s = re.sub(r"https?://\S+", "<u>", s)
        s = re.sub(r"\d+", "#", s)
        return s[:64]

    def dedup_by_text(items, n):
        seen, out = set(), []
        for p in items:
            key = tpl_key(p["text"])
            if key and key in seen:
                continue
            seen.add(key)
            out.append(p)
            if len(out) >= n:
                break
        if len(out) < n:
            for p in items:
                if p not in out:
                    out.append(p)
                if len(out) >= n:
                    break
        return out

    top_like = dedup_by_text(
        sorted(posts, key=lambda p: -p["like"]), 12)

    # ---- 长文（长文模板重复的可能性低，用普通前缀去重即可）
    longest = []
    seen_l = set()
    for p in sorted(posts, key=lambda p: -len(p["text"])):
        k = re.sub(r"\s+", "", p["text"])[:40]
        if k in seen_l:
            continue
        seen_l.add(k)
        longest.append(p)
        if len(longest) >= 8:
            break

    total_chars = sum(len(p["text"]) for p in posts)
    d0 = datetime.datetime.fromtimestamp(posts[0]["ts"], CST)
    d1 = datetime.datetime.fromtimestamp(posts[-1]["ts"], CST)

    def strip_prefix(t):
        """去掉固定片头，只留这条动态真正的内容，用于榜单展示。"""
        s = t.strip()
        if "切り抜き職人" in s and "作ってくれました" in s:
            tail = s.split("作ってくれました", 1)[-1]
            tail = re.sub(r"^[!！。、,，さん\s]+", "", tail)
            if len(tail) > 12:
                return tail
        return s

    def rank_item(p, extra):
        d = {
            "id": p["id"], "ts": p["ts"],
            "text": strip_prefix(p["text"])[:60],
        }
        d.update(extra(p))
        return d

    # ---- 舰长（大航海）
    # 已从站点移除。原因：需求要求「开播以来每月上舰数」，
    # B 站只公开「此刻仍在舰」的名单（scope=current），
    # 既没有累计值，也没有按月的历史，无法满足口径，故整块不输出。
    # guard.json 仍保留在 data/ 下备查，只是不再进入 meta.json。

    meta = {
        "generated_at": datetime.datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "uid": index.get("uid"),
        "name": "火羽ひのめ",
        # 头像：本地化避免 B 站 CDN 防盗链，前端仍带失败兜底
        "avatar": "assets/images/avatar.png",
        "avatar2x": "assets/images/avatar@2x.png",
        "total": len(posts),
        "with_time": len(posts),
        "with_images": sum(1 for p in posts if p["imgs"]),
        "total_images": sum(len(p["imgs"]) for p in posts),
        "videos": sum(1 for p in posts if p["video"]),
        "total_chars": total_chars,
        "avg_chars": total_chars // max(len(posts), 1),
        "translated": sum(1 for p in posts if p["zh"]),
        "first": posts[0]["ts"],
        "first_str": d0.strftime("%Y-%m-%d"),
        "last": posts[-1]["ts"],
        "last_str": d1.strftime("%Y-%m-%d"),
        "span_days": (d1.date() - d0.date()).days + 1,
        "years": years,
        "months": months,
        "hours": hours,
        "weekdays": wds,
        # 140 个：椭圆词艺术版式要的是「无缝填满」的密度，
        # 词数是覆盖率的主导因素（100 个时椭圆内仍有大片留白）
        "top_words": [{"w": w, "n": n} for w, n in words.most_common(140)],
        "top_like": [rank_item(p, lambda x: {"like": x["like"]}) for p in top_like],
        "longest": [rank_item(p, lambda x: {"chars": len(x["text"])}) for p in longest],
        "busiest_month": max(months, key=lambda m: m["n"])["ym"],
        "peak_hour": hours.index(max(hours)),
    }

    with open(os.path.join(OUT, "posts.json"), "w", encoding="utf-8") as f:
        json.dump(posts, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    # ---- 同步图片（media 目录已由 fetch_media_thumbs.py / fetch_covers.py 铺好，
    #      这里只做存在性校验，缺什么报什么，不静默复制原图）
    need = set()
    for p in posts:
        for pair in p["imgs"]:
            need.update(pair)
        if p["video"] and p["video"]["cover"]:
            need.add(p["video"]["cover"])
    missing = sorted(fn for fn in need if not os.path.exists(os.path.join(MEDIA_DST, fn)))

    print(f"posts={len(posts)} months={len(months)} years={len(years)}")
    print(f"chars={total_chars} images={meta['total_images']} videos={meta['videos']}")
    print(f"media need={len(need)} missing={len(missing)}")
    for fn in missing[:10]:
        print(f"  MISSING {fn}")
    for n in ("posts.json", "meta.json"):
        print(f"  {n}: {os.path.getsize(os.path.join(OUT, n)) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
